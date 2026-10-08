// T3.S6: the redo of a paste that landed in batches, a slice at a time. One Yjs redo restores the whole paste in one
// transaction, which Lexical then places and lays out at once; pasting it again instead made new items that the
// steps after it in the redo chain do not follow, so they could never be redone. A slice is a subset of the undo
// step's deletions, redone through the UndoManager itself, so each restored item records the copy it became (`redone`)
// and later steps follow it. A container is redone in the slice that holds it or an earlier one, with its attributes
// and its first child, so the binding never sees an element without its type or an empty list or table.
import * as Y from 'yjs';

type StackItem = Y.UndoManager['undoStack'][number];
type DeleteSet = StackItem['deletions'];
type Range = { client: number; clock: number; len: number };

/** Containers whose children a slice boundary may part: a list's items, a nested list item's, a table's rows. */
const SPINES = new Set(['list', 'listitem', 'table']);

/** About the bytes an item adds to an update: its id and origins, its key, and its content. */
function bytesOf(item: Y.Item, len: number): number {
  const { content } = item;
  let bytes = 16 + (item.parentSub?.length ?? 0);
  if (content instanceof Y.ContentString) bytes += len * 2;
  else if (content instanceof Y.ContentAny) for (const value of content.arr) bytes += typeof value === 'string' ? value.length + 2 : 8;
  return bytes;
}

const isBlock = (item: Y.Item): boolean =>
  item.parentSub === null && item.content instanceof Y.ContentType && (item.content.type instanceof Y.XmlText || item.content.type instanceof Y.XmlElement);

/** A container's Lexical node type, read off its attributes even when deleted. */
function typeName(item: Y.Item): unknown {
  const type = (item.content as Y.ContentType).type as Y.AbstractType<unknown>;
  const value = type._map.get('__type');
  return value?.content.getContent()[0];
}

interface Entry {
  item: Y.Item;
  range: Range;
  bytes: number;
}

/** A run of entries no slice boundary may part. */
interface Atom {
  ranges: Range[];
  blocks: number;
  bytes: number;
}

/**
 * The redo of `step` (on `manager`'s redo stack) as atoms in an order where every container comes before what it
 * holds. Reads the doc without splitting any item.
 */
function atomsOf(manager: Y.UndoManager, step: StackItem): Atom[] {
  const doc = manager.doc;
  const entries: Entry[] = [];
  // Yjs itself leaves out what the step also inserted, as it pops each slice (the host's undo may change that set).
  step.deletions.clients.forEach((ranges, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs || structs.length === 0) return;
    const last = structs[structs.length - 1];
    const known = last.id.clock + last.length;
    for (const { clock, len } of ranges) {
      const end = Math.min(clock + len, known);
      if (clock >= end) continue;
      for (let i = Y.findIndexSS(structs, clock); i < structs.length && structs[i].id.clock < end; i += 1) {
        const item = structs[i];
        if (!(item instanceof Y.Item)) continue;
        if (!manager.scope.some((type) => type === (doc as unknown) || Y.isParentOf(type as Y.AbstractType<unknown>, item))) continue;
        const from = Math.max(clock, item.id.clock);
        const to = Math.min(end, item.id.clock + item.length);
        entries.push({ item, range: { client, clock: from, len: to - from }, bytes: bytesOf(item, to - from) });
      }
    }
  });
  const containers = new Set(entries.filter(({ item }) => item.content instanceof Y.ContentType).map(({ item }) => item));
  const owner = (entry: Entry): Y.Item | null => {
    const parent = (entry.item.parent as Y.AbstractType<unknown>)._item;
    return parent && containers.has(parent) ? parent : null;
  };
  const children = new Map<Y.Item, Entry[]>();
  const roots: Entry[] = [];
  for (const entry of entries) {
    const parent = owner(entry);
    if (!parent) roots.push(entry);
    else if (children.has(parent)) children.get(parent)!.push(entry);
    else children.set(parent, [entry]);
  }

  const atoms: Atom[] = [];
  let atom: Atom | null = null;
  const seen = new Set<Y.Item>();
  // Depth first, a container's attributes before its children; a boundary only before a block whose container is
  // not being redone, or a spine's block after its first.
  const stack: { entry: Entry; cut: boolean }[] = roots.slice().reverse().map((entry) => ({ entry, cut: true }));
  while (stack.length) {
    const { entry, cut } = stack.pop()!;
    if (!atom || (cut && isBlock(entry.item))) {
      atom = { ranges: [], blocks: 0, bytes: 0 };
      atoms.push(atom);
    }
    atom.ranges.push(entry.range);
    atom.bytes += entry.bytes;
    if (isBlock(entry.item)) atom.blocks += 1;
    const kids = children.get(entry.item);
    if (!kids || seen.has(entry.item)) continue;
    seen.add(entry.item);
    const spine = SPINES.has(typeName(entry.item) as string);
    const ordered = [...kids.filter((kid) => kid.item.parentSub !== null), ...kids.filter((kid) => kid.item.parentSub === null)];
    let first = true;
    const pushes: { entry: Entry; cut: boolean }[] = [];
    for (const kid of ordered) {
      const block = isBlock(kid.item);
      pushes.push({ entry: kid, cut: spine && block && !first });
      if (block) first = false;
    }
    for (let i = pushes.length - 1; i >= 0; i -= 1) stack.push(pushes[i]);
  }
  return atoms;
}

function toDeleteSet(ranges: Range[]): DeleteSet {
  const ds = Y.createDeleteSet();
  const byClient = new Map<number, Range[]>();
  for (const range of ranges) {
    const list = byClient.get(range.client);
    if (list) list.push(range);
    else byClient.set(range.client, [range]);
  }
  for (const [client, list] of byClient) {
    list.sort((a, b) => a.clock - b.clock);
    const merged: { clock: number; len: number }[] = [];
    for (const { clock, len } of list) {
      const last = merged.at(-1);
      if (last && clock <= last.clock + last.len) last.len = Math.max(last.len, clock + len - last.clock);
      else merged.push({ clock, len });
    }
    ds.clients.set(client, merged as never);
  }
  return ds;
}

/** The redo of one stack item in slices: each is a stack item of its own over part of the deletions. */
export class RedoSlices {
  readonly #atoms: Atom[];
  #at = 0;

  constructor(manager: Y.UndoManager, readonly step: StackItem) {
    this.#atoms = atomsOf(manager, step);
  }

  get done(): boolean {
    return this.#at >= this.#atoms.length;
  }

  /**
   * The next slice, up to `blocks` blocks and about `bytes` bytes (at least one atom), as a stack item over its part
   * of the deletions; the step's insertions ride in every slice (the first deletes them; the rest find them gone).
   */
  next(blocks: number, bytes: number): { item: StackItem; blocks: number } | null {
    if (this.done) return null;
    const ranges: Range[] = [];
    let used = 0;
    let size = 0;
    while (this.#at < this.#atoms.length) {
      const atom = this.#atoms[this.#at];
      if (ranges.length > 0 && (used + atom.blocks > blocks || size + atom.bytes > bytes)) break;
      ranges.push(...atom.ranges);
      used += atom.blocks;
      size += atom.bytes;
      this.#at += 1;
    }
    const Item = this.step.constructor as new (deletions: DeleteSet, insertions: DeleteSet) => StackItem;
    const item = new Item(toDeleteSet(ranges), this.step.insertions);
    this.step.meta.forEach((value, key) => item.meta.set(key, value));
    return { item, blocks: used };
  }
}

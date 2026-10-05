// Seam (a) of the vendored plugin (A§10.2, A§10.8): the body's one Cmd+Z stack over the note's UndoManager, which
// tracks only this client's binding, and one UndoManager per held payload doc, which tracks this client's field
// edits (A§10.10). Cmd+Z never undoes a peer's or the server's writes, and one typing burst is one step.
import { UNDO_COMMAND, REDO_COMMAND, type LexicalEditor } from 'lexical';
import type { Binding } from '@lexical/yjs';
import {
  ContentString, ContentType, Item, Map as YMap, UndoManager, XmlText, findIndexSS, getItem, isDeleted, type AbstractType, type Transaction,
} from 'yjs';
import { BodyUndo, lexicalAction, payloadDocsFor } from '@moss-multi/sync/payload-docs';

import { REGISTER_LOCAL_ORIGIN } from '@moss-multi/sync/registers';
export { REGISTER_LOCAL_ORIGIN };

export const UNDO_CAPTURE_TIMEOUT_MS = 1_000;
type StackItem = UndoManager['undoStack'][number];

/** The plugin drives it as it would the root UndoManager: undo, redo, clear, the stacks' lengths and their events. */
export function createBindingUndoManager(binding: Binding): UndoManager {
  // A setter and an attribute written in one Lexical update undo together.
  const stack = new BodyUndo(createRootUndoManager(binding), binding.editor ? lexicalAction(binding.editor) : undefined);
  const payloads = payloadDocsFor(binding.doc);
  for (const doc of payloads.docs.values()) stack.trackPayload(doc, REGISTER_LOCAL_ORIGIN, UNDO_CAPTURE_TIMEOUT_MS);
  payloads.onHold((_id, doc) => { stack.trackPayload(doc, REGISTER_LOCAL_ORIGIN, UNDO_CAPTURE_TIMEOUT_MS); });
  return stack as unknown as UndoManager;
}

/**
 * Undo deletes only this client's items, but deleting a container deletes everything in it, and peers type into
 * containers this client created: a paragraph (Y.XmlText), and a text node's property map, which in @lexical/yjs owns
 * the characters after it up to the next embed (deleting the map left them dangling, and the binding then deleted
 * them for everyone). So undo keeps a container while it holds a peer's live characters, together with the
 * properties it was created with; only this client's own characters go. Undoing a delete restores the deleted items
 * as copies under this client's id (yjs redoItem), so a copy keeps the author of the item it restores. Yjs never
 * restores what a step both created and deleted, so a peer's characters deleted in the step that created their line
 * would come back without their paragraph or text node; those containers are restored with them.
 */
function createRootUndoManager(binding: Binding): UndoManager {
  const { doc } = binding;
  const trackedOrigins = new Set<unknown>([binding]);
  // This client's ids: the doc's own, plus any merged in under a tracked origin.
  const own = new Set([doc.clientID]);
  const noteOwn = (transaction: Transaction) => {
    if (!trackedOrigins.has(transaction.origin)) return;
    transaction.afterState.forEach((clock, client) => { if ((transaction.beforeState.get(client) ?? 0) < clock) own.add(client); });
  };
  // Restored copies: id ranges of this client's items whose characters another client wrote.
  const copies = new Map<number, { clock: number; len: number; author: number }[]>();
  const authorsOf = (client: number, clock: number, len: number) => {
    const known = copies.get(client);
    if (!known) return [{ clock, len, author: client }];
    const found: { clock: number; len: number; author: number }[] = [];
    let at = clock;
    for (const copy of known) {
      const from = Math.max(at, copy.clock); const to = Math.min(clock + len, copy.clock + copy.len);
      if (from >= to) continue;
      if (from > at) found.push({ clock: at, len: from - at, author: client });
      found.push({ clock: from, len: to - from, author: copy.author });
      at = to;
    }
    if (at < clock + len) found.push({ clock: at, len: clock + len - at, author: client });
    return found;
  };
  const byPeer = (item: Item) => authorsOf(item.id.client, item.id.clock, item.length).some(({ author }) => !own.has(author));
  // The step being undone or redone. One undo() pops past steps that change nothing, so this follows the stack.
  let stack: StackItem[] | null = null;
  let popped: StackItem[] = [];
  const current = () => (stack ? popped[stack.length] : undefined);
  // Characters the step inserted are deleted by it whoever wrote them, so they do not keep a container.
  const doomed = (item: Item) => {
    const step = current();
    return !!step && !(item.content instanceof ContentType) && isDeleted(step.insertions, item.id);
  };
  const isPeers = (item: Item) => !item.deleted && !doomed(item) && byPeer(item);
  // Every item overlapping a delete set's ranges, read without splitting.
  const eachItem = (set: StackItem['deletions'], visit: (item: Item) => void) => set.clients.forEach((ranges, client) => {
    const structs = doc.store.clients.get(client);
    if (!structs) return;
    const end = structs.at(-1)!.id.clock + structs.at(-1)!.length;
    for (const { clock, len } of ranges) {
      if (clock >= end) continue;
      for (let i = findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + len; i++) {
        const struct = structs[i]!;
        if (struct instanceof Item) visit(struct);
      }
    }
  });
  // Each deleted item a step restored points (`redone`) at its copy; the copy keeps the original's author.
  const rememberCopies = (step: StackItem) => {
    const found: [number, { clock: number; len: number; author: number }][] = [];
    eachItem(step.deletions, original => {
      const { redone } = original;
      if (!redone) return;
      for (const part of authorsOf(original.id.client, original.id.clock, original.length)) {
        if (part.author !== redone.client) found.push([redone.client, { ...part, clock: redone.clock + part.clock - original.id.clock }]);
      }
    });
    for (const [client, copy] of found) copies.set(client, [...copies.get(client) ?? [], copy].sort((a, b) => a.clock - b.clock));
  };
  // The containers a step created, as they are now: undoing a delete replaced some of them with restored copies.
  const createdBy = (step: StackItem) => {
    const created = new Set<Item>();
    eachItem(step.insertions, item => {
      if (!(item.content instanceof ContentType)) return;
      let current = item;
      while (current.redone) current = getItem(doc.store, current.redone) as Item;
      created.add(current);
    });
    return created;
  };
  const holdsNested = (item: Item | null): boolean =>
    !!item && !item.deleted && item.content instanceof ContentType && holdsPeers(item.content.type as AbstractType<unknown>);
  // A peer's live item in the sequence, or in a nested type at any depth (a property value is not content).
  const holdsPeers = (type: AbstractType<unknown>): boolean => {
    for (let item = type._start; item; item = item.right) if (isPeers(item) || holdsNested(item)) return true;
    for (const item of type._map.values()) if (holdsNested(item)) return true;
    return false;
  };
  // Kept while it holds a peer's live characters, whoever wrote the container: redoing a delete of a peer's restored
  // line removes only what the step restored, not what the peer typed into it since.
  const keeps = (item: Item): boolean => {
    if (item.deleted || !(item.content instanceof ContentType)) return false;
    const type = item.content.type as AbstractType<unknown>;
    if (item.parent instanceof XmlText && item.parentSub === null && type instanceof YMap) {
      for (let next = item.right; next; next = next.right) {
        if (next.deleted) continue;
        if (!(next.content instanceof ContentString)) return false;
        if (isPeers(next)) return true;
      }
      return false;
    }
    return holdsPeers(type);
  };
  const prepared = new Map<StackItem, Set<Item>>();
  // Yjs restores a step's deletions before it filters its insertions, so authorship of the copies is known first.
  const prepare = (step: StackItem) => {
    let created = prepared.get(step);
    if (!created) { rememberCopies(step); created = createdBy(step); prepared.set(step, created); }
    return created;
  };
  const deleteFilter = (item: Item): boolean => {
    const step = current();
    const created = step ? prepare(step) : null;
    if (item.parentSub === null) return !keeps(item);
    // A property goes with its container: kept while the container the step created is kept.
    const owner = (item.parent as AbstractType<unknown>)._item;
    if (owner && created?.has(owner)) return !keeps(owner);
    // A first assignment goes: the key was absent before the step (an optional property such as a callout's level).
    // Yjs links a key's next value after its tombstones, so a value undone earlier, or a peer's concurrent value,
    // proves nothing: the step replaced a value only if it deleted one it did not write itself.
    let replaced = false;
    for (let left = item.left; left && step && !replaced; left = left.left) {
      replaced = isDeleted(step.deletions, left.id) && !isDeleted(step.insertions, left.id);
    }
    if (!replaced) return true;
    // Yjs has already restored the value the step replaced, where it could. When a peer rewrote the key meanwhile it
    // cannot, and deleting the step's value would leave the key empty: Lexical hands every peer `undefined` for a
    // property its node never allows to be unset (a formula's `__commentIds`, which Lexical rewrites on every clone).
    return (item.parent as AbstractType<unknown>)._map.get(item.parentSub) !== item;
  };
  // Run as yjs pops a step, before it restores the step's deletions. A peer's deleted item needs the containers it
  // sat in and, for characters, the text node's property map in front of them, with their latest properties. Those
  // the step created and deleted leave its insertions, so yjs restores them along with the peer's item.
  const restoreStructure = (step: StackItem) => {
    const { insertions } = step;
    const restore = new Set<Item>();
    const need = (item: Item | null) => {
      if (!item || restore.has(item) || !item.deleted || !(item.content instanceof ContentType) || !isDeleted(insertions, item.id)) return;
      restore.add(item);
      for (const value of (item.content.type as AbstractType<unknown>)._map.values()) if (isDeleted(insertions, value.id)) restore.add(value);
      need((item.parent as AbstractType<unknown>)._item);
    };
    eachItem(step.deletions, item => {
      if (item.parentSub !== null || isDeleted(insertions, item.id) || !byPeer(item)) return;
      need((item.parent as AbstractType<unknown>)._item);
      if (!(item.content instanceof ContentString)) return;
      let left = item.left;
      while (left?.content instanceof ContentString) left = left.left;
      if (left?.content instanceof ContentType && left.content.type instanceof YMap) need(left);
    });
    for (const item of restore) {
      const ranges = insertions.clients.get(item.id.client);
      if (!ranges) continue;
      const from = item.id.clock; const to = from + item.length;
      const kept = ranges.flatMap(range => {
        const end = range.clock + range.len;
        if (end <= from || range.clock >= to) return [range];
        return [{ clock: range.clock, len: from - range.clock }, { clock: to, len: end - to }].filter(part => part.len > 0);
      });
      if (kept.length) insertions.clients.set(item.id.client, kept as typeof ranges); else insertions.clients.delete(item.id.client);
    }
  };
  const undo = new UndoManager(binding.root.getSharedType(), {
    trackedOrigins,
    captureTimeout: UNDO_CAPTURE_TIMEOUT_MS,
    deleteFilter,
  });
  const following = (read: () => StackItem[], run: () => StackItem | null) => () => {
    const steps = stack = read(); popped = stack.slice();
    steps.pop = () => { const step = Array.prototype.pop.call(steps) as StackItem | undefined; if (step) restoreStructure(step); return step; };
    try { return run(); } finally {
      Reflect.deleteProperty(steps, 'pop');
      for (const step of popped.slice(steps.length)) prepare(step);
      stack = null; popped = []; prepared.clear();
    }
  };
  undo.undo = following(() => undo.undoStack, undo.undo.bind(undo));
  undo.redo = following(() => undo.redoStack, undo.redo.bind(undo));
  doc.on('afterTransaction', noteOwn);
  const destroy = undo.destroy.bind(undo);
  undo.destroy = () => { doc.off('afterTransaction', noteOwn); destroy(); };
  return undo;
}

let focusedBody: LexicalEditor | null = null;
export function trackUndoFocus(editor: LexicalEditor): () => void {
  const focus = () => { focusedBody = editor; };
  const stop = editor.registerRootListener((root, previous) => {
    previous?.removeEventListener('focusin', focus);
    root?.addEventListener('focusin', focus);
  });
  return () => { stop(); if (focusedBody === editor) focusedBody = null; };
}
export function undoFromEmptyPrompt(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void; stopPropagation(): void }): void {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z' || !focusedBody?.isEditable()) return;
  event.preventDefault(); event.stopPropagation();
  focusedBody.dispatchCommand(event.shiftKey ? REDO_COMMAND : UNDO_COMMAND, undefined);
}

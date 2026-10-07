// Routed deletes in Suggest mode (docs/design/suggestions.md §5): an explicit delete over body items (Backspace,
// Delete, word or line delete, Cut, typing, Enter or paste over a selection) proposes a delete part with the exact
// ids instead of removing them; the text stays in F painted struck and the caret moves past it. The author's own
// pending text in the same selection deletes natively. Undo and redo take a strike back and put it again, in order
// with the binding's own undo steps. Everything else is native and recorded verbatim (a join at a block edge too).
// A native rewrite that re-creates struck text has the copy removed by the fork (client.ts, keepStrikes), so the
// struck characters leave F and their delete parts stay; where each struck character went is traced through Lexical's
// own text operations (trace.ts), or, where an operation rebuilds a node from its text, by aligning what the
// transaction deleted around a struck character with what it wrote. Undo of their strike re-creates them, as the author's own, where they stood.
import { $getClipboardDataFromSelection, setLexicalClipboardDataTransfer } from '@lexical/clipboard';
import type { IdSpan } from '@moss-multi/protocol/suggest';
import type { Rewrites, SuggestFork } from '@moss-multi/sync/suggest/client';
import {
  $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, COMMAND_PRIORITY_CRITICAL,
  CONTROLLED_TEXT_INSERTION_COMMAND, CUT_COMMAND, DELETE_CHARACTER_COMMAND, DELETE_LINE_COMMAND, DELETE_WORD_COMMAND,
  INSERT_LINE_BREAK_COMMAND, INSERT_PARAGRAPH_COMMAND, mergeRegister, PASTE_COMMAND, REDO_COMMAND, UNDO_COMMAND,
  type LexicalEditor, type LexicalNode, type TextNode,
} from 'lexical';
import * as Y from 'yjs';
import { bindingOf } from '../binding-registry.ts';
import { charAround, idKey, sharedItem, textIds, toSpans } from './chars.ts';
import { traceStrikes, type Spot } from './trace.ts';

type Routed = 'none' | 'struck' | 'own' | 'skip';

const UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

/** The leaf beside `node` inside its block, entering inline elements such as links; null at the block's edge. */
function $besideLeaf(node: LexicalNode, backward: boolean): LexicalNode | null {
  let current: LexicalNode = node;
  for (;;) {
    const sibling = backward ? current.getPreviousSibling() : current.getNextSibling();
    if (sibling) {
      let leaf: LexicalNode = sibling;
      for (;;) {
        if (!$isElementNode(leaf) || !leaf.isInline()) return leaf;
        const child: LexicalNode | null = backward ? leaf.getLastChild() : leaf.getFirstChild();
        if (!child) return leaf;
        leaf = child;
      }
    }
    const parent = current.getParent();
    if (!parent || !parent.isInline()) return null;
    current = parent;
  }
}

/** A strike's run of targets within one item, and how to re-create any part of it. */
interface Run {
  id: Y.ID;
  len: number;
  make: (from: number, len: number) => string | Y.XmlElement | Y.Map<unknown>;
}

/**
 * A strike as an undo step: `depth` is the binding's undo stack before it; `native` when own text went with it.
 * `runs`: its targets as they were struck; `copies`: what undoing it re-created for targets a rewrite removed.
 */
interface Strike {
  part: string | null;
  targets: IdSpan[];
  depth: number;
  native: boolean;
  runs: Run[];
  copies: IdSpan[];
}

type DeleteSet = Y.UndoManager['undoStack'][number]['deletions'];

/** `set` less the ids in `spans`, as a new delete set. */
function without(set: DeleteSet, spans: readonly IdSpan[]): DeleteSet {
  const out = Y.mergeDeleteSets([set]);
  for (const [client, ranges] of out.clients) {
    let kept = ranges;
    for (const span of spans) {
      if (span.client !== client) continue;
      const end = span.clock + span.len;
      kept = kept.flatMap((range) => {
        const to = range.clock + range.len;
        if (to <= span.clock || range.clock >= end) return [range];
        return [{ clock: range.clock, len: span.clock - range.clock }, { clock: end, len: to - end }].filter((part) => part.len > 0) as typeof ranges;
      });
    }
    out.clients.set(client, kept);
  }
  return out;
}

/** Re-creating or removing struck items: not an undo step of the binding's, but forwarded like any edit of F. */
const RESTORE = Symbol('suggest-restore');

function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  try {
    const struct = Y.getItem(doc.store, id);
    return struct instanceof Y.Item ? struct : null;
  } catch {
    return null;
  }
}

/** An item's index in its parent's sequence. */
function indexOf(item: Y.Item): number {
  let index = 0;
  for (let n = (item.parent as Y.AbstractType<unknown>)._start; n && n !== item; n = n.right) if (!n.deleted && n.countable) index += n.length;
  return index;
}

/** How to re-create part of a struck item: its characters, or a fresh copy of a line break's map or a decorator's element. */
function maker(item: Y.Item): Run['make'] | null {
  const { content } = item;
  if (content instanceof Y.ContentString) {
    const text = content.str;
    return (from, len) => text.slice(from, from + len);
  }
  if (!(content instanceof Y.ContentType)) return null;
  const { type } = content;
  if (type instanceof Y.XmlElement) {
    const name = type.nodeName;
    const attributes = type.getAttributes();
    return () => {
      const element = new Y.XmlElement(name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value as string);
      return element;
    };
  }
  if (type instanceof Y.Map) {
    const entries = Object.entries(type.toJSON());
    return () => {
      const map = new Y.Map<unknown>();
      for (const [key, value] of entries) map.set(key, value);
      return map;
    };
  }
  return null;
}

/** One unit of a sequence: a UTF-16 code unit, or an embed (a text node's map, a line break, a decorator, a block). */
interface Unit {
  sym: string;
  id: Y.ID;
}

function unitsOf(item: Y.Item): Unit[] {
  const { content } = item;
  if (content instanceof Y.ContentFormat || !item.countable) return [];
  if (content instanceof Y.ContentString) {
    const { str } = content;
    return Array.from({ length: str.length }, (_, i) => ({ sym: str[i], id: Y.createID(item.id.client, item.id.clock + i) }));
  }
  let sym = '\0';
  if (content instanceof Y.ContentType) {
    const { type } = content;
    sym = type instanceof Y.XmlElement ? `\0${type.nodeName}` : type instanceof Y.Map ? `\0${String(type.get('__type'))}` : '\0block';
  }
  return Array.from({ length: item.length }, (_, i) => ({ sym, id: Y.createID(item.id.client, item.id.clock + i) }));
}

/** Longest sequences compared at most: a node a rewrite rebuilds is a block's worth of text. */
const ALIGN_CAP = 4_000_000;

/**
 * Pairs units of `from` with units of `to` along a longest common subsequence; null past the cap. Each pair is
 * [index in from, index in to].
 */
function align(from: readonly Unit[], to: readonly Unit[]): Map<number, number> | null {
  const n = from.length;
  const m = to.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > ALIGN_CAP) return null;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      table[i * width + j] = from[i - 1].sym === to[j - 1].sym
        ? table[(i - 1) * width + j - 1] + 1
        : Math.max(table[(i - 1) * width + j], table[i * width + j - 1]);
    }
  }
  const pairs = new Map<number, number>();
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (from[i - 1].sym === to[j - 1].sym && table[i * width + j] === table[(i - 1) * width + j - 1] + 1) {
      pairs.set(i - 1, j - 1);
      i -= 1;
      j -= 1;
    } else if (table[(i - 1) * width + j] >= table[i * width + j - 1]) i -= 1;
    else j -= 1;
  }
  return pairs;
}

/**
 * The run of units `tr` deleted around `item` in its parent (tombstones from earlier transactions skipped); a live item
 * ends it. `start`: the run's first item, the same for every item in it.
 */
function deletedRun(tr: Y.Transaction, item: Y.Item): { units: Unit[]; start: Y.Item } {
  let start = item;
  while (start.left && start.left.deleted) start = start.left;
  const units: Unit[] = [];
  for (let n: Y.Item | null = start; n && n.deleted; n = n.right) if (Y.isDeleted(tr.deleteSet, n.id)) units.push(...unitsOf(n));
  return { units, start };
}

export function registerSuggestRouting(editor: LexicalEditor, fork: SuggestFork): () => void {
  const manager = (): Y.UndoManager | null => (editor as unknown as Record<symbol, Y.UndoManager | undefined>)[UNDO_MANAGER] ?? null;
  const undone: Strike[] = [];
  const redone: Strike[] = [];
  const { doc } = fork;
  /** Each struck item undo re-created, by the original's id. */
  const restoredAs = new Map<string, Y.ID>();
  let watched: Y.UndoManager | null = null;
  /** The body's own undo manager under the binding's stack (BodyUndo also relays its payload docs' managers). */
  let watchedRoot: Y.UndoManager | null = null;
  /** Struck originals a rewrite re-created and the fork removed again: no undo step of the body restores them. */
  const keptOut: IdSpan[] = [];
  /** The body stack the last rewrite's step went to: characters the fork stands in afterwards join that step. */
  let keptIn: Y.UndoManager['undoStack'] | null = null;
  // Any new edit of his own ends the redo history, strikes included.
  const onStack = (event: { type: 'undo' | 'redo' }) => {
    if (event.type === 'undo' && watched && !watched.undoing && !watched.redoing) redone.length = 0;
  };
  // Body ids only: a payload doc's items can carry the same client and clock.
  const onRootStack = (event: { stackItem?: { deletions: DeleteSet } }) => {
    const item = event.stackItem;
    if (item && keptOut.length) item.deletions = without(item.deletions, keptOut);
  };
  const watch = (undo: Y.UndoManager | null) => {
    if (undo === watched) return;
    watched?.off('stack-item-added', onStack);
    watched?.off('stack-item-updated', onStack);
    watchedRoot?.off('stack-item-added', onRootStack);
    watchedRoot?.off('stack-item-updated', onRootStack);
    watched = undo;
    watchedRoot = undo ? ((undo as unknown as { root?: Y.UndoManager }).root ?? undo) : null;
    undo?.on('stack-item-added', onStack);
    undo?.on('stack-item-updated', onStack);
    watchedRoot?.on('stack-item-added', onRootStack);
    watchedRoot?.on('stack-item-updated', onRootStack);
  };
  /** A strike's targets in runs within one item, with their content, read while they stand. */
  const runsOf = (ids: readonly Y.ID[]): Run[] => {
    const runs: (Run & { item: Y.Item })[] = [];
    for (const id of ids) {
      const item = itemAt(doc, id);
      if (!item) continue;
      const last = runs.at(-1);
      if (last && last.item === item && last.id.clock + last.len === id.clock) {
        last.len += 1;
        continue;
      }
      const make = maker(item);
      if (make) runs.push({ item, id, len: 1, make: (from, len) => make(id.clock - item.id.clock + from, len) });
    }
    return runs.map(({ id, len, make }) => ({ id, len, make }));
  };
  /** A strike joins the undo history as its own step; `native` when the next binding step belongs to it. */
  const remember = (part: string, targets: IdSpan[], native: boolean, ids: readonly Y.ID[]) => {
    const undo = manager();
    watch(undo);
    undo?.stopCapturing();
    undone.push({ part, targets, depth: undo?.undoStack.length ?? 0, native, runs: runsOf(ids), copies: [] });
    redone.length = 0;
    if (native) setTimeout(() => manager()?.stopCapturing(), 0);
  };
  /** Where struck items stand by the binding (all of them by default): a text node and offset, or a leaf's key. */
  const spotsOf = (ids?: readonly Y.ID[]): Spot[] => {
    const binding = bindingOf(editor);
    const struck = ids ?? fork.struck().flatMap((span) => Array.from({ length: span.len }, (_, i) => Y.createID(span.client, span.clock + i)));
    if (!binding || struck.length === 0) return [];
    const owners = new Map<Y.Item, string>();
    for (const [key, collab] of binding.collabNodeMap as unknown as Map<string, { _map?: Y.Map<unknown>; _xmlElem?: Y.XmlElement; _xmlText?: Y.XmlText }>) {
      const item = (collab._map ?? collab._xmlElem ?? collab._xmlText)?._item;
      if (item) owners.set(item, key);
    }
    const spots: Spot[] = [];
    for (const id of struck) {
      const item = itemAt(doc, id);
      if (!item || item.deleted) continue;
      if (!(item.content instanceof Y.ContentString)) {
        const key = owners.get(item);
        if (key) spots.push({ id, key, offset: -1 });
        continue;
      }
      // A character: counted from its text node's property map, the embed before it.
      let offset = id.clock - item.id.clock;
      let map: Y.Item | null = null;
      for (let left = item.left; left; left = left.left) {
        if (left.deleted || left.content instanceof Y.ContentFormat) continue;
        if (left.content instanceof Y.ContentString) offset += left.length;
        else {
          map = left;
          break;
        }
      }
      const key = map ? owners.get(map) : undefined;
      if (key) spots.push({ id, key, offset });
    }
    return spots;
  };
  const trace = traceStrikes(editor, () => spotsOf());

  const strike = (ids: readonly Y.ID[], native = false): string | null => {
    const targets = toSpans(ids);
    const part = fork.proposeDelete(targets);
    if (part) {
      remember(part, targets, native, ids);
      trace.add(spotsOf(ids));
    }
    return part;
  };

  /** A binding transaction's copies of struck items: what stands where the trace carried each one. */
  const rewrites = (tr: Y.Transaction): Rewrites | null => {
    const binding = bindingOf(editor);
    if (!binding || tr.origin !== binding) return null;
    const fresh = (id: Y.ID) => id.clock >= (tr.beforeState.get(id.client) ?? 0);
    const copies: [Y.ID, Y.ID][] = [];
    const displaced: Y.ID[] = [];
    const texts = new Map<string, Y.ID[] | null>();
    for (const spot of trace.take()) {
      let actual: Y.ID | undefined;
      if (spot.offset < 0) actual = sharedItem(binding, spot.key)?.id;
      else {
        if (!texts.has(spot.key)) texts.set(spot.key, textIds(binding, spot.key));
        actual = texts.get(spot.key)?.[spot.offset];
      }
      if (!actual || Y.compareIDs(actual, spot.id)) continue;
      if (fresh(actual)) copies.push([actual, spot.id]);
      // The original still stands, elsewhere: the binding kept it for other text.
      if (spot.offset >= 0 && itemAt(doc, spot.id)?.deleted === false) displaced.push(spot.id);
    }
    copies.push(...rebuilt(tr, copies));
    return { copies, displaced };
  };

  /**
   * Struck originals `tr` deleted with no copy traced: an operation rebuilt their node from its text (a Markdown
   * shortcut's replace, a typeahead's cut into a new node), so the text the transaction wrote holds the copy. The
   * units it deleted around each one are aligned with the runs of units it wrote, and the unit the struck one aligns
   * with, beside an aligned neighbour, is its copy.
   */
  const rebuilt = (tr: Y.Transaction, traced: readonly [Y.ID, Y.ID][]): [Y.ID, Y.ID][] => {
    const paired = new Set(traced.map(([, original]) => idKey(original)));
    const used = new Set(traced.map(([copy]) => idKey(copy)));
    const lost: { id: Y.ID; item: Y.Item }[] = [];
    for (const span of fork.struck()) {
      for (let i = 0; i < span.len; i += 1) {
        const id = Y.createID(span.client, span.clock + i);
        if (paired.has(idKey(id)) || !Y.isDeleted(tr.deleteSet, id)) continue;
        const item = itemAt(doc, id);
        if (item?.deleted && item.parentSub === null) lost.push({ id, item });
      }
    }
    if (lost.length === 0) return [];
    const before = tr.beforeState.get(doc.clientID) ?? 0;
    const isFresh = (n: Y.Item) => n.id.client === doc.clientID && n.id.clock >= before;
    // The runs of units the transaction wrote: live fresh items side by side (tombstones between them skipped).
    const runs: Unit[][] = [];
    const seen = new Set<Y.Item>();
    for (const struct of doc.store.clients.get(doc.clientID) ?? []) {
      if (!(struct instanceof Y.Item) || struct.id.clock + struct.length <= before || struct.deleted || struct.parentSub !== null || seen.has(struct)) continue;
      let start = struct;
      while (start.left && (start.left.deleted || isFresh(start.left))) start = start.left;
      const units: Unit[] = [];
      for (let n: Y.Item | null = start; n && (n.deleted || isFresh(n)); n = n.right) {
        if (n.deleted) continue;
        seen.add(n);
        units.push(...unitsOf(n));
      }
      if (units.length) runs.push(units);
    }
    if (runs.length === 0) return [];
    const found: [Y.ID, Y.ID][] = [];
    const alignments = new Map<Y.Item, { units: Unit[]; pairs: (Map<number, number> | null)[] }>();
    for (const { id, item } of lost) {
      const run = deletedRun(tr, item);
      let aligned = alignments.get(run.start);
      if (!aligned) {
        aligned = { units: run.units, pairs: runs.map((units) => align(run.units, units)) };
        alignments.set(run.start, aligned);
      }
      const at = aligned.units.findIndex((unit) => Y.compareIDs(unit.id, id));
      if (at < 0) continue;
      let best: { copy: Y.ID; score: number } | null = null;
      for (let r = 0; r < runs.length; r += 1) {
        const pairs = aligned.pairs[r];
        const to = pairs?.get(at);
        if (!pairs || to === undefined) continue;
        // A neighbour aligned beside it: the struck unit sits in the same text, not on a lone equal character.
        const beside = pairs.get(at - 1) === to - 1 || pairs.get(at + 1) === to + 1 || aligned.units.length === 1;
        const copy = runs[r][to].id;
        if (beside && !used.has(idKey(copy)) && (!best || pairs.size > best.score)) best = { copy, score: pairs.size };
      }
      if (!best) continue;
      used.add(idKey(best.copy));
      found.push([best.copy, id]);
    }
    return found;
  };
  const settle = (tr: Y.Transaction) => {
    if (tr.origin !== bindingOf(editor)) return;
    trace.settle();
  };
  doc.on('beforeTransaction', settle);

  /** The live item standing for `id` now, following re-created copies and the binding's undo restores (`redone`). */
  const liveAt = (id: Y.ID): { item: Y.Item; offset: number } | null => {
    let at = id;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const item = itemAt(doc, at);
      if (!item) return null;
      const offset = at.clock - item.id.clock;
      if (!item.deleted) return { item, offset };
      const copy = restoredAs.get(idKey(at));
      if (copy) at = copy;
      else if (item.redone) at = Y.createID(item.redone.client, item.redone.clock + offset);
      else return null;
    }
    return null;
  };

  /**
   * Where a removed struck run goes back: after the nearest character before it that still stands (earlier characters
   * of its own item first: adjacent strikes can share one), or at its block's start.
   */
  const placeOf = (start: Y.ID): { type: Y.XmlText; index: number } | null => {
    const original = itemAt(doc, start);
    if (!original) return null;
    let item: Y.Item | null = original;
    let clock = start.clock - 1;
    while (item) {
      for (; clock >= item.id.clock; clock -= 1) {
        const live = liveAt(Y.createID(item.id.client, clock));
        if (!live || live.item.parentSub !== null || !(live.item.parent instanceof Y.XmlText)) continue;
        return { type: live.item.parent, index: indexOf(live.item) + (live.item.countable ? live.offset + 1 : 0) };
      }
      item = item.left;
      if (item) clock = item.id.clock + item.length - 1;
    }
    const block = (original.parent as Y.AbstractType<unknown>)._item;
    const live = block ? liveAt(block.id) : null;
    const type = live && live.item.content instanceof Y.ContentType ? live.item.content.type : null;
    return type instanceof Y.XmlText ? { type, index: 0 } : null;
  };

  /** A target the record removes: gone from F (a rewrite's copy of it went too) while it stands in the body. */
  const removed = (id: Y.ID): boolean => itemAt(doc, id)?.deleted !== false && itemAt(fork.body, id)?.deleted === false;

  /** Undo of a strike whose targets a rewrite removed: they come back where they stood, as the author's own. */
  const restore = (strike: Strike): IdSpan[] => {
    const copies: IdSpan[] = [];
    const gone = strike.runs.flatMap((run) => {
      const parts: { id: Y.ID; from: number; len: number; run: Run }[] = [];
      for (let i = 0; i < run.len; i += 1) {
        if (!removed(Y.createID(run.id.client, run.id.clock + i))) continue;
        const last = parts.at(-1);
        if (last && last.from + last.len === i) last.len += 1;
        else parts.push({ id: Y.createID(run.id.client, run.id.clock + i), from: i, len: 1, run });
      }
      return parts;
    });
    if (gone.length === 0) return copies;
    doc.transact(() => {
      for (const { id, from, len, run } of gone) {
        const place = placeOf(id);
        if (!place) continue;
        const client = doc.clientID;
        const clock = Y.getState(doc.store, client);
        const made = run.make(from, len);
        if (typeof made === 'string') place.type.insert(place.index, made);
        else place.type.insertEmbed(place.index, made);
        for (let i = 0; i < len; i += 1) restoredAs.set(idKey({ client: id.client, clock: id.clock + i }), Y.createID(client, clock + i));
        copies.push({ client, clock, len });
      }
    }, RESTORE);
    return copies;
  };

  /** Redo of that strike: the re-created copies go again. */
  const unrestore = (copies: readonly IdSpan[]): void => {
    if (copies.length === 0) return;
    doc.transact(() => {
      for (const span of copies) {
        const end = span.clock + span.len;
        for (let clock = span.clock; clock < end;) {
          const item = itemAt(doc, Y.createID(span.client, clock));
          if (!item) break;
          const offset = clock - item.id.clock;
          const len = Math.min(item.length - offset, end - clock);
          if (!item.deleted && item.parentSub === null && item.parent instanceof Y.XmlText) item.parent.delete(indexOf(item) + offset, len);
          clock += len;
        }
      }
    }, RESTORE);
  };

  /** The targets still standing in the body: redo proposes them again, removed from F or not. */
  const standing = (targets: readonly IdSpan[]): IdSpan[] => {
    const ids: Y.ID[] = [];
    for (const span of targets) {
      for (let i = 0; i < span.len; i += 1) {
        const id = Y.createID(span.client, span.clock + i);
        if (itemAt(fork.body, id)?.deleted === false) ids.push(id);
      }
    }
    return toSpans(ids);
  };

  /** Whether the selection holds anything a delete would change: an unstruck body item or the author's own. */
  const $live = (): boolean => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || selection.isCollapsed() || !binding) return false;
    const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
    for (const node of selection.getNodes()) {
      if ($isTextNode(node)) {
        const ids = textIds(binding, node.getKey());
        if (!ids) continue;
        const from = start.type === 'text' && start.key === node.getKey() ? start.offset : 0;
        const to = end.type === 'text' && end.key === node.getKey() ? end.offset : ids.length;
        if (ids.slice(from, to).some((id) => !fork.isStruck(id))) return true;
        continue;
      }
      if ($isElementNode(node)) continue;
      const item = sharedItem(binding, node.getKey());
      if (item && !fork.isStruck(item.id)) return true;
    }
    return false;
  };

  /**
   * A non-collapsed selection: body items in it become one delete part, the author's own text in it is removed
   * natively, and the caret goes to its end (its start with `toStart`, for a backward word or line delete).
   * `own`: only the author's own text, which deletes natively. `skip`: nothing left to strike; the caret still moves.
   */
  const $routeRange = (toStart = false): Routed => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || selection.isCollapsed() || !binding) return 'none';
    const own = fork.ownClients();
    const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
    const body: Y.ID[] = [];
    const mine: { node: TextNode; from: number; to: number }[] = [];
    const mineLeaves: LexicalNode[] = [];
    for (const node of selection.getNodes()) {
      if ($isTextNode(node)) {
        const ids = textIds(binding, node.getKey());
        if (!ids) continue;
        const from = start.type === 'text' && start.key === node.getKey() ? start.offset : 0;
        const to = end.type === 'text' && end.key === node.getKey() ? end.offset : ids.length;
        let run = -1;
        for (let i = from; i < to; i += 1) {
          const id = ids[i];
          if (own.has(id.client)) {
            if (run < 0) run = i;
            continue;
          }
          if (run >= 0) mine.push({ node, from: run, to: i });
          run = -1;
          if (!fork.isStruck(id)) body.push(id);
        }
        if (run >= 0) mine.push({ node, from: run, to });
        continue;
      }
      if ($isElementNode(node)) continue;
      // A line break or a decorator inside the selection.
      const item = sharedItem(binding, node.getKey());
      if (!item) continue;
      if (own.has(item.id.client)) mineLeaves.push(node);
      else if (!fork.isStruck(item.id)) body.push(item.id);
    }
    const owned = mine.length + mineLeaves.length;
    if (body.length === 0 && owned > 0) return 'own';
    if (body.length > 0 && !strike(body, owned > 0)) return 'skip';
    const at = toStart ? start : end;
    const caret = { key: at.key, offset: at.offset, type: at.type };
    // His own characters go natively, last first so earlier offsets hold (all of them sit after the start).
    for (const { node, from, to } of mine.reverse()) {
      if (!toStart && caret.type === 'text' && node.getKey() === caret.key) caret.offset -= to - from;
      node.spliceText(from, to - from, '', false);
    }
    for (const leaf of mineLeaves) leaf.remove();
    const target = $getNodeByKey(caret.key);
    if (target?.isAttached()) {
      selection.anchor.set(caret.key, Math.max(0, caret.offset), caret.type);
      selection.focus.set(caret.key, Math.max(0, caret.offset), caret.type);
    } else {
      const anchor = selection.anchor.getNode();
      if (anchor.isAttached() && $isTextNode(anchor)) anchor.select(selection.anchor.offset, selection.anchor.offset);
    }
    return body.length > 0 ? 'struck' : 'skip';
  };

  /**
   * Backspace or Delete at a collapsed caret: past struck items to the next character or inline leaf (a link's
   * text, a line break, an inline formula), struck or, if his own, deleted natively. A block edge is native (a join).
   */
  const $routeChar = (backward: boolean): boolean => {
    const selection = $getSelection();
    const binding = bindingOf(editor);
    if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.type !== 'text' || !binding) return false;
    const own = fork.ownClients();
    let node: LexicalNode = selection.anchor.getNode();
    let offset = selection.anchor.offset;
    const step = (from: LexicalNode): boolean => {
      const next = $besideLeaf(from, backward);
      if (!next) return false;
      node = next;
      offset = $isTextNode(next) ? (backward ? next.getTextContentSize() : 0) : 0;
      return true;
    };
    for (let guard = 0; guard < 100_000; guard += 1) {
      if ($isTextNode(node)) {
        const text: TextNode = node;
        const ids = textIds(binding, text.getKey());
        if (!ids) return false;
        const at = backward ? offset - 1 : offset;
        if (at >= 0 && at < ids.length) {
          // A whole character: both halves of a surrogate pair, and a grapheme's combining marks.
          const content = text.getTextContent();
          const [from, to] = content.length === ids.length ? charAround(content, at) : [at, at + 1];
          const id = ids[at];
          if (fork.isStruck(id)) {
            offset = backward ? from : to;
            continue;
          }
          if (own.has(id.client)) {
            const caret = backward ? to : from;
            text.select(caret, caret);
            return false;
          }
          const body = ids.slice(from, to).filter((unit) => !own.has(unit.client) && !fork.isStruck(unit));
          strike(body);
          const caret = backward ? from : to;
          text.select(caret, caret);
          return true;
        }
        if (!step(text)) {
          // A block edge: native, from past the struck text.
          text.select(offset, offset);
          return false;
        }
        continue;
      }
      // A line break, an inline decorator or an empty inline element.
      const leaf: LexicalNode = node;
      const item = sharedItem(binding, leaf.getKey());
      if (!item) return false;
      if (own.has(item.id.client)) {
        if (backward) leaf.selectNext(0, 0);
        else leaf.selectPrevious();
        return false;
      }
      if (!fork.isStruck(item.id)) {
        strike([item.id]);
        if (backward) leaf.selectPrevious();
        else leaf.selectNext(0, 0);
        return true;
      }
      if (!step(leaf)) {
        if (backward) leaf.selectPrevious();
        else leaf.selectNext(0, 0);
        return false;
      }
    }
    return false;
  };

  /**
   * Word or line delete: a collapsed caret extends by `granularity`, past words or lines already struck, and the
   * caret ends beyond what it struck in the delete's direction, so the next one strikes onward.
   */
  const $extended = (backward: boolean, granularity: 'word' | 'lineboundary'): boolean => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return false;
    if (selection.isCollapsed()) {
      for (let guard = 0; guard < 1_000; guard += 1) {
        const { key, offset, type } = selection.focus;
        selection.modify('extend', backward, granularity);
        const moved = selection.focus.key !== key || selection.focus.offset !== offset || selection.focus.type !== type;
        if (!moved || $live()) break;
        // Only struck text so far: go past it and extend again.
        selection.anchor.set(selection.focus.key, selection.focus.offset, selection.focus.type);
      }
    }
    const routed = $routeRange(backward);
    return routed === 'struck' || routed === 'skip';
  };

  const P = COMMAND_PRIORITY_CRITICAL;
  return mergeRegister(
    () => watch(null),
    () => doc.off('beforeTransaction', settle),
    () => trace.stop(),
    fork.traceRewrites(rewrites),
    editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) => {
      const routed = $routeRange();
      return routed === 'none' ? $routeChar(backward) : routed !== 'own';
    }, P),
    editor.registerCommand(DELETE_WORD_COMMAND, (backward) => $extended(backward, 'word'), P),
    editor.registerCommand(DELETE_LINE_COMMAND, (backward) => $extended(backward, 'lineboundary'), P),
    editor.registerCommand(CONTROLLED_TEXT_INSERTION_COMMAND, (payload) => {
      const routed = $routeRange();
      if (routed !== 'struck' && routed !== 'skip') return false;
      const text = typeof payload === 'string' ? payload : (payload.data ?? payload.dataTransfer?.getData('text/plain') ?? '');
      const selection = $getSelection();
      if ($isRangeSelection(selection) && text) selection.insertText(text);
      return true;
    }, P),
    // Enter, Shift+Enter and paste over a selection: strike it, then insert natively at its end.
    editor.registerCommand(INSERT_PARAGRAPH_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(PASTE_COMMAND, () => {
      $routeRange();
      return false;
    }, P),
    editor.registerCommand(CUT_COMMAND, (event) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || selection.isCollapsed()) return false;
      const clipboard = event instanceof ClipboardEvent ? event.clipboardData : null;
      if (clipboard) {
        setLexicalClipboardDataTransfer(clipboard, $getClipboardDataFromSelection(selection));
        event?.preventDefault();
      }
      const routed = $routeRange();
      if (routed === 'own') selection.removeText();
      return true;
    }, P),
    // Undo takes back the latest strike when no later step of his came after it; with own text it removed, the
    // binding's undo of that removal runs in the same keystroke.
    editor.registerCommand(UNDO_COMMAND, () => {
      const undo = manager();
      const last = undone.at(-1);
      if (!last || !undo) return false;
      const expected = last.depth + (last.native ? 1 : 0);
      const length = undo.undoStack.length;
      if (length > expected) return false;
      undone.pop();
      if (last.part) fork.withdrawPart(last.part);
      const copies = restore(last);
      const native = last.native && length === expected;
      redone.push({ ...last, depth: undo.redoStack.length, native, copies });
      return !native;
    }, P),
    editor.registerCommand(REDO_COMMAND, () => {
      const undo = manager();
      const last = redone.at(-1);
      if (!last || !undo) return false;
      const expected = last.depth + (last.native ? 1 : 0);
      const length = undo.redoStack.length;
      if (length > expected) return false;
      redone.pop();
      const native = last.native && length === expected;
      unrestore(last.copies);
      const targets = standing(last.targets);
      const part = targets.length ? fork.proposeDelete(targets) : null;
      if (part || last.copies.length) {
        undo.stopCapturing();
        undone.push({ ...last, part, depth: undo.undoStack.length, native, copies: [] });
      }
      return !native;
    }, P),
    fork.on((event) => {
      // Before the undo manager records the step that re-created them.
      if (event.type === 'kept') {
        watch(manager());
        keptOut.push(...event.originals);
        if (event.added.length) {
          // Made after the rewrite's step was recorded: undo of that step removes them too.
          const step = keptIn?.at(-1);
          if (step) {
            const added = Y.createDeleteSet();
            for (const span of event.added) {
              const ranges = added.clients.get(span.client) ?? [];
              ranges.push({ clock: span.clock, len: span.len } as (typeof ranges)[number]);
              added.clients.set(span.client, ranges);
            }
            step.insertions = Y.mergeDeleteSets([step.insertions, added]);
          }
          keptIn = null;
        } else keptIn = watchedRoot ? (watchedRoot.undoing ? watchedRoot.redoStack : watchedRoot.undoStack) : null;
      }
      // A closed record's steps leave the binding's stacks (pane.tsx dropUndo); its strikes go with them.
      if (event.type === 'closed') {
        undone.length = 0;
        redone.length = 0;
      }
    }),
    editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        const top = $isRangeSelection(selection) ? selection.anchor.getNode().getTopLevelElement() : null;
        fork.caret(top ? top.getIndexWithinParent() : -1);
      });
    }),
  );
}

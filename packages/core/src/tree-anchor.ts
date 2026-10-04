// Comment anchors on the V1 tree (A§13; docs/design/comments.md). An anchor is two RelativePositions into the
// XmlText that holds the text (start sticks right, end sticks left) plus a quote over one projection of the tree that
// every client and the DocDO compute from Y types alone, so no Lexical editor is needed to resolve or re-anchor.
import * as Y from 'yjs';
import { diffText } from './text-diff.ts';

/** Characters of context kept either side of a quote. */
export const QUOTE_CONTEXT = 32;
/** A resolved range still counts as the commented text at this similarity to its quote (glyphdown). */
export const REANCHOR_THRESHOLD = 0.5;
/** Below this length a quote is ambiguous, so a re-anchor also needs its prefix and suffix to match. */
export const MIN_ANCHOR_CHARS = 8;
export const CONTEXT_THRESHOLD = 0.8;
/** A decorator (a V1 XmlElement embed) is one character of the projection. */
export const BLOCK_CHAR = '￼';

export interface TextQuote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TreeAnchor {
  /** base64 Y.RelativePosition, assoc 0 (sticks to the first commented character). */
  start: string;
  /** base64 Y.RelativePosition, assoc -1 (sticks to the last commented character). */
  end: string;
  quote: TextQuote;
  /** The range's last known start in the projection, a tie-breaker for re-anchoring. */
  hint: number;
  status: 'anchored' | 'orphaned';
  /** Set when the DocDO orphans the anchor: the doc's state vector then (base64). Only a later restore reattaches it. */
  orphanedAt?: string;
  /** Set with orphanedAt when the anchor's block was deleted: that block's item id and the range's offset in it. */
  block?: { client: number; clock: number; offset: number };
}

export interface Range {
  start: number;
  end: number;
}

/** A contiguous stretch of one XmlText's content in the projection: text, or one decorator. */
interface Run {
  type: Y.XmlText;
  /** Index of the run's first position inside `type` (embeds count one each). */
  index: number;
  /** Offset of the run's first character in the projection. */
  flat: number;
  length: number;
}

export interface Projection {
  text: string;
  runs: Run[];
  byType: Map<Y.XmlText, Run[]>;
  starts: Map<Y.XmlText, number>;
}

/**
 * The tree as plain text: text nodes as written, a decorator as BLOCK_CHAR, a linebreak as '\n', and one '\n'
 * between blocks (emitted lazily, so empty blocks add nothing). V1 text-node property maps contribute nothing.
 */
export function project(doc: Y.Doc): Projection {
  const root = doc.get('root', Y.XmlText);
  const runs: Run[] = [];
  const byType = new Map<Y.XmlText, Run[]>();
  const starts = new Map<Y.XmlText, number>();
  let text = '';
  let pendingBreak = false;
  const open = () => {
    if (pendingBreak && text.length > 0 && !text.endsWith('\n')) text += '\n';
    pendingBreak = false;
  };
  const push = (run: Run) => {
    runs.push(run);
    const list = byType.get(run.type) ?? [];
    list.push(run);
    byType.set(run.type, list);
  };
  const visit = (type: Y.XmlText) => {
    starts.set(type, text.length);
    let index = 0;
    for (const { insert } of type.toDelta() as { insert: unknown }[]) {
      if (typeof insert === 'string') {
        open();
        push({ type, index, flat: text.length, length: insert.length });
        text += insert;
        index += insert.length;
        continue;
      }
      if (insert instanceof Y.XmlText) {
        pendingBreak = true;
        visit(insert);
        pendingBreak = true;
      } else if (insert instanceof Y.XmlElement) {
        if (type === root) pendingBreak = true;
        open();
        push({ type, index, flat: text.length, length: 1 });
        text += BLOCK_CHAR;
        if (type === root) pendingBreak = true;
      } else if (insert instanceof Y.Map && insert.get('__type') === 'linebreak') {
        open();
        text += '\n';
      }
      index += 1;
    }
  };
  visit(root);
  return { text, runs, byType, starts };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += B64[a >> 2] + B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let at = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((k) => Math.max(0, B64.indexOf(clean[i + k] ?? 'A')));
    const chunk = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    const have = Math.min(4, clean.length - i);
    if (have > 1) bytes[at++] = (chunk >> 16) & 0xff;
    if (have > 2) bytes[at++] = (chunk >> 8) & 0xff;
    if (have > 3) bytes[at++] = chunk & 0xff;
  }
  return bytes;
}

export const encodeRelPos = (position: Y.RelativePosition): string => toBase64(Y.encodeRelativePosition(position));
export const decodeRelPos = (value: string): Y.RelativePosition => Y.decodeRelativePosition(fromBase64(value));

/** The tree position of a projection offset: a start prefers the run it opens, an end the run it closes. */
function positionAt(projection: Projection, flat: number, assoc: 0 | -1): Y.RelativePosition | null {
  const fits = (run: Run) => (assoc < 0 ? flat > run.flat : flat < run.flat + run.length);
  let best: Run | undefined;
  for (const run of projection.runs) {
    if (flat < run.flat || flat > run.flat + run.length) continue;
    if (!best || (!fits(best) && fits(run))) best = run;
  }
  return best ? Y.createRelativePositionFromTypeIndex(best.type, best.index + (flat - best.flat), assoc) : null;
}

/** The projection offset of an index inside an XmlText; an index between runs maps to the next run's start. */
function flatOf(projection: Projection, type: Y.XmlText, index: number): number | null {
  const runs = projection.byType.get(type);
  if (!runs) return projection.starts.get(type) ?? null;
  let after: number | null = null;
  for (const run of runs) {
    if (index >= run.index && index <= run.index + run.length) return run.flat + (index - run.index);
    if (run.index > index) return run.flat;
    after = run.flat + run.length;
  }
  return after;
}

export function captureQuote(text: string, start: number, end: number): TextQuote {
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT), start),
    suffix: text.slice(end, end + QUOTE_CONTEXT),
  };
}

/** Mints an anchor over projection offsets [start, end); a side that lands on no run is left empty. */
export function mintAnchor(doc: Y.Doc, start: number, end: number, projection = project(doc)): TreeAnchor {
  const from = positionAt(projection, start, 0);
  const to = positionAt(projection, end, -1);
  return {
    start: from ? encodeRelPos(from) : '',
    end: to ? encodeRelPos(to) : '',
    quote: captureQuote(projection.text, start, end),
    hint: start,
    status: 'anchored',
  };
}

/**
 * The anchor's range from its RelativePositions alone, or null when a side no longer resolves into the tree or the
 * range inverted. Yjs's own `redone` links are not followed: they exist only in the undoing client (yjs#638).
 */
export function resolveAnchor(doc: Y.Doc, anchor: TreeAnchor, projection = project(doc)): Range | null {
  return resolveSides(doc, anchor, projection, null).range;
}

/**
 * Items inserted after a fence that name a right origin, by that origin's client. Yjs's undo re-inserts a deleted item
 * as a copy whose right origin is the deleted item itself (UndoManager `redoItem`). A peer that had seen the deletion
 * never names it, because an insert steps over deleted items to its right; a peer that typed before it saw the
 * deletion can, so a candidate copy must also carry the commented characters (`restoredId`, `validateAnchor`).
 */
export type Restores = Map<number, Y.Item[]>;

function restoresAfter(doc: Y.Doc, fence: Map<number, number>): Restores {
  const out: Restores = new Map();
  for (const [client, structs] of doc.store.clients) {
    const from = fence.get(client) ?? 0;
    for (const struct of structs) {
      if (struct.id.clock < from || !(struct instanceof Y.Item) || !struct.rightOrigin) continue;
      const list = out.get(struct.rightOrigin.client) ?? [];
      list.push(struct);
      out.set(struct.rightOrigin.client, list);
    }
  }
  return out;
}

function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (id.clock >= Y.getState(doc.store, id.client)) return null;
  const struct = Y.getItem(doc.store, id) as Y.Item | Y.GC;
  return struct instanceof Y.Item ? struct : null;
}

const sameId = (a: Y.ID | null, b: Y.ID | null) => a !== null && b !== null && a.client === b.client && a.clock === b.clock;

/** The first clock of the copy `item` belongs to: Yjs splits a copy into pieces that share its right origin. */
function copyStart(doc: Y.Doc, item: Y.Item): number {
  let at = item;
  for (;;) {
    const origin = at.origin;
    if (!origin || origin.client !== at.id.client || origin.clock !== at.id.clock - 1) return at.id.clock;
    const previous = itemAt(doc, origin);
    if (!previous || !sameId(previous.rightOrigin, item.rightOrigin)) return at.id.clock;
    at = previous;
  }
}

/** The projected character at `id`: a text character, or BLOCK_CHAR for an embed. */
function charAt(doc: Y.Doc, id: Y.ID): string | null {
  const item = itemAt(doc, id);
  if (!item || item.deleted) return null;
  if (item.content instanceof Y.ContentString) return item.content.str[id.clock - item.id.clock] ?? null;
  return item.content instanceof Y.ContentType || item.content instanceof Y.ContentEmbed ? BLOCK_CHAR : null;
}

/**
 * The id that restored the deleted character `id`, or null when nothing after the fence restored it. The copy must
 * hold `expected` (the commented character on that side), so text a peer typed in front of the deletion before it saw
 * it, which names the same right origin, is not taken for a restore.
 */
function restoredId(doc: Y.Doc, id: Y.ID, restores: Restores, expected: string | undefined): Y.ID | null {
  for (const item of restores.get(id.client) ?? []) {
    const origin = item.rightOrigin!;
    // A restored copy names the deleted item it replaces; text typed before it names a character that was live.
    if (origin.clock > id.clock || !itemAt(doc, origin)?.deleted) continue;
    const start = copyStart(doc, item);
    const target = Y.createID(item.id.client, start + (id.clock - origin.clock));
    const copy = itemAt(doc, target);
    if (!copy || !sameId(copy.rightOrigin, origin) || copyStart(doc, copy) !== start) continue;
    if (expected === undefined || charAt(doc, target) === expected) return target;
  }
  return null;
}

/** A position whose character was deleted moves to the character's restored copy, following repeated undos. */
function followRestore(
  doc: Y.Doc,
  position: Y.RelativePosition,
  restores: Restores,
  expected: string | undefined,
): { position: Y.RelativePosition; restored: boolean } {
  let id = position.item;
  let restored = false;
  for (let hop = 0; id && hop < 8; hop += 1) {
    if (!itemAt(doc, id)?.deleted) break;
    const next = restoredId(doc, id, restores, expected);
    if (!next) break;
    id = next;
    restored = true;
  }
  return restored && id ? { position: new Y.RelativePosition(null, null, id, position.assoc), restored } : { position, restored: false };
}

function resolveSides(doc: Y.Doc, anchor: TreeAnchor, projection: Projection, restores: Restores | null): { range: Range | null; restored: boolean } {
  if (!anchor.start || !anchor.end) return { range: null, restored: false };
  let restored = false;
  const side = (value: string, expected: string | undefined) => {
    let position = decodeRelPos(value);
    if (restores) {
      const followed = followRestore(doc, position, restores, expected);
      position = followed.position;
      restored ||= followed.restored;
    }
    const absolute = Y.createAbsolutePositionFromRelativePosition(position, doc, false);
    return absolute && absolute.type instanceof Y.XmlText ? flatOf(projection, absolute.type, absolute.index) : null;
  };
  const { exact } = anchor.quote;
  const start = side(anchor.start, exact ? exact[0] : undefined);
  const end = side(anchor.end, exact ? exact[exact.length - 1] : undefined);
  if (start === null || end === null || end < start) return { range: null, restored: false };
  return { range: { start, end }, restored };
}

/** Where a deleted block now starts, when a copy inserted after the fence restored it. */
function restoredBlock(block: NonNullable<TreeAnchor['block']>, projection: Projection, restores: Restores): number | null {
  let id: Y.ID = Y.createID(block.client, block.clock);
  for (let hop = 0; hop < 8; hop += 1) {
    const copy = (restores.get(id.client) ?? []).find((item) => sameId(item.rightOrigin, id) && item.content instanceof Y.ContentType);
    if (!copy) return null;
    if (!copy.deleted) {
      const type = (copy.content as Y.ContentType).type;
      return type instanceof Y.XmlText ? projection.starts.get(type) ?? null : null;
    }
    id = copy.id;
  }
  return null;
}

/** Shared characters over total length, 0..1, from the same edit script the title binding uses. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  // Every character of `a` is kept or deleted; the script leaves the common prefix and suffix as implicit retains.
  let equal = a.length;
  for (const op of diffText(a, b)) if ('delete' in op) equal -= op.delete;
  return (2 * equal) / (a.length + b.length);
}

const contextMatch = (actual: string, expected: string) => (expected.length === 0 && actual.length === 0 ? 1 : similarity(actual, expected));

/** Where a quote now lives: the exact occurrence with the best context, nearest the hint on ties. */
export function findQuote(text: string, quote: TextQuote, hint: number): Range | null {
  const { exact } = quote;
  if (!exact.length) return null;
  let best: { start: number; prefix: number; suffix: number } | null = null;
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const prefix = contextMatch(text.slice(Math.max(0, at - quote.prefix.length), at), quote.prefix);
    const suffix = contextMatch(text.slice(at + exact.length, at + exact.length + quote.suffix.length), quote.suffix);
    const score = prefix + suffix;
    const bestScore = best ? best.prefix + best.suffix : -1;
    if (!best || score > bestScore || (score === bestScore && Math.abs(at - hint) < Math.abs(best.start - hint))) best = { start: at, prefix, suffix };
  }
  if (!best) return null;
  if (exact.length < MIN_ANCHOR_CHARS && (best.prefix < CONTEXT_THRESHOLD || best.suffix < CONTEXT_THRESHOLD)) return null;
  return { start: best.start, end: best.start + exact.length };
}

const sameQuote = (a: TextQuote, b: TextQuote) => a.exact === b.exact && a.prefix === b.prefix && a.suffix === b.suffix;

const fenceOf = (anchor: TreeAnchor) => (anchor.orphanedAt ? Y.decodeStateVector(fromBase64(anchor.orphanedAt)) : null);

/**
 * Keeps an anchor whose positions still cover its quote, refreshing the quote to the text they now cover. A comment
 * never jumps: when its text or block is deleted it is orphaned with its positions kept, and it comes back only where
 * a later undo or restore re-inserts that same text (a copy whose right origin is the deleted item and which reads
 * exactly as the quote, so a peer's text that merely names the deleted item never takes its place). The quote is
 * searched only for an anchor that never had positions (an import, a paste, a quote-only REST comment). Pure:
 * `changed` says the anchor differs in anything but its hint, which is what the caller persists.
 */
export function validateAnchor(
  doc: Y.Doc,
  anchor: TreeAnchor,
  projection = project(doc),
  restores?: Restores,
): { anchor: TreeAnchor; range: Range | null; reanchored: boolean; changed: boolean } {
  const orphan = () => ({ anchor: { ...anchor, status: 'orphaned' as const }, range: null, reanchored: false, changed: anchor.status !== 'orphaned' });
  if (!anchor.start || !anchor.end) {
    const found = findQuote(projection.text, anchor.quote, anchor.hint);
    return found ? { anchor: mintAnchor(doc, found.start, found.end, projection), range: found, reanchored: true, changed: true } : orphan();
  }
  const fence = fenceOf(anchor);
  const known = fence ? (restores ?? restoresAfter(doc, fence)) : null;
  const { exact } = anchor.quote;
  const covers = (range: Range | null): range is Range =>
    range !== null && (exact.length === 0 || similarity(projection.text.slice(range.start, range.end), exact) >= REANCHOR_THRESHOLD);
  let { range, restored } = resolveSides(doc, anchor, projection, known);
  if (!covers(range) && known && anchor.block) {
    const at = restoredBlock(anchor.block, projection, known);
    const start = at === null ? -1 : at + anchor.block.offset;
    if (start >= 0 && projection.text.slice(start, start + exact.length) === exact) {
      range = { start, end: start + exact.length };
      restored = true;
    }
  }
  if (!covers(range)) return orphan();
  if (restored && projection.text.slice(range.start, range.end) !== exact) return orphan();
  if (restored) return { anchor: mintAnchor(doc, range.start, range.end, projection), range, reanchored: true, changed: true };
  const quote = captureQuote(projection.text, range.start, range.end);
  const changed = anchor.status !== 'anchored' || !sameQuote(quote, anchor.quote);
  const kept = { ...anchor };
  delete kept.orphanedAt;
  delete kept.block;
  return { anchor: { ...kept, quote, hint: range.start, status: 'anchored' }, range, reanchored: false, changed };
}

/**
 * Every anchored comment's range just before a frame applies, the projection it was read from, the doc's state vector
 * then (the fence for a restore inside the frame), and the text-node structure of each block holding a range's side.
 */
export interface FrameBefore {
  projection: Projection;
  ranges: Map<string, Range>;
  vector: string;
  shapes: Map<Y.XmlText, string>;
}

/** A block's text-node structure: the ids of its embeds (V1 text-node property maps, linebreaks, decorators). */
function shapeOf(type: Y.XmlText): string {
  const ids: string[] = [];
  for (const { insert } of type.toDelta() as { insert: unknown }[]) {
    if (insert instanceof Y.AbstractType && insert._item) ids.push(`${insert._item.id.client}:${insert._item.id.clock}`);
  }
  return ids.join(',');
}

export function anchorsBefore(doc: Y.Doc): FrameBefore {
  const projection = project(doc);
  const ranges = new Map<string, Range>();
  const shapes = new Map<Y.XmlText, string>();
  for (const [id, record] of doc.getMap<{ anchor?: TreeAnchor }>('comments')) {
    if (record?.anchor?.status !== 'anchored') continue;
    const range = resolveAnchor(doc, record.anchor, projection);
    if (!range || range.end <= range.start) continue;
    ranges.set(id, range);
    for (const side of [sideAt(projection, range.start, 0), sideAt(projection, range.end, -1)]) {
      if (side && !shapes.has(side.type)) shapes.set(side.type, shapeOf(side.type));
    }
  }
  return { projection, ranges, vector: toBase64(Y.encodeStateVector(doc)), shapes };
}

/** One side of a range as its XmlText and an offset into that type's own projected text. */
function sideAt(projection: Projection, flat: number, assoc: 0 | -1): { type: Y.XmlText; local: number } | null {
  const fits = (run: Run) => (assoc < 0 ? flat > run.flat : flat < run.flat + run.length);
  let best: Run | undefined;
  for (const run of projection.runs) {
    if (flat < run.flat || flat > run.flat + run.length) continue;
    if (!best || (!fits(best) && fits(run))) best = run;
  }
  if (!best) return null;
  let local = flat - best.flat;
  for (const run of projection.byType.get(best.type) ?? []) {
    if (run === best) break;
    local += run.length;
  }
  return { type: best.type, local };
}

function flatAtLocal(projection: Projection, type: Y.XmlText, local: number, assoc: 0 | -1): number | null {
  let before = 0;
  let edge: number | null = null;
  for (const run of projection.byType.get(type) ?? []) {
    const offset = local - before;
    if (assoc < 0 ? offset > 0 && offset <= run.length : offset >= 0 && offset < run.length) return run.flat + offset;
    if (offset === 0 || offset === run.length) edge ??= run.flat + offset;
    before += run.length;
  }
  return edge;
}

const typeText = (projection: Projection, type: Y.XmlText) =>
  (projection.byType.get(type) ?? []).map((run) => projection.text.slice(run.flat, run.flat + run.length)).join('');

/**
 * A range carried through a frame that split or merged text nodes in its blocks without changing their projected
 * text: a format split rewrites a text node's Y items without changing a character, so the comment keeps the same
 * offsets in those blocks. A frame that leaves the text nodes as they were (a delete and a retype of the same text)
 * is no split, and the comment stays orphaned.
 */
function mapThroughFrame(frame: FrameBefore, after: Projection, range: Range): Range | null {
  const before = frame.projection;
  const start = sideAt(before, range.start, 0);
  const end = sideAt(before, range.end, -1);
  if (!start || !end) return null;
  let split = false;
  for (const type of new Set([start.type, end.type])) {
    if (!after.byType.has(type) || typeText(before, type) !== typeText(after, type)) return null;
    if (shapeOf(type) !== frame.shapes.get(type)) split = true;
  }
  if (!split) return null;
  const from = flatAtLocal(after, start.type, start.local, 0);
  const to = flatAtLocal(after, end.type, end.local, -1);
  return from !== null && to !== null && to > from ? { start: from, end: to } : null;
}

/** The outermost deleted block holding a range's start, and the range's offset in it, so a restore of it can be found. */
function deletedBlock(before: Projection, range: Range): TreeAnchor['block'] {
  // Walk the types, not their items' content: a deleted block's item content is already garbage-collected.
  let top: Y.XmlText | null = null;
  let type: unknown = sideAt(before, range.start, 0)?.type;
  while (type instanceof Y.AbstractType && type._item) {
    if (type._item.deleted && type instanceof Y.XmlText) top = type;
    type = type._item.parent;
  }
  const start = top ? before.starts.get(top) : undefined;
  return top?._item && start !== undefined ? { client: top._item.id.client, clock: top._item.id.clock, offset: range.start - start } : undefined;
}

/**
 * Validates every anchor in `Y.Map('comments')` and rewrites, in one transaction under `origin`, the records whose
 * anchor changed. The DocDO calls it in the same synchronous step that applies a `root` frame, with `before` taken just
 * before that frame, so the refresh is persisted beside the frame and a restart never loses it (comments.md §3.4). A
 * newly orphaned anchor keeps its positions and records the fence (and deleted block) a restore must come after; the
 * fence is the state before the frame, so an undo sent in the same frame as its deletion reattaches it at once.
 * Returns the ids it rewrote.
 */
export function refreshAnchors(doc: Y.Doc, origin: unknown, before?: FrameBefore): string[] {
  const comments = doc.getMap<{ anchor?: TreeAnchor }>('comments');
  const rewritten: [string, { anchor?: TreeAnchor }][] = [];
  const indexes = new Map<string, Restores>();
  let projection: Projection | null = null;
  for (const [id, record] of comments) {
    const anchor = record?.anchor;
    if (!anchor) continue;
    projection ??= project(doc);
    const fence = fenceOf(anchor);
    let known: Restores | undefined;
    if (fence) {
      known = indexes.get(anchor.orphanedAt!) ?? restoresAfter(doc, fence);
      indexes.set(anchor.orphanedAt!, known);
    }
    const checked = validateAnchor(doc, anchor, projection, known);
    let { anchor: next, changed } = checked;
    const { range } = checked;
    const was = before?.ranges.get(id);
    const mapped = was && before ? mapThroughFrame(before, projection, was) : null;
    if (mapped && (range?.start !== mapped.start || range?.end !== mapped.end)) {
      next = mintAnchor(doc, mapped.start, mapped.end, projection);
      changed = true;
    } else if (next.status === 'orphaned' && anchor.status !== 'orphaned') {
      const block = was && before ? deletedBlock(before.projection, was) : undefined;
      const fenced = { ...anchor, orphanedAt: before?.vector ?? toBase64(Y.encodeStateVector(doc)), ...(block ? { block } : {}) };
      // Validated again behind the fence, so a restore in this same frame counts.
      ({ anchor: next } = validateAnchor(doc, fenced, projection));
      changed = true;
    }
    if (changed) rewritten.push([id, { ...record, anchor: next }]);
  }
  if (rewritten.length > 0) doc.transact(() => { for (const [id, record] of rewritten) comments.set(id, record); }, origin);
  return rewritten.map(([id]) => id);
}


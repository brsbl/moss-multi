// The frame-scoped comment anchor engine (docs/design/comments.md §4). Pure: it reads one Yjs transaction before
// garbage collection (afterTransaction, F1) and returns the anchor records that change; the caller writes them
// through writeComments in the same synchronous turn. Nothing here searches the document for text, scores
// similarity, or trusts undo-copy identity: an anchor shrinks to its own survivors, is re-minted onto text the same
// frame inserted between the same survivors (I4), or is orphaned with its lost place and comes back only when live
// items inside that place read exactly as the lost passage did (I5).
import * as Y from 'yjs';
import { BLOCK_CHAR, fromBase64, toBase64 } from './tree-anchor.ts';

/** Structs one gap walk may visit in each direction; past it the walk fails safe (I7). */
export const WALK_BUDGET = 4096;
export const MAX_QUOTE = 10_000;
export const MAX_MEMBER_RUNS = 512;
export const MAX_LIFT_DEPTH = 3;
/** Comments that may cover any one character (checked at create), which bounds every per-item index fan-out. */
export const OVERLAP_CAP = 32;
/** Tokens one range, place or signature walk may produce. */
export const TOKEN_BUDGET = 65_536;
const RANGE_BUDGET = WALK_BUDGET + 4 * MAX_QUOTE;
/** Structs one hit comment may visit: two gap walks, two range walks, the loss emission and one check. */
export const COMMENT_BUDGET = 2 * WALK_BUDGET + 4 * RANGE_BUDGET;

export type ItemId = [client: number, clock: number];

/** A token stream's signature: a 128-bit SHA-256 prefix, its length, and the comment's span [a, b) inside it. */
export interface Sig {
  h: string;
  n: number;
  a: number;
  b: number;
}

/** One list's part of a lost place: (left, last] over the deleted members, or (left, right) once re-homed (§4.5). */
export interface Seg {
  list: ItemId | 'root';
  left: ItemId | null;
  last?: ItemId;
  right?: ItemId | null;
}

/** A lost place lifted out of a deleted block: its signature, its token offset, and its list's token in the outer. */
export interface Inner {
  at: number;
  list: number;
  pre: Sig;
  inner?: Inner;
}

export interface LostPlace {
  v: 1;
  segs: Seg[];
  /** Top-level deleted members as [client, clock, length] runs. */
  members: [number, number, number][];
  pre: Sig;
  inner?: Inner;
}

/** The `a:<id>` record. */
export interface Anchor {
  kind: 'text' | 'block';
  /** b64 RelativePosition on the first unit, assoc 0. */
  start: string;
  /** b64 RelativePosition on the last unit, assoc -1. */
  end: string;
  status: 'anchored' | 'orphaned';
  /** Server-computed at mint, rewritten only on a status change; display only. */
  quote: string;
  lost?: LostPlace;
}

/** A character, decorator or embed: an item and the offset of the unit inside it. */
export interface Unit {
  item: Y.Item;
  off: number;
}

/** Counted work in the last frame, so the cost bound is tested by counters, not timing. */
export interface FrameStats {
  structs: number;
  comments: number;
  lookups: number;
}

class OverBudget extends Error {}

class Walk {
  #used = 0;
  constructor(
    private readonly limit: number,
    private readonly stats: FrameStats,
  ) {}

  tick(): void {
    this.stats.structs += 1;
    this.#used += 1;
    if (this.#used > this.limit) throw new OverBudget();
  }
}

const scratch = (): FrameStats => ({ structs: 0, comments: 0, lookups: 0 });

/** Which items count as present when reading a stream: before the frame, after it, or simply live. */
type Live = (item: Y.Item) => boolean;
const isLive: Live = (item) => !item.deleted;

const parentOf = (item: Y.Item) => item.parent as Y.AbstractType<unknown>;
const listOf = (item: Y.Item): Y.XmlText | null =>
  item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlText ? item.content.type : null;

function unitAt(doc: Y.Doc, id: Y.ID | ItemId | null): Unit | null {
  if (!id) return null;
  const [client, clock] = Array.isArray(id) ? id : [id.client, id.clock];
  if (clock >= Y.getState(doc.store, client)) return null;
  const struct = Y.getItem(doc.store, Y.createID(client, clock));
  return struct instanceof Y.Item ? { item: struct, off: clock - struct.id.clock } : null;
}

const positionOf = (value: string): Y.ID | null => (value ? Y.decodeRelativePosition(fromBase64(value)).item : null);

export function encodePosition(unit: Unit, assoc: 0 | -1): string {
  const item = { client: unit.item.id.client, clock: unit.item.id.clock + unit.off };
  return toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromJSON({ type: null, tname: null, item, assoc })));
}

/** A type's attributes as one sorted string, each key read at its value under `live` (pre-frame or post-frame). */
function attrs(type: Y.AbstractType<unknown>, live: Live): string {
  const out: string[] = [];
  for (const key of [...type._map.keys()].sort()) {
    let at: Y.Item | null = type._map.get(key) ?? null;
    while (at && !live(at)) at = at.left;
    if (!at) continue;
    const values = at.content.getContent();
    const value: unknown = values[values.length - 1];
    out.push(JSON.stringify([key, value instanceof Y.AbstractType ? '[type]' : value ?? null]));
  }
  return out.join(',');
}

interface Tok {
  t: string;
  item: Y.Item;
  off: number;
}

/**
 * The tokens of one item's own content. `text` mode, for gap maps: characters and decorator fingerprints. `full`
 * mode, for lost places: also block opens, text-node property maps, linebreaks and formats.
 */
function own(item: Y.Item, from: number, to: number, full: boolean, live: Live, out: Tok[]): void {
  const content = item.content;
  if (content instanceof Y.ContentString) {
    for (let i = from; i <= to; i += 1) out.push({ t: content.str[i], item, off: i });
    return;
  }
  if (content instanceof Y.ContentType) {
    const type = content.type;
    if (type instanceof Y.XmlText) {
      if (full) out.push({ t: `B${attrs(type, live)}`, item, off: 0 });
    } else if (type instanceof Y.XmlElement) {
      out.push({ t: `D${type.nodeName}|${attrs(type, live)}`, item, off: 0 });
    } else if (type instanceof Y.Map) {
      if (full) out.push({ t: `M${attrs(type, live)}`, item, off: 0 });
    } else {
      out.push({ t: 'T|', item, off: 0 });
    }
    return;
  }
  if (content instanceof Y.ContentFormat) {
    if (full) out.push({ t: `F${content.key}=${JSON.stringify(content.value)}`, item, off: 0 });
    return;
  }
  if (content instanceof Y.ContentDeleted) return;
  const values = content.getContent();
  for (let i = from; i <= to; i += 1) out.push({ t: `E${JSON.stringify(values[i] ?? null)}`, item, off: i });
}

/** Token offsets of every item an emission visits, live or not: where its subtree starts and ends. */
type Spans = Map<Y.Item, [number, number]>;

function emitSubtree(item: Y.Item, full: boolean, live: Live, out: Tok[], walk: Walk, spans?: Spans): void {
  walk.tick();
  const start = out.length;
  if (live(item)) {
    own(item, 0, item.length - 1, full, live, out);
    if (out.length > TOKEN_BUDGET) throw new OverBudget();
    const list = listOf(item);
    if (list) for (let child = list._start; child; child = child.right) emitSubtree(child, full, live, out, walk, spans);
  }
  spans?.set(item, [start, out.length]);
}

/** The next item in flattened order: a block's children follow its open item. */
function next(item: Y.Item): Y.Item | null {
  const list = listOf(item);
  if (list?._start) return list._start;
  for (let at: Y.Item = item; ; ) {
    if (at.right) return at.right;
    const up = parentOf(at)._item;
    if (!up) return null;
    at = up;
  }
}

interface Entry {
  item: Y.Item;
  from: number;
  to: number;
}

/** Every item from unit `s` to unit `e` inclusive, in flattened order, with the unit sub-range of the end items. */
function rangeEntries(s: Unit, e: Unit, walk: Walk): Entry[] {
  const out: Entry[] = [];
  for (let at: Y.Item | null = s.item; ; at = next(at)) {
    walk.tick();
    if (!at) throw new OverBudget();
    out.push({ item: at, from: at === s.item ? s.off : 0, to: at === e.item ? e.off : at.length - 1 });
    if (at === e.item) return out;
  }
}

function entryTokens(entries: Entry[], full: boolean, live: Live): Tok[] {
  const out: Tok[] = [];
  for (const entry of entries) {
    if (live(entry.item)) own(entry.item, entry.from, entry.to, full, live, out);
    if (out.length > TOKEN_BUDGET) throw new OverBudget();
  }
  return out;
}

const textOf = (tokens: Tok[]) => tokens.map((tok) => (tok.t.length === 1 ? tok.t : BLOCK_CHAR)).join('');

/** Stub: indexes nothing and changes nothing (the red-first run of T4.0). */
export class AnchorEngine {
  stats: FrameStats = scratch();
  readonly #records = new Map<string, Anchor>();

  constructor(readonly doc: Y.Doc) {}

  load(records: Iterable<[string, Anchor]>): void {
    for (const [id, anchor] of records) this.set(id, anchor);
  }

  get(id: string): Anchor | undefined {
    return this.#records.get(id);
  }

  set(id: string, anchor: Anchor | undefined): void {
    if (anchor) this.#records.set(id, anchor);
    else this.#records.delete(id);
  }

  frame(txn: Y.Transaction): Map<string, Anchor> {
    if (txn.doc !== this.doc) throw new Error('another doc');
    this.stats = scratch();
    return new Map();
  }
}

/** The live tree's text-mode units, a decorator as U+FFFC: what a client selection or a test mints from. */
export function liveUnits(doc: Y.Doc): { text: string; units: Unit[] } {
  const tokens: Tok[] = [];
  const walk = new Walk(Number.POSITIVE_INFINITY, scratch());
  for (let child = doc.get('root', Y.XmlText)._start; child; child = child.right) emitSubtree(child, false, isLive, tokens, walk);
  return { text: textOf(tokens), units: tokens.map(({ item, off }) => ({ item, off })) };
}

/** A record minted on live units `first`..`last`, with the server-computed quote. */
export function mintAnchor(first: Unit, last: Unit, kind: Anchor['kind'] = 'text'): Anchor {
  const tokens = entryTokens(rangeEntries(first, last, new Walk(Number.POSITIVE_INFINITY, scratch())), false, isLive);
  return { kind, start: encodePosition(first, 0), end: encodePosition(last, -1), status: 'anchored', quote: textOf(tokens) };
}

/** The text an anchored record paints, or null when it is orphaned or its positions no longer resolve. */
export function anchorText(doc: Y.Doc, anchor: Anchor): string | null {
  if (anchor.status !== 'anchored') return null;
  const s = unitAt(doc, positionOf(anchor.start));
  const e = unitAt(doc, positionOf(anchor.end));
  if (!s || !e || s.item.deleted || e.item.deleted) return null;
  try {
    return textOf(entryTokens(rangeEntries(s, e, new Walk(RANGE_BUDGET, scratch())), false, isLive));
  } catch (error) {
    if (error instanceof OverBudget) return null;
    throw error;
  }
}

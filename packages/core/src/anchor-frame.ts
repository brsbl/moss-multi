// The frame-scoped comment anchor engine (docs/design/comments.md §5). Pure: it reads one Yjs transaction before
// garbage collection (afterTransaction, F1) and returns the anchor records that change; the caller writes them
// through writeComments in the same synchronous turn. Nothing here searches the document for text, scores
// similarity, or trusts undo-copy identity: an anchor shrinks to its own survivors, is re-minted onto text the same
// frame inserted between the same survivors (I4), or is orphaned with its lost place and comes back only when live
// items inside that place read exactly as the lost passage did (I5).
import { digest } from 'lib0/hash/sha256';
import { encodeUtf8 } from 'lib0/string';
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

/** One list's part of a lost place: (left, last] over the deleted members, or (left, right) once re-homed (§5.5). */
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

/** Liveness relative to one transaction (comments.md §5 predicates). */
class View {
  constructor(readonly txn: Y.Transaction) {}

  isNew(item: Y.Item): boolean {
    return item.id.clock >= (this.txn.beforeState.get(item.id.client) ?? 0);
  }

  deletedNow(item: Y.Item): boolean {
    return item.deleted && Y.isDeleted(this.txn.deleteSet, item.id);
  }

  readonly pre: Live = (item) => !this.isNew(item) && (!item.deleted || this.deletedNow(item));

  survivor(item: Y.Item): boolean {
    return !item.deleted && !this.isNew(item);
  }
}

const parentOf = (item: Y.Item) => item.parent as Y.AbstractType<unknown>;
const listOf = (item: Y.Item): Y.XmlText | null =>
  item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlText ? item.content.type : null;
const idOf = (id: Y.ID): ItemId => [id.client, id.clock];
const keyOf = (id: Y.ID | ItemId) => (Array.isArray(id) ? `${id[0]}:${id[1]}` : `${id.client}:${id.clock}`);
const contains = (item: Y.Item, id: ItemId) => item.id.client === id[0] && id[1] >= item.id.clock && id[1] < item.id.clock + item.length;

/** A character, a decorator or an opaque embed: something a comment can start or end on. */
function isUnit(item: Y.Item): boolean {
  const content = item.content;
  if (content instanceof Y.ContentType) return !(content.type instanceof Y.XmlText) && !(content.type instanceof Y.Map);
  return !(content instanceof Y.ContentFormat) && !(content instanceof Y.ContentDeleted);
}

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
function attrs(type: { _map: Map<string, Y.Item> }, live: Live): string {
  const out: string[] = [];
  for (const key of [...type._map.keys()].sort()) {
    let at: Y.Item | null = type._map.get(key) ?? null;
    while (at && !live(at)) at = at.left;
    if (!at) continue;
    const values = at.content.getContent();
    const value: unknown = values[values.length - 1];
    // A nested map is a node's NodeState (`__state`, F4); read it at the same moment.
    out.push(JSON.stringify([key, value instanceof Y.Map ? `{${attrs(value, live)}}` : value instanceof Y.AbstractType ? '[type]' : value ?? null]));
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

function prev(item: Y.Item, walk: Walk): Y.Item | null {
  if (!item.left) return parentOf(item)._item;
  let at = item.left;
  for (let list = listOf(at); list?._start; list = listOf(at)) {
    at = list._start;
    while (at.right) {
      walk.tick();
      at = at.right;
    }
  }
  return at;
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

const sameTokens = (a: Tok[], b: Tok[]) => a.length === b.length && a.every((tok, i) => tok.t === b[i].t);
const textOf = (tokens: Tok[]) => tokens.map((tok) => (tok.t.length === 1 ? tok.t : BLOCK_CHAR)).join('');

function signature(tokens: Tok[]): string {
  const bytes = digest(encodeUtf8(tokens.map((tok) => `${tok.t.length}:${tok.t}`).join('')));
  return [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Where `part` starts in `hay`, every occurrence (KMP over token strings). */
function occurrences(hay: Tok[], part: string[]): number[] {
  const fail = new Array<number>(part.length).fill(0);
  for (let i = 1, k = 0; i < part.length; i += 1) {
    while (k > 0 && part[i] !== part[k]) k = fail[k - 1];
    if (part[i] === part[k]) k += 1;
    fail[i] = k;
  }
  const starts: number[] = [];
  for (let i = 0, k = 0; i < hay.length; i += 1) {
    while (k > 0 && hay[i].t !== part[k]) k = fail[k - 1];
    if (hay[i].t === part[k]) k += 1;
    if (k === part.length) {
      starts.push(i - part.length + 1);
      k = fail[k - 1];
    }
  }
  return starts;
}

/**
 * The wrap rule: where the comment's part D[i0, i0 + n) sits in I when the frame only removed tokens from the gap's
 * text. A reading of I as D with tokens removed may keep the part as the run I[j, j + n) when I's tokens before j fit
 * in order into D before i0 and those after it fit into D after the part. The answer is the one such j, and only if
 * no other occurrence of the part in D could be that same run in a reading. Otherwise null: never a guess.
 */
function wrapRun(deleted: Tok[], inserted: Tok[], i0: number, part: string[]): number | null {
  const n = part.length;
  // head[x]: the shortest prefix of D that holds I[0, x) in order. tail[y]: the latest start of a suffix of D that
  // holds I[y, |I|) in order.
  const head = new Array<number>(inserted.length + 1).fill(Number.POSITIVE_INFINITY);
  head[0] = 0;
  for (let i = 0, x = 0; i < deleted.length && x < inserted.length; i += 1) if (deleted[i].t === inserted[x].t) head[++x] = i + 1;
  const tail = new Array<number>(inserted.length + 1).fill(Number.NEGATIVE_INFINITY);
  tail[inserted.length] = deleted.length;
  for (let i = deleted.length - 1, y = inserted.length; i >= 0 && y > 0; i -= 1) if (deleted[i].t === inserted[y - 1].t) tail[--y] = i;
  const fits = (k: number, j: number) => head[j] <= k && tail[j + n] >= k + n;
  const runs = occurrences(inserted, part).filter((j) => fits(i0, j));
  if (runs.length !== 1) return null;
  const j = runs[0];
  return occurrences(deleted, part).filter((k) => fits(k, j)).length === 1 ? j : null;
}

/** Disjoint clock spans per client, each naming the comments indexed on it. */
class SpanIndex {
  readonly #byClient = new Map<number, { s: number; e: number; ids: Set<string> }[]>();

  #first(spans: { e: number }[], clock: number): number {
    let lo = 0;
    let hi = spans.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (spans[mid].e <= clock) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  add(client: number, s: number, length: number, id: string): void {
    const spans = this.#byClient.get(client) ?? [];
    this.#byClient.set(client, spans);
    const e = s + length;
    let i = this.#first(spans, s);
    for (let cur = s; cur < e; ) {
      const span = spans[i];
      if (!span || span.s >= e) {
        spans.splice(i, 0, { s: cur, e, ids: new Set([id]) });
        return;
      }
      if (span.s > cur) {
        spans.splice(i, 0, { s: cur, e: span.s, ids: new Set([id]) });
        i += 1;
        cur = span.s;
        continue;
      }
      if (span.s < cur) {
        spans.splice(i + 1, 0, { s: cur, e: span.e, ids: new Set(span.ids) });
        span.e = cur;
        i += 1;
        continue;
      }
      if (span.e > e) {
        spans.splice(i + 1, 0, { s: e, e: span.e, ids: new Set(span.ids) });
        span.e = e;
      }
      span.ids.add(id);
      cur = span.e;
      i += 1;
    }
  }

  remove(client: number, s: number, length: number, id: string): void {
    const spans = this.#byClient.get(client);
    if (!spans) return;
    for (let i = this.#first(spans, s); i < spans.length && spans[i].s < s + length; ) {
      spans[i].ids.delete(id);
      if (spans[i].ids.size === 0) spans.splice(i, 1);
      else i += 1;
    }
  }

  query(client: number, s: number, e: number, out: Set<string>): void {
    const spans = this.#byClient.get(client);
    if (!spans) return;
    for (let i = this.#first(spans, s); i < spans.length && spans[i].s < e; i += 1) for (const id of spans[i].ids) out.add(id);
  }
}

/** What one record put in the indexes, so it can be taken out exactly. */
interface Indexed {
  anchor: Anchor;
  ep: ItemId[];
  mi: [number, number, number][];
  ai: string[];
}

interface Match {
  tokens: Tok[];
  spans: Spans;
}

const detached = (anchor: Anchor, quote = anchor.quote): Anchor => ({
  kind: anchor.kind,
  start: anchor.start,
  end: anchor.end,
  status: 'orphaned',
  quote,
});

const anchoredOn = (anchor: Anchor, first: Unit, last: Unit): Anchor => ({
  kind: anchor.kind,
  start: encodePosition(first, 0),
  end: encodePosition(last, -1),
  status: 'anchored',
  quote: anchor.quote,
});

const depthOf = (inner: Inner | undefined): number => (inner ? 1 + depthOf(inner.inner) : 0);

/**
 * The server's anchor engine for one doc. EP (endpoint items), MI (lost member runs and re-homed bounds) and AI
 * (ancestor blocks of lost places) are in memory and rebuilt from the `a:` records with `load` (I8).
 */
export class AnchorEngine {
  stats: FrameStats = scratch();
  readonly #records = new Map<string, Indexed>();
  readonly #ep = new SpanIndex();
  readonly #mi = new SpanIndex();
  readonly #ai = new Map<string, Set<string>>();

  constructor(readonly doc: Y.Doc) {}

  load(records: Iterable<[string, Anchor]>): void {
    for (const [id, anchor] of records) this.set(id, anchor);
  }

  get(id: string): Anchor | undefined {
    return this.#records.get(id)?.anchor;
  }

  /** Re-indexes one record after it was written (or removes it). */
  set(id: string, anchor: Anchor | undefined): void {
    const old = this.#records.get(id);
    if (old) {
      for (const [client, clock] of old.ep) this.#ep.remove(client, clock, 1, id);
      for (const [client, clock, length] of old.mi) this.#mi.remove(client, clock, length, id);
      for (const key of old.ai) this.#ai.get(key)?.delete(id);
      this.#records.delete(id);
    }
    if (!anchor) return;
    const entry: Indexed = { anchor, ep: [], mi: [], ai: [] };
    if (anchor.status === 'anchored') {
      for (const value of [anchor.start, anchor.end]) {
        const id = positionOf(value);
        if (id) entry.ep.push([id.client, id.clock]);
      }
    } else if (anchor.lost) {
      entry.mi.push(...anchor.lost.members);
      for (const seg of anchor.lost.segs) {
        if ('right' in seg) for (const bound of [seg.left, seg.right]) if (bound) entry.mi.push([bound[0], bound[1], 1]);
        entry.ai.push(...this.#ancestors(seg.list));
      }
    }
    for (const [client, clock] of entry.ep) this.#ep.add(client, clock, 1, id);
    for (const [client, clock, length] of entry.mi) this.#mi.add(client, clock, length, id);
    for (const key of entry.ai) {
      const ids = this.#ai.get(key) ?? new Set<string>();
      ids.add(id);
      this.#ai.set(key, ids);
    }
    this.#records.set(id, entry);
  }

  #ancestors(list: Seg['list']): string[] {
    if (list === 'root') return [];
    const keys: string[] = [];
    for (let at = unitAt(this.doc, list)?.item ?? null; at && keys.length < 32; at = parentOf(at)._item) keys.push(keyOf(at.id));
    return keys;
  }

  /** The anchor records this transaction changes. Call from afterTransaction, before garbage collection. */
  frame(txn: Y.Transaction): Map<string, Anchor> {
    this.stats = scratch();
    const view = new View(txn);
    const out = new Map<string, Anchor>();
    const store = this.doc.store;

    // §5.2: only comments whose endpoint this transaction deletes.
    const hits = new Set<string>();
    for (const [client, ranges] of txn.deleteSet.clients) {
      for (const range of ranges) {
        this.stats.lookups += 1;
        this.#ep.query(client, range.clock, range.clock + range.len, hits);
      }
    }
    for (const id of hits) {
      const anchor = this.get(id);
      if (anchor?.status !== 'anchored') continue;
      const changed = this.#anchored(view, anchor);
      if (changed) out.set(id, changed);
    }

    // §5.5: orphans whose place sits inside a block this transaction deletes.
    const outers = new Map<Y.Item, Outer | null>();
    for (const [client, ranges] of txn.deleteSet.clients) {
      const structs = store.clients.get(client);
      if (!structs) continue;
      for (const range of ranges) {
        for (let i = Y.findIndexSS(structs, range.clock); i < structs.length && structs[i].id.clock < range.clock + range.len; i += 1) {
          const struct = structs[i];
          if (!(struct instanceof Y.Item) || !listOf(struct)) continue;
          this.stats.lookups += 1;
          for (const id of this.#ai.get(keyOf(struct.id)) ?? []) {
            const anchor = out.get(id) ?? this.get(id);
            if (anchor?.status !== 'orphaned' || !anchor.lost || out.has(id)) continue;
            const lifted = this.#lift(view, anchor, outers);
            if (lifted) out.set(id, lifted);
          }
        }
      }
    }

    // §5.4: a frame-new item whose origin or right origin names a lost member or a re-homed bound.
    const candidates = new Set<string>();
    for (const [client, after] of txn.afterState) {
      const before = txn.beforeState.get(client) ?? 0;
      const structs = store.clients.get(client);
      if (after <= before || !structs) continue;
      for (let i = Y.findIndexSS(structs, before); i < structs.length && structs[i].id.clock < after; i += 1) {
        const struct = structs[i];
        if (!(struct instanceof Y.Item)) continue;
        for (const ref of [struct.origin, struct.rightOrigin]) {
          if (!ref) continue;
          this.stats.lookups += 1;
          this.#mi.query(ref.client, ref.clock, ref.clock + 1, candidates);
        }
      }
    }
    for (const id of candidates) {
      if (out.has(id)) continue;
      const anchor = this.get(id);
      if (anchor?.status !== 'orphaned' || !anchor.lost) continue;
      const changed = this.#reattach(anchor, anchor.lost);
      if (changed) out.set(id, changed);
    }
    return out;
  }

  #anchored(view: View, anchor: Anchor): Anchor | null {
    this.stats.comments += 1;
    const s = unitAt(this.doc, positionOf(anchor.start));
    const e = unitAt(this.doc, positionOf(anchor.end));
    if (!s || !e) return detached(anchor);
    if (!s.item.deleted && !e.item.deleted) return null;
    let quote = anchor.quote;
    try {
      const entries = rangeEntries(s, e, new Walk(RANGE_BUDGET, this.stats));
      const pre = entryTokens(entries, false, view.pre);
      quote = textOf(pre);
      const mapped = this.#gapMap(view, s, e, pre);
      if (mapped) return anchoredOn(anchor, ...mapped);
      const shrunk = shrink(view, entries, s, e);
      if (shrunk) return anchoredOn(anchor, ...shrunk);
      return this.#lose(view, anchor, s, e, entries, quote);
    } catch (error) {
      if (error instanceof OverBudget) return detached(anchor, quote);
      throw error;
    }
  }

  /** I4: each deleted endpoint maps onto text this frame inserted between the same two survivors. */
  #gapMap(view: View, s: Unit, e: Unit, pre: Tok[]): [Unit, Unit] | null {
    let first = s;
    let last = e;
    let endDone = !e.item.deleted;
    if (s.item.deleted) {
      const items = this.#gap(view, s);
      const both = !endDone && items.includes(e.item);
      const mapped = mapIn(view, items, s, both ? e : null);
      if (!mapped) return null;
      first = mapped[0]!;
      if (both) {
        last = mapped[1]!;
        endDone = true;
      }
    }
    if (!endDone) {
      const mapped = mapIn(view, this.#gap(view, e), null, e);
      if (!mapped) return null;
      last = mapped[1]!;
    }
    const post = entryTokens(rangeEntries(first, last, new Walk(RANGE_BUDGET, this.stats)), false, isLive);
    return sameTokens(post, pre) ? [first, last] : null;
  }

  /** The items between the nearest survivors on either side of a deleted unit, in flattened order. */
  #gap(view: View, unit: Unit): Y.Item[] {
    const left: Y.Item[] = [];
    const leftWalk = new Walk(WALK_BUDGET, this.stats);
    for (let at = prev(unit.item, leftWalk); at && !view.survivor(at); at = prev(at, leftWalk)) {
      leftWalk.tick();
      left.push(at);
    }
    const right: Y.Item[] = [];
    const rightWalk = new Walk(WALK_BUDGET, this.stats);
    for (let at = next(unit.item); at && !view.survivor(at); at = next(at)) {
      rightWalk.tick();
      right.push(at);
    }
    return [...left.reverse(), unit.item, ...right];
  }

  /** §5.3: orphan with the place the text was lost from, or reattach at once if the frame already restored it. */
  #lose(view: View, anchor: Anchor, s: Unit, e: Unit, entries: Entry[], quote: string): Anchor {
    const tops: Y.Item[] = [];
    const seen = new Set<Y.Item>();
    for (const { item } of entries) {
      if (!view.pre(item) || !view.deletedNow(item)) continue;
      let top = item;
      for (let up = parentOf(top)._item; up && view.deletedNow(up); up = parentOf(up)._item) top = up;
      if (seen.has(top)) continue;
      seen.add(top);
      tops.push(top);
    }
    if (tops.length === 0 || tops.length > MAX_MEMBER_RUNS) return detached(anchor, quote);
    const segs: Seg[] = [];
    const byList = new Map<Y.AbstractType<unknown>, Seg>();
    for (const top of tops) {
      const list = parentOf(top);
      const seg = byList.get(list);
      if (seg) {
        seg.last = idOf(top.lastId);
        continue;
      }
      const fresh: Seg = { list: list._item ? idOf(list._item.id) : 'root', left: top.left ? idOf(top.left.lastId) : null, last: idOf(top.lastId) };
      byList.set(list, fresh);
      segs.push(fresh);
    }
    const tokens: Tok[] = [];
    const walk = new Walk(RANGE_BUDGET, this.stats);
    for (const top of tops) emitSubtree(top, true, view.pre, tokens, walk);
    const a = tokens.findIndex((tok) => tok.item === s.item && tok.off === s.off);
    const b = tokens.findIndex((tok) => tok.item === e.item && tok.off === e.off) + 1;
    if (a < 0 || b <= a) return detached(anchor, quote);
    const lost: LostPlace = {
      v: 1,
      segs,
      members: tops.map((top) => [top.id.client, top.id.clock, top.length]),
      pre: { h: signature(tokens), n: tokens.length, a, b },
    };
    const orphan: Anchor = { ...detached(anchor, quote), lost };
    return this.#reattach(orphan, lost) ?? orphan;
  }

  /** I5: live items inside the lost place read exactly as the lost passage did; a lifted place re-homes first. */
  #reattach(anchor: Anchor, lost: LostPlace): Anchor | null {
    this.stats.comments += 1;
    let place = lost;
    for (let depth = 0; depth <= MAX_LIFT_DEPTH; depth += 1) {
      const match = this.#check(place);
      if (!match) return place === lost ? null : { ...detached(anchor), lost: place };
      if (!place.inner) return anchoredOn(anchor, match.tokens[place.pre.a], match.tokens[place.pre.b - 1]);
      const home = rehome(place.inner, match);
      if (!home) return detached(anchor);
      place = home;
    }
    return detached(anchor);
  }

  #check(place: LostPlace): Match | null {
    const walk = new Walk(WALK_BUDGET + 4 * place.pre.n, this.stats);
    const tokens: Tok[] = [];
    const spans: Spans = new Map();
    try {
      for (const seg of place.segs) if (!this.#walkSeg(seg, tokens, spans, walk, place.pre.n)) return null;
    } catch (error) {
      if (error instanceof OverBudget) return null;
      throw error;
    }
    return tokens.length === place.pre.n && signature(tokens) === place.pre.h ? { tokens, spans } : null;
  }

  /** The live items of one segment and their full subtrees, in full mode. False when the segment is gone. */
  #walkSeg(seg: Seg, out: Tok[], spans: Spans, walk: Walk, n: number): boolean {
    const list = seg.list === 'root' ? this.doc.get('root', Y.XmlText) : liveList(unitAt(this.doc, seg.list)?.item);
    if (!list) return false;
    let at: Y.Item | null = list._start;
    let from = 0;
    if (seg.left) {
      const left = unitAt(this.doc, seg.left);
      if (!left || parentOf(left.item) !== list) return false;
      at = left.item;
      from = left.off + 1;
      if (from >= at.length) {
        at = at.right;
        from = 0;
      }
    }
    for (; at; at = at.right, from = 0) {
      walk.tick();
      let to = at.length - 1;
      if (seg.right && contains(at, seg.right)) {
        to = seg.right[1] - at.id.clock - 1;
        if (to >= from && !at.deleted) own(at, from, to, true, isLive, out);
        return true;
      }
      const ends = seg.last !== undefined && contains(at, seg.last);
      if (ends) to = seg.last![1] - at.id.clock;
      if (!at.deleted) {
        const start = out.length;
        own(at, from, to, true, isLive, out);
        const children = listOf(at);
        if (children) for (let child = children._start; child; child = child.right) emitSubtree(child, true, isLive, out, walk, spans);
        spans.set(at, [start, out.length]);
        if (out.length > n) return false;
      }
      if (ends) return true;
    }
    return seg.last === undefined;
  }

  /** §5.5: the place moves out to the outermost deleted block, keeping the old place's signature as `inner`. */
  #lift(view: View, anchor: Anchor, outers: Map<Y.Item, Outer | null>): Anchor | null {
    const lost = anchor.lost!;
    if (lost.segs.length !== 1 || depthOf(lost.inner) >= MAX_LIFT_DEPTH) return detached(anchor);
    const seg = lost.segs[0];
    const listItem = seg.list === 'root' ? null : unitAt(this.doc, seg.list)?.item;
    if (!listItem || !listOf(listItem)) return detached(anchor);
    let top: Y.Item | null = null;
    for (let up: Y.Item | null = listItem; up; up = parentOf(up)._item) if (view.deletedNow(up)) top = up;
    if (!top) return null;
    let outer = outers.get(top);
    if (outer === undefined) {
      outer = this.#outer(view, top);
      outers.set(top, outer);
    }
    const open = outer?.spans.get(listItem);
    if (!outer || !open || open[1] === open[0]) return detached(anchor);
    let at = open[0] + 1;
    if (seg.left) {
      const left = unitAt(this.doc, seg.left);
      const span = left && outer.spans.get(left.item);
      if (!left || !span || parentOf(left.item)._item !== listItem) return detached(anchor);
      const string = left.item.content instanceof Y.ContentString && span[1] > span[0];
      at = string ? span[0] + left.off + 1 : span[1];
    }
    const lifted: LostPlace = {
      v: 1,
      segs: [outer.seg],
      members: [[top.id.client, top.id.clock, top.length]],
      pre: { ...outer.sig, a: at, b: at },
      inner: { at, list: open[0], pre: lost.pre, ...(lost.inner ? { inner: lost.inner } : {}) },
    };
    const orphan: Anchor = { ...detached(anchor), lost: lifted };
    return this.#reattach(orphan, lifted) ?? orphan;
  }

  #outer(view: View, top: Y.Item): Outer | null {
    const tokens: Tok[] = [];
    const spans: Spans = new Map();
    try {
      emitSubtree(top, true, view.pre, tokens, new Walk(RANGE_BUDGET, this.stats), spans);
    } catch (error) {
      if (error instanceof OverBudget) return null;
      throw error;
    }
    const list = parentOf(top);
    return {
      seg: { list: list._item ? idOf(list._item.id) : 'root', left: top.left ? idOf(top.left.lastId) : null, last: idOf(top.lastId) },
      sig: { h: signature(tokens), n: tokens.length, a: 0, b: 0 },
      spans,
    };
  }
}

interface Outer {
  seg: Seg;
  sig: Sig;
  spans: Spans;
}

const liveList = (item: Y.Item | null | undefined): Y.XmlText | null => (item && !item.deleted ? listOf(item) : null);

/** The inner place inside the restored copy: between the live items around its token offset in the same list. */
function rehome(inner: Inner, match: Match): LostPlace | null {
  const listItem = match.tokens[inner.list]?.item;
  const list = liveList(listItem);
  if (!listItem || !list) return null;
  let left: ItemId | null = null;
  let right: ItemId | null = null;
  for (let child = list._start; child; child = child.right) {
    const span = match.spans.get(child);
    if (child.deleted || !span) continue;
    if (span[1] <= inner.at) {
      left = idOf(child.lastId);
    } else if (span[0] >= inner.at) {
      right = idOf(child.id);
      break;
    } else if (child.content instanceof Y.ContentString) {
      left = [child.id.client, child.id.clock + inner.at - span[0] - 1];
      right = [child.id.client, child.id.clock + inner.at - span[0]];
      break;
    } else {
      return null;
    }
  }
  return { v: 1, segs: [{ list: idOf(listItem.id), left, right }], members: [], pre: inner.pre, ...(inner.inner ? { inner: inner.inner } : {}) };
}

/** I4's candidate maps for one gap: D == I by offset, else a unique part in the common prefix or suffix, else a wrap run. */
function mapIn(view: View, items: Y.Item[], s: Unit | null, e: Unit | null): [Unit | null, Unit | null] | null {
  const deleted: Tok[] = [];
  const inserted: Tok[] = [];
  for (const item of items) {
    if (view.pre(item) && item.deleted) own(item, 0, item.length - 1, false, view.pre, deleted);
    else if (view.isNew(item) && !item.deleted) own(item, 0, item.length - 1, false, isLive, inserted);
    if (deleted.length + inserted.length > TOKEN_BUDGET) throw new OverBudget();
  }
  const index = (unit: Unit) => deleted.findIndex((tok) => tok.item === unit.item && tok.off === unit.off);
  const i0 = s ? index(s) : 0;
  const i1 = e ? index(e) : deleted.length - 1;
  if (i0 < 0 || i1 < i0) return null;
  let map: ((i: number) => number) | null = null;
  if (sameTokens(deleted, inserted)) {
    map = (i) => i;
  } else {
    const part = deleted.slice(i0, i1 + 1).map((tok) => tok.t);
    const unique = occurrences(deleted, part).length === 1 && occurrences(inserted, part).length === 1;
    const most = Math.min(deleted.length, inserted.length);
    let p = 0;
    while (p < most && deleted[p].t === inserted[p].t) p += 1;
    let q = 0;
    while (q < most - p && deleted[deleted.length - 1 - q].t === inserted[inserted.length - 1 - q].t) q += 1;
    if (unique && i1 < p) map = (i) => i;
    else if (unique && i0 >= deleted.length - q) map = (i) => i - deleted.length + inserted.length;
    else {
      // A wrap: a markdown shortcut deletes the text with its delimiters and reinserts it, so I is D minus tokens.
      const j = wrapRun(deleted, inserted, i0, part);
      if (j === null) return null;
      map = (i) => i - i0 + j;
    }
  }
  const at = (i: number): Unit | null => {
    const tok = inserted[map!(i)];
    return tok ? { item: tok.item, off: tok.off } : null;
  };
  const first = s ? at(i0) : null;
  const last = e ? at(i1) : null;
  if ((s && !first) || (e && !last)) return null;
  return [first, last];
}

/** I3b: a deleted endpoint moves inward to the nearest surviving unit of the comment's own pre-frame range. */
function shrink(view: View, entries: Entry[], s: Unit, e: Unit): [Unit, Unit] | null {
  let first: Unit | null = s.item.deleted ? null : s;
  let last: Unit | null = e.item.deleted ? null : e;
  if (!first) {
    const hit = entries.find(({ item }) => view.survivor(item) && isUnit(item));
    if (hit) first = { item: hit.item, off: hit.from };
  }
  if (!last) {
    for (let i = entries.length - 1; i >= 0 && !last; i -= 1) {
      const { item, to } = entries[i];
      if (view.survivor(item) && isUnit(item)) last = { item, off: to };
    }
  }
  return first && last ? [first, last] : null;
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

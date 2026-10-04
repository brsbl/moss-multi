// SP11 (T5.0, docs/design/suggestions.md §4): vets a suggest-mode frame on what Yjs actually applied, by one
// invariant. The frame is applied to a mirror (the server) or judged in afterTransaction (the client self-check), and
// the vetter compares the ORIGINAL PROJECTION of every type the transaction touched before and after it: every
// character with its effective format, every embed and every map value that is not the author's pending insert. The
// only differences allowed are the author's new items where suggesting is allowed, deletions of the author's own
// pending items, and text a split moved, re-proven as copies with the same character and format in document order.
// Anything else refuses the whole frame, whatever struct shape produced it.
import * as Y from 'yjs';

/** A run of one client's consecutive clocks: an id set, by Yjs identity. */
export interface IdSpan {
  client: number;
  clock: number;
  len: number;
}

export type VetReason = 'delete-original' | 'mutate-original' | 'outside-body' | 'unresolvable' | 'foreign-client' | 'too-large';
/** `inserts` are the author's new content; `moved` are copies of original text a split moved, still original. */
export type Verdict = { ok: true; inserts: IdSpan[]; moved: IdSpan[] } | { ok: false; reason: VetReason };

export interface VetOptions {
  /** The author's insert ids (ownSpans). */
  own: readonly IdSpan[];
  /** Original text the author's splits moved: never theirs, even inside their own blocks. */
  moved?: readonly IdSpan[];
  /** Yjs client ids this connection already wrote under; a fresh client id (no state yet) is claimed by the frame. */
  clients: ReadonlySet<number>;
  /** Per-frame cost caps (VET_LIMITS by default). */
  limits?: VetLimits;
}

/** A frame integrating or deleting more structs, or touching more types, than this is refused before it is judged. */
export interface VetLimits {
  structs: number;
  types: number;
}
export const VET_LIMITS: VetLimits = { structs: 20_000, types: 2_000 };

const BODY = 'root';
const REGISTERS = 'registers';
const VET_ORIGIN = Symbol('suggest-vet');

class Refusal extends Error {
  constructor(readonly reason: VetReason) {
    super(reason);
  }
}

type Type = Y.AbstractType<unknown>;

/**
 * The DocDO's mirror of the live doc. It follows every update the live doc applies. A suggest-mode frame is applied
 * here first and judged in the mirror's afterTransaction, before Yjs collects anything. On a pass the DO applies the
 * same frame to the live doc (which the mirror then sees as a no-op); on a refusal the mirror is dropped and rebuilt
 * from the live doc for the next frame, so it never keeps what the live doc refused.
 */
export class SuggestMirror {
  readonly #live: Y.Doc;
  #doc: Y.Doc | null = null;
  readonly #follow = (update: Uint8Array) => {
    if (this.#doc) Y.applyUpdate(this.#doc, update);
  };

  constructor(live: Y.Doc) {
    this.#live = live;
    live.on('update', this.#follow);
  }

  /** The mirror, rebuilt from the live doc after a refusal dropped it. */
  get doc(): Y.Doc {
    if (!this.#doc) {
      const doc = new Y.Doc({ gc: this.#live.gc });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.#live));
      this.#doc = doc;
    }
    return this.#doc;
  }

  /** Applies `update` to the mirror and runs `inspect` on its transaction, in afterTransaction. */
  apply<T>(update: Uint8Array, inspect: (transaction: Y.Transaction) => T): T | null {
    const doc = this.doc;
    const seen: { result: T | null } = { result: null };
    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === VET_ORIGIN && seen.result === null) seen.result = inspect(transaction);
    };
    doc.on('afterTransaction', onTransaction);
    try {
      Y.applyUpdate(doc, update, VET_ORIGIN);
    } finally {
      doc.off('afterTransaction', onTransaction);
    }
    return seen.result;
  }

  vet(update: Uint8Array, options: VetOptions): Verdict {
    let verdict: Verdict;
    try {
      verdict = this.apply(update, (transaction) => judge(transaction, options)) ?? { ok: true, inserts: [], moved: [] };
    } catch {
      verdict = { ok: false, reason: 'unresolvable' };
    }
    // Nothing parks: a struct or delete Yjs could not integrate now would land later, unvetted.
    const store = this.doc.store;
    if (verdict.ok && (store.pendingStructs !== null || store.pendingDs !== null)) verdict = { ok: false, reason: 'unresolvable' };
    if (!verdict.ok) this.reset();
    return verdict;
  }

  /** Drops the mirror; the next frame rebuilds it from the live doc. */
  reset(): void {
    this.#doc?.destroy();
    this.#doc = null;
  }

  destroy(): void {
    this.#live.off('update', this.#follow);
    this.reset();
  }
}

/** One frame against a throwaway mirror of `doc` (tests and one-off callers; the DO keeps a SuggestMirror). */
export function vetSuggestFrame(doc: Y.Doc, update: Uint8Array, options: VetOptions): Verdict {
  const mirror = new SuggestMirror(doc);
  try {
    return mirror.vet(update, options);
  } finally {
    mirror.destroy();
  }
}

/** The client self-check: the same judgement on a local transaction, from afterTransaction. */
export function vetTransaction(transaction: Y.Transaction, options: VetOptions): Verdict {
  return judge(transaction, options);
}

function judge(transaction: Y.Transaction, options: VetOptions): Verdict {
  try {
    return { ok: true, ...vet(transaction, options) };
  } catch (error) {
    // Fail closed: a frame the vetter cannot judge is refused.
    return { ok: false, reason: error instanceof Refusal ? error.reason : 'unresolvable' };
  }
}

/**
 * What a transaction did, read in afterTransaction: its structs are integrated and its deletes marked, and nothing is
 * collected yet. An item existed before when its clock is below `beforeState`, and was live before when it is not
 * deleted now or this transaction deleted it. `deleted` holds every existing item the transaction deleted, the content
 * Yjs deletes with a deleted container included.
 */
function frameOf(transaction: Y.Transaction, limits: VetLimits) {
  const store = transaction.doc.store;
  const before = (client: number) => transaction.beforeState.get(client) ?? 0;
  const isFresh = (item: Y.Item) => item.id.clock >= before(item.id.client);
  const liveBefore = (item: Y.Item) => !isFresh(item) && (!item.deleted || Y.isDeleted(transaction.deleteSet, item.id));
  let structs = 0;
  const count = () => {
    if (++structs > limits.structs) throw new Refusal('too-large');
  };
  const fresh: Y.Item[] = [];
  for (const [client, after] of transaction.afterState) {
    const from = before(client);
    if (after <= from) continue;
    const list = store.clients.get(client) ?? [];
    for (let i = Y.findIndexSS(list, from); i < list.length; i++) {
      count();
      const struct = list[i];
      if (struct instanceof Y.Item) fresh.push(struct);
    }
  }
  const deleted: Y.Item[] = [];
  Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
    count();
    if (struct instanceof Y.Item && !isFresh(struct)) deleted.push(struct);
  });
  const changed = transaction.changed as unknown as Map<Type, Set<string | null>>;
  const touched = new Set<Type>(changed.keys());
  for (const item of deleted) touched.add(item.parent as Type);
  if (touched.size > limits.types) throw new Refusal('too-large');
  return { isFresh, liveBefore, fresh, deleted, touched, changed };
}

function vet(transaction: Y.Transaction, options: VetOptions): { inserts: IdSpan[]; moved: IdSpan[] } {
  // A client id the doc already held must be one this connection wrote under, or the frame could take a peer's next
  // clocks (Yjs would then drop the peer's real edits at those clocks as duplicates). A new client id is claimed.
  for (const [client, after] of transaction.afterState) {
    const from = transaction.beforeState.get(client) ?? 0;
    if (after > from && from > 0 && !options.clients.has(client)) throw new Refusal('foreign-client');
  }
  const { isFresh, liveBefore, fresh, deleted, touched, changed } = frameOf(transaction, options.limits ?? VET_LIMITS);

  /** Fresh items that stay original: copies of moved text and the maps governing them (`copies`), same-value rewrites. */
  const copies = new Set<string>();
  const kept = new Set<string>();
  const movedBefore = options.moved ?? [];
  const isOwnClock = (item: Y.Item, clock: number): boolean => {
    const client = item.id.client;
    if (coveredBy(movedBefore, client, clock, clock + 1) || copies.has(`${client}:${clock}`)) return false;
    return isFresh(item) || coveredBy(options.own, client, clock, clock + 1);
  };
  const isOwn = (item: Y.Item) => isOwnClock(item, item.id.clock);

  const rootCache = new Map<Type, string>();
  const rootOf = (type: Type): string => {
    let at = type;
    for (let depth = 0; at._item; depth++) {
      if (depth > 10_000) throw new Refusal('unresolvable');
      at = at._item.parent as Type;
    }
    let key = rootCache.get(at);
    if (key === undefined) rootCache.set(at, (key = Y.findRootTypeKey(at)));
    return key;
  };
  const parentOf = (item: Y.Item): Type => {
    if (!(item.parent instanceof Y.AbstractType)) throw new Refusal('unresolvable');
    return item.parent as Type;
  };

  // Where new items may go. Body sequences take inserts anywhere; their effect on original content is judged below.
  // Registers take a new key (a new decorator's payload) and edits inside the author's own registers.
  for (const item of fresh) {
    const { content } = item;
    if (content instanceof Y.ContentFormat) throw new Refusal('mutate-original'); // V1 never writes formatting marks
    if (content instanceof Y.ContentDoc) throw new Refusal('outside-body');
    const parent = parentOf(item);
    const root = rootOf(parent);
    if (root === BODY) continue;
    if (root !== REGISTERS) throw new Refusal('outside-body');
    if (!parent._item) {
      if (item.parentSub === null) throw new Refusal('mutate-original');
      continue; // a registers key: judged with every map value below
    }
    if (!isOwn(parent._item)) throw new Refusal('mutate-original');
  }
  for (const item of deleted) {
    const parent = parentOf(item);
    const root = rootOf(parent);
    if (root === BODY) continue;
    if (root !== REGISTERS) throw new Refusal('outside-body');
    if (parent._item && !isOwn(item)) throw new Refusal('mutate-original');
  }
  for (const type of touched) {
    // Yjs rewrites a remote frame's formatting marks after the transaction, unjudged.
    if ((type as unknown as { _hasFormatting?: boolean })._hasFormatting) throw new Refusal('mutate-original');
  }

  // Map values, on every touched container that existed before and is still there. A value another author wrote must
  // read the same after the whole frame: the live value once Yjs has ordered the frame's items and applied its full
  // delete set. A same-value rewrite of it stays theirs. Any other change is allowed only on the author's own container
  // and only when it changes no one else's content: a block's attributes are part of the format of everything inside
  // it (checked after the alignment), and a text map's are the format of the characters it governs (the alignment).
  const deletedKeys = new Map<Type, Set<string>>();
  for (const item of deleted) {
    if (item.parentSub === null) continue;
    const parent = item.parent as Type;
    deletedKeys.set(parent, (deletedKeys.get(parent) ?? new Set<string>()).add(item.parentSub));
  }
  const ownBlocksChanged: Type[] = [];
  for (const type of touched) {
    const holder = type._item;
    if (holder && (isFresh(holder) || holder.deleted)) continue; // new, or gone with its container: judged in its parent
    const keys = new Set<string>(deletedKeys.get(type));
    for (const key of changed.get(type) ?? []) if (key !== null) keys.add(key);
    for (const key of keys) {
      let previous: Y.Item | null = type._map.get(key) ?? null;
      while (previous && !liveBefore(previous)) previous = previous.left;
      const last = type._map.get(key);
      const current = last && !last.deleted ? last : null;
      if (valueOf(previous) === valueOf(current)) {
        if (current && previous && current !== previous && !isOwn(previous)) kept.add(keyOf(current.id));
        continue;
      }
      if (previous && !isOwn(previous)) throw new Refusal('mutate-original');
      if (!holder) {
        if (rootOf(type) === REGISTERS && (current === null || isFresh(current))) continue;
        throw new Refusal('mutate-original');
      }
      if (!isOwn(holder)) throw new Refusal('mutate-original');
      if (!(type instanceof Y.Map)) ownBlocksChanged.push(type);
    }
  }

  // The body in document order, over the top-level blocks the frame touched. Before: every original unit (a character
  // with the values of the text map governing it, or an embed) live before. After: the original units live after and
  // every fresh unit. Each original must still be there, in order, with the same format; an original character may be
  // deleted only as half of a split (Enter mid-paragraph, a soft break, a run formatted mid-word, or undoing one), by
  // matching a fresh copy with the same character and format at its place in document order, and the copy stays
  // original.
  const body = transaction.doc.share.get(BODY) as Type | undefined;
  if (body) {
    const window = topLevel(body, [...fresh, ...deleted, ...[...touched].map((type) => type._item)]);
    if (window.size > 0) {
      const ownUnit = (unit: Unit) => !unit.fresh && isOwnClock(unit.item, unit.clock);
      const { pre, post } = units(body, window, liveBefore, isFresh);
      align(pre.filter((unit) => !ownUnit(unit)), post.filter((unit) => unit.fresh || !ownUnit(unit)), {
        wanted: () => true,
        same: (o, p) => p.char === o.char && p.fmt === o.fmt,
        kept: (o, p) => {
          if (p.fmt !== o.fmt) throw new Refusal('mutate-original');
        },
        matched: (_o, p) => {
          copies.add(keyOf(p));
          if (p.gov && isFresh(p.gov)) copies.add(keyOf(p.gov.id));
        },
        missing: () => {
          throw new Refusal('delete-original');
        },
      });
    }
  }

  // An own block whose attributes changed must hold nothing that is not the author's after the frame.
  const walk = (parent: Type): void => {
    for (let item = parent._start; item; item = item.right) {
      if (item.deleted) continue;
      for (let i = 0; i < item.length; i++) if (!isOwnClock(item, item.id.clock + i)) throw new Refusal('mutate-original');
      if (item.content instanceof Y.ContentType) walk(item.content.type as Type);
    }
  };
  for (const type of ownBlocksChanged) walk(type);

  const inserts: IdSpan[] = [];
  for (const item of fresh) {
    if (item.deleted || kept.has(keyOf(item.id))) continue;
    for (let i = 0; i < item.length; i++) {
      const clock = item.id.clock + i;
      if (!copies.has(`${item.id.client}:${clock}`)) register(inserts, item.id.client, clock);
    }
  }
  return { inserts, moved: spansOf(copies) };
}

/** A map entry's value as comparable text: a type-valued entry by its item's identity, an absent one as null. */
function valueOf(item: Y.Item | null): string | null {
  if (!item || item.content instanceof Y.ContentDeleted) return null;
  if (item.content instanceof Y.ContentType) return `type ${keyOf(item.id)}`;
  const values = item.content.getContent();
  return JSON.stringify(values[values.length - 1]);
}

/** The top-level blocks holding `items` (null entries and items outside the body are ignored). */
function topLevel(body: Type, items: Iterable<Y.Item | null>): Set<Y.Item> {
  const out = new Set<Y.Item>();
  for (const item of items) {
    let at: Y.Item | null = item;
    for (let depth = 0; at && at.parent !== body; depth++) at = depth > 10_000 ? null : ((at.parent as Type)._item ?? null);
    if (at) out.add(at);
  }
  return out;
}

/** The units of the `window` blocks, in document order, before and after the transaction. */
function units(body: Type, window: ReadonlySet<Y.Item>, liveBefore: (item: Y.Item) => boolean, isFresh: (item: Y.Item) => boolean) {
  const pre: Unit[] = [];
  const post: Unit[] = [];
  const liveAfter = (item: Y.Item) => !item.deleted;
  for (let top = body._start; top; top = top.right) {
    if (!window.has(top)) continue;
    if (liveBefore(top)) flatten([top], liveBefore, isFresh, pre);
    if (liveAfter(top)) flatten([top], liveAfter, isFresh, post);
  }
  return { pre, post };
}

/**
 * Identity carry: a frame from any writer (an editor's Enter or bold, another suggester's split, a review, an undo)
 * that deletes characters of `spans` and re-inserts copies gives those copies new ids. The DocDO runs this on the
 * mirror for each frame that deletes a tracked id, and writes the result into the record in the transaction that
 * applies the frame, so a suggestion's text keeps its paint, its reject target and its clean-export exclusion.
 */
export function carryIdentity(doc: Y.Doc, update: Uint8Array, spans: readonly IdSpan[]): IdSpan[] {
  const mirror = new SuggestMirror(doc);
  try {
    return mirror.apply(update, (transaction) => carryTransaction(transaction, spans)) ?? spans.map((span) => ({ ...span }));
  } finally {
    mirror.destroy();
  }
}

/** The carry on an applied transaction, from afterTransaction. */
export function carryTransaction(transaction: Y.Transaction, spans: readonly IdSpan[]): IdSpan[] {
  const out = spans.map((span) => ({ ...span }));
  const { isFresh, liveBefore, fresh, deleted } = frameOf(transaction, { structs: Infinity, types: Infinity });
  const tracked = (client: number, clock: number) => coveredBy(spans, client, clock, clock + 1);
  const hit = deleted.some((item) => {
    if (!(item.content instanceof Y.ContentString)) return false;
    for (let i = 0; i < item.length; i++) if (tracked(item.id.client, item.id.clock + i)) return true;
    return false;
  });
  const body = transaction.doc.share.get(BODY) as Type | undefined;
  if (!hit || !body) return out;
  const { pre, post } = units(body, topLevel(body, [...fresh, ...deleted]), liveBefore, isFresh);
  // Characters only: an editor's bold re-inserts the run with new text properties, and it is still the same text.
  const added = new Set<string>();
  align(pre, post, {
    wanted: (o) => o.char !== null && tracked(o.client, o.clock),
    same: (o, p) => p.char === o.char,
    kept: () => {},
    matched: (_o, p) => {
      added.add(keyOf(p));
      if (p.gov && isFresh(p.gov)) added.add(keyOf(p.gov.id));
    },
    missing: () => {},
  });
  for (const span of spansOf(added)) out.push(span);
  return out;
}

/**
 * What reject or withdraw removes (owner ruling, docs/design/suggestions.md D2b): only the author's own items. An own
 * container (a block, list item or table row) goes only when nothing live inside it is someone else's; otherwise it
 * stays as an ordinary block and only the author's items inside it go. An own text map that governs someone else's
 * characters stays too, so their format does not change. T5.3 applies this with Lexical's own operations.
 */
export function rejectPlan(doc: Y.Doc, inserts: readonly IdSpan[]): IdSpan[] {
  const remove = new Set<string>();
  const own = (id: { client: number; clock: number }) => coveredBy(inserts, id.client, id.clock, id.clock + 1);
  /** Marks the author's items under `type`; returns whether anything live there is someone else's. */
  const visit = (type: Type): boolean => {
    let foreign = false;
    const gov: { map: Y.Item | null; foreign: boolean } = { map: null, foreign: false };
    const closeMap = () => {
      if (gov.map && own(gov.map.id) && !gov.foreign) remove.add(keyOf(gov.map.id));
      gov.map = null;
      gov.foreign = false;
    };
    for (let item = type._start; item; item = item.right) {
      if (item.deleted) continue;
      const { content, id } = item;
      if (content instanceof Y.ContentString) {
        for (let i = 0; i < item.length; i++) {
          const clock = { client: id.client, clock: id.clock + i };
          if (own(clock)) remove.add(keyOf(clock));
          else foreign = gov.foreign = true;
        }
        continue;
      }
      closeMap();
      if (content instanceof Y.ContentType && isTextMapType(content.type, () => true)) {
        gov.map = item;
        continue;
      }
      const inner = content instanceof Y.ContentType ? visit(content.type as Type) : false;
      if (!own(id)) foreign = true;
      else if (!inner) remove.add(keyOf(id));
      if (inner) foreign = true;
    }
    closeMap();
    return foreign;
  };
  const body = rootType(doc, BODY);
  if (body) visit(body);
  for (const item of rootType(doc, REGISTERS)?._map.values() ?? []) {
    if (!item.deleted && own(item.id)) remove.add(keyOf(item.id));
  }
  return spansOf(remove);
}

const rootType = (doc: Y.Doc, name: string) => doc.share.get(name) as Type | undefined;

/**
 * Seconds an accepted record's ids stay the author's after the accept while the author's client has not yet
 * acknowledged seeing it: a frame typed before the client saw the accept is concurrent with it, not a violation.
 */
export const SEEN_GRACE_SECONDS = 30;

/** The ownership fields of a suggestion record (docs/design/suggestions.md §2). */
export interface OwnedRecord {
  author: string;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
  /** The DocDO's review counter when the record left `open`. */
  resolvedRev?: number;
  resolvedAt?: number;
  inserts: IdSpan[];
  moved: IdSpan[];
}

/**
 * The author's own ids as their client last saw them: open records, plus records accepted after the review counter
 * the connection last acknowledged (`seenRev`), within the grace window.
 */
export function ownSpans(records: readonly OwnedRecord[], author: string, basis: { seenRev: number; now: number }): { own: IdSpan[]; moved: IdSpan[] } {
  const own: IdSpan[] = [];
  const moved: IdSpan[] = [];
  for (const record of records) {
    if (record.author !== author) continue;
    const unseen = record.status === 'accepted' && (record.resolvedRev ?? 0) > basis.seenRev && basis.now - (record.resolvedAt ?? 0) <= SEEN_GRACE_SECONDS;
    if (record.status === 'open' || unseen) own.push(...record.inserts);
    if (record.status === 'open') moved.push(...record.moved);
  }
  return { own, moved };
}

/** One clock of the body in document order: a character, or an embed (a block, line break, decorator). */
interface Unit {
  client: number;
  clock: number;
  item: Y.Item;
  fresh: boolean;
  /** Null for an embed. */
  char: string | null;
  /** A character's effective format: the values of the text map governing it, as stable JSON. */
  fmt: string | null;
  /** The text map governing a character. */
  gov: Y.Item | null;
}
const keyOf = (e: { client: number; clock: number }) => `${e.client}:${e.clock}`;

/** Whether a type is a V1 text node's map, as of the `include`d entries. */
function isTextMapType(type: unknown, include: (item: Y.Item) => boolean): type is Y.Map<unknown> {
  return type instanceof Y.Map && mapJson(type, include).__type === 'text';
}

/**
 * The units of `items` and their nested content in document order, counting only `include`d items. A text map is not
 * a unit: it is the format of the characters after it, up to the next embed. Formatting marks and tombstones carry
 * nothing a V1 body shows.
 */
function flatten(items: Iterable<Y.Item>, include: (item: Y.Item) => boolean, isFresh: (item: Y.Item) => boolean, out: Unit[]): void {
  let fmt: string | null = null;
  let gov: Y.Item | null = null;
  for (const item of items) {
    const { content, id } = item;
    if (content instanceof Y.ContentFormat || content instanceof Y.ContentDeleted) continue;
    const fresh = isFresh(item);
    if (content instanceof Y.ContentString) {
      for (let i = 0; i < content.str.length; i++) out.push({ client: id.client, clock: id.clock + i, item, fresh, char: content.str[i], fmt, gov });
      continue;
    }
    if (content instanceof Y.ContentType && isTextMapType(content.type, include)) {
      fmt = stableJson(mapJson(content.type, include));
      gov = item;
      continue;
    }
    fmt = null;
    gov = null;
    for (let i = 0; i < item.length; i++) out.push({ client: id.client, clock: id.clock + i, item, fresh, char: null, fmt: null, gov: null });
    if (content instanceof Y.ContentType) flatten(children(content.type as Type, include), include, isFresh, out);
  }
}

function* children(type: Type, include: (item: Y.Item) => boolean): Generator<Y.Item> {
  for (let item = type._start; item; item = item.right) if (include(item)) yield item;
}

/** A map's entries as of the `include`d items: an entry the frame overwrote reads its previous value. */
function mapJson(map: Y.Map<unknown>, include: (item: Y.Item) => boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, last] of map._map) {
    let item: Y.Item | null = last;
    while (item && !include(item)) item = item.left;
    if (item && !(item.content instanceof Y.ContentDeleted)) {
      const values = item.content.getContent();
      out[key] = values[values.length - 1];
    }
  }
  return out;
}

const stableJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key] instanceof Y.AbstractType ? 'type' : value[key]]));

/**
 * Pairs each unit before the frame with the same unit after it, or, for a `wanted` unit the frame deleted, with the
 * next fresh unit `same` accepts as its copy. Units that existed before keep their document order (Yjs never moves an
 * item), so the scan for a copy stops at the first unit that is not fresh.
 */
function align(
  pre: readonly Unit[], post: readonly Unit[],
  on: { wanted: (o: Unit) => boolean; same: (o: Unit, p: Unit) => boolean; kept: (o: Unit, p: Unit) => void; matched: (o: Unit, p: Unit) => void; missing: (o: Unit) => void },
): void {
  const live = new Set(post.filter((p) => !p.fresh).map(keyOf));
  let j = 0;
  for (const o of pre) {
    if (live.has(keyOf(o))) {
      while (j < post.length && keyOf(post[j]) !== keyOf(o)) j++;
      on.kept(o, post[j]);
      j++;
      continue;
    }
    if (!on.wanted(o)) continue;
    let found = -1;
    for (let k = j; k < post.length && post[k].fresh; k++) {
      if (on.same(o, post[k])) {
        found = k;
        break;
      }
    }
    if (found < 0) {
      on.missing(o);
      continue;
    }
    on.matched(o, post[found]);
    j = found + 1;
  }
}

function coveredBy(spans: readonly IdSpan[], client: number, from: number, to: number): boolean {
  let at = from;
  for (const span of spans.filter((s) => s.client === client).sort((a, b) => a.clock - b.clock)) {
    if (span.clock > at) break;
    at = Math.max(at, span.clock + span.len);
    if (at >= to) return true;
  }
  return at >= to;
}

/** Adds one item id to the id set, extending the last span when the clock continues it. */
function register(spans: IdSpan[], client: number, clock: number): void {
  const last = spans[spans.length - 1];
  if (last && last.client === client && last.clock + last.len === clock) last.len += 1;
  else spans.push({ client, clock, len: 1 });
}

function spansOf(keys: ReadonlySet<string>): IdSpan[] {
  const out: IdSpan[] = [];
  for (const [client, clock] of [...keys].map((k) => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    register(out, client, clock);
  }
  return out;
}

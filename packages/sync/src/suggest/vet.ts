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
    if (store.pendingStructs !== null || store.pendingDs !== null) verdict = { ok: false, reason: 'unresolvable' };
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
  const movedBefore = new SpanIndex(options.moved ?? []);
  const ownBefore = new SpanIndex(options.own);
  const isOwnClock = (item: Y.Item, clock: number): boolean => {
    const client = item.id.client;
    if (movedBefore.has(client, clock) || copies.has(`${client}:${clock}`)) return false;
    return isFresh(item) || ownBefore.has(client, clock);
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
  // with its format, or an embed) live before. After: the original units live after and every fresh unit. Each original
  // must still be there, in order, with the same format; an original character may be deleted only as half of a split
  // (Enter mid-paragraph, a soft break, a run formatted mid-word, or undoing one), by matching a fresh copy with the
  // same character and format at its place in document order, and the copy stays original. A character's format is
  // its text map's values, its depth and the attributes of every block around it; a copy's block may differ from the
  // original's only as Lexical's Enter makes it (enterMakes), or back again when the copy goes into an existing
  // original block (an undo, or a join back).
  const body = transaction.doc.share.get(BODY) as Type | undefined;
  if (body) {
    const window = topLevel(body, [...fresh, ...deleted, ...[...touched].map((type) => type._item)]);
    if (window.size > 0) {
      const ownUnit = (unit: Unit) => !unit.fresh && isOwnClock(unit.item, unit.clock);
      const sameBlock = (o: Unit, p: Unit): boolean => {
        if (o.blockKey === p.blockKey) return true;
        if (!o.block || !p.block || !p.container) return false;
        if (enterMakes(o.block, p.block)) return true;
        return !isFresh(p.container) && !isOwn(p.container) && enterMakes(p.block, o.block);
      };
      const { pre, post } = units(body, window, liveBefore, isFresh);
      align(pre.filter((unit) => !ownUnit(unit)), post.filter((unit) => unit.fresh || !ownUnit(unit)), {
        wanted: () => true,
        // An embed is never a copy.
        same: (o, p) => o.char !== null && p.char === o.char && p.text === o.text && sameBlock(o, p),
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

/** Block attributes that only style what is typed next into an empty block, never the text already in it. */
const NEXT_TYPING: ReadonlySet<string> = new Set(['__textFormat', '__textStyle']);
/** Element attributes Lexical's heading and quote Enter do not copy to the new block. */
const ENTER_RESETS = ['__format', '__indent', '__style'] as const;
type Attrs = Readonly<Record<string, unknown>>;

const isDefault = (value: unknown) => value === undefined || value === null || value === 0 || value === '' || value === false;
const sameValue = (a: unknown, b: unknown) => a === b || (a == null && b == null) || JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether Lexical's Enter in a block with `from`'s attributes makes a block with `to`'s (lexical 0.48:
 * ParagraphNode, HeadingNode, QuoteNode and ListItemNode `insertNewAfter`). A list item keeps everything but its
 * number and starts unchecked. A paragraph keeps
 * everything but its indent, a heading keeps its tag and direction, and a quote becomes a paragraph with its
 * direction. Any other difference is a restyle, never a split.
 */
function enterMakes(from: Attrs, to: Attrs): boolean {
  const equalExcept = (skip: readonly string[]) => {
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      if (!skip.includes(key) && !sameValue(from[key], to[key])) return false;
    }
    return true;
  };
  const resetOrKept = (keys: readonly string[]) => keys.every((key) => isDefault(to[key]) || sameValue(to[key], from[key]));
  if (from.__type === 'paragraph' && to.__type === 'paragraph') return equalExcept(['__indent']) && resetOrKept(['__indent']);
  // The list's own transform renumbers `__value`, and a new item starts unchecked.
  if (from.__type === 'listitem' && to.__type === 'listitem') return equalExcept(['__value', '__checked']) && resetOrKept(['__checked']);
  if (from.__type === 'heading' && to.__type === 'heading') return equalExcept(ENTER_RESETS) && resetOrKept(ENTER_RESETS);
  if (from.__type === 'quote' && to.__type === 'paragraph') {
    return sameValue(from.__dir, to.__dir) && ENTER_RESETS.every((key) => isDefault(to[key]));
  }
  return false;
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
  return carryIdentities(doc, update, [spans])[0];
}

/** carryIdentity for every open record at once, the way the DocDO runs it. */
export function carryIdentities(doc: Y.Doc, update: Uint8Array, records: readonly (readonly IdSpan[])[]): IdSpan[][] {
  const mirror = new SuggestMirror(doc);
  try {
    return mirror.apply(update, (transaction) => carryRecords(transaction, records)) ?? records.map((spans) => spans.map((span) => ({ ...span })));
  } finally {
    mirror.destroy();
  }
}

/** The carry on an applied transaction, from afterTransaction. */
export function carryTransaction(transaction: Y.Transaction, spans: readonly IdSpan[]): IdSpan[] {
  return carryRecords(transaction, [spans])[0];
}

/**
 * The carry of every record on one alignment. Every deleted character takes part, tracked or not, so each copy is
 * matched to exactly one source, and the copy goes to the record that owned that source: identical characters of
 * different records, or of a record and original text, side by side never share a copy.
 */
export function carryRecords(transaction: Y.Transaction, records: readonly (readonly IdSpan[])[]): IdSpan[][] {
  const out = records.map((spans) => spans.map((span) => ({ ...span })));
  const indexes = records.map((spans) => new SpanIndex(spans));
  const owners = (client: number, clock: number) => indexes.flatMap((index, i) => (index.has(client, clock) ? [i] : []));
  const { isFresh, liveBefore, fresh, deleted } = frameOf(transaction, { structs: Infinity, types: Infinity });
  const hit = deleted.some((item) => {
    if (!(item.content instanceof Y.ContentString)) return false;
    for (let i = 0; i < item.length; i++) if (owners(item.id.client, item.id.clock + i).length > 0) return true;
    return false;
  });
  const body = transaction.doc.share.get(BODY) as Type | undefined;
  if (!hit || !body) return out;
  const { pre, post } = units(body, topLevel(body, [...fresh, ...deleted]), liveBefore, isFresh);
  // Characters only: an editor's bold re-inserts the run with new text properties, and it is still the same text.
  const added = records.map(() => new Set<string>());
  align(pre, post, {
    wanted: (o) => o.char !== null,
    same: (o, p) => o.char !== null && p.char === o.char,
    kept: () => {},
    matched: (o, p) => {
      for (const i of owners(o.client, o.clock)) {
        added[i].add(keyOf(p));
        if (p.gov && isFresh(p.gov)) added[i].add(keyOf(p.gov.id));
      }
    },
    missing: () => {},
  });
  added.forEach((keys, i) => out[i].push(...spansOf(keys)));
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
  const index = new SpanIndex(inserts);
  const own = (id: { client: number; clock: number }) => index.has(id.client, id.clock);
  const registers = rootType(doc, REGISTERS);
  // A decorator's payload lives in its register, not under the decorator, and deleting the register's entry deletes
  // its text with it: an own register holding someone else's text stays, with the decorator naming it.
  const registerForeign = new Map<string, boolean>();
  const visitRegister = (key: string): boolean => {
    const known = registerForeign.get(key);
    if (known !== undefined) return known;
    registerForeign.set(key, false);
    const entry = registers?._map.get(key);
    if (!entry || entry.deleted) return false;
    const foreign = entry.content instanceof Y.ContentType ? visit(entry.content.type as Type) : false;
    if (own(entry.id) && !foreign) remove.add(keyOf(entry.id));
    registerForeign.set(key, foreign);
    return foreign;
  };
  const registerOf = (type: Type): string | null => {
    const entry = type._map.get('__regId');
    if (!entry || entry.deleted) return null;
    const values = entry.content.getContent();
    const value = values[values.length - 1];
    return typeof value === 'string' && value !== '' ? value : null;
  };
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
      let inner = false;
      if (content instanceof Y.ContentType) {
        const children = visit(content.type as Type);
        const register = registerOf(content.type as Type);
        inner = (register !== null && visitRegister(register)) || children;
      }
      if (!own(id)) foreign = true;
      else if (!inner) remove.add(keyOf(id));
      if (inner) foreign = true;
    }
    closeMap();
    return foreign;
  };
  const body = rootType(doc, BODY);
  if (body) visit(body);
  for (const key of registers?._map.keys() ?? []) visitRegister(key);
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
  /** A character's text format: its depth, the attributes of the blocks around its block, and its text map's values. */
  text: string | null;
  /** A character's effective format: `text` plus its block's attributes. */
  fmt: string | null;
  /** The text map governing a character. */
  gov: Y.Item | null;
  /** The block holding a character, and that block's attributes (without NEXT_TYPING) as an object and as JSON. */
  container: Y.Item | null;
  block: Attrs | null;
  blockKey: string | null;
}

/** Where flatten is: the depth, the blocks around the current one, and the current block. */
interface Place {
  depth: number;
  outer: string;
  container: Y.Item | null;
  block: Attrs | null;
  blockKey: string;
}
const ROOT_PLACE: Place = { depth: 0, outer: '', container: null, block: null, blockKey: '-' };
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
function flatten(items: Iterable<Y.Item>, include: (item: Y.Item) => boolean, isFresh: (item: Y.Item) => boolean, out: Unit[], place = ROOT_PLACE): void {
  let map: string | null = null;
  let gov: Y.Item | null = null;
  const { container, block, blockKey } = place;
  for (const item of items) {
    const { content, id } = item;
    if (content instanceof Y.ContentFormat || content instanceof Y.ContentDeleted) continue;
    const fresh = isFresh(item);
    if (content instanceof Y.ContentString) {
      // The nesting depth is part of the format: a split never moves text into or out of a nested block.
      const text = `${place.depth} ${place.outer} ${map ?? '-'}`;
      const fmt = `${text} ${blockKey}`;
      for (let i = 0; i < content.str.length; i++) {
        out.push({ client: id.client, clock: id.clock + i, item, fresh, char: content.str[i], text, fmt, gov, container, block, blockKey });
      }
      continue;
    }
    if (content instanceof Y.ContentType && isTextMapType(content.type, include)) {
      map = stableJson(mapJson(content.type, include));
      gov = item;
      continue;
    }
    map = null;
    gov = null;
    for (let i = 0; i < item.length; i++) {
      out.push({ client: id.client, clock: id.clock + i, item, fresh, char: null, text: null, fmt: null, gov: null, container, block, blockKey });
    }
    if (content instanceof Y.ContentType) {
      const attrs = mapJson(content.type, include);
      for (const key of NEXT_TYPING) delete attrs[key];
      const next: Place = { depth: place.depth + 1, outer: `${place.outer}/${blockKey}`, container: item, block: attrs, blockKey: stableJson(attrs) };
      flatten(children(content.type as Type, include), include, isFresh, out, next);
    }
  }
}

function* children(type: Type, include: (item: Y.Item) => boolean): Generator<Y.Item> {
  for (let item = type._start; item; item = item.right) if (include(item)) yield item;
}

/** A map's entries as of the `include`d items: an entry the frame overwrote reads its previous value. */
function mapJson(map: Type, include: (item: Y.Item) => boolean): Record<string, unknown> {
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

/** An id set indexed once: per client, sorted and merged [from, to) ranges, looked up by binary search. */
class SpanIndex {
  readonly #ranges = new Map<number, number[]>();

  constructor(spans: readonly IdSpan[]) {
    const byClient = new Map<number, IdSpan[]>();
    for (const span of spans) {
      if (span.len <= 0) continue;
      const list = byClient.get(span.client);
      if (list) list.push(span);
      else byClient.set(span.client, [span]);
    }
    for (const [client, list] of byClient) {
      const flat: number[] = [];
      for (const { clock, len } of list.sort((a, b) => a.clock - b.clock)) {
        const end = flat.length - 1;
        if (end > 0 && clock <= flat[end]) flat[end] = Math.max(flat[end], clock + len);
        else flat.push(clock, clock + len);
      }
      this.#ranges.set(client, flat);
    }
  }

  has(client: number, clock: number): boolean {
    const flat = this.#ranges.get(client);
    if (!flat) return false;
    let lo = 0;
    let hi = flat.length / 2 - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (clock < flat[2 * mid]) hi = mid - 1;
      else if (clock >= flat[2 * mid + 1]) lo = mid + 1;
      else return true;
    }
    return false;
  }
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

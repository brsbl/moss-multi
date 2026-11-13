// A note's size as its limits count it (A§5.1 Limits): the characters of text its body holds (JavaScript string
// length, summed over every text run under `root`), and the Yjs structs its doc holds (live, deleted and collected
// alike, since edit history costs memory too). A payload doc counts its `payload` text and its structs the same way.
// `growthOf` predicts what an update would add before it is applied, without copying the doc.
import * as Y from 'yjs';

type Type = Y.AbstractType<unknown>;
type Struct = Y.Item | Y.GC;

/** A payload's size as the note's limits count it. */
export interface PayloadSize {
  chars: number;
  structs: number;
}

/** A payload doc's text characters (its `payload` text; a chart's or sketch's keys hold none) and structs. */
export function payloadSize(doc: Y.Doc): PayloadSize {
  // A type a remote update made is untyped until read as one; a chart's or sketch's doc has no `payload`.
  const chars = doc.share.has('payload') ? doc.getText('payload').length : 0;
  return { chars, structs: structCount(doc) };
}

/** Which top-level types' text counts: the note's body (`root`), or everything (a payload doc). */
export type Scope = 'body' | 'all';

/** Every struct the doc's store holds. */
export function structCount(doc: Y.Doc): number {
  let count = 0;
  for (const structs of doc.store.clients.values()) count += structs.length;
  return count;
}

/** Whether `type` is the body or nested in it (memoized per type). */
function scopeTest(doc: Y.Doc, scope: Scope): (type: Type | null) => boolean {
  if (scope === 'all') return () => true;
  // Looked up on each walk: a fresh doc defines `root` only when its seed is written.
  const known = new WeakMap<Type, boolean>();
  return (type) => {
    if (!type) return false;
    const root = doc.share.get('root') ?? null;
    const seen: Type[] = [];
    let at: Type | null = type;
    let found: boolean | undefined;
    while (at) {
      found = known.get(at);
      if (found !== undefined) break;
      seen.push(at);
      if (at === root) {
        found = true;
        break;
      }
      const parent: unknown = at._item?.parent ?? null;
      at = parent instanceof Y.AbstractType ? (parent as Type) : null;
    }
    const result = found ?? false;
    for (const visited of seen) known.set(visited, result);
    return result;
  };
}

const textOf = (struct: Struct): number =>
  struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentString ? struct.length : 0;

/** The characters of text in scope, by a walk over every struct. */
export function countChars(doc: Y.Doc, scope: Scope = 'body'): number {
  const inScope = scopeTest(doc, scope);
  let chars = 0;
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      const length = textOf(struct);
      if (length > 0 && inScope((struct as Y.Item).parent as Type)) chars += length;
    }
  }
  return chars;
}

/**
 * The characters of text in scope, kept exact as transactions apply: counted once, then adjusted by each
 * transaction's new structs and deletions (before Yjs collects the deleted content).
 */
export class TextCount {
  #chars: number;
  readonly #inScope: (type: Type | null) => boolean;
  readonly #listener: (transaction: Y.Transaction) => void;

  constructor(readonly doc: Y.Doc, readonly scope: Scope = 'body') {
    this.#inScope = scopeTest(doc, scope);
    this.#chars = countChars(doc, scope);
    this.#listener = (transaction) => this.#apply(transaction);
    doc.on('afterTransaction', this.#listener);
  }

  get chars(): number {
    return this.#chars;
  }

  /** Counts afresh (at load and at each compaction). */
  recount(): number {
    this.#chars = countChars(this.doc, this.scope);
    return this.#chars;
  }

  dispose(): void {
    this.doc.off('afterTransaction', this.#listener);
  }

  #apply(transaction: Y.Transaction): void {
    const { beforeState, afterState } = transaction;
    const store = this.doc.store;
    for (const [client, after] of afterState) {
      const before = beforeState.get(client) ?? 0;
      if (after <= before) continue;
      const structs = store.clients.get(client)!;
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i += 1) {
        const length = textOf(structs[i]);
        if (length > 0 && this.#inScope((structs[i] as Y.Item).parent as Type)) this.#chars += length;
      }
    }
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      // Only what was counted: a struct made and deleted in this transaction never was.
      if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentString)) return;
      if (struct.id.clock >= (beforeState.get(struct.id.client) ?? 0)) return;
      if (this.#inScope(struct.parent as Type)) this.#chars -= struct.length;
    });
  }
}

/** What an update would add to a doc: characters in scope (negative when it deletes more), structs, and ids it names. */
export interface Growth {
  chars: number;
  /** An upper bound: Yjs may merge some of them after applying. */
  structs: number;
  /** Whether it makes any struct the doc lacks (a write of only deletions makes none). */
  inserts: boolean;
  /** Payload ids (`__regId` values) the update's new elements name. */
  named: Set<string>;
}

interface Fresh {
  struct: Struct;
  /** The first clock the doc lacks. */
  start: number;
  end: number;
}

const stateOf = (doc: Y.Doc, client: number): number => {
  const structs = doc.store.clients.get(client);
  if (!structs?.length) return 0;
  const last = structs[structs.length - 1];
  return last.id.clock + last.length;
};

/**
 * What applying `update` to `doc` would add, read from the update alone: its new structs, the splits it causes in
 * structs the doc holds (each origin, right origin and deleted range's edge inside one), and the text it inserts in
 * scope less the text it deletes. A frame needing a clock the doc lacks is refused before this runs.
 */
export function growthOf(doc: Y.Doc, update: Uint8Array, scope: Scope = 'body'): Growth {
  const { structs, ds } = Y.decodeUpdate(update);
  const store = doc.store;
  const inScope = scopeTest(doc, scope);
  const fresh = new Map<number, Fresh[]>();
  const growth: Growth = { chars: 0, structs: 0, inserts: false, named: new Set() };
  /** Clocks a struct must start at; true when the split happens even in a deleted struct (an origin). */
  const cuts = new Map<number, Map<number, boolean>>();
  const cut = (client: number, clock: number, always: boolean) => {
    let at = cuts.get(client);
    if (!at) cuts.set(client, (at = new Map()));
    at.set(clock, always || at.get(clock) === true);
  };
  for (const struct of structs as (Struct | { constructor: unknown; id: Y.ID; length: number })[]) {
    if (!(struct instanceof Y.Item) && !(struct instanceof Y.GC)) continue;
    const { client, clock } = struct.id;
    const have = Math.max(stateOf(doc, client), fresh.get(client)?.at(-1)?.end ?? 0);
    if (clock + struct.length <= have) continue;
    const start = Math.max(clock, have);
    let list = fresh.get(client);
    if (!list) fresh.set(client, (list = []));
    list.push({ struct, start, end: clock + struct.length });
    growth.structs += 1;
    growth.inserts = true;
    if (struct instanceof Y.Item && start === clock) {
      if (struct.origin) cut(struct.origin.client, struct.origin.clock + 1, true);
      if (struct.rightOrigin) cut(struct.rightOrigin.client, struct.rightOrigin.clock, true);
    }
  }
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      cut(client, clock, false);
      cut(client, clock + len, false);
    }
  }

  const freshAt = (client: number, clock: number): Fresh | null => {
    const list = fresh.get(client);
    if (!list) return null;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const entry = list[mid];
      if (clock < entry.start) high = mid - 1;
      else if (clock >= entry.end) low = mid + 1;
      else return entry;
    }
    return null;
  };
  const storedAt = (client: number, clock: number): Struct | null => {
    if (clock >= stateOf(doc, client)) return null;
    const list = store.clients.get(client)!;
    return list[Y.findIndexSS(list, clock)];
  };

  // Each cut strictly inside a struct splits it once more; a deleted range's edge splits only a live struct.
  for (const [client, clocks] of cuts) {
    for (const [clock, always] of clocks) {
      const stored = storedAt(client, clock);
      if (stored) {
        if (stored.id.clock !== clock && stored instanceof Y.Item && (always || !stored.deleted)) growth.structs += 1;
        continue;
      }
      const entry = freshAt(client, clock);
      if (entry && entry.start !== clock && entry.struct instanceof Y.Item) growth.structs += 1;
    }
  }

  // Whether a new struct's parent is in scope: from its parent's name or item, else from its origin's parent.
  const scoped = new Map<Struct, boolean>();
  const typeInScope = (item: Y.Item): boolean => item.content instanceof Y.ContentType && inScope(item.content.type as Type);
  const freshInScope = (struct: Struct, depth = 0): boolean => {
    const known = scoped.get(struct);
    if (known !== undefined) return known;
    // A chain too deep to follow counts, so the estimate never falls short.
    if (scope === 'all' || depth > 1_000 || !(struct instanceof Y.Item)) return true;
    // Counted while it resolves, so a crafted cycle of origins ends.
    scoped.set(struct, true);
    let result: boolean;
    const parent = struct.parent as unknown;
    if (typeof parent === 'string') result = scope === 'all' || parent === 'root';
    else if (parent instanceof Y.ID) result = containerInScope(parent, depth);
    else {
      const neighbour = struct.origin ?? struct.rightOrigin;
      result = neighbour ? siblingInScope(neighbour, depth) : true;
    }
    scoped.set(struct, result);
    return result;
  };
  const containerInScope = (id: Y.ID, depth: number): boolean => {
    const stored = storedAt(id.client, id.clock);
    if (stored) return stored instanceof Y.Item ? typeInScope(stored) : true;
    const entry = freshAt(id.client, id.clock);
    return entry ? scope === 'all' || freshInScope(entry.struct, depth + 1) : true;
  };
  const siblingInScope = (id: Y.ID, depth: number): boolean => {
    const stored = storedAt(id.client, id.clock);
    if (stored) return stored instanceof Y.Item ? !(stored.parent instanceof Y.AbstractType) || inScope(stored.parent as Type) : true;
    const entry = freshAt(id.client, id.clock);
    return entry ? freshInScope(entry.struct, depth + 1) : true;
  };

  const deletedWithin = (client: number, start: number, end: number): number => {
    let deleted = 0;
    for (const { clock, len } of ds.clients.get(client) ?? []) {
      const from = Math.max(start, clock);
      const to = Math.min(end, clock + len);
      if (to > from) deleted += to - from;
    }
    return deleted;
  };

  for (const [client, list] of fresh) {
    for (const { struct, start, end } of list) {
      if (!(struct instanceof Y.Item)) continue;
      if (struct.content instanceof Y.ContentString) {
        const kept = end - start - deletedWithin(client, start, end);
        if (kept > 0 && freshInScope(struct)) growth.chars += kept;
      } else if (struct.parentSub === '__regId' && struct.content instanceof Y.ContentAny) {
        const value = struct.content.arr[0];
        if (typeof value === 'string') growth.named.add(value);
      }
    }
  }

  // Text the doc holds that the update deletes.
  for (const [client, ranges] of ds.clients) {
    const list = store.clients.get(client);
    if (!list) continue;
    const state = stateOf(doc, client);
    for (const { clock, len } of ranges) {
      const end = Math.min(clock + len, state);
      for (let i = clock < state ? Y.findIndexSS(list, clock) : list.length; i < list.length && list[i].id.clock < end; i += 1) {
        const struct = list[i];
        const length = textOf(struct);
        if (length === 0 || !inScope((struct as Y.Item).parent as Type)) continue;
        growth.chars -= Math.min(end, struct.id.clock + length) - Math.max(clock, struct.id.clock);
      }
    }
  }
  return growth;
}

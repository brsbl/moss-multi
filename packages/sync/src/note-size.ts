// A note's size as its limits count it (A§5.1 Limits): the characters of text its body holds (JavaScript string
// length, summed over every text run under `root`), and the Yjs structs its doc holds (live, deleted and collected
// alike, since edit history costs memory too). A payload doc counts its `payload` text and its structs the same way.
// `growthOf` predicts what an update would add before it is applied, without copying the doc.
import * as Y from 'yjs';
import { isPayloadType } from './payload-docs.ts';

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
  /** An upper bound: Yjs may merge some of them after applying. Negative when a write of only deletions merges more than it splits. */
  structs: number;
  /** Whether it makes any struct the doc lacks (a write of only deletions makes none). */
  inserts: boolean;
  /** Whether any new struct is more than a property or a format (text, an element, an embed, deleted content). */
  content: boolean;
  /**
   * Payload ids the update may name: each new `__regId`, and the id of each element whose new `__type` is a payload's.
   * A superset, so a payload brought into the note is never missed.
   */
  named: Set<string>;
  /**
   * Stored elements the update deletes (with everything inside a deleted container) or may stop naming a payload
   * (a new `__type` that is not a payload's, or a new `__regId`). A subset, so a payload is never dropped wrongly.
   */
  dropped: Set<Y.XmlElement>;
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

/** How many clocks in [start, end) the ranges delete. `ranges` is sorted and merged (Y.mergeDeleteSets). */
export function deletedWithin(ranges: readonly { clock: number; len: number }[], start: number, end: number): number {
  // The first range ending after `start`, found by bisection, so a frame of many strings and ranges stays linear.
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const { clock, len } = ranges[mid];
    if (clock + len <= start) low = mid + 1;
    else high = mid;
  }
  let deleted = 0;
  for (let i = low; i < ranges.length; i += 1) {
    const { clock, len } = ranges[i];
    if (clock >= end) break;
    deleted += Math.min(end, clock + len) - Math.max(start, clock);
  }
  return deleted;
}

/**
 * What applying `update` to `doc` would add, read from the update alone: its new structs, the splits it causes in
 * structs the doc holds (each origin, right origin and deleted range's edge inside one), and the text it inserts in
 * scope less the text it deletes. For a write of only deletions, less the merges it certainly causes, so deleting next
 * to deleted text (a run from its end) reads as adding nothing. A frame needing a clock the doc lacks is refused before
 * this runs.
 */
export function growthOf(doc: Y.Doc, update: Uint8Array, scope: Scope = 'body'): Growth {
  const decoded = Y.decodeUpdate(update);
  const structs = decoded.structs;
  // Sorted and merged as applying it does: a crafted update may list a range twice, overlapping or out of order.
  const ds = Y.mergeDeleteSets([decoded.ds]);
  const store = doc.store;
  const inScope = scopeTest(doc, scope);
  const fresh = new Map<number, Fresh[]>();
  const growth: Growth = { chars: 0, structs: 0, inserts: false, content: false, named: new Set(), dropped: new Set() };
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

  // A write of only deletions also merges what it leaves deleted beside a deleted neighbour (deleting a run from its end).
  if (!growth.inserts) growth.structs -= mergesAfterDeleting(doc, ds);

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
    if (typeof parent === 'string') result = parent === 'root';
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

  /** The live element a stored item is, if it is one. */
  const elementAt = (id: Y.ID): Y.XmlElement | null => {
    const stored = storedAt(id.client, id.clock);
    return stored instanceof Y.Item && !stored.deleted && stored.content instanceof Y.ContentType && stored.content.type instanceof Y.XmlElement
      ? stored.content.type : null;
  };
  interface Key {
    sub: string | null;
    /** The stored element it is set on, else the new struct of the new type it is set on, else null (unknown). */
    on: Y.XmlElement | Struct | null;
    /** Whether it takes the place of the stored element's value (one set later than it, or a key it lacks). */
    replaces: boolean;
  }
  const keyed = (sub: string, parent: Y.ID | null): Key => {
    const element = parent ? elementAt(parent) : null;
    if (element) {
      const current = element._map.get(sub);
      return { sub, on: element, replaces: !current || current.deleted };
    }
    const entry = parent && !storedAt(parent.client, parent.clock) ? freshAt(parent.client, parent.clock) : null;
    return { sub, on: entry?.struct ?? null, replaces: true };
  };
  const UNKEYED: Key = { sub: null, on: null, replaces: false };
  /**
   * A new item's map key and the element it is set on. An update omits both for a key it sets again (its origin is the
   * value it replaces), so they are read from the origin. Null when they cannot be known.
   */
  const keyOf = (item: Y.Item, depth = 0): Key | null => {
    if (item.parentSub !== null) return keyed(item.parentSub, item.parent instanceof Y.ID ? item.parent : null);
    if (item.parent !== null || !item.origin) return UNKEYED;
    if (depth > 1_000) return null;
    const stored = storedAt(item.origin.client, item.origin.clock);
    if (stored) {
      if (!(stored instanceof Y.Item)) return null;
      if (stored.parentSub === null) return UNKEYED;
      const element = stored.parent instanceof Y.XmlElement && !stored.parent._item?.deleted ? stored.parent : null;
      return { sub: stored.parentSub, on: element, replaces: !stored.deleted };
    }
    const entry = freshAt(item.origin.client, item.origin.clock);
    return entry?.struct instanceof Y.Item ? keyOf(entry.struct, depth + 1) : null;
  };

  /** Per element whose `__regId` or `__type` the update sets: the values it sets, and whether one replaces the stored. */
  interface Naming { regIds: string[]; types: unknown[]; newId: boolean; newType: boolean }
  const naming = new Map<Y.XmlElement | Struct | null, Naming>();
  const entryOf = (on: Y.XmlElement | Struct | null): Naming => {
    let entry = naming.get(on);
    if (!entry) naming.set(on, (entry = { regIds: [], types: [], newId: false, newType: false }));
    return entry;
  };
  /** `__type` values set on new elements, read only for those the update also gives an id (a note's every block has one). */
  const newTypes: Y.Item[] = [];
  for (const [client, list] of fresh) {
    for (const { struct, start, end } of list) {
      if (!(struct instanceof Y.Item)) {
        growth.content = true;
        continue;
      }
      if (struct.content instanceof Y.ContentString) {
        growth.content = true;
        const kept = end - start - deletedWithin(ds.clients.get(client) ?? [], start, end);
        if (kept > 0 && freshInScope(struct)) growth.chars += kept;
        continue;
      }
      if (struct.content instanceof Y.ContentFormat) continue;
      const key = keyOf(struct);
      if (!key?.sub) {
        growth.content = true;
        continue;
      }
      if (key.sub !== '__regId' && key.sub !== '__type') continue;
      const value = struct.content instanceof Y.ContentAny ? struct.content.arr[0] : undefined;
      if (key.sub === '__type' && key.on !== null && !(key.on instanceof Y.XmlElement)) {
        newTypes.push(struct);
        continue;
      }
      const entry = entryOf(key.on);
      if (key.sub === '__regId') {
        if (typeof value === 'string') entry.regIds.push(value);
        entry.newId ||= key.replaces;
      } else {
        entry.types.push(value);
        entry.newType ||= key.replaces;
      }
    }
  }
  if ([...naming.keys()].some((on) => on !== null && !(on instanceof Y.XmlElement))) {
    for (const item of newTypes) {
      const entry = naming.get(keyOf(item)!.on);
      if (!entry) continue;
      entry.types.push(item.content instanceof Y.ContentAny ? item.content.arr[0] : undefined);
      entry.newType = true;
    }
  }
  for (const [on, { regIds, types, newId, newType }] of naming) {
    const element = on instanceof Y.XmlElement ? on : null;
    // Of the values one update sets, any may win; an element it is not known to set on, or a new one it gives no type
    // (a later update may), may be a payload's.
    const after = newType ? types : [...types, element?.getAttribute('__type')];
    const payload = on === null || (!element && !types.length) || after.some((type) => typeof type === 'string' && isPayloadType(type));
    if (payload) {
      for (const id of regIds) growth.named.add(id);
      const stored: unknown = element?.getAttribute('__regId');
      if (!newId && typeof stored === 'string') growth.named.add(stored);
    }
    // A stored element stops naming its payload when a later value replaces its id, or its type with no payload's.
    if (element && (newId || (newType && !payload))) growth.dropped.add(element);
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
        if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentType) elementsIn(struct.content.type as Type, growth.dropped);
        const length = textOf(struct);
        if (length === 0 || !inScope((struct as Y.Item).parent as Type)) continue;
        growth.chars -= Math.min(end, struct.id.clock + length) - Math.max(clock, struct.id.clock);
      }
    }
  }
  return growth;
}

/** Whether `ranges` (sorted and merged) delete `clock`. */
function deletes(ranges: readonly { clock: number; len: number }[], clock: number): boolean {
  return deletedWithin(ranges, clock, clock + 1) > 0;
}

const sameId = (a: Y.ID | null, b: Y.ID | null): boolean => a === b || (a !== null && b !== null && a.client === b.client && a.clock === b.clock);

/**
 * How many pairs of neighbouring stored structs Yjs merges once a write of only deletions applies: both deleted after
 * it, the right one inserted just after the left (so they were one run), and their content alike once collected. The
 * pairs counted are those at or inside each deleted range's edges; any other merge it makes only lowers the count, so
 * the prediction stays at or above what lands.
 */
function mergesAfterDeleting(doc: Y.Doc, ds: ReturnType<typeof Y.mergeDeleteSets>): number {
  let merged = 0;
  for (const [client, ranges] of ds.clients) {
    const list = doc.store.clients.get(client);
    if (!list?.length) continue;
    const state = stateOf(doc, client);
    // The content a struct holds once the write's deletions are collected (y-partyserver's docs collect them).
    const contentAfter = (item: Y.Item): unknown => {
      const newly = !item.deleted;
      return newly && doc.gc && !item.keep && doc.gcFilter(item) ? Y.ContentDeleted : item.content.constructor;
    };
    let checked = -1;
    for (const { clock, len } of ranges) {
      if (clock >= state) break;
      const end = Math.min(clock + len, state);
      // Each stored struct starting in [clock, end] with the one before it: the pairs whose edge the range touches.
      for (let i = Y.findIndexSS(list, clock); i < list.length && list[i].id.clock <= end; i += 1) {
        const right = list[i];
        if (i === 0 || i <= checked || right.id.clock < clock) continue;
        checked = i;
        const left = list[i - 1];
        if (!(left instanceof Y.Item) || !(right instanceof Y.Item)) continue;
        const leftEnd = left.id.clock + left.length;
        if (!(left.deleted || deletes(ranges, leftEnd - 1)) || !(right.deleted || deletes(ranges, right.id.clock))) continue;
        if (left.right !== right || !sameId(right.origin, Y.createID(client, leftEnd - 1)) || !sameId(left.rightOrigin, right.rightOrigin)) continue;
        if (left.redone !== null || right.redone !== null) continue;
        const kind = contentAfter(left);
        if (kind !== contentAfter(right) || (kind !== Y.ContentDeleted && kind !== Y.ContentString)) continue;
        merged += 1;
      }
    }
  }
  return merged;
}

/** `type` if it is an element, and every live element inside it. */
function elementsIn(type: Type, into: Set<Y.XmlElement>): void {
  if (type instanceof Y.XmlElement) into.add(type);
  for (let item = type._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) elementsIn(item.content.type as Type, into);
  }
}

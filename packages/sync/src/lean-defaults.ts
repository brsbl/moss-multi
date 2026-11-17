// The lean layout (A§10.11) for an undo: Yjs removes a key outright when an undo takes back the write that first stored
// it, and a client on the earlier binding reads an empty key as `undefined`, not as the class default.
import type { Binding } from '@lexical/yjs';
import {
  ContentDeleted, decodeUpdate, findIndexSS, GC, getState, Item, Map as YMap, mergeDeleteSets, XmlElement, XmlText, type AbstractType, type Doc, type Transaction,
} from 'yjs';

/** Each node type's properties the lean layout leaves out at their default, as the patched binding builds them. */
export type LeanDefaults = ReadonlyMap<string, Readonly<Record<string, unknown>>>;
type LeanBinding = Binding & { leanDefaults?: LeanDefaults };

/** The binding's lean defaults; undefined for a binding without the patch. */
export const leanDefaultsOf = (binding: Binding): LeanDefaults | undefined => (binding as LeanBinding).leanDefaults;

/** The default `parent`'s node class has for `key`, or undefined when it has none worth writing. */
function defaultFor(defaults: LeanDefaults | undefined, parent: AbstractType<unknown>, key: string): unknown {
  if (key === '__type' || parent._item?.deleted) return undefined;
  const type = parent._map.get('__type');
  if (!type || type.deleted) return undefined;
  const values = defaults?.get(type.content.getContent()[0] as string);
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

function write(parent: AbstractType<unknown>, key: string, value: unknown): boolean {
  if (parent instanceof YMap) parent.set(key, value);
  else if (parent instanceof XmlText || parent instanceof XmlElement) parent.setAttribute(key, value as string);
  else return false;
  return true;
}

/**
 * Called on an undo's map entry before it is deleted: when it is the key's current value and its node class has a
 * lean default for it, writes that default in its place in the undo's transaction (so a redo takes it back like any
 * replaced value), and returns true. An `undefined` default reads the same either way and is not written.
 */
export function keepLeanDefault(binding: Binding, item: Item): boolean {
  const key = item.parentSub;
  const parent = item.parent as AbstractType<unknown>;
  if (key === null || item.deleted || parent._map.get(key) !== item) return false;
  const value = defaultFor(leanDefaultsOf(binding), parent, key);
  return value !== undefined && write(parent, key, value);
}

/** Keys and structs the repairs looked at: a step counter for tests. */
export const repairWork = { steps: 0 };

/**
 * The client id the DocDO's repairs are written under. Of two concurrent writes to one key Yjs keeps the higher
 * client id's, and no client's is below 0, so a client's write concurrent with a repair always wins over it.
 */
export const REPAIR_CLIENT = 0;

const PRIMITIVES = new Set(['number', 'string', 'boolean']);

/** Whether `value` cannot stand for a default of type `kind`: another type, or a number that is not finite. */
const mismatches = (kind: string, value: unknown): boolean => typeof value !== kind || (kind === 'number' && !Number.isFinite(value));

/** Whether a stored value is the wrong one for `fallback`, the class default: only a number, string or boolean default is held to its type. */
export function wrongType(fallback: unknown, value: unknown): boolean {
  return PRIMITIVES.has(typeof fallback) && mismatches(typeof fallback, value);
}

const isNodeType = (type: AbstractType<unknown>) => type instanceof YMap || type instanceof XmlText || type instanceof XmlElement;
const valueOf = (item: Item): unknown => item.content.getContent()[item.length - 1];

/** Whether the key's current entry needs its class default: emptied, or holding a value of the wrong type. */
function due(defaults: LeanDefaults, type: AbstractType<unknown>, key: string, item: Item | undefined): unknown {
  const value = defaultFor(defaults, type, key);
  if (value === undefined) return undefined;
  if (!item || item.deleted) return value;
  return wrongType(value, valueOf(item)) ? value : undefined;
}

/**
 * Writes the repairs under REPAIR_CLIENT, each only while its key still holds the entry it was found with, so a write
 * that landed meanwhile is never overwritten.
 */
function repair(doc: Doc, origin: unknown, writes: [AbstractType<unknown>, string, Item | undefined, unknown][]): void {
  const own = doc.clientID;
  doc.clientID = REPAIR_CLIENT;
  try {
    doc.transact(() => {
      for (const [type, key, item, value] of writes) if (type._map.get(key) === item) write(type, key, value);
    }, origin);
  } finally {
    doc.clientID = own;
  }
}

/**
 * After each transaction `from` accepts, every body node key it wrote that its node class has a lean default for, and
 * that it left empty (an earlier build's undo of a key's first write deletes the key, and its reader then assigns
 * `undefined` to the node) or holding a value of the wrong type for a number, string or boolean default (a NaN indent),
 * gets that default back under `origin`, so every reader holds a value the editor can work with. `__type` and keys whose
 * default is null are left alone; the work is per key the transaction wrote. Returns the detach.
 */
export function keepLeanKeys(doc: Doc, defaults: LeanDefaults, origin: unknown, from: (origin: unknown) => boolean): () => void {
  const root = doc.get('root', XmlText) as AbstractType<unknown>;
  let written: [AbstractType<unknown>, string, Item | undefined][] = [];
  /** In the body and not deleted, nor inside a deleted node. */
  const live = (type: AbstractType<unknown>) => {
    let at = type;
    while (at._item) {
      if (at._item.deleted) return false;
      at = at._item.parent as AbstractType<unknown>;
    }
    return at === root;
  };
  const collect = (transaction: Transaction) => {
    if (transaction.origin === origin || !from(transaction.origin)) return;
    // The keys of nodes that were there before it (a deleted key's among them)...
    for (const [changed, keys] of transaction.changed) {
      const type = changed as unknown as AbstractType<unknown>;
      if (!isNodeType(type)) continue;
      for (const key of keys) {
        if (key === null || key === '__type') continue;
        repairWork.steps += 1;
        written.push([type, key, type._map.get(key)]);
      }
    }
    // ...and of nodes it made, which Yjs lists in no change: read from its new structs.
    const { beforeState, afterState } = transaction;
    const isNew = (item: Item) => item.id.clock >= (beforeState.get(item.id.client) ?? 0);
    for (const [client, after] of afterState) {
      const before = beforeState.get(client) ?? 0;
      if (after <= before) continue;
      const structs = doc.store.clients.get(client)!;
      for (let i = findIndexSS(structs, before); i < structs.length; i += 1) {
        repairWork.steps += 1;
        const item = structs[i];
        if (!(item instanceof Item) || item.parentSub === null || item.parentSub === '__type') continue;
        const parent = item.parent as AbstractType<unknown>;
        if (!isNodeType(parent) || !parent._item || !isNew(parent._item)) continue;
        written.push([parent, item.parentSub, parent._map.get(item.parentSub)]);
      }
    }
  };
  const restore = () => {
    if (!written.length) return;
    const found = written;
    written = [];
    const writes: [AbstractType<unknown>, string, Item | undefined, unknown][] = [];
    for (const [type, key, item] of found) {
      repairWork.steps += 1;
      if (type._map.get(key) !== item || !live(type)) continue;
      const value = due(defaults, type, key, item);
      if (value !== undefined) writes.push([type, key, item, value]);
    }
    if (writes.length) repair(doc, origin, writes);
  };
  doc.on('afterTransaction', collect);
  doc.on('afterAllTransactions', restore);
  return () => {
    doc.off('afterTransaction', collect);
    doc.off('afterAllTransactions', restore);
  };
}

/** What the repairs of one update would write, read before it applies: an upper bound on their count and bytes. */
export interface Repairs {
  count: number;
  bytes: number;
}

interface KeyFacts {
  /** The primitive types of each key's number, string or boolean defaults, across classes. */
  kinds: Map<string, Set<string>>;
  /** Keys some class has a default for that a repair would write. */
  defaulted: Set<string>;
  /** Bytes one repair can add to the stored state, at most. */
  bytes: number;
}

const facts = new WeakMap<LeanDefaults, KeyFacts>();

function factsOf(defaults: LeanDefaults): KeyFacts {
  let known = facts.get(defaults);
  if (known) return known;
  known = { kinds: new Map(), defaulted: new Set(), bytes: 0 };
  let value = 0;
  for (const values of defaults.values()) {
    for (const [key, fallback] of Object.entries(values)) {
      if (key === '__type' || fallback === undefined) continue;
      known.defaulted.add(key);
      // A string's UTF-8 bytes and its length, a float64, or a tag byte.
      value = Math.max(value, typeof fallback === 'string' ? 3 * fallback.length + 5 : 9);
      if (!PRIMITIVES.has(typeof fallback)) continue;
      let kinds = known.kinds.get(key);
      if (!kinds) known.kinds.set(key, (kinds = new Set()));
      kinds.add(typeof fallback);
    }
  }
  // Its info byte, its origin's client and clock, the content's tag and length, the value, and the delete of the value
  // it replaces; the struct header of REPAIR_CLIENT's run once per update is in REPAIR_HEADER_BYTES.
  known.bytes = 1 + 10 + 2 + value + 11;
  facts.set(defaults, known);
  return known;
}

/** The header of REPAIR_CLIENT's structs and deletes in an update, once. */
const REPAIR_HEADER_BYTES = 24;

type Ranges = readonly { clock: number; len: number }[];

/** Whether `ranges` (sorted and merged) delete `clock`. */
function deletes(ranges: Ranges | undefined, clock: number): boolean {
  if (!ranges) return false;
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid];
    if (clock < range.clock) high = mid - 1;
    else if (clock >= range.clock + range.len) low = mid + 1;
    else return true;
  }
  return false;
}

/**
 * How many keys applying `update` to `doc` could leave for keepLeanKeys to repair, read from the update alone and
 * counted in steps of the update's own structs and the stored structs it deletes, so the count costs the same on any
 * doc: each new key value whose type no class default of that key has, or that the update deletes too, and each
 * stored current value it deletes and replaces with nothing, on a node it leaves standing. An upper bound: a new value
 * that a concurrent one outranks, or set on a node outside the body, still counts.
 */
export function predictRepairs(doc: Doc, update: Uint8Array, defaults: LeanDefaults): Repairs {
  const { kinds, defaulted, bytes } = factsOf(defaults);
  const decoded = decodeUpdate(update);
  const ds = mergeDeleteSets([decoded.ds]);
  const store = doc.store;
  const storedAt = (client: number, clock: number): Item | GC | null => {
    const list = store.clients.get(client);
    if (!list || clock >= getState(store, client)) return null;
    return list[findIndexSS(list, clock)] as Item | GC;
  };
  const deleted = (client: number, clock: number) => deletes(ds.clients.get(client), clock);
  /** The update's new items, per client in clock order (as an update lists them). */
  const fresh = new Map<number, Item[]>();
  /** The stored values the update writes over: each new value's origin. */
  const replaced = new Map<number, Set<number>>();
  const items: Item[] = [];
  for (const struct of decoded.structs) {
    repairWork.steps += 1;
    if (!(struct instanceof Item)) continue;
    const { client, clock } = struct.id;
    if (clock < getState(store, client)) continue;
    items.push(struct);
    let list = fresh.get(client);
    if (!list) fresh.set(client, (list = []));
    list.push(struct);
    if (struct.origin) {
      let at = replaced.get(struct.origin.client);
      if (!at) replaced.set(struct.origin.client, (at = new Set()));
      at.add(struct.origin.clock);
    }
  }
  const freshAt = (client: number, clock: number): Item | null => {
    const list = fresh.get(client);
    if (!list) return null;
    let low = 0;
    let high = list.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const item = list[mid];
      if (clock < item.id.clock) high = mid - 1;
      else if (clock >= item.id.clock + item.length) low = mid + 1;
      else return item;
    }
    return null;
  };
  // An update leaves out the key of a value set over another (its origin): it is read from the origin, once per item.
  const UNKNOWN = Symbol('unknown key');
  const keys = new Map<Item, string | null | typeof UNKNOWN>();
  const keyOf = (item: Item, depth = 0): string | null | typeof UNKNOWN => {
    const known = keys.get(item);
    if (known !== undefined) return known;
    let key: string | null | typeof UNKNOWN;
    if (item.parentSub !== null) key = item.parentSub;
    else if (item.parent !== null || !item.origin) key = null;
    else if (depth > 1_000) key = UNKNOWN;
    else {
      const stored = storedAt(item.origin.client, item.origin.clock);
      const next = stored ? null : freshAt(item.origin.client, item.origin.clock);
      key = stored ? (stored instanceof Item ? stored.parentSub : null) : next ? keyOf(next, depth + 1) : UNKNOWN;
    }
    keys.set(item, key);
    return key;
  };
  let count = 0;
  for (const item of items) {
    const key = keyOf(item);
    if (key === null || key === '__type') continue;
    // A value the update sets again is not the key's: the one set over it is counted instead.
    if (replaced.get(item.id.client)?.has(item.id.clock + item.length - 1)) continue;
    if (key === UNKNOWN) {
      count += 1;
      continue;
    }
    if (deleted(item.id.client, item.id.clock) || item.content instanceof ContentDeleted) {
      if (defaulted.has(key)) count += 1;
      continue;
    }
    const value = valueOf(item);
    const of = kinds.get(key);
    if (of && [...of].some((kind) => mismatches(kind, value))) count += 1;
  }
  for (const [client, ranges] of ds.clients) {
    const list = store.clients.get(client);
    if (!list) continue;
    const state = getState(store, client);
    for (const { clock, len } of ranges) {
      if (clock >= state) continue;
      const end = Math.min(clock + len, state);
      for (let i = findIndexSS(list, clock); i < list.length && list[i].id.clock < end; i += 1) {
        repairWork.steps += 1;
        const struct = list[i];
        if (!(struct instanceof Item) || struct.deleted || struct.parentSub === null || struct.parentSub === '__type') continue;
        const parent = struct.parent as AbstractType<unknown>;
        if (!isNodeType(parent) || parent._map.get(struct.parentSub) !== struct) continue;
        if (parent._item && deleted(parent._item.id.client, parent._item.id.clock)) continue;
        if (replaced.get(client)?.has(struct.id.clock + struct.length - 1)) continue;
        if (defaultFor(defaults, parent, struct.parentSub) !== undefined) count += 1;
      }
    }
  }
  return { count, bytes: count ? REPAIR_HEADER_BYTES + count * bytes : 0 };
}


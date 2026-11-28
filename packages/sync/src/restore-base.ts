// A restore's base (A§14): the note and each payload as the restorer saw them when it opened Restore, sent as state
// vectors. The server reconciles the version over the live state cut back to that base, so whatever anyone inserted
// after it (a peer's typing, an agent's write) merges in where it was typed, and checks before applying that none of it
// would be lost.
import { fromBase64, toBase64 } from 'lib0/buffer';
import * as Y from 'yjs';
import { isPayloadType, type PayloadDocs } from './payload-docs.ts';

/** What a client sends with a restore. */
export interface RestoreBase {
  /** The note's state vector, base64. */
  note: string;
  /** Each payload's state vector the client held, base64, by payload id. */
  payloads: Record<string, string>;
  /** Milliseconds since the client captured it. */
  age: number;
}

/** The base of a restore, captured when its dialog opens; the caller adds its age when it sends it. */
export function captureRestoreBase(doc: Y.Doc, payloads?: PayloadDocs): Omit<RestoreBase, 'age'> {
  const held: Record<string, string> = {};
  // Every payload held, an empty one too; one still loading is left out, and the server refuses a base without it.
  for (const [id, payload] of payloads?.docs ?? []) if (!payloads?.awaiting(id)) held[id] = toBase64(Y.encodeStateVector(payload));
  return { note: toBase64(Y.encodeStateVector(doc)), payloads: held };
}

/** A base the server cannot use: none, too old, or not a state the doc has had. */
export class StaleBase extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleBase';
  }
}

export type StateVector = Map<number, number>;

export interface DecodedBase {
  note: StateVector;
  payloads: Map<string, StateVector>;
}

/** Decodes a restore's base, or throws StaleBase when it is missing, malformed or older than `maxAgeMs`. */
export function decodeRestoreBase(base: unknown, maxAgeMs: number): DecodedBase {
  if (typeof base !== 'object' || base === null) throw new StaleBase('no base');
  const { note, payloads, age } = base as Partial<RestoreBase>;
  if (typeof age !== 'number' || !Number.isFinite(age) || age < 0 || age > maxAgeMs) throw new StaleBase('the base is too old');
  if (typeof note !== 'string' || typeof payloads !== 'object' || payloads === null) throw new StaleBase('a malformed base');
  try {
    return {
      note: Y.decodeStateVector(fromBase64(note)),
      payloads: new Map(Object.entries(payloads).map(([id, sv]) => {
        if (typeof sv !== 'string') throw new Error('a malformed payload base');
        return [id, Y.decodeStateVector(fromBase64(sv))];
      })),
    };
  } catch {
    throw new StaleBase('a malformed base');
  }
}

/** Each client's clock in `doc`. */
const stateOf = (doc: Y.Doc): StateVector => Y.decodeStateVector(Y.encodeStateVector(doc));

/**
 * `update`'s state cut back to `sv`: every item a client made before its clock in `sv`, with every deletion the doc
 * holds of them. Throws StaleBase when the cut is not a state the doc has had (an item would lack its origin).
 */
export function stateAt(update: Uint8Array, sv: StateVector): Uint8Array {
  const full = new Y.Doc({ gc: false });
  const base = new Y.Doc();
  try {
    Y.applyUpdate(full, update);
    const has = stateOf(full);
    const cut: StateVector = new Map();
    for (const [client, clock] of sv) {
      const end = Math.min(clock, has.get(client) ?? 0);
      if (end > 0) cut.set(client, end);
    }
    const deleted = Y.createDeleteSetFromStructStore(full.store);
    const kept = Y.createDeleteSet();
    for (const [client, items] of deleted.clients) {
      const end = cut.get(client);
      if (!end) continue;
      const within = items.filter((item) => item.clock < end).map((item) => ({ clock: item.clock, len: Math.min(item.len, end - item.clock) }));
      if (within.length) kept.clients.set(client, within as typeof items);
    }
    Y.createDocFromSnapshot(full, Y.createSnapshot(kept, cut), base);
    if (base.store.pendingStructs !== null || base.store.pendingDs !== null) throw new StaleBase('the base is not a state of the doc');
    return Y.encodeStateAsUpdate(base);
  } finally {
    full.destroy();
    base.destroy();
  }
}

/**
 * Countable content in `doc` that clients made after `from` (up to `until`) and that is visible: neither deleted nor
 * inside a deleted parent. `maps` counts map entries too (a compound payload's keys); a body's element attributes are not.
 */
export function shownSince(doc: Y.Doc, from: StateVector, until: StateVector, maps: boolean): number {
  let count = 0;
  const visit = (item: Y.Item, shown: boolean): void => {
    const visible = shown && !item.deleted;
    if (visible && item.countable) {
      const start = Math.max(item.id.clock, from.get(item.id.client) ?? 0);
      const end = Math.min(item.id.clock + item.length, until.get(item.id.client) ?? 0);
      if (end > start) count += end - start;
    }
    if (item.content instanceof Y.ContentType) walk(item.content.type, visible);
  };
  const walk = (type: { _start: Y.Item | null; _map: Map<string, Y.Item> }, shown: boolean): void => {
    for (let item = type._start; item; item = item.right) visit(item, shown);
    if (maps) for (const item of type._map.values()) visit(item, shown);
  };
  for (const type of doc.share.values()) walk(type, true);
  return count;
}

/** The payload ids that visible elements of `state` name. */
export function namedPayloads(state: Uint8Array): Set<string> {
  const doc = new Y.Doc();
  const named = new Set<string>();
  const walk = (type: { _start: Y.Item | null }): void => {
    for (let item = type._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentType)) continue;
      const child = item.content.type;
      if (child instanceof Y.XmlElement) {
        const id: unknown = child.getAttribute('__regId');
        if (isPayloadType(String(child.getAttribute('__type'))) && typeof id === 'string' && id) named.add(id);
      }
      walk(child);
    }
  };
  try {
    Y.applyUpdate(doc, state);
    for (const type of doc.share.values()) walk(type);
    return named;
  } finally {
    doc.destroy();
  }
}

/** Countable content in `state` made after `from` that is visible. */
export function shownAfter(state: Uint8Array, from: StateVector): number {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return shownSince(doc, from, stateOf(doc), true);
  } finally {
    doc.destroy();
  }
}

/** Whether applying `diff` to `state` keeps every insert made after `from` visible. */
export function keepsInserts(state: Uint8Array, diff: Uint8Array, from: StateVector, maps: boolean): boolean {
  const before = new Y.Doc();
  const after = new Y.Doc();
  try {
    Y.applyUpdate(before, state);
    const until = stateOf(before);
    const shown = shownSince(before, from, until, maps);
    if (shown === 0) return true;
    Y.applyUpdate(after, state);
    Y.applyUpdate(after, diff);
    return shownSince(after, from, until, maps) === shown;
  } finally {
    before.destroy();
    after.destroy();
  }
}

/** The state vector of an update. */
export const stateVectorOf = (update: Uint8Array): StateVector => Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update));

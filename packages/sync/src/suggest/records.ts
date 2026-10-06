// Suggestion records in `Y.Map('suggestions')` (docs/design/suggestions.md §1). Only the DocDO writes them, under
// SUGGESTIONS_ORIGIN and, once a SuggestionsWriter is bound, under its reserved Yjs client id S, so no client frame
// can reach the map (I2). A record's ops are stored and never applied to the body except by accept.
import * as Y from 'yjs';
import type { DeletePart, RecordMeta, RecordOp, SuggestionRecord } from '@moss-multi/core/suggest/apply';

export const SUGGESTIONS = 'suggestions';
export const SUGGESTIONS_ORIGIN = 'server-suggestions';
export const SUGGEST_ACCEPT = 'suggest-accept';

type Decoded = ReturnType<typeof Y.decodeUpdate>;

/**
 * The one writer of `suggestions`. Every write runs under the reserved client S; a client frame is refused if it
 * carries an S struct, names S as an origin, right origin or parent, names any item inside the map (tombstones included),
 * uses `suggestions` as a string parent, or deletes a live S item. A non-S item can then never land in the map (the comments.md §2 argument), and the check is
 * O(frame · log n): the live S clocks are kept sorted.
 */
export class SuggestionsWriter {
  #live: number[] = [];

  constructor(
    readonly doc: Y.Doc,
    readonly client: number,
  ) {
    if (doc.clientID === client) throw new Error('the doc writes as S');
    for (const struct of doc.store.clients.get(client) ?? []) {
      if (struct instanceof Y.Item && !struct.deleted) for (let i = 0; i < struct.length; i += 1) this.#live.push(struct.id.clock + i);
    }
    // Any transaction that deletes an S item, whoever runs it, drops those clocks.
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      for (const { clock, len } of txn.deleteSet.clients.get(client) ?? []) this.#drop(clock, clock + len);
    });
    writers.set(doc, this);
  }

  write(fn: () => void): void {
    const own = this.doc.clientID;
    const before = Y.getState(this.doc.store, this.client);
    this.doc.clientID = this.client;
    try {
      this.doc.transact(fn, SUGGESTIONS_ORIGIN);
    } finally {
      this.doc.clientID = own;
    }
    const after = Y.getState(this.doc.store, this.client);
    for (let clock = before; clock < after; clock += 1) {
      const struct = Y.getItem(this.doc.store, Y.createID(this.client, clock));
      if (struct instanceof Y.Item && !struct.deleted) this.#live.push(clock);
    }
  }

  /** True when a client frame would touch `suggestions`. */
  touches({ structs, ds }: Decoded): boolean {
    const s = this.client;
    for (const struct of structs) {
      if (struct.id.client === s) return true;
      if (!(struct instanceof Y.Item)) continue;
      if (struct.origin?.client === s || struct.rightOrigin?.client === s) return true;
      const parent = struct.parent as unknown;
      if (parent === SUGGESTIONS || (parent instanceof Y.ID && parent.client === s)) return true;
      // Yjs takes a parent from the origin or the parent item: any of them in the map, live or a tombstone another
      // client wrote (a duplicate copies the source's), lands the item there.
      if (this.#inMap(struct.origin) || this.#inMap(struct.rightOrigin) || (parent instanceof Y.ID && this.#inMap(parent))) return true;
    }
    for (const { clock, len } of ds.clients.get(s) ?? []) if (this.#coversLive(clock, clock + len)) return true;
    return false;
  }

  /** True when `id` names a stored item inside `suggestions`, deleted or not; O(log n). */
  #inMap(id: Y.ID | null): boolean {
    if (!id || id.clock >= Y.getState(this.doc.store, id.client)) return false;
    const item = Y.getItem(this.doc.store, id);
    if (!(item instanceof Y.Item)) return false;
    const map = this.doc.share.get(SUGGESTIONS);
    // Only the server nests in the map, a few levels deep; a deeper chain is the body.
    let type: unknown = item.parent;
    for (let depth = 0; depth < 8 && type instanceof Y.AbstractType; depth += 1) {
      if (type === map) return true;
      type = type._item?.parent;
    }
    return false;
  }

  #lower(clock: number): number {
    let lo = 0;
    let hi = this.#live.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.#live[mid] < clock) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  #coversLive(from: number, to: number): boolean {
    const at = this.#lower(from);
    return at < this.#live.length && this.#live[at] < to;
  }

  #drop(from: number, to: number): void {
    const lo = this.#lower(from);
    const hi = this.#lower(to);
    if (hi > lo) this.#live.splice(lo, hi - lo);
  }
}

const writers = new WeakMap<Y.Doc, SuggestionsWriter>();
const closedListeners = new WeakMap<Y.Doc, Set<(id: string, meta: RecordMeta) => void>>();

/** Hears every record `closeRecord` closes, in the same turn. */
export function onRecordClosed(doc: Y.Doc, listener: (id: string, meta: RecordMeta) => void): () => void {
  const listeners = closedListeners.get(doc) ?? new Set();
  closedListeners.set(doc, listeners);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A fresh id for S: not the doc's own, and not one any struct already uses. */
export function newSuggestionsClient(doc: Y.Doc): number {
  for (;;) {
    const id = crypto.getRandomValues(new Uint32Array(1))[0];
    if (id !== 0 && id !== doc.clientID && !doc.store.clients.has(id)) return id;
  }
}

export function suggestionsWriter(doc: Y.Doc): SuggestionsWriter | null {
  return writers.get(doc) ?? null;
}

/** One server transaction on the records: under S once a writer is bound (the DocDO), else under the doc's id. */
export function writeSuggestions(doc: Y.Doc, fn: () => void): void {
  const writer = writers.get(doc);
  if (writer) writer.write(fn);
  else doc.transact(fn, SUGGESTIONS_ORIGIN);
}

const recordMap = (doc: Y.Doc, id: string): Y.Map<unknown> | null => {
  const value = doc.getMap(SUGGESTIONS).get(id);
  return value instanceof Y.Map ? value : null;
};

export function readMeta(doc: Y.Doc, id: string): RecordMeta | null {
  const meta = recordMap(doc, id)?.get('meta');
  return typeof meta === 'string' ? (JSON.parse(meta) as RecordMeta) : null;
}

/** The length of a record's stored meta JSON; 0 when there is none. O(1). */
export function metaBytes(doc: Y.Doc, id: string): number {
  const meta = recordMap(doc, id)?.get('meta');
  return typeof meta === 'string' ? meta.length : 0;
}

export function readRecord(doc: Y.Doc, id: string): SuggestionRecord | null {
  const map = recordMap(doc, id);
  const meta = readMeta(doc, id);
  if (!map || !meta) return null;
  const ops = map.get('ops');
  const parts = map.get('parts');
  return {
    meta,
    ops: ops instanceof Y.Array ? (ops.toArray() as RecordOp[]) : [],
    parts: parts instanceof Y.Array ? (parts.toArray() as DeletePart[]) : [],
  };
}

export function recordIds(doc: Y.Doc): string[] {
  return [...doc.getMap(SUGGESTIONS).keys()];
}

/** Call inside writeSuggestions. */
export function createRecord(doc: Y.Doc, meta: RecordMeta): void {
  const map = new Y.Map<unknown>();
  doc.getMap(SUGGESTIONS).set(meta.id, map);
  map.set('meta', JSON.stringify(meta));
  map.set('ops', new Y.Array<RecordOp>());
  map.set('parts', new Y.Array<DeletePart>());
}

/** Call inside writeSuggestions. */
export function patchMeta(doc: Y.Doc, id: string, patch: Partial<RecordMeta>): RecordMeta {
  const map = recordMap(doc, id);
  const meta = readMeta(doc, id);
  if (!map || !meta) throw new Error(`no suggestion ${id}`);
  const next = { ...meta, ...patch };
  map.set('meta', JSON.stringify(next));
  return next;
}

/** Each op: `{doc, update}`, the doc `'body'` or a payload id. */
export function opsOf(doc: Y.Doc, id: string): Y.Array<RecordOp> {
  return recordMap(doc, id)!.get('ops') as Y.Array<RecordOp>;
}

export function partsOf(doc: Y.Doc, id: string): Y.Array<DeletePart> {
  return recordMap(doc, id)!.get('parts') as Y.Array<DeletePart>;
}

/**
 * Closes a record: the status, who and when, and its ops and parts cleared, in one server transaction. The ingest
 * hears of it in the same turn (an accepted record's leases are spent, design §4.3).
 */
export function closeRecord(doc: Y.Doc, id: string, patch: Partial<RecordMeta>): void {
  let meta: RecordMeta | null = null;
  writeSuggestions(doc, () => {
    meta = patchMeta(doc, id, patch);
    const ops = opsOf(doc, id);
    const parts = partsOf(doc, id);
    ops.delete(0, ops.length);
    parts.delete(0, parts.length);
  });
  const closed = meta as RecordMeta | null;
  if (closed) for (const listener of closedListeners.get(doc) ?? []) listener(id, closed);
}

// The DocDO's payload docs (A§10.10; docs/design/registers.md rules 5, 6, 8 and 10), Yjs-level with no Lexical. Each
// code, HTML or formula payload is a Y.Doc keyed by its block's `__regId`, stored in its own SQLite rows. The naming
// index (id → the live elements that name it) is kept from each note transaction's own structs, so its cost is the
// transaction. A payload no live element names is withheld: its updates are stored and acked, never fanned out or
// answered, and when an element names it again its whole state is sent to every socket.
import * as Y from 'yjs';
import { PAYLOAD_LOADED, REGISTER_FIELDS } from './payload-docs.ts';

/** The janitor's note writes (dedupe, migration): no client tracks them, and the index records no change for them. */
export const JANITOR = 'payload-janitor';

/** A payload unnamed this long is dropped, as trash is (A§5.1). */
export const PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Per-payload compaction thresholds. */
const COMPACT_ROWS = 100;
const COMPACT_BYTES = 256 * 1024;
/** Rows cap at 2 MB; a larger state is stored as consecutive parts. */
const PART_BYTES = 1.5 * 1024 * 1024;

export interface PayloadWork {
  /** Ids whose elements a note transaction changed. */
  evaluated: number;
  revealed: number;
  /** Payload updates stored without fan-out. */
  withheld: number;
  deduped: number;
  compared: number;
}

/**
 * id → the live elements naming it, from each transaction's own structs: the elements it integrated (and `__regId`
 * attributes it set) and the ones it deleted, including every element inside a deleted or recreated paragraph or
 * container (Yjs deletes a subtree item by item). `take()` returns the ids changed since the last call, each with
 * whether it was named before.
 */
export class NameIndex {
  readonly live = new Map<string, Set<Y.XmlElement>>();
  readonly #ids = new WeakMap<Y.XmlElement, string>();
  #changed = new Map<string, boolean>();

  constructor(doc: Y.Doc, private readonly ignore: unknown) {
    doc.on('afterTransaction', (transaction: Y.Transaction) => this.#index(doc, transaction));
  }

  named(id: string): boolean {
    return (this.live.get(id)?.size ?? 0) > 0;
  }

  take(): Map<string, boolean> {
    const out = this.#changed;
    this.#changed = new Map();
    return out;
  }

  #index(doc: Y.Doc, transaction: Y.Transaction): void {
    const record = transaction.origin !== this.ignore;
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = doc.store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        if (!(struct instanceof Y.Item) || struct.deleted) continue;
        if (struct.content instanceof Y.ContentType && struct.content.type instanceof Y.XmlElement) {
          this.#set(struct.content.type, record);
        } else if (struct.parentSub === '__regId' && struct.parent instanceof Y.XmlElement && !struct.parent._item?.deleted) {
          this.#set(struct.parent, record);
        }
      }
    });
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (struct instanceof Y.Item && struct.content instanceof Y.ContentType && struct.content.type instanceof Y.XmlElement) {
        this.#drop(struct.content.type, record);
      }
    });
  }

  /** Files a live element under its current id (moving it if its id changed). */
  #set(element: Y.XmlElement, record: boolean): void {
    const attr: unknown = element.getAttribute('__regId');
    const id = REGISTER_FIELDS[String(element.getAttribute('__type'))] && typeof attr === 'string' && attr ? attr : undefined;
    const previous = this.#ids.get(element);
    if (previous === id) {
      if (id === undefined || this.live.get(id)?.has(element)) return;
    } else if (previous !== undefined) {
      this.#drop(element, record);
    }
    if (id === undefined) return;
    let set = this.live.get(id);
    if (!set) this.live.set(id, (set = new Set()));
    if (record && !this.#changed.has(id)) this.#changed.set(id, set.size > 0);
    set.add(element);
    this.#ids.set(element, id);
  }

  #drop(element: Y.XmlElement, record: boolean): void {
    const id = this.#ids.get(element);
    const set = id === undefined ? undefined : this.live.get(id);
    if (!set?.has(element)) return;
    if (record && !this.#changed.has(id!)) this.#changed.set(id!, true);
    set.delete(element);
    this.#ids.delete(element);
    if (!set.size) this.live.delete(id!);
  }
}

interface Meta {
  bytes: number;
  /** When it lost its last element (ms), or null while named. */
  unnamedSince: number | null;
  rows: number;
  rowBytes: number;
}

function blob(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

export interface PayloadStoreOptions {
  /** A named payload's update, to every socket (fan-out, or a reveal's whole state). */
  broadcast(id: string, update: Uint8Array, origin: unknown): void;
  /** A payload's update persisted from a connection (for its ack). */
  persisted?(id: string, update: Uint8Array, origin: unknown): void;
  /** Withheld payloads together may hold this many bytes; the oldest unnamed go first. */
  withheldCapBytes: number;
  now?: () => number;
}

/**
 * The payload docs and their private rows, `payload_updates(seq, reg_id, data, part)` plus `payload_meta(reg_id, bytes,
 * unnamed_since)`. Docs load lazily (on a frame, a step 1, a reveal or a read); each id compacts on its own.
 */
export class PayloadStore {
  readonly names: NameIndex;
  readonly work: PayloadWork = { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, compared: 0 };
  readonly #docs = new Map<string, Y.Doc>();
  readonly #meta = new Map<string, Meta>();
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  #settling = false;
  /** Stored bytes of every payload, and of the withheld ones (`unnamedSince` set), kept as they change. */
  #totalBytes = 0;
  #withheldBytes = 0;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly note: Y.Doc,
    private readonly options: PayloadStoreOptions,
  ) {
    this.#sql = storage.sql;
    this.#now = options.now ?? Date.now;
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS payload_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, reg_id TEXT NOT NULL, data BLOB NOT NULL, part INTEGER NOT NULL DEFAULT 0)',
    );
    this.#sql.exec('CREATE INDEX IF NOT EXISTS payload_updates_reg ON payload_updates (reg_id, seq)');
    this.#sql.exec('CREATE TABLE IF NOT EXISTS payload_meta (reg_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, unnamed_since INTEGER)');
    for (const row of this.#sql.exec<{ reg_id: string; bytes: number; unnamed_since: number | null }>('SELECT reg_id, bytes, unnamed_since FROM payload_meta').toArray()) {
      const meta = { bytes: Number(row.bytes), unnamedSince: row.unnamed_since === null ? null : Number(row.unnamed_since), rows: 0, rowBytes: 0 };
      this.#meta.set(row.reg_id, meta);
      this.#totalBytes += meta.bytes;
      if (meta.unnamedSince !== null) this.#withheldBytes += meta.bytes;
    }
    this.names = new NameIndex(note, JANITOR);
  }

  /** After the note's replay: forget the replay's index changes, and drop payloads unnamed past the TTL. */
  loaded(): void {
    this.names.take();
    const expired = this.#now() - PAYLOAD_TTL_MS;
    for (const [id, meta] of this.#meta) {
      if (this.names.named(id)) {
        if (meta.unnamedSince !== null) this.#setUnnamed(id, null);
      } else if (meta.unnamedSince === null) {
        this.#setUnnamed(id, this.#now());
      } else if (meta.unnamedSince < expired) {
        this.#drop(id);
      }
    }
  }

  named(id: string): boolean {
    return this.names.named(id);
  }

  has(id: string): boolean {
    return this.#meta.has(id) || this.#docs.has(id);
  }

  /** Encoded bytes of every named payload, for the state cap. */
  get namedBytes(): number {
    return this.#totalBytes - this.#withheldBytes;
  }

  bytesOf(id: string): number {
    return this.#meta.get(id)?.bytes ?? 0;
  }

  /** The payload's doc, loading its rows on first use. */
  doc(id: string): Y.Doc {
    let doc = this.#docs.get(id);
    if (doc) return doc;
    doc = new Y.Doc({ guid: id });
    let rows = 0;
    let rowBytes = 0;
    let parts: Uint8Array[] = [];
    for (const row of this.#sql.exec<{ data: ArrayBuffer; part: number }>('SELECT data, part FROM payload_updates WHERE reg_id = ? ORDER BY seq', id).toArray()) {
      const bytes = new Uint8Array(row.data);
      rows += 1;
      rowBytes += bytes.byteLength;
      parts.push(bytes);
      if (Number(row.part) === 0) {
        Y.applyUpdate(doc, parts.length === 1 ? parts[0] : concat(parts), PAYLOAD_LOADED);
        parts = [];
      }
    }
    const meta = this.#meta.get(id);
    if (meta) Object.assign(meta, { rows, rowBytes });
    doc.on('update', (update: Uint8Array, origin: unknown) => this.#updated(id, update, origin));
    this.#docs.set(id, doc);
    return doc;
  }

  /** A named payload's whole state; null while withheld or unknown (duplicates, exports, the mirror). */
  read(id: string): Uint8Array | null {
    if (!this.names.named(id) || !this.has(id)) return null;
    return Y.encodeStateAsUpdate(this.doc(id));
  }

  /** Every named payload, for a duplicate (or, later, a version). */
  namedStates(): [string, Uint8Array][] {
    const out: [string, Uint8Array][] = [];
    for (const id of this.#meta.keys()) if (this.names.named(id)) out.push([id, Y.encodeStateAsUpdate(this.doc(id))]);
    return out;
  }

  /** A server write to a payload (an import's first text, a duplicate, a migration). */
  write(id: string, update: Uint8Array, origin: unknown): void {
    Y.applyUpdate(this.doc(id), update, origin);
  }

  /**
   * After each note update: serve every payload whose id became named again, record when one lost its last element,
   * and keep one element per id. Work is the ids the update changed; a duplicate costs its copies.
   */
  settle(connected: () => boolean): void {
    if (this.#settling) return;
    this.#settling = true;
    try {
      for (const [id, wasNamed] of this.names.take()) {
        this.work.evaluated += 1;
        const live = this.names.live.get(id);
        if (!live?.size) {
          if (wasNamed && this.#meta.has(id)) this.#setUnnamed(id, this.#now());
          continue;
        }
        if (!wasNamed && this.#meta.has(id)) {
          this.#setUnnamed(id, null);
          if (connected()) {
            this.options.broadcast(id, Y.encodeStateAsUpdate(this.doc(id)), null);
            this.work.revealed += 1;
          }
        }
        if (live.size > 1) this.#dedupe(live);
      }
    } finally {
      this.#settling = false;
    }
  }

  /** Concurrent moves, or an undo racing a move, left two elements for one id: keep the lowest item id. */
  #dedupe(live: Set<Y.XmlElement>): void {
    this.work.compared += live.size;
    const [, ...extra] = [...live].sort((a, b) => a._item!.id.client - b._item!.id.client || a._item!.id.clock - b._item!.id.clock);
    this.note.transact((transaction) => {
      for (const element of extra) {
        element._item!.delete(transaction);
        // Deleting an item directly bypasses the parent's position cache.
        const parent = element.parent as Y.XmlText & { _searchMarker: { length: number } | null };
        if (parent._searchMarker) parent._searchMarker.length = 0;
        this.work.deduped += 1;
      }
    }, JANITOR);
  }

  #updated(id: string, update: Uint8Array, origin: unknown): void {
    if (origin === PAYLOAD_LOADED) return;
    this.#persist(id, update);
    this.options.persisted?.(id, update, origin);
    if (this.names.named(id)) {
      this.options.broadcast(id, update, origin);
    } else {
      this.work.withheld += 1;
      if (this.#meta.get(id)!.unnamedSince === null) this.#setUnnamed(id, this.#now());
      if (this.#withheldBytes > this.options.withheldCapBytes) this.#capWithheld();
    }
  }

  #persist(id: string, update: Uint8Array): void {
    let meta = this.#meta.get(id);
    if (!meta) {
      meta = { bytes: 0, unnamedSince: this.names.named(id) ? null : this.#now(), rows: 0, rowBytes: 0 };
      this.#meta.set(id, meta);
    }
    if (update.byteLength > PART_BYTES) {
      this.#compact(id);
      return;
    }
    this.#sql.exec('INSERT INTO payload_updates (reg_id, data, part) VALUES (?, ?, 0)', id, blob(update));
    meta.rows += 1;
    meta.rowBytes += update.byteLength;
    this.#resize(meta, meta.bytes + update.byteLength);
    if (meta.rows > COMPACT_ROWS || meta.rowBytes > COMPACT_BYTES) this.#compact(id);
    else this.#writeMeta(id, meta);
  }

  /** Swaps an id's rows for its re-encoded state, in parts under the row cap. */
  #compact(id: string): void {
    const state = Y.encodeStateAsUpdate(this.doc(id));
    const meta = this.#meta.get(id)!;
    this.storage.transactionSync(() => {
      this.#sql.exec('DELETE FROM payload_updates WHERE reg_id = ?', id);
      for (let offset = 0; offset < state.byteLength; offset += PART_BYTES) {
        const last = offset + PART_BYTES >= state.byteLength;
        this.#sql.exec('INSERT INTO payload_updates (reg_id, data, part) VALUES (?, ?, ?)', id, blob(state.subarray(offset, offset + PART_BYTES)), last ? 0 : 1);
      }
      Object.assign(meta, { rows: Math.ceil(state.byteLength / PART_BYTES), rowBytes: state.byteLength });
      this.#resize(meta, state.byteLength);
      this.#writeMeta(id, meta);
    });
  }

  #writeMeta(id: string, meta: Meta): void {
    this.#sql.exec(
      'INSERT INTO payload_meta (reg_id, bytes, unnamed_since) VALUES (?, ?, ?) ON CONFLICT(reg_id) DO UPDATE SET bytes = excluded.bytes, unnamed_since = excluded.unnamed_since',
      id, meta.bytes, meta.unnamedSince,
    );
  }

  #resize(meta: Meta, bytes: number): void {
    this.#totalBytes += bytes - meta.bytes;
    if (meta.unnamedSince !== null) this.#withheldBytes += bytes - meta.bytes;
    meta.bytes = bytes;
  }

  #setUnnamed(id: string, since: number | null): void {
    const meta = this.#meta.get(id);
    if (!meta || meta.unnamedSince === since) return;
    if (meta.unnamedSince === null) this.#withheldBytes += meta.bytes;
    else if (since === null) this.#withheldBytes -= meta.bytes;
    meta.unnamedSince = since;
    this.#writeMeta(id, meta);
  }

  /** Withheld payloads over their cap lose the oldest unnamed first; only reached past the cap. */
  #capWithheld(): void {
    const unnamed = [...this.#meta].filter(([, meta]) => meta.unnamedSince !== null);
    unnamed.sort((a, b) => a[1].unnamedSince! - b[1].unnamedSince!);
    for (const [id] of unnamed) {
      if (this.#withheldBytes <= this.options.withheldCapBytes) break;
      this.#drop(id);
    }
  }

  #drop(id: string): void {
    const meta = this.#meta.get(id);
    if (meta) {
      this.#totalBytes -= meta.bytes;
      if (meta.unnamedSince !== null) this.#withheldBytes -= meta.bytes;
    }
    this.#sql.exec('DELETE FROM payload_updates WHERE reg_id = ?', id);
    this.#sql.exec('DELETE FROM payload_meta WHERE reg_id = ?', id);
    this.#meta.delete(id);
    this.#docs.get(id)?.destroy();
    this.#docs.delete(id);
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * M1 docs kept payloads in `Y.Map('registers')`, and pre-register docs in the element's own attribute. Each becomes a
 * payload doc written by the server alone, and the map entries are deleted (GC drops their bytes). Returns whether
 * the note changed.
 */
export function migratePayloads(note: Y.Doc, write: (id: string, text: string) => void): boolean {
  const registers = note.getMap<unknown>('registers');
  const legacy: [Y.XmlElement, string, string, string][] = [];
  const visit = (type: Y.XmlText | Y.XmlElement) => {
    const attrs = type.getAttributes() as Record<string, unknown>;
    const field = REGISTER_FIELDS[String(attrs.__type)];
    if (field && !attrs.__regId && typeof attrs[field] === 'string' && type._item && type instanceof Y.XmlElement) {
      legacy.push([type, `legacy:${type._item.id.client}:${type._item.id.clock}`, field, attrs[field] as string]);
    }
    const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
    for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  visit(note.get('root', Y.XmlText));
  if (!registers.size && !legacy.length) return false;
  for (const [id, text] of registers) if (text instanceof Y.Text) write(id, text.toString());
  for (const [, id, , text] of legacy) write(id, text);
  note.transact(() => {
    for (const id of [...registers.keys()]) registers.delete(id);
    // The note keeps no payload text: the legacy field goes too.
    for (const [element, id, field] of legacy) {
      element.setAttribute('__regId', id);
      element.removeAttribute(field);
    }
  }, JANITOR);
  return true;
}

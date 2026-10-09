// The DocDO's payload docs (A§10.10; docs/design/registers.md rules 5, 6, 8 and 10), Yjs-level with no Lexical. Each
// code, HTML, formula, chart or sketch payload is a Y.Doc keyed by its block's `__regId`, stored in its own SQLite rows. The naming
// index (id → the live elements that name it) is kept from each note transaction's own structs, so its cost is the
// transaction. A payload is served (fanned out, its step 1 answered, read by duplicates and exports) only while an
// element names it and the element came from the server or from someone who could already read it; otherwise it is
// withheld: its updates are stored and acked, never sent. Knowing a payload's id never reveals it: ids are random,
// an element naming a withheld id serves it only when its author was already one of the payload's readers, and the
// server renames anyone else's element to a fresh, empty id, so nobody's later move or undo of it can reveal the text.
import * as Y from 'yjs';
import { fieldsOf, MAP_REGISTERS } from './map-codecs.ts';
import { isPayloadType, newPayloadId, PAYLOAD_LOADED, REGISTER_FIELDS } from './payload-docs.ts';

/** The janitor's note writes (dedupe, migration): no client tracks them, and the index records no change for them. */
export const JANITOR = 'payload-janitor';

/** A payload unnamed this long is dropped, as trash is (A§5.1). */
export const PAYLOAD_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Payload docs held in memory at once; the least recently used unload (their rows stay). */
export const PAYLOAD_DOCS_HELD = 256;
/** Per-payload compaction thresholds. */
const COMPACT_ROWS = 100;
export const COMPACT_BYTES = 256 * 1024;
/** Rows cap at 2 MB; a larger state is stored as consecutive parts. */
const PART_BYTES = 1.5 * 1024 * 1024;

export interface PayloadWork {
  /** Ids whose elements a note transaction changed. */
  evaluated: number;
  revealed: number;
  /** Payload updates stored without fan-out. */
  withheld: number;
  deduped: number;
  /** Elements that named a withheld payload they could not read, pointed at fresh ids. */
  renamed: number;
  compared: number;
  /** Payload docs held in memory now. */
  held: number;
}

/** A changed id: the elements naming it that the batch added, each with its transaction's origin. */
interface Change {
  added: Map<Y.XmlElement, unknown>;
}

/**
 * id → the live elements naming it, from each transaction's own structs: the elements it integrated (and the `__regId`
 * and `__type` attributes it set or removed) and the ones it deleted, including every element inside a deleted or
 * recreated paragraph or container (Yjs deletes a subtree item by item). `take()` returns the ids changed since the
 * last call.
 */
export class NameIndex {
  readonly live = new Map<string, Set<Y.XmlElement>>();
  readonly #ids = new WeakMap<Y.XmlElement, string>();
  #changed = new Map<string, Change>();

  constructor(doc: Y.Doc, private readonly ignore: unknown) {
    doc.on('afterTransaction', (transaction: Y.Transaction) => this.#index(doc, transaction));
  }

  named(id: string): boolean {
    return (this.live.get(id)?.size ?? 0) > 0;
  }

  take(): Map<string, Change> {
    const out = this.#changed;
    this.#changed = new Map();
    return out;
  }

  #index(doc: Y.Doc, transaction: Y.Transaction): void {
    const origin = transaction.origin;
    const record = origin !== this.ignore;
    transaction.afterState.forEach((after, client) => {
      const before = transaction.beforeState.get(client) ?? 0;
      if (after === before) return;
      const structs = doc.store.clients.get(client) ?? [];
      for (let i = Y.findIndexSS(structs, before); i < structs.length; i++) {
        const struct = structs[i];
        if (!(struct instanceof Y.Item) || struct.deleted) continue;
        if (struct.content instanceof Y.ContentType && struct.content.type instanceof Y.XmlElement) {
          this.#set(struct.content.type, record, origin);
        } else if (naming(struct)) {
          this.#set(struct.parent as Y.XmlElement, record, origin);
        }
      }
    });
    Y.iterateDeletedStructs(transaction, transaction.deleteSet, (struct) => {
      if (!(struct instanceof Y.Item)) return;
      if (struct.content instanceof Y.ContentType && struct.content.type instanceof Y.XmlElement) {
        this.#drop(struct.content.type, record);
      } else if (naming(struct)) {
        // A removed `__regId` or `__type` (a replaced one is also re-filed above, to the same effect).
        this.#set(struct.parent as Y.XmlElement, record, origin);
      }
    });
  }

  #note(id: string, record: boolean): Change | undefined {
    if (!record) return undefined;
    let change = this.#changed.get(id);
    if (!change) this.#changed.set(id, (change = { added: new Map() }));
    return change;
  }

  /** Files a live element under its current id (moving it if its id changed). */
  #set(element: Y.XmlElement, record: boolean, origin: unknown): void {
    const attr: unknown = element.getAttribute('__regId');
    const id = isPayloadType(String(element.getAttribute('__type'))) && typeof attr === 'string' && attr ? attr : undefined;
    const previous = this.#ids.get(element);
    if (previous === id) {
      if (id === undefined || this.live.get(id)?.has(element)) return;
    } else if (previous !== undefined) {
      this.#drop(element, record);
    }
    if (id === undefined) return;
    let set = this.live.get(id);
    if (!set) this.live.set(id, (set = new Set()));
    this.#note(id, record)?.added.set(element, origin);
    set.add(element);
    this.#ids.set(element, id);
  }

  #drop(element: Y.XmlElement, record: boolean): void {
    const id = this.#ids.get(element);
    const set = id === undefined ? undefined : this.live.get(id);
    if (!set?.has(element)) return;
    this.#note(id!, record);
    set.delete(element);
    this.#ids.delete(element);
    if (!set.size) this.live.delete(id!);
  }
}

/** An attribute item that decides what a live element names: its `__regId` or its `__type`. */
function naming(struct: Y.Item): boolean {
  return (struct.parentSub === '__regId' || struct.parentSub === '__type') && struct.parent instanceof Y.XmlElement && !struct.parent._item?.deleted;
}

interface Meta {
  bytes: number;
  /** Since when it has been withheld (ms): unnamed, or named only by an element its readers did not make. */
  withheldSince: number | null;
  rows: number;
  rowBytes: number;
}

function blob(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

export interface PayloadStoreOptions {
  /** A served payload's update to every socket but `origin`'s (fan-out, or a reveal's whole state). */
  broadcast(id: string, update: Uint8Array, origin: unknown): void;
  /** A payload's update was persisted. */
  persisted?(id: string, update: Uint8Array, origin: unknown): void;
  /** The principal behind a transaction origin (a connection); null for the server's own writes. */
  principalOf(origin: unknown): string | null;
  now?: () => number;
}

/**
 * The payload docs and their private rows: `payload_updates(seq, reg_id, data, part)`, `payload_meta(reg_id, bytes,
 * withheld_since)` and `payload_readers(reg_id, principal)`, the principals that have been sent or have written a
 * payload. Docs load lazily (on a frame, a step 1, a reveal or a read), the least recently used unload, and each id
 * compacts on its own.
 */
export class PayloadStore {
  readonly names: NameIndex;
  readonly work: PayloadWork = { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, renamed: 0, compared: 0, held: 0 };
  /** Insertion order is recency: the first entry is the least recently used. */
  readonly #docs = new Map<string, Y.Doc>();
  readonly #readers = new Map<string, Set<string>>();
  readonly #meta = new Map<string, Meta>();
  readonly #sql: SqlStorage;
  readonly #now: () => number;
  #settling = false;
  /** Stored bytes of every payload, kept as they change. */
  #totalBytes = 0;
  /**
   * Bytes each principal wrote into payloads while they were withheld, counted while the payload is withheld: a reveal
   * stops counting them and withholding it again counts them again; a drop forgets them. Kept in `payload_withheld`
   * too, so neither a wake nor a reveal resets anyone's allowance.
   */
  readonly #byIdentity = new Map<string, number>();
  readonly #attributed = new Map<string, Map<string, number>>();

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
    this.#sql.exec('CREATE TABLE IF NOT EXISTS payload_meta (reg_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, withheld_since INTEGER)');
    this.#sql.exec('CREATE TABLE IF NOT EXISTS payload_readers (reg_id TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (reg_id, principal))');
    this.#sql.exec(
      'CREATE TABLE IF NOT EXISTS payload_withheld (reg_id TEXT NOT NULL, principal TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (reg_id, principal))',
    );
    for (const row of this.#sql.exec<{ reg_id: string; bytes: number; withheld_since: number | null }>('SELECT reg_id, bytes, withheld_since FROM payload_meta').toArray()) {
      const meta = { bytes: Number(row.bytes), withheldSince: row.withheld_since === null ? null : Number(row.withheld_since), rows: 0, rowBytes: 0 };
      this.#meta.set(row.reg_id, meta);
      this.#totalBytes += meta.bytes;
    }
    for (const row of this.#sql.exec<{ reg_id: string; principal: string; bytes: number }>('SELECT reg_id, principal, bytes FROM payload_withheld').toArray()) {
      this.#attribute(row.reg_id, row.principal, Number(row.bytes));
    }
    this.names = new NameIndex(note, JANITOR);
  }

  /**
   * After the note's replay: forget the replay's index changes, withhold any stored payload no element names, and drop
   * the ones withheld past the TTL. A named payload keeps its persisted state (served, or withheld from a forged name).
   */
  loaded(): void {
    this.names.take();
    const expired = this.#now() - PAYLOAD_TTL_MS;
    for (const [id, meta] of this.#meta) {
      if (this.names.named(id)) continue;
      if (meta.withheldSince === null) this.#withhold(id, this.#now());
      else if (meta.withheldSince < expired) this.#drop(id);
    }
  }

  /** Named, and not withheld: its updates fan out and its step 1 is answered. */
  served(id: string): boolean {
    return this.names.named(id) && (this.#meta.get(id)?.withheldSince ?? null) === null;
  }

  has(id: string): boolean {
    return this.#meta.has(id) || this.#docs.has(id);
  }

  /** Encoded bytes of every stored payload, named or withheld, for the state cap. */
  get totalBytes(): number {
    return this.#totalBytes;
  }

  bytesOf(id: string): number {
    return this.#meta.get(id)?.bytes ?? 0;
  }

  /** Bytes `principal` has written into withheld payloads (capped per identity, so nobody crowds out another). */
  withheldBy(principal: string): number {
    return this.#byIdentity.get(principal) ?? 0;
  }

  isReader(id: string, principal: string): boolean {
    return this.#readersOf(id).has(principal);
  }

  /** Records principals that were sent or wrote payload `id`. */
  addReaders(id: string, principals: Iterable<string>): void {
    const readers = this.#readersOf(id);
    for (const principal of principals) {
      if (readers.has(principal)) continue;
      readers.add(principal);
      this.#sql.exec('INSERT OR IGNORE INTO payload_readers (reg_id, principal) VALUES (?, ?)', id, principal);
    }
  }

  #readersOf(id: string): Set<string> {
    let readers = this.#readers.get(id);
    if (!readers) {
      readers = new Set(this.#sql.exec<{ principal: string }>('SELECT principal FROM payload_readers WHERE reg_id = ?', id).toArray().map((row) => row.principal));
      this.#readers.set(id, readers);
    }
    return readers;
  }

  /** The payload's doc, loading its rows on first use; the least recently used unload past PAYLOAD_DOCS_HELD. */
  doc(id: string): Y.Doc {
    let doc = this.#docs.get(id);
    if (doc) {
      this.#docs.delete(id);
      this.#docs.set(id, doc);
      return doc;
    }
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
    for (const [held, loaded] of this.#docs) {
      if (this.#docs.size <= PAYLOAD_DOCS_HELD) break;
      if (held === id) continue;
      loaded.destroy();
      this.#docs.delete(held);
      this.#readers.delete(held);
    }
    this.work.held = this.#docs.size;
    return doc;
  }

  /** A served payload's whole state; null while withheld or unknown (duplicates, exports, the mirror). */
  read(id: string): Uint8Array | null {
    if (!this.served(id) || !this.has(id)) return null;
    return Y.encodeStateAsUpdate(this.doc(id));
  }

  /** Every served payload, for a duplicate (or, later, a version). */
  servedStates(): [string, Uint8Array][] {
    const out: [string, Uint8Array][] = [];
    for (const id of this.#meta.keys()) if (this.served(id)) out.push([id, Y.encodeStateAsUpdate(this.doc(id))]);
    return out;
  }

  /** A write to a payload: a connection's frame (`origin` the connection) or the server's own. */
  write(id: string, update: Uint8Array, origin: unknown): void {
    Y.applyUpdate(this.doc(id), update, origin);
  }

  /**
   * After each note update, for the ids it changed: withhold a payload that lost its last element. An element naming a
   * withheld payload serves it again if the server or one of its readers made that element (its whole state goes to
   * every socket); anyone else's element is renamed to a fresh, empty id. Whoever makes an element naming a served or
   * new payload becomes one of its readers (they can ask for it anyway), so a block's creator may type into it after a
   * peer deletes it. Keep one element per id. Work is the ids the update touched; a duplicate costs its copies.
   */
  settle(connected: () => boolean): void {
    if (this.#settling) return;
    this.#settling = true;
    try {
      for (const [id, { added }] of this.names.take()) {
        this.work.evaluated += 1;
        const live = this.names.live.get(id);
        const meta = this.#meta.get(id);
        if (!live?.size) {
          if (meta && meta.withheldSince === null) this.#withhold(id, this.#now());
          continue;
        }
        const authors: [Y.XmlElement, string | null][] = [];
        for (const [element, origin] of added) if (live.has(element)) authors.push([element, this.options.principalOf(origin)]);
        if (meta && meta.withheldSince !== null) {
          const forged = authors.filter(([, principal]) => principal !== null && !this.isReader(id, principal)).map(([element]) => element);
          if (forged.length) this.#rename(forged);
          if (authors.length > forged.length) {
            this.#serve(id);
            if (connected()) {
              this.options.broadcast(id, Y.encodeStateAsUpdate(this.doc(id)), null);
              this.work.revealed += 1;
            }
          }
        } else {
          this.addReaders(id, authors.flatMap(([, principal]) => (principal === null ? [] : [principal])));
        }
        if (live.size > 1) this.#dedupe(live);
      }
    } finally {
      this.#settling = false;
    }
  }

  /** Points elements that named a withheld payload without being able to read it at fresh, empty payloads. */
  #rename(elements: Y.XmlElement[]): void {
    this.note.transact(() => {
      for (const element of elements) element.setAttribute('__regId', newPayloadId());
    }, JANITOR);
    this.work.renamed += elements.length;
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
    if (this.served(id)) {
      this.options.broadcast(id, update, origin);
      return;
    }
    this.work.withheld += 1;
    const principal = this.options.principalOf(origin);
    if (principal === null) return;
    this.#attribute(id, principal, update.byteLength);
    this.#sql.exec(
      'INSERT INTO payload_withheld (reg_id, principal, bytes) VALUES (?, ?, ?) ON CONFLICT(reg_id, principal) DO UPDATE SET bytes = bytes + excluded.bytes',
      id, principal, update.byteLength,
    );
  }

  #attribute(id: string, principal: string, bytes: number): void {
    let attributed = this.#attributed.get(id);
    if (!attributed) this.#attributed.set(id, (attributed = new Map()));
    attributed.set(principal, (attributed.get(principal) ?? 0) + bytes);
    if ((this.#meta.get(id)?.withheldSince ?? null) !== null) this.#byIdentity.set(principal, this.withheldBy(principal) + bytes);
  }

  /** Counts (or stops counting) a payload's attributed bytes against its writers. */
  #count(id: string, sign: 1 | -1): void {
    for (const [principal, bytes] of this.#attributed.get(id) ?? []) this.#byIdentity.set(principal, this.withheldBy(principal) + sign * bytes);
  }

  #persist(id: string, update: Uint8Array): void {
    let meta = this.#meta.get(id);
    if (!meta) {
      // A new payload is withheld until an element names it (a first text can arrive before its element).
      meta = { bytes: 0, withheldSince: this.names.named(id) ? null : this.#now(), rows: 0, rowBytes: 0 };
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
      'INSERT INTO payload_meta (reg_id, bytes, withheld_since) VALUES (?, ?, ?) ON CONFLICT(reg_id) DO UPDATE SET bytes = excluded.bytes, withheld_since = excluded.withheld_since',
      id, meta.bytes, meta.withheldSince,
    );
  }

  #resize(meta: Meta, bytes: number): void {
    this.#totalBytes += bytes - meta.bytes;
    meta.bytes = bytes;
  }

  #withhold(id: string, since: number): void {
    const meta = this.#meta.get(id)!;
    if (meta.withheldSince !== null) return;
    meta.withheldSince = since;
    this.#writeMeta(id, meta);
    this.#count(id, 1);
  }

  #serve(id: string): void {
    const meta = this.#meta.get(id)!;
    if (meta.withheldSince === null) return;
    meta.withheldSince = null;
    this.#writeMeta(id, meta);
    this.#count(id, -1);
  }

  #drop(id: string): void {
    const meta = this.#meta.get(id);
    this.#totalBytes -= meta?.bytes ?? 0;
    if (meta && meta.withheldSince !== null) this.#count(id, -1);
    this.#attributed.delete(id);
    this.#sql.exec('DELETE FROM payload_withheld WHERE reg_id = ?', id);
    this.#sql.exec('DELETE FROM payload_updates WHERE reg_id = ?', id);
    this.#sql.exec('DELETE FROM payload_meta WHERE reg_id = ?', id);
    this.#sql.exec('DELETE FROM payload_readers WHERE reg_id = ?', id);
    this.#meta.delete(id);
    this.#readers.delete(id);
    this.#docs.get(id)?.destroy();
    this.#docs.delete(id);
    this.work.held = this.#docs.size;
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

/** A payload's first value: text, or a compound payload's encoded keys. */
export type PayloadSeed = string | Map<string, unknown>;

/**
 * M1 docs kept payloads in `Y.Map('registers')` (a chart's or sketch's as a nested Y.Map), and pre-register docs in the
 * element's own attributes. Each becomes a payload doc written by the server alone, under a fresh random id (an M1 id
 * may be a guessable import id), and the map entries and legacy attributes are deleted (GC drops their bytes).
 * Returns whether the note changed.
 */
export function migratePayloads(note: Y.Doc, write: (id: string, value: PayloadSeed) => void): boolean {
  const registers = note.getMap<unknown>('registers');
  const naming = new Map<string, Y.XmlElement[]>();
  const legacy: [Y.XmlElement, string[], PayloadSeed, string | null][] = [];
  const visit = (type: Y.XmlText | Y.XmlElement) => {
    const attrs = type.getAttributes() as Record<string, unknown>;
    const kind = String(attrs.__type);
    if (isPayloadType(kind) && type instanceof Y.XmlElement) {
      const id = typeof attrs.__regId === 'string' && attrs.__regId ? attrs.__regId : null;
      if (id) {
        const list = naming.get(id);
        if (list) list.push(type); else naming.set(id, [type]);
      }
      // M1 set an id and kept the attribute, so an element may carry both; its register is the newer value.
      const field = REGISTER_FIELDS[kind];
      const codec = MAP_REGISTERS[kind];
      if (field && typeof attrs[field] === 'string') legacy.push([type, [field], attrs[field] as string, id]);
      else if (codec) {
        const fields = codec.fields.filter(name => attrs[name] !== undefined);
        if (fields.length) legacy.push([type, fields, codec.encode(fieldsOf(attrs, codec)), id]);
      }
    }
    const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
    for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) visit(child);
  };
  visit(note.get('root', Y.XmlText));
  if (!registers.size && !legacy.length) return false;
  const renamed: [Y.XmlElement, string][] = [];
  const values: [string, PayloadSeed][] = [];
  const isRegister = (value: unknown) => value instanceof Y.Text || value instanceof Y.Map;
  for (const [old, value] of registers) {
    if (!isRegister(value)) continue;
    const id = newPayloadId();
    values.push([id, value instanceof Y.Text ? value.toString() : new Map((value as Y.Map<unknown>).entries())]);
    for (const element of naming.get(old) ?? []) renamed.push([element, id]);
  }
  const fields: [Y.XmlElement, string][] = [];
  for (const [element, names, value, old] of legacy) {
    for (const name of names) fields.push([element, name]);
    if (old !== null && isRegister(registers.get(old))) continue;
    const id = newPayloadId();
    values.push([id, value]);
    renamed.push([element, id]);
  }
  // Renamed first, so a payload an element names is written as named; an orphan entry stays withheld.
  note.transact(() => {
    for (const key of [...registers.keys()]) registers.delete(key);
    for (const [element, id] of renamed) element.setAttribute('__regId', id);
    // The note keeps no payload value: the legacy fields go too.
    for (const [element, field] of fields) element.removeAttribute(field);
  }, JANITOR);
  for (const [id, value] of values) write(id, value);
  return true;
}

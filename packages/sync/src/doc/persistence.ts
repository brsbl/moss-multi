// DocDO persistence (A§5.1): every update is its own yupdates row; compaction re-encodes the live doc, which keeps
// item identity, into ystate chunks under the 2 MB row cap; meta holds flags and stateBytes; revocations are
// durable so a woken DO already knows them.
import * as Y from 'yjs';
import type { DeleteSet } from './admission.ts';

/** The origin of everything replayed from storage; it is never persisted again. */
export const PERSISTENCE = 'persistence';

export const COMPACT_MAX_ROWS = 500;
export const COMPACT_MAX_BYTES = 1024 * 1024;
export const STATE_CHUNK_BYTES = 1.5 * 1024 * 1024;

export type RevocationKind = 'token' | 'session' | 'principal';
export type Revoked = Record<RevocationKind, Set<string>>;

/** workerd binds BLOBs from an ArrayBuffer of exactly the value's bytes. */
function blob(bytes: Uint8Array): ArrayBuffer {
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return (whole ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class DocStore {
  private readonly sql: SqlStorage;
  private rows = 0;
  private bytes = 0;
  /** The encoded doc state: exact at load and at each compaction, plus each update's bytes in between. */
  stateBytes = 0;
  readonly revoked: Revoked = { token: new Set(), session: new Set(), principal: new Set() };

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS yupdates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS ystate (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS revocations (kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id))',
    );
    this.sql.exec('CREATE TABLE IF NOT EXISTS media (filename TEXT PRIMARY KEY)');
  }

  /** The folder files an upload, copy or carry placed in the doc (A§16), by stored name. */
  media(): string[] {
    return this.sql.exec<{ filename: string }>('SELECT filename FROM media').toArray().map((row) => row.filename);
  }

  hasMedia(filename: string): boolean {
    return this.sql.exec('SELECT 1 FROM media WHERE filename = ?', filename).toArray().length > 0;
  }

  addMedia(filenames: Iterable<string>): void {
    for (const filename of filenames) this.sql.exec('INSERT OR IGNORE INTO media (filename) VALUES (?)', filename);
  }

  replaceMedia(filenames: Iterable<string>): void {
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM media');
      this.addMedia(filenames);
    });
  }

  /** Applies the state chunks in idx order, then every update row in seq order, under PERSISTENCE. */
  load(doc: Y.Doc): void {
    const chunks = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM ystate ORDER BY idx').toArray();
    if (chunks.length > 0) Y.applyUpdate(doc, concat(chunks.map((row) => new Uint8Array(row.data))), PERSISTENCE);
    const updates = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM yupdates ORDER BY seq').toArray();
    for (const row of updates) {
      const update = new Uint8Array(row.data);
      Y.applyUpdate(doc, update, PERSISTENCE);
      this.bytes += update.byteLength;
    }
    this.rows = updates.length;
    this.stateBytes = Y.encodeStateAsUpdate(doc).byteLength;
    if (this.meta('stateBytes') !== String(this.stateBytes)) this.setMeta('stateBytes', String(this.stateBytes));
    for (const row of this.sql.exec<{ kind: string; id: string }>('SELECT kind, id FROM revocations').toArray()) {
      if (row.kind in this.revoked) this.revoked[row.kind as RevocationKind].add(row.id);
    }
  }

  /**
   * Persists an update `doc` has applied: a log row, or a compaction when the log is due or the update alone would
   * pass the 2 MB row cap (a large paste or server import).
   */
  record(update: Uint8Array, doc: Y.Doc): void {
    if (update.byteLength > STATE_CHUNK_BYTES) {
      this.compact(doc);
      return;
    }
    this.sql.exec('INSERT INTO yupdates (data) VALUES (?)', blob(update));
    this.rows += 1;
    this.bytes += update.byteLength;
    this.stateBytes += update.byteLength;
    if (this.shouldCompact) this.compact(doc);
  }

  get pendingRows(): number {
    return this.rows;
  }

  get shouldCompact(): boolean {
    return this.rows > COMPACT_MAX_ROWS || this.bytes > COMPACT_MAX_BYTES;
  }

  /** Swaps the log for the re-encoded live doc in one transaction. */
  compact(doc: Y.Doc): void {
    const state = Y.encodeStateAsUpdate(doc);
    this.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM ystate');
      for (let offset = 0, idx = 0; offset < state.byteLength; offset += STATE_CHUNK_BYTES, idx += 1) {
        this.sql.exec('INSERT INTO ystate (idx, data) VALUES (?, ?)', idx, blob(state.subarray(offset, offset + STATE_CHUNK_BYTES)));
      }
      this.sql.exec('DELETE FROM yupdates');
      this.setMeta('stateBytes', String(state.byteLength));
    });
    this.rows = 0;
    this.bytes = 0;
    this.stateBytes = state.byteLength;
  }

  meta(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

/**
 * One ack per socket per window, sent when the window closes, naming the deletes the acked frames carried. Keyed by
 * the socket itself: a client may reuse its connection id while the DO still holds the old socket, whose close must
 * never cancel the new one's ack. In memory: a wake simply sends none.
 */
export class AckCoalescer<Socket extends object> {
  private readonly pending = new Map<Socket, { timer: ReturnType<typeof setTimeout>; deletes: DeleteSet[] }>();

  constructor(
    private readonly send: (socket: Socket, deletes: DeleteSet) => void,
    private readonly windowMs: number,
  ) {}

  schedule(socket: Socket, deletes?: DeleteSet): void {
    const entry = this.pending.get(socket);
    if (entry) {
      if (deletes) entry.deletes.push(deletes);
      return;
    }
    const timer = setTimeout(() => {
      const due = this.pending.get(socket);
      this.pending.delete(socket);
      this.send(socket, Y.mergeDeleteSets(due?.deletes ?? []));
    }, this.windowMs);
    this.pending.set(socket, { timer, deletes: deletes ? [deletes] : [] });
  }

  cancel(socket: Socket): void {
    const entry = this.pending.get(socket);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(socket);
  }
}

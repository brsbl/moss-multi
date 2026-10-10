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
/** Each revoked id with when it was revoked (epoch ms). */
export type Revoked = Record<RevocationKind, Map<string, number>>;

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
  #oversized = false;
  /** The encoded doc state: exact at load and at each compaction, plus each update's bytes in between. */
  stateBytes = 0;
  /** Runs after each compaction, which re-encodes the doc anyway: the suggestion share is measured afresh there. */
  onCompacted: (() => void) | null = null;
  readonly revoked: Revoked = { token: new Map(), session: new Map(), principal: new Map() };

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS yupdates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS ystate (idx INTEGER PRIMARY KEY, data BLOB NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS revocations (kind TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (kind, id))',
    );
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
    for (const row of this.sql.exec<{ kind: string; id: string; at: number }>('SELECT kind, id, at FROM revocations').toArray()) {
      if (row.kind in this.revoked) this.revoked[row.kind as RevocationKind].set(row.id, Number(row.at));
    }
  }

  /** Persists a revocation before anyone acts on it; a principal keeps its latest time (A§8). */
  revoke(kind: RevocationKind, id: string, at: number): void {
    this.sql.exec(
      'INSERT INTO revocations (kind, id, at) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET at = max(at, excluded.at)',
      kind,
      id,
      at,
    );
    this.revoked[kind].set(id, Math.max(at, this.revoked[kind].get(id) ?? at));
  }

  /**
   * Persists an update `doc` has applied as a log row. It never compacts here: the update handler runs inside the
   * transaction, before the DocDO purges what a client frame left parked, and a compaction encodes parked structs
   * (comments.md §3, I2). An update too large for one row is left to `compactIfDue`, which the DocDO runs next.
   */
  record(update: Uint8Array): void {
    if (update.byteLength > STATE_CHUNK_BYTES) {
      this.#oversized = true;
      return;
    }
    this.sql.exec('INSERT INTO yupdates (data) VALUES (?)', blob(update));
    this.rows += 1;
    this.bytes += update.byteLength;
    this.stateBytes += update.byteLength;
  }

  /** Compacts when the log is due or an update was too large for a row. Call it only with nothing parked. */
  compactIfDue(doc: Y.Doc): void {
    if (this.#oversized || this.shouldCompact) this.compact(doc);
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
    this.#oversized = false;
    this.stateBytes = state.byteLength;
    this.onCompacted?.();
  }

  meta(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key).toArray()[0]?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }
}

/**
 * One ack per socket per window, sent when the window closes, naming the deletes the acked frames carried, the note's
 * and each payload's. A payload's coverage is the clock ranges of the acked frames themselves, as far as the server
 * holds them, so an ack tells a client nothing it did not send. Keyed by the socket itself: a client may
 * reuse its connection id while the DO still holds the old socket, whose close must never cancel the new one's ack.
 * In memory: a wake simply sends none.
 */
export class AckCoalescer<Socket extends object> {
  private readonly pending = new Map<Socket, { timer: ReturnType<typeof setTimeout>; deletes: DeleteSet[]; payloads: Map<string, { sv: Map<number, number>; deletes: DeleteSet[] }> }>();

  constructor(
    private readonly send: (socket: Socket, deletes: DeleteSet, payloads: Map<string, { sv: Map<number, number>; deletes: DeleteSet }>) => void,
    private readonly windowMs: number,
  ) {}

  /** `payload` names the payload doc the acked frame wrote, and `covered` the clocks the frame put there; the note's otherwise. */
  schedule(socket: Socket, deletes?: DeleteSet, payload?: string, covered?: Map<number, number>): void {
    let entry = this.pending.get(socket);
    if (!entry) {
      const timer = setTimeout(() => {
        const due = this.pending.get(socket);
        this.pending.delete(socket);
        const payloads = new Map([...(due?.payloads ?? [])].map(([id, { sv, deletes: sets }]) => [id, { sv, deletes: Y.mergeDeleteSets(sets) }] as const));
        this.send(socket, Y.mergeDeleteSets(due?.deletes ?? []), payloads);
      }, this.windowMs);
      entry = { timer, deletes: [], payloads: new Map() };
      this.pending.set(socket, entry);
    }
    if (payload === undefined) {
      if (deletes) entry.deletes.push(deletes);
      return;
    }
    let acked = entry.payloads.get(payload);
    if (!acked) entry.payloads.set(payload, (acked = { sv: new Map(), deletes: [] }));
    if (deletes) acked.deletes.push(deletes);
    for (const [client, clock] of covered ?? []) {
      if ((acked.sv.get(client) ?? 0) < clock) acked.sv.set(client, clock);
    }
  }

  cancel(socket: Socket): void {
    const entry = this.pending.get(socket);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(socket);
  }
}

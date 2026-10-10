// Suggest-mode ingest in the DocDO (docs/design/suggestions.md §3, §14): bookkeeping, not authorization. Leases,
// record ids, `suggest-ops` on the body or a payload doc, `suggest-delete`, merge, undelete and withdraw, each O(frame):
// no call reads more than the records and leases it names, so cost never grows with the doc, its closed records or a
// continuation chain. Structs are placed against the one channel table accept uses (packages/core/src/suggest).
// Nothing here writes the body or a payload: a record's ops reach them only through an editor's accept (T5.3).
import * as Y from 'yjs';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { SUGGEST_LIMITS, type IdSpan, type LeaseGrant, type SuggestReply, type SuggestRefusal, type SuggestRequest } from '@moss-multi/protocol/suggest';
import { base64ToBytes } from '@moss-multi/protocol/sync';
import {
  BODY_DOC, channelAllows, checkStructs, contentKind, ownValue, PAYLOAD_ID, placementOf, type DeletePart, type DocKind, type Placement, type RecordMeta,
  type RecordOp,
} from '@moss-multi/core/suggest/apply';
import { payloadDocsFor } from '../payload-docs.ts';
import {
  closeRecord, createRecord, metaBytes, onRecordClosed, opsOf, partBytes, partsOf, patchMeta, readMeta, readRecord, recordBytes, recordIds, suggestionStateBytes,
  suggestionsWriter, SUGGESTIONS_ORIGIN, varUintBytes, writeSuggestions,
} from '../suggest/records.ts';

/** Who sends a suggest frame: the principal, its live role, and the connection (a server-minted nonce). */
export interface Suggester {
  id: string;
  name: string;
  role: string;
  connection: string;
}

export interface Lease {
  client: number;
  principal: string;
  /** The connection that may write with it. */
  connection: string;
  /** The record id minted with it. */
  reserved: string;
  /** The record it last wrote to; null until its first frame. */
  record: string | null;
  /** The next clock it may send in each doc it writes (`body`, or a payload id): everything below is acknowledged. */
  clocks: Record<string, number>;
  /** Its record was accepted: its body items are ordinary body text (design §4.3). */
  spent: boolean;
  /** Its connection closed. */
  expired: boolean;
  usedAt: number;
  /** The client fork it was granted to: that fork may resume it from a new socket while the old one is still open. */
  fork?: string | null;
}

/** Where leases live: DO SQLite in the DocDO (`suggest_leases`), memory in unit tests. */
export interface LeaseStore {
  get(client: number): Lease | undefined;
  put(lease: Lease): void;
  reservedFor(record: string): Lease | undefined;
  /** Unexpired leases used since `since` that hold no record yet: the ids a principal holds in reserve. */
  live(principal: string, since: number): number;
  expireConnection(connection: string): void;
  spend(record: string): void;
  rebind(from: string, into: string): void;
  /** What every stored lease holds, as the retained-state share charges it (`leaseBytes` each). */
  storedBytes(): number;
}

/** What one stored lease row is charged against the retained-state share: a fixed row plus its clocks JSON. */
const LEASE_BYTES = 128;
export const leaseBytes = (lease: Pick<Lease, 'clocks'>): number => LEASE_BYTES + JSON.stringify(lease.clocks).length;

export class MemoryLeases implements LeaseStore {
  readonly #byClient = new Map<number, Lease>();
  readonly #byReserved = new Map<string, Lease>();

  get(client: number): Lease | undefined {
    const lease = this.#byClient.get(client);
    return lease && { ...lease, clocks: { ...lease.clocks } };
  }

  put(lease: Lease): void {
    this.#byClient.set(lease.client, { ...lease, clocks: { ...lease.clocks } });
    this.#byReserved.set(lease.reserved, this.#byClient.get(lease.client)!);
  }

  reservedFor(record: string): Lease | undefined {
    const lease = this.#byReserved.get(record);
    return lease && { ...lease, clocks: { ...lease.clocks } };
  }

  live(principal: string, since: number): number {
    let count = 0;
    for (const lease of this.#byClient.values()) if (lease.principal === principal && lease.record === null && !lease.expired && lease.usedAt >= since) count += 1;
    return count;
  }

  expireConnection(connection: string): void {
    for (const lease of this.#byClient.values()) if (lease.connection === connection) lease.expired = true;
  }

  spend(record: string): void {
    for (const lease of this.#byClient.values()) if (lease.record === record) lease.spent = true;
  }

  rebind(from: string, into: string): void {
    for (const lease of this.#byClient.values()) if (lease.record === from) lease.record = into;
  }

  storedBytes(): number {
    let bytes = 0;
    for (const lease of this.#byClient.values()) bytes += leaseBytes(lease);
    return bytes;
  }
}

type Row = Record<string, ArrayBuffer | string | number | null>;

export class SqlLeases implements LeaseStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS suggest_leases (client_id INTEGER PRIMARY KEY, principal_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, reserved_id TEXT NOT NULL UNIQUE, record_id TEXT, clocks TEXT NOT NULL,
      spent INTEGER NOT NULL, expired INTEGER NOT NULL, used_at INTEGER NOT NULL, fork_id TEXT)`);
    sql.exec('CREATE INDEX IF NOT EXISTS suggest_leases_principal ON suggest_leases (principal_id, spent, expired)');
    sql.exec('CREATE INDEX IF NOT EXISTS suggest_leases_record ON suggest_leases (record_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS suggest_leases_connection ON suggest_leases (connection_id)');
  }

  #one(query: string, ...bindings: (string | number)[]): Lease | undefined {
    const row = this.sql.exec<Row>(query, ...bindings).toArray()[0];
    if (!row) return undefined;
    return {
      client: Number(row.client_id),
      principal: String(row.principal_id),
      connection: String(row.connection_id),
      reserved: String(row.reserved_id),
      record: row.record_id === null ? null : String(row.record_id),
      clocks: JSON.parse(String(row.clocks)) as Record<string, number>,
      spent: Number(row.spent) === 1,
      expired: Number(row.expired) === 1,
      usedAt: Number(row.used_at),
      fork: row.fork_id === null || row.fork_id === undefined ? null : String(row.fork_id),
    };
  }

  get(client: number): Lease | undefined {
    return this.#one('SELECT * FROM suggest_leases WHERE client_id = ?', client);
  }

  put(lease: Lease): void {
    this.sql.exec(
      `INSERT INTO suggest_leases (client_id, principal_id, connection_id, reserved_id, record_id, clocks, spent, expired, used_at, fork_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET connection_id = excluded.connection_id,
        record_id = excluded.record_id, clocks = excluded.clocks, spent = excluded.spent, expired = excluded.expired,
        used_at = excluded.used_at, fork_id = excluded.fork_id`,
      lease.client, lease.principal, lease.connection, lease.reserved, lease.record, JSON.stringify(lease.clocks), lease.spent ? 1 : 0, lease.expired ? 1 : 0,
      lease.usedAt, lease.fork ?? null,
    );
  }

  reservedFor(record: string): Lease | undefined {
    return this.#one('SELECT * FROM suggest_leases WHERE reserved_id = ?', record);
  }

  live(principal: string, since: number): number {
    const row = this.sql.exec<Row>(
      'SELECT COUNT(*) AS n FROM suggest_leases WHERE principal_id = ? AND record_id IS NULL AND expired = 0 AND used_at >= ?', principal, since,
    ).toArray()[0];
    return Number(row?.n ?? 0);
  }

  expireConnection(connection: string): void {
    this.sql.exec('UPDATE suggest_leases SET expired = 1 WHERE connection_id = ?', connection);
  }

  spend(record: string): void {
    this.sql.exec('UPDATE suggest_leases SET spent = 1 WHERE record_id = ?', record);
  }

  rebind(from: string, into: string): void {
    this.sql.exec('UPDATE suggest_leases SET record_id = ? WHERE record_id = ?', into, from);
  }

  storedBytes(): number {
    return Number(this.sql.exec<Row>('SELECT COALESCE(SUM(? + LENGTH(clocks)), 0) AS n FROM suggest_leases', LEASE_BYTES).toArray()[0]?.n ?? 0);
  }
}

export const SUGGEST_CAPS = {
  recordOpsBytes: SUGGEST_LIMITS.recordOpsBytes,
  openPerPrincipal: SUGGEST_LIMITS.openPerPrincipal,
  openOpsShare: SUGGEST_LIMITS.openOpsShare,
  partSpans: SUGGEST_LIMITS.partSpans,
  partItems: SUGGEST_LIMITS.partItems,
} as const;

/** `sv`: each of the record's leases' acknowledged clock in `doc`, the doc the frame wrote. */
export type IngestResult =
  | { ok: true; record: string; requested: string; doc: string; sv: Record<string, number>; parts: string[] }
  | { ok: false; reason: SuggestRefusal };

export interface IngestOptions {
  stateCap: number;
  /** Registered Lexical node types (`__type` values). */
  registry: ReadonlySet<string>;
  now?: () => number;
  leases?: LeaseStore;
  /** The doc's encoded state now, for the projected state cap. */
  stateBytes?: () => number;
  /** Record ids; a random UUID unless a test pins them. */
  mintId?: () => string;
  /**
   * The note's payload doc `id` as the DO serves it, to place a payload op's structs; undefined for an id it does not
   * serve (unknown or withheld), whose structs are left to accept. The in-memory payload docs by default.
   */
  payloadDoc?: (id: string) => Y.Doc | undefined;
  /** Hears each record ingest creates, once its write landed; `continues` names the accepted record it follows. */
  onCreated?: (id: string, author: string, continues?: string) => void;
}

/** Where each struct of an open record's ops sits, per doc and client, clock-sorted, so a later op's structs can be placed. */
type Placed = Map<string, Map<number, { clock: number; len: number; at: Placement }[]>>;

/** Leases one resume may name: a principal's open records may hold more than the unused-lease cap. */
const RESUME_MAX = 64;
/** Item headers and keys a meta write adds, beyond the JSON itself. */
const META_SLACK = 64;
/** Encoded bytes a split adds: one struct header naming both origins. */
const SPLIT_BYTES = 32;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FORK_ID = /^[A-Za-z0-9_-]{8,64}$/;
const refused = (reason: SuggestRefusal): { ok: false; reason: SuggestRefusal } => ({ ok: false, reason });

interface Info {
  author: string;
  /** Bytes of ops and parts while open. */
  bytes: number;
  open: boolean;
}

/** `reserved`: the lease whose minted id a new record takes; the record binds it, whatever the frame holds. */
type Target = { ok: true; id: string; create: boolean; continues?: string; base: string; reserved?: Lease } | { ok: false; reason: SuggestRefusal };

export class SuggestIngest {
  readonly leases: LeaseStore;
  /** Every record, so a frame never reads another record's meta. */
  readonly #info = new Map<string, Info>();
  /** A closed record's successor: its continuation, or the record it merged into. Path-compressed on read. */
  readonly #next = new Map<string, string>();
  readonly #open = new Map<string, Set<string>>();
  #openBytes = 0;
  /**
   * All retained suggestion state, as the encoded doc holds it plus the stored leases: measured on wake and at each
   * compaction (`remeasure`); between them every write to `suggestions` adds its update and takes off only the content
   * Yjs provably frees, so the count never falls below what is held. Bounded by `stateShare`.
   */
  #retained = 0;
  /** Open records' placements; a record's entry goes when it closes. */
  readonly #placed = new Map<string, Placed>();

  constructor(
    readonly doc: Y.Doc,
    readonly options: IngestOptions,
  ) {
    this.leases = options.leases ?? new MemoryLeases();
    for (const id of recordIds(doc)) {
      const record = readRecord(doc, id);
      if (!record) continue;
      const open = record.meta.status === 'open';
      const bytes = open ? recordBytes(record) : 0;
      this.#track(id, record.meta.author, bytes, open);
      if (open) {
        for (const op of record.ops) {
          try {
            this.#place(id, op.doc, Y.decodeUpdate(op.update))?.();
          } catch {
            // An undecodable stored op is accept's to refuse.
          }
        }
      }
      const next = record.meta.mergedInto ?? record.meta.continuedBy;
      if (next) this.#next.set(id, next);
    }
    onRecordClosed(doc, (id, meta) => this.#closed(id, meta));
    this.remeasure();
    // A write adds its update; what it deletes (a replaced meta, cleared ops and parts) leaves only a tombstone.
    doc.on('afterTransaction', (txn: Y.Transaction) => {
      if (txn.origin === SUGGESTIONS_ORIGIN) this.#retained = Math.max(0, this.#retained - freedBytes(txn));
    });
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === SUGGESTIONS_ORIGIN) this.#retained += update.byteLength;
    });
  }

  /** Retained suggestion state, in bytes, as the share counts it. */
  get retainedBytes(): number {
    return this.#retained;
  }

  /** Measures the retained state afresh: O(S structs + stored leases), so for a wake or a compaction, not a frame. */
  remeasure(): void {
    this.#retained = suggestionStateBytes(this.doc) + this.leases.storedBytes();
  }

  /**
   * Fresh leases for `who`'s connection, at most `SUGGEST_LIMITS.leaseBatch` and never past `liveLeases` live ones;
   * or `resume` of `who`'s leases whose connection closed or idled, rebound to this one with their acknowledged clock.
   */
  lease(who: Suggester, resume: readonly number[] = [], count: number = SUGGEST_LIMITS.leaseBatch, fork: string | null = null): { ok: true; leases: LeaseGrant[] } | { ok: false; reason: SuggestRefusal } {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    if (!Array.isArray(resume) || resume.length > RESUME_MAX) return refused('malformed');
    const now = this.#now();
    const since = now - SUGGEST_LIMITS.leaseIdleMs;
    const grants: LeaseGrant[] = [];
    for (const client of resume) {
      const lease = typeof client === 'number' ? this.leases.get(client) : undefined;
      if (!lease || lease.principal !== who.id) return refused('lease');
      const held = !lease.expired && lease.usedAt >= since;
      // Held by another open connection: only the fork it was granted to may take it over (its old socket is dead
      // to it, though the DocDO has not seen it close).
      if (held && lease.connection !== who.connection && !(fork !== null && lease.fork === fork)) return refused('lease');
      if (!held && lease.record === null && this.leases.live(who.id, since) >= SUGGEST_LIMITS.liveLeases) return refused('lease-cap');
      this.leases.put({ ...lease, connection: who.connection, expired: false, usedAt: now, fork: fork ?? lease.fork ?? null });
      grants.push({ client, record: lease.record === null ? lease.reserved : this.#head(lease.record), clock: ownValue(lease.clocks, BODY_DOC) ?? 0, clocks: lease.clocks });
    }
    const wanted = Math.min(Math.max(0, Math.floor(count)), SUGGEST_LIMITS.leaseBatch, SUGGEST_LIMITS.liveLeases - this.leases.live(who.id, since));
    // A lease row is retained state too: none is minted past the share, or into the reserve kept for edits.
    const fresh = Math.max(0, Math.min(wanted, Math.floor(this.#room() / leaseBytes({ clocks: {} }))));
    const writer = suggestionsWriter(this.doc)?.client;
    for (let i = 0; i < fresh; i += 1) {
      let client = 0;
      while (client === 0 || client === writer || this.doc.store.clients.has(client) || this.leases.get(client)) client = crypto.getRandomValues(new Uint32Array(1))[0];
      const reserved = this.#mint();
      this.leases.put({ client, principal: who.id, connection: who.connection, reserved, record: null, clocks: {}, spent: false, expired: false, usedAt: now, fork });
      grants.push({ client, record: reserved, clock: 0, clocks: {} });
      this.#retained += leaseBytes({ clocks: {} });
    }
    return grants.length ? { ok: true, leases: grants } : refused(fresh < wanted ? 'doc-cap' : 'lease-cap');
  }

  /** One fork transaction: a body update, or `{doc, update}` in the body or a payload doc of the fork. */
  ops(who: Suggester, record: string, op: Uint8Array | RecordOp): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const { doc, update } = op instanceof Uint8Array ? { doc: BODY_DOC, update: op } : ((op ?? {}) as Partial<RecordOp>);
    if (typeof doc !== 'string' || (doc !== BODY_DOC && !PAYLOAD_ID.test(doc)) || !(update instanceof Uint8Array)) return refused('malformed');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    let meta: { from: Map<number, number>; to: Map<number, number> };
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      meta = Y.parseUpdateMeta(update);
      decoded = Y.decodeUpdate(update);
    } catch {
      return refused('malformed');
    }
    const held = this.#held(doc);
    const now = this.#now();
    const leases: Lease[] = [];
    for (const [client, from] of meta.from) {
      const lease = this.leases.get(client);
      if (!lease || !this.#holds(who, lease)) return refused('lease');
      if (lease.record !== null && this.#head(lease.record) !== target.base) return refused('lease');
      const next = ownValue(lease.clocks, doc) ?? 0;
      if (from > next) return refused('clock-gap');
      // A record never holds two versions of one id.
      if (from < next) return refused('clock-overlap');
      // The lease's first write to this doc: the doc must not hold its id already (minting checked only the body).
      if (next === 0 && held && Y.getState(held.store, client) > 0) return refused('lease');
      leases.push(lease);
    }
    // The caps first, so an oversized frame is never placed.
    const cap = this.#caps(who, target, update.byteLength, meta.from.size);
    if (cap) return refused(cap);
    // Default-deny (suggestions.md §4.4): every struct sits in a channel of the table accept's G3 reads.
    const placed = this.#place(target.id, doc, decoded);
    if (!placed) return refused('channel');
    // An early, O(frame) reject of node types Lexical would not bind; G7 is the full check at accept.
    for (const struct of doc === BODY_DOC ? decoded.structs : []) {
      if (!(struct instanceof Y.Item) || struct.parentSub !== '__type') continue;
      const value = struct.content.getContent().at(-1);
      if (typeof value !== 'string' || !this.options.registry.has(value)) return refused('node-type');
    }

    writeSuggestions(this.doc, () => {
      if (target.create) this.#create(who, target.id, now, target.continues);
      opsOf(this.doc, target.id).push([{ doc, update }]);
      const current = readMeta(this.doc, target.id)!;
      patchMeta(this.doc, target.id, { updatedAt: now, clients: [...new Set([...current.clients, ...meta.from.keys()])] });
    });
    placed();
    if (target.create) this.options.onCreated?.(target.id, who.id, target.continues);
    this.#grow(target.id, update.byteLength);
    this.#bind(target, now);
    for (const lease of leases) {
      const clocks = { ...lease.clocks, [doc]: meta.to.get(lease.client) ?? ownValue(lease.clocks, doc) ?? 0 };
      this.#retained += leaseBytes({ clocks }) - leaseBytes(lease);
      this.leases.put({ ...lease, record: target.id, clocks, usedAt: now });
    }
    return { ok: true, record: target.id, requested: record, doc, sv: this.#sv(target.id, doc), parts: [] };
  }

  delete(who: Suggester, record: string, part: { id: string; targets: IdSpan[] }): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    if (typeof part?.id !== 'string' || !RECORD_ID.test(part.id) || !Array.isArray(part.targets)) return refused('malformed');
    if (part.targets.length === 0 || part.targets.length > SUGGEST_CAPS.partSpans) return refused('target');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    const quote = this.#quote(part.targets);
    if (quote === null) return refused('target');
    const stored: DeletePart = { id: part.id, kind: 'delete', targets: part.targets.map(({ client, clock, len }) => ({ client, clock, len })), quote };
    const bytes = partBytes(stored);
    const cap = this.#caps(who, target, bytes, 0);
    if (cap) return refused(cap);
    const now = this.#now();
    writeSuggestions(this.doc, () => {
      if (target.create) this.#create(who, target.id, now, target.continues);
      partsOf(this.doc, target.id).push([stored]);
      patchMeta(this.doc, target.id, { updatedAt: now });
    });
    if (target.create) this.options.onCreated?.(target.id, who.id, target.continues);
    this.#grow(target.id, bytes);
    this.#bind(target, now);
    return { ok: true, record: target.id, requested: record, doc: BODY_DOC, sv: this.#sv(target.id, BODY_DOC), parts: [part.id] };
  }

  /** Takes back one delete part of an open record the author holds. */
  undelete(who: Suggester, record: string, partId: string): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    if (typeof partId !== 'string') return refused('malformed');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    if (target.create) return refused('record');
    const parts = partsOf(this.doc, target.id);
    const index = parts.toArray().findIndex((part) => part.id === partId);
    if (index < 0) return refused('target');
    const bytes = partBytes(parts.get(index));
    writeSuggestions(this.doc, () => {
      parts.delete(index, 1);
      patchMeta(this.doc, target.id, { updatedAt: this.#now() });
    });
    this.#grow(target.id, -bytes);
    return { ok: true, record: target.id, requested: record, doc: BODY_DOC, sv: this.#sv(target.id, BODY_DOC), parts: [] };
  }

  /** Moves `from`'s ops, parts and leases into `into`; both are the author's open records. Writes no body. */
  merge(who: Suggester, into: string, from: string): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const a = this.#target(who, into);
    const b = this.#target(who, from);
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (a.create || b.create || a.continues || b.continues) return refused('record');
    if (a.id === b.id) return { ok: true, record: a.id, requested: into, doc: BODY_DOC, sv: this.#sv(a.id, BODY_DOC), parts: [] };
    const moved = this.#info.get(b.id)!.bytes;
    if (this.#info.get(a.id)!.bytes + moved > SUGGEST_CAPS.recordOpsBytes) return refused('record-cap');
    // The moved ops leave `from` in the same write, so the share is charged only the meta; the note's state counts
    // the copy until its next compaction.
    const metaWrites = this.#metaWrite(a.id, 0) + this.#metaWrite(b.id, 0);
    if (this.#overState(metaWrites, moved + metaWrites)) return refused('doc-cap');
    const now = this.#now();
    const source = readRecord(this.doc, b.id)!;
    writeSuggestions(this.doc, () => {
      opsOf(this.doc, a.id).push(source.ops);
      partsOf(this.doc, a.id).push(source.parts);
      const current = readMeta(this.doc, a.id)!;
      patchMeta(this.doc, a.id, { updatedAt: now, clients: [...new Set([...current.clients, ...source.meta.clients])] });
      patchMeta(this.doc, b.id, { status: 'withdrawn', mergedInto: a.id, resolvedBy: who.id, resolvedAt: now });
      const ops = opsOf(this.doc, b.id);
      const parts = partsOf(this.doc, b.id);
      ops.delete(0, ops.length);
      parts.delete(0, parts.length);
    });
    this.#next.set(b.id, a.id);
    this.leases.rebind(b.id, a.id);
    this.#movePlaced(b.id, a.id);
    this.#closed(b.id, null);
    this.#grow(a.id, moved);
    return { ok: true, record: a.id, requested: into, doc: BODY_DOC, sv: this.#sv(a.id, BODY_DOC), parts: [] };
  }

  /** The author closes an open record: status only, the body is never written (I4). */
  withdraw(who: Suggester, record: string): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    if (target.create || target.continues) return refused('record');
    closeRecord(this.doc, target.id, { status: 'withdrawn', resolvedBy: who.id, resolvedAt: this.#now() });
    return { ok: true, record: target.id, requested: record, doc: BODY_DOC, sv: {}, parts: [] };
  }

  /** Records holding placements: only open ones, so the index is bounded by the open-record caps. */
  get placedRecords(): number {
    return this.#placed.size;
  }

  /** The connection closed: its leases can no longer write until a `resume`. */
  expireConnection(connection: string): void {
    this.leases.expireConnection(connection);
  }

  /**
   * True when a frame for `held` (the body, or a payload doc) carries new structs under a leased client id, which only
   * a record may hold; O(frame). Structs the doc already holds (an accepted record's text echoed in a step 2) do not
   * count.
   */
  namesLease(update: Uint8Array, held: Y.Doc = this.doc): boolean {
    let meta: { to: Map<number, number> };
    try {
      meta = Y.parseUpdateMeta(update);
    } catch {
      return false;
    }
    for (const [client, to] of meta.to) if (to > Y.getState(held.store, client) && this.leases.get(client)) return true;
    return false;
  }

  /** `who` writes with `lease` now: its principal, its connection, neither closed nor idle. */
  #holds(who: Suggester, lease: Lease): boolean {
    return lease.principal === who.id && lease.connection === who.connection && !lease.expired && lease.usedAt >= this.#now() - SUGGEST_LIMITS.leaseIdleMs;
  }

  /** A new record on a reserved id binds that lease, so it no longer counts as an unused one toward the cap. */
  #bind(target: Extract<Target, { ok: true }>, now: number): void {
    if (target.reserved && target.reserved.record === null) this.leases.put({ ...target.reserved, record: target.id, usedAt: now });
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #mint(): string {
    for (;;) {
      const id = this.options.mintId?.() ?? crypto.randomUUID();
      if (RECORD_ID.test(id) && !this.#info.has(id) && !this.leases.reservedFor(id)) return id;
    }
  }

  /** The record a chain of continuations and merges ends at. */
  #head(id: string): string {
    let head = id;
    const path: string[] = [];
    for (let next = this.#next.get(head); next !== undefined; next = this.#next.get(head)) {
      path.push(head);
      head = next;
    }
    for (const step of path) this.#next.set(step, head);
    return head;
  }

  /**
   * Where a frame for `record` lands: the open head of its chain, a new record for an id minted to this principal,
   * or a continuation of an accepted head (whatever the frame holds, delete-only included). A rejected or withdrawn
   * head refuses `record-closed`. Ids nobody minted to this principal refuse `record`.
   */
  #target(who: Suggester, record: string): Target {
    if (typeof record !== 'string' || !RECORD_ID.test(record)) return refused('malformed');
    const info = this.#info.get(record);
    if (!info) {
      const lease = this.leases.reservedFor(record);
      if (!lease || lease.principal !== who.id) return refused('record');
      if (!this.#holds(who, lease)) return refused('lease');
      return { ok: true, id: record, create: true, base: record, reserved: lease };
    }
    if (info.author !== who.id) return refused('not-author');
    const head = this.#head(record);
    const meta = readMeta(this.doc, head);
    if (!meta || meta.author !== who.id) return refused('not-author');
    if (meta.status === 'open') return { ok: true, id: head, create: false, base: head };
    if (meta.status === 'accepted') return { ok: true, id: this.#mint(), create: true, continues: head, base: head };
    return refused('record-closed');
  }

  /** Bytes the server transaction adds to the encoded state besides the op or part: the record and meta it writes. */
  #metaWrite(id: string, clients: number): number {
    return metaBytes(this.doc, id) + clients * 12 + META_SLACK;
  }

  #overhead(who: Suggester, target: Extract<Target, { ok: true }>, clients: number): number {
    if (!target.create) return this.#metaWrite(target.id, clients);
    const meta = { v: 2, id: target.id, author: who.id, authorName: who.name, source: 'live', createdAt: 0, updatedAt: 0, status: 'open', continues: target.continues };
    return JSON.stringify(meta).length * 2 + clients * 12 + 3 * META_SLACK + (target.continues ? this.#metaWrite(target.continues, 0) : 0);
  }

  /** What suggestion growth may still add: short of the share of retained suggestion state and of the reserve. */
  #room(): number {
    const share = this.options.stateCap * SUGGEST_LIMITS.stateShare - this.#retained;
    if (this.options.stateBytes === undefined) return share;
    return Math.min(share, this.options.stateCap * SUGGEST_LIMITS.reserveShare - this.options.stateBytes());
  }

  /**
   * Suggestion growth would pass the share of retained suggestion state (`retained` more bytes), or take the note
   * (`state` more) into the reserve kept for body and payload edits.
   */
  #overState(retained: number, state: number = retained): boolean {
    if (this.#retained + retained > this.options.stateCap * SUGGEST_LIMITS.stateShare) return true;
    return this.options.stateBytes !== undefined && this.options.stateBytes() + state > this.options.stateCap * SUGGEST_LIMITS.reserveShare;
  }

  #caps(who: Suggester, target: Extract<Target, { ok: true }>, bytes: number, clients: number): SuggestRefusal | null {
    const recordBytes = (target.create ? 0 : (this.#info.get(target.id)?.bytes ?? 0)) + bytes;
    if (recordBytes > SUGGEST_CAPS.recordOpsBytes) return 'record-cap';
    if (this.#openBytes + bytes > this.options.stateCap * SUGGEST_CAPS.openOpsShare) return 'ops-cap';
    if (this.#overState(bytes + this.#overhead(who, target, clients))) return 'doc-cap';
    if (target.create && (this.#open.get(who.id)?.size ?? 0) >= SUGGEST_CAPS.openPerPrincipal) return 'open-cap';
    return null;
  }

  #create(who: Suggester, id: string, now: number, continues?: string): void {
    const meta: RecordMeta = {
      v: 2, id, author: who.id, authorName: who.name, source: 'live', createdAt: now, updatedAt: now, status: 'open', clients: [],
      ...(continues ? { continues } : {}),
    };
    createRecord(this.doc, meta);
    if (continues) {
      patchMeta(this.doc, continues, { continuedBy: id });
      this.#next.set(continues, id);
    }
    this.#track(id, who.id, 0, true);
  }

  #track(id: string, author: string, bytes: number, open: boolean): void {
    this.#info.set(id, { author, bytes, open });
    if (!open) return;
    const set = this.#open.get(author) ?? new Set<string>();
    set.add(id);
    this.#open.set(author, set);
    this.#openBytes += bytes;
  }

  #grow(id: string, bytes: number): void {
    const info = this.#info.get(id)!;
    info.bytes += bytes;
    this.#openBytes += bytes;
  }

  /** Closed by accept, reject, withdraw or merge: the caps forget it; an accept spends its leases. */
  #closed(id: string, meta: RecordMeta | null): void {
    const info = this.#info.get(id);
    if (info?.open) {
      info.open = false;
      this.#openBytes -= info.bytes;
      info.bytes = 0;
      this.#open.get(info.author)?.delete(id);
    }
    this.#placed.delete(id);
    if (meta?.status === 'accepted') this.leases.spend(id);
  }

  /** The doc an op for `doc` is placed against: the body, or the payload doc as the DO serves it. */
  #held(doc: string): Y.Doc | undefined {
    if (doc === BODY_DOC) return this.doc;
    return this.options.payloadDoc ? this.options.payloadDoc(doc) : payloadDocsFor(this.doc).get(doc);
  }

  /**
   * Places `decoded`'s structs against the record's earlier ops and the note's docs through the channel table:
   * O(structs × (log n + depth)), depth capped. Returns null when a struct is outside the table, else a commit that
   * indexes the placements for the record's later ops.
   */
  #place(record: string, doc: string, decoded: ReturnType<typeof Y.decodeUpdate>): (() => void) | null {
    const kind: DocKind = doc === BODY_DOC ? 'body' : 'payload';
    const index = this.#placed.get(record)?.get(doc);
    const held = this.#held(doc);
    const seen = new Map<Y.Item, Placement | null>();
    const lookup = (id: Y.ID): Placement | null => {
      const hit = spanAt(index?.get(id.client) ?? [], id.clock);
      if (hit) return hit.at;
      if (!held || id.clock >= Y.getState(held.store, id.client)) return null;
      const struct = Y.getItem(held.store, id);
      if (!(struct instanceof Y.Item)) return null;
      if (!seen.has(struct)) seen.set(struct, placementOf(kind, held, struct));
      return seen.get(struct)!;
    };
    const placed = checkStructs(kind, decoded, lookup);
    if (!placed) return null;
    return () => {
      let byDoc = this.#placed.get(record);
      if (!byDoc) this.#placed.set(record, (byDoc = new Map()));
      let byClient = byDoc.get(doc);
      if (!byClient) byDoc.set(doc, (byClient = new Map()));
      const unsorted = new Set<number>();
      for (const { struct, at } of placed) {
        const list = byClient.get(struct.id.client) ?? [];
        if (list.length > 0 && list[list.length - 1].clock > struct.id.clock) unsorted.add(struct.id.client);
        list.push({ clock: struct.id.clock, len: struct.length, at });
        byClient.set(struct.id.client, list);
      }
      for (const client of unsorted) byClient.get(client)!.sort((a, b) => a.clock - b.clock);
    };
  }

  /** A merged record's placements join the record it merged into. */
  #movePlaced(from: string, into: string): void {
    const moved = this.#placed.get(from);
    if (!moved) return;
    let byDoc = this.#placed.get(into);
    if (!byDoc) this.#placed.set(into, (byDoc = new Map()));
    for (const [doc, clients] of moved) {
      let byClient = byDoc.get(doc);
      if (!byClient) byDoc.set(doc, (byClient = new Map()));
      for (const [client, list] of clients) byClient.set(client, [...(byClient.get(client) ?? []), ...list].sort((a, b) => a.clock - b.clock));
    }
    this.#placed.delete(from);
  }

  /** Each of the record's leases' acknowledged clock in `doc`. */
  #sv(id: string, doc: string): Record<string, number> {
    const sv: Record<string, number> = {};
    for (const client of readMeta(this.doc, id)?.clients ?? []) {
      const lease = this.leases.get(client);
      if (lease) sv[client] = ownValue(lease.clocks, doc) ?? 0;
    }
    return sv;
  }

  /**
   * Every target is a live body item in a channel of the table (the one accept's G3 removes against) that no pending
   * lease wrote (an accepted record's leases are spent, so its text is ordinary body text): O(spans × log n) lookups
   * plus the items named, capped, each sequence parent placed once. Returns the quote, or null when a target fails.
   */
  #quote(targets: readonly IdSpan[]): string | null {
    let quote = '';
    let items = 0;
    const parents = new Map<unknown, Placement | null>();
    const inTable = (item: Y.Item): boolean => {
      const key = item.parentSub === null ? item.parent : item;
      if (!parents.has(key)) parents.set(key, placementOf('body', this.doc, item));
      const at = parents.get(key);
      return !!at && channelAllows('body', at, contentKind(item.content));
    };
    for (const span of targets) {
      if (![span?.client, span?.clock, span?.len].every((n) => Number.isSafeInteger(n) && n >= 0) || span.len === 0) return null;
      const lease = this.leases.get(span.client);
      if (lease && !lease.spent) return null;
      const structs = this.doc.store.clients.get(span.client);
      const end = span.clock + span.len;
      if (!structs || Y.getState(this.doc.store, span.client) < end) return null;
      for (let i = Y.findIndexSS(structs, span.clock); i < structs.length && structs[i].id.clock < end; i++) {
        const struct = structs[i];
        if (++items > SUGGEST_CAPS.partItems) return null;
        if (!(struct instanceof Y.Item) || struct.deleted || !inTable(struct)) return null;
        const from = Math.max(span.clock, struct.id.clock) - struct.id.clock;
        const to = Math.min(end, struct.id.clock + struct.length) - struct.id.clock;
        if (quote.length < 1024) quote += struct.content instanceof Y.ContentString ? struct.content.str.slice(from, to) : '￼';
      }
    }
    return quote.slice(0, 1024);
  }
}

/**
 * The encoded bytes a transaction provably frees from earlier writes: Yjs swaps a deleted item's content for its length
 * at cleanup, so each item frees its content's encoding (Yjs's own writer) less that length; a deletion that split an
 * item at either end costs that piece a header. Never more than the encoded state shrinks: O(items deleted, their
 * content).
 */
function freedBytes(txn: Y.Transaction): number {
  if (!txn.doc.gc) return 0;
  let bytes = 0;
  Y.iterateDeletedStructs(txn, txn.deleteSet, (struct) => {
    if (!(struct instanceof Y.Item) || struct.keep || struct.id.clock >= (txn.beforeState.get(struct.id.client) ?? 0)) return;
    const encoder = new Y.UpdateEncoderV1();
    struct.content.write(encoder, 0);
    bytes += encoder.toUint8Array().byteLength - varUintBytes(struct.length);
  });
  for (const [client, ranges] of txn.deleteSet.clients) {
    const structs = txn.doc.store.clients.get(client) ?? [];
    // A piece split off an item names the item's previous clock as its origin.
    const split = (clock: number) => {
      if (clock >= (txn.beforeState.get(client) ?? 0)) return false;
      const struct = structs[Y.findIndexSS(structs, clock)];
      return struct instanceof Y.Item && struct.id.clock === clock && struct.origin?.client === client && struct.origin.clock === clock - 1;
    };
    for (const { clock, len } of ranges) {
      if (split(clock)) bytes -= SPLIT_BYTES;
      if (split(clock + len)) bytes -= SPLIT_BYTES;
    }
  }
  return bytes;
}

/** The entry of a clock-sorted list holding `clock`, by binary search. */
function spanAt<T extends { clock: number; len: number }>(list: readonly T[], clock: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clock < list[mid].clock) hi = mid - 1;
    else if (clock >= list[mid].clock + list[mid].len) lo = mid + 1;
    else return list[mid];
  }
  return undefined;
}

/** One doc-socket suggest request, validated and run; the reply is unicast to its sender. */
export function handleSuggest(ingest: SuggestIngest, who: Suggester, request: SuggestRequest): SuggestReply {
  const refuse = (record: unknown, reason: SuggestRefusal): SuggestReply => ({ t: 'suggest-refused', record: typeof record === 'string' ? record : null, reason });
  let result: IngestResult;
  let requested: unknown;
  switch (request.t) {
    case 'suggest-lease': {
      const fork = typeof request.fork === 'string' && FORK_ID.test(request.fork) ? request.fork : null;
      const leased = ingest.lease(who, request.resume ?? [], SUGGEST_LIMITS.leaseBatch, fork);
      return leased.ok ? { t: 'suggest-leased', leases: leased.leases } : refuse(null, leased.reason);
    }
    case 'suggest-ops': {
      requested = request.record;
      let update: Uint8Array;
      try {
        if (typeof request.update !== 'string') throw new Error('no update');
        update = base64ToBytes(request.update);
      } catch {
        return refuse(requested, 'malformed');
      }
      result = ingest.ops(who, request.record, { doc: request.doc ?? BODY_DOC, update });
      break;
    }
    case 'suggest-delete':
      requested = request.record;
      result = ingest.delete(who, request.record, request.part);
      break;
    case 'suggest-undelete':
      requested = request.record;
      result = ingest.undelete(who, request.record, request.partId);
      break;
    case 'suggest-merge':
      requested = request.into;
      result = ingest.merge(who, request.into, request.from);
      break;
    case 'suggest-withdraw':
      requested = request.record;
      result = ingest.withdraw(who, request.record);
      break;
    default:
      return refuse(null, 'malformed');
  }
  return result.ok
    ? { t: 'suggest-ack', record: result.record, requested: result.requested, doc: result.doc, sv: result.sv, parts: result.parts }
    : refuse(requested, result.reason);
}

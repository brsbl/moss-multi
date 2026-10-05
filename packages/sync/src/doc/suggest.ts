// Suggest-mode ingest in the DocDO (docs/design/suggestions.md §3): bookkeeping, not authorization. Leases, record
// ids, `suggest-ops`, `suggest-delete`, merge, undelete and withdraw, each O(frame): no call reads more than the
// records and leases it names, so cost never grows with the doc, its closed records or a continuation chain. Nothing
// here writes the body: a record's ops reach it only through an editor's accept (T5.3).
import * as Y from 'yjs';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { SUGGEST_LIMITS, type IdSpan, type LeaseGrant, type SuggestReply, type SuggestRefusal, type SuggestRequest } from '@moss-multi/protocol/suggest';
import { base64ToBytes } from '@moss-multi/protocol/sync';
import { BODY_ROOTS, type DeletePart, type RecordMeta } from '@moss-multi/core/suggest/apply';
import {
  closeRecord, createRecord, metaBytes, onRecordClosed, opsOf, partsOf, patchMeta, readMeta, readRecord, recordIds, suggestionsWriter, writeSuggestions,
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
  /** The next clock it may send: everything below is acknowledged. */
  nextClock: number;
  /** Its record was accepted: its body items are ordinary body text (design §4.3). */
  spent: boolean;
  /** Its connection closed. */
  expired: boolean;
  usedAt: number;
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
}

export class MemoryLeases implements LeaseStore {
  readonly #byClient = new Map<number, Lease>();
  readonly #byReserved = new Map<string, Lease>();

  get(client: number): Lease | undefined {
    const lease = this.#byClient.get(client);
    return lease && { ...lease };
  }

  put(lease: Lease): void {
    this.#byClient.set(lease.client, { ...lease });
    this.#byReserved.set(lease.reserved, this.#byClient.get(lease.client)!);
  }

  reservedFor(record: string): Lease | undefined {
    const lease = this.#byReserved.get(record);
    return lease && { ...lease };
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
}

type Row = Record<string, ArrayBuffer | string | number | null>;

export class SqlLeases implements LeaseStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS suggest_leases (client_id INTEGER PRIMARY KEY, principal_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, reserved_id TEXT NOT NULL UNIQUE, record_id TEXT, next_clock INTEGER NOT NULL,
      spent INTEGER NOT NULL, expired INTEGER NOT NULL, used_at INTEGER NOT NULL)`);
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
      nextClock: Number(row.next_clock),
      spent: Number(row.spent) === 1,
      expired: Number(row.expired) === 1,
      usedAt: Number(row.used_at),
    };
  }

  get(client: number): Lease | undefined {
    return this.#one('SELECT * FROM suggest_leases WHERE client_id = ?', client);
  }

  put(lease: Lease): void {
    this.sql.exec(
      `INSERT INTO suggest_leases (client_id, principal_id, connection_id, reserved_id, record_id, next_clock, spent, expired, used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET connection_id = excluded.connection_id,
        record_id = excluded.record_id, next_clock = excluded.next_clock, spent = excluded.spent, expired = excluded.expired,
        used_at = excluded.used_at`,
      lease.client, lease.principal, lease.connection, lease.reserved, lease.record, lease.nextClock, lease.spent ? 1 : 0, lease.expired ? 1 : 0, lease.usedAt,
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
}

export const SUGGEST_CAPS = {
  /** Bytes of ops (and delete parts) per record. */
  recordOpsBytes: 256 * 1024,
  openPerPrincipal: 20,
  /** All open records' ops, as a share of the state cap. */
  openOpsShare: 0.25,
  /** Spans per delete part, and items a part may name. */
  partSpans: 1024,
  partItems: 20_000,
} as const;

export type IngestResult =
  | { ok: true; record: string; requested: string; sv: Record<string, number>; parts: string[] }
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
}

/** Leases one resume may name: a principal's open records may hold more than the unused-lease cap. */
const RESUME_MAX = 64;
/** Item headers and keys a meta write adds, beyond the JSON itself. */
const META_SLACK = 64;
const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const refused = (reason: SuggestRefusal): { ok: false; reason: SuggestRefusal } => ({ ok: false, reason });

interface Info {
  author: string;
  /** Bytes of ops and parts while open. */
  bytes: number;
  open: boolean;
}

/** `reserved`: the lease whose minted id a new record takes; the record binds it, whatever the frame holds. */
type Target = { ok: true; id: string; create: boolean; continues?: string; base: string; reserved?: Lease } | { ok: false; reason: SuggestRefusal };

const partBytes = (part: DeletePart) => part.id.length + part.quote.length * 2 + part.targets.length * 24 + 16;

export class SuggestIngest {
  readonly leases: LeaseStore;
  /** Every record, so a frame never reads another record's meta. */
  readonly #info = new Map<string, Info>();
  /** A closed record's successor: its continuation, or the record it merged into. Path-compressed on read. */
  readonly #next = new Map<string, string>();
  readonly #open = new Map<string, Set<string>>();
  #openBytes = 0;

  constructor(
    readonly doc: Y.Doc,
    readonly options: IngestOptions,
  ) {
    this.leases = options.leases ?? new MemoryLeases();
    for (const id of recordIds(doc)) {
      const record = readRecord(doc, id);
      if (!record) continue;
      const open = record.meta.status === 'open';
      const bytes = open ? record.ops.reduce((sum, op) => sum + op.byteLength, 0) + record.parts.reduce((sum, part) => sum + partBytes(part), 0) : 0;
      this.#track(id, record.meta.author, bytes, open);
      const next = record.meta.mergedInto ?? record.meta.continuedBy;
      if (next) this.#next.set(id, next);
    }
    onRecordClosed(doc, (id, meta) => this.#closed(id, meta));
  }

  /**
   * Fresh leases for `who`'s connection, at most `SUGGEST_LIMITS.leaseBatch` and never past `liveLeases` live ones;
   * or `resume` of `who`'s leases whose connection closed or idled, rebound to this one with their acknowledged clock.
   */
  lease(who: Suggester, resume: readonly number[] = [], count: number = SUGGEST_LIMITS.leaseBatch): { ok: true; leases: LeaseGrant[] } | { ok: false; reason: SuggestRefusal } {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    if (!Array.isArray(resume) || resume.length > RESUME_MAX) return refused('malformed');
    const now = this.#now();
    const since = now - SUGGEST_LIMITS.leaseIdleMs;
    const grants: LeaseGrant[] = [];
    for (const client of resume) {
      const lease = typeof client === 'number' ? this.leases.get(client) : undefined;
      if (!lease || lease.principal !== who.id) return refused('lease');
      const held = !lease.expired && lease.usedAt >= since;
      if (held && lease.connection !== who.connection) return refused('lease');
      if (!held && lease.record === null && this.leases.live(who.id, since) >= SUGGEST_LIMITS.liveLeases) return refused('lease-cap');
      this.leases.put({ ...lease, connection: who.connection, expired: false, usedAt: now });
      grants.push({ client, record: lease.record === null ? lease.reserved : this.#head(lease.record), clock: lease.nextClock });
    }
    const fresh = Math.min(Math.max(0, Math.floor(count)), SUGGEST_LIMITS.leaseBatch, SUGGEST_LIMITS.liveLeases - this.leases.live(who.id, since));
    const writer = suggestionsWriter(this.doc)?.client;
    for (let i = 0; i < fresh; i += 1) {
      let client = 0;
      while (client === 0 || client === writer || this.doc.store.clients.has(client) || this.leases.get(client)) client = crypto.getRandomValues(new Uint32Array(1))[0];
      const reserved = this.#mint();
      this.leases.put({ client, principal: who.id, connection: who.connection, reserved, record: null, nextClock: 0, spent: false, expired: false, usedAt: now });
      grants.push({ client, record: reserved, clock: 0 });
    }
    return grants.length ? { ok: true, leases: grants } : refused('lease-cap');
  }

  ops(who: Suggester, record: string, update: Uint8Array): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    let meta: { from: Map<number, number>; to: Map<number, number> };
    let structs: (Y.Item | Y.GC | Y.Skip)[];
    try {
      meta = Y.parseUpdateMeta(update);
      structs = Y.decodeUpdate(update).structs;
    } catch {
      return refused('malformed');
    }
    const now = this.#now();
    const leases: Lease[] = [];
    for (const [client, from] of meta.from) {
      const lease = this.leases.get(client);
      if (!lease || !this.#holds(who, lease)) return refused('lease');
      if (lease.record !== null && this.#head(lease.record) !== target.base) return refused('lease');
      if (from > lease.nextClock) return refused('clock-gap');
      // A record never holds two versions of one id.
      if (from < lease.nextClock) return refused('clock-overlap');
      leases.push(lease);
    }
    // An early, O(frame) reject of node types Lexical would not bind; G7 is the full check at accept.
    for (const struct of structs) {
      if (!(struct instanceof Y.Item) || struct.parentSub !== '__type') continue;
      const value = struct.content.getContent().at(-1);
      if (typeof value !== 'string' || !this.options.registry.has(value)) return refused('node-type');
    }
    const cap = this.#caps(who, target, update.byteLength, meta.from.size);
    if (cap) return refused(cap);

    writeSuggestions(this.doc, () => {
      if (target.create) this.#create(who, target.id, now, target.continues);
      opsOf(this.doc, target.id).push([update]);
      const current = readMeta(this.doc, target.id)!;
      patchMeta(this.doc, target.id, { updatedAt: now, clients: [...new Set([...current.clients, ...meta.from.keys()])] });
    });
    this.#grow(target.id, update.byteLength);
    this.#bind(target, now);
    for (const lease of leases) {
      this.leases.put({ ...lease, record: target.id, nextClock: meta.to.get(lease.client) ?? lease.nextClock, usedAt: now });
    }
    return { ok: true, record: target.id, requested: record, sv: this.#sv(target.id), parts: [] };
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
    this.#grow(target.id, bytes);
    this.#bind(target, now);
    return { ok: true, record: target.id, requested: record, sv: this.#sv(target.id), parts: [part.id] };
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
    return { ok: true, record: target.id, requested: record, sv: this.#sv(target.id), parts: [] };
  }

  /** Moves `from`'s ops, parts and leases into `into`; both are the author's open records. Writes no body. */
  merge(who: Suggester, into: string, from: string): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const a = this.#target(who, into);
    const b = this.#target(who, from);
    if (!a.ok) return a;
    if (!b.ok) return b;
    if (a.create || b.create || a.continues || b.continues) return refused('record');
    if (a.id === b.id) return { ok: true, record: a.id, requested: into, sv: this.#sv(a.id), parts: [] };
    const moved = this.#info.get(b.id)!.bytes;
    if (this.#info.get(a.id)!.bytes + moved > SUGGEST_CAPS.recordOpsBytes) return refused('record-cap');
    if (this.#overState(moved + this.#metaWrite(a.id, 0) + this.#metaWrite(b.id, 0))) return refused('doc-cap');
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
    this.#closed(b.id, null);
    this.#grow(a.id, moved);
    return { ok: true, record: a.id, requested: into, sv: this.#sv(a.id), parts: [] };
  }

  /** The author closes an open record: status only, the body is never written (I4). */
  withdraw(who: Suggester, record: string): IngestResult {
    if (!roleAtLeast(who.role, 'suggester')) return refused('role');
    const target = this.#target(who, record);
    if (!target.ok) return target;
    if (target.create || target.continues) return refused('record');
    closeRecord(this.doc, target.id, { status: 'withdrawn', resolvedBy: who.id, resolvedAt: this.#now() });
    return { ok: true, record: target.id, requested: record, sv: {}, parts: [] };
  }

  /** The connection closed: its leases can no longer write until a `resume`. */
  expireConnection(connection: string): void {
    this.leases.expireConnection(connection);
  }

  /**
   * True when a body frame carries new structs under a leased client id, which only a record may hold; O(frame).
   * Structs the doc already holds (an accepted record's text echoed in a step 2) do not count.
   */
  namesLease(update: Uint8Array): boolean {
    let meta: { to: Map<number, number> };
    try {
      meta = Y.parseUpdateMeta(update);
    } catch {
      return false;
    }
    for (const [client, to] of meta.to) if (to > Y.getState(this.doc.store, client) && this.leases.get(client)) return true;
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

  #overState(bytes: number): boolean {
    return this.options.stateBytes !== undefined && this.options.stateBytes() + bytes > this.options.stateCap;
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
    if (meta?.status === 'accepted') this.leases.spend(id);
  }

  /** Each of the record's leases' acknowledged clock. */
  #sv(id: string): Record<string, number> {
    const sv: Record<string, number> = {};
    for (const client of readMeta(this.doc, id)?.clients ?? []) {
      const lease = this.leases.get(client);
      if (lease) sv[client] = lease.nextClock;
    }
    return sv;
  }

  /**
   * Every target is a live item in `root` or `registers` that no pending lease wrote (an accepted record's leases
   * are spent, so its text is ordinary body text): O(spans × log n) lookups plus the items named, capped. Returns
   * the quote, or null when a target fails.
   */
  #quote(targets: readonly IdSpan[]): string | null {
    let quote = '';
    let items = 0;
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
        if (!(struct instanceof Y.Item) || struct.deleted || !inBody(this.doc, struct)) return null;
        const from = Math.max(span.clock, struct.id.clock) - struct.id.clock;
        const to = Math.min(end, struct.id.clock + struct.length) - struct.id.clock;
        if (quote.length < 1024) quote += struct.content instanceof Y.ContentString ? struct.content.str.slice(from, to) : '￼';
      }
    }
    return quote.slice(0, 1024);
  }
}

function inBody(doc: Y.Doc, item: Y.Item): boolean {
  let parent = item.parent;
  for (let depth = 0; depth < 256; depth++) {
    if (!(parent instanceof Y.AbstractType)) return false;
    if (!parent._item) {
      for (const [name, shared] of doc.share) if (shared === parent) return BODY_ROOTS.has(name);
      return false;
    }
    parent = parent._item.parent;
  }
  return false;
}

/** One doc-socket suggest request, validated and run; the reply is unicast to its sender. */
export function handleSuggest(ingest: SuggestIngest, who: Suggester, request: SuggestRequest): SuggestReply {
  const refuse = (record: unknown, reason: SuggestRefusal): SuggestReply => ({ t: 'suggest-refused', record: typeof record === 'string' ? record : null, reason });
  let result: IngestResult;
  let requested: unknown;
  switch (request.t) {
    case 'suggest-lease': {
      const leased = ingest.lease(who, request.resume ?? []);
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
      result = ingest.ops(who, request.record, update);
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
    ? { t: 'suggest-ack', record: result.record, requested: result.requested, sv: result.sv, parts: result.parts }
    : refuse(requested, result.reason);
}

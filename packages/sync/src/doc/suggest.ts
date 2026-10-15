// Suggest-mode ingest in the DocDO (docs/design/suggestions.md §3): bookkeeping, not authorization. Leases, the
// `suggest-ops` append and `suggest-delete` validation, each O(frame). Nothing here writes the body: a record's ops
// reach it only through an editor's accept. The spike keeps leases in memory; T5.2 persists them in
// `suggest_leases` and wires the doc-socket frames.
import * as Y from 'yjs';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import {
  BODY_DOC, BODY_ROOTS, checkStructs, placementOf, type DocKind, type IdSpan, type Placement, type RecordMeta, type RecordOp,
} from '@moss-multi/core/suggest/apply';
import { payloadDocsFor } from '../payload-docs.ts';
import { createRecord, opsOf, partsOf, patchMeta, readMeta, readRecord, recordIds, SUGGESTIONS_ORIGIN } from '../suggest/records.ts';

export interface SuggestPrincipal {
  id: string;
  name: string;
}

export interface Lease {
  client: number;
  principal: string;
  record: string | null;
  /** The next clock per doc: a lease writes the body and each payload doc of the author's fork, each its own clocks. */
  nextClock: Map<string, number>;
  spent: boolean;
}

export const SUGGEST_CAPS = {
  /** Bytes of ops per record. */
  recordOpsBytes: 256 * 1024,
  openPerPrincipal: 20,
  /** All open records' ops, as a share of the state cap. */
  openOpsShare: 0.25,
  /** Spans per delete part, and items a part may name. */
  partSpans: 1024,
  partItems: 20_000,
} as const;

export type IngestRefusal =
  | 'role'
  | 'malformed'
  | 'not-author'
  | 'record-closed'
  | 'lease'
  | 'clock-gap'
  | 'record-cap'
  | 'open-cap'
  | 'ops-cap'
  | 'node-type'
  | 'channel'
  | 'target';

export type IngestResult = { ok: true; record: string; doc: string; clocks: Record<number, number> } | { ok: false; reason: IngestRefusal };

export interface IngestOptions {
  stateCap: number;
  /** Registered Lexical node types (`__type` values). */
  registry: ReadonlySet<string>;
  now?: () => number;
  /** The note's payload doc `id` as the DO holds it, to place a payload op's structs; the in-memory payloads by default. */
  payloadDoc?: (id: string) => Y.Doc | undefined;
}

/** Where each struct of a record's earlier ops sits, per doc and client, so a later op's structs can be placed. */
type Placed = Map<string, Map<number, { clock: number; len: number; at: Placement }[]>>;

const RECORD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export class SuggestIngest {
  readonly leases = new Map<number, Lease>();
  /** Bytes of ops per open record, so the caps never re-read the doc. */
  readonly #bytes = new Map<string, number>();
  readonly #placed = new Map<string, Placed>();

  constructor(
    readonly doc: Y.Doc,
    readonly options: IngestOptions,
  ) {
    for (const id of recordIds(doc)) {
      const record = readRecord(doc, id);
      if (record?.meta.status !== 'open') continue;
      this.#bytes.set(id, record.ops.reduce((sum, op) => sum + op.update.byteLength, 0));
      for (const op of record.ops) {
        try {
          this.#place(id, op.doc, Y.decodeUpdate(op.update));
        } catch {
          // An undecodable stored op is accept's to refuse.
        }
      }
    }
  }

  /** Fresh client ids, absent from the body's state vector and from every other lease. */
  lease(principal: string, count = 2): number[] {
    const out: number[] = [];
    while (out.length < count) {
      const client = crypto.getRandomValues(new Uint32Array(1))[0];
      if (client === 0 || this.leases.has(client) || this.doc.store.clients.has(client)) continue;
      this.leases.set(client, { client, principal, record: null, nextClock: new Map(), spent: false });
      out.push(client);
    }
    return out;
  }

  /** One fork transaction: a body update, or `{doc, update}` for a payload doc of the fork. */
  ops(principal: SuggestPrincipal, role: string, record: string, op: Uint8Array | RecordOp): IngestResult {
    if (!roleAtLeast(role, 'suggester')) return { ok: false, reason: 'role' };
    const { doc, update } = op instanceof Uint8Array ? { doc: BODY_DOC, update: op } : op;
    if (typeof doc !== 'string' || (doc !== BODY_DOC && !RECORD_ID.test(doc)) || !(update instanceof Uint8Array)) return { ok: false, reason: 'malformed' };
    const target = this.#target(principal, record);
    if (!target.ok) return target;
    let meta: { from: Map<number, number>; to: Map<number, number> };
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      meta = Y.parseUpdateMeta(update);
      decoded = Y.decodeUpdate(update);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const chain = this.#chain(target.id);
    for (const [client, from] of meta.from) {
      const lease = this.leases.get(client);
      if (!lease || lease.principal !== principal.id || (lease.record !== null && !chain.has(lease.record))) return { ok: false, reason: 'lease' };
      if (from > (lease.nextClock.get(doc) ?? 0)) return { ok: false, reason: 'clock-gap' };
    }
    // The caps first, so an oversized frame is never placed.
    const bytes = (this.#bytes.get(target.id) ?? 0) + update.byteLength;
    if (bytes > SUGGEST_CAPS.recordOpsBytes) return { ok: false, reason: 'record-cap' };
    if (this.#openBytes() + update.byteLength > this.options.stateCap * SUGGEST_CAPS.openOpsShare) return { ok: false, reason: 'ops-cap' };
    if (target.create && this.#openCount(principal.id) >= SUGGEST_CAPS.openPerPrincipal) return { ok: false, reason: 'open-cap' };
    // G3 at ingest (suggestions.md §4.4): every struct this frame writes sits in a channel of the table.
    const placed = this.#place(target.id, doc, decoded, true);
    if (!placed) return { ok: false, reason: 'channel' };
    // An early, O(frame) reject of node types Lexical would not bind; G7 is the full check at accept.
    for (const struct of doc === BODY_DOC ? decoded.structs : []) {
      if (!(struct instanceof Y.Item) || struct.parentSub !== '__type') continue;
      const value = struct.content.getContent().at(-1);
      if (typeof value !== 'string' || !this.options.registry.has(value)) return { ok: false, reason: 'node-type' };
    }

    const now = this.options.now?.() ?? Date.now();
    this.doc.transact(() => {
      if (target.create) this.#create(principal, target.id, now, target.continues);
      opsOf(this.doc, target.id).push([{ doc, update }]);
      const current = readMeta(this.doc, target.id)!;
      patchMeta(this.doc, target.id, { updatedAt: now, clients: [...new Set([...current.clients, ...meta.from.keys()])] });
    }, SUGGESTIONS_ORIGIN);
    this.#bytes.set(target.id, bytes);
    placed();
    const clocks: Record<number, number> = {};
    for (const [client, to] of meta.to) {
      const lease = this.leases.get(client)!;
      lease.record = target.id;
      const next = Math.max(lease.nextClock.get(doc) ?? 0, to);
      lease.nextClock.set(doc, next);
      clocks[client] = next;
    }
    return { ok: true, record: target.id, doc, clocks };
  }

  delete(principal: SuggestPrincipal, role: string, record: string, part: { id: string; targets: IdSpan[] }): IngestResult {
    if (!roleAtLeast(role, 'suggester')) return { ok: false, reason: 'role' };
    if (typeof part?.id !== 'string' || !RECORD_ID.test(part.id) || !Array.isArray(part.targets)) return { ok: false, reason: 'malformed' };
    if (part.targets.length === 0 || part.targets.length > SUGGEST_CAPS.partSpans) return { ok: false, reason: 'target' };
    const target = this.#target(principal, record);
    if (!target.ok) return target;
    const quote = this.#quote(part.targets);
    if (quote === null) return { ok: false, reason: 'target' };
    if (target.create && this.#openCount(principal.id) >= SUGGEST_CAPS.openPerPrincipal) return { ok: false, reason: 'open-cap' };
    const now = this.options.now?.() ?? Date.now();
    const targets = part.targets.map(({ client, clock, len }) => ({ client, clock, len }));
    this.doc.transact(() => {
      if (target.create) this.#create(principal, target.id, now, target.continues);
      partsOf(this.doc, target.id).push([{ id: part.id, kind: 'delete', targets, quote }]);
      patchMeta(this.doc, target.id, { updatedAt: now });
    }, SUGGESTIONS_ORIGIN);
    this.#bytes.set(target.id, this.#bytes.get(target.id) ?? 0);
    return { ok: true, record: target.id, doc: BODY_DOC, clocks: {} };
  }

  /**
   * Places `decoded`'s structs against the record's earlier ops and the note's docs: O(structs × (log n + depth)),
   * with depth capped at MAX_DEPTH. Returns null when a struct is outside the channel table, else a commit that
   * indexes the placements for later ops; with `defer` unset it commits at once.
   */
  #place(record: string, doc: string, decoded: ReturnType<typeof Y.decodeUpdate>, defer = false): (() => void) | null {
    const kind: DocKind = doc === BODY_DOC ? 'body' : 'payload';
    const index = this.#placed.get(record)?.get(doc);
    const held = doc === BODY_DOC ? this.doc : (this.options.payloadDoc ?? ((key: string) => payloadDocsFor(this.doc).get(key)))(doc);
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
    const commit = () => {
      let byDoc = this.#placed.get(record);
      if (!byDoc) this.#placed.set(record, (byDoc = new Map()));
      let byClient = byDoc.get(doc);
      if (!byClient) byDoc.set(doc, (byClient = new Map()));
      const sorted = new Set<number>();
      for (const { struct, at } of placed) {
        const list = byClient.get(struct.id.client);
        const entry = { clock: struct.id.clock, len: struct.length, at };
        if (!list) byClient.set(struct.id.client, [entry]);
        else {
          if (list[list.length - 1].clock > entry.clock) sorted.add(struct.id.client);
          list.push(entry);
        }
      }
      // A frame re-sending clocks below a client's last: one sort per client, not one splice per struct.
      for (const client of sorted) byClient.get(client)!.sort((a, b) => a.clock - b.clock);
    };
    if (!defer) commit();
    return commit;
  }

  /** An editor's body frame naming a leased client id is refused `protected-type` (T5.2). O(frame). */
  namesLease(update: Uint8Array): boolean {
    for (const client of Y.parseUpdateMeta(update).from.keys()) if (this.leases.has(client)) return true;
    return false;
  }

  /**
   * Where a frame for `record` lands: the open record itself, a new record for an unused id, or a continuation of an
   * accepted one. A rejected or withdrawn record refuses `record-closed`.
   */
  #target(principal: SuggestPrincipal, record: string): { ok: true; id: string; create: boolean; continues?: string } | { ok: false; reason: IngestRefusal } {
    if (typeof record !== 'string' || !RECORD_ID.test(record)) return { ok: false, reason: 'malformed' };
    let id = record;
    for (let hops = 0; hops < 64; hops++) {
      const meta = readMeta(this.doc, id);
      if (!meta) return { ok: true, id, create: true, continues: id === record ? undefined : record };
      if (meta.author !== principal.id) return { ok: false, reason: 'not-author' };
      if (meta.status === 'open') return { ok: true, id, create: false };
      if (meta.status !== 'accepted') return { ok: false, reason: 'record-closed' };
      if (meta.continuedBy) {
        id = meta.continuedBy;
        continue;
      }
      const next = `${record.slice(0, 48)}-c${hops + 1}`;
      return { ok: true, id: next, create: true, continues: id };
    }
    return { ok: false, reason: 'record-closed' };
  }

  /** The record and every record it continues: a lease bound to any of them may write here. */
  #chain(id: string): Set<string> {
    const chain = new Set([id]);
    for (let meta = readMeta(this.doc, id); meta?.continues && !chain.has(meta.continues); meta = readMeta(this.doc, meta.continues)) {
      chain.add(meta.continues);
    }
    return chain;
  }

  #create(principal: SuggestPrincipal, id: string, now: number, continues?: string): void {
    const meta: RecordMeta = {
      v: 2, id, author: principal.id, authorName: principal.name, source: 'live', createdAt: now, updatedAt: now, status: 'open', clients: [],
      ...(continues ? { continues } : {}),
    };
    createRecord(this.doc, meta);
    if (continues && readMeta(this.doc, continues)) patchMeta(this.doc, continues, { continuedBy: id });
  }

  #openCount(principal: string): number {
    let count = 0;
    for (const id of this.#bytes.keys()) if (readMeta(this.doc, id)?.author === principal && readMeta(this.doc, id)?.status === 'open') count++;
    return count;
  }

  #openBytes(): number {
    let total = 0;
    for (const [id, bytes] of this.#bytes) if (readMeta(this.doc, id)?.status === 'open') total += bytes;
    return total;
  }

  /**
   * Every target is a live item in `root` or `registers` whose client is not leased: O(spans × log n) lookups plus
   * the items named, capped. Returns the quote, or null when a target fails.
   */
  #quote(targets: readonly IdSpan[]): string | null {
    let quote = '';
    let items = 0;
    for (const span of targets) {
      if (![span?.client, span?.clock, span?.len].every((n) => Number.isSafeInteger(n) && n >= 0) || span.len === 0) return null;
      if (this.leases.has(span.client)) return null;
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

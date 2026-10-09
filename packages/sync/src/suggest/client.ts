// The suggest-mode client (docs/design/suggestions.md §5, §14), headless so it runs in tests: the fork F (the body B
// and a copy of each payload doc it touches, plus the author's own valid open records, written under the active
// lease) and the composite C (B plus every valid open record). F forwards every transaction, in the body or a payload
// doc, whose origin is not one of its own as `suggest-ops` with that doc; it never writes B or B's payloads. A record
// enters F or C only after G1–G3 and the headless bind check pass on scratch copies.
import * as Y from 'yjs';
import {
  BODY_DOC, BODY_ROOTS, hydrate, ownValue, PAYLOAD_ID, regRefs, ROOT_KINDS, type Inserted, type RecordOp, type SuggestionRecord,
} from '@moss-multi/core/suggest/apply';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type IdSpan, type LeaseGrant, type SuggestReply, type SuggestRefusal, type SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64 } from '@moss-multi/protocol/sync';
import { attachPayloadDocs, PAYLOAD_LOADED, PayloadDocs, payloadDocsFor, payloadMap, payloadText } from '../payload-docs.ts';
import { attachPayloadSource } from '../server-doc.ts';
import { registerFork } from './forks.ts';
import { openRecords, partBytes, readMeta, readRecord, recordBytes, recordIds } from './records.ts';
import { bindCheck } from './review.ts';

export { openRecords };

export const SHIM_BODY_APPLY = 'shim-body-apply';
export const SHIM_RECORD_APPLY = 'shim-record-apply';
const VIEW_APPLY = 'suggest-view';

/** A new group starts after this long without an edit (§5 grouping). */
export const GROUP_IDLE_MS = 30_000;
/**
 * The DocDO expires a lease no frame used for `leaseIdleMs`: an active lease untouched this long is resumed on the same
 * connection before the next request.
 */
export const LEASE_RENEW_MS = SUGGEST_LIMITS.leaseIdleMs / 2;

export type BindCheck = (doc: Y.Doc, inserted: Inserted, deleted: readonly IdSpan[]) => boolean;

/** The payload ids a record's ops write. */
export const payloadIdsOf = (record: SuggestionRecord): string[] => [...new Set(record.ops.filter((op) => op.doc !== BODY_DOC).map((op) => op.doc))];

function rootName(doc: Y.Doc, type: Y.AbstractType<unknown>): string | null {
  let top = type;
  while (top._item !== null) {
    const parent = top._item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    top = parent;
  }
  for (const [name, shared] of doc.share) if (shared === top) return name;
  return null;
}

/** A doc and the payload docs a record wrote beside it, all gc-free scratch copies. */
export interface View {
  doc: Y.Doc;
  payloads: Map<string, Y.Doc>;
}

export function destroyView(view: View): void {
  view.doc.destroy();
  for (const payload of view.payloads.values()) payload.destroy();
}

/** Where a view reads a payload's state before the record: B's payload doc, or an earlier record's in C. */
export type PayloadBase = (id: string) => Y.Doc | undefined;

/**
 * `base` plus the record's ops on gc-free scratch copies of the body and of each payload they write, or null when the
 * record fails G1 (nothing parked in any doc), G2 (only its leased clients advance), G3 (only the body's and payloads'
 * roots change) or the bind check. Delete parts are not applied: they paint as strikes. Never touches `base` or a
 * payload `payloadOf` returns.
 */
export function applyForView(base: Y.Doc, record: SuggestionRecord, check: BindCheck = bindCheck, payloadOf: PayloadBase = (id) => payloadDocsFor(base).get(id)): View | null {
  const view: View = { doc: hydrate(base), payloads: new Map() };
  const fail = () => {
    destroyView(view);
    return null;
  };
  const groups = new Map<Y.Doc, Uint8Array[]>([[view.doc, []]]);
  for (const op of record.ops as unknown[]) {
    const { doc, update } = (op ?? {}) as Partial<RecordOp>;
    if (typeof doc !== 'string' || !(update instanceof Uint8Array)) return fail();
    let into = view.doc;
    if (doc !== BODY_DOC) {
      if (!PAYLOAD_ID.test(doc)) return fail();
      let payload = view.payloads.get(doc);
      if (!payload) {
        const from = payloadOf(doc);
        payload = from ? hydrate(from) : new Y.Doc({ gc: false });
        view.payloads.set(doc, payload);
        groups.set(payload, []);
      }
      into = payload;
    }
    groups.get(into)!.push(update);
  }
  const clients = new Set(record.meta.clients);
  const inserted = new Map<number, readonly [number, number]>();
  const deleted: IdSpan[] = [];
  for (const [doc, updates] of groups) {
    const before = Y.decodeStateVector(Y.encodeStateVector(doc));
    let transaction: Y.Transaction | null = null;
    try {
      doc.transact((tr) => {
        transaction = tr;
        for (const update of updates) Y.applyUpdate(doc, update);
      }, VIEW_APPLY);
    } catch {
      return fail();
    }
    const tr = transaction as Y.Transaction | null;
    if (!tr || doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return fail();
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
      const from = before.get(client) ?? 0;
      if (clock <= from) continue;
      if (!clients.has(client)) return fail();
      if (doc === view.doc) inserted.set(client, [from, clock]);
    }
    if (doc === view.doc) {
      for (const [client, items] of (tr.deleteSet as unknown as { clients: Map<number, { clock: number; len: number }[]> }).clients) {
        for (const { clock, len } of items) deleted.push({ client, clock, len });
      }
    }
    const roots = doc === view.doc ? BODY_ROOTS : ROOT_KINDS.payload;
    for (const type of tr.changed.keys()) {
      const name = rootName(doc, type as unknown as Y.AbstractType<unknown>);
      if (name === null || !roots.has(name)) return fail();
    }
  }
  // The bind check reads the payloads this record writes, as an editor bound to the view would.
  const read = (id: string) => {
    const payload = view.payloads.get(id);
    return payload ? Y.encodeStateAsUpdate(payload) : null;
  };
  attachPayloadSource(view.doc, { read, has: (id) => view.payloads.has(id), write: () => {}, totalBytes: () => 0, bytesOf: () => 0 });
  try {
    if (!check(view.doc, inserted, deleted)) return fail();
  } catch {
    return fail();
  }
  return view;
}

export interface Built extends View {
  /** C: B plus every valid open record's ops, gc-free, with the payloads they write. The caller destroys it. */
  doc: Y.Doc;
  valid: string[];
  broken: string[];
  /** Records left out until a payload they edit has arrived from the server. */
  waiting: string[];
  /** Each valid record's leased clients. */
  clients: Map<number, string>;
}

/**
 * The payloads B's body names or holds, for records that edit them: held now (so the session syncs them), and
 * `undefined` while still arriving. A payload B neither names nor holds is new in a record: it starts empty.
 */
function bodyPayload(body: Y.Doc, id: string, named: () => ReadonlyMap<string, unknown>): Y.Doc | null | undefined {
  const host = payloadDocsFor(body);
  if (!host.get(id) && !named().has(id)) return null;
  const doc = host.hold(id);
  return host.awaiting(id) ? undefined : doc;
}

/** The composite C, built on demand from B's records. Bind-check verdicts are kept per record and op count. */
export class Composite {
  readonly #verdicts = new Map<string, { ops: number; ok: boolean }>();

  constructor(
    readonly body: Y.Doc,
    readonly options: { author?: string; check?: BindCheck } = {},
  ) {}

  build(): Built {
    const built: Built = { doc: hydrate(this.body), payloads: new Map(), valid: [], broken: [], waiting: [], clients: new Map() };
    let named: Map<string, unknown> | null = null;
    const names = () => (named ??= regRefs(this.body));
    for (const record of openRecords(this.body, this.options.author)) {
      const id = record.meta.id;
      // A record editing a payload whose state has not arrived would park; it waits for the payload instead.
      if (payloadIdsOf(record).some((payload) => !built.payloads.has(payload) && bodyPayload(this.body, payload, names) === undefined)) {
        built.waiting.push(id);
        continue;
      }
      const check: BindCheck = (scratch, inserted, deleted) => {
        const known = this.#verdicts.get(id);
        if (known && known.ops === record.ops.length) return known.ok;
        const ok = (this.options.check ?? bindCheck)(scratch, inserted, deleted);
        this.#verdicts.set(id, { ops: record.ops.length, ok });
        return ok;
      };
      const next = applyForView(built.doc, record, check, (payload) => built.payloads.get(payload) ?? bodyPayload(this.body, payload, names) ?? undefined);
      if (!next) {
        built.broken.push(id);
        continue;
      }
      built.doc.destroy();
      built.doc = next.doc;
      for (const [payload, doc] of next.payloads) {
        built.payloads.get(payload)?.destroy();
        built.payloads.set(payload, doc);
      }
      built.valid.push(id);
      for (const client of record.meta.clients) built.clients.set(client, id);
    }
    attachViewPayloads(this.body, built.doc, built.payloads);
    return built;
  }
}

/**
 * Read-only payloads for a view of B, for a bind and for an export: the view's own payload when a record wrote one,
 * else B's.
 */
function attachViewPayloads(body: Y.Doc, doc: Y.Doc, own: ReadonlyMap<string, Y.Doc> = new Map()): void {
  const source = payloadDocsFor(body);
  const read = (id: string) => {
    const from = own.get(id) ?? source.get(id);
    return from ? Y.encodeStateAsUpdate(from) : null;
  };
  const has = (id: string) => own.has(id) || source.has(id);
  attachPayloadDocs(doc, new PayloadDocs(read, has));
  attachPayloadSource(doc, { read, has, write: () => {}, totalBytes: () => 0, bytesOf: () => 0 });
}

/**
 * Payload docs for a doc derived from B (F, or Review's C), attached to it so its editor's registers read them. Each
 * starts as a copy of B's payload when B's body names it or B holds it (and is held in B, so the session syncs it),
 * follows B's later updates under `origin`, and waits while B's is still arriving; `seed` adds a view's own state (C's
 * record ops). Any other id starts empty: a payload new in a record, or minted here.
 */
export function derivedPayloads(body: Y.Doc, derived: Y.Doc, origin: unknown, seed?: (id: string) => Y.Doc | undefined): { host: PayloadDocs; stop: () => void } {
  const source = payloadDocsFor(body);
  const host = attachPayloadDocs(derived, new PayloadDocs(undefined, (id) => source.has(id)));
  const stops: (() => void)[] = [];
  stops.push(host.onHold((id, doc, fresh) => {
    const seeded = fresh ? undefined : seed?.(id);
    if (seeded) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seeded), PAYLOAD_LOADED);
    if (fresh || (!source.get(id) && !regRefs(body).has(id))) return;
    const from = source.hold(id);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(from), PAYLOAD_LOADED);
    const follow = (update: Uint8Array) => Y.applyUpdate(doc, update, origin);
    from.on('update', follow);
    stops.push(() => from.off('update', follow));
    if (source.awaiting(id)) host.await(id);
  }));
  stops.push(source.onArrive((id) => host.arrived(id)));
  return {
    host,
    stop: () => {
      for (const stop of stops.splice(0)) stop();
      host.destroy();
    },
  };
}

/** Review binds C; if binding C throws, it binds a copy of the body instead (§5). `built` sees C's records. */
export function reviewDoc(body: Y.Doc, composite: Composite, bind: (doc: Y.Doc) => void, seen?: (built: Built) => void): 'composite' | 'body' {
  const built = composite.build();
  try {
    bind(built.doc);
    seen?.(built);
    return 'composite';
  } catch {
    const plain = hydrate(body);
    attachViewPayloads(body, plain);
    bind(plain);
    return 'body';
  } finally {
    destroyView(built);
  }
}

export type ForkEvent =
  | { type: 'ready' }
  /** Paint changed: a part was proposed, acked or dropped, or a record of the author's changed. */
  | { type: 'change' }
  /** One of the author's records closed (§5: drop its undo items, rotate leases). */
  | { type: 'closed'; record: string; status: string; clients: number[] }
  /** F holds text of a closed record with nothing unacked: rebuild F. */
  | { type: 'rebuild' }
  /** Input closed: `unsaved` is each block holding a change the server never acknowledged. */
  | { type: 'refused'; reason: SuggestRefusal; unsaved: string[] }
  /**
   * A rewrite re-created these struck originals and their copies were removed: the step that moved them must never
   * restore them (an undo restore is a new block the editor has not bound yet), so undo of that step leaves them out.
   * `added`: characters that stood in for displaced originals, made just after that step was recorded (a second event):
   * undo of that step removes them with the rest of it.
   */
  | { type: 'kept'; originals: IdSpan[]; added: IdSpan[] };

/** A top-level block of the body: a paragraph-like element (XmlText) or a block decorator (XmlElement). */
export type Block = Y.XmlText | Y.XmlElement;

export interface ForkOptions {
  me: string;
  name?: string;
  send: (request: SuggestRequest) => void;
  now?: () => number;
  /** The markdown of these top-level blocks of F, or null for their plain text. */
  exportBlocks?: (blocks: Block[]) => string[] | null;
  check?: BindCheck;
}

interface Pending {
  request: SuggestRequest;
  /** A `suggest-ops` request's update, and the doc it was made in. */
  op?: RecordOp;
}

const isShim = (origin: unknown) => origin === SHIM_BODY_APPLY || origin === SHIM_RECORD_APPLY || origin === PAYLOAD_LOADED;

/** The fork's removal of re-created struck items: forwarded like any edit, never an undo step of the binding's. */
export const KEEP_STRIKES = 'suggest-keep-strikes';

const covers = (spans: readonly IdSpan[], client: number, clock: number) =>
  spans.some((span) => span.client === client && span.clock <= clock && clock < span.clock + span.len);

const idKey = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`;

function itemAt(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (id.clock >= Y.getState(doc.store, id.client)) return null;
  const struct = Y.getItem(doc.store, id);
  return struct instanceof Y.Item ? struct : null;
}

/** An item's index in its parent's sequence. */
function indexOf(item: Y.Item): number {
  let index = 0;
  for (let n = (item.parent as Y.AbstractType<unknown>)._start; n && n !== item; n = n.right) if (!n.deleted && n.countable) index += n.length;
  return index;
}

/** Deletes the live items at `ids` from their sequences. */
function removeItems(doc: Y.Doc, ids: readonly Y.ID[]): void {
  for (const id of ids) {
    const item = itemAt(doc, id);
    if (!item || item.deleted || item.parentSub !== null) continue;
    const parent = item.parent as Y.AbstractType<unknown>;
    const at = indexOf(item) + (item.countable ? id.clock - item.id.clock : 0);
    if (parent instanceof Y.XmlText || parent instanceof Y.XmlFragment) parent.delete(at, 1);
  }
}

/**
 * Stands fresh characters in for the live struck characters at `ids` (each the same text, at the same place), and
 * deletes the originals; returns the new items' ids.
 */
function replaceItems(doc: Y.Doc, ids: readonly Y.ID[]): IdSpan[] {
  const added: IdSpan[] = [];
  const sorted = [...ids].sort((x, y) => x.client - y.client || x.clock - y.clock);
  for (let i = 0; i < sorted.length;) {
    const item = itemAt(doc, sorted[i]);
    if (!item || item.deleted || !(item.content instanceof Y.ContentString) || !(item.parent instanceof Y.XmlText)) {
      i += 1;
      continue;
    }
    // A run within one item goes in one insert, so a surrogate pair stays whole.
    const from = sorted[i].clock - item.id.clock;
    let len = 1;
    for (; i + len < sorted.length && from + len < item.length; len += 1) {
      const id = sorted[i + len];
      if (id.client !== item.id.client || id.clock !== sorted[i].clock + len) break;
    }
    const at = indexOf(item) + from;
    const clock = Y.getState(doc.store, doc.clientID);
    item.parent.insert(at, item.content.str.slice(from, from + len));
    item.parent.delete(at + len, len);
    added.push({ client: doc.clientID, clock, len });
    i += len;
  }
  return added;
}

/**
 * What one transaction of F did to struck items, as the editor traced them (apps/web suggest/trace.ts): `copies` pairs
 * each new item standing where a struck character went with the original it copies; `displaced` names struck originals
 * the binding kept standing for other text (an equal character the same edit put where the original was).
 */
export interface Rewrites {
  copies: [copy: Y.ID, original: Y.ID][];
  displaced: Y.ID[];
}

/** The top-level block (a child of `root`) holding `type`, or null. */
function blockOf(doc: Y.Doc, type: Y.AbstractType<unknown> | null): Block | null {
  const root = doc.get('root', Y.XmlText);
  let current = type;
  while (current && current._item) {
    const parent = current._item.parent as Y.AbstractType<unknown>;
    if (parent === root) return current instanceof Y.XmlText || current instanceof Y.XmlElement ? current : null;
    current = parent;
  }
  return null;
}

/** A decorator's payload, read from the payload doc its `__regId` names. */
function payloadOfBlock(doc: Y.Doc, type: Block): string {
  const id = type.getAttribute('__regId');
  const payload = typeof id === 'string' ? payloadDocsFor(doc).get(id) : undefined;
  if (!payload) return '';
  const text = payloadText(payload).toString();
  const map = payloadMap(payload);
  return map.size ? JSON.stringify(map.toJSON()) : text;
}

/** Plain text of a block: its characters, nested blocks and decorator payloads. */
export function blockText(doc: Y.Doc, block: Block): string {
  if (block instanceof Y.XmlElement) return payloadOfBlock(doc, block);
  return (block.toDelta() as { insert: unknown }[])
    .map(({ insert }) => {
      if (typeof insert === 'string') return insert;
      if (insert instanceof Y.XmlElement) return payloadOfBlock(doc, insert);
      if (insert instanceof Y.XmlText) return insert.getAttribute('__regId') ? payloadOfBlock(doc, insert) : blockText(doc, insert);
      return '';
    })
    .join('');
}

/**
 * The top-level blocks of `doc` that `ops` insert into or delete from, or that hold a span of `spans`, in document
 * order. An op in a payload doc counts for every decorator naming that payload.
 */
export function touchedBlocks(doc: Y.Doc, ops: readonly RecordOp[], spans: readonly IdSpan[] = []): Block[] {
  const found = new Set<Block>();
  let refs: Map<string, Y.AbstractType<unknown>[]> | null = null;
  const add = (type: Y.AbstractType<unknown> | null) => {
    const block = blockOf(doc, type);
    if (block) found.add(block);
  };
  const note = (id: Y.ID) => {
    if (id.clock >= Y.getState(doc.store, id.client)) return;
    const struct = Y.getItem(doc.store, id);
    if (!(struct instanceof Y.Item)) return;
    add(struct.content instanceof Y.ContentType ? (struct.content.type as Y.AbstractType<unknown>) : (struct.parent as Y.AbstractType<unknown>));
  };
  for (const op of ops) {
    if (op.doc !== BODY_DOC) {
      refs ??= regRefs(doc);
      for (const type of refs.get(op.doc) ?? []) add(type);
      continue;
    }
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(op.update);
    } catch {
      continue;
    }
    for (const struct of decoded.structs) if (struct instanceof Y.Item) note(struct.id);
    for (const [client, ranges] of decoded.ds.clients) for (const { clock } of ranges) note(Y.createID(client, clock));
  }
  for (const span of spans) note(Y.createID(span.client, span.clock));
  const order = (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map(({ insert }) => insert);
  return [...found].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

let partSeq = 0;
const partId = () => `p${Date.now().toString(36)}${(partSeq += 1).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** A delete part's bytes as the DocDO will store it, before it reads the quote (at most 1,024 characters). */
const pendingPartBytes = (targets: readonly IdSpan[]): number =>
  partBytes({ id: partId(), kind: 'delete', targets: [...targets], quote: '' }) + 2 * Math.min(1024, targets.reduce((sum, span) => sum + span.len, 0));
/**
 * The fork F. `begin()` asks for leases; their reply fills F (bind the editor first, so it reconciles F like a first
 * sync) and starts forwarding. Replies arrive in request order through `receive`.
 */
export class SuggestFork {
  readonly doc = new Y.Doc();
  /** The active lease first, then spares. */
  #leases: LeaseGrant[] = [];
  /** Each lease this fork wrote under, by client: the record it names. */
  readonly #mine = new Map<number, string>();
  /** Leases that carried an op or a part: the next group takes a fresh one. */
  readonly #used = new Set<number>();
  /** Delete parts of the author's open records, proposed or acknowledged, by part id. */
  readonly #parts = new Map<string, { record: string; targets: IdSpan[] }>();
  /** Parts this fork proposed, and those it took back (the body holds a taken-back part until its undelete lands). */
  readonly #proposed = new Set<string>();
  readonly #withdrawn = new Set<string>();
  /** How many of each author record's ops F holds: another window's later ops enter F as they arrive. */
  readonly #applied = new Map<string, number>();
  #inflight: Pending[] = [];
  #waiting: Pending[] = [];
  readonly #listeners = new Set<(event: ForkEvent) => void>();
  readonly #closedSeen = new Set<string>();
  readonly #merged = new Set<string>();
  #asked = false;
  #leasing = false;
  #resuming = false;
  #ready = false;
  #closed = false;
  #disposed = false;
  #sent = 0;
  #lastEdit = 0;
  /** When each lease was last granted, resumed or written under. */
  readonly #touched = new Map<number, number>();
  #lastBlock = -1;
  #caretBlock = -1;
  /** Names this fork to the DocDO, so it can resume its leases from a new socket while the old one looks open there. */
  readonly #id = `f${[...crypto.getRandomValues(new Uint32Array(3))].map((n) => n.toString(36)).join('')}`;

  /** F's payload docs: copies of B's it touches and its own new ones, written under the same lease as F's body. */
  readonly #payloads: ReturnType<typeof derivedPayloads>;

  constructor(
    readonly body: Y.Doc,
    readonly options: ForkOptions,
  ) {
    registerFork(this.doc, this);
    this.#payloads = derivedPayloads(body, this.doc, SHIM_BODY_APPLY);
    this.#payloads.host.onHold((id, doc) => {
      doc.clientID = this.doc.clientID;
      doc.on('beforeTransaction', this.#before);
      doc.on('update', (update: Uint8Array, origin: unknown) => this.#forward(update, origin, id));
    });
    this.doc.on('beforeTransaction', this.#before);
    this.doc.on('afterTransaction', this.#keepStrikes);
    this.doc.on('update', this.#forwardBody);
    body.on('update', this.#fromBody);
  }

  /** F's payload docs. */
  get payloads(): PayloadDocs {
    return this.#payloads.host;
  }

  get ready(): boolean {
    return this.#ready;
  }

  /** Input is closed: a refusal, or the fork was disposed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** `suggest-ops` frames forwarded. */
  get sent(): number {
    return this.#sent;
  }

  get record(): string | null {
    return this.#leases[0]?.record ?? null;
  }

  on(listener: (event: ForkEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Asks for the leases F writes under. */
  begin(): void {
    if (this.#asked || this.#disposed) return;
    this.#asked = true;
    this.#leasing = true;
    this.#request({ t: 'suggest-lease', fork: this.#id });
  }

  /**
   * The socket came back: requests it never answered are replayed after the author's leases resume on the new
   * connection, and anything made meanwhile waits behind them, so the active record continues (§5 offline).
   */
  reconnected(): void {
    if (this.#disposed || this.#closed) return;
    const replay = this.#inflight.splice(0);
    if (!this.#ready) {
      this.#asked = false;
      this.#waiting = [];
      this.begin();
      return;
    }
    // Unanswered lease requests are not replayed: the resume mints spares.
    this.#waiting.unshift(...replay.filter((entry) => entry.request.t !== 'suggest-lease'));
    this.#leasing = false;
    this.#resuming = true;
    this.#send({ request: { t: 'suggest-lease', resume: this.#resumable(), fork: this.#id } });
  }

  /**
   * Only this fork's leases: another window of the author holds its own, and naming one would refuse the resume. Read
   * when the resume is sent, after the new socket's sync: the active and spare leases, every used lease whose record
   * the body shows open, and every lease an owed op is written under, whatever its record's status now. An op owed
   * to a record accepted meanwhile opens its continuation, and needs its lease to land.
   */
  #resumable(): number[] {
    const open = this.#openMine();
    const owed = new Set<number>();
    for (const { op } of [...this.#inflight, ...this.#waiting]) {
      if (!op) continue;
      try {
        for (const client of Y.parseUpdateMeta(op.update).from.keys()) owed.add(client);
      } catch {
        // An op F made always parses.
      }
    }
    return [...new Set([...this.#leases.map((lease) => lease.client), ...[...this.#used].filter((client) => open.has(client) || owed.has(client))])];
  }

  /** Requests are made that the server has not stored yet, sent or waiting to be: the session stays unacked. */
  get owes(): boolean {
    return !this.#closed && (this.#resuming || this.#waiting.length > 0 || this.#inflight.length > 0);
  }


  receive(reply: SuggestReply): void {
    if (this.#disposed) return;
    const entry = this.#inflight.shift();
    const resumed = entry?.request.t === 'suggest-lease' && entry.request.resume !== undefined;
    if (reply.t === 'suggest-leased') {
      if (resumed) {
        const fresh = new Map(reply.leases.map((lease) => [lease.client, lease]));
        const known = new Set(this.#leases.map((lease) => lease.client));
        this.#leases = this.#leases.map((lease) => fresh.get(lease.client) ?? lease);
        // A lease the resume minted beside the named ones is a spare, while F lacks one.
        for (const lease of reply.leases) {
          if (!known.has(lease.client) && !this.#used.has(lease.client) && this.#leases.length < 2) this.#leases.push(lease);
        }
        this.#touch(reply.leases);
        this.#resuming = false;
        this.#dropStored(new Map(reply.leases.map((lease) => [lease.client, lease.clocks ?? { [BODY_DOC]: lease.clock }])));
        this.#flush();
        return;
      }
      this.#leasing = false;
      this.#leases.push(...reply.leases);
      this.#touch(reply.leases);
      if (!this.#ready) this.#start();
      return;
    }
    if (reply.t === 'suggest-ack') {
      const request = entry?.request;
      if (request?.t === 'suggest-ops' || request?.t === 'suggest-delete') {
        if (reply.record !== reply.requested) this.#follow(reply.requested, reply.record);
      }
      this.#emit({ type: 'change' });
      return;
    }
    const request = entry?.request;
    if (request?.t === 'suggest-delete' && reply.reason === 'target') {
      this.#parts.delete(request.part.id);
      this.#emit({ type: 'change' });
      return;
    }
    // Taking back a part the record no longer holds changes nothing.
    if (request?.t === 'suggest-undelete' && reply.reason === 'target') return;
    if (request?.t === 'suggest-lease' && this.#ready && !resumed && reply.reason === 'lease-cap') {
      // No spare: the active group continues.
      this.#leasing = false;
      return;
    }
    if (this.#resuming) this.#resuming = false;
    this.#leasing = false;
    this.#halt(reply.reason, entry);
  }

  /**
   * Proposes deleting body items (never the author's own pending items, which delete natively). The text stays in F,
   * painted struck, and the caret moves past it (the caller moves it). Returns the part's id, or null.
   */
  proposeDelete(targets: IdSpan[]): string | null {
    if (!this.#ready || this.#closed || targets.length === 0) return null;
    this.#maybeRotate();
    const active = this.#leases[0];
    if (!active) return null;
    const id = partId();
    this.#parts.set(id, { record: active.record, targets });
    this.#proposed.add(id);
    this.#used.add(active.client);
    this.#mine.set(active.client, active.record);
    this.#lastEdit = this.#now();
    this.#lastBlock = this.#caretBlock;
    this.#request({ t: 'suggest-delete', record: active.record, part: { id, targets } });
    this.#emit({ type: 'change' });
    return id;
  }

  /** Takes back one of the author's delete parts (undo of a strike): `suggest-undelete`. */
  withdrawPart(part: string): boolean {
    const known = this.#parts.get(part);
    if (!known || !this.#ready || this.#closed) return false;
    this.#parts.delete(part);
    this.#withdrawn.add(part);
    this.#request({ t: 'suggest-undelete', record: known.record, partId: part });
    this.#emit({ type: 'change' });
    return true;
  }

  /** The targets of one of the author's parts, while it stands. */
  partTargets(part: string): IdSpan[] | null {
    return this.#parts.get(part)?.targets ?? null;
  }

  isStruck(id: { client: number; clock: number }): boolean {
    for (const { targets } of this.#parts.values()) if (covers(targets, id.client, id.clock)) return true;
    return false;
  }

  /** Every struck span: the author's open delete parts. */
  struck(): IdSpan[] {
    return [...this.#parts.values()].flatMap(({ targets }) => targets);
  }

  /** The leased clients of the author's open records and of this fork: items under them are the author's own. */
  ownClients(): Set<number> {
    const own = new Set<number>(this.#openMine().keys());
    for (const lease of this.#leases) own.add(lease.client);
    for (const record of openRecords(this.body, this.options.me)) for (const client of record.meta.clients) own.add(client);
    return own;
  }

  /** The caret's top-level block index: an edit more than one block from the last starts a new group. */
  caret(block: number): void {
    this.#caretBlock = block;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closed = true;
    this.body.off('update', this.#fromBody);
    this.doc.off('beforeTransaction', this.#before);
    this.doc.off('afterTransaction', this.#keepStrikes);
    this.doc.off('update', this.#forwardBody);
    this.#stopArrivals?.();
    this.#listeners.clear();
    this.#payloads.stop();
    this.doc.destroy();
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #emit(event: ForkEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  #send(entry: Pending): void {
    this.#inflight.push(entry);
    this.options.send(entry.request);
  }

  #request(request: SuggestRequest, op?: RecordOp): void {
    const active = this.#leases[0];
    if (request.t !== 'suggest-lease' && this.#ready && !this.#resuming && active && this.#now() - (this.#touched.get(active.client) ?? 0) >= LEASE_RENEW_MS) {
      // The active lease may have idled out on the DocDO: resume the leases on this connection first.
      this.#resuming = true;
      this.#send({ request: { t: 'suggest-lease', resume: this.#resumable(), fork: this.#id } });
    }
    const entry = { request, op };
    if (this.#resuming) this.#waiting.push(entry);
    else this.#send(entry);
  }

  #touch(leases: readonly { client: number }[]): void {
    const now = this.#now();
    for (const lease of leases) this.#touched.set(lease.client, now);
  }

  #flush(): void {
    const waiting = this.#waiting.splice(0);
    for (const entry of waiting) this.#send(entry);
  }

  /**
   * After a resume, drops replays the DocDO already stored (their ack was lost with the socket): an op whose every
   * clock is below its lease's acknowledged clock in the op's doc, and a part the author's records already hold.
   */
  #dropStored(acked: ReadonlyMap<number, Readonly<Record<string, number>>>): void {
    let parts: Set<string> | null = null;
    this.#waiting = this.#waiting.filter(({ request, op }) => {
      if (request.t === 'suggest-ops' && op) {
        let to: Map<number, number>;
        try {
          to = Y.parseUpdateMeta(op.update).to;
        } catch {
          return true;
        }
        return to.size === 0 || [...to].some(([client, clock]) => clock > (ownValue(acked.get(client) ?? {}, op.doc) ?? 0));
      }
      if (request.t === 'suggest-delete') {
        parts ??= new Set(openRecords(this.body, this.options.me).flatMap((record) => record.parts.map((part) => part.id)));
        return !parts.has(request.part.id);
      }
      return true;
    });
  }

  #setClient(client: number): void {
    this.doc.clientID = client;
    for (const payload of this.#payloads.host.docs.values()) payload.clientID = client;
  }

  /** F's copy of payload `id`, held now; undefined while B's is still arriving from the server. */
  #payload(id: string): Y.Doc | undefined {
    const doc = this.#payloads.host.hold(id);
    return this.#payloads.host.awaiting(id) ? undefined : doc;
  }

  #stopArrivals: (() => void) | null = null;

  /**
   * F: B, then the author's valid open records, then forwarding starts. Payloads those records edit are copied from B
   * first; while one is still arriving, F waits for it.
   */
  #start(): void {
    const active = this.#leases[0];
    if (!active || this.#ready || this.#disposed) return;
    const own = openRecords(this.body, this.options.me);
    let named: Map<string, unknown> | null = null;
    const missing = own.flatMap(payloadIdsOf).filter((id) => {
      if (!payloadDocsFor(this.body).get(id) && !(named ??= regRefs(this.body)).has(id)) return false;
      return this.#payload(id) === undefined;
    });
    if (missing.length) {
      this.#stopArrivals ??= this.#payloads.host.onArrive(() => this.#start());
      return;
    }
    this.#stopArrivals?.();
    this.#stopArrivals = null;
    this.#setClient(active.client);
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.body), SHIM_BODY_APPLY);
    const built = new Composite(this.body, { author: this.options.me, check: this.options.check }).build();
    destroyView(built);
    const valid = new Set(built.valid);
    for (const record of own) {
      if (!valid.has(record.meta.id)) continue;
      for (const op of record.ops) this.#applyOp(op, SHIM_RECORD_APPLY);
      this.#applied.set(record.meta.id, record.ops.length);
      for (const client of record.meta.clients) this.#mine.set(client, record.meta.id);
      for (const part of record.parts) this.#parts.set(part.id, { record: record.meta.id, targets: part.targets });
    }
    this.#ready = true;
    this.#emit({ type: 'ready' });
  }

  #applyOp(op: RecordOp, origin: unknown): void {
    Y.applyUpdate(op.doc === BODY_DOC ? this.doc : this.#payloads.host.hold(op.doc), op.update, origin);
  }

  /** The author's records this fork knows that are still open, by client. */
  #openMine(): Map<number, string> {
    const open = new Map<number, string>();
    for (const [client, record] of this.#mine) {
      const meta = readMeta(this.body, record);
      if (!meta || meta.status === 'open') open.set(client, record);
    }
    return open;
  }

  /** A frame for `from` landed in `to` (a continuation, or a record it merged into): its leases and parts move too. */
  #follow(from: string, to: string): void {
    for (const lease of this.#leases) if (lease.record === from) lease.record = to;
    for (const [client, record] of this.#mine) if (record === from) this.#mine.set(client, to);
    for (const part of this.#parts.values()) if (part.record === from) part.record = to;
  }

  /** Whether the next edit starts a new group: idle, or more than one block from the last. */
  #rotates(): boolean {
    const active = this.#leases[0];
    if (!active || !this.#used.has(active.client) || this.#leases.length < 2) return false;
    const idle = this.#now() - this.#lastEdit > GROUP_IDLE_MS;
    const away = this.#caretBlock >= 0 && this.#lastBlock >= 0 && Math.abs(this.#caretBlock - this.#lastBlock) > 1;
    return idle || away;
  }

  #maybeRotate(): void {
    if (this.#rotates()) this.#rotate();
  }

  /**
   * Whether an edit adding `bytes` of ops, and with `strike` a delete part of those targets, fits every cap the DocDO
   * checks it against, counted as it counts them: the record the edit writes (what the body shows of it and what is
   * still unanswered, and the same of every older open record of the author's it would merge), all open records' ops,
   * the author's open records, the part's spans. `blocks`: the top-level blocks the edit spans (the caret's by
   * default). Null when it fits, else the refusal it would meet. Some headroom on the record: an edit's ops encode a
   * little larger than a replay measures.
   */
  admit(bytes: number, strike?: readonly IdSpan[], blocks?: { from: number; to: number }): SuggestRefusal | null {
    if (!this.#ready || this.#closed) return 'record-closed';
    const lease = this.#rotates() ? this.#leases[1] : this.#leases[0];
    if (!lease) return 'lease';
    let adds = bytes;
    if (strike?.length) {
      const items = strike.reduce((sum, span) => sum + span.len, 0);
      if (strike.length > SUGGEST_LIMITS.partSpans || items > SUGGEST_LIMITS.partItems) return 'target';
      adds += pendingPartBytes(strike);
    }
    const pending = new Map<string, number>();
    for (const { request, op } of [...this.#inflight, ...this.#waiting]) {
      if (request.t === 'suggest-ops' && op) pending.set(request.record, (pending.get(request.record) ?? 0) + op.update.byteLength);
      if (request.t === 'suggest-delete') pending.set(request.record, (pending.get(request.record) ?? 0) + pendingPartBytes(request.part.targets));
    }
    const held = (id: string) => {
      const record = readRecord(this.body, id);
      return (record ? recordBytes(record) : 0) + (pending.get(id) ?? 0);
    };
    const stored = readRecord(this.body, lease.record);
    let total = held(lease.record) + adds;
    for (const other of this.#mergedBy(lease.record, blocks ?? { from: this.#caretBlock, to: this.#caretBlock })) total += held(other);
    if (total > SUGGEST_LIMITS.recordOpsBytes * 0.9) return 'record-cap';
    let open = [...pending.values()].reduce((sum, add) => sum + add, 0);
    for (const id of recordIds(this.body)) {
      const record = readMeta(this.body, id)?.status === 'open' ? readRecord(this.body, id) : null;
      if (record) open += recordBytes(record);
    }
    if (open + adds > STATE_CAP_BYTES * SUGGEST_LIMITS.openOpsShare) return 'ops-cap';
    const creates = !stored && !pending.has(lease.record);
    if (creates && openRecords(this.body, this.options.me).length >= SUGGEST_LIMITS.openPerPrincipal) return 'open-cap';
    return null;
  }

  /**
   * The author's open records other than `into` that an edit in top-level blocks `from`..`to` may build on or delete,
   * and so merge into its record (#forward): any holding an item of those blocks, or an item of the root from the block
   * before them to the block after. Every block when the blocks are unknown.
   */
  #mergedBy(into: string, { from, to }: { from: number; to: number }): Set<string> {
    const found = new Set<string>();
    const mine = this.#openMine();
    for (const record of openRecords(this.body, this.options.me)) for (const client of record.meta.clients) mine.set(client, record.meta.id);
    if (mine.size === 0) return found;
    const see = (item: Y.Item) => {
      const record = mine.get(item.id.client);
      if (record && record !== into) found.add(record);
    };
    const walk = (type: Y.AbstractType<unknown>) => {
      const visit = (item: Y.Item) => {
        see(item);
        if (item.content instanceof Y.ContentType) walk(item.content.type as Y.AbstractType<unknown>);
      };
      for (let item = type._start; item; item = item.right) visit(item);
      for (const last of type._map.values()) for (let item: Y.Item | null = last; item; item = item.left) visit(item);
    };
    const root = this.doc.get('root', Y.XmlText);
    const every = from < 0 || to < 0;
    let index = -1;
    for (let item = root._start; item; item = item.right) {
      const block = !item.deleted && item.content instanceof Y.ContentType;
      if (block) index += 1;
      // A tombstone or a format between blocks sits after the block before it.
      const at = block ? index : index + 0.5;
      if (!every && (at < from - 1 || at > to + 1)) continue;
      see(item);
      if (block && (every || (index >= from && index <= to))) walk((item.content as Y.ContentType).type as Y.AbstractType<unknown>);
    }
    return found;
  }

  /** The next group: the spare lease becomes active, and a new spare is asked for. */
  #rotate(): void {
    if (this.#leases.length < 2) return;
    this.#leases.shift();
    this.#setClient(this.#leases[0].client);
    if (this.#leases.length < 2 && !this.#leasing) {
      this.#leasing = true;
      this.#request({ t: 'suggest-lease', fork: this.#id });
    }
  }

  readonly #before = (tr: Y.Transaction): void => {
    if (isShim(tr.origin) || !this.#ready || this.#closed) return;
    this.#maybeRotate();
  };

  /** Re-created struck items, by id: the struck original each one copies. */
  readonly #copyOf = new Map<string, { copy: Y.ID; original: Y.ID }>();
  /** The editor's trace of what a transaction did to struck items. */
  #rewrites: ((tr: Y.Transaction) => Rewrites | null) | null = null;

  /** The bound editor reports, per transaction, the copies of struck items it wrote (trace.ts); returns the stopper. */
  traceRewrites(find: (tr: Y.Transaction) => Rewrites | null): () => void {
    this.#rewrites = find;
    return () => {
      if (this.#rewrites === find) this.#rewrites = null;
    };
  }

  /**
   * A native rewrite (a join, an unwrap, a paste, a retyped block, a split, the undo or redo of one) re-creates the text
   * it moves under new ids, struck characters too. The strike is F's data, not a guess at the rewrite: each item a
   * transaction inserts as the copy of a struck original is removed again at once, in a transaction of its own that is
   * forwarded like any edit, so the record inserts and deletes the copy, and the delete part keeps naming the original.
   * A copy is found from the data: an undo's restore points at it (`redone`), and the editor traces where each struck
   * character went through its own text operations (`traceRewrites`). A struck original the binding kept standing for
   * other text is replaced there by a fresh character, so that text stays and the original goes.
   */
  readonly #keepStrikes = (tr: Y.Transaction): void => {
    if (isShim(tr.origin) || tr.origin === KEEP_STRIKES || !this.#ready || this.#closed || this.#parts.size === 0) return;
    const traced = this.#rewrites?.(tr) ?? null;
    const inserted = [...tr.afterState].some(([client, clock]) => clock > (tr.beforeState.get(client) ?? 0));
    if (!inserted) return;
    const own = this.ownClients();
    const struckOriginal = (id: Y.ID): Y.ID | null => {
      const original = this.#copyOf.get(idKey(id))?.original ?? id;
      return !own.has(original.client) && this.isStruck(original) ? original : null;
    };
    const fresh = (id: Y.ID) => id.clock >= (tr.beforeState.get(id.client) ?? 0) && id.clock < (tr.afterState.get(id.client) ?? 0);
    const copies = new Map<string, { copy: Y.ID; original: Y.ID }>();
    const keep = (copy: Y.ID, original: Y.ID) => {
      if (itemAt(this.doc, copy)?.deleted === false) copies.set(idKey(copy), { copy, original });
    };
    // Restores: a struck original, or an earlier copy of one, whose `redone` names an item this transaction made.
    const struckIds: Y.ID[] = [];
    for (const { targets } of this.#parts.values()) {
      for (const span of targets) for (let i = 0; i < span.len; i += 1) struckIds.push(Y.createID(span.client, span.clock + i));
    }
    for (const id of [...struckIds, ...[...this.#copyOf.values()].map(({ copy }) => copy)]) {
      const item = itemAt(this.doc, id);
      if (!item?.redone) continue;
      const copy = Y.createID(item.redone.client, item.redone.clock + id.clock - item.id.clock);
      const original = struckOriginal(id);
      if (original && fresh(copy)) keep(copy, original);
    }
    // Rewrites: where the editor carried each struck character.
    for (const [copy, original] of traced?.copies ?? []) {
      const struck = struckOriginal(original);
      if (struck && fresh(copy)) keep(copy, struck);
    }
    const displaced = (traced?.displaced ?? []).filter((id) => !own.has(id.client) && this.isStruck(id) && itemAt(this.doc, id)?.deleted === false);
    if (copies.size === 0 && displaced.length === 0) return;
    for (const entry of copies.values()) this.#copyOf.set(idKey(entry.copy), entry);
    const originals = [...copies.values()].map(({ original }) => original).sort((x, y) => x.client - y.client || x.clock - y.clock);
    const spans: IdSpan[] = [];
    for (const { client, clock } of originals) {
      const last = spans.at(-1);
      if (last && last.client === client && last.clock + last.len === clock) last.len += 1;
      else if (!last || last.client !== client || last.clock + last.len < clock) spans.push({ client, clock, len: 1 });
    }
    if (copies.size) this.doc.transact(() => removeItems(this.doc, [...copies.values()].map(({ copy }) => copy)), KEEP_STRIKES);
    // Still inside the rewrite's transaction: the undo manager records its step after this.
    this.#emit({ type: 'kept', originals: spans, added: [] });
    if (displaced.length === 0) return;
    // After the rewrite's update is sent: an insert made now would also be encoded into it (Yjs writes every struct
    // past the transaction's before-state), and the record would receive the same ids twice.
    this.doc.once('afterAllTransactions', () => {
      if (this.#closed) return;
      let added: IdSpan[] = [];
      this.doc.transact(() => {
        added = replaceItems(this.doc, displaced);
      }, KEEP_STRIKES);
      if (added.length) this.#emit({ type: 'kept', originals: [], added });
    });
  };

  /** One F transaction, in the body or in payload `doc`: a `suggest-ops` under the active lease. */
  readonly #forwardBody = (update: Uint8Array, origin: unknown): void => this.#forward(update, origin, BODY_DOC);

  readonly #forward = (update: Uint8Array, origin: unknown, doc: string): void => {
    if (isShim(origin) || !this.#ready || this.#closed) return;
    const active = this.#leases[0];
    if (!active) return;
    this.#used.add(active.client);
    this.#mine.set(active.client, active.record);
    this.#lastEdit = this.#now();
    this.#lastBlock = this.#caretBlock;
    this.#sent += 1;
    const request: SuggestRequest = doc === BODY_DOC
      ? { t: 'suggest-ops', record: active.record, update: bytesToBase64(update) }
      : { t: 'suggest-ops', record: active.record, doc, update: bytesToBase64(update) };
    this.#request(request, { doc, update });
    this.#touch([active]);
    // An edit that builds on another of the author's open records joins it, or accept would fail G1 (§5).
    for (const other of this.#named(update)) {
      if (other === active.record || this.#merged.has(other)) continue;
      this.#merged.add(other);
      this.#request({ t: 'suggest-merge', into: active.record, from: other });
    }
  };

  /** The author's other open records whose items `update` builds on or deletes. */
  #named(update: Uint8Array): Set<string> {
    const named = new Set<string>();
    const mine = this.#openMine();
    for (const record of openRecords(this.body, this.options.me)) for (const client of record.meta.clients) mine.set(client, record.meta.id);
    if (mine.size === 0) return named;
    const see = (id: Y.ID | null) => {
      const record = id && mine.get(id.client);
      if (record) named.add(record);
    };
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(update);
    } catch {
      return named;
    }
    for (const struct of decoded.structs) {
      if (!(struct instanceof Y.Item)) continue;
      see(struct.origin);
      see(struct.rightOrigin);
      if (struct.parent instanceof Y.ID) see(struct.parent);
    }
    for (const client of decoded.ds.clients.keys()) see(Y.createID(client, 0));
    return named;
  }

  readonly #fromBody = (update: Uint8Array): void => {
    if (!this.#ready || this.#disposed) return;
    Y.applyUpdate(this.doc, update, SHIM_BODY_APPLY);
    let changed = false;
    const queue = [...new Set([...this.#mine.values(), ...[...this.#parts.values()].map((part) => part.record)])];
    for (let i = 0; i < queue.length; i += 1) {
      const record = queue[i];
      if (this.#closedSeen.has(record)) continue;
      const meta = readMeta(this.body, record);
      if (!meta || meta.status === 'open') continue;
      this.#closedSeen.add(record);
      changed = true;
      if (meta.mergedInto) {
        // The server moved its ops and parts into the record it merged into; they stay pending there.
        this.#follow(record, meta.mergedInto);
        queue.push(meta.mergedInto);
        continue;
      }
      for (const [id, part] of this.#parts) if (part.record === record) this.#parts.delete(id);
      this.#emit({ type: 'closed', record, status: meta.status, clients: meta.clients });
      if (meta.status === 'accepted') {
        // Accepted text is body text now; the next edit writes a fresh group.
        if (this.#leases[0]?.record === record) this.#rotate();
        continue;
      }
      const owes = [...this.#inflight, ...this.#waiting].some(({ request }) =>
        (request.t === 'suggest-ops' || request.t === 'suggest-delete') && request.record === record);
      if (owes) this.#halt('record-closed');
      else if (!this.#closed) this.#emit({ type: 'rebuild' });
    }
    if (!this.#closed && this.#absorb()) changed = true;
    if (changed) this.#emit({ type: 'change' });
  };

  /**
   * Every open record of the author, from any of the author's windows, as it grows: ops F lacks enter F once they pass
   * G1–G3 and the bind check on scratch copies, and the record's parts paint. A record that does not pass yet, or
   * edits a payload still arriving, is retried on the next update.
   */
  #absorb(): boolean {
    let changed = false;
    for (const record of openRecords(this.body, this.options.me)) {
      const id = record.meta.id;
      const known = this.#applied.get(id);
      if (known === undefined || record.ops.length > known) {
        const fresh = record.ops.slice(known ?? 0).filter((op) => this.#adds(op));
        if (fresh.length > 0) {
          const ids = payloadIdsOf({ ...record, ops: fresh });
          if (ids.some((payload) => this.#payload(payload) === undefined)) continue;
          const scratch = applyForView(this.doc, { ...record, ops: fresh }, this.options.check, (payload) => this.#payloads.host.get(payload));
          if (!scratch) continue;
          destroyView(scratch);
          for (const op of fresh) this.#applyOp(op, SHIM_RECORD_APPLY);
          changed = true;
        }
        this.#applied.set(id, record.ops.length);
      }
      for (const client of record.meta.clients) if (!this.#mine.has(client)) this.#mine.set(client, id);
      const held = new Set(record.parts.map((part) => part.id));
      for (const part of record.parts) {
        if (this.#parts.has(part.id) || this.#withdrawn.has(part.id)) continue;
        this.#parts.set(part.id, { record: id, targets: part.targets });
        changed = true;
      }
      // Another window took a part back.
      for (const [part, entry] of this.#parts) {
        if (entry.record === id && !held.has(part) && !this.#proposed.has(part)) {
          this.#parts.delete(part);
          changed = true;
        }
      }
    }
    return changed;
  }

  /** Whether `op` inserts an item F lacks or deletes one F still shows, in the doc it was made in. */
  #adds(op: RecordOp): boolean {
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(op.update);
    } catch {
      return true;
    }
    const doc = op.doc === BODY_DOC ? this.doc : this.#payloads.host.get(op.doc);
    if (!doc) return true;
    const store = doc.store;
    for (const struct of decoded.structs) {
      if (!(struct instanceof Y.Skip) && struct.id.clock + struct.length > Y.getState(store, struct.id.client)) return true;
    }
    for (const [client, ranges] of decoded.ds.clients) {
      for (const { clock, len } of ranges) {
        for (let at = clock; at < clock + len; ) {
          if (at >= Y.getState(store, client)) return true;
          const item = Y.getItem(store, Y.createID(client, at));
          if (!item.deleted) return true;
          at = item.id.clock + item.length;
        }
      }
    }
    return false;
  }

  /**
   * Closes input in this tick and offers back every block holding a change the server never acknowledged: the
   * refused request's own, and everything still in flight or waiting behind it.
   */
  #halt(reason: SuggestRefusal, refused?: Pending): void {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...(refused ? [refused] : []), ...this.#inflight, ...this.#waiting];
    const ops = entries.flatMap((entry) => (entry.op ? [entry.op] : []));
    const spans = entries.flatMap(({ request }) => (request.t === 'suggest-delete' ? request.part.targets : []));
    const blocks = touchedBlocks(this.doc, ops, spans);
    const unsaved = this.options.exportBlocks?.(blocks) ?? blocks.map((block) => blockText(this.doc, block));
    this.#emit({ type: 'refused', reason, unsaved: unsaved.filter((text) => text.trim().length > 0) });
  }
}

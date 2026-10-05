// The suggest-mode client (docs/design/suggestions.md §5), Lexical-free so it runs headless in tests: the fork F (the
// body B plus the author's own valid open records, written under the active lease) and the composite C (B plus every
// valid open record). F forwards every transaction whose origin is not one of its own as `suggest-ops`; it never
// writes B. A record enters F or C only after G1–G3 and the headless bind check pass on a scratch copy.
import * as Y from 'yjs';
import { BODY_ROOTS, hydrate, regRefs, type Inserted, type SuggestionRecord } from '@moss-multi/core/suggest/apply';
import type { IdSpan, LeaseGrant, SuggestReply, SuggestRefusal, SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64 } from '@moss-multi/protocol/sync';
import { readMeta, readRecord, recordIds } from './records.ts';
import { bindCheck } from './review.ts';

export const SHIM_BODY_APPLY = 'shim-body-apply';
export const SHIM_RECORD_APPLY = 'shim-record-apply';
const VIEW_APPLY = 'suggest-view';

/** A new group starts after this long without an edit (§5 grouping). */
export const GROUP_IDLE_MS = 30_000;

export type BindCheck = (doc: Y.Doc, inserted: Inserted) => boolean;

/** Open records, oldest first; only `author`'s when given. */
export function openRecords(body: Y.Doc, author?: string): SuggestionRecord[] {
  const records: SuggestionRecord[] = [];
  for (const id of recordIds(body)) {
    const record = readRecord(body, id);
    if (record && record.meta.status === 'open' && (author === undefined || record.meta.author === author)) records.push(record);
  }
  return records.sort((a, b) => a.meta.createdAt - b.meta.createdAt || (a.meta.id < b.meta.id ? -1 : 1));
}

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

/**
 * `base` plus the record's ops on a gc-free scratch copy, or null when the record fails G1 (nothing parked), G2 (only
 * its leased clients advance), G3 (only `root` and `registers` change) or the bind check. Delete parts are not
 * applied: they paint as strikes. Never touches `base`.
 */
export function applyForView(base: Y.Doc, record: SuggestionRecord, check: BindCheck = bindCheck): Y.Doc | null {
  const scratch = hydrate(base);
  const fail = () => {
    scratch.destroy();
    return null;
  };
  const before = Y.decodeStateVector(Y.encodeStateVector(scratch));
  let transaction: Y.Transaction | null = null;
  try {
    scratch.transact((tr) => {
      transaction = tr;
      for (const op of record.ops) Y.applyUpdate(scratch, op);
    }, VIEW_APPLY);
  } catch {
    return fail();
  }
  const tr = transaction as Y.Transaction | null;
  if (!tr || scratch.store.pendingStructs !== null || scratch.store.pendingDs !== null) return fail();
  const clients = new Set(record.meta.clients);
  const inserted = new Map<number, readonly [number, number]>();
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(scratch))) {
    const from = before.get(client) ?? 0;
    if (clock <= from) continue;
    if (!clients.has(client)) return fail();
    inserted.set(client, [from, clock]);
  }
  for (const type of tr.changed.keys()) {
    const name = rootName(scratch, type as unknown as Y.AbstractType<unknown>);
    if (name === null || !BODY_ROOTS.has(name)) return fail();
  }
  try {
    if (!check(scratch, inserted)) return fail();
  } catch {
    return fail();
  }
  return scratch;
}

export interface Built {
  /** C: B plus every valid open record's ops, gc-free. The caller destroys it. */
  doc: Y.Doc;
  valid: string[];
  broken: string[];
  /** Each valid record's leased clients. */
  clients: Map<number, string>;
}

/** The composite C, built on demand from B's records. Bind-check verdicts are kept per record and op count. */
export class Composite {
  readonly #verdicts = new Map<string, { ops: number; ok: boolean }>();

  constructor(
    readonly body: Y.Doc,
    readonly options: { author?: string; check?: BindCheck } = {},
  ) {}

  build(): Built {
    let doc = hydrate(this.body);
    const valid: string[] = [];
    const broken: string[] = [];
    const clients = new Map<number, string>();
    for (const record of openRecords(this.body, this.options.author)) {
      const id = record.meta.id;
      const check: BindCheck = (scratch, inserted) => {
        const known = this.#verdicts.get(id);
        if (known && known.ops === record.ops.length) return known.ok;
        const ok = (this.options.check ?? bindCheck)(scratch, inserted);
        this.#verdicts.set(id, { ops: record.ops.length, ok });
        return ok;
      };
      const next = applyForView(doc, record, check);
      if (!next) {
        broken.push(id);
        continue;
      }
      doc.destroy();
      doc = next;
      valid.push(id);
      for (const client of record.meta.clients) clients.set(client, id);
    }
    return { doc, valid, broken, clients };
  }
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
    bind(plain);
    return 'body';
  } finally {
    built.doc.destroy();
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
  | { type: 'refused'; reason: SuggestRefusal; unsaved: string[] };

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
  update?: Uint8Array;
}

const isShim = (origin: unknown) => origin === SHIM_BODY_APPLY || origin === SHIM_RECORD_APPLY;

const covers = (spans: readonly IdSpan[], client: number, clock: number) =>
  spans.some((span) => span.client === client && span.clock <= clock && clock < span.clock + span.len);

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

/** The registers key an item sits under (an entry, or anything inside one), or null outside `registers`. */
function registerKey(doc: Y.Doc, item: Y.Item): string | null {
  const registers = doc.getMap('registers') as unknown as Y.AbstractType<unknown>;
  for (let current: Y.Item | null = item; current; ) {
    const parent = current.parent as Y.AbstractType<unknown>;
    if (parent === registers) return current.parentSub;
    current = parent._item;
  }
  return null;
}

/** A decorator's payload, read from the register its `__regId` names. */
function registerText(doc: Y.Doc, type: Block): string {
  const id = type.getAttribute('__regId');
  const value = typeof id === 'string' ? doc.getMap('registers').get(id) : undefined;
  if (value instanceof Y.Text) return value.toString();
  if (value instanceof Y.AbstractType) return JSON.stringify(value.toJSON());
  return typeof value === 'string' ? value : '';
}

/** Plain text of a block: its characters, nested blocks and decorator payloads. */
export function blockText(doc: Y.Doc, block: Block): string {
  if (block instanceof Y.XmlElement) return registerText(doc, block);
  return (block.toDelta() as { insert: unknown }[])
    .map(({ insert }) => {
      if (typeof insert === 'string') return insert;
      if (insert instanceof Y.XmlElement) return registerText(doc, insert);
      if (insert instanceof Y.XmlText) return insert.getAttribute('__regId') ? registerText(doc, insert) : blockText(doc, insert);
      return '';
    })
    .join('');
}

/**
 * The top-level blocks of `doc` that `updates` insert into or delete from, or that hold a span of `spans`, in
 * document order. An edit inside a register counts for every decorator naming it.
 */
export function touchedBlocks(doc: Y.Doc, updates: readonly Uint8Array[], spans: readonly IdSpan[] = []): Block[] {
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
    const key = registerKey(doc, struct);
    if (key !== null) {
      refs ??= regRefs(doc);
      for (const type of refs.get(key) ?? []) add(type);
      return;
    }
    add(struct.content instanceof Y.ContentType ? (struct.content.type as Y.AbstractType<unknown>) : (struct.parent as Y.AbstractType<unknown>));
  };
  for (const update of updates) {
    let decoded: ReturnType<typeof Y.decodeUpdate>;
    try {
      decoded = Y.decodeUpdate(update);
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
  #lastBlock = -1;
  #caretBlock = -1;
  /** Names this fork to the DocDO, so it can resume its leases from a new socket while the old one looks open there. */
  readonly #id = `f${[...crypto.getRandomValues(new Uint32Array(3))].map((n) => n.toString(36)).join('')}`;

  constructor(
    readonly body: Y.Doc,
    readonly options: ForkOptions,
  ) {
    this.doc.on('beforeTransaction', this.#before);
    this.doc.on('update', this.#forward);
    body.on('update', this.#fromBody);
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
    // Only this fork's leases: another window of the author holds its own, and naming one would refuse the resume.
    const open = this.#openMine();
    const resume = [...new Set([...this.#leases.map((lease) => lease.client), ...[...this.#used].filter((client) => open.has(client))])];
    this.#waiting.unshift(...replay.filter((entry) => entry.request.t !== 'suggest-lease'));
    this.#resuming = true;
    this.#send({ request: { t: 'suggest-lease', resume, fork: this.#id } });
  }

  /** Requests are made that the server has not stored yet, sent or waiting to be: the session stays unacked. */
  get owes(): boolean {
    return !this.#closed && (this.#resuming || this.#waiting.length > 0 || this.#inflight.length > 0);
  }


  receive(reply: SuggestReply): void {
    if (this.#disposed) return;
    const entry = this.#inflight.shift();
    if (reply.t === 'suggest-leased') {
      this.#leasing = false;
      if (this.#resuming) {
        const fresh = new Map(reply.leases.map((lease) => [lease.client, lease]));
        this.#leases = this.#leases.map((lease) => fresh.get(lease.client) ?? lease);
        this.#resuming = false;
        this.#dropStored(new Map(reply.leases.map((lease) => [lease.client, lease.clock])));
        this.#flush();
        return;
      }
      this.#leases.push(...reply.leases);
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
    if (request?.t === 'suggest-lease' && this.#ready && !this.#resuming && reply.reason === 'lease-cap') {
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
    this.doc.off('update', this.#forward);
    this.#listeners.clear();
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

  #request(request: SuggestRequest, update?: Uint8Array): void {
    const entry = { request, update };
    if (this.#resuming) this.#waiting.push(entry);
    else this.#send(entry);
  }

  #flush(): void {
    const waiting = this.#waiting.splice(0);
    for (const entry of waiting) this.#send(entry);
  }

  /**
   * After a resume, drops replays the DocDO already stored (their ack was lost with the socket): an op whose every
   * clock is below its lease's acknowledged clock, and a part the author's records already hold.
   */
  #dropStored(acked: ReadonlyMap<number, number>): void {
    let parts: Set<string> | null = null;
    this.#waiting = this.#waiting.filter(({ request, update }) => {
      if (request.t === 'suggest-ops' && update) {
        let to: Map<number, number>;
        try {
          to = Y.parseUpdateMeta(update).to;
        } catch {
          return true;
        }
        return to.size === 0 || [...to].some(([client, clock]) => clock > (acked.get(client) ?? 0));
      }
      if (request.t === 'suggest-delete') {
        parts ??= new Set(openRecords(this.body, this.options.me).flatMap((record) => record.parts.map((part) => part.id)));
        return !parts.has(request.part.id);
      }
      return true;
    });
  }

  /** F: B, then the author's valid open records, then forwarding starts. */
  #start(): void {
    const active = this.#leases[0];
    if (!active) return;
    this.doc.clientID = active.client;
    Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(this.body), SHIM_BODY_APPLY);
    const own = new Composite(this.body, { author: this.options.me, check: this.options.check }).build();
    own.doc.destroy();
    const valid = new Set(own.valid);
    for (const record of openRecords(this.body, this.options.me)) {
      if (!valid.has(record.meta.id)) continue;
      for (const op of record.ops) Y.applyUpdate(this.doc, op, SHIM_RECORD_APPLY);
      for (const client of record.meta.clients) this.#mine.set(client, record.meta.id);
      for (const part of record.parts) this.#parts.set(part.id, { record: record.meta.id, targets: part.targets });
    }
    this.#ready = true;
    this.#emit({ type: 'ready' });
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

  #maybeRotate(): void {
    const active = this.#leases[0];
    if (!active || !this.#used.has(active.client) || this.#leases.length < 2) return;
    const idle = this.#now() - this.#lastEdit > GROUP_IDLE_MS;
    const away = this.#caretBlock >= 0 && this.#lastBlock >= 0 && Math.abs(this.#caretBlock - this.#lastBlock) > 1;
    if (!idle && !away) return;
    this.#rotate();
  }

  /** The next group: the spare lease becomes active, and a new spare is asked for. */
  #rotate(): void {
    if (this.#leases.length < 2) return;
    this.#leases.shift();
    this.doc.clientID = this.#leases[0].client;
    if (this.#leases.length < 2 && !this.#leasing) {
      this.#leasing = true;
      this.#request({ t: 'suggest-lease', fork: this.#id });
    }
  }

  readonly #before = (tr: Y.Transaction): void => {
    if (isShim(tr.origin) || !this.#ready || this.#closed) return;
    this.#maybeRotate();
  };

  readonly #forward = (update: Uint8Array, origin: unknown): void => {
    if (isShim(origin) || !this.#ready || this.#closed) return;
    const active = this.#leases[0];
    if (!active) return;
    this.#used.add(active.client);
    this.#mine.set(active.client, active.record);
    this.#lastEdit = this.#now();
    this.#lastBlock = this.#caretBlock;
    this.#sent += 1;
    this.#request({ t: 'suggest-ops', record: active.record, update: bytesToBase64(update) }, update);
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
    if (changed) this.#emit({ type: 'change' });
  };

  /**
   * Closes input in this tick and offers back every block holding a change the server never acknowledged: the
   * refused request's own, and everything still in flight or waiting behind it.
   */
  #halt(reason: SuggestRefusal, refused?: Pending): void {
    if (this.#closed) return;
    this.#closed = true;
    const entries = [...(refused ? [refused] : []), ...this.#inflight, ...this.#waiting];
    const updates = entries.flatMap((entry) => (entry.update ? [entry.update] : []));
    const spans = entries.flatMap(({ request }) => (request.t === 'suggest-delete' ? request.part.targets : []));
    const blocks = touchedBlocks(this.doc, updates, spans);
    const unsaved = this.options.exportBlocks?.(blocks) ?? blocks.map((block) => blockText(this.doc, block));
    this.#emit({ type: 'refused', reason, unsaved: unsaved.filter((text) => text.trim().length > 0) });
  }
}

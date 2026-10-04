import type { Connection, ConnectionContext, WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1 } from 'y-protocols/sync';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { ACK_COALESCE_MS, AWARENESS_MAX_BYTES, MAX_CONNECTIONS, STATE_CAP_BYTES, WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import {
  bytesToBase64, CLOSE, encodePayloadFrame, PAYLOAD_STEP1, PAYLOAD_STEP2, PAYLOAD_UPDATE, type PayloadAck, type PayloadFrame,
  type ServerEvent, type WriteRefusalReason,
} from '@moss-multi/protocol/sync';
import {
  attachmentFrom, classifySync, connectCode, parseFrame, revocationCode, stateBytesAfter, WriteRate, type Attachment, type DeleteSet,
} from './doc/admission.ts';
import { attach, attachmentOf, awarenessTooLarge, awarenessFrame, receivePresence, leavePresence } from './doc/awareness.ts';
import { AckCoalescer, DocStore, PERSISTENCE } from './doc/persistence.ts';
import { d1Projections, Projections, type ProjectionTarget } from './doc/projections.ts';
import type { SyncEnv } from './env.ts';
import { migrateFrontmatter } from '@moss-multi/core/frontmatter';
import { payloadText } from './payload-docs.ts';
import { JANITOR, migratePayloads, PayloadStore, type PayloadWork } from './payloads.ts';
import { attachPayloadSource, exportDocMarkdown, importBody, rootIsEmpty, SERVER_IMPORT, SERVER_SEED, seedEmptyParagraph } from './server-doc.ts';
import { writeTitle } from './server-title.ts';

/** A title written by create() or a REST rename; both project. */
export const SERVER_TITLE = 'server-title';

export interface DocLimits {
  stateCapBytes: number;
  maxConnections: number;
  writeRate: { max: number; windowMs: number };
  awarenessMaxBytes: number;
  /** Withheld payload ids one connection may write at once (the ids it is minting, or holds after a delete). */
  withheldIdsPerConnection: number;
  /** Bytes one principal may write into withheld payloads, so nobody crowds out another's (A§10.10). */
  withheldBytesPerIdentity: number;
}

export interface CreateDocInput {
  folderId: string;
  ownerId: string;
  /** A file stem (import); "+ Note" sends none, and placeholder text is never authored. */
  title?: string;
  /** A body to import through the one converter instead of the seed's empty paragraph. */
  markdown?: string;
}

/** A server write that would pass the state cap (A§5.1 Limits). */
export class DocCapError extends Error {
  constructor() {
    super('doc-cap');
    this.name = 'DocCapError';
  }
}

const isConnection = (origin: unknown): origin is Connection =>
  typeof origin === 'object' && origin !== null && typeof (origin as Connection).send === 'function' && 'id' in origin;

/**
 * Classifies frames for payload ids the store has never seen; never written. Made on first use: a Y.Doc draws a
 * random client id, which workerd refuses in global scope.
 */
let unknownPayload: Y.Doc | null = null;

/**
 * What a payload frame's own structs put on the server: for each client in it, the end of its clock range, as far as
 * the doc holds it contiguously. Never more than the frame carried, so an ack tells the client nothing it did not send.
 */
function coverage(doc: Y.Doc, update: Uint8Array): Map<number, number> {
  const covered = new Map<number, number>();
  for (const [client, end] of Y.parseUpdateMeta(update).to) {
    const held = Math.min(end, Y.getState(doc.store, client));
    if (held > 0) covered.set(client, held);
  }
  return covered;
}

/** y-partyserver's guard: a socket that is closing or closed is skipped. */
function send(connection: Connection, message: Uint8Array): void {
  if (connection.readyState !== undefined && connection.readyState !== 0 && connection.readyState !== 1) return;
  try {
    connection.send(message);
  } catch {
    // closing; its close handler runs
  }
}

/**
 * One per doc, addressed by idFromName(docId) at /parties/doc-d-o/<docId> (A§5.1). The Worker authenticates every
 * socket and sets the trusted headers; this class persists, seeds, gates writes and answers RPCs. Every RPC that
 * reads the doc starts with ready(), so a stub that outlives an eviction never reads an empty doc.
 */
export class DocDO extends YServer<SyncEnv> {
  static options = { hibernate: true };
  /** Static so the Node harness can shrink them. */
  static limits: DocLimits = {
    stateCapBytes: STATE_CAP_BYTES,
    maxConnections: MAX_CONNECTIONS,
    writeRate: WRITE_RATE,
    awarenessMaxBytes: AWARENESS_MAX_BYTES,
    withheldIdsPerConnection: 64,
    withheldBytesPerIdentity: Math.floor(STATE_CAP_BYTES / 4),
  };
  /** Where the title, filename and updated_at projections land (A§5.1). */
  static projectionTarget: (env: SyncEnv) => ProjectionTarget | null = (env) => (env?.DB ? d1Projections(env.DB) : null);

  readonly instanceId = crypto.randomUUID();
  /** Payload work since the last reset, which the harness reads to bound it (A§10.10). */
  get payloadWork(): PayloadWork {
    return this.#payloads?.work ?? { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, renamed: 0, compared: 0, held: 0 };
  }
  readonly constructedAt = Date.now();

  #store: DocStore | null = null;
  #payloads: PayloadStore | null = null;
  #exported: string | null = null;
  #projections: Projections | null = null;
  readonly #limits = (this.constructor as typeof DocDO).limits;
  readonly #rate = new WriteRate(this.#limits.writeRate.max, this.#limits.writeRate.windowMs);
  readonly #acks = new AckCoalescer<Connection>((connection, deletes, payloads) => this.#ack(connection, deletes, payloads), ACK_COALESCE_MS);
  /** The deletes of the sync frame being applied, which its ack names. */
  #frameDeletes: DeleteSet | undefined;
  /** Withheld payload ids each connection has written, bounded per connection. In memory: a wake starts at none. */
  readonly #withheldWrites = new WeakMap<Connection, Set<string>>();

  /** Runs inside partyserver's blockConcurrencyWhile, so a woken DO replays before it sees any frame. */
  override async onLoad(): Promise<void> {
    const store = new DocStore(this.ctx.storage);
    // The naming index is built by the replay itself, from each transaction's own structs.
    const payloads = new PayloadStore(this.ctx.storage, this.document, {
      broadcast: (id, update, origin) => this.#broadcastPayload(id, update, origin),
      persisted: (_id, _update, origin) => {
        this.#exported = null;
        if (isConnection(origin)) this.#projections?.touch();
      },
      principalOf: (origin) => (isConnection(origin) ? (attachmentOf(origin)?.principalId ?? '') : null),
    });
    store.load(this.document);
    this.#store = store;
    this.#payloads = payloads;
    this.document.on('update', (update: Uint8Array, origin: unknown) => this.#persist(store, update, origin));
    migrateFrontmatter(this.document, 'frontmatter-migration');
    const migrated = migratePayloads(this.document, (id, text) => {
      if (payloads.has(id)) return;
      const doc = payloads.doc(id);
      doc.transact(() => payloadText(doc).insert(0, text), JANITOR);
    });
    // The migrated text leaves the note's rows too.
    if (migrated) store.compact(this.document);
    payloads.loaded();
    attachPayloadSource(this.document, {
      read: (id) => payloads.read(id),
      has: (id) => payloads.has(id),
      write: (id, update) => payloads.write(id, update, SERVER_IMPORT),
    });
    // After every note update (a frame, a server write, a restore, a push): reveal and keep one element per id.
    this.document.on('afterAllTransactions', () => payloads.settle(() => this.#connected()));
    this.#seed(store);
    const target = (this.constructor as typeof DocDO).projectionTarget(this.env);
    if (target) this.#project(new Projections(this.name, target));
  }

  /** Debounced by y-partyserver (2 s, at most 10 s). */
  override async onSave(): Promise<void> {
    if (this.#store && this.#store.pendingRows > 0) this.#store.compact(this.document);
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const store = await this.#ready();
    const attachment = attachmentFrom(ctx.request.headers);
    const code = connectCode(attachment, {
      revoked: store.revoked,
      deleted: store.meta('deleted') === '1',
      connections: [...this.getConnections()].length,
      maxConnections: this.#limits.maxConnections,
    });
    if (code !== null || !attachment) {
      connection.close(code ?? CLOSE.noPrincipal, 'refused');
      return;
    }
    attach(connection, attachment);
    // Registering the socket in the PrincipalDO's sign-out registry lands with that registry (A§5.2, M2).
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    writeSyncStep1(encoder, this.document);
    connection.send(encoding.toUint8Array(encoder));
    if (attachment.presenceAllowed && this.document.awareness.getStates().size) {
      connection.send(awarenessFrame(this.document.awareness, [...this.document.awareness.getStates().keys()]));
    }
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    const attachment = attachmentOf(connection);
    const store = this.#store;
    if (!attachment || !store) {
      connection.close(CLOSE.noPrincipal, 'no principal');
      return;
    }
    const revoked = revocationCode(attachment, store.revoked);
    if (revoked !== null) {
      connection.close(revoked, 'revoked');
      return;
    }
    if (typeof message === 'string') {
      super.onMessage(connection, message);
      return;
    }
    const frame = parseFrame(message);
    if (frame.kind === 'other') return;
    if (frame.kind === 'payload') {
      if (this.#payloads) this.#payloadFrame(connection, attachment, store, this.#payloads, frame.payload);
      return;
    }
    if (frame.kind === 'awareness') {
      if (!awarenessTooLarge(frame.bytes, this.#limits.awarenessMaxBytes)) receivePresence(this.document.awareness, connection, message, [...this.getConnections()]);
      return;
    }
    // Inert frames (every step 2 answering a step 1) pass whatever the role; writes meet the gates.
    if (frame.kind === 'sync') {
      const { changes, missing, deletes } = classifySync(this.document, frame.update);
      if (changes) {
        if (this.#refused(connection, attachment, () => this.#overCap(store, frame.update), missing)) return;
      } else if (roleAtLeast(attachment.role, 'editor')) {
        // The doc already holds it, so nothing persists to ack it: an editor's reconnect step 2 after its ack was lost
        // with the old socket. Acked too, so the client learns its edits are on the server (A§10.6).
        this.#acks.schedule(connection, deletes);
      }
      this.#frameDeletes = deletes;
    }
    try {
      super.onMessage(connection, message);
    } finally {
      this.#frameDeletes = undefined;
    }
  }

  /** Defense in depth: below editor, y-partyserver never applies a step 2 or update, inert or not. */
  override isReadOnly(connection: Connection): boolean {
    return !roleAtLeast(attachmentOf(connection)?.role, 'editor');
  }

  override onClose(connection: Connection): void {
    leavePresence(this.document.awareness, connection, this.getConnections());
    this.#rate.forget(connection);
    this.#acks.cancel(connection);
  }

  /**
   * Records the doc's folder and owner and writes its starting content: the seed, or an imported body. Idempotent:
   * a repeated create changes nothing. Throws DocCapError for a body past the state cap.
   */
  async create(input: CreateDocInput): Promise<void> {
    const store = await this.#ready();
    this.#seed(store);
    if (store.meta('created') !== null) return;
    if (input.markdown) {
      const parts = splitFrontmatter(input.markdown);
      const hasFrontmatter = parts.hasFrontmatter && !parts.error;
      const frontmatter = hasFrontmatter ? input.markdown.slice(0, input.markdown.length - parts.body.length) : undefined;
      importBody(this.document, hasFrontmatter ? parts.body : input.markdown, (diff, payloads) => this.#admitServerWrite(store, diff, payloads), frontmatter);
    }
    const title = input.title?.trim();
    // POST /api/docs wrote a provisional row; the title and its filename arrive through the projection.
    if (title) writeTitle(this.document, title, SERVER_TITLE);
    store.setMeta('folder', input.folderId);
    store.setMeta('owner', input.ownerId);
    if (!title) await this.#projections?.initializeEmpty();
    await this.#projections?.flush();
    store.setMeta('created', '1');
  }

  /**
   * A rename from outside the doc's sockets (REST, CLI): a minimal write to Y.Text('title') that every open client
   * merges, projected before it returns.
   */
  async renameTitle(text: string): Promise<void> {
    await this.#ready();
    writeTitle(this.document, text, SERVER_TITLE);
    this.#projections?.touch();
    await this.#projections?.flush();
  }

  /** Internal RPC: preserves Yjs item identity, including relative anchors, without a markdown round trip. */
  /** Payloads go too, but only the ones an element names: a withheld payload never reaches a copy. */
  async snapshotForDuplicate(): Promise<{ title: string; state: Uint8Array; payloads: [string, Uint8Array][] }> {
    await this.#ready();
    return {
      title: this.document.getText('title').toString(),
      state: Y.encodeStateAsUpdate(this.document),
      payloads: this.#payloads?.servedStates() ?? [],
    };
  }

  async createFromSnapshot(input: Omit<CreateDocInput, 'markdown'>, state: Uint8Array, payloads: [string, Uint8Array][] = []): Promise<void> {
    const store = await this.#ready();
    if (store.meta('created') !== null) return;
    const bytes = payloads.reduce((sum, [, payload]) => sum + payload.byteLength, state.byteLength);
    if (bytes > this.#limits.stateCapBytes) throw new DocCapError();
    for (const [id, payload] of payloads) this.#payloads?.write(id, payload, SERVER_IMPORT);
    this.document.transact(() => {
      // Drop only this new doc's seed, then apply the independent source snapshot.
      const root = this.document.get('root', Y.XmlText);
      root.delete(0, root.length);
      Y.applyUpdate(this.document, state, SERVER_IMPORT);
      const title = this.document.getText('title');
      title.delete(0, title.length);
      title.insert(0, input.title ?? '');
    }, SERVER_IMPORT);
    store.setMeta('folder', input.folderId);
    store.setMeta('owner', input.ownerId);
    await this.#projections?.flush();
    store.setMeta('created', '1');
  }

  /** The doc as a `.md` file, memoized until the next update. */
  async exportMarkdown(): Promise<string> {
    await this.#ready();
    this.#exported ??= exportDocMarkdown(this.document, this.name);
    return this.#exported;
  }

  /** Called through a raw stub and never runs onStart, so it reads nothing from the doc (A§19). */
  probeInstance(): { instanceId: string; constructedAt: number } {
    return { instanceId: this.instanceId, constructedAt: this.constructedAt };
  }

  /** The reset test hook (A§19): drops this instance; the call that ends it rejects. */
  abortInstance(): void {
    this.ctx.abort('qa-reset');
  }

  async #ready(): Promise<DocStore> {
    await this.__unsafe_ensureInitialized();
    if (!this.#store) throw new Error('DocDO started without its store');
    return this.#store;
  }

  #seed(store: DocStore): void {
    if (store.meta('seeded') !== null) return;
    if (rootIsEmpty(this.document)) seedEmptyParagraph(this.document);
    store.setMeta('seeded', '1');
  }

  #persist(store: DocStore, update: Uint8Array, origin: unknown): void {
    this.#exported = null;
    if (origin === PERSISTENCE) return;
    store.record(update, this.document);
    if (isConnection(origin)) {
      this.#acks.schedule(origin, this.#frameDeletes);
      this.#projections?.touch();
    }
  }

  /** Title changes project, except the replay and the seed (A§5.1). */
  #project(projections: Projections): void {
    this.#projections = projections;
    const title = this.document.getText('title');
    title.observe((_event, transaction) => {
      if (transaction.origin === PERSISTENCE || transaction.origin === SERVER_SEED) return;
      projections.title(title.toString());
    });
  }

  /**
   * The note plus every stored payload against the cap (A§5.1 Limits); `extra` is bytes a server write adds to
   * payloads. Simulated only near the cap, since the copy costs a full encode.
   */
  #overCap(store: DocStore, update: Uint8Array, extra = 0): boolean {
    const cap = this.#limits.stateCapBytes;
    const payloads = (this.#payloads?.totalBytes ?? 0) + extra;
    return store.stateBytes + payloads + update.byteLength > cap && stateBytesAfter(this.document, update) + payloads > cap;
  }

  #payloadOverCap(store: DocStore, payloads: PayloadStore, id: string, doc: Y.Doc, update: Uint8Array): boolean {
    const cap = this.#limits.stateCapBytes;
    const base = store.stateBytes + payloads.totalBytes;
    return base + update.byteLength > cap && base - payloads.bytesOf(id) + stateBytesAfter(doc, update) > cap;
  }

  #admitServerWrite(store: DocStore, diff: Uint8Array, payloads: [string, Uint8Array][]): void {
    if (this.#overCap(store, diff, payloads.reduce((sum, [, update]) => sum + update.byteLength, 0))) throw new DocCapError();
  }

  #connected(): boolean {
    return !this.getConnections()[Symbol.iterator]().next().done;
  }

  /**
   * A payload's frame (A§10.10): through the same role, rate and size gates as the note's, classified against its own
   * doc. A step 1 is answered only while the payload is served. A write to a withheld payload is accepted only from
   * one of its readers, or for a new id the connection is minting; each connection writes a bounded number of withheld
   * ids and each principal a bounded number of withheld bytes, so nobody can crowd out another's withheld payloads.
   * Acks carry vectors built from the acked frames alone, so they reveal nothing the client did not send.
   */
  #payloadFrame(connection: Connection, attachment: Attachment, store: DocStore, payloads: PayloadStore, frame: PayloadFrame): void {
    const { id, step, data } = frame;
    try {
      if (step === PAYLOAD_STEP1) {
        if (!payloads.served(id)) return;
        send(connection, encodePayloadFrame(id, PAYLOAD_STEP2, Y.encodeStateAsUpdate(payloads.doc(id), data)));
        payloads.addReaders(id, [attachment.principalId]);
        return;
      }
      // An id the store has never seen stays unloaded unless the frame writes to it.
      const known = payloads.has(id);
      const withheld = !payloads.served(id);
      // Every write to a withheld payload by someone who cannot read it is refused, whatever it carries, so neither an
      // ack nor a refusal tells them which of its clocks the server holds.
      if (known && withheld && !payloads.isReader(id, attachment.principalId)) {
        this.#refused(connection, attachment, () => true);
        return;
      }
      const target = known ? payloads.doc(id) : (unknownPayload ??= new Y.Doc());
      const { changes, missing, deletes } = classifySync(target, data);
      if (!changes) {
        // An editor's resend of what is already stored: acked, since the ack that covered it may have been lost.
        if (roleAtLeast(attachment.role, 'editor')) this.#acks.schedule(connection, deletes, id, coverage(target, data));
        return;
      }
      const overCap = () => {
        if (withheld) {
          if (!this.#mayWriteWithheld(connection, payloads, id)) return true;
          if (payloads.withheldBy(attachment.principalId) + data.byteLength > this.#limits.withheldBytesPerIdentity) return true;
        }
        return this.#payloadOverCap(store, payloads, id, payloads.doc(id), data);
      };
      if (this.#refused(connection, attachment, overCap, missing)) return;
      payloads.addReaders(id, [attachment.principalId]);
      const doc = payloads.doc(id);
      Y.applyUpdate(doc, data, connection);
      this.#acks.schedule(connection, deletes, id, coverage(doc, data));
    } catch {
      // A frame that does not decode is dropped like an unknown one.
    }
  }

  /** Counts `id` among the connection's withheld ids, unless that would pass the bound; served ones no longer count. */
  #mayWriteWithheld(connection: Connection, payloads: PayloadStore, id: string): boolean {
    let ids = this.#withheldWrites.get(connection);
    if (!ids) this.#withheldWrites.set(connection, (ids = new Set()));
    if (ids.has(id)) return true;
    if (ids.size >= this.#limits.withheldIdsPerConnection) for (const held of ids) if (payloads.served(held)) ids.delete(held);
    if (ids.size >= this.#limits.withheldIdsPerConnection) return false;
    ids.add(id);
    return true;
  }

  /** A served payload's update to every socket but the one it came from; each recipient becomes one of its readers. */
  #broadcastPayload(id: string, update: Uint8Array, origin: unknown): void {
    const frame = encodePayloadFrame(id, PAYLOAD_UPDATE, update);
    const readers: string[] = [];
    for (const connection of this.getConnections()) {
      if (connection === origin) continue;
      send(connection, frame);
      const principal = attachmentOf(connection)?.principalId;
      if (principal) readers.push(principal);
    }
    this.#payloads?.addReaders(id, readers);
  }

  /**
   * True when the write was refused and the socket closed; a refusal is never silent. `missing`: the frame needs a
   * clock the doc lacks, which Yjs would hold pending, uncounted, and integrate under a later sender's transaction.
   */
  #refused(connection: Connection, attachment: Attachment, overCap: () => boolean, missing = false): boolean {
    if (!roleAtLeast(attachment.role, 'suggester')) return this.#refuse(connection, 'role', CLOSE.revoked);
    // A suggester's writes are vetted on a mirror (M5); until then they are refused, never applied unvetted.
    if (!roleAtLeast(attachment.role, 'editor')) return this.#refuse(connection, 'suggest', CLOSE.writeRefused);
    if (!this.#rate.allow(connection)) {
      // Transient: the client keeps its Y.Doc and its next step 2 re-delivers everything.
      connection.close(CLOSE.writeRate, 'write rate');
      return true;
    }
    if (missing) {
      // Transient too: a reconnect's step 2 carries whatever the frame depended on.
      connection.close(CLOSE.writeRate, 'missing dependency');
      return true;
    }
    if (overCap()) return this.#refuse(connection, 'doc-cap', CLOSE.writeRefused);
    return false;
  }

  #refuse(connection: Connection, reason: WriteRefusalReason, code: number): true {
    const event: ServerEvent = { t: 'write-refused', reason };
    this.sendCustomMessage(connection, JSON.stringify(event));
    connection.close(code, `write-refused: ${reason}`);
    return true;
  }

  #ack(connection: Connection, deletes: DeleteSet, payloads: Map<string, { sv: Map<number, number>; deletes: DeleteSet }>): void {
    const event: Extract<ServerEvent, { t: 'ack' }> = {
      t: 'ack',
      sv: bytesToBase64(Y.encodeStateVector(this.document)),
      ds: bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(deletes, new Map()))),
    };
    if (payloads.size) {
      const acked: Record<string, PayloadAck> = {};
      for (const [id, covered] of payloads) {
        acked[id] = {
          sv: bytesToBase64(Y.encodeStateVector(covered.sv)),
          ds: bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(covered.deletes, new Map()))),
        };
      }
      event.p = acked;
    }
    // sendCustomMessage skips a socket that has closed.
    this.sendCustomMessage(connection, JSON.stringify(event));
  }
}

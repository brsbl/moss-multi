import { getServerByName, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1 } from 'y-protocols/sync';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { ACK_COALESCE_MS, AWARENESS_MAX_BYTES, MAX_CONNECTIONS, STATE_CAP_BYTES, WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast } from '@moss-multi/protocol/roles';
import { bytesToBase64, CLOSE, type ServerEvent, type WriteRefusalReason } from '@moss-multi/protocol/sync';
import {
  attachmentFrom, classifySync, connectCode, EVERYONE, parseFrame, revocationCode, stateBytesAfter, WriteRate, type Attachment, type DeleteSet,
} from './doc/admission.ts';
import { attach, attachmentOf, awarenessTooLarge, awarenessFrame, receivePresence, leavePresence } from './doc/awareness.ts';
import { AckCoalescer, DocStore, PERSISTENCE } from './doc/persistence.ts';
import { d1Projections, Projections, type ProjectionTarget } from './doc/projections.ts';
import { publishMeta } from './fanout.ts';
import type { SyncEnv } from './env.ts';
import { migrateFrontmatter } from '@moss-multi/core/frontmatter';
import { migrateRegisters } from './registers.ts';
import { exportDocMarkdown, importBody, rootIsEmpty, SERVER_IMPORT, SERVER_SEED, seedEmptyParagraph } from './server-doc.ts';
import { writeTitle } from './server-title.ts';

/** A title written by create() or a REST rename; both project. */
export const SERVER_TITLE = 'server-title';

export interface DocLimits {
  stateCapBytes: number;
  maxConnections: number;
  writeRate: { max: number; windowMs: number };
  awarenessMaxBytes: number;
}

export interface CreateDocInput {
  folderId: string;
  ownerId: string;
  /** A file stem (import); "+ Note" sends none, and placeholder text is never authored. */
  title?: string;
  /** A body to import through the one converter instead of the seed's empty paragraph. */
  markdown?: string;
}

/** What a recheck revokes (A§5.1, A§8): principals and share tokens close 4403, sessions 4402. */
export interface RecheckInput {
  principalIds?: string[];
  tokens?: string[];
  sessions?: string[];
  /** Every socket resolved no later than `at` (a retried move, whose losses are no longer known); each re-asks REST. */
  everyone?: boolean;
  /** When the change committed (epoch ms); a principal's socket resolved no later than this is refused. */
  at?: number;
}

/**
 * The PrincipalDO's sign-out registry (A§5.2): records that a session (or, for an agent, the principal itself, with a
 * null session) has a socket on a doc, and answers `ended` when that session already ended.
 */
export type SocketRegistry = (principalId: string, sessionId: string | null, docId: string) => Promise<'ok' | 'ended'>;

/** Whether D1 has the doc in Trash (or has no row for it); throws when D1 cannot answer. */
export type TrashedInD1 = (docId: string) => Promise<boolean>;

/** How long a trash's hold waits for its settle before the alarm settles it from D1. */
export const HOLD_MS = 60_000;
/** Close code for an admission the DocDO cannot confirm: the client retries (RFC 6455 "try again later"). */
const TRY_AGAIN = 1013;

/** A server write that would pass the state cap (A§5.1 Limits). */
export class DocCapError extends Error {
  constructor() {
    super('doc-cap');
    this.name = 'DocCapError';
  }
}

/** The trashes holding the doc closed, each with when the alarm may settle it. */
function holdsOf(store: DocStore): Map<string, number> {
  const raw = store.meta('holds');
  return new Map(raw ? Object.entries(JSON.parse(raw) as Record<string, number>) : []);
}

const isConnection = (origin: unknown): origin is Connection =>
  typeof origin === 'object' && origin !== null && typeof (origin as Connection).send === 'function' && 'id' in origin;

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
  };
  /** Where the title, filename and updated_at projections land (A§5.1). */
  static projectionTarget: (env: SyncEnv) => ProjectionTarget | null = (env) => (env?.DB ? d1Projections(env.DB, (id) => publishMeta(env, [id])) : null);
  /** Where a settle reads whether the doc is in Trash: D1, the one source of truth (A§8). */
  static liveness: (env: SyncEnv) => TrashedInD1 | null = (env) => (env?.DB
    ? async (docId) => {
      const row = await env.DB.prepare('SELECT deleted_at FROM docs WHERE id = ?').bind(docId).first<{ deleted_at: number | null }>();
      return !row || row.deleted_at !== null;
    }
    : null);
  /** Where a socket registers for sign-out and agent-key revocation (A§5.2). */
  static registry: (env: SyncEnv) => SocketRegistry | null = (env) => (env?.PrincipalDO
    ? async (principalId, sessionId, docId) => (await getServerByName(env.PrincipalDO, principalId)).registerDocSocket(sessionId, docId)
    : null);

  readonly instanceId = crypto.randomUUID();
  readonly constructedAt = Date.now();

  #store: DocStore | null = null;
  #exported: string | null = null;
  #projections: Projections | null = null;
  readonly #limits = (this.constructor as typeof DocDO).limits;
  readonly #rate = new WriteRate(this.#limits.writeRate.max, this.#limits.writeRate.windowMs);
  readonly #acks = new AckCoalescer<Connection>((connection, deletes) => this.#ack(connection, deletes), ACK_COALESCE_MS);
  /** The deletes of the sync frame being applied, which its ack names. */
  #frameDeletes: DeleteSet | undefined;
  /** Settles run one at a time, so the last one applies the newest D1 read. */
  #settling: Promise<unknown> = Promise.resolve();

  /** Runs inside partyserver's blockConcurrencyWhile, so a woken DO replays before it sees any frame. */
  override async onLoad(): Promise<void> {
    const store = new DocStore(this.ctx.storage);
    store.load(this.document);
    this.#store = store;
    this.document.on('update', (update: Uint8Array, origin: unknown) => this.#persist(store, update, origin));
    migrateFrontmatter(this.document, 'frontmatter-migration');
    migrateRegisters(this.document);
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
    let deleted = store.meta('deleted') === '1' || holdsOf(store).size > 0;
    // A doc closed without a hold may have missed the settle of a restore: D1 decides, and an unanswered read admits
    // nobody (the 101 waits for this, so no frame arrives first).
    if (deleted && holdsOf(store).size === 0 && this.#liveness()) {
      try {
        deleted = (await this.#queue(() => this.#settle([], connection))).deleted || holdsOf(store).size > 0;
      } catch (error) {
        console.error('DocDO admission could not confirm the doc is live', error);
        connection.close(TRY_AGAIN, 'unconfirmed');
        return;
      }
    }
    const code = connectCode(attachment, {
      revoked: store.revoked,
      deleted,
      connections: [...this.getConnections()].length,
      maxConnections: this.#limits.maxConnections,
    });
    if (code !== null || !attachment) {
      connection.close(code ?? CLOSE.noPrincipal, 'refused');
      return;
    }
    attach(connection, attachment);
    this.#register(connection, attachment, store);
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
    if (frame.kind === 'awareness') {
      if (!awarenessTooLarge(frame.bytes, this.#limits.awarenessMaxBytes)) receivePresence(this.document.awareness, connection, message, [...this.getConnections()]);
      return;
    }
    // Inert frames (every step 2 answering a step 1) pass whatever the role; writes meet the gates.
    if (frame.kind === 'sync') {
      const { changes, deletes } = classifySync(this.document, frame.update);
      if (changes) {
        if (this.#refused(connection, attachment, store, frame.update)) return;
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
      importBody(this.document, hasFrontmatter ? parts.body : input.markdown, (diff) => this.#admitServerWrite(store, diff), frontmatter);
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

  /**
   * A trash is starting (A§5.1, A§8): the doc is held closed before D1 records it, so no write lands on a trashed note
   * whatever fails next. The hold is persisted before anyone hears of it, so a woken DO and a reconnect also meet 4410;
   * every open socket is told, then closed 4410. Only a settle naming the hold, or the alarm once it has waited
   * HOLD_MS, lets it go, and only from a D1 read. Idempotent.
   */
  async trash(hold: string): Promise<void> {
    const store = await this.#ready();
    const holds = holdsOf(store);
    const fresh = !holds.has(hold);
    if (fresh) {
      holds.set(hold, Date.now() + HOLD_MS);
      store.setMeta('holds', JSON.stringify(Object.fromEntries(holds)));
    }
    this.#closeAll();
    if (fresh) await this.#schedule(holds);
  }

  /**
   * Applies D1 (A§8): the doc is closed while D1 has it in Trash, and open again once D1 has it live and no other
   * trash holds it. `hold` releases that trash's hold. Throws, changing nothing, when D1 cannot answer.
   */
  settle(hold?: string): Promise<{ deleted: boolean }> {
    return this.#queue(() => this.#settle(hold === undefined ? [] : [hold]));
  }

  /** A hold whose route never settled it (A§5.1): settled from D1 once it has waited, retried while D1 cannot answer. */
  override async onAlarm(): Promise<void> {
    const store = await this.#ready();
    const now = Date.now();
    const expired = [...holdsOf(store)].filter(([, until]) => until <= now).map(([hold]) => hold);
    if (expired.length > 0) {
      try {
        await this.#queue(() => this.#settle(expired));
      } catch (error) {
        console.error('DocDO hold settle failed; retrying', error);
        await this.ctx.storage.setAlarm(now + HOLD_MS);
        return;
      }
    }
    await this.#schedule(holdsOf(store));
  }

  /**
   * The one kick path's landing (A§8): persists the revocations before closing anything, so a woken DO and a socket
   * already on its way in meet them too, then closes every socket they name: 4403 for a principal or a share token
   * (the client asks REST and rebinds read-only or ends `revoked`), 4402 for an ended session. Idempotent.
   */
  async recheck(input: RecheckInput): Promise<{ closed: number }> {
    const store = await this.#ready();
    const at = input.at ?? Date.now();
    for (const id of input.principalIds ?? []) store.revoke('principal', id, at);
    for (const id of input.tokens ?? []) store.revoke('token', id, at);
    for (const id of input.sessions ?? []) store.revoke('session', id, at);
    if (input.everyone) store.revoke('principal', EVERYONE, at);
    let closed = 0;
    for (const connection of this.getConnections()) {
      const attachment = attachmentOf(connection);
      const code = attachment ? revocationCode(attachment, store.revoked) : null;
      if (code === null) continue;
      connection.close(code, code === CLOSE.sessionEnded ? 'session ended' : 'revoked');
      closed += 1;
    }
    return { closed };
  }

  /** Internal RPC: preserves Yjs item identity, including relative anchors, without a markdown round trip. */
  async snapshotForDuplicate(): Promise<{ title: string; state: Uint8Array }> {
    await this.#ready();
    return { title: this.document.getText('title').toString(), state: Y.encodeStateAsUpdate(this.document) };
  }

  async createFromSnapshot(input: Omit<CreateDocInput, 'markdown'>, state: Uint8Array): Promise<void> {
    const store = await this.#ready();
    if (store.meta('created') !== null) return;
    if (state.byteLength > this.#limits.stateCapBytes) throw new DocCapError();
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

  /**
   * Off the upgrade path (A§5.1 onConnect): a signed-in socket registers under its session and an agent's under the
   * agent, so sign-out and key revocation can find it. A session that ended before this socket registered (its upgrade
   * was resolved before the sign-out) is remembered and the socket closes 4402.
   */
  #register(connection: Connection, attachment: Attachment, store: DocStore): void {
    const register = (this.constructor as typeof DocDO).registry(this.env);
    const sessionId = attachment.sessionId;
    if (!register || (sessionId === null && attachment.kind !== 'agent')) return;
    const registered = register(attachment.principalId, sessionId, this.name).then((answer) => {
      if (answer !== 'ended') return;
      if (sessionId !== null) store.revoke('session', sessionId, Date.now());
      else store.revoke('principal', attachment.principalId, Date.now());
      connection.close(sessionId !== null ? CLOSE.sessionEnded : CLOSE.revoked, sessionId !== null ? 'session ended' : 'revoked');
    }, (error: unknown) => {
      // Fail closed: an unregistered socket would outlive a sign-out. The client reconnects and registers again.
      console.error('DocDO socket registration failed', error);
      connection.close(TRY_AGAIN, 'unregistered');
    });
    this.ctx.waitUntil(registered);
  }

  #liveness(): TrashedInD1 | null {
    return (this.constructor as typeof DocDO).liveness(this.env);
  }

  #queue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#settling.then(run);
    this.#settling = next.catch(() => undefined);
    return next;
  }

  /** `admitting`, a socket still in onConnect, is left for its own refusal. */
  async #settle(release: string[], admitting?: Connection): Promise<{ deleted: boolean }> {
    const trashedInD1 = this.#liveness();
    if (!trashedInD1) throw new Error('DocDO has no D1 to settle from');
    const deleted = await trashedInD1(this.name);
    const store = await this.#ready();
    const holds = holdsOf(store);
    for (const hold of release) holds.delete(hold);
    store.setMeta('holds', JSON.stringify(Object.fromEntries(holds)));
    store.setMeta('deleted', deleted ? '1' : '0');
    if (deleted || holds.size > 0) this.#closeAll(admitting);
    return { deleted };
  }

  /** The alarm goes off when the oldest hold has waited HOLD_MS. */
  async #schedule(holds: Map<string, number>): Promise<void> {
    if (holds.size === 0) return;
    await this.ctx.storage.setAlarm(Math.min(...holds.values()));
  }

  /** Every open socket hears the doc is gone, then closes 4410. */
  #closeAll(except?: Connection): void {
    const event: ServerEvent = { t: 'doc-deleted' };
    for (const connection of this.getConnections()) {
      if (connection.id === except?.id) continue;
      this.sendCustomMessage(connection, JSON.stringify(event));
      connection.close(CLOSE.deleted, 'deleted');
    }
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

  /** Simulated only near the cap, since the copy costs a full encode. */
  #overCap(store: DocStore, update: Uint8Array): boolean {
    const cap = this.#limits.stateCapBytes;
    return store.stateBytes + update.byteLength > cap && stateBytesAfter(this.document, update) > cap;
  }

  #admitServerWrite(store: DocStore, diff: Uint8Array): void {
    if (this.#overCap(store, diff)) throw new DocCapError();
  }

  /** True when the write was refused and the socket closed; a refusal is never silent. */
  #refused(connection: Connection, attachment: Attachment, store: DocStore, update: Uint8Array): boolean {
    if (!roleAtLeast(attachment.role, 'suggester')) return this.#refuse(connection, 'role', CLOSE.revoked);
    // A suggester's writes are vetted on a mirror (M5); until then they are refused, never applied unvetted.
    if (!roleAtLeast(attachment.role, 'editor')) return this.#refuse(connection, 'suggest', CLOSE.writeRefused);
    if (!this.#rate.allow(connection)) {
      // Transient: the client keeps its Y.Doc and its next step 2 re-delivers everything.
      connection.close(CLOSE.writeRate, 'write rate');
      return true;
    }
    if (this.#overCap(store, update)) return this.#refuse(connection, 'doc-cap', CLOSE.writeRefused);
    return false;
  }

  #refuse(connection: Connection, reason: WriteRefusalReason, code: number): true {
    const event: ServerEvent = { t: 'write-refused', reason };
    this.sendCustomMessage(connection, JSON.stringify(event));
    connection.close(code, `write-refused: ${reason}`);
    return true;
  }

  #ack(connection: Connection, deletes: DeleteSet): void {
    const event: ServerEvent = {
      t: 'ack',
      sv: bytesToBase64(Y.encodeStateVector(this.document)),
      ds: bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(deletes, new Map()))),
    };
    // sendCustomMessage skips a socket that has closed.
    this.sendCustomMessage(connection, JSON.stringify(event));
  }
}

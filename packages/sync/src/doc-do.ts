import { getServerByName, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1 } from 'y-protocols/sync';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { ACK_COALESCE_MS, AWARENESS_MAX_BYTES, MAX_CONNECTIONS, STATE_CAP_BYTES, WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { SUGGEST_LIMITS, type SuggestReply, type SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CLOSE, type ServerEvent, type WriteRefusalReason } from '@moss-multi/protocol/sync';
import {
  attachmentFrom, classifySync, connectCode, parseFrame, revocationCode, stateBytesAfter, WriteRate, type Attachment, type Decoded, type DeleteSet,
} from './doc/admission.ts';
import { attach, attachmentOf, awarenessTooLarge, awarenessFrame, receivePresence, leavePresence } from './doc/awareness.ts';
import { AckCoalescer, DocStore, PERSISTENCE } from './doc/persistence.ts';
import { coerceSidecar, COMMENT_STATE_SHARE, COMMENTS_PER_DOC, DocComments, type CommentCreate, type CommentResult } from './doc/comments.ts';
import { d1Projections, Projections, type ProjectionTarget } from './doc/projections.ts';
import { handleSuggest, SqlLeases, SuggestIngest, type Suggester } from './doc/suggest.ts';
import { newSuggestionsClient, SUGGESTIONS, SuggestionsWriter } from './suggest/records.ts';
import { nodeRegistry } from './suggest/review.ts';
import { publishMeta } from './fanout.ts';
import type { SyncEnv } from './env.ts';
import { migrateFrontmatter } from '@moss-multi/core/frontmatter';
import { migrateRegisters } from './registers.ts';
import { SEARCH_DO_NAME, type IndexEntry } from './search-do.ts';
import { exportDocMarkdown, importBody, rootIsEmpty, SERVER_IMPORT, SERVER_SEED, seedEmptyParagraph } from './server-doc.ts';
import { writeTitle } from './server-title.ts';

/** How long after a wake the doc re-feeds search. */
const WAKE_FEED_MS = 1_000;
/** The `search-fed` meta while the index holds this doc's content; bump it when an index entry's shape changes. */
const SEARCH_FEED_VERSION = '2';

/** A title written by create() or a REST rename; both project. */
export const SERVER_TITLE = 'server-title';

export interface DocLimits {
  stateCapBytes: number;
  maxConnections: number;
  writeRate: { max: number; windowMs: number };
  awarenessMaxBytes: number;
  /** Comment and reply records per doc (comments.md §4). */
  maxComments: number;
}

export interface CreateDocInput {
  folderId: string;
  ownerId: string;
  /** A file stem (import); "+ Note" sends none, and placeholder text is never authored. */
  title?: string;
  /** A body to import through the one converter instead of the seed's empty paragraph. */
  markdown?: string;
  /** Moss's comments.json for `markdown`'s `%%m:` markers (moss interchange); records are authored by `author`. */
  comments?: Record<string, unknown>;
  author?: string;
}

/** Whether D1 has the doc in Trash (or has no row for it); throws when D1 cannot answer. */
export type TrashedInD1 = (docId: string) => Promise<boolean>;

/** Store items a sub-editor's delete set may make the classifier visit per frame byte (its frame never applies). */
const CLASSIFY_BUDGET_PER_BYTE = 8;

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

/** Where the DocDO feeds its title and body (A§5.3): the SearchDO in the Worker, a fake in the harness. */
export interface SearchFeed {
  index(entry: IndexEntry): Promise<{ linksChanged: boolean }>;
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
    maxComments: COMMENTS_PER_DOC,
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

  /** Where search feeds land; null leaves the doc unindexed. */
  static searchFeed: (env: SyncEnv) => SearchFeed | null = (env) => (env?.SearchDO ? {
    index: async (entry) => (await getServerByName(env.SearchDO, SEARCH_DO_NAME)).index(entry),
  } : null);

  readonly instanceId = crypto.randomUUID();
  readonly constructedAt = Date.now();

  #store: DocStore | null = null;
  #comments: DocComments | null = null;
  #exported: string | null = null;
  #projections: Projections | null = null;
  /** The title and body this instance last fed to search. */
  #fed: string | null = null;
  /** Doc edits since load; a feed marks the doc fed only if none landed while it ran. */
  #edits = 0;
  /** Whether the stored `search-fed` meta is cleared (an edit the index may lack). */
  #searchStale = false;
  readonly #limits = (this.constructor as typeof DocDO).limits;
  readonly #rate = new WriteRate(this.#limits.writeRate.max, this.#limits.writeRate.windowMs);
  readonly #acks = new AckCoalescer<Connection>((connection, deletes) => this.#ack(connection, deletes), ACK_COALESCE_MS);
  /** The deletes of the sync frame being applied, which its ack names. */
  #frameDeletes: DeleteSet | undefined;
  /** Settles run one at a time, so the last one applies the newest D1 read. */
  #settling: Promise<unknown> = Promise.resolve();
  /** The one writer of `suggestions` (reserved client S) and the suggestion ingest (docs/design/suggestions.md). */
  #suggestions: SuggestionsWriter | null = null;
  #ingest: SuggestIngest | null = null;
  /** Suggest refusals per principal in the last window, and principals cooling down (until when). In memory. */
  readonly #refusals = new Map<string, number[]>();
  readonly #cooldowns = new Map<string, number>();

  /** Runs inside partyserver's blockConcurrencyWhile, so a woken DO replays before it sees any frame. */
  override async onLoad(): Promise<void> {
    const store = new DocStore(this.ctx.storage);
    store.load(this.document);
    this.#store = store;
    this.document.on('update', (update: Uint8Array, origin: unknown) => this.#persist(store, update, origin));
    // R from meta and the anchor indexes from the `a:` records (comments.md §3, I8).
    this.#comments = new DocComments(this.document, store);
    migrateFrontmatter(this.document, 'frontmatter-migration');
    migrateRegisters(this.document);
    this.#seed(store);
    let client = Number(store.meta('suggestions-client'));
    if (!client) {
      client = newSuggestionsClient(this.document);
      store.setMeta('suggestions-client', String(client));
    }
    this.#suggestions = new SuggestionsWriter(this.document, client);
    this.#ingest = new SuggestIngest(this.document, {
      stateCap: this.#limits.stateCapBytes,
      registry: nodeRegistry(),
      leases: new SqlLeases(this.ctx.storage.sql),
      stateBytes: () => store.stateBytes,
    });
    this.#comments.flush();
    const target = (this.constructor as typeof DocDO).projectionTarget(this.env);
    if (target) this.#project(new Projections(this.name, target));
    // A wake re-feeds only a doc the index may lack (L§4.14): an edit whose feed never landed, or an older entry
    // shape; once onStart has served the waiting frames. A doc being created is fed by the save its content triggers.
    this.#searchStale = store.meta('search-fed') !== SEARCH_FEED_VERSION;
    if (this.#searchStale && store.meta('created') !== null) setTimeout(() => void this.#feedSearch(), WAKE_FEED_MS);
  }

  /** Debounced by y-partyserver (2 s, at most 10 s). */
  override async onSave(): Promise<void> {
    if (this.#store && this.#store.pendingRows > 0) this.#store.compact(this.document);
    await this.#feedSearch();
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
    if (this.#coolingDown(attachment.principalId)) {
      connection.close(CLOSE.connectionLimit, 'suggest-cooldown');
      return;
    }
    attach(connection, { ...attachment, nonce: crypto.randomUUID() });
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
    if (frame.kind === 'awareness') {
      if (!awarenessTooLarge(frame.bytes, this.#limits.awarenessMaxBytes)) receivePresence(this.document.awareness, connection, message, [...this.getConnections()]);
      return;
    }
    // Inert frames (every step 2 answering a step 1) pass whatever the role; writes meet the gates.
    /** A frame Yjs will apply: an editor's write. */
    let applying: ReturnType<typeof Y.decodeUpdate> | null = null;
    if (frame.kind === 'sync') {
      const writer = roleAtLeast(attachment.role, 'editor');
      const budget = writer ? Infinity : frame.update.byteLength * CLASSIFY_BUDGET_PER_BYTE + 1024;
      let decoded: ReturnType<typeof Y.decodeUpdate>;
      try {
        decoded = Y.decodeUpdate(frame.update);
      } catch {
        this.#refuse(connection, 'unresolved', CLOSE.writeRefused);
        return;
      }
      const { changes, deletes } = classifySync(this.document, frame.update, budget, decoded);
      if (changes && this.#refused(connection, attachment, store, frame.update, decoded)) return;
      // Gate 2b on every step 2 or update, inert or not, whatever the role: no client frame reaches `comments`
      // (comments.md §3, I1). O(frame · log); it follows no references.
      if (this.#comments?.check(decoded)) {
        this.#refuse(connection, 'protected-type', CLOSE.writeRefused);
        return;
      }
      if (!changes && writer) {
        // The doc already holds it, so nothing persists to ack it: an editor's reconnect step 2 after its ack was lost
        // with the old socket. Acked too, so the client learns its edits are on the server (A§10.6).
        this.#acks.schedule(connection, deletes);
      }
      this.#frameDeletes = deletes;
      if (changes && !this.isReadOnly(connection)) applying = decoded;
    }
    try {
      super.onMessage(connection, message);
    } finally {
      this.#frameDeletes = undefined;
    }
    if (frame.kind === 'sync') this.#afterFrame(connection, store, applying ? applying.structs : []);
  }

  /**
   * After a client frame applies: nothing it carried may wait in Yjs's pending queues to integrate after a later
   * write, so a parked struct or delete is dropped and the frame refused, as is a frame Yjs threw on (comments.md §3,
   * I2). Then the anchor changes it caused are written through writeComments in this turn (I8), and only then may the
   * log compact, so a snapshot never holds parked structs.
   */
  #afterFrame(connection: Connection, store: DocStore, applied: ReturnType<typeof Y.decodeUpdate>['structs']): void {
    const yStore = this.document.store;
    // y-protocols swallows what Yjs throws mid-apply, so a throw shows only as a struct that is neither integrated
    // nor parked.
    const threw = applied.some((struct) => !(struct instanceof Y.Skip) && struct.id.clock + struct.length > Y.getState(yStore, struct.id.client));
    if (threw || yStore.pendingStructs !== null || yStore.pendingDs !== null) {
      yStore.pendingStructs = null;
      yStore.pendingDs = null;
      this.#refuse(connection, 'unresolved', CLOSE.writeRefused);
    }
    this.#comments?.flush();
    store.compactIfDue(this.document);
  }

  /** Defense in depth: below editor, y-partyserver never applies a step 2 or update, inert or not. */
  override isReadOnly(connection: Connection): boolean {
    return !roleAtLeast(attachmentOf(connection)?.role, 'editor');
  }

  /** Suggest-mode frames (docs/design/suggestions.md §2): the live role on every frame, one reply each. */
  override onCustomMessage(connection: Connection, message: string): void {
    const attachment = attachmentOf(connection);
    const ingest = this.#ingest;
    if (!attachment || !ingest) return;
    if (this.#coolingDown(attachment.principalId)) {
      connection.close(CLOSE.connectionLimit, 'suggest-cooldown');
      return;
    }
    let request: SuggestRequest | null = null;
    if (message.length <= SUGGEST_LIMITS.frameChars) {
      try {
        request = JSON.parse(message) as SuggestRequest;
      } catch {
        request = null;
      }
    }
    if (request !== null && (typeof request !== 'object' || typeof request.t !== 'string' || !request.t.startsWith('suggest-'))) return;
    if (request?.t !== 'suggest-lease' && !this.#rate.allow(connection)) {
      connection.close(CLOSE.writeRate, 'write rate');
      return;
    }
    const who: Suggester = { id: attachment.principalId, name: attachment.name, role: attachment.role, connection: attachment.nonce ?? connection.id };
    const reply: SuggestReply = request ? handleSuggest(ingest, who, request) : { t: 'suggest-refused', record: null, reason: 'malformed' };
    this.sendCustomMessage(connection, JSON.stringify(reply));
    if (reply.t === 'suggest-refused') this.#countRefusal(attachment.principalId);
  }

  /**
   * A principal's role on this doc changed (the kick path, A§8): every open connection of theirs reads the new role
   * on its next frame; no role at all closes them 4403, so their client asks REST.
   */
  async recheckRole(principalId: string, role: Role | null): Promise<void> {
    await this.#ready();
    for (const connection of this.getConnections()) {
      const attachment = attachmentOf(connection);
      if (attachment?.principalId !== principalId) continue;
      if (role === null) connection.close(CLOSE.revoked, 'revoked');
      else attach(connection, { ...attachment, role });
    }
  }

  override onClose(connection: Connection): void {
    const nonce = attachmentOf(connection)?.nonce;
    if (nonce) this.#ingest?.expireConnection(nonce);
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
      const sidecar = input.comments ? Object.fromEntries(coerceSidecar(input.comments)) : undefined;
      const marks = importBody(this.document, hasFrontmatter ? parts.body : input.markdown, (diff) => this.#admitServerWrite(store, diff), frontmatter, sidecar);
      // Right after the tree diff, in the same turn (comments.md §13).
      // The import's diff may be past a log row and not yet counted in stateBytes, so the room is measured.
      if (sidecar) {
        const room = this.#commentRoom(Y.encodeStateAsUpdate(this.document).byteLength);
        this.#comments?.importSidecar(sidecar, marks, input.author ?? input.ownerId, this.#limits.maxComments, room);
      }
    }
    const title = input.title?.trim();
    // POST /api/docs wrote a provisional row; the title and its filename arrive through the projection.
    if (title) writeTitle(this.document, title, SERVER_TITLE);
    this.#comments?.flush();
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
    this.#comments?.flush();
    this.#projections?.touch();
    await this.#projections?.flush();
  }

  /**
   * A comment or reply from REST (comments.md §4): `author` is the server principal the Worker resolved, and the
   * Worker has checked commenter access and the per-principal rate. Records persist in this turn.
   */
  async createComment(input: CommentCreate): Promise<CommentResult> {
    const store = await this.#ready();
    const comments = this.#comments;
    if (!comments) throw new Error('DocDO started without comments');
    // A trash holds the doc closed to every write (A§8), whatever the Worker resolved before the body arrived.
    if (holdsOf(store).size > 0) return { ok: false, status: 404, error: 'trashed' };
    // The record and anchor bytes, quote included, count against the comments' share of the cap (A§5.1 Limits).
    const result = comments.create(input, this.#limits.maxComments, this.#commentRoom(store.stateBytes));
    comments.flush();
    return result;
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
    // A copy has no pending suggestions: the source's records were written under the source's reserved client (I2).
    this.#suggestions?.write(() => this.document.getMap(SUGGESTIONS).clear());
    this.#comments?.dropCopied();
    this.#comments?.flush();
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

  /** Feeds search now, even with nothing changed: the Worker's backfill for a doc the index lacks. */
  async reindex(): Promise<void> {
    await this.#ready();
    this.#fed = null;
    await this.#feedSearch();
  }

  /** Called through a raw stub and never runs onStart, so it reads nothing from the doc (A§19). */
  probeInstance(): { instanceId: string; constructedAt: number } {
    return { instanceId: this.instanceId, constructedAt: this.constructedAt };
  }

  /** The reset test hook (A§19): drops this instance; the call that ends it rejects. */
  abortInstance(): void {
    this.ctx.abort('qa-reset');
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

  /**
   * The title from Y.Text and the body as the converter exports it, never the tree's `toString()` (L§4.14). When the
   * doc's wiki links change, its readers hear a meta event so open backlinks refresh (A§11).
   */
  async #feedSearch(): Promise<void> {
    const feed = (this.constructor as typeof DocDO).searchFeed(this.env);
    if (!feed) return;
    try {
      // Never through ready(): called from onLoad's timer and onSave, the doc is already loaded.
      this.#exported ??= exportDocMarkdown(this.document, this.name);
      const markdown = this.#exported;
      const entry: IndexEntry = { docId: this.name, title: this.document.getText('title').toString(), body: splitFrontmatter(markdown).body };
      const signature = `${entry.title}\u0000${entry.body}`;
      const edits = this.#edits;
      if (signature !== this.#fed) {
        const { linksChanged } = await feed.index(entry);
        this.#fed = signature;
        if (linksChanged && this.env?.DB && this.env.PrincipalDO) await publishMeta(this.env, [this.name]);
      }
      if (this.#searchStale && edits === this.#edits) {
        this.#store?.setMeta('search-fed', SEARCH_FEED_VERSION);
        this.#searchStale = false;
      }
    } catch (error) {
      console.error(`search feed for ${this.name} failed`, error);
    }
  }

  #seed(store: DocStore): void {
    if (store.meta('seeded') !== null) return;
    if (rootIsEmpty(this.document)) seedEmptyParagraph(this.document);
    store.setMeta('seeded', '1');
  }

  #persist(store: DocStore, update: Uint8Array, origin: unknown): void {
    this.#exported = null;
    if (origin === PERSISTENCE) return;
    store.record(update);
    this.#edits += 1;
    if (!this.#searchStale) {
      store.setMeta('search-fed', '');
      this.#searchStale = true;
    }
    if (isConnection(origin)) {
      this.#acks.schedule(origin, this.#frameDeletes);
      this.#projections?.touch();
    } else {
      // Server writes run with nothing parked: every client frame's leftovers were purged when it applied.
      store.compactIfDue(this.document);
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

  /** The bytes comment writes may still add to a state of `stateBytes`. */
  #commentRoom(stateBytes: number): number {
    return Math.floor(this.#limits.stateCapBytes * COMMENT_STATE_SHARE) - stateBytes;
  }

  #admitServerWrite(store: DocStore, diff: Uint8Array): void {
    if (this.#overCap(store, diff)) throw new DocCapError();
  }

  #coolingDown(principalId: string): boolean {
    const until = this.#cooldowns.get(principalId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.#cooldowns.delete(principalId);
    return false;
  }

  /** `SUGGEST_LIMITS.refusals.max` refusals a window: every socket of the principal closes 4429 a while. */
  #countRefusal(principalId: string): void {
    const now = Date.now();
    const { max, windowMs } = SUGGEST_LIMITS.refusals;
    const recent = (this.#refusals.get(principalId) ?? []).filter((at) => now - at < windowMs);
    recent.push(now);
    this.#refusals.set(principalId, recent);
    if (recent.length < max) return;
    this.#refusals.delete(principalId);
    this.#cooldowns.set(principalId, now + SUGGEST_LIMITS.cooldownMs);
    for (const connection of this.getConnections()) {
      if (attachmentOf(connection)?.principalId === principalId) connection.close(CLOSE.connectionLimit, 'suggest-cooldown');
    }
  }

  /** True when the write was refused and the socket closed; a refusal is never silent. */
  #refused(connection: Connection, attachment: Attachment, store: DocStore, update: Uint8Array, decoded: Decoded): boolean {
    // Suggesters never write the body: their changes travel as suggestion records (docs/design/suggestions.md I1).
    // The role decides, never the frame's contents.
    if (!roleAtLeast(attachment.role, 'editor')) {
      this.#refuse(connection, 'role', CLOSE.revoked);
      this.#countRefusal(attachment.principalId);
      return true;
    }
    if (!this.#rate.allow(connection)) {
      // Transient: the client keeps its Y.Doc and its next step 2 re-delivers everything.
      connection.close(CLOSE.writeRate, 'write rate');
      return true;
    }
    // Only the DocDO writes `suggestions` (I2), and a leased client id only ever writes a record (A§5.1 step 4).
    if (this.#suggestions?.touches(decoded) || this.#ingest?.namesLease(update)) {
      this.#refuse(connection, 'protected-type', CLOSE.writeRefused);
      this.#countRefusal(attachment.principalId);
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

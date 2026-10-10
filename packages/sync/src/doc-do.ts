import { getServerByName, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { YServer } from 'y-partyserver';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { writeSyncStep1 } from 'y-protocols/sync';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import {
  ACCESS_DEADLINE_MS, ACCESS_TICK_MS, ACK_COALESCE_MS, ANSWER_PIECE_BYTES, AWARENESS_MAX_BYTES, DOC_SOCKET_MAX_MS, MAX_CONNECTIONS, STATE_CAP_BYTES,
  WORKING_EXPORT_DOC_RATE, WRITE_RATE,
} from '@moss-multi/protocol/limits';
import { ROLES, roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { SUGGEST_LIMITS, type SuggestReply, type SuggestRequest } from '@moss-multi/protocol/suggest';
import {
  bytesToBase64, CLOSE, encodePayloadFrame, encodeSyncFrame, PAYLOAD_STEP1, PAYLOAD_STEP2, PAYLOAD_UPDATE, type PayloadAck, type PayloadFrame,
  type ServerEvent, type WriteRefusalReason,
} from '@moss-multi/protocol/sync';
import {
  attachmentFrom, classifySync, connectCode, EVERYONE, parseFrame, revocationCode, stateBytesAfter, WriteRate, type Attachment, type DeleteSet,
} from './doc/admission.ts';
import { attach, attachmentOf, awarenessTooLarge, awarenessFrame, receivePresence, leavePresence } from './doc/awareness.ts';
import { AckCoalescer, DocStore, PERSISTENCE } from './doc/persistence.ts';
import { coerceSidecar, COMMENT_STATE_SHARE, COMMENTS_PER_DOC, DocComments, type CommentCreate, type CommentDeleteScope, type CommentResult, type CommentSource } from './doc/comments.ts';
import { d1Projections, Projections, type ProjectionTarget } from './doc/projections.ts';
import { handleSuggest, SqlLeases, SuggestIngest, type Suggester } from './doc/suggest.ts';
import { newSuggestionsClient, readMeta, recordIds, SUGGESTIONS, SuggestionsWriter } from './suggest/records.ts';
import {
  acceptRecord, EMPTY_IDLE_MS, exportWorkingMarkdown, nodeRegistry, rejectRecord, reviewPreview, withdrawRecord, type Preview, type Reviewer, type ReviewResult,
} from './suggest/review.ts';
import { TRY_AGAIN, withDeadline, type Stamp } from './access-epoch.ts';
import { publishMeta } from './fanout.ts';
import type { SyncEnv } from './env.ts';
import { migrateFrontmatter } from '@moss-multi/core/frontmatter';
import { seedPayload } from './payload-docs.ts';
import { JANITOR, migratePayloads, PayloadStore, type PayloadWork } from './payloads.ts';
import { SEARCH_DO_NAME, type IndexEntry } from './search-do.ts';
import { attachPayloadSource, exportDocMarkdown, importBody, rootIsEmpty, SERVER_IMPORT, SERVER_SEED, seedEmptyParagraph } from './server-doc.ts';
import { writeTitle } from './server-title.ts';
import { splitUpdate } from './update-pieces.ts';

/** How long after a wake the doc re-feeds search. */
const WAKE_FEED_MS = 1_000;
/** How long after a payload-only edit the doc feeds search (the note's own saves cover note edits). */
const PAYLOAD_FEED_MS = 2_000;
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
  /** Withheld payload ids one connection may write at once (the ids it is minting, or holds after a delete). */
  withheldIdsPerConnection: number;
  /** Bytes one principal may write into withheld payloads, so nobody crowds out another's (A§10.10). */
  withheldBytesPerIdentity: number;
  /** Working-view exports this doc computes per window (I5); cached reads are free. */
  workingRate: { max: number; windowMs: number };
  /** Frames and bytes one socket may have waiting for a validation, and all sockets together; past it the socket closes 1013. */
  inboxFramesPerConnection: number;
  inboxBytesPerConnection: number;
  inboxBytes: number;
  /** How long a validation waits for D1 before failing closed (L§4.7). */
  accessDeadlineMs: number;
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

/** Who a socket is, as a re-resolution needs it. */
export type SocketIdentity = Pick<Attachment, 'principalId' | 'kind' | 'sessionId' | 'shareToken'>;

/** A socket's access as a fresh admission would resolve it: its role and whether it may see who else is here. */
export interface Resolved {
  role: Role;
  presence: boolean;
}

/**
 * Pull validation (A§8): `stamp` reads the doc's access epoch and which of the sockets' sessions and agent keys are
 * live; `resolve` re-resolves one socket's access to the doc ('deleted' for a doc in Trash, null without access). Both
 * throw when D1 cannot answer.
 */
export interface AccessCheck {
  stamp(docId: string, sessions: string[], agents: string[]): Promise<Stamp>;
  resolve(docId: string, socket: SocketIdentity): Promise<Resolved | 'deleted' | null>;
}

/** Whether D1 has the doc in Trash (or has no row for it); throws when D1 cannot answer. */
export type TrashedInD1 = (docId: string) => Promise<boolean>;

/** How long a trash's hold waits for its settle before the alarm settles it from D1. */
export const HOLD_MS = 60_000;
/** Store items a sub-editor's delete set may make the classifier visit per frame byte (its frame never applies). */
const CLASSIFY_BUDGET_PER_BYTE = 8;

/** A queue that runs each job after the previous one settles; a rejection reaches its caller, not the next job. */
const serializer = () => {
  let gate: Promise<unknown> = Promise.resolve();
  return <T>(run: () => Promise<T>): Promise<T> => {
    const next = gate.then(run);
    gate = next.catch(() => undefined);
    return next;
  };
};

/** Who a REST comment write stands for, as the Worker resolved it: its principal, session or key, and share token. */
export type CommentActor = SocketIdentity;

/** A refused review action: the gate's reason, or the actor's (as for comments). */
export type ReviewRefusal = { ok: false; status: number; reason: string };
export type SuggestionPreview = Preview & { closed?: boolean };

/** A new live suggestion, for the bell. */
export type SuggestionNotifier = (notice: { docId: string; author: string; record: string }) => Promise<void>;

/** A comment write whose authorization D1 could not confirm: refused, and the client may retry. */
const UNCONFIRMED: CommentResult = { ok: false, status: 503, error: 'unconfirmed' };

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

/** When a socket reaches DOC_SOCKET_MAX_MS from its admission here. */
const agesAt = (attachment: Attachment) => (attachment.admittedAt ?? 0) + DOC_SOCKET_MAX_MS;
const aged = (attachment: Attachment, now: number) => agesAt(attachment) <= now;

/** The trashes holding the doc closed, each with when the alarm may settle it. */
function holdsOf(store: DocStore): Map<string, number> {
  const raw = store.meta('holds');
  return new Map(raw ? Object.entries(JSON.parse(raw) as Record<string, number>) : []);
}

/** A socket the DO may still send to and read from. */
const isOpen = (connection: Connection) => connection.readyState === undefined || connection.readyState === 1;

const sizeOf = (message: WSMessage) => (typeof message === 'string' ? message.length : message.byteLength);

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

/** A save slower than this waits for writes to pause (T3.S6: large pastes, their undo and redo). */
const SLOW_FRAME_MS = 1_000;
/** A slow save waits for this long without a client write. */
const WRITE_PAUSE_MS = 2_000;
/** A suggester's new records notify the bell at most once per this long. */
const NOTICE_COALESCE_MS = 10 * 60_000;
export class DocDO extends YServer<SyncEnv> {
  static options = { hibernate: true };
  /** Static so the Node harness can shrink them. */
  static limits: DocLimits = {
    stateCapBytes: STATE_CAP_BYTES,
    maxConnections: MAX_CONNECTIONS,
    writeRate: WRITE_RATE,
    awarenessMaxBytes: AWARENESS_MAX_BYTES,
    maxComments: COMMENTS_PER_DOC,
    withheldIdsPerConnection: 64,
    withheldBytesPerIdentity: Math.floor(STATE_CAP_BYTES / 4),
    inboxFramesPerConnection: 256,
    // A workerd frame is at most 1 MiB, so one socket may always have its largest frame waiting.
    inboxBytesPerConnection: 2 * 1024 * 1024,
    inboxBytes: 8 * 1024 * 1024,
    accessDeadlineMs: ACCESS_DEADLINE_MS,
    workingRate: WORKING_EXPORT_DOC_RATE,
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
  /**
   * How sockets are re-validated before each frame (A§8 pull validation). The Worker installs the one resolver
   * (apps/web/src/server.ts); with none, frames apply as they arrive (the Node harness).
   */
  static access: (env: SyncEnv) => AccessCheck | null = () => null;
  /** Who hears of a new live suggestion (the bell); installed by the Worker. */
  static suggestionNotices: (env: SyncEnv) => SuggestionNotifier | null = () => null;

  /** Where search feeds land; null leaves the doc unindexed. */
  static searchFeed: (env: SyncEnv) => SearchFeed | null = (env) => (env?.SearchDO ? {
    index: async (entry) => (await getServerByName(env.SearchDO, SEARCH_DO_NAME)).index(entry),
  } : null);

  readonly instanceId = crypto.randomUUID();
  /** Payload work since the last reset, which the harness reads to bound it (A§10.10). */
  get payloadWork(): PayloadWork {
    return this.#payloads?.work ?? { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, renamed: 0, compared: 0, held: 0 };
  }
  readonly constructedAt = Date.now();

  #store: DocStore | null = null;
  #comments: DocComments | null = null;
  #payloads: PayloadStore | null = null;
  #exported: string | null = null;
  /** The working view (§4.7), dropped with #exported by every note, record and payload update. */
  #working: string | null = null;
  #projections: Projections | null = null;
  /** The title and body this instance last fed to search. */
  #fed: string | null = null;
  /** Doc edits since load; a feed marks the doc fed only if none landed while it ran. */
  #edits = 0;
  /** When the last client write landed, how long the last save took, and a save waiting for the writes to pause. */
  #lastWriteAt = 0;
  #saveMs = 0;
  #quietSave: ReturnType<typeof setTimeout> | undefined;
  /** Whether the stored `search-fed` meta is cleared (an edit the index may lack). */
  #searchStale = false;
  /** A feed queued by a payload edit; payload docs do not trigger the note's debounced save. */
  #payloadFeed: ReturnType<typeof setTimeout> | null = null;
  readonly #limits = (this.constructor as typeof DocDO).limits;
  readonly #rate = new WriteRate(this.#limits.writeRate.max, this.#limits.writeRate.windowMs);
  readonly #workingRate = new WriteRate(this.#limits.workingRate.max, this.#limits.workingRate.windowMs);
  readonly #acks = new AckCoalescer<Connection>((connection, deletes, payloads) => this.#ack(connection, deletes, payloads), ACK_COALESCE_MS);
  /** The deletes of the sync frame being applied, which its ack names. */
  #frameDeletes: DeleteSet | undefined;
  /** Settles run one at a time, so the last one applies the newest D1 read. */
  readonly #queue = serializer();
  /** Withheld payload ids each connection has written, bounded per connection. In memory: a wake starts at none. */
  readonly #withheldWrites = new WeakMap<Connection, Set<string>>();
  /** Frames waiting for the validation that starts after they arrived. */
  #inbox: [Connection, WSMessage][] = [];
  /** Frames and bytes each socket has waiting, from arrival until applied or dropped, and their total bytes. */
  readonly #waiting = new Map<Connection, { frames: number; bytes: number }>();
  #waitingBytes = 0;
  /** A flush that has not started yet; a frame arriving now joins it. */
  #pendingFlush: Promise<void> | null = null;
  /** Validations, admissions and frame batches run one at a time, in arrival order. */
  readonly #serial = serializer();
  /** When the next access tick is due; null when no frame came since the last one. In memory: a wake starts idle. */
  #tickAt: number | null = null;
  /** The one writer of `suggestions` (reserved client S) and the suggestion ingest (docs/design/suggestions.md). */
  #suggestions: SuggestionsWriter | null = null;
  #ingest: SuggestIngest | null = null;
  /**
   * When the next idle check of open records is due (§4.7: an idle record with nothing to show is rejected by the
   * system), and the `updatedAt` each record was last checked at. In memory: a wake checks on the next record change.
   */
  #idleAt: number | null = null;
  readonly #idleChecked = new Map<string, number>();
  /** Suggest refusals per principal in the last window, and principals cooling down (until when). In memory. */
  readonly #refusals = new Map<string, number[]>();
  readonly #cooldowns = new Map<string, number>();
  /** Connections whose last suggest refusal was for want of room (`doc-cap`, `ops-cap`), until a grant or an ack. */
  readonly #noRoom = new Set<string>();

  /** Runs inside partyserver's blockConcurrencyWhile, so a woken DO replays before it sees any frame. */
  override async onLoad(): Promise<void> {
    const store = new DocStore(this.ctx.storage);
    // The naming index is built by the replay itself, from each transaction's own structs.
    const payloads = new PayloadStore(this.ctx.storage, this.document, {
      broadcast: (id, update, origin) => this.#broadcastPayload(id, update, origin),
      persisted: (_id, _update, origin) => {
        this.#exported = null;
        this.#working = null;
        this.#edited(store);
        if (isConnection(origin)) {
          this.#projections?.touch();
          if (!this.#payloadFeed) this.#payloadFeed = setTimeout(() => {
            this.#payloadFeed = null;
            void this.#feedSearch();
          }, PAYLOAD_FEED_MS);
        }
      },
      principalOf: (origin) => (isConnection(origin) ? (attachmentOf(origin)?.principalId ?? '') : null),
    });
    store.load(this.document);
    this.#store = store;
    this.#payloads = payloads;
    this.document.on('update', (update: Uint8Array, origin: unknown) => this.#persist(store, update, origin));
    // R from meta and the anchor indexes from the `a:` records (comments.md §3, I8).
    this.#comments = new DocComments(this.document, store);
    migrateFrontmatter(this.document, 'frontmatter-migration');
    const migrated = migratePayloads(this.document, (id, value) => {
      if (!payloads.has(id)) seedPayload(payloads.doc(id), value, JANITOR);
    });
    // The migrated text leaves the note's rows too.
    if (migrated) store.compact(this.document);
    payloads.loaded();
    attachPayloadSource(this.document, {
      read: (id) => payloads.read(id),
      has: (id) => payloads.has(id),
      write: (id, update) => payloads.write(id, update, SERVER_IMPORT),
      totalBytes: () => payloads.totalBytes,
      bytesOf: (id) => payloads.bytesOf(id),
    });
    // After every note update (a frame, a server write, a restore, a push): reveal and keep one element per id.
    this.document.on('afterAllTransactions', () => payloads.settle(() => this.#connected()));
    this.#seed(store);
    this.#comments.flush();
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
      // The note plus every stored payload, withheld ones included, as #overCap counts (A§10).
      stateBytes: () => store.stateBytes + payloads.totalBytes,
      // Only a served payload places a payload op; a withheld one is accept's G4 to refuse, and reads as unknown here.
      payloadDoc: (id) => (payloads.served(id) ? payloads.doc(id) : undefined),
      onCreated: (record, author, continues) => {
        if (!continues) this.#noticeSuggestion(record, author);
      },
    });
    store.onCompacted = () => this.#ingest?.remeasure();
    this.document.getMap(SUGGESTIONS).observeDeep(() => {
      if (this.#idleAt !== null) return;
      this.#idleAt = Date.now() + EMPTY_IDLE_MS;
      void this.#schedule(holdsOf(store)).catch((error: unknown) => console.error('DocDO could not schedule the idle check', error));
    });
    // A wake forgets when the idle check was due, so any open record gets one at the next alarm.
    if (recordIds(this.document).some((id) => readMeta(this.document, id)?.status === 'open')) this.#idleAt = Date.now();
    const target = (this.constructor as typeof DocDO).projectionTarget(this.env);
    if (target) this.#project(new Projections(this.name, target));
    // A wake re-feeds only a doc the index may lack (L§4.14): an edit whose feed never landed, or an older entry
    // shape; once onStart has served the waiting frames. A doc being created is fed by the save its content triggers.
    this.#searchStale = store.meta('search-fed') !== SEARCH_FEED_VERSION;
    if (this.#searchStale && store.meta('created') !== null) setTimeout(() => void this.#feedSearch(), WAKE_FEED_MS);
  }

  /**
   * Debounced by y-partyserver (2 s, at most 10 s). On a large note its compaction and search export take seconds, and
   * at most every 10 s while a large paste streams in they held the DO, with the writes it was applying, past a peer's
   * 12 s silence limit (T3.S6): a save that took over a second waits until the writes pause.
   */
  override async onSave(): Promise<void> {
    clearTimeout(this.#quietSave);
    if (this.#saveMs > SLOW_FRAME_MS && Date.now() - this.#lastWriteAt < WRITE_PAUSE_MS) {
      this.#quietSave = setTimeout(() => void this.onSave(), WRITE_PAUSE_MS);
      return;
    }
    const started = Date.now();
    if (this.#store && this.#store.pendingRows > 0) this.#store.compact(this.document);
    await this.#feedSearch();
    this.#saveMs = Date.now() - started;
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
      connections: [...this.#all()].length,
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
    const check = this.#accessCheck();
    // Pending until validated: no broadcast reaches it and none of its frames apply before then (A§8).
    attach(connection, { ...attachment, nonce: crypto.randomUUID(), admittedAt: Date.now(), pending: check !== null });
    this.#register(connection, attachment, store);
    // Admission re-checks once the socket is registered, so a revocation that commits while the Worker resolved the
    // role, or after, is seen here or by the socket's first frame (A§8 pull validation).
    if (check) {
      try {
        await this.#serial(() => this.#validate(check, [connection]));
      } catch (error) {
        console.error('DocDO admission could not validate access', error);
        connection.close(TRY_AGAIN, 'unvalidated');
        return;
      }
      if (!isOpen(connection)) return;
      this.#tickAt ??= Date.now() + ACCESS_TICK_MS;
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    writeSyncStep1(encoder, this.document);
    connection.send(encoding.toUint8Array(encoder));
    // The payload bytes the cap counts, withheld ones too (a client holds only the payloads its tree names); none: 0.
    const payloadBytes = this.#payloads?.totalBytes ?? 0;
    if (payloadBytes > 0) this.sendCustomMessage(connection, JSON.stringify({ t: 'usage', pb: payloadBytes } satisfies ServerEvent));
    if (attachment.presenceAllowed && this.document.awareness.getStates().size) {
      connection.send(awarenessFrame(this.document.awareness, [...this.document.awareness.getStates().keys()]));
    }
    await this.#schedule(holdsOf(store));
    // Frames it sent while pending waited in the inbox.
    if (check && this.#inbox.length > 0) await this.#drain();
  }

  /**
   * With an access check, a frame waits for a validation that starts after it arrived (A§8 pull validation): a
   * revocation committed before then closes the socket it outdates, and the frame never applies. Frames arriving
   * while one validation is in flight share the next.
   */
  override onMessage(connection: Connection, message: WSMessage): void | Promise<void> {
    if (!this.#accessCheck()) {
      this.#handle(connection, message);
      return;
    }
    if (!isOpen(connection)) return;
    // Bounded before it waits: a socket that queues past its share, or past the DO's, closes 1013 and resends later.
    const bytes = sizeOf(message);
    const waiting = this.#waiting.get(connection) ?? { frames: 0, bytes: 0 };
    if (waiting.frames + 1 > this.#limits.inboxFramesPerConnection || waiting.bytes + bytes > this.#limits.inboxBytesPerConnection
      || this.#waitingBytes + bytes > this.#limits.inboxBytes) {
      this.#dropWaiting(connection);
      connection.close(TRY_AGAIN, 'inbox full');
      return;
    }
    this.#waiting.set(connection, { frames: waiting.frames + 1, bytes: waiting.bytes + bytes });
    this.#waitingBytes += bytes;
    this.#inbox.push([connection, message]);
    return this.#drain();
  }

  /** A waiting frame leaves the bound's accounting: applied, dropped or refused. */
  #taken(connection: Connection, message: WSMessage): void {
    const bytes = sizeOf(message);
    this.#waitingBytes = Math.max(0, this.#waitingBytes - bytes);
    const waiting = this.#waiting.get(connection);
    if (!waiting) return;
    if (waiting.frames <= 1) this.#waiting.delete(connection);
    else this.#waiting.set(connection, { frames: waiting.frames - 1, bytes: Math.max(0, waiting.bytes - bytes) });
  }

  /** Drops the frames a closing socket has waiting in the inbox (a batch being validated skips them itself). */
  #dropWaiting(connection: Connection): void {
    if (!this.#waiting.has(connection)) return;
    this.#inbox = this.#inbox.filter(([queued, message]) => {
      if (queued !== connection) return true;
      this.#taken(queued, message);
      return false;
    });
  }

  #drain(): Promise<void> {
    if (this.#pendingFlush) return this.#pendingFlush;
    const flush = this.#serial(() => this.#flush());
    this.#pendingFlush = flush;
    return flush;
  }

  /** Only validated sockets: y-partyserver's update and awareness broadcasts and every relay here go through this. */
  override *getConnections<TState = unknown>(tag?: string): Iterable<Connection<TState>> {
    for (const connection of super.getConnections<TState>(tag)) {
      const attachment = attachmentOf(connection);
      if (attachment && !attachment.pending) yield connection;
    }
  }

  /** Every accepted socket, validated or not: what closes, counts and schedules. */
  #all(): Iterable<Connection> {
    return super.getConnections();
  }

  async #flush(): Promise<void> {
    this.#pendingFlush = null;
    const batch = this.#inbox.splice(0);
    const check = this.#accessCheck();
    if (check) {
      try {
        await this.#validate(check);
      } catch (error) {
        // Fail closed: nothing applies unvalidated. The clients reconnect and resend.
        console.error('DocDO could not validate access; refusing frames', error);
        for (const [connection, message] of batch) {
          this.#taken(connection, message);
          connection.close(TRY_AGAIN, 'unvalidated');
        }
        return;
      }
    }
    const deferred: [Connection, WSMessage][] = [];
    for (const [connection, message] of batch) {
      const attachment = attachmentOf(connection);
      // Still being admitted: its frames wait for its own validation, which drains them.
      if (isOpen(connection) && (!attachment || attachment.pending)) {
        deferred.push([connection, message]);
        continue;
      }
      this.#taken(connection, message);
      if (!isOpen(connection)) continue;
      try {
        this.#handle(connection, message);
      } catch (error) {
        console.error('DocDO frame failed', error);
      }
    }
    this.#inbox.unshift(...deferred);
    if (check && this.#tickAt === null && this.#connected()) {
      this.#tickAt = Date.now() + ACCESS_TICK_MS;
      const store = this.#store;
      if (store) await this.#schedule(holdsOf(store));
    }
  }

  #handle(connection: Connection, message: WSMessage): void {
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
    if (aged(attachment, Date.now())) {
      connection.close(TRY_AGAIN, 'aged');
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
    if (frame.kind === 'step1') {
      this.#answer(connection, message);
      return;
    }
    // Inert frames (every step 2 answering a step 1) pass whatever the role; writes meet the gates.
    /** A frame Yjs will apply: an editor's write. */
    let applying: ReturnType<typeof Y.decodeUpdate> | null = null;
    if (frame.kind === 'sync') {
      let decoded: ReturnType<typeof Y.decodeUpdate>;
      try {
        decoded = Y.decodeUpdate(frame.update);
      } catch {
        this.#refuse(connection, 'unresolved', CLOSE.writeRefused);
        return;
      }
      const writer = roleAtLeast(attachment.role, 'editor');
      // Below editor the frame never applies, so its classification is bounded by its own size (I5).
      const budget = writer ? Infinity : frame.update.byteLength * CLASSIFY_BUDGET_PER_BYTE + 1024;
      const { changes, missing, deletes } = classifySync(this.document, frame.update, decoded, budget);
      const guarded = () => !!this.#comments?.check(decoded);
      // Only the DocDO writes `suggestions` (I2), and a leased client id only ever writes a record (A§5.1 step 4).
      const leased = () => !!this.#suggestions?.touches(decoded) || !!this.#ingest?.namesLease(frame.update);
      if (changes && this.#refused(connection, attachment, () => this.#overCap(store, frame.update), missing, guarded, leased)) return;
      // Gate 2b on every step 2 or update, inert or not, whatever the role: no client frame reaches `comments`
      // (comments.md §3, I1). O(frame · log); it follows no references.
      if (!changes && guarded()) {
        this.#refuse(connection, 'protected-type', CLOSE.writeRefused);
        return;
      }
      if (!changes && roleAtLeast(attachment.role, 'editor')) {
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

  /**
   * A step 1's answer in frames of at most about ANSWER_PIECE_BYTES, whole blocks each: updates, then the step 2, so
   * the provider reads as synced only once all of it has landed. y-partyserver sent it as one frame, and a peer behind
   * a large paste was sent megabytes it read as silence until they arrived (T3.S6b).
   */
  #answer(connection: Connection, message: ArrayBuffer | ArrayBufferView): void {
    const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    const decoder = decoding.createDecoder(bytes);
    decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    const update = Y.encodeStateAsUpdate(this.document, decoding.readVarUint8Array(decoder));
    const pieces = update.byteLength > ANSWER_PIECE_BYTES ? splitUpdate(update, ANSWER_PIECE_BYTES).map((piece) => piece.update) : [update];
    for (const [index, piece] of pieces.entries()) send(connection, encodeSyncFrame(index === pieces.length - 1 ? 1 : 2, piece));
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
    // A refusal for want of room (`doc-cap`, `ops-cap`) is the note's state, not abuse: it never counts toward the
    // cooldown, so a fast typist or a reload on a full note stays connected. After one, the growth frames the client
    // had in flight are refused alike in O(1); a granted lease or an ack ends that.
    if (this.#noRoom.has(connection.id) && (request?.t === 'suggest-ops' || request?.t === 'suggest-delete' || request?.t === 'suggest-merge')) {
      const record = request.t === 'suggest-merge' ? request.into : request.record;
      const reply: SuggestReply = { t: 'suggest-refused', record: typeof record === 'string' ? record : null, reason: 'doc-cap' };
      this.sendCustomMessage(connection, JSON.stringify(reply));
      return;
    }
    const who: Suggester = { id: attachment.principalId, name: attachment.name, role: attachment.role, connection: attachment.nonce ?? connection.id };
    const reply: SuggestReply = request ? handleSuggest(ingest, who, request) : { t: 'suggest-refused', record: null, reason: 'malformed' };
    this.sendCustomMessage(connection, JSON.stringify(reply));
    if (reply.t !== 'suggest-refused') {
      this.#noRoom.delete(connection.id);
      return;
    }
    if (reply.reason === 'doc-cap' || reply.reason === 'ops-cap') this.#noRoom.add(connection.id);
    else this.#countRefusal(attachment.principalId);
  }

  override onClose(connection: Connection): void {
    const nonce = attachmentOf(connection)?.nonce;
    if (nonce) this.#ingest?.expireConnection(nonce);
    leavePresence(this.document.awareness, connection, this.getConnections());
    this.#dropWaiting(connection);
    this.#rate.forget(connection);
    this.#noRoom.delete(connection.id);
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
      const marks = importBody(this.document, hasFrontmatter ? parts.body : input.markdown, (diff, payloads) => this.#admitServerWrite(store, diff, payloads), frontmatter, sidecar);
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
    // Every open socket hears the rename, so each must still have access (A§8 pull validation).
    const check = this.#accessCheck();
    if (check) await this.#serial(() => this.#validate(check));
    writeTitle(this.document, text, SERVER_TITLE);
    this.#comments?.flush();
    this.#projections?.touch();
    await this.#projections?.flush();
  }

  /**
   * A comment or reply from REST (comments.md §4): `author` is the server principal the Worker resolved, and the
   * Worker has checked commenter access and the per-principal rate. Records persist in this turn.
   */
  createComment(input: CommentCreate & { actor?: CommentActor }): Promise<CommentResult> {
    const { actor, ...create } = input;
    return this.#commentWrite(actor, (store, comments) => {
      // The record and anchor bytes, quote included, count against the comments' share of the cap (A§5.1 Limits).
      const result = comments.create(create, this.#limits.maxComments, this.#commentRoom(store.stateBytes));
      comments.flush();
      return result;
    });
  }

  /** Resolves or reopens a thread for a commenter or above (comments.md §12). */
  resolveComment(input: { id: string; resolved: boolean; by: CommentSource; actor?: CommentActor }): Promise<CommentResult> {
    return this.#commentWrite(input.actor, (_store, comments) => comments.resolve(input.id, input.resolved, input.by));
  }

  /** Edits a comment's text; `author` is the Worker's principal and must be the comment's author (comments.md §12). */
  editComment(input: { id: string; author: string; text: string; actor?: CommentActor }): Promise<CommentResult> {
    return this.#commentWrite(input.actor, (store, comments) => comments.edit(input.id, input.author, input.text, this.#commentRoom(store.stateBytes)));
  }

  /** Deletes a comment or a whole thread as its author; a root delete promotes the oldest reply (comments.md §12). */
  deleteComment(input: { id: string; author: string; scope: CommentDeleteScope; actor?: CommentActor }): Promise<CommentResult> {
    return this.#commentWrite(input.actor, (_store, comments) => comments.remove(input.id, input.author, input.scope));
  }

  /** Adds or removes the principal's reaction on a comment (comments.md §12). */
  reactComment(input: { id: string; principal: string; emoji: string; on: boolean; actor?: CommentActor }): Promise<CommentResult> {
    return this.#commentWrite(input.actor, (store, comments) => comments.react(input.id, input.principal, input.emoji, input.on, this.#commentRoom(store.stateBytes)));
  }

  /**
   * Every comment write (A§8 pull validation, T2.5): in one serialized write the open sockets are validated, the actor
   * is re-resolved through the same check whether or not it has a socket (a live session or key, at least commenter,
   * a live doc), and the write runs right after with no await between. A check that cannot answer refuses. With no
   * access check installed (the Node harness), writes apply as frames do.
   */
  async #commentWrite(actor: CommentActor | undefined, write: (store: DocStore, comments: DocComments) => CommentResult): Promise<CommentResult> {
    const store = await this.#ready();
    const comments = this.#comments;
    if (!comments) throw new Error('DocDO started without comments');
    // A doc closed without a hold may have missed a restore's settle: D1 decides, as at admission.
    if (store.meta('deleted') === '1' && holdsOf(store).size === 0 && this.#liveness()) {
      try {
        await this.#queue(() => this.#settle([]));
      } catch (error) {
        console.error('DocDO comment write could not confirm the doc is live', error);
        return UNCONFIRMED;
      }
    }
    const check = this.#accessCheck();
    return this.#serial(async () => {
      if (check) {
        let refused: CommentResult | null;
        try {
          await this.#validate(check);
          refused = await this.#authorizeActor(check, store, actor);
        } catch (error) {
          console.error('DocDO could not re-authorize a comment write; refusing it', error);
          return UNCONFIRMED;
        }
        if (refused) return refused;
      }
      // A trash holds the doc closed to every write (A§8), and a settled one leaves it deleted.
      if (holdsOf(store).size > 0 || store.meta('deleted') === '1') return { ok: false, status: 404, error: 'trashed' };
      return write(store, comments);
    });
  }

  /** The actor's verdict now: null while it may comment, else the refusal. Throws when D1 cannot answer. */
  async #authorizeActor(check: AccessCheck, store: DocStore, actor: CommentActor | undefined): Promise<CommentResult | null> {
    const resolved = await this.#resolveActor(check, store, actor);
    if ('ok' in resolved) return resolved;
    return roleAtLeast(resolved.role, 'commenter') ? null : { ok: false, status: 403, error: 'forbidden' };
  }

  /** The actor's live role now, or the refusal (no live credential, no access, a revocation). Throws when D1 cannot answer. */
  async #resolveActor(check: AccessCheck, store: DocStore, actor: CommentActor | undefined): Promise<CommentResult | { role: Role }> {
    const unauthenticated: CommentResult = { ok: false, status: 401, error: 'unauthenticated' };
    if (!actor || (actor.kind !== 'user' && actor.kind !== 'agent')) return unauthenticated;
    const session = actor.kind === 'user' ? actor.sessionId : null;
    if (actor.kind === 'user' && !session) return unauthenticated;
    const resolvedAt = Date.now();
    const { stamp, access } = await withDeadline(this.#limits.accessDeadlineMs, async (race) => {
      const read = await race(check.stamp(this.name, session ? [session] : [], actor.kind === 'agent' ? [actor.principalId] : []));
      return { stamp: read, access: await race(check.resolve(this.name, actor)) };
    });
    if (session ? !stamp.sessions.has(session) : !stamp.agents.has(actor.principalId)) return unauthenticated;
    if (access === 'deleted') return { ok: false, status: 404, error: 'trashed' };
    if (access === null) return { ok: false, status: 404, error: 'not-found' };
    // A kick persisted while D1 answered outdates what it said.
    if (revocationCode({ ...actor, resolvedAt } as Attachment, store.revoked) !== null) return { ok: false, status: 403, error: 'forbidden' };
    return { role: access.role as Role };
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
    // The access tick (A§8): a socket that sends nothing still closes once its access is gone. Any alarm runs it, since
    // a woken DO does not know whether this one was a tick.
    const check = this.#accessCheck();
    if (this.#tickAt !== null && this.#tickAt <= now) this.#tickAt = null;
    if (check && this.#connected()) {
      try {
        await this.#serial(() => this.#validate(check));
      } catch (error) {
        console.error('DocDO access tick could not validate; retrying', error);
        this.#tickAt = now + ACCESS_TICK_MS;
      }
    }
    // A socket at DOC_SOCKET_MAX_MS reconnects, so the sign-out registry never outlives a socket it should name.
    for (const connection of this.#all()) {
      const attachment = attachmentOf(connection);
      if (attachment && aged(attachment, now)) connection.close(TRY_AGAIN, 'aged');
    }
    if (this.#idleAt !== null && this.#idleAt <= now) {
      this.#idleAt = null;
      try {
        await this.#serial(async () => this.#checkIdle(now));
      } catch (error) {
        console.error('DocDO idle check failed', error);
      }
    }
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
    for (const connection of this.#all()) {
      const attachment = attachmentOf(connection);
      const code = attachment ? revocationCode(attachment, store.revoked) : null;
      if (code === null) continue;
      connection.close(code, code === CLOSE.sessionEnded ? 'session ended' : 'revoked');
      closed += 1;
    }
    return { closed };
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
    this.#comments?.dropCopied();
    this.#comments?.flush();
    // A copy has no pending suggestions: the source's records were written under the source's reserved client (I2).
    this.#suggestions?.write(() => this.document.getMap(SUGGESTIONS).clear());
    store.setMeta('folder', input.folderId);
    store.setMeta('owner', input.ownerId);
    await this.#projections?.flush();
    store.setMeta('created', '1');
  }

  /**
   * The hunks a reviewer is shown and the hash and digest an accept must name (docs/design/suggestions.md §4.4), for
   * any reader. An idle record with nothing to show is rejected by the system; an outdated or broken one is badged.
   */
  previewSuggestion(input: { id: string; reviewer: Reviewer; actor?: CommentActor }): Promise<SuggestionPreview | ReviewRefusal> {
    return this.#review(input, 'viewer', () => reviewPreview(this.document, input.id));
  }

  /**
   * Accept (§4.1–4.3): editor and above, in one synchronous turn after the actor is re-authorized. The record lands
   * exactly as previewed or nothing does; its leases are spent in the same turn.
   */
  acceptSuggestion(input: { id: string; reviewer: Reviewer; actor?: CommentActor; previewHash: string; digest: string }): Promise<ReviewResult | ReviewRefusal> {
    return this.#review(input, 'editor', (reviewer) => {
      const result = acceptRecord(this.document, input.id, { previewHash: input.previewHash, digest: input.digest }, reviewer, { stateCap: this.#limits.stateCapBytes });
      if (result.ok) {
        this.#comments?.flush();
        this.#projections?.touch();
      }
      return result;
    });
  }

  /** Reject (§4.5): editor and above; only the record changes. */
  rejectSuggestion(input: { id: string; reviewer: Reviewer; actor?: CommentActor }): Promise<ReviewResult | ReviewRefusal> {
    return this.#review(input, 'editor', (reviewer) => rejectRecord(this.document, input.id, reviewer));
  }

  /** Withdraw (§4.5): the author, at any role from suggester up; only the record changes. */
  withdrawSuggestion(input: { id: string; reviewer: Reviewer; actor?: CommentActor }): Promise<ReviewResult | ReviewRefusal> {
    return this.#review(input, 'suggester', (reviewer) => withdrawRecord(this.document, input.id, reviewer));
  }

  /**
   * One review action in the doc's serialized write (A§8 pull validation): the actor is re-resolved and its live role,
   * not the Worker's, is the reviewer's; the action runs right after with no await between. A trashed doc refuses.
   */
  async #review<T>(input: { reviewer: Reviewer; actor?: CommentActor }, floor: Role, run: (reviewer: Reviewer) => T): Promise<T | ReviewRefusal> {
    const store = await this.#ready();
    const check = this.#accessCheck();
    return this.#serial(async (): Promise<T | ReviewRefusal> => {
      let reviewer = input.reviewer;
      if (check) {
        let resolved: CommentResult | { role: Role };
        try {
          await this.#validate(check);
          resolved = await this.#resolveActor(check, store, input.actor);
        } catch (error) {
          console.error('DocDO could not re-authorize a suggestion review; refusing it', error);
          return { ok: false, status: 503, reason: 'unconfirmed' };
        }
        if ('ok' in resolved) return { ok: false, status: resolved.ok ? 500 : resolved.status, reason: resolved.ok ? 'unconfirmed' : resolved.error };
        reviewer = { id: input.reviewer.id, role: resolved.role };
      }
      if (holdsOf(store).size > 0 || store.meta('deleted') === '1') return { ok: false, status: 404, reason: 'trashed' };
      if (!roleAtLeast(reviewer.role, floor)) return { ok: false, status: 403, reason: 'role' };
      return run(reviewer);
    });
  }

  /** Each open record idle since its last check gets its preview, which rejects an empty one; the rest come due later. */
  #checkIdle(now: number): void {
    let next: number | null = null;
    for (const id of recordIds(this.document)) {
      const meta = readMeta(this.document, id);
      if (!meta || meta.status !== 'open' || this.#idleChecked.get(id) === meta.updatedAt) continue;
      const due = meta.updatedAt + EMPTY_IDLE_MS;
      if (due > now) {
        next = Math.min(next ?? due, due);
        continue;
      }
      this.#idleChecked.set(id, meta.updatedAt);
      reviewPreview(this.document, id, { now });
    }
    if (next !== null) this.#idleAt = Math.min(this.#idleAt ?? next, next);
  }

  /** One bell notice per author and note per window, kept across wakes; the D1 row coalesces too (notifySuggestion). */
  #noticeSuggestion(record: string, author: string): void {
    const notify = (this.constructor as typeof DocDO).suggestionNotices(this.env);
    if (!notify) return;
    const key = `suggest-noticed:${author}`;
    const last = Number(this.#store?.meta(key));
    const now = Date.now();
    if (Number.isFinite(last) && last > 0 && now - last < NOTICE_COALESCE_MS) return;
    this.#store?.setMeta(key, String(now));
    const sent = notify({ docId: this.name, author, record }).catch((error: unknown) => console.error('suggestion notice failed', error));
    try {
      this.ctx.waitUntil(sent);
    } catch {
      // No request to extend (the Node harness): the notice still runs.
    }
  }

  /** The doc as a `.md` file, memoized until the next update. */
  async exportMarkdown(): Promise<string> {
    await this.#ready();
    this.#exported ??= exportDocMarkdown(this.document, this.name);
    return this.#exported;
  }

  /**
   * The working view (§4.7): the note with every valid open suggestion applied, memoized until the next note, record
   * or payload update. Computing it runs the accept gates per open record, so it is bounded per doc (I5); null past it.
   */
  async exportWorking(): Promise<string | null> {
    await this.#ready();
    if (this.#working !== null) return this.#working;
    if (!this.#workingRate.allow(this)) return null;
    this.#working = exportWorkingMarkdown(this.document, this.name);
    return this.#working;
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

  #accessCheck(): AccessCheck | null {
    return (this.constructor as typeof DocDO).access(this.env);
  }

  /**
   * Pull validation (A§8): reads the doc's access epoch and the sockets' credentials, then closes every socket whose
   * session ended (4402) or key was revoked (4403), and re-resolves each socket admitted under an older epoch, closing
   * it on a lowered or lost role (4403) or a doc in Trash (4410). A socket that keeps its role takes the new epoch.
   * Throws, closing nothing, when D1 cannot answer.
   */
  async #validate(check: AccessCheck, only?: Connection[]): Promise<void> {
    const sockets = (only ?? [...this.#all()]).flatMap((connection) => {
      const attachment = attachmentOf(connection);
      return attachment && isOpen(connection) ? [{ connection, attachment }] : [];
    });
    if (sockets.length === 0) return;
    const { stamp, verdicts } = await withDeadline(this.#limits.accessDeadlineMs, (race) => this.#verdicts(check, sockets, race));
    for (const [i, { connection, attachment }] of sockets.entries()) {
      const verdict = verdicts[i];
      if (!isOpen(connection)) continue;
      if (verdict === null) {
        // Read fresh: a validation that ran meanwhile may have admitted it already.
        if (attachmentOf(connection)?.pending) attach(connection, { ...attachment, pending: false });
        continue;
      }
      if (typeof verdict === 'object') {
        attach(connection, { ...attachment, epoch: stamp.key, presenceAllowed: verdict.presence, pending: false });
        continue;
      }
      if (verdict === CLOSE.deleted) this.sendCustomMessage(connection, JSON.stringify({ t: 'doc-deleted' } satisfies ServerEvent));
      connection.close(verdict, verdict === CLOSE.sessionEnded ? 'session ended' : verdict === CLOSE.deleted ? 'deleted' : 'revoked');
    }
  }

  /**
   * Each socket's verdict: null to keep it as admitted, its access when re-resolved and kept, or the code that closes
   * it. Every D1 read goes through `race`, the validation's deadline.
   */
  async #verdicts(
    check: AccessCheck,
    sockets: { attachment: Attachment }[],
    race: <R>(read: Promise<R>) => Promise<R>,
  ): Promise<{ stamp: Stamp; verdicts: (number | Resolved | null)[] }> {
    const unique = (ids: (string | null)[]) => [...new Set(ids.filter((id): id is string => id !== null))];
    const stamp = await race(check.stamp(
      this.name,
      unique(sockets.map(({ attachment }) => (attachment.kind === 'user' ? attachment.sessionId : null))),
      unique(sockets.map(({ attachment }) => (attachment.kind === 'agent' ? attachment.principalId : null))),
    ));
    const resolved = new Map<string, Promise<Resolved | 'deleted' | null>>();
    const verdicts = await race(Promise.all(sockets.map(async ({ attachment }): Promise<number | Resolved | null> => {
      if (attachment.kind === 'user' && attachment.sessionId !== null && !stamp.sessions.has(attachment.sessionId)) return CLOSE.sessionEnded;
      if (attachment.kind === 'agent' && !stamp.agents.has(attachment.principalId)) return CLOSE.revoked;
      if (stamp.key && attachment.epoch === stamp.key) return null;
      const who = [attachment.kind, attachment.principalId, attachment.sessionId, attachment.shareToken].join('|');
      let access = resolved.get(who);
      if (!access) resolved.set(who, (access = check.resolve(this.name, attachment)));
      const now = await access;
      if (now === 'deleted') return CLOSE.deleted;
      if (now === null || ROLES.indexOf(now.role) < ROLES.indexOf(attachment.role)) return CLOSE.revoked;
      // Kept, with presence as a fresh admission would allow it: a socket only a link still lifts no longer sees who is here.
      return { role: attachment.role, presence: now.presence };
    })));
    return { stamp, verdicts };
  }

  #liveness(): TrashedInD1 | null {
    return (this.constructor as typeof DocDO).liveness(this.env);
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

  /** The alarm goes off when the oldest hold has waited HOLD_MS, or the oldest socket reaches DOC_SOCKET_MAX_MS. */
  async #schedule(holds: Map<string, number>): Promise<void> {
    const due = [...holds.values()];
    if (this.#tickAt !== null) due.push(this.#tickAt);
    if (this.#idleAt !== null) due.push(this.#idleAt);
    for (const connection of this.#all()) {
      const attachment = attachmentOf(connection);
      if (attachment) due.push(agesAt(attachment));
    }
    if (due.length === 0) return;
    await this.ctx.storage.setAlarm(Math.min(...due));
  }

  /** Every open socket hears the doc is gone, then closes 4410. */
  #closeAll(except?: Connection): void {
    const event: ServerEvent = { t: 'doc-deleted' };
    for (const connection of this.#all()) {
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
    this.#working = null;
    if (origin === PERSISTENCE) return;
    store.record(update);
    this.#edited(store);
    if (isConnection(origin)) {
      this.#lastWriteAt = Date.now();
      this.#acks.schedule(origin, this.#frameDeletes);
      this.#projections?.touch();
    } else {
      // Server writes run with nothing parked: every client frame's leftovers were purged when it applied.
      store.compactIfDue(this.document);
    }
  }

  /** An edit to the note or a payload: the search index may lack it until the next feed. */
  #edited(store: DocStore): void {
    this.#edits += 1;
    if (!this.#searchStale) {
      store.setMeta('search-fed', '');
      this.#searchStale = true;
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

  /** The bytes comment writes may still add to a state of `stateBytes`, counted with every stored payload as #overCap does. */
  #commentRoom(stateBytes: number): number {
    return Math.floor(this.#limits.stateCapBytes * COMMENT_STATE_SHARE) - stateBytes - (this.#payloads?.totalBytes ?? 0);
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
    return !this.#all()[Symbol.iterator]().next().done;
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
      // A leased client id writes a payload only inside a record (A§5.1 step 4), as in the body.
      const target = known ? payloads.doc(id) : (unknownPayload ??= new Y.Doc());
      const leased = () => !!this.#ingest?.namesLease(data, target);
      const budget = roleAtLeast(attachment.role, 'editor') ? Infinity : data.byteLength * CLASSIFY_BUDGET_PER_BYTE + 1024;
      const { changes, missing, deletes } = classifySync(target, data, undefined, budget);
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
      if (this.#refused(connection, attachment, overCap, missing, undefined, leased)) return;
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
  #refused(
    connection: Connection, attachment: Attachment, overCap: () => boolean, missing = false, guarded?: () => boolean, leased?: () => boolean,
  ): boolean {
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
    // A guard violation is refused 4409 even when it also needs a clock the doc lacks (comments.md §3).
    if (guarded?.()) return this.#refuse(connection, 'protected-type', CLOSE.writeRefused);
    if (leased?.()) {
      this.#refuse(connection, 'protected-type', CLOSE.writeRefused);
      this.#countRefusal(attachment.principalId);
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
    for (const connection of this.#all()) {
      if (attachmentOf(connection)?.principalId === principalId) connection.close(CLOSE.connectionLimit, 'suggest-cooldown');
    }
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
    const payloadBytes = this.#payloads?.totalBytes ?? 0;
    if (payloadBytes > 0) event.pb = payloadBytes;
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

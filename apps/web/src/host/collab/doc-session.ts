// The doc session (A§10.1, A§10.5, A§10.6): per pane per doc, a fresh Y.Doc and one hardened YProvider, created
// when the binding plugin mounts and torn down in order when it unmounts. A tab holds at most one session per doc.
// The session owns its doc's connection truth: a 1 s heartbeat closes a socket silent for 12 s with 4408 and
// detaches it at once, every close code is dispatched once (closeAction), handshakes that keep failing ask REST, and
// a first sync later than 8 s reads `retrying`. Edits the DocDO has not acked live only in this Y.Doc, so a session
// released with unacked edits stays connected without its pane until they are acked, or until the doc ends.
import { CLIENT_PROTOCOL, PROTOCOL_PARAM } from '@moss-multi/protocol/client-protocol';
import type { ConnectionState, TerminalReason } from '@moss-multi/protocol/dom-contract';
import { isRole, roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import type { SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import {
  base64ToBytes, CLOSE, closeAction, DOC_LIMIT_NOTICE, encodeMovesFrame, encodeSyncFrame, PAYLOAD_MESSAGE, type ServerEvent, type WriteRefusalReason,
} from '@moss-multi/protocol/sync';
import { attachPayloadDocs, namedPayloadIds, PayloadDocs, PayloadSync } from '@moss-multi/sync/payload-docs';
import { applyDeletes, deletesUpdate, landedWhole, PasteWatch, rollBackPaste, withoutDeletes, type PasteRecord, type PayloadSpan, type Ranges } from '@moss-multi/sync/paste-rollback';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { knownRole, startRoleRead, supersedeRoleReads } from '../access.ts';
import { onOutdated } from '../client-protocol.ts';
import { existingModel } from '../comments/model.ts';
import { heldRead } from '../leave.ts';
import { leaveTo } from '../navigation.ts';
import { refuseInput, settleRefusal } from '../refusal.ts';
import { AckLedger } from './acks.ts';
import { ownUpdate, readStep1, readUpdate, Replay } from './replay.ts';
import {
  connectionOf, FIRST_SYNC_DEADLINE_MS, HANDSHAKE_FAILURES, HEARTBEAT_CHECK_MS, publishConnection, publishUnacked, reduceLink, RESYNC_MS,
  SILENCE_LIMIT_MS, startLink, type Link, type LinkEvent,
} from './connection.ts';
import { Outbox, syncWrite, type Frame } from './outbox.ts';
import { dropRollback, PASTE_PARTLY_KEPT, PASTE_ROLLED_BACK, saveRollback, storedRollbacks, storeRollback, type StoredPaste } from './paste-rollback.ts';
import { clearTerminal, setTerminal, terminalOf } from './terminal.ts';
import { isSuggestReply, SuggestLedger } from './suggest-acks.ts';
import { markSession, markUnacked } from './unacked.ts';
import { heardRestore } from './restore-notice.ts';
import { clearUndoOf } from './undo.ts';

const PARTY = 'doc-d-o';
const ACCESS_TIMEOUT_MS = 10_000;

export interface SessionState {
  /** The provider has applied the server's first sync step 2. */
  synced: boolean;
  resync: boolean;
  /** Some local write is not yet covered by a server ack (A§10.6). */
  unacked: boolean;
  /** The first sync is past its deadline (A§10.3). */
  retrying: boolean;
  connection: ConnectionState;
  /** The role allows writing; a 4403 re-ask can lower it. */
  canWrite: boolean;
  writePaused: boolean;
}

type Listener = (state: SessionState) => void;

/** The banner and the refusal announcer say these. */
export const WRITE_REFUSED: Record<WriteRefusalReason, string> = {
  role: "You can't edit this note.",
  'doc-cap': 'This note is at its size limit, so your last change was not saved.',
  suggest: "Suggestions aren't available yet, so your change was not saved.",
  unresolved: 'Your last change could not be saved. Reconnecting to the saved note.',
  'protected-type': 'Your last change could not be saved. Reconnecting to the saved note.',
};
export const HALTED_REFUSED = 'Your last change could not be saved. Reconnecting to the saved note.';
export const VIEW_ONLY = 'You can view this note but can no longer edit it.';

/**
 * The provider's WebSocket (its WebSocketPolyfill). `detach` closes the socket and runs the provider's close path
 * at once, without waiting for a close event that a half-open socket may never deliver; from then on the socket's
 * own events are dropped, so a late close can never touch the socket that replaced it. The fields are declared, not
 * initialized: a subclass constructor may call addEventListener before an initializer would run.
 */
class DocSocket extends WebSocket {
  declare detached?: boolean;
  declare closeListeners?: ((event: CloseEvent) => void)[];
  /** Sends large updates in acked pieces (T3.S6); a session's sockets each have their own. */
  declare outbox?: Outbox;
  /** Takes out of a write what must not be sent yet: a landing paste's deletes (T3.B32). */
  declare hold?: (frame: Frame) => Frame;

  /** Nothing goes out on a socket that is closing: a reply to a late server frame would be lost and logs an error. */
  override send(...args: Parameters<WebSocket['send']>): void {
    if (this.readyState !== WebSocket.OPEN) return;
    const frame = this.hold ? this.hold(args[0] as Frame) : (args[0] as Frame);
    if (this.outbox) this.outbox.send(frame);
    else super.send(frame);
  }

  detach(code: number, reason: string): void {
    if (this.detached) return;
    this.outbox?.close();
    try {
      this.close(code, reason);
    } catch {
      // already closing
    }
    this.detached = true;
    const event = new CloseEvent('close', { code, reason, wasClean: false });
    for (const listener of this.closeListeners ?? []) listener.call(this, event);
  }
}

const nativeAddEventListener = WebSocket.prototype.addEventListener;
const nativeSend = WebSocket.prototype.send;

/** The provider's socket class: each socket sends through its own outbox, emptied when it closes. */
class OutboxSocket extends DocSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const outbox = new Outbox((frame) => {
      if (this.readyState === WebSocket.OPEN) nativeSend.call(this, frame);
    });
    this.outbox = outbox;
    nativeAddEventListener.call(this, 'close', () => outbox.close());
  }
}
// Assigned rather than overridden in the class body: one signature cannot override WebSocket's overloads.
DocSocket.prototype.addEventListener = function addEventListener(
  this: DocSocket,
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
): void {
  if (listener === null) return;
  if (typeof listener !== 'function') {
    nativeAddEventListener.call(this, type, listener, options);
    return;
  }
  if (type === 'close') (this.closeListeners ??= []).push(listener as (event: CloseEvent) => void);
  nativeAddEventListener.call(
    this,
    type,
    (event: Event) => {
      if (!this.detached) listener.call(this, event);
    },
    options,
  );
} as WebSocket['addEventListener'];

/** Awareness renewals with an unchanged payload still go out, and a remote frame is never echoed (L§4.3). */
function broadcastAwarenessOnUpdate(provider: YProvider): void {
  const handler = provider._awarenessUpdateHandler;
  provider.awareness.off('change', handler);
  const local: typeof handler = (changes, origin) => {
    if (origin !== provider) handler(changes, origin);
  };
  provider.awareness.on('update', local);
  const destroy = provider.destroy.bind(provider);
  provider.destroy = () => {
    provider.awareness.off('update', local);
    destroy();
  };
}

/** An intentional close sends 1000, never a bare close; `held()` keeps a session that still owes edits connected. */
function closeNormally(provider: YProvider, held: () => boolean): void {
  provider.disconnect = () => {
    if (held()) return;
    provider.shouldConnect = false;
    provider.disconnectBc();
    provider.ws?.close(CLOSE.normal, 'session closed');
  };
}

const shareToken = (): string | null => new URLSearchParams(window.location.search).get('share');

type AccessAnswer =
  /** `remember` applies the role to the tab unless a newer read or an access change superseded this one (T9.12). */
  | { kind: 'role'; role: Role; canWrite: boolean; canSuggest: boolean; remember: () => boolean }
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | { kind: 'signed-out' }
  /** The network or the server could not say: keep trying. */
  | { kind: 'unknown' };

/** Asks REST what this caller may do with the doc (A§10.5 handshake failures, A§8 client handling of 4403); held while
 * the page leaves and asked again if it stays (leave.ts). */
export async function askAccess(docId: string): Promise<AccessAnswer> {
  const share = shareToken();
  const query = share ? `?share=${encodeURIComponent(share)}` : '';
  const remember = startRoleRead();
  try {
    return await heldRead((signal) => fetch(`/api/docs/${encodeURIComponent(docId)}/access${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    }), async (response): Promise<AccessAnswer> => {
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 404) return { kind: 'gone' };
      if (!response.ok) return { kind: 'unknown' };
      const body = (await response.json()) as { role?: unknown; deleted?: unknown };
      if (body.deleted === true) return { kind: 'deleted' };
      return isRole(body.role)
        ? { kind: 'role', role: body.role, canWrite: roleAtLeast(body.role, 'editor'), canSuggest: roleAtLeast(body.role, 'suggester'), remember: () => remember(docId, body.role) }
        : { kind: 'unknown' };
    }, { timeoutMs: ACCESS_TIMEOUT_MS });
  } catch {
    return { kind: 'unknown' };
  }
}

/** The tab's sessions by doc id with the pane holding each, and by provider for the plugin's teardown. */
const held = new Map<string, { session: DocSession; owner: object }>();
const byProvider = new WeakMap<object, DocSession>();
/** Providers the plugin binds in place of a session's own (Suggest and Review), with the doc they bind. */
const aliases = new WeakMap<object, { doc: Y.Doc; release: () => void }>();

/** The plugin binds `provider` and `doc` for `session` (Suggest's fork, Review's composite); `release` runs at teardown. */
export function aliasProvider(provider: object, session: DocSession, doc: Y.Doc, release: () => void): void {
  byProvider.set(provider, session);
  aliases.set(provider, { doc, release });
}
const ownerListeners = new Set<() => void>();
/** Every live session of the tab, lingering ones included: the per-tab socket registry (A§10.1). */
const sessions = new Set<DocSession>();

function ownersChanged(): void {
  for (const listener of ownerListeners) listener();
}

/** Calls `listener` whenever a doc is taken or released in this tab; returns the unsubscriber. */
export function subscribeDocOwners(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

/** The pane holding `docId` in this tab, or null. */
export function docOwner(docId: string): object | null {
  return held.get(docId)?.owner ?? null;
}

/** The note and payload docs this tab holds for `docId`, or null: what a restore's base is read from (A§14). */
export function heldDocOf(docId: string): { doc: Y.Doc; payloads: PayloadDocs } | null {
  const session = held.get(docId)?.session;
  return session ? { doc: session.doc, payloads: session.payloads } : null;
}

let signingOut = false;
/** Docs closed to writes while a trash waits for their acks (A§10.6). */
const closedForTrash = new Set<string>();
const ackWaiters = new Set<() => void>();

/** Keep the sync channel delivering while the sign-out guard waits for acks. */
export function pauseDocWrites(paused: boolean): void {
  signingOut = paused;
  for (const session of sessions) session.pauseWrites();
}

/** Closes (or reopens) these docs to writes in this tab, every session of them, while their sockets keep delivering. */
export function closeDocsToWrites(docIds: string[], closed: boolean): void {
  for (const id of docIds) {
    if (closed) closedForTrash.add(id);
    else closedForTrash.delete(id);
  }
  for (const session of sessions) if (docIds.includes(session.docId)) session.pauseWrites();
}

// REST refused this bundle as outdated: every doc stops where it is and offers the reload.
onOutdated(() => {
  for (const session of [...sessions]) session.end('outdated');
});

/** The server trashed these docs: this tab's sessions of them end now, without waiting for the 4410. */
export function endTrashedDocs(docIds: string[]): void {
  for (const session of [...sessions]) if (docIds.includes(session.docId)) session.end('deleted');
}

/**
 * The workspace channel says these docs changed (A§8): a session that went terminal `deleted` asks REST again, and
 * reopens when the note is live after all (a trash that never committed closed it 4410 first).
 */
export function reopenDocs(docIds: string[]): void {
  for (const session of [...sessions]) if (docIds.includes(session.docId)) void session.reopen();
}

/** Docs whose role is being asked again; true when another ask is owed once this one answers. */
const reasking = new Map<string, boolean>();

function reaskRole(docId: string): void {
  if (reasking.has(docId)) {
    reasking.set(docId, true);
    return;
  }
  reasking.set(docId, false);
  void askAccess(docId).then((answer) => {
    if (answer.kind === 'role' && held.has(docId) && !terminalOf(docId)) answer.remember();
  }).finally(() => {
    const again = reasking.get(docId);
    reasking.delete(docId);
    if (again) reaskRole(docId);
  });
}

/**
 * The workspace channel says access may have changed (A§8): each open note it names (every one, for a vault or folder
 * change or a reconnect) asks for its role again and its pane follows the answer. The server stays the authority.
 */
export function reaskDocRoles(event: WorkspaceEvent): void {
  if (event.type !== 'meta' && event.type !== 'vaults') return;
  const every = event.type === 'vaults' || event.folderIds.length > 0;
  for (const docId of [...held.keys()]) {
    if (terminalOf(docId) || !(every || event.docIds.includes(docId))) continue;
    // An answer to a read already under way may predate this change, so it no longer applies.
    supersedeRoleReads(docId);
    reaskRole(docId);
  }
}

/** Resolves true once no session of these docs holds an unacked edit, or false after `timeoutMs`. */
export function waitDocsAcked(docIds: string[], timeoutMs: number): Promise<boolean> {
  const pending = () => [...sessions].some((session) => docIds.includes(session.docId) && session.state.unacked);
  if (!pending()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (acked: boolean) => {
      clearTimeout(timer);
      ackWaiters.delete(check);
      resolve(acked);
    };
    const check = () => { if (!pending()) finish(true); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ackWaiters.add(check);
  });
}

/** Confirmed sign-out severs every socket of this window; nothing reconnects. */
export function severDocSessions(): void {
  for (const session of [...sessions]) session.end('session-ended');
}

/** The banner's Retry for a doc that went terminal `conn-limit`. */
export function retryDoc(docId: string): void {
  held.get(docId)?.session.retry();
}

const byDoc = new WeakMap<Y.Doc, DocSession>();

/** A heartbeat tick this late means the main thread was busy (T3.S6). */
const BUSY_TICK_MS = 2 * HEARTBEAT_CHECK_MS;

/**
 * A late tick keeps a silent socket for at most this long after the last frame heard, counted in time the thread was
 * free to read frames: a late tick adds one interval, since frames sent during the block wait behind it (B208).
 */
const BUSY_GRACE_MS = 30_000;
/** A step 1 still unanswered this long is sent again, however many frames still arrive (B213). */
const RESYNC_HOLD_MS = 30_000;
/** An outbox stalled at its budget with writes still queued this long reconnects and replays the ledger (B209). */
const STUCK_MS = 20_000;

/**
 * The bytes of the payload docs the DocDO counts against `doc`'s cap, withheld ones too (T3.S6): a tab holds only the
 * payloads its tree names. Its last word, plus the payload writes of this tab no ack has covered, made since its last
 * usage figure: an ack's count includes the writes it covers, and a usage figure those that persisted with their acks
 * lost, so none is counted twice (B207). 0 for a doc no session holds.
 */
export const countedPayloadBytes = (doc: Y.Doc): number => byDoc.get(doc)?.countedPayloadBytes ?? 0;

/** What a paste may bring the note to: the cap less 3% for what its estimate leaves out (T3.S6). */
export const PASTE_LIMIT_BYTES = Math.floor(STATE_CAP_BYTES * 0.97);

/** The origin of a rollback's deletes: not the binding's, so no undo step takes them (T3.B32). */
export const ROLLBACK_ORIGIN = Symbol('moss-multi:paste-rollback');
/** How long a rollback waits for the payload docs a cut paste made to arrive, so their landed text goes too. */
const ROLLBACK_ARRIVAL_MS = 10_000;

/**
 * A large paste as it lands (T3.B32): this client's clocks in the note, the payload docs it makes, and the deletes its
 * writes make. Those deletes are held back from what the tab sends (`holding`) until every item of the paste is
 * acked, so a paste cut short has deleted nothing on the server and its rollback only deletes what it added.
 */
export class PasteTrack {
  readonly watch: PasteWatch;
  /** The paste's deletes are not sent yet. */
  holding = true;
  /** A refusal stopped it: its deletes are never sent from this session. */
  stopped = false;
  /** Where the pane was scrolled when the paste began, restored if it is rolled back. */
  scrollTop: number | undefined;
  readonly #made = new Map<string, Y.Doc>();
  /** The deletes the paste makes in each payload doc it made, so a rollback tells another writer's deletes apart. */
  readonly #watches = new Map<string, PasteWatch>();
  readonly #ends = new Map<string, number>();
  readonly #stop: () => void;

  constructor(readonly doc: Y.Doc, payloads: PayloadDocs, readonly abort: () => void, readonly onFinish: () => void) {
    this.watch = new PasteWatch(doc);
    this.#stop = payloads.onHold((id, payload, fresh) => {
      if (!fresh || this.finished) return;
      this.#made.set(id, payload);
      if (!this.#watches.has(id)) this.#watches.set(id, new PasteWatch(payload));
    });
  }

  get finished(): boolean {
    return this.watch.finished;
  }

  /** The paste's last item is written. */
  finish(): void {
    if (this.finished) return;
    this.watch.finish();
    for (const [id, payload] of this.#made) this.#ends.set(id, Y.getState(payload.store, payload.clientID));
    for (const watch of this.#watches.values()) watch.finish();
    this.#stop();
    this.onFinish();
  }

  payloads(): PasteRecord['payloads'] {
    const payloads: PasteRecord['payloads'] = {};
    for (const [id, payload] of this.#made) {
      payloads[id] = { client: payload.clientID, from: 0, to: this.#ends.get(id) ?? Y.getState(payload.store, payload.clientID) };
      const deletes = this.#watches.get(id)?.deletes() ?? [];
      if (deletes.length > 0) payloads[id].deletes = deletes;
    }
    return payloads;
  }

  record(): StoredPaste {
    const record: StoredPaste = { note: this.watch.span(), payloads: this.payloads(), deletes: this.watch.deletes() };
    if (this.scrollTop !== undefined) record.scrollTop = this.scrollTop;
    return record;
  }
}

/** Tracks a large paste landing in `doc` (T3.B32); `abort` stops it landing. Null for a doc no session holds. */
export const trackPaste = (doc: Y.Doc | undefined, abort: () => void): PasteTrack | null => (doc && byDoc.get(doc)?.trackPaste(abort)) ?? null;

export class DocSession {
  readonly doc = new Y.Doc();
  /** The DocDO's last word on the payload bytes it counts against the cap (countedPayloadBytes). */
  payloadBytes = 0;

  get countedPayloadBytes(): number {
    return this.payloadBytes + this.#ledger.pendingPayloadBytes();
  }
  /** The payload docs this tab holds beside the note (A§10.10), destroyed with it. */
  readonly payloads = attachPayloadDocs(this.doc, new PayloadDocs());
  readonly #payloadSync: PayloadSync;
  stopPresence?: () => void;
  readonly provider: YProvider;
  #state: SessionState = { synced: false, resync: false, unacked: false, retrying: false, connection: 'reconnecting', canWrite: true, writePaused: false };
  readonly #listeners = new Set<Listener>();
  #refusedMessage = HALTED_REFUSED;
  #disposed = false;
  /** Released by its pane while edits were unacked: connected, without a pane, until the DocDO acks them. */
  #lingering = false;
  /** Terminal: this session's edits can no longer land. */
  #ended = false;
  #reopening = false;
  readonly #ledger = new AckLedger();
  readonly #suggest = new SuggestLedger();
  /** The socket suggest requests may use: one that has synced. On a new socket the fork resumes its leases first. */
  #suggestWs: WebSocket | null = null;
  readonly #suggestListeners = new Set<(reply: SuggestReply) => void>();
  readonly #disposeListeners = new Set<() => void>();
  readonly #replay: Replay;
  /** Payload resends wait for the note's backlog replay (#opened). */
  #payloadsDue = false;
  #link: Link;
  #socketOpen = false;
  #lastResync = 0;
  /** A step 1 this session sent has had no step 2 back yet, and when a sync frame last arrived (T3.S6b). */
  #resyncOwed = false;
  #syncHeard = 0;
  /** Sync updates received before the first step 2, applied with it. */
  #firstSync: Uint8Array[] = [];
  #visibleSince = 0;
  #lastTick = 0;
  /** The last frame stamp a tick saw, and the free time since it (BUSY_GRACE_MS). */
  #heardSeen = 0;
  #quietFor = 0;
  #failedHandshakes = 0;
  #accessRetries = 0;
  #accessRetry: ReturnType<typeof setTimeout> | undefined;
  #paused = false;
  #pagePresence: ReturnType<YProvider['awareness']['getLocalState']> = null;
  /** Large pastes landing or unacked (T3.B32). */
  readonly #pastes = new Set<PasteTrack>();
  /** The stored pastes this session took on at its first sync, each dropped once what settles it is acked. */
  #rollbacks: Set<string> | null = null;
  /** Those it settled, waiting for the acks. */
  readonly #applied = new Set<string>();
  /** The DocDO's state vector, as its acks report it. */
  readonly #ackedSv = new Map<number, number>();
  /** Where to scroll the pane once a rolled-back note shows: where it was when the paste began. */
  rolledBackScroll: number | null = null;
  readonly #tick: ReturnType<typeof setInterval>;
  readonly #deadline: ReturnType<typeof setTimeout>;

  constructor(readonly docId: string, canWrite = true) {
    this.#state.canWrite = canWrite;
    this.#link = startLink(Date.now());
    this.provider = new YProvider(window.location.host, docId, this.doc, {
      party: PARTY,
      // The binding plugin makes the one connect; a second would be a second socket (L§4.3).
      connect: false,
      disableBc: true,
      // The heartbeat sends the 4 s resync itself, so it can pause while the tab is hidden.
      resyncInterval: 0,
      WebSocketPolyfill: OutboxSocket as unknown as typeof WebSocket,
      // The protocol lets a server that has moved on refuse this bundle before it writes (4426, rule 10).
      params: () => {
        const share = shareToken();
        return { [PROTOCOL_PARAM]: String(CLIENT_PROTOCOL), ...(share ? { share } : {}) };
      },
    });
    // An async params lookup cannot reopen a session that ended while it was in flight.
    let intent = this.provider.shouldConnect;
    Object.defineProperty(this.provider, 'shouldConnect', {
      configurable: true,
      get: () => intent && !this.#ended && !this.#disposed,
      set: (value: boolean) => { intent = value; },
    });
    broadcastAwarenessOnUpdate(this.provider);
    closeNormally(this.provider, () => this.#lingering);
    this.#replay = new Replay((update) => {
      const ws = this.provider.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || this.#ended) return false;
      ws.send(encodeSyncFrame(2, update));
      return true;
    });
    // The frame discipline (comments.md §6): with writes unacked, the server's step 1 is answered only after they are
    // replayed as their own frames, and the step 2 it then gets arrives inert. Writes made meanwhile wait their turn.
    // The step 2 carries only this client's own writes (ownUpdate), never a comment record the server wrote meanwhile.
    const answerSync = this.provider.messageHandlers[0];
    this.provider.messageHandlers[0] = (encoder, decoder, provider, emitSynced, type) => {
      const sv = this.#ended ? null : readStep1(decoder);
      if (!sv) answerSync(encoder, decoder, provider, emitSynced, type);
      else if (this.#ledger.pending().length) this.#replay.start(this.#ledger.pending(), () => this.#answerStep1(sv));
      else {
        this.#replay.cancel();
        this.#answerStep1(sv);
      }
    };
    const sendLive = this.provider._updateHandler;
    this.doc.off('update', sendLive);
    this.provider._updateHandler = (update, origin) => {
      if (origin !== this.provider && this.#replay.active) this.#replay.hold(update);
      else sendLive(update, origin);
    };
    this.doc.on('update', this.provider._updateHandler);
    this.provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') this.#opened();
    });
    this.provider.on('connection-close', (event: CloseEvent | null) => this.#closed(event));
    this.provider.on('sync', (synced: boolean) => {
      if (synced) this.#synced();
    });
    this.provider.on('custom-message', (message: string) => this.#onServerEvent(message));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider) this.#wrote(update);
    });
    // Payload frames ride the doc socket under their own message type; the provider hands them over whole.
    this.#payloadSync = new PayloadSync(this.payloads, {
      send: (frame) => this.provider.ws?.send(frame),
      open: () => this.provider.wsconnected && !this.#ended,
      wrote: (id, update) => this.#wrote(update, id),
      remote: this.provider,
      note: this.doc,
      // A payload made and deleted offline waits, kept, for its tree to name it again; it is not an unsaved edit.
      parked: (id, parked) => {
        this.#ledger.park(id, parked);
        if (this.#ledger.unacked !== this.#state.unacked) this.#set({ unacked: this.#ledger.unacked });
      },
    });
    // A step 2 from the server answers the last step 1.
    const sync = this.provider.messageHandlers[0];
    this.provider.messageHandlers[0] = (encoder, decoder, provider, emitSynced, type) => {
      this.#syncHeard = Date.now();
      const step2 = decoder.arr[decoder.pos] === 1;
      if (step2) this.#resyncOwed = false;
      // Until the first sync, the answer's pieces are held and land with its step 2 as one transaction. A piece can
      // leave the root with no visible block (a deleted seed, blocks waiting on a later piece), and @lexical/yjs fills
      // an empty root by writing a paragraph into the doc, ahead of the note (T7.Q).
      if (!this.#state.synced) {
        const update = readUpdate(decoder);
        if (update) {
          this.#firstSync.push(update);
          return;
        }
      }
      const started = performance.now();
      if (step2 && this.#firstSync.length) {
        const held = this.#firstSync;
        this.#firstSync = [];
        this.doc.transact(() => {
          for (const update of held) {
            try {
              Y.applyUpdate(this.doc, update, this.provider);
            } catch (error) {
              console.error('Caught error while handling a Yjs update', error);
            }
          }
          sync(encoder, decoder, provider, false, type);
        }, this.provider);
        if (emitSynced) provider.synced = true;
      } else sync(encoder, decoder, provider, emitSynced, type);
      if (performance.now() - started > 50) performance.measure('moss-sync-message', { start: started });
    };
    this.provider.messageHandlers[PAYLOAD_MESSAGE] = (_encoder, decoder) => {
      this.#payloadSync.receive(decoder.arr);
    };
    this.#deadline = setTimeout(() => {
      if (!this.#state.synced) this.#set({ retrying: true });
    }, FIRST_SYNC_DEADLINE_MS);
    this.#tick = setInterval(() => this.#heartbeat(), HEARTBEAT_CHECK_MS);
    document.addEventListener('visibilitychange', this.#onVisibility);
    // Capture before the provider and Lexical's pagehide listeners clear awareness.
    window.addEventListener('pagehide', this.#onPageHide, true);
    window.addEventListener('pageshow', this.#onPageShow);
    sessions.add(this);
    byDoc.set(this.doc, this);
    markSession(this, true);
    this.#state.writePaused = signingOut || closedForTrash.has(docId);
    this.#publish();
  }

  /** Writes pause for a sign-out in progress or a trash of this doc waiting for its acks. */
  pauseWrites(): void {
    const writePaused = signingOut || closedForTrash.has(this.docId);
    if (writePaused !== this.#state.writePaused) this.#set({ writePaused });
  }

  get state(): SessionState {
    return this.#state;
  }

  trackPaste(abort: () => void): PasteTrack | null {
    if (this.#ended || this.#disposed) return null;
    const track = new PasteTrack(this.doc, this.payloads, abort, () => this.#release());
    this.#pastes.add(track);
    return track;
  }

  /** What a write sent now must leave out: the deletes of the pastes still holding theirs. */
  readonly #hold = (frame: Frame): Frame => {
    if (typeof frame === 'string' || this.#pastes.size === 0) return frame;
    const held: Ranges = [];
    for (const track of this.#pastes) if (track.holding) held.push(...track.watch.deletes());
    if (held.length === 0) return frame;
    const write = syncWrite(frame);
    if (!write) return frame;
    try {
      const update = withoutDeletes(write.update, held);
      return update === write.update ? frame : encodeSyncFrame(write.step, update);
    } catch {
      // bytes Yjs cannot read hold no deletes of the paste's
      return frame;
    }
  };

  /** Whether every item of `track` is acked: the note's, and its payload docs' writes. */
  #landed(track: PasteTrack): boolean {
    const span = track.watch.span();
    if ((this.#ackedSv.get(span.client) ?? 0) < span.to) return false;
    const pending = new Set(this.#ledger.pendingPayloads());
    return Object.keys(track.payloads()).every((id) => !pending.has(id));
  }

  /** A paste that finished and landed whole sends its deletes: the paste is complete. */
  #release(): void {
    for (const track of this.#pastes) {
      if (!track.holding || track.stopped || !track.finished || !this.#landed(track)) continue;
      track.holding = false;
      const ranges = track.watch.deletes();
      // A socket that is down sends them with the unacked writes when it reconnects.
      const ws = this.provider.ws;
      if (ranges.length === 0 || this.#ended || !ws) continue;
      // The server sees the moved text's delete only now, after the copy: it is told where the comments on it went.
      const moves = existingModel(this.doc)?.moves() ?? [];
      if (moves.length > 0) ws.send(encodeMovesFrame(moves));
      ws.send(encodeSyncFrame(2, deletesUpdate(ranges)));
    }
  }

  /** Calls `listener` on every change; returns the unsubscriber. */
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The pane let go. With every edit acked, or none that can still land, the session tears down now; otherwise it
   * leaves presence, keeps (or reopens) its socket so the next sync step 2 delivers the edits, and tears down at the
   * ack. The doc stays held meanwhile, so a pane that reopens it binds a fresh Y.Doc once the edits are on the server.
   */
  release(): void {
    if (this.#disposed || this.#lingering) return;
    if (!this.#state.unacked || (this.#ended && terminalOf(this.docId) !== 'conn-limit')) {
      this.dispose();
      return;
    }
    this.#lingering = true;
    this.#pagePresence = null;
    this.stopPresence?.();
    this.#listeners.clear();
    this.provider.awareness.setLocalState(null);
    this.#listeners.add((state) => {
      if (!state.unacked) this.dispose();
    });
    if (!this.provider.shouldConnect && !this.#ended) void this.provider.connect();
  }

  /** Sends a suggest-mode request (the fork, T5.1); `data-sync-unacked` holds until the DocDO replies. */
  sendSuggest(request: SuggestRequest): void {
    const ws = this.provider.ws;
    if (ws && ws === this.#suggestWs && ws.readyState === WebSocket.OPEN && !this.#ended) {
      this.provider.sendMessage(JSON.stringify(request));
      this.#suggest.sent(request);
    } else {
      this.#suggest.held(request);
    }
    if (!this.#state.unacked) this.#set({ unacked: true });
  }

  /** Every suggest reply, in order; returns the unsubscriber. */
  onSuggestReply(listener: (reply: SuggestReply) => void): () => void {
    this.#suggestListeners.add(listener);
    return () => this.#suggestListeners.delete(listener);
  }

  /** The fork holds requests back that it still owes the DocDO: the session stays unacked (and a released one lingers). */
  oweSuggest(owed: boolean): void {
    if (this.#disposed) return;
    this.#suggest.owed = owed;
    if (owed && !this.#state.unacked) this.#set({ unacked: true });
    else this.#settleUnacked();
  }

  /** Calls `listener` once when the session is torn down (now, if it already was); returns the unsubscriber. */
  onDisposed(listener: () => void): () => void {
    if (this.#disposed) {
      listener();
      return () => {};
    }
    this.#disposeListeners.add(listener);
    return () => this.#disposeListeners.delete(listener);
  }

  /**
   * The fork resends what it still owes on a new socket: requests the old one never answered leave the ledger, then
   * `resend` runs, and only then can `data-sync-unacked` settle. A lingering session never sees a false zero between.
   */
  resendSuggest(resend: () => void): void {
    this.#suggest.takeUnsent();
    this.#suggestWs = this.provider.ws;
    resend();
    this.#settleUnacked();
  }

  /** The doc is over for this session (A§10.6): no reconnect, every surface goes inert, a lingering session lets go. */
  end(reason: TerminalReason): void {
    if (this.#disposed) return;
    this.#ended = true;
    this.#pagePresence = null;
    this.provider.shouldConnect = false;
    setTerminal(this.docId, reason);
    // A demotion's notice no longer holds once the note has ended (its banner says why).
    settleRefusal(VIEW_ONLY, 0);
    if (this.#lingering && reason !== 'conn-limit') {
      this.dispose();
      return;
    }
    const ws = this.provider.ws;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(CLOSE.normal, 'ended');
  }

  /** After `deleted` on a note REST still has live: the terminal state clears and the socket reopens at the role REST
   * gives, or the pane rebinds read-only. Anything else leaves it terminal. */
  async reopen(): Promise<void> {
    if (this.#disposed || this.#reopening || !this.#ended || terminalOf(this.docId) !== 'deleted') return;
    this.#reopening = true;
    const answer = await askAccess(this.docId).finally(() => { this.#reopening = false; });
    if (this.#disposed || answer.kind !== 'role' || terminalOf(this.docId) !== 'deleted') return;
    // A stale answer (access changed while it was asked) is asked again.
    if (!answer.remember()) return this.reopen();
    this.#ended = false;
    this.#failedHandshakes = 0;
    clearTerminal(this.docId);
    if (!answer.canWrite) {
      if (this.#state.canWrite) refuseInput(VIEW_ONLY);
      this.#ended = true;
      this.#set({ canWrite: false, resync: true });
      return;
    }
    this.provider.shouldConnect = true;
    void this.provider.connect();
  }

  /** Tries again after `conn-limit`: the terminal state clears and the socket reopens. */
  retry(): void {
    if (this.#disposed) return;
    this.#ended = false;
    this.#failedHandshakes = 0;
    clearTerminal(this.docId);
    void this.provider.connect();
  }

  /** Teardown in A§10.1 order: presence cleared while the socket is open, close 1000, then the doc. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pagePresence = null;
    this.stopPresence?.();
    this.#lingering = false;
    this.#replay.cancel();
    clearTimeout(this.#accessRetry);
    clearInterval(this.#tick);
    clearTimeout(this.#deadline);
    document.removeEventListener('visibilitychange', this.#onVisibility);
    window.removeEventListener('pagehide', this.#onPageHide, true);
    window.removeEventListener('pageshow', this.#onPageShow);
    sessions.delete(this);
    markSession(this, false);
    markUnacked(this, false);
    for (const check of [...ackWaiters]) check();
    publishConnection(this.docId, this, null);
    publishUnacked(this.docId, this, null);
    if (held.get(this.docId)?.session === this) {
      held.delete(this.docId);
      ownersChanged();
    }
    this.#listeners.clear();
    const { awareness } = this.provider;
    awareness.setLocalState(null);
    this.provider.disconnect();
    this.provider.destroy();
    // A connect still resolving its params can never reopen the socket.
    Object.defineProperty(this.provider, 'shouldConnect', { get: () => false, set: () => undefined });
    awareness.destroy();
    // Before the doc goes: a suggest mount delivering for a released pane lets go of its fork first.
    for (const listener of [...this.#disposeListeners]) listener();
    this.#disposeListeners.clear();
    this.#suggestListeners.clear();
    this.#payloadSync.destroy();
    this.doc.destroy();
    this.payloads.destroy();
  }

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    if (!this.#state.unacked) this.#settled();
    markUnacked(this, this.#state.unacked);
    this.#publish();
    for (const listener of [...this.#listeners]) listener(this.#state);
    for (const check of [...ackWaiters]) check();
  }

  /** Every write is acked: a paste that finished and sent its deletes is whole, and a settled rollback is done. */
  #settled(): void {
    for (const track of [...this.#pastes]) if (track.finished && !track.holding) this.#pastes.delete(track);
    for (const key of this.#applied) {
      dropRollback(key);
      this.#rollbacks?.delete(key);
    }
    this.#applied.clear();
  }

  /** Gives up the stored pastes this session took on, settled or not: the landed part stays (docs/METHOD.md). */
  #dropRollbacks(): void {
    if (!this.#rollbacks) return;
    for (const key of this.#rollbacks) dropRollback(key);
    this.#rollbacks.clear();
    this.#applied.clear();
  }

  #publish(): void {
    if (this.#disposed) return;
    const { connection, synced, retrying } = this.#state;
    publishConnection(this.docId, this, { connection, synced, retrying });
    publishUnacked(this.docId, this, this.#state.unacked);
  }

  /** Folds a link event into the connection state. */
  #update(event: LinkEvent | null): void {
    if (event) this.#link = reduceLink(this.#link, event);
    const connection = connectionOf(this.#link, Date.now());
    if (connection !== this.#state.connection) this.#set({ connection });
  }

  #opened(): void {
    this.#socketOpen = true;
    // The provider sends a step 1 on open; each held payload sends its own, and its unacked writes.
    this.#lastResync = Date.now();
    this.#resyncOwed = true;
    this.#failedHandshakes = 0;
    const ws = this.provider.ws as DocSocket | null;
    if (ws) ws.hold = this.#hold;
    // A write made before the server's step 1 arrives must not overtake the backlog replayed then (comments.md §6).
    // The note's backlog goes first: it holds the elements naming payloads made offline, so those payloads' resends wait
    // for it and never reach the DocDO as unnamed writes.
    if (this.#ledger.pending().length && !this.#ended) {
      this.#replay.arm();
      this.#payloadsDue = true;
    } else {
      this.#payloadsDue = false;
      this.#payloadSync.connected((id) => this.#ledger.pendingUpdate(id));
    }
  }

  /** Each held payload's step 1 and unacked writes, once the note's backlog has gone (#opened). */
  #resendPayloads(): void {
    if (!this.#payloadsDue) return;
    this.#payloadsDue = false;
    this.#payloadSync.connected((id) => (this.#ended ? null : this.#ledger.pendingUpdate(id)));
  }

  /** Answers the server's step 1 with the step 2 it asked for, holding only this client's writes. */
  #answerStep1(sv: Uint8Array): void {
    const ws = this.provider.ws;
    if (ws?.readyState === WebSocket.OPEN && !this.#ended) ws.send(encodeSyncFrame(1, ownUpdate(this.doc, sv)));
    this.#resendPayloads();
  }

  #synced(): void {
    this.#suggestWs = this.provider.ws;
    this.#accessRetries = 0;
    this.#update({ type: 'synced' });
    if (this.#state.synced || this.#rollbacks !== null) return;
    clearTimeout(this.#deadline);
    const stored = storedRollbacks(this.docId);
    this.#rollbacks = new Set(stored.keys());
    if (stored.size === 0) {
      this.#set({ synced: true, retrying: false });
      return;
    }
    // Without write access the landed part stays (docs/METHOD.md): nothing is tried, so nothing is refused again.
    if (!this.#state.canWrite || !roleAtLeast(knownRole(this.docId) ?? 'editor', 'editor')) {
      this.#dropRollbacks();
      this.#set({ synced: true, retrying: false });
      return;
    }
    void this.#rollBack(stored).then(() => {
      if (!this.#disposed && !this.#state.synced) this.#set({ synced: true, retrying: false });
    });
  }

  /** Resolves once none of `ids` is still arriving, or after `ms`. */
  #arrival(ids: Set<string>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiting = () => [...ids].some((id) => this.payloads.awaiting(id));
      if (!waiting()) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        stop();
        resolve();
      };
      const timer = Number.isFinite(ms) ? setTimeout(done, ms) : undefined;
      const stop = this.payloads.onArrive(() => {
        if (!waiting() || this.#disposed) done();
      });
    });
  }

  /**
   * Settles each stored paste (T3.B32) before the pane shows the note, the latest first. One cut short is rolled
   * back in whole blocks, a block another writer wrote into (or into its payload, read once it has arrived) kept
   * whole. Its deletes were never sent, so nothing it replaced needs restoring. One that landed whole sends its held
   * deletes, which completes it. A paste whose payload docs have not arrived after 10 s is settled once they have, as
   * the note shows.
   */
  async #rollBack(stored: Map<string, StoredPaste>): Promise<void> {
    const records = [...stored].sort(([, a], [, b]) => b.note.from - a.note.from);
    const named = namedPayloadIds(this.doc);
    const ids = new Set<string>();
    for (const [, record] of records) for (const id of Object.keys(record.payloads)) if (named.has(id)) ids.add(id);
    for (const id of ids) this.payloads.hold(id);
    await this.#arrival(ids, ROLLBACK_ARRIVAL_MS);
    if (this.#disposed || this.#ended) return;
    const waiting = this.#settle(records, ids);
    if (waiting.length === 0) return;
    void this.#arrival(ids, Infinity).then(() => {
      if (!this.#disposed && !this.#ended && this.#rollbacks) this.#settle(waiting.filter(([key]) => this.#rollbacks?.has(key)), ids);
    });
  }

  /** Settles `records`; returns those whose payload docs are still arriving. */
  #settle(records: [string, StoredPaste][], ids: Set<string>): [string, StoredPaste][] {
    const waiting: [string, StoredPaste][] = [];
    let cut = false;
    let kept = 0;
    for (const [key, record] of records) {
      const payloads = Object.entries(record.payloads).filter(([id]) => ids.has(id));
      // One still arriving would read as cut short, and its landed items would stay once it arrived.
      if (payloads.some(([id]) => this.payloads.awaiting(id))) {
        waiting.push([key, record]);
        continue;
      }
      if (!record.decided) {
        const whole = landedWhole(this.doc, record.note) && payloads.every(([id, span]) => landedWhole(this.payloads.hold(id), span));
        record.decided = whole ? 'whole' : 'cut';
        saveRollback(key, record);
      }
      if (record.decided === 'whole') {
        if (record.deletes?.length) applyDeletes(this.doc, record.deletes, ROLLBACK_ORIGIN);
      } else {
        cut = true;
        const held = payloads.map(([id, span]): [string, Y.Doc, PayloadSpan] => [id, this.payloads.hold(id), span]);
        kept += rollBackPaste(this.doc, record.note, held, ROLLBACK_ORIGIN, undefined, record.deletes).kept;
        if (record.scrollTop !== undefined) this.rolledBackScroll = record.scrollTop;
      }
      this.#applied.add(key);
    }
    if (cut) refuseInput(kept > 0 ? PASTE_PARTLY_KEPT : PASTE_ROLLED_BACK);
    if (!this.#ledger.unacked) this.#settled();
    return waiting;
  }

  #closed(event: CloseEvent | null): void {
    if (this.#disposed) return;
    const opened = this.#socketOpen;
    this.#socketOpen = false;
    this.#suggest.dropped();
    // What it had not sent stays in the ledger; the next socket replays it.
    this.#replay.cancel();
    // Each socket gets its own partyserver connection id (`_pk`, read at every reconnect): the DocDO keys acks by
    // socket, but a fresh id keeps any lookup by id unambiguous.
    this.provider.id = crypto.randomUUID();
    this.#update({ type: 'closed', at: Date.now() });
    // Dispatched before the provider schedules its reconnect, so a stop here is never raced (A§10.6).
    const action = closeAction(event?.code ?? 1006);
    switch (action.kind) {
      case 'terminal':
        this.end(action.reason);
        if (event?.code === CLOSE.noPrincipal) leaveTo(`/login?next=${encodeURIComponent(window.location.pathname)}`);
        return;
      case 'reask':
        this.provider.shouldConnect = false;
        void this.#reask('revoked');
        return;
      case 'refused':
        this.#ended = true;
        this.provider.shouldConnect = false;
        refuseInput(this.#refusedMessage);
        this.#set({ resync: true });
        if (this.#lingering) this.dispose();
        return;
      case 'retry':
        // A designed refusal opens and then closes with its code, so a handshake that keeps failing is the network
        // or the Worker: stop the ladder and ask REST what is true (A§10.5).
        if (!opened && (this.#failedHandshakes += 1) >= HANDSHAKE_FAILURES) {
          this.provider.shouldConnect = false;
          void this.#reask('handshake');
        }
        return;
      case 'normal':
        this.provider.shouldConnect = false;
        return;
    }
  }

  /** Asks REST after a 4403 or repeated failed handshakes, then ends, lowers to read-only, or reconnects. */
  async #reask(cause: 'revoked' | 'handshake'): Promise<void> {
    const answer = await askAccess(this.docId);
    if (this.#disposed || this.#ended) return;
    switch (answer.kind) {
      case 'signed-out':
        this.end('session-ended');
        return;
      case 'gone':
        this.end(cause === 'revoked' ? 'revoked' : 'unavailable');
        return;
      case 'deleted':
        this.end('deleted');
        return;
      case 'role':
        // The pane's role, its top bar and its menus follow the answer (a demotion lowers them in place). A newer read
        // answered or access changed meanwhile (a lowering raised back before this answer came): this one is stale, so
        // ask again rather than act on it.
        if (!answer.remember()) {
          void this.#reask(cause);
          return;
        }
        // A suggester's failed handshakes are the network: its suggestions still need delivering, so it reconnects.
        if (!answer.canWrite && !(cause === 'handshake' && answer.canSuggest)) {
          refuseInput(VIEW_ONLY);
          this.#dropRollbacks();
          this.#ended = true;
          this.#set({ canWrite: false, resync: true });
          if (this.#lingering) this.dispose();
          return;
        }
        break;
      case 'unknown':
        break;
    }
    this.#failedHandshakes = 0;
    const delay = Math.min(15_000, 1_000 * 2 ** this.#accessRetries++);
    this.#accessRetry = setTimeout(() => {
      if (!this.#disposed && !this.#ended) void this.provider.connect();
    }, delay);
  }

  #heartbeat(): void {
    if (this.#disposed || this.#paused) return;
    const ws = this.provider.ws as DocSocket | null;
    const now = Date.now();
    // A main thread busy enough to hold this 1 s tick back (a 2 MB paste, its undo, a peer's large paste applied
    // here) reads its frames late: that is not a silent socket. Held 6 s was the bar, and a collaborator's tab
    // applying a 40,000-block paste, its ticks late by 1-5 s, read the server as silent and reconnected.
    // The grace is bounded by the last frame heard, so a socket that stays silent through it still reads as half-open.
    const heard = this.provider.wsLastMessageReceived;
    const late = this.#lastTick > 0 && now - this.#lastTick > BUSY_TICK_MS;
    if (heard !== this.#heardSeen) {
      this.#heardSeen = heard;
      this.#quietFor = 0;
    } else if (this.#lastTick > 0) {
      this.#quietFor += late ? HEARTBEAT_CHECK_MS : now - this.#lastTick;
    }
    if (late && this.#quietFor < BUSY_GRACE_MS) this.#visibleSince = now;
    this.#lastTick = now;
    if (ws && ws.readyState === WebSocket.OPEN && !document.hidden) {
      if (now - Math.max(heard, this.#visibleSince) > SILENCE_LIMIT_MS) {
        // Half-open: close 4408 and reconnect now; the old socket's close event may never come (A§10.5).
        this.#update({ type: 'silent', lastHeard: heard });
        ws.detach(CLOSE.heartbeat, 'heartbeat');
        return;
      }
      // Writes queued behind a budget no ack frees (acks lost while frames still arrive): the reconnect's step 2
      // replays the ledger, and its fresh outbox starts with an empty window.
      if ((ws.outbox?.blockedFor(now) ?? 0) > STUCK_MS) {
        this.#update({ type: 'silent', lastHeard: heard });
        ws.detach(CLOSE.heartbeat, 'stalled');
        return;
      }
      // While sync frames still arrive, the answer to the last step 1 is queued behind them: another would only
      // queue the whole backlog again. A peer behind a large paste was sent it once per 4 s, megabytes each time.
      // Held back at most RESYNC_HOLD_MS: an answer that was lost never arrives.
      const holding = this.#resyncOwed && now - this.#syncHeard < RESYNC_MS && now - this.#lastResync < RESYNC_HOLD_MS;
      if (now - this.#lastResync >= RESYNC_MS && !holding) this.#resync(ws);
    }
    this.#update(null);
  }

  #resync(ws: WebSocket): void {
    this.#lastResync = Date.now();
    try {
      ws.send(encodeSyncFrame(0, Y.encodeStateVector(this.doc)));
      this.#resyncOwed = true;
      // A woken DO has an empty awareness map even when this socket survived. Preserve the caret and focus.
      const awareness = this.provider.awareness;
      const state = awareness.getLocalState();
      if (state !== null && !this.#ended && !this.#lingering) awareness.setLocalState(state);
      // Writes still queued in the outbox are on their way; resending them would only queue them twice.
      if ((ws as DocSocket).outbox?.busy) return;
      // Unacked writes go again under the frame discipline (comments.md §6), unless a replay is already sending them.
      // Each held payload asks again too, after the note's backlog, so one whose frames were lost catches up (A§10.10).
      this.#payloadsDue = true;
      if (this.#ledger.pending().length && !this.#ended) {
        if (!this.#replay.active) this.#replay.start(this.#ledger.pending(), () => this.#resendPayloads());
      } else this.#resendPayloads();
    } catch {
      // closing; the close path takes over
    }
  }

  /** Back in view: the silence clock restarts and a step 1 asks the server for anything missed while hidden. */
  readonly #onVisibility = (): void => {
    if (document.hidden || this.#paused || this.#disposed) return;
    this.#visibleSince = Date.now();
    const ws = this.provider.ws;
    if (ws?.readyState === WebSocket.OPEN) this.#resync(ws);
  };

  /** Heartbeats stop on pagehide so the DO can hibernate, and resume if the page comes back from the cache. */
  readonly #onPageHide = (event: PageTransitionEvent): void => {
    if (!this.#paused && event.persisted && !this.#ended && !this.#lingering) this.#pagePresence = this.provider.awareness.getLocalState();
    this.#paused = true;
    this.provider.awareness.setLocalState(null);
  };

  readonly #onPageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    this.#paused = false;
    if (this.#pagePresence && !this.#disposed && !this.#ended && !this.#lingering && this.provider.awareness.getLocalState() === null) {
      this.provider.awareness.setLocalState(this.#pagePresence);
    }
    this.#pagePresence = null;
    this.#onVisibility();
  };

  /** Unacked clears only once body writes and suggest requests are both settled. */
  #settleUnacked(): void {
    if (this.#state.unacked && !this.#ledger.unacked && !this.#suggest.unacked) this.#set({ unacked: false });
  }

  #wrote(update: Uint8Array, payload?: string): void {
    this.#ledger.wrote(update, payload);
    if (!this.#state.unacked && this.#ledger.unacked) this.#set({ unacked: true });
  }

  #onServerEvent(message: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(message) as ServerEvent;
    } catch {
      return;
    }
    // A server event is a frame heard: y-partyserver stamps only binary ones, and a socket hearing just acks while a
    // large replay converges is alive, not silent.
    this.provider.wsLastMessageReceived = Date.now();
    if (event.t === 'usage') {
      this.payloadBytes = event.pb;
      this.#ledger.usageReported();
      // Once per connect: a test can wait for the DocDO's figure before it sizes a paste against it (j01-paste-held).
      performance.mark('moss-payload-usage', { detail: { pb: event.pb, limit: PASTE_LIMIT_BYTES } });
    } else if (event.t === 'ack') {
      this.payloadBytes = event.pb ?? 0;
      try {
        const sv = Y.decodeStateVector(base64ToBytes(event.sv));
        for (const [client, clock] of sv) if ((this.#ackedSv.get(client) ?? 0) < clock) this.#ackedSv.set(client, clock);
        (this.provider.ws as DocSocket | null)?.outbox?.acked(sv);
      } catch {
        // a malformed vector reopens nothing
      }
      const started = performance.now();
      if (this.#state.unacked && this.#ledger.acked(event)) this.#settleUnacked();
      if (this.#pastes.size > 0) this.#release();
      // A slow ack read is a User Timing measure, so a held tab can be told apart from the paste's batches.
      if (performance.now() - started > 50) performance.measure('moss-sync-ack', { start: started });
    } else if (isSuggestReply(event)) {
      this.#suggest.replied();
      for (const listener of [...this.#suggestListeners]) listener(event);
      this.#settleUnacked();
    } else if (event.t === 'write-refused') {
      this.#refusedMessage = event.reason === 'doc-cap' && event.limit && event.limit !== 'state'
        ? DOC_LIMIT_NOTICE[event.limit]
        : WRITE_REFUSED[event.reason] ?? WRITE_REFUSED.role;
      // A rollback refused in its turn is not tried again: the landed part stays (docs/METHOD.md).
      if (this.#rollbacks?.size) this.#dropRollbacks();
      // A paste cut short is rolled back by the binding that follows, and one that landed whole is completed: each
      // stops here, under its own key.
      if ((event.reason === 'doc-cap' || event.reason === 'unresolved') && this.#pastes.size > 0) {
        let cut = false;
        for (const track of this.#pastes) {
          // One not yet all written was cut short, whatever of it landed.
          const unfinished = !track.finished;
          track.stopped = true;
          track.abort();
          const record = track.record();
          if (unfinished) record.decided = 'cut';
          if (unfinished || !this.#landed(track)) cut = true;
          storeRollback(this.docId, record);
        }
        this.#pastes.clear();
        if (cut) this.#refusedMessage = PASTE_ROLLED_BACK;
      }
      refuseInput(this.#refusedMessage);
    } else if (event.t === 'doc-deleted') {
      this.end('deleted');
    } else if (event.t === 'restored') {
      // The restore's update came first on this socket: undo steps from before it would replay replaced items.
      clearUndoOf(this.doc);
      heardRestore(this.docId, { by: String(event.by), point: typeof event.point === 'string' ? event.point : null });
    }
  }
}

/**
 * A new session for `docId`, held by the pane `owner`, or null while another pane of this tab holds the doc. The
 * refusal never throws (A§10.1): the refused pane stays closed until the holder lets go. A new session is a fresh
 * attempt, so a terminal reason left by an earlier one clears.
 */
export function openDocSession(docId: string, owner: object, canWrite = true): DocSession | null {
  if (held.has(docId)) return null;
  clearTerminal(docId);
  const session = new DocSession(docId, canWrite);
  held.set(docId, { session, owner });
  byProvider.set(session.provider, session);
  ownersChanged();
  return session;
}

/**
 * Seam (d) of the vendored plugin: its provider effect's cleanup tears the session down and clears the doc map. A
 * refused pane's plugin has no provider.
 */
export function releaseProvider(docId: string, provider: object | undefined, docMap: Map<string, Y.Doc>): void {
  const session = provider && byProvider.get(provider);
  if (!session) return;
  const alias = aliases.get(provider);
  if (docMap.get(docId) === session.doc || (alias && docMap.get(docId) === alias.doc)) docMap.delete(docId);
  alias?.release();
  session.release();
}

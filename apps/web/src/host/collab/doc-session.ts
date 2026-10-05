// The doc session (A§10.1, A§10.5, A§10.6): per pane per doc, a fresh Y.Doc and one hardened YProvider, created
// when the binding plugin mounts and torn down in order when it unmounts. A tab holds at most one session per doc.
// The session owns its doc's connection truth: a 1 s heartbeat closes a socket silent for 12 s with 4408 and
// detaches it at once, every close code is dispatched once (closeAction), handshakes that keep failing ask REST, and
// a first sync later than 8 s reads `retrying`. Edits the DocDO has not acked live only in this Y.Doc, so a session
// released with unacked edits stays connected without its pane until they are acked, or until the doc ends.
import type { ConnectionState, TerminalReason } from '@moss-multi/protocol/dom-contract';
import { isRole, roleAtLeast } from '@moss-multi/protocol/roles';
import { CLOSE, closeAction, PAYLOAD_MESSAGE, type ServerEvent, type WriteRefusalReason } from '@moss-multi/protocol/sync';
import { attachPayloadDocs, PayloadDocs, PayloadSync } from '@moss-multi/sync/payload-docs';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import { leaveTo } from '../navigation.ts';
import { refuseInput } from '../refusal.ts';
import { AckLedger } from './acks.ts';
import {
  connectionOf, FIRST_SYNC_DEADLINE_MS, HANDSHAKE_FAILURES, HEARTBEAT_CHECK_MS, publishConnection, reduceLink, RESYNC_MS,
  SILENCE_LIMIT_MS, startLink, type Link, type LinkEvent,
} from './connection.ts';
import { clearTerminal, setTerminal, terminalOf } from './terminal.ts';
import { markSession, markUnacked } from './unacked.ts';

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
  /** Why the session stopped delivering edits (a refused write, or a lower role with edits pending). */
  halted: string | null;
}

type Listener = (state: SessionState) => void;

/** The banner and the refusal announcer say these. */
export const WRITE_REFUSED: Record<WriteRefusalReason, string> = {
  role: "You can't edit this note.",
  'doc-cap': 'This note is at its size limit, so your last change was not saved.',
  suggest: "Suggestions aren't available yet, so your change was not saved.",
};
export const HALTED_REFUSED = 'Your last change could not be saved. Reconnecting to the saved note.';
const VIEW_ONLY = 'You can view this note but can no longer edit it.';

/**
 * The provider's WebSocket (its WebSocketPolyfill). `detach` closes the socket and runs the provider's close path
 * at once, without waiting for a close event that a half-open socket may never deliver; from then on the socket's
 * own events are dropped, so a late close can never touch the socket that replaced it. The fields are declared, not
 * initialized: a subclass constructor may call addEventListener before an initializer would run.
 */
class DocSocket extends WebSocket {
  declare detached?: boolean;
  declare closeListeners?: ((event: CloseEvent) => void)[];

  /** Nothing goes out on a socket that is closing: a reply to a late server frame would be lost and logs an error. */
  override send(...args: Parameters<WebSocket['send']>): void {
    if (this.readyState === WebSocket.OPEN) super.send(...args);
  }

  detach(code: number, reason: string): void {
    if (this.detached) return;
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

function varUint(out: number[], value: number): void {
  let rest = value;
  while (rest > 0x7f) {
    out.push(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/** A y-protocols sync frame: message 0, the step, then its length-prefixed payload. */
function syncFrame(step: number, payload: Uint8Array): Uint8Array {
  const head = [0, step];
  varUint(head, payload.length);
  const frame = new Uint8Array(head.length + payload.length);
  frame.set(head);
  frame.set(payload, head.length);
  return frame;
}

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
  | { kind: 'role'; canWrite: boolean }
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | { kind: 'signed-out' }
  /** The network or the server could not say: keep trying. */
  | { kind: 'unknown' };

/** Asks REST what this caller may do with the doc (A§10.5 handshake failures, A§8 client handling of 4403). */
async function askAccess(docId: string): Promise<AccessAnswer> {
  const share = shareToken();
  const query = share ? `?share=${encodeURIComponent(share)}` : '';
  try {
    const response = await fetch(`/api/docs/${encodeURIComponent(docId)}/access${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 404) return { kind: 'gone' };
    if (!response.ok) return { kind: 'unknown' };
    const body = (await response.json()) as { role?: unknown; deleted?: unknown };
    if (body.deleted === true) return { kind: 'deleted' };
    return isRole(body.role) ? { kind: 'role', canWrite: roleAtLeast(body.role, 'editor') } : { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}

/** The tab's sessions by doc id with the pane holding each, and by provider for the plugin's teardown. */
const held = new Map<string, { session: DocSession; owner: object }>();
const byProvider = new WeakMap<object, DocSession>();
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

/** The server trashed these docs: this tab's sessions of them end now, without waiting for the 4410. */
export function endTrashedDocs(docIds: string[]): void {
  for (const session of [...sessions]) if (docIds.includes(session.docId)) session.end('deleted');
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

export class DocSession {
  readonly doc = new Y.Doc();
  /** The payload docs this tab holds beside the note (A§10.10), destroyed with it. */
  readonly payloads = attachPayloadDocs(this.doc, new PayloadDocs());
  readonly #payloadSync: PayloadSync;
  stopPresence?: () => void;
  readonly provider: YProvider;
  #state: SessionState = { synced: false, resync: false, unacked: false, retrying: false, connection: 'reconnecting', canWrite: true, writePaused: false, halted: null };
  readonly #listeners = new Set<Listener>();
  #refusedMessage = HALTED_REFUSED;
  #disposed = false;
  /** Released by its pane while edits were unacked: connected, without a pane, until the DocDO acks them. */
  #lingering = false;
  /** Terminal or halted: this session's edits can no longer land. */
  #ended = false;
  readonly #ledger = new AckLedger();
  #link: Link;
  #socketOpen = false;
  #lastResync = 0;
  #visibleSince = 0;
  #failedHandshakes = 0;
  #accessRetries = 0;
  #accessRetry: ReturnType<typeof setTimeout> | undefined;
  #paused = false;
  #pagePresence: ReturnType<YProvider['awareness']['getLocalState']> = null;
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
      WebSocketPolyfill: DocSocket as unknown as typeof WebSocket,
      params: () => {
        const share = shareToken();
        return share ? { share } : {};
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
    });
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
    if (this.docId || !this.#state.unacked || (this.#ended && terminalOf(this.docId) !== 'conn-limit')) {
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

  /** The doc is over for this session (A§10.6): no reconnect, every surface goes inert, a lingering session lets go. */
  end(reason: TerminalReason): void {
    if (this.#disposed) return;
    this.#ended = true;
    this.#pagePresence = null;
    this.provider.shouldConnect = false;
    setTerminal(this.docId, reason);
    if (this.#lingering && reason !== 'conn-limit') {
      this.dispose();
      return;
    }
    const ws = this.provider.ws;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(CLOSE.normal, 'ended');
  }

  /** Tries again after `conn-limit`: the terminal state clears and the socket reopens. */
  retry(): void {
    if (this.#disposed || this.#state.halted !== null) return;
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
    this.#payloadSync.destroy();
    this.doc.destroy();
    this.payloads.destroy();
  }

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    markUnacked(this, this.#state.unacked);
    this.#publish();
    for (const listener of [...this.#listeners]) listener(this.#state);
    for (const check of [...ackWaiters]) check();
  }

  #publish(): void {
    if (this.#disposed) return;
    const { connection, synced, retrying, halted } = this.#state;
    publishConnection(this.docId, this, { connection, synced, retrying, halted });
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
    this.#failedHandshakes = 0;
    // The note's unacked writes go first (the provider's own step 1 and step 2 follow this event): they hold the
    // elements naming payloads made offline, so those payloads' resends never reach the DocDO as unnamed writes.
    const pending = this.#ledger.pendingUpdate();
    if (pending && !this.#ended) this.provider.ws?.send(syncFrame(2, pending));
    this.#payloadSync.connected((id) => this.#ledger.pendingUpdate(id));
  }

  #synced(): void {
    this.#accessRetries = 0;
    this.#update({ type: 'synced' });
    if (this.#state.synced) return;
    clearTimeout(this.#deadline);
    this.#set({ synced: true, retrying: false });
  }

  #closed(event: CloseEvent | null): void {
    if (this.#disposed) return;
    const opened = this.#socketOpen;
    this.#socketOpen = false;
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
        if (!answer.canWrite) {
          refuseInput(VIEW_ONLY);
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
    if (ws && ws.readyState === WebSocket.OPEN && !document.hidden) {
      const now = Date.now();
      const heard = this.provider.wsLastMessageReceived;
      if (now - Math.max(heard, this.#visibleSince) > SILENCE_LIMIT_MS) {
        // Half-open: close 4408 and reconnect now; the old socket's close event may never come (A§10.5).
        this.#update({ type: 'silent', lastHeard: heard });
        ws.detach(CLOSE.heartbeat, 'heartbeat');
        return;
      }
      if (now - this.#lastResync >= RESYNC_MS) this.#resync(ws);
    }
    this.#update(null);
  }

  #resync(ws: WebSocket): void {
    this.#lastResync = Date.now();
    try {
      ws.send(syncFrame(0, Y.encodeStateVector(this.doc)));
      // A woken DO has an empty awareness map even when this socket survived. Preserve the caret and focus.
      const awareness = this.provider.awareness;
      const state = awareness.getLocalState();
      if (state !== null && !this.#ended && !this.#lingering) awareness.setLocalState(state);
      const pending = this.#ledger.pendingUpdate();
      if (pending && !this.#ended) ws.send(syncFrame(2, pending));
      if (!this.#ended) for (const id of this.#ledger.pendingPayloads()) this.#payloadSync.resend(id, this.#ledger.pendingUpdate(id));
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

  #wrote(update: Uint8Array, payload?: string): void {
    this.#ledger.wrote(update, payload);
    if (!this.#state.unacked) this.#set({ unacked: true });
  }

  #onServerEvent(message: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(message) as ServerEvent;
    } catch {
      return;
    }
    if (event.t === 'ack') {
      if (this.#state.unacked && this.#ledger.acked(event)) this.#set({ unacked: false });
    } else if (event.t === 'write-refused') {
      this.#refusedMessage = WRITE_REFUSED[event.reason] ?? WRITE_REFUSED.role;
      refuseInput(this.#refusedMessage);
    } else if (event.t === 'doc-deleted') {
      this.end('deleted');
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
  if (docMap.get(docId) === session.doc) docMap.delete(docId);
  session.release();
}

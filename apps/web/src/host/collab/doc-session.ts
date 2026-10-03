// The doc session (A§10.1): per pane per doc, a fresh Y.Doc and one hardened YProvider, created when the binding
// plugin mounts and torn down in order when it unmounts. A tab holds at most one session per doc. Edits the DocDO has
// not acked (typed while the socket was down) live only in this Y.Doc, so a session released with unacked edits stays
// connected without its pane until they are acked, and only then tears down (A§10.6).
import { base64ToBytes, type ServerEvent } from '@moss-multi/protocol/sync';
import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';

const PARTY = 'doc-d-o';
/** Sync step 1 every 4 s: the server always answers, which keeps frames flowing for the heartbeat (A§10.5). */
const RESYNC_INTERVAL_MS = 4_000;
const NORMAL_CLOSURE = 1000;

export interface SessionState {
  /** The provider has applied the server's first sync step 2. */
  synced: boolean;
  /** Some local write is not yet covered by a server ack (A§10.6). */
  unacked: boolean;
}

type Listener = (state: SessionState) => void;

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
    provider.ws?.close(NORMAL_CLOSURE, 'session closed');
  };
}

/** True when every clock in `local` is covered by `acked`. */
function covered(local: Map<number, number>, acked: Map<number, number>): boolean {
  for (const [client, clock] of local) if ((acked.get(client) ?? 0) < clock) return false;
  return true;
}

const shareToken = (): string | null => new URLSearchParams(window.location.search).get('share');

/** The tab's sessions by doc id with the pane holding each, and by provider for the plugin's teardown. */
const held = new Map<string, { session: DocSession; owner: object }>();
const byProvider = new WeakMap<object, DocSession>();
const ownerListeners = new Set<() => void>();

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

export class DocSession {
  readonly doc = new Y.Doc();
  readonly provider: YProvider;
  #state: SessionState = { synced: false, unacked: false };
  readonly #listeners = new Set<Listener>();
  #disposed = false;
  /** Released by its pane while edits were unacked: connected, without a pane, until the DocDO acks them. */
  #lingering = false;

  constructor(readonly docId: string) {
    this.provider = new YProvider(window.location.host, docId, this.doc, {
      party: PARTY,
      // The binding plugin makes the one connect; a second would be a second socket (L§4.3).
      connect: false,
      disableBc: true,
      resyncInterval: RESYNC_INTERVAL_MS,
      params: () => {
        const share = shareToken();
        return share ? { share } : {};
      },
    });
    broadcastAwarenessOnUpdate(this.provider);
    closeNormally(this.provider, () => this.#lingering);
    this.provider.on('sync', (synced: boolean) => {
      if (synced && !this.#state.synced) this.#set({ synced: true });
    });
    this.provider.on('custom-message', (message: string) => this.#onServerEvent(message));
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== this.provider && !this.#state.unacked) this.#set({ unacked: true });
    });
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
   * The pane let go. With every edit acked the session tears down now; otherwise it leaves presence, keeps (or
   * reopens) its socket so the next sync step 2 delivers the edits, and tears down at the ack. The doc stays held
   * meanwhile, so a pane that reopens it binds a fresh Y.Doc once the edits are on the server.
   */
  release(): void {
    if (this.#disposed || this.#lingering) return;
    if (!this.#state.unacked) {
      this.dispose();
      return;
    }
    this.#lingering = true;
    this.#listeners.clear();
    this.provider.awareness.setLocalState(null);
    this.#listeners.add((state) => {
      if (!state.unacked) this.dispose();
    });
    if (!this.provider.shouldConnect) void this.provider.connect();
  }

  /** Teardown in A§10.1 order: presence cleared while the socket is open, close 1000, then the doc. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lingering = false;
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
    this.doc.destroy();
  }

  #set(patch: Partial<SessionState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #onServerEvent(message: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(message) as ServerEvent;
    } catch {
      return;
    }
    if (event.t !== 'ack' || !this.#state.unacked) return;
    const acked = Y.decodeStateVector(base64ToBytes(event.sv));
    if (covered(Y.decodeStateVector(Y.encodeStateVector(this.doc)), acked)) this.#set({ unacked: false });
  }
}

/**
 * A new session for `docId`, held by the pane `owner`, or null while another pane of this tab holds the doc. The
 * refusal never throws (A§10.1): the refused pane stays closed until the holder lets go.
 */
export function openDocSession(docId: string, owner: object): DocSession | null {
  if (held.has(docId)) return null;
  const session = new DocSession(docId);
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

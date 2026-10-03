// The doc session (A§10.1): per pane per doc, a fresh Y.Doc and one hardened YProvider, created when the binding
// plugin mounts and torn down in order when it unmounts. A tab holds at most one session per doc.
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

/** An intentional close sends 1000, never a bare close. */
function closeNormally(provider: YProvider): void {
  provider.disconnect = () => {
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

/** The tab's sessions by doc id, and by provider for the plugin's teardown. */
const sessions = new Map<string, DocSession>();
const byProvider = new WeakMap<object, DocSession>();

export class DocSession {
  readonly doc = new Y.Doc();
  readonly provider: YProvider;
  #state: SessionState = { synced: false, unacked: false };
  readonly #listeners = new Set<Listener>();
  #disposed = false;

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
    closeNormally(this.provider);
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

  /** Teardown in A§10.1 order: presence cleared while the socket is open, close 1000, then the doc. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (sessions.get(this.docId) === this) sessions.delete(this.docId);
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

/** A new session for `docId`; a second session for a doc this tab already holds is refused loudly (A§10.1). */
export function openDocSession(docId: string): DocSession {
  if (sessions.has(docId)) throw new Error(`moss-multi: ${docId} is already open in this tab`);
  const session = new DocSession(docId);
  sessions.set(docId, session);
  byProvider.set(session.provider, session);
  return session;
}

/** Seam (d) of the vendored plugin: its provider effect's cleanup tears the session down and clears the doc map. */
export function releaseProvider(docId: string, provider: object, docMap: Map<string, Y.Doc>): void {
  const session = byProvider.get(provider);
  if (!session) return;
  if (docMap.get(docId) === session.doc) docMap.delete(docId);
  session.dispose();
}

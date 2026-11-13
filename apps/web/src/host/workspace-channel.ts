import { parseWorkspaceEvent, type WorkspaceEvent } from '@moss-multi/protocol/workspace';
import type { AuthStore } from './auth-state.ts';

export interface WorkspaceChannelDeps {
  auth: Pick<AuthStore, 'get' | 'subscribe'>;
  socket: () => WebSocket;
  visible: () => boolean;
  onPause?: () => void;
  onVisible: (callback: () => void) => () => void;
}

/** A socket that has not answered a visibility probe in this long is replaced. */
export const PROBE_MS = 10_000;
/** A healthy, visible channel still asks for a full refresh this often, so one lost event cannot leave metadata stale. */
export const RECONCILE_MS = 120_000;

/** Reconnect catches up through REST; no document watch sockets. A visible channel reconciles every RECONCILE_MS. */
export function subscribeWorkspace(deps: WorkspaceChannelDeps, receive: (event: WorkspaceEvent) => void): () => void {
  let disposed = false;
  let terminal = false;
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let probe: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;
  let lastPong = 0;
  let lastReconcile = 0;
  const allowed = () => !disposed && !terminal && deps.auth.get().status === 'signed-in';
  const stop = () => {
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    if (probe) clearTimeout(probe);
    retry = null;
    heartbeat = null;
    probe = null;
    const old = socket;
    socket = null;
    if (old) {
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
  };
  const reconnect = () => {
    stop();
    if (allowed()) retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15_000));
  };
  function connect() {
    if (!allowed() || socket) return;
    retry = null;
    let current: WebSocket;
    try { current = deps.socket(); } catch { reconnect(); return; }
    socket = current;
    current.onopen = () => {
      if (!allowed() || socket !== current) return;
      attempts = 0;
      lastPong = Date.now();
      // Includes the initial connection, covering changes between the boot read and this handshake.
      reconcile();
      heartbeat = setInterval(() => {
        if (!deps.visible()) return;
        if (Date.now() - lastPong > 60_000) { reconnect(); return; }
        current.send('ping');
        if (Date.now() - lastReconcile >= RECONCILE_MS) reconcile();
      }, 25_000);
    };
    current.onmessage = (message) => {
      if (!allowed() || socket !== current) return;
      if (message.data === 'pong') { lastPong = Date.now(); return; }
      try {
        const event = parseWorkspaceEvent(JSON.parse(String(message.data)));
        if (event) receive(event);
      } catch { /* Malformed frames never reach the bridge. */ }
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      if (event.code === 4401 || event.code === 4402) { terminal = true; stop(); deps.onPause?.(); return; }
      reconnect();
    };
    current.onerror = () => { if (socket === current) reconnect(); };
  }
  const offAuth = deps.auth.subscribe(() => { if (allowed()) connect(); else { stop(); deps.onPause?.(); } });
  const reconcile = () => {
    lastReconcile = Date.now();
    receive({ type: 'vaults' });
  };
  // Only a pong proves the socket alive: a probe unanswered within PROBE_MS replaces it. Returning to the tab never
  // postpones the heartbeat's own check.
  const offVisible = deps.onVisible(() => {
    if (!allowed()) return;
    if (socket?.readyState === 1) {
      const probed = socket;
      const sentAt = Date.now();
      probed.send('ping');
      if (!probe) {
        probe = setTimeout(() => {
          probe = null;
          if (socket === probed && lastPong < sentAt) reconnect();
        }, PROBE_MS);
      }
      if (Date.now() - lastReconcile >= RECONCILE_MS) reconcile();
    } else if (!socket) { if (retry) clearTimeout(retry); connect(); }
  });
  connect();
  return () => { disposed = true; stop(); offAuth(); offVisible(); };
}

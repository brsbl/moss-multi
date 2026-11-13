// Real severs (S-test §3.6). setOffline and CDP offline never close an open WebSocket (L§4.20), so a severable
// actor's doc sockets run through a routeWebSocket proxy; the whole-server half-open is Stack.pause().
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { CUSTOM_PREFIX, PAYLOAD_MESSAGE } from '../../packages/protocol/src/sync.ts';
import { DOC_SOCKET_PATH } from './contract.ts';

interface Conn {
  page: WebSocketRoute;
  server: WebSocketRoute | null;
  closed: boolean;
  census: { closed(): void } | null;
  lost: boolean;
  /** Frames the page sent while its doc was held, in order, not yet delivered. */
  held: (string | Buffer)[] | null;
}

/** Reports each page socket the proxy sees, so telemetry counts the page's sockets rather than the proxy's legs. */
export type SocketCensus = (url: string) => { closed(): void };

export interface Sever {
  /**
   * Half-open: both ends stay OPEN and nothing is delivered either way. With `swallowCloses`, a close from the server
   * is lost too, as on a dead network: the page learns its socket is gone only when `restore` drops it (1012).
   */
  blackhole(options?: { swallowCloses?: boolean }): void;
  /** Abrupt drop on both ends; 1012 is in the product's transient-retry set. */
  reset(code?: number): void;
  /** Delivers again, acks included, and lets reconnects that arrived while severed (and are still open) through. */
  restore(): void;
  /** Until the next reset or restore, no DocDO ack reaches the page (acks lost in flight); everything else crosses. */
  loseAcks(): void;
  /**
   * Edits in flight: until `deliverHeld`, every frame the page sends on `docId`'s sockets (open now or later) waits
   * here, undelivered and in order, while the server's frames still reach the page. A held socket that closes loses
   * its frames, as a dropped connection would.
   */
  hold(docId: string): void;
  /** Delivers the held frames in order and stops holding. */
  deliverHeld(): void;
  /** Queues every payload frame the DocDO sends (a block's text still in flight) until `releasePayloads`. */
  holdPayloads(): void;
  releasePayloads(): void;
  census(): { connections: number; dropped: { out: number; in: number }; acksLost: number; held: number };
  /** Sends a raw frame to the server on the page's open doc socket, as a client that ignores its binding would. */
  inject(frame: Buffer): void;
}

const isAck = (message: string | Buffer): boolean => {
  if (typeof message !== 'string' || !message.startsWith(CUSTOM_PREFIX)) return false;
  try {
    return (JSON.parse(message.slice(CUSTOM_PREFIX.length)) as { t?: unknown }).t === 'ack';
  } catch {
    return false;
  }
};

const isPayload = (message: string | Buffer): boolean => typeof message !== 'string' && message[0] === PAYLOAD_MESSAGE;

const DOC_SOCKET = new RegExp(DOC_SOCKET_PATH.replace(/\//g, '\\/'));

export async function makeSeverable(context: BrowserContext, census?: SocketCensus): Promise<Sever> {
  const ctl = {
    mode: 'up' as 'up' | 'blackhole', swallowCloses: false, conns: [] as Conn[], dropped: { out: 0, in: 0 }, losingAcks: false, acksLost: 0,
    holding: null as string | null, payloads: null as [Conn, Buffer][] | null,
  };
  const heldDoc = (conn: Conn) => {
    const path = new URL(conn.page.url()).pathname;
    return ctl.holding !== null && decodeURIComponent(path.slice(DOC_SOCKET_PATH.length).split('/')[0]) === ctl.holding;
  };
  const attach = (conn: Conn) => {
    const server = conn.page.connectToServer();
    conn.server = server;
    conn.page.onMessage((message) => {
      if (ctl.mode !== 'up') ctl.dropped.out++;
      else if (conn.held) conn.held.push(message);
      else server.send(message);
    });
    server.onMessage((message) => {
      if (ctl.mode !== 'up') ctl.dropped.in++;
      else if (ctl.losingAcks && isAck(message)) ctl.acksLost += 1;
      else if (ctl.payloads && isPayload(message)) ctl.payloads.push([conn, message as Buffer]);
      else conn.page.send(message);
    });
    server.onClose((code, reason) => {
      if (ctl.mode === 'blackhole' && ctl.swallowCloses) {
        conn.lost = true;
        return;
      }
      conn.closed = true;
      conn.held = null;
      conn.census?.closed();
      conn.page.close({ code, reason });
    });
  };
  // The proxy's own leg (Playwright's routing): a frame the page sent while its socket was OPEN is relayed to the real
  // socket later, and if the server's close reached that socket first, Chromium logs "WebSocket is already in CLOSING
  // or CLOSED state." for a send the page never made late. The relay drops such a frame, as the wire would. Only the
  // native socket is patched, before the routing mock replaces it, so the page's own sends keep the mock's checks.
  await context.addInitScript((path) => {
    if (!String(WebSocket).includes('[native code]')) return;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function relaySend(this: WebSocket, data: Parameters<WebSocket['send']>[0]) {
      if (this.readyState > WebSocket.OPEN && this.url.includes(path)) return;
      send.call(this, data);
    };
  }, DOC_SOCKET_PATH);
  await context.routeWebSocket(DOC_SOCKET, (page) => {
    const conn: Conn = { page, server: null, closed: false, census: census?.(page.url()) ?? null, lost: false, held: null };
    if (heldDoc(conn)) conn.held = [];
    ctl.conns.push(conn);
    // A socket the page closes while severed never reaches the server.
    page.onClose((code, reason) => {
      conn.closed = true;
      conn.held = null;
      conn.census?.closed();
      conn.server?.close({ code, reason });
    });
    if (ctl.mode === 'up') attach(conn);
  });
  return {
    blackhole({ swallowCloses = false } = {}) {
      ctl.mode = 'blackhole';
      ctl.swallowCloses = swallowCloses;
    },
    reset(code = 1012) {
      ctl.mode = 'blackhole';
      ctl.losingAcks = false;
      for (const conn of ctl.conns.filter((c) => !c.closed)) {
        conn.closed = true;
        conn.census?.closed();
        conn.page.close({ code, reason: 'qa-sever' });
        conn.server?.close({ code });
      }
    },
    restore() {
      ctl.mode = 'up';
      ctl.losingAcks = false;
      ctl.swallowCloses = false;
      // A socket the server closed during a swallowing black hole is dead; the page finds out now.
      for (const conn of ctl.conns.filter((c) => c.lost && !c.closed)) {
        conn.closed = true;
        conn.census?.closed();
        conn.page.close({ code: 1012, reason: 'qa-sever' });
      }
      for (const conn of ctl.conns.filter((c) => !c.server && !c.closed)) attach(conn);
    },
    loseAcks() {
      ctl.losingAcks = true;
    },
    hold(docId) {
      ctl.holding = docId;
      for (const conn of ctl.conns.filter((c) => !c.closed && !c.held && heldDoc(c))) conn.held = [];
    },
    deliverHeld() {
      ctl.holding = null;
      for (const conn of ctl.conns.filter((c) => c.held)) {
        const frames = conn.held ?? [];
        conn.held = null;
        if (!conn.closed && conn.server) for (const frame of frames) conn.server.send(frame);
      }
    },
    holdPayloads() {
      ctl.payloads ??= [];
    },
    releasePayloads() {
      const held = ctl.payloads ?? [];
      ctl.payloads = null;
      for (const [conn, message] of held) if (!conn.closed) conn.page.send(message);
    },
    census: () => ({
      connections: ctl.conns.length, dropped: { ...ctl.dropped }, acksLost: ctl.acksLost,
      held: ctl.conns.reduce((n, c) => n + (c.held?.length ?? 0), 0),
    }),
    inject(frame) {
      const conn = ctl.conns.filter((c) => !c.closed && c.server).at(-1);
      if (!conn?.server) throw new Error('no open doc socket to inject into');
      conn.server.send(frame);
    },
  };
}

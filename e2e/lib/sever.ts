// Real severs (S-test §3.6). setOffline and CDP offline never close an open WebSocket (L§4.20), so a severable
// actor's doc sockets run through a routeWebSocket proxy; the whole-server half-open is Stack.pause().
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { DOC_SOCKET_PATH } from './contract.ts';

interface Conn { page: WebSocketRoute; server: WebSocketRoute | null; closed: boolean; census: { closed(): void } | null }

/** Reports each page socket the proxy sees, so telemetry counts the page's sockets rather than the proxy's legs. */
export type SocketCensus = (url: string) => { closed(): void };

export interface Sever {
  /** Half-open: both ends stay OPEN and nothing is delivered either way. */
  blackhole(): void;
  /** Abrupt drop on both ends; 1012 is in the product's transient-retry set. */
  reset(code?: number): void;
  /** Delivers again, and lets reconnects that arrived while severed (and are still open) through. */
  restore(): void;
  census(): { connections: number; dropped: { out: number; in: number } };
}

const DOC_SOCKET = new RegExp(DOC_SOCKET_PATH.replace(/\//g, '\\/'));

export async function makeSeverable(context: BrowserContext, census?: SocketCensus): Promise<Sever> {
  const ctl = { mode: 'up' as 'up' | 'blackhole', conns: [] as Conn[], dropped: { out: 0, in: 0 } };
  const attach = (conn: Conn) => {
    const server = conn.page.connectToServer();
    conn.server = server;
    conn.page.onMessage((message) => (ctl.mode === 'up' ? server.send(message) : ctl.dropped.out++));
    server.onMessage((message) => (ctl.mode === 'up' ? conn.page.send(message) : ctl.dropped.in++));
    server.onClose((code, reason) => {
      conn.closed = true;
      conn.census?.closed();
      conn.page.close({ code, reason });
    });
  };
  await context.routeWebSocket(DOC_SOCKET, (page) => {
    const conn: Conn = { page, server: null, closed: false, census: census?.(page.url()) ?? null };
    ctl.conns.push(conn);
    // A socket the page closes while severed never reaches the server.
    page.onClose((code, reason) => {
      conn.closed = true;
      conn.census?.closed();
      conn.server?.close({ code, reason });
    });
    if (ctl.mode === 'up') attach(conn);
  });
  return {
    blackhole() {
      ctl.mode = 'blackhole';
    },
    reset(code = 1012) {
      ctl.mode = 'blackhole';
      for (const conn of ctl.conns.filter((c) => !c.closed)) {
        conn.closed = true;
        conn.census?.closed();
        conn.page.close({ code, reason: 'qa-sever' });
        conn.server?.close({ code });
      }
    },
    restore() {
      ctl.mode = 'up';
      for (const conn of ctl.conns.filter((c) => !c.server && !c.closed)) attach(conn);
    },
    census: () => ({ connections: ctl.conns.length, dropped: { ...ctl.dropped } }),
  };
}

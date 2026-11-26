// Real severs (S-test §3.6). setOffline and CDP offline never close an open WebSocket (L§4.20), so a severable
// actor's doc sockets run through a routeWebSocket proxy; the whole-server half-open is Stack.pause().
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import { CLOSE, CUSTOM_PREFIX, PAYLOAD_MESSAGE } from '../../packages/protocol/src/sync.ts';
import { DOC_SOCKET_PATH } from './contract.ts';

interface Conn {
  page: WebSocketRoute;
  server: WebSocketRoute | null;
  closed: boolean;
  census: ReturnType<SocketCensus> | null;
  lost: boolean;
  /** Frames the page sent while its doc was held, in order, not yet delivered. */
  held: (string | Buffer)[] | null;
  /** The socket's place in the order this context opened its doc sockets. */
  index: number;
  /** The page's end is closed while the server's leg stays open, holding its undelivered frames (`orphan`). */
  orphaned: boolean;
}

/**
 * One line of the tap: a doc socket of this context opening or closing, a suggest-mode frame crossing either way (or
 * not crossing: `fate`), or a call on the sever itself. A routed page's frames and close codes are seen nowhere else.
 */
export interface TapEvent {
  at: number;
  /** The socket, in the order the context opened its doc sockets; -1 for a call on the sever. */
  conn: number;
  kind: 'open' | 'out' | 'in' | 'close' | 'ctl';
  /** A frame's `t`, or the sever call's name. */
  t?: string;
  record?: string | null;
  /** `suggest-lease`: the leases the request resumes; absent on a fresh request. */
  resume?: number[];
  fork?: string;
  reason?: string;
  /** `suggest-leased`: the leases granted, as `client:clock:record`. */
  leases?: string[];
  /** `suggest-ops`: the base64 length of the update. */
  size?: number;
  fate?: 'crossed' | 'held' | 'released' | 'dropped' | 'lost' | 'late' | 'orphan';
  side?: 'server' | 'page' | 'sever';
  code?: number;
  closeReason?: string;
}

/** Reports each page socket the proxy sees, so telemetry counts the page's sockets rather than the proxy's legs. */
export type SocketCensus = (url: string) => { closed(code?: number, reason?: string): void; received?(message: string | Buffer): void };

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
  /**
   * Once the DocDO closes one of `docId`'s sockets 4409 (a refused write), the writes the page sends on its later
   * sockets (sync step 2s, updates and payload frames) wait undelivered; its step 1s still cross, so it binds.
   */
  holdWritesAfterRefusal(docId: string): void;
  /** Stops holding and drops every held frame undelivered, as a closed tab loses them. */
  dropHeld(): void;
  /** Queues every payload frame the DocDO sends (a block's text still in flight) until `releasePayloads`. */
  holdPayloads(): void;
  /** Queues every frame the DocDO sends, not only payloads, until `releasePayloads`: an edit waits at the page's door. */
  holdIncoming(): void;
  releasePayloads(): void;
  /** `heldUpdates`: the queued frames that are document updates (y-protocols message 0, 2). */
  census(): { connections: number; dropped: { out: number; in: number }; acksLost: number; held: number; heldUpdates: number };
  /**
   * Sends a raw frame to the server on the page's open doc socket, as a client that ignores its binding would: a binary
   * sync frame, or a string such as a `__YPS:` suggest request.
   */
  inject(frame: Buffer | string): void;
  /** Every suggest-mode frame, socket open and close, and sever call so far, in order. */
  log(): TapEvent[];
  /** Until the next reset, no suggest reply reaches the page (a frame stored with its reply lost); the tap records each. */
  loseSuggestReplies(): void;
  /**
   * A stalled connection the page gave up on: the page's sockets close (1012) while their server legs stay open with
   * the frames held on them, and holding stops, so the page's next socket crosses at once.
   */
  orphan(): void;
  /** Sends each orphaned leg's held frames to the server, late and in order; the leg stays open to hear the replies. */
  deliverOrphaned(): number;
  /** Closes the orphaned server legs. */
  closeOrphaned(): void;
}

/** What the tap keeps of a suggest-mode frame; null for any other frame. */
export const suggestFrame = (message: string | Buffer): Partial<TapEvent> | null => {
  if (typeof message !== 'string' || !message.startsWith(CUSTOM_PREFIX)) return null;
  try {
    const frame = JSON.parse(message.slice(CUSTOM_PREFIX.length)) as Record<string, unknown>;
    const t = frame.t;
    if (typeof t !== 'string' || (!t.startsWith('suggest-') && t !== 'write-refused')) return null;
    const leases = Array.isArray(frame.leases)
      ? (frame.leases as { client?: unknown; clock?: unknown; record?: unknown }[]).map((lease) => `${String(lease.client)}:${String(lease.clock)}:${String(lease.record).slice(0, 8)}`)
      : undefined;
    const record = typeof frame.record === 'string' ? frame.record.slice(0, 8) : typeof frame.into === 'string' ? frame.into.slice(0, 8) : frame.record === null ? null : undefined;
    return {
      t,
      ...(record !== undefined ? { record } : {}),
      ...(Array.isArray(frame.resume) ? { resume: frame.resume as number[] } : {}),
      ...(typeof frame.fork === 'string' ? { fork: frame.fork.slice(0, 8) } : {}),
      ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {}),
      ...(leases ? { leases } : {}),
      ...(typeof frame.update === 'string' ? { size: frame.update.length } : {}),
    };
  } catch {
    return null;
  }
};

const isAck = (message: string | Buffer): boolean => {
  if (typeof message !== 'string' || !message.startsWith(CUSTOM_PREFIX)) return false;
  try {
    return (JSON.parse(message.slice(CUSTOM_PREFIX.length)) as { t?: unknown }).t === 'ack';
  } catch {
    return false;
  }
};

const isPayload = (message: string | Buffer): boolean => typeof message !== 'string' && message[0] === PAYLOAD_MESSAGE;
/** A sync step 2 or update (y-protocols: message 0, then 1 or 2), or a payload frame: a write, not a step 1. */
const isWrite = (message: string | Buffer): boolean =>
  typeof message !== 'string' && ((message[0] === 0 && (message[1] === 1 || message[1] === 2)) || message[0] === PAYLOAD_MESSAGE);

const DOC_SOCKET = new RegExp(DOC_SOCKET_PATH.replace(/\//g, '\\/'));

export async function makeSeverable(context: BrowserContext, census?: SocketCensus): Promise<Sever> {
  const ctl = {
    mode: 'up' as 'up' | 'blackhole', swallowCloses: false, conns: [] as Conn[], dropped: { out: 0, in: 0 }, losingAcks: false, acksLost: 0,
    holding: null as string | null, payloads: null as [Conn, string | Buffer][] | null,
    writesOnly: false, holdOnRefusal: null as string | null, holdAll: false,
    losingSuggest: false, tap: [] as TapEvent[], orphans: [] as { conn: Conn; frames: (string | Buffer)[] }[],
  };
  const note = (conn: Conn | null, event: Omit<TapEvent, 'at' | 'conn'>) => {
    ctl.tap.push({ at: Date.now(), conn: conn ? conn.index : -1, ...event });
  };
  const heldDoc = (conn: Conn) => {
    const path = new URL(conn.page.url()).pathname;
    return ctl.holding !== null && decodeURIComponent(path.slice(DOC_SOCKET_PATH.length).split('/')[0]) === ctl.holding;
  };
  const attach = (conn: Conn) => {
    const server = conn.page.connectToServer();
    conn.server = server;
    conn.page.onMessage((message) => {
      const frame = suggestFrame(message);
      const fate = ctl.mode !== 'up' ? 'dropped' : conn.held && (!ctl.writesOnly || isWrite(message)) ? 'held' : 'crossed';
      if (frame) note(conn, { kind: 'out', ...frame, fate });
      if (ctl.mode !== 'up') ctl.dropped.out++;
      else if (conn.held && (!ctl.writesOnly || isWrite(message))) conn.held.push(message);
      else server.send(message);
    });
    server.onMessage((message) => {
      const frame = suggestFrame(message);
      if (conn.orphaned) {
        // The page gave this socket up: nobody hears the reply but the tap.
        if (frame) note(conn, { kind: 'in', ...frame, fate: 'orphan' });
        return;
      }
      if (ctl.mode !== 'up') {
        ctl.dropped.in++;
        if (frame) note(conn, { kind: 'in', ...frame, fate: 'dropped' });
      } else if (ctl.losingAcks && isAck(message)) ctl.acksLost += 1;
      else if (ctl.losingSuggest && frame && frame.t !== 'write-refused') note(conn, { kind: 'in', ...frame, fate: 'lost' });
      else if (ctl.payloads && (ctl.holdAll || isPayload(message))) ctl.payloads.push([conn, message]);
      else {
        if (frame) note(conn, { kind: 'in', ...frame, fate: 'crossed' });
        conn.page.send(message);
        conn.census?.received?.(message);
      }
    });
    server.onClose((code, reason) => {
      note(conn, { kind: 'close', side: 'server', code, closeReason: reason, ...(conn.orphaned ? { fate: 'orphan' as const } : {}) });
      if (conn.orphaned) return;
      if (code === CLOSE.writeRefused && ctl.holdOnRefusal !== null) {
        ctl.holding = ctl.holdOnRefusal;
        ctl.writesOnly = true;
        ctl.holdOnRefusal = null;
      }
      if (ctl.mode === 'blackhole' && ctl.swallowCloses) {
        conn.lost = true;
        return;
      }
      conn.closed = true;
      conn.held = null;
      conn.census?.closed(code, reason);
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
    const conn: Conn = { page, server: null, closed: false, census: census?.(page.url()) ?? null, lost: false, held: null, index: ctl.conns.length, orphaned: false };
    if (heldDoc(conn)) conn.held = [];
    ctl.conns.push(conn);
    note(conn, { kind: 'open', t: ctl.mode, ...(conn.held ? { fate: 'held' as const } : {}) });
    // A socket the page closes while severed never reaches the server.
    page.onClose((code, reason) => {
      if (conn.orphaned) return;
      note(conn, { kind: 'close', side: 'page', code, closeReason: reason });
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
      note(null, { kind: 'ctl', t: 'reset' });
      ctl.mode = 'blackhole';
      ctl.losingAcks = false;
      ctl.losingSuggest = false;
      for (const conn of ctl.conns.filter((c) => !c.closed)) {
        note(conn, { kind: 'close', side: 'sever', code, closeReason: 'qa-sever', ...(conn.server ? {} : { fate: 'dropped' as const }) });
        conn.closed = true;
        conn.census?.closed();
        conn.page.close({ code, reason: 'qa-sever' });
        conn.server?.close({ code });
      }
    },
    restore() {
      note(null, { kind: 'ctl', t: 'restore' });
      ctl.mode = 'up';
      ctl.losingAcks = false;
      ctl.swallowCloses = false;
      // A socket the server closed during a swallowing black hole is dead; the page finds out now.
      for (const conn of ctl.conns.filter((c) => c.lost && !c.closed)) {
        note(conn, { kind: 'close', side: 'sever', code: 1012, closeReason: 'qa-sever' });
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
      note(null, { kind: 'ctl', t: 'hold' });
      ctl.holding = docId;
      for (const conn of ctl.conns.filter((c) => !c.closed && !c.held && heldDoc(c))) conn.held = [];
    },
    deliverHeld() {
      note(null, { kind: 'ctl', t: 'deliverHeld' });
      ctl.holding = null;
      ctl.writesOnly = false;
      for (const conn of ctl.conns.filter((c) => c.held)) {
        const frames = conn.held ?? [];
        conn.held = null;
        if (!conn.closed && conn.server) {
          for (const frame of frames) {
            const tapped = suggestFrame(frame);
            if (tapped) note(conn, { kind: 'out', ...tapped, fate: 'released' });
            conn.server.send(frame);
          }
        }
      }
    },
    holdWritesAfterRefusal(docId) {
      ctl.holdOnRefusal = docId;
    },
    dropHeld() {
      note(null, { kind: 'ctl', t: 'dropHeld' });
      ctl.holding = null;
      ctl.writesOnly = false;
      for (const conn of ctl.conns) conn.held = null;
    },
    holdPayloads() {
      ctl.payloads ??= [];
    },
    holdIncoming() {
      ctl.payloads ??= [];
      ctl.holdAll = true;
    },
    releasePayloads() {
      const held = ctl.payloads ?? [];
      ctl.payloads = null;
      ctl.holdAll = false;
      for (const [conn, message] of held) {
        if (conn.closed) continue;
        conn.page.send(message);
        conn.census?.received?.(message);
      }
    },
    census: () => ({
      connections: ctl.conns.length, dropped: { ...ctl.dropped }, acksLost: ctl.acksLost,
      held: ctl.conns.reduce((n, c) => n + (c.held?.length ?? 0), 0),
      heldUpdates: (ctl.payloads ?? []).filter(([, message]) => typeof message !== 'string' && message[0] === 0 && message[1] === 2).length,
    }),
    inject(frame) {
      const conn = ctl.conns.filter((c) => !c.closed && c.server).at(-1);
      if (!conn?.server) throw new Error('no open doc socket to inject into');
      conn.server.send(frame);
    },
    log: () => ctl.tap.map((event) => ({ ...event })),
    loseSuggestReplies() {
      note(null, { kind: 'ctl', t: 'loseSuggestReplies' });
      ctl.losingSuggest = true;
    },
    orphan() {
      note(null, { kind: 'ctl', t: 'orphan' });
      ctl.holding = null;
      ctl.writesOnly = false;
      for (const conn of ctl.conns.filter((c) => !c.closed && c.server)) {
        note(conn, { kind: 'close', side: 'sever', code: 1012, closeReason: 'qa-sever', fate: 'orphan' });
        conn.closed = true;
        conn.orphaned = true;
        conn.census?.closed();
        ctl.orphans.push({ conn, frames: conn.held ?? [] });
        conn.held = null;
        conn.page.close({ code: 1012, reason: 'qa-sever' });
      }
    },
    deliverOrphaned() {
      note(null, { kind: 'ctl', t: 'deliverOrphaned' });
      let sent = 0;
      for (const orphan of ctl.orphans) {
        for (const frame of orphan.frames.splice(0)) {
          const tapped = suggestFrame(frame);
          if (tapped) note(orphan.conn, { kind: 'out', ...tapped, fate: 'late' });
          orphan.conn.server?.send(frame);
          sent += 1;
        }
      }
      return sent;
    },
    closeOrphaned() {
      note(null, { kind: 'ctl', t: 'closeOrphaned' });
      for (const { conn } of ctl.orphans.splice(0)) conn.server?.close({ code: 1012 });
    },
  };
}

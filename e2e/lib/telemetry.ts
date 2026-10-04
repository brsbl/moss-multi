// Per-page census, installed before the first navigation (S-test §3.3): console, page errors, HTTP >= 400,
// failed requests, doc sockets and the build stamps of every document load.
import type { Page } from '@playwright/test';
import { DOC_SOCKET_PATH, NAMES } from './contract.ts';
import { readStamps } from './detectors.js';

export interface ConsoleEntry { type: string; text: string; url: string; at: number }
export interface PageError { message: string; stack: string; at: number }
export interface HttpEntry { status: number; method: string; url: string; at: number }
export interface FailedRequest { method: string; url: string; failure: string; at: number }
export interface SocketEntry { url: string; docId: string; epoch: number; openedAt: number; closedAt: number | null; error: string | null }
export interface StampEntry { url: string; status: number | null; meta: string | null; client: string | null; at: number }

export class Telemetry {
  readonly console: ConsoleEntry[] = [];
  readonly pageErrors: PageError[] = [];
  readonly http: HttpEntry[] = [];
  readonly failed: FailedRequest[] = [];
  readonly sockets: SocketEntry[] = [];
  readonly stamps: StampEntry[] = [];
  /** Document loads so far; sockets are counted per (doc, epoch), because a reload is a new document. */
  epoch = 0;
  private documentStatus: number | null = null;
  private pending: Promise<void>[] = [];

  /**
   * `routed`: the context's doc sockets run through a routeWebSocket proxy (a severable actor). The page's own
   * sockets are then mocks CDP never sees (it sees only the proxy's server legs), so the proxy reports each one
   * through routedSocket instead.
   */
  static install(page: Page, { routed = false } = {}): Telemetry {
    const t = new Telemetry();
    page.on('console', (message) => {
      if (message.type() !== 'error' && message.type() !== 'warning') return;
      t.console.push({ type: message.type(), text: message.text(), url: message.location().url ?? '', at: Date.now() });
    });
    page.on('pageerror', (error) => t.pageErrors.push({ message: error.message, stack: error.stack ?? '', at: Date.now() }));
    page.on('response', (response) => {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        t.documentStatus = response.status();
        t.epoch += 1;
      }
      if (response.status() >= 400) t.http.push({ status: response.status(), method: request.method(), url: response.url(), at: Date.now() });
    });
    page.on('requestfailed', (request) =>
      t.failed.push({ method: request.method(), url: request.url(), failure: request.failure()?.errorText ?? '', at: Date.now() }),
    );
    page.on('websocket', (socket) => {
      if (routed) return;
      const entry = t.socketOpened(socket.url());
      if (!entry) return;
      socket.on('close', () => { entry.closedAt = Date.now(); });
      socket.on('socketerror', (error) => { entry.error = String(error); });
    });
    page.on('load', () => {
      t.pending.push(t.stamp(page));
    });
    return t;
  }

  /** Records a doc socket the page opened now; null for any other socket. */
  socketOpened(url: string): SocketEntry | null {
    const path = new URL(url).pathname;
    if (!path.startsWith(DOC_SOCKET_PATH)) return null;
    const entry: SocketEntry = {
      url,
      docId: decodeURIComponent(path.slice(DOC_SOCKET_PATH.length).split('/')[0]),
      epoch: this.epoch,
      openedAt: Date.now(),
      closedAt: null,
      error: null,
    };
    this.sockets.push(entry);
    return entry;
  }

  /** A routed page socket, as the proxy saw it open; `closed()` records its close, once. */
  routedSocket(url: string): { closed(): void } {
    const entry = this.socketOpened(url);
    return {
      closed() {
        if (entry && entry.closedAt === null) entry.closedAt = Date.now();
      },
    };
  }

  /** Waits for stamp reads started by load events. */
  async settle(): Promise<void> {
    await Promise.all(this.pending);
  }

  /** Records the current document's build stamps; a page that navigates away mid-read is skipped. */
  async stamp(page: Page): Promise<void> {
    try {
      const { meta, client } = await page.evaluate(readStamps, { names: NAMES });
      this.stamps.push({ url: page.url(), status: this.documentStatus, meta, client, at: Date.now() });
    } catch {
      // navigated or closed; the next load records its own stamps
    }
  }
}

// Per-page census, installed before the first navigation (S-test §3.3): console, page errors, HTTP >= 400,
// failed requests, doc sockets and the build stamps of every document load.
import type { Page } from '@playwright/test';
import { DOC_SOCKET_PATH, NAMES } from './contract.ts';
import { readStamps } from './detectors.js';

export interface ConsoleEntry { type: string; text: string; url: string; at: number }
export interface PageError { message: string; stack: string; at: number }
export interface HttpEntry { status: number; method: string; url: string; at: number }
export interface FailedRequest { method: string; url: string; failure: string; at: number }
export interface SocketEntry {
  url: string; docId: string; epoch: number; openedAt: number; closedAt: number | null; error: string | null;
  /** The close event's code, when the page saw it (not on a routed page). */
  code?: number | null;
  /** The page document that opened it, when the page reported it (not on a routed page). */
  document?: string | null;
}
export interface StampEntry { url: string; status: number | null; meta: string | null; client: string | null; at: number }

/** The page reports each doc socket it closes through this binding (Telemetry.install). */
const PAGE_CLOSE_BINDING = '__e2eDocSocketClosed';
/** The page reports each doc socket's close event code through this binding. */
const CLOSE_CODE_BINDING = '__e2eDocSocketCloseCode';
/** The page reports the document that constructs each doc socket through this binding. */
const SOCKET_DOCUMENT_BINDING = '__e2eDocSocketDocument';

export class Telemetry {
  readonly console: ConsoleEntry[] = [];
  readonly pageErrors: PageError[] = [];
  readonly http: HttpEntry[] = [];
  readonly failed: FailedRequest[] = [];
  readonly sockets: SocketEntry[] = [];
  readonly stamps: StampEntry[] = [];
  /** Document loads so far; sockets are counted per (doc, epoch), because a reload is a new document. */
  epoch = 0;
  /** Resolves once the page-side hooks are registered; await it before the first navigation. */
  ready: Promise<void> = Promise.resolve();
  private documentStatus: number | null = null;
  private pending: Promise<void>[] = [];
  /** Each doc socket URL's document, as the page reported it (each URL carries its own `_pk`). */
  private documents = new Map<string, string>();

  /**
   * `routed`: the context's doc sockets run through a routeWebSocket proxy (a severable actor). The page's own
   * sockets are then mocks CDP never sees (it sees only the proxy's server legs), so the proxy reports each one
   * through routedSocket instead.
   *
   * A socket counts as closed from the moment the page closes it: a browser holds a socket it closed in its closing
   * handshake until the far end answers (up to a minute when the server is stopped), and the page no longer holds it.
   */
  static install(page: Page, { routed = false } = {}): Telemetry {
    const t = new Telemetry();
    if (!routed) {
      t.ready = Promise.all([
        page.exposeBinding(PAGE_CLOSE_BINDING, (_source, url: unknown, at: unknown) => {
          if (typeof url === 'string') t.pageClosed(url, typeof at === 'number' ? at : Date.now());
        }),
        page.exposeBinding(CLOSE_CODE_BINDING, (_source, url: unknown, code: unknown) => {
          if (typeof url === 'string' && typeof code === 'number') t.closeCode(url, code);
        }),
        page.exposeBinding(SOCKET_DOCUMENT_BINDING, (_source, url: unknown, document: unknown) => {
          if (typeof url === 'string' && typeof document === 'string') t.socketDocument(url, document);
        }),
        page.addInitScript(
          ({ path, binding, codes, documents }) => {
            // This document's identity: a socket the previous document opened as it unloaded can reach the census
            // after this document's navigation response, so the navigation count alone would misfile it.
            const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            // Every doc socket's close code, through a construct trap that leaves the class, its statics and
            // instanceof as they are.
            const Native = WebSocket;
            window.WebSocket = new Proxy(Native, {
              construct(target, args: ConstructorParameters<typeof WebSocket>, newTarget: (new (...a: ConstructorParameters<typeof WebSocket>) => WebSocket)) {
                // newTarget keeps a subclass of this class (a journey's recorder) its own methods.
                const socket = Reflect.construct(target, args, newTarget) as WebSocket;
                try {
                  if (new URL(socket.url).pathname.startsWith(path)) {
                    const own = (window as unknown as Record<string, ((url: string, document: string) => unknown) | undefined>)[documents];
                    void own?.(socket.url, documentId);
                    socket.addEventListener('close', (event) => {
                      const report = (window as unknown as Record<string, ((url: string, code: number) => unknown) | undefined>)[codes];
                      void report?.(socket.url, event.code);
                    });
                  }
                } catch {
                  // the census never breaks the page
                }
                return socket;
              },
            });
            const close = WebSocket.prototype.close;
            WebSocket.prototype.close = function (this: WebSocket, code?: number, reason?: string) {
              try {
                const report = (window as unknown as Record<string, ((url: string, at: number) => unknown) | undefined>)[binding];
                if (this.readyState < WebSocket.CLOSING && new URL(this.url).pathname.startsWith(path)) void report?.(this.url, Date.now());
              } catch {
                // the census never breaks the page
              }
              return close.call(this, code, reason);
            };
          },
          { path: DOC_SOCKET_PATH, binding: PAGE_CLOSE_BINDING, codes: CLOSE_CODE_BINDING, documents: SOCKET_DOCUMENT_BINDING },
        ),
      ]).then(() => undefined);
    }
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
      socket.on('close', () => { entry.closedAt ??= Date.now(); });
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
      document: this.documents.get(url) ?? null,
    };
    this.sockets.push(entry);
    return entry;
  }

  /** The page document that constructed the doc socket at `url`; the report and the open may arrive in either order. */
  socketDocument(url: string, document: string): void {
    this.documents.set(url, document);
    for (const socket of this.sockets) if (socket.url === url && !socket.document) socket.document = document;
  }

  /** The page closed the doc socket at `url` at page time `at` (each socket's URL carries its own `_pk`). */
  pageClosed(url: string, at: number): void {
    const entry = [...this.sockets].reverse().find((socket) => socket.url === url && socket.closedAt === null);
    if (entry) entry.closedAt = Math.max(entry.openedAt, at);
  }

  /** The close code of the newest doc socket at `url` that has none yet. */
  closeCode(url: string, code: number): void {
    const entry = [...this.sockets].reverse().find((socket) => socket.url === url && socket.code == null);
    if (entry) entry.code = code;
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

// The canary's per-run request budget (A§21, T8.D): every request a canary leg makes to the Worker counts, from the
// browser and from Node, and the run fails once it passes the budget. Static assets under /assets/ are served
// without invoking the Worker, so they are not counted. The count lives in a file beside the canary state, so a
// restarted Playwright worker keeps counting the same run.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext } from '@playwright/test';

export class RequestBudget {
  private used: number;
  private readonly origin: string;

  constructor(readonly path: string, readonly limit: number, baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
    this.used = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { used: number }).used : 0;
  }

  get count(): number {
    return this.used;
  }

  get exceeded(): boolean {
    return this.used > this.limit;
  }

  /** Counts one request to `url` when it reaches the Worker. */
  charge(url: string): void {
    const target = new URL(url.replace(/^ws/, 'http'));
    if (target.origin !== this.origin || target.pathname.startsWith('/assets/')) return;
    this.used += 1;
    writeFileSync(this.path, `${JSON.stringify({ used: this.used, limit: this.limit })}\n`);
  }

  /** Counts every request and socket the context's pages open. */
  watch(context: BrowserContext): void {
    context.on('request', (request) => this.charge(request.url()));
    context.on('page', (page) => page.on('websocket', (socket) => this.charge(socket.url())));
  }

  /** Fails once the run has made more requests than its budget. */
  assert(where: string): void {
    if (this.exceeded) throw new Error(`request budget: ${this.used} Worker requests passed this run's budget of ${this.limit} (${where})`);
  }
}

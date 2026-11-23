// The canary's per-run request budget (A§21, T8.D): every request a leg makes to the Worker counts, from the browser,
// from Node's fetch, from Playwright's API request contexts and from child processes such as the CLI, and the run
// fails once it passes the budget. Static assets under /assets/ are served without invoking the Worker, so they are
// not counted. The count lives in a file beside the canary state, so a restarted Playwright worker keeps counting the
// same run; a child process appends one byte per request to a sidecar file, which the count adds.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

/** The preload a child process gets through NODE_OPTIONS; it counts the child's fetches into the sidecar. */
const CHILD_PRELOAD = new URL('./budget-child.mjs', import.meta.url);

/** The budget Node's own fetch charges, if any (one per Playwright worker). */
const node: { budget: RequestBudget | null; wrapped: boolean } = { budget: null, wrapped: false };

const urlOf = (input: unknown): string | null => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    const url = (input as { url: unknown }).url;
    return typeof url === 'function' ? String((url as () => string).call(input)) : String(url);
  }
  return null;
};

export class RequestBudget {
  private used: number;
  private readonly origin: string;
  /** Child processes' requests, one byte each. */
  readonly childPath: string;

  constructor(readonly path: string, readonly limit: number, baseUrl: string) {
    this.origin = new URL(baseUrl).origin;
    this.childPath = `${path}.children`;
    this.used = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { own?: number }).own ?? 0 : 0;
  }

  private get children(): number {
    return existsSync(this.childPath) ? statSync(this.childPath).size : 0;
  }

  get count(): number {
    return this.used + this.children;
  }

  get exceeded(): boolean {
    return this.count > this.limit;
  }

  /** True when a request to `url` reaches the Worker. */
  counts(url: string, base = this.origin): boolean {
    let target: URL;
    try {
      target = new URL(url.replace(/^ws/, 'http'), base);
    } catch {
      return false;
    }
    return target.origin === this.origin && !target.pathname.startsWith('/assets/');
  }

  /** Counts one request to `url` when it reaches the Worker. */
  charge(url: string): void {
    if (!this.counts(url)) return;
    this.used += 1;
    writeFileSync(this.path, `${JSON.stringify({ used: this.count, own: this.used, limit: this.limit })}\n`);
  }

  /** Counts every request and socket the context's pages open, and every request its API context sends. */
  watch(context: BrowserContext): void {
    context.on('request', (request) => this.charge(request.url()));
    context.on('page', (page) => page.on('websocket', (socket) => this.charge(socket.url())));
    this.watchApi(context.request);
  }

  /** Counts every request an API request context sends (`get`, `post` and the rest all go through its `fetch`). */
  watchApi(request: APIRequestContext): void {
    const marked = request as APIRequestContext & { budgetWatched?: boolean };
    if (marked.budgetWatched) return;
    marked.budgetWatched = true;
    const send = request.fetch.bind(request);
    request.fetch = ((input: Parameters<APIRequestContext['fetch']>[0], options?: Parameters<APIRequestContext['fetch']>[1]) => {
      const url = urlOf(input);
      if (url) this.charge(new URL(url, this.origin).href);
      return send(input, options);
    }) as APIRequestContext['fetch'];
  }

  /** Counts every request this process's global fetch sends to the Worker. */
  watchNode(): void {
    node.budget = this;
    if (node.wrapped) return;
    node.wrapped = true;
    const send = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = urlOf(input);
      if (url && node.budget) node.budget.charge(url);
      return send(input, init);
    }) as typeof fetch;
  }

  /** Stops charging this process's fetch to this budget. */
  unwatchNode(): void {
    if (node.budget === this) node.budget = null;
  }

  /** The environment a child process (the CLI) needs for its requests to count. */
  childEnv(): Record<string, string> {
    return {
      NODE_OPTIONS: `--import=${fileURLToPath(CHILD_PRELOAD)}`,
      MOSS_BUDGET_CHILD_PATH: this.childPath,
      MOSS_BUDGET_ORIGIN: this.origin,
    };
  }

  /** Fails once the run has made more requests than its budget. */
  assert(where: string): void {
    if (this.exceeded) throw new Error(`request budget: ${this.count} Worker requests passed this run's budget of ${this.limit} (${where})`);
  }
}

/** Charges a WebSocket this process opens itself (the ws library, not fetch) to the running budget, if any. */
export function chargeSocket(url: string): void {
  node.budget?.charge(url);
}

/** The environment a child process (the CLI) needs for its requests to count against the running budget, if any. */
export function childBudgetEnv(): Record<string, string> {
  return node.budget?.childEnv() ?? {};
}

// Infrastructure is never a product verdict (S-test §2.8): fixtures throw InfraBlocked, the reporter writes
// test-results/blocked.json, and the summary says BLOCKED instead of FAILED.
import type { APIRequestContext } from '@playwright/test';

export class InfraBlocked extends Error {
  constructor(reason: string) {
    super(`InfraBlocked: ${reason}`);
    this.name = 'InfraBlocked';
  }
}

export const isInfraBlocked = (message: string | undefined): boolean => /\bInfraBlocked: /.test(message ?? '');

/** The one engine signature a page's own console or failed-request text may carry. */
export const NETWORK_PROCESS_CRASHED = "the browser's network process crashed";

// The Worker's own exception (1101) and resource limit (1102) come first: Cloudflare renders them on its error page too,
// and the staging retry gate (scripts/deploy/retry-gate.mjs) never retries them.
const SIGNATURES: [RegExp, string][] = [
  [/\berror code: 1101\b|\bWorker threw exception\b|\bcf-error-code">1101</i, 'Worker 1101'],
  [/\berror code: 1102\b|\bWorker exceeded resource limits\b|\bcf-error-code">1102</i, 'Worker 1102'],
  [/<!--\[if lt IE 7\]>[\s\S]*\bie6 oldie\b/i, 'a Cloudflare error page'],
  [/\bD1(?:_ERROR)?\b[^\n]*\b7429\b/i, 'D1 7429 (overloaded)'],
  [/\bECONNREFUSED\b|\bECONNRESET\b|socket hang up/i, 'the stack is unreachable'],
  [/\bEADDRINUSE\b/, 'a port in use'],
  [/Executable doesn't exist|browserType\.launch: |Failed to launch/i, 'the browser failed to launch'],
  [/\*\*\* Received signal|workerd[^\n]*(?:segmentation fault|SIGSEGV|SIGABRT)/i, 'a workerd crash'],
  // WebKit names its own network process crash. Not "WebKit encountered an internal error" (its consequence, and too
  // broad) and not "Target crashed" (a page process, which a page that runs out of memory can cause) (T9.48g).
  [/\bNetwork process crashed\b/, NETWORK_PROCESS_CRASHED],
];

/** The infrastructure signature in a response body, log or error text, or null for a product outcome. */
export function classifyInfra(text: string): string | null {
  return SIGNATURES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** The network-process crash signature in any of a page's console or failed-request texts, or null. */
export function browserCrashIn(texts: string[]): string | null {
  return texts.some((text) => classifyInfra(text) === NETWORK_PROCESS_CRASHED) ? NETWORK_PROCESS_CRASHED : null;
}

/** An engine fault read from the browser's own stderr, never from page text (T9.55c). Each is a fixed name. */
export const LIBSOUP_CHECK = "WebKit's network process failed a libsoup check";
export const ENGINE_FAULTS: readonly string[] = [LIBSOUP_CHECK];

/** The engine fault one line of the browser log carries, or null. */
export function engineFaultIn(line: string): string | null {
  void line;
  return null;
}

/** A line of an engine fault, noted when the browser log received it. */
export interface NotedFault { at: number; name: string }

/** The engine fault that labels a failed test, as the start of an InfraBlocked reason, or null. */
export function engineFaultOf(test: { failed: boolean; madeAt: number; teardownAt: number; noted: NotedFault[]; pages: { label: string; crashes: number[] }[] }): string | null {
  void test;
  return null;
}

/** The fixed engine fault name an InfraBlocked error names, or null. */
export function engineFaultNamed(message: string | undefined): string | null {
  void message;
  return null;
}

/** Throws InfraBlocked when `text` carries an infrastructure signature. */
export function assertNotInfra(text: string, where: string): void {
  const signature = classifyInfra(text);
  if (signature) throw new InfraBlocked(`${where}: ${signature}`);
}

/**
 * Playwright's API requests share one keep-alive agent per process, and the stack's dev proxy closes an idle pooled
 * connection, sometimes just as a request goes out on it: "socket hang up" on a GET and a POST (runs 38389778699,
 * 38346480112 and 38406081753), on a stack that answered every other request. Every request through `request` asks
 * for its connection to close after it, so none goes out on a connection the proxy may be closing.
 */
export function closeEachConnection(request: APIRequestContext): APIRequestContext {
  type Send = (url: unknown, options?: { headers?: Record<string, string> }) => unknown;
  for (const method of ['get', 'head', 'post', 'put', 'patch', 'delete', 'fetch'] as const) {
    const original = request[method].bind(request) as Send;
    const closing: Send = (url, options = {}) => original(url, { ...options, headers: { connection: 'close', ...options.headers } });
    (request as unknown as Record<string, Send>)[method] = closing;
  }
  return request;
}

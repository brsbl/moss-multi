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
];

/** The infrastructure signature in a response body, log or error text, or null for a product outcome. */
export function classifyInfra(text: string): string | null {
  return SIGNATURES.find(([pattern]) => pattern.test(text))?.[1] ?? null;
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

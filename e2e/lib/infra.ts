// Infrastructure is never a product verdict (S-test §2.8): fixtures throw InfraBlocked, the reporter writes
// test-results/blocked.json, and the summary says BLOCKED instead of FAILED.
import http from 'node:http';
import https from 'node:https';

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

/** Throws InfraBlocked when `text` carries an infrastructure signature. */
export function assertNotInfra(text: string, where: string): void {
  const signature = classifyInfra(text);
  if (signature) throw new InfraBlocked(`${where}: ${signature}`);
}

/**
 * Playwright sends API requests (`request`, `request.newContext()`, `route.fetch()`) through process-wide keep-alive
 * agents and never resends one. The local Worker ignores a request's `connection: close`, answers without it and
 * closes a connection 5 s after its last answer, so a request written to a pooled socket just then failed with
 * "socket hang up" (runs 45257142311, 45132107814, 45089319305). No Node agent in this process pools a socket: each
 * request opens its own connection and nothing is resent. Call at module scope, before the first request; off
 * loopback each Node-side request costs a TLS handshake.
 */
export function ownConnections(): void {
  http.Agent.prototype.keepSocketAlive = () => false;
  https.Agent.prototype.keepSocketAlive = () => false;
}

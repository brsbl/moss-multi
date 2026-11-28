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

/**
 * Engine faults read from the browser's own stderr, never from page text (T9.55c, g): page console text does not reach
 * it, and these patterns are not in SIGNATURES, which run over response bodies and error text a page can write. Each
 * is a fixed name, the only text of the fault a run summary prints. A line cannot be tied to one WebKit process by its
 * text (`pid=` is Playwright's launcher, `(process:N)` names no program), so only its text is matched.
 */
export const LIBSOUP_CHECK = "WebKit's network process failed a libsoup check";
export const GLIB_ABORT = "WebKit's page process aborted in GLib's main loop";
export const ENGINE_FAULTS: readonly string[] = [LIBSOUP_CHECK, GLIB_ABORT];

// A browser-log line: the time engine.ts kept it at (optional), then Playwright's mark for the browser's stderr.
const STDERR = String.raw`^(?:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z )?\[pid=\d+\]\[err\] `;
const ENGINE_LINES: [RegExp, string][] = [
  // WebKit bug 276819 quotes the queued form; the unqueued form was seen in the j09 reload leg's reproduction.
  [
    new RegExp(`${STDERR}(?:\\(process:\\d+\\): )?libsoup-CRITICAL \\*\\*: [\\d:.]+: soup_session_feature_request_(?:queued|unqueued): assertion 'SOUP_IS_SESSION_FEATURE \\(feature\\)' failed`),
    LIBSOUP_CHECK,
  ],
  // GLib's assertion on its loop's sorted descriptors, then abort(); the `[out] Bail out!` copy alone does not match.
  [new RegExp(`${STDERR}GLib:ERROR:[^\\s:]*gmain\\.c:\\d+:g_main_context_check_unlocked: assertion failed`), GLIB_ABORT],
];

/** The engine fault one line of the browser log carries, or null. */
export function engineFaultIn(line: string): string | null {
  return ENGINE_LINES.find(([pattern]) => pattern.test(line))?.[1] ?? null;
}

/** A line of an engine fault, noted when the browser log received it. */
export interface NotedFault { at: number; name: string }

/**
 * The engine fault that labels a failed WebKit test, as the start of an InfraBlocked reason, or null. `madeAt` is when
 * the test's Actors was made, `teardownAt` when its teardown began, `noted` the fault lines the worker's browsers
 * wrote. A libsoup line at or after `madeAt` labels the failure. The check keys on time, not on context: with two
 * people, a fault in one page's network labels a failure in the other's page; the job is red either way.
 *
 * GLib's abort labels it only with a crash of one person's page reported at or after a GLib line noted from `madeAt`
 * to before `teardownAt`: a page crash alone stays FAILED (a page that runs out of memory can be the product's doing,
 * T9.48g), as does the line alone, an earlier test's line, or a crash before the line. An export that fails with its
 * page alive has no crash, so it is never labelled.
 */
export function engineFaultOf(test: { failed: boolean; madeAt: number; teardownAt: number; noted: NotedFault[]; pages: { label: string; crashes: number[] }[] }): string | null {
  if (!test.failed) return null;
  const libsoup = test.noted.find((line) => line.name === LIBSOUP_CHECK && line.at >= test.madeAt);
  if (libsoup) return `${LIBSOUP_CHECK}: the browser's stderr carried it at ${new Date(libsoup.at).toISOString()}`;
  for (const line of test.noted) {
    if (line.name !== GLIB_ABORT || line.at < test.madeAt || line.at >= test.teardownAt) continue;
    for (const page of test.pages) {
      const crash = page.crashes.find((at) => at >= line.at);
      if (crash === undefined) continue;
      return `${GLIB_ABORT}: [${page.label}] the browser's stderr carried it at ${new Date(line.at).toISOString()}, and the page's crash was reported ${((crash - line.at) / 1000).toFixed(1)} s later`;
    }
  }
  return null;
}

/** The fixed engine fault name an InfraBlocked error starts with, or null. */
export function engineFaultNamed(message: string | undefined): string | null {
  const first = (message ?? '').split('\n')[0];
  return ENGINE_FAULTS.find((name) => first.includes(`InfraBlocked: ${name}: `)) ?? null;
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
 * request opens its own connection and nothing is resent. Called once, by playwright.config.ts, which every worker
 * loads before its first request; off loopback each Node-side request costs a TLS handshake.
 */
export function ownConnections(): void {
  http.Agent.prototype.keepSocketAlive = () => false;
  https.Agent.prototype.keepSocketAlive = () => false;
}

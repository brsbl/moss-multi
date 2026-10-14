// The staging retry gate (A§21, T8.2). A staging leg may run once more only when its failed attempt failed on named
// infrastructure classes alone: every error's first line matched explicitly below. A product assertion, an invariant
// (checked after the body, so it follows the body's error), a timeout or anything unnamed is never retried, even beside
// an infrastructure error: the retry attempt fails at once and the run fails. The run log
// (canary-reporter.mjs) writes each failed attempt's verdict where the retry reads it, and prints every retry.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g');

/** @type {[string, RegExp][]} The infrastructure classes a staging retry may follow, each matched on the first line of an error. */
export const INFRA_CLASSES = [
  // A fixture's own classification (e2e/lib/infra.ts): a Cloudflare error page, D1 7429, Worker 1101, an unreachable stack.
  ['infra-blocked', /\bInfraBlocked: /],
  ['connection reset', /\bnet::ERR_CONNECTION_(?:RESET|CLOSED|REFUSED|ABORTED)\b|\bECONNRESET\b|\bECONNREFUSED\b|\bsocket hang up\b/],
  ['network changed', /\bnet::ERR_(?:NETWORK_CHANGED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED)\b|\bEAI_AGAIN\b/],
];

/** @param {{ message?: string } | undefined} error */
const classOf = (error) => {
  const first = (error?.message ?? '').replace(ANSI, '').split('\n')[0];
  return INFRA_CLASSES.find(([, pattern]) => pattern.test(first))?.[0] ?? null;
};

/**
 * The named infrastructure class of a failed attempt (its first error's), or null when any of its errors is anything
 * else (never retried).
 * @param {{ message?: string }[] | undefined} errors the attempt's errors, first the one that failed it
 */
export function retryClass(errors) {
  if (!errors?.length) return null;
  const classes = errors.map(classOf);
  return classes.every((name) => name !== null) ? classes[0] : null;
}

/**
 * Where a failed attempt's verdict waits for its retry.
 * @param {string} outputDir
 * @param {string} testId
 * @param {number} retry
 */
export const verdictPath = (outputDir, testId, retry) => join(outputDir, '.retry-gate', `${testId}-${retry}.json`);

/**
 * Records a failed attempt's verdict (the run log, as each attempt ends).
 * @param {string} outputDir
 * @param {string} testId
 * @param {number} retry
 * @param {{ message?: string }[] | undefined} errors
 */
export function recordVerdict(outputDir, testId, retry, errors) {
  const path = verdictPath(outputDir, testId, retry);
  mkdirSync(join(outputDir, '.retry-gate'), { recursive: true });
  const infra = retryClass(errors);
  writeFileSync(path, JSON.stringify({ infra }));
  return infra;
}

/**
 * At the start of a retry: proceeds only when the previous attempt's recorded verdict names an infrastructure class,
 * and returns it; throws otherwise, so a product failure is never retried into a pass.
 * @param {{ retry: number, testId: string, project: { outputDir: string } }} info the retry's TestInfo
 * @param {number} [waitMs] how long to wait for the run log's verdict
 */
export async function gateRetry(info, waitMs = 10_000) {
  if (info.retry === 0) return null;
  const path = verdictPath(info.project.outputDir, info.testId, info.retry - 1);
  const deadline = Date.now() + waitMs;
  while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  if (!existsSync(path)) throw new Error(`retry refused: no verdict for attempt ${info.retry}, so it is not known to be infrastructure`);
  const { infra } = /** @type {{ infra: unknown }} */ (JSON.parse(readFileSync(path, 'utf8')));
  if (typeof infra !== 'string') {
    throw new Error(`retry refused: attempt ${info.retry} failed on a product assertion or invariant, and only infrastructure is retried`);
  }
  return infra;
}

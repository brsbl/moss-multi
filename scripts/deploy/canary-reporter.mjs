// The run log against a non-loopback target (e2e/playwright.config.ts; deploy-staging.yml's canary). That log is
// public, and a failed authenticated request's error carries Playwright's call log, cookie header included. So this
// prints each test's title, status and duration, and for a failure only where in the suite it failed and which
// invariants it broke; error text and test output are withheld. The JSON reporter keeps the detail on the runner,
// which nothing uploads.

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

// A stack frame in the suite's own source: `e2e/<dir>/<file>.ts:<line>`, nothing else of the frame.
const FRAME = /\/(e2e\/(?:journeys|lib)\/[\w.-]+\.ts):(\d+):\d+\)?$/;

// Fixed labels for what an error message says; only the label is printed.
const KINDS = [
  ['timeout', /\bTimeout \d+ms exceeded|Test timeout of/],
  ['expect', /\bexpect\(/],
  ['request', /\bapiRequestContext\.|fetch failed|socket hang up|ECONNRESET/],
  ['navigation', /\bpage\.goto:|net::ERR_/],
  ['auth', /\bsign-(?:in|up) for |: 429 /],
  ['infrastructure', /\bInfraBlocked\b|^infrastructure/i],
];

/**
 * A failure's credential-free trace: the suite source lines on each error's stack (at most four), fixed labels for the
 * kind of error, and the invariant numbers its message names (e2e/lib/actors.ts). No text of the error is printed.
 * @param {{ errors?: { message?: string, stack?: string }[] }} result
 */
export function failureTrace(result) {
  const lines = [];
  for (const error of result.errors ?? []) {
    const frames = (error.stack ?? '').split('\n').flatMap((line) => {
      const match = /^\s+at /.test(line) ? FRAME.exec(line) : null;
      return match ? [`${match[1]}:${match[2]}`] : [];
    });
    if (frames.length > 0) lines.push(`at ${[...new Set(frames)].slice(0, 4).join(' < ')}`);
    const kinds = KINDS.filter(([, pattern]) => pattern.test(error.message ?? '')).map(([kind]) => kind);
    if (kinds.length > 0) lines.push(`kind ${kinds.join(', ')}`);
    const invariants = [...new Set([...(error.message ?? '').matchAll(/\binvariant (\d)\b/g)].map((match) => match[1]))];
    if (invariants.length > 0) lines.push(`invariants ${invariants.join(', ')}`);
  }
  return lines;
}

export default class CanaryReporter {
  /** @type {Map<string, number>} */
  counts = new Map();

  printsToStdio() {
    return true;
  }

  /**
   * @param {unknown} _config
   * @param {{ allTests(): unknown[] }} suite
   */
  onBegin(_config, suite) {
    console.log(`Running ${suite.allTests().length} tests; error text and test output are withheld off loopback.`);
  }

  /**
   * @param {{ titlePath(): string[] }} test
   * @param {{ status: string, duration: number, errors?: { message?: string, stack?: string }[] }} result
   */
  onTestEnd(test, result) {
    this.counts.set(result.status, (this.counts.get(result.status) ?? 0) + 1);
    // titlePath: the root, the project, the file, describes and the test.
    console.log(`  ${result.status} ${test.titlePath().filter(Boolean).slice(1).join(' › ')} (${seconds(result.duration)})`);
    for (const line of failureTrace(result)) console.log(`      ${line}`);
  }

  onError() {
    console.error('A run-level error occurred; its text is withheld off loopback.');
  }

  /** @param {{ status: string, duration: number }} result */
  onEnd(result) {
    const counts = [...this.counts].map(([status, n]) => `${n} ${status}`).join(', ') || 'no tests';
    console.log(`${result.status}: ${counts} in ${seconds(result.duration)}`);
  }
}

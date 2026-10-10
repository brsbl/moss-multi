// The run log against a non-loopback target (e2e/playwright.config.ts; deploy-staging.yml's canary). That log is
// public, and a failed authenticated request's error carries Playwright's call log, cookie header included. So this
// prints each test's title, status and duration, and for a failure only fixed facts: where in the suite it failed, the
// kind of error, numeric expected and received values, and which invariants it broke; error text and test output are
// withheld. The JSON reporter keeps the detail on the runner, which nothing uploads.

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
  ['auth limit', /: 429 /],
  ['auth', /\bsign-(?:in|up) for /],
  ['infrastructure', /\bInfraBlocked\b|^infrastructure/i],
];

/**
 * A failure's credential-free trace: the suite source lines on each error's stack (at most four), fixed labels for the
 * kind of error, and the facts of its invariant findings. No text of the error is printed.
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
    const values = numericValues(error.message ?? '');
    if (values) lines.push(values);
    lines.push(...findingFacts(error.message ?? ''));
  }
  return lines;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, 'g');

/**
 * An assertion's expected and received values when both are plain numbers (a latency, a count), else null: a text
 * value can carry anything the page showed, so it is never printed.
 * @param {string} message
 */
export function numericValues(message) {
  message = message.replace(ANSI, '');
  const expected = /^Expected: {1,8}((?:[<>]=? )?-?\d{1,9}(?:\.\d{1,6})?)$/m.exec(message);
  const received = /^Received: {1,8}(-?\d{1,9}(?:\.\d{1,6})?)$/m.exec(message);
  return expected && received ? `expected ${expected[1]}, received ${received[1]}` : null;
}

/**
 * A console error's fixed class: a resource load failure with its status, a WebSocket failure, or nothing.
 * @param {string} detail
 */
const consoleKind = (detail) => {
  const load = /Failed to load resource: the server responded with a status of (\d{3})/.exec(detail);
  if (load) return ` (load ${load[1]})`;
  return /WebSocket/i.test(detail) ? ' (websocket)' : '';
};

/** A request path as its route: every segment that is not a short lowercase word (an id or a token) becomes `:id`. */
const route = (path) => path.split('/').map((segment) => (segment === '' || /^[a-z][a-z-]{0,19}$/.test(segment) ? segment : ':id')).join('/');

/**
 * The invariant findings in an e2e/lib/actors.ts failure, as fixed facts: the invariant, the actor's label, and for
 * invariants 1, 3 and 7 the HTTP status, method and route, the socket counts, or the field and counts. Never the text.
 * @param {string} message
 */
export function findingFacts(message) {
  const facts = [];
  for (const line of message.split('\n')) {
    const match = /^\s*invariant (\d) \[([\w-]{1,24})\] (.*)$/.exec(line);
    if (!match) continue;
    const [, n, actor, detail] = match;
    let fact = '';
    if (n === '1') {
      const http = /^HTTP (\d{3}) ([A-Z]{3,7}) (?:[a-z]+:\/\/[^/\s]+)?(\/[^\s?#]*)/.exec(detail);
      if (http) fact = `HTTP ${http[1]} ${http[2]} ${route(http[3])}`;
      else if (detail.startsWith('console error')) fact = `console error${consoleKind(detail)}`;
      else if (detail.startsWith('page error')) fact = 'page error';
    } else if (n === '3') {
      const sockets = /\b(\d{1,6}) socket opens in one document, (\d{1,6}) allowed/.exec(detail);
      if (sockets) fact = `${sockets[1]} socket opens, ${sockets[2]} allowed`;
      const ended = /\((\d{1,6}) errored; lived ((?:\d{1,9} ms(?: \(\d{4}\))?|open)(?:, (?:\d{1,9} ms(?: \(\d{4}\))?|open)){0,20})\)/.exec(detail);
      if (sockets && ended) fact += ` (${ended[1]} errored; lived ${ended[2]})`;
    } else if (n === '7') {
      const field = / (title|body): /.exec(detail)?.[1] ?? '';
      const counts = /appears (\d+) time\(s\), typed (\d+)/.exec(detail);
      if (counts) fact = `${field} appears ${counts[1]}, typed ${counts[2]}`;
      else fact = / still unbound after /.test(detail) ? `${field} still unbound` : `${field} out of order`;
    }
    facts.push(`invariant ${n} [${actor}]${fact ? ` ${fact}` : ''}`);
  }
  return [...new Set(facts)].slice(0, 8);
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

#!/usr/bin/env node
// What staging's Worker and Durable Objects did while a full suite ran (T8.2): deploy-staging.yml's tail job runs
// `wrangler tail --format json --status error` and reduces each event to counts under fixed names, so the public log
// and artifact never hold a URL, header, log line or error text (docs/DEPLOY.md). An isolate that passed its memory or
// CPU limit resets every Durable Object it hosts, so the minutes it happened are kept to set against the failures.
//   node scripts/deploy/tail-summary.mjs run OUT.json -- <command...>   (runs the tail; SIGTERM ends it and writes OUT)
//   node scripts/deploy/tail-summary.mjs probe OUT.json -- <command...> (the same for SP9's probe uploads)
//   node scripts/deploy/tail-summary.mjs check-probe OUT.json          (fails without the near-cap upload's telemetry)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Exception classes, by a fixed pattern on the message; the message itself is never kept. */
export const CLASSES = [
  ['memory limit', /exceeded its memory limit|memory limit exceeded/i],
  ['cpu limit', /exceeded (its )?cpu|cpu time limit/i],
  ['object reset', /durable object reset|was reset/i],
  ['object overloaded', /overloaded/i],
  ['storage timeout', /storage operation exceeded timeout/i],
  ['network lost', /network connection lost/i],
  ['internal error', /internal error/i],
];
const LIMIT_CLASSES = new Set(['memory limit', 'cpu limit']);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const OUTCOME = /^[A-Za-z]{1,30}$/;
const METHOD = /^[A-Z]{3,7}$/;
/** Route families only: ids, tokens and query strings never reach the summary. */
const ROUTE = /^\/(api|parties)\/([a-z][a-z-]{0,29})(?=\/|$)/;

const bump = (record, key) => {
  record[key] = (record[key] ?? 0) + 1;
};

/** @param {unknown} url */
function routeOf(url) {
  try {
    const match = ROUTE.exec(new URL(String(url)).pathname);
    return match ? `/${match[1]}/${match[2]}` : 'other';
  } catch {
    return 'other';
  }
}

/** wrangler prints each event as JSON.stringify(event, null, 4): `{` and `}` alone on their lines open and close it. */
class EventStream {
  #buffer = '';
  #object = /** @type {string[] | null} */ (null);
  #onEvent;
  unparsed = 0;

  /** @param {(event: any) => void} onEvent */
  constructor(onEvent) {
    this.#onEvent = onEvent;
  }

  /** @param {string} chunk wrangler's stdout, in any split */
  push(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      this.#line(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
    }
  }

  /** @param {string} line */
  #line(line) {
    if (this.#object === null) {
      if (line === '{') this.#object = [line];
      return;
    }
    this.#object.push(line);
    if (line !== '}') return;
    const text = this.#object.join('\n');
    this.#object = null;
    let event;
    try {
      event = JSON.parse(text);
    } catch {
      this.unparsed += 1;
      return;
    }
    this.#onEvent(event);
  }
}

export class TailSummary {
  #stream = new EventStream((event) => this.#event(event));
  events = 0;
  overload = 0;
  /** @type {Record<string, number>} */
  outcomes = {};
  /** @type {Record<string, number>} */
  classes = {};
  /** @type {Record<string, number>} */
  limitMinutes = {};

  /** @param {string} chunk wrangler's stdout, in any split */
  push(chunk) {
    this.#stream.push(chunk);
  }

  get unparsed() {
    return this.#stream.unparsed;
  }

  /** @param {any} event */
  #event(event) {
    if (event?.event?.type === 'overload') {
      this.overload += 1;
      return;
    }
    if (typeof event?.outcome !== 'string') return;
    this.events += 1;
    const outcome = OUTCOME.test(event.outcome) ? event.outcome : 'other';
    let source;
    if (event.event && typeof event.event === 'object' && 'request' in event.event) {
      const method = String(event.event.request?.method ?? '').toUpperCase();
      source = `worker ${METHOD.test(method) ? method : 'other'} ${routeOf(event.event.request?.url)}`;
    } else {
      const entrypoint = typeof event.entrypoint === 'string' && NAME.test(event.entrypoint) ? event.entrypoint : 'other';
      const method = typeof event.event?.rpcMethod === 'string' && NAME.test(event.event.rpcMethod) ? event.event.rpcMethod : 'other';
      source = `${entrypoint}.${method}`;
    }
    bump(this.outcomes, `${source} ${outcome}`);
    const minute = Number.isFinite(event.eventTimestamp) ? `${new Date(event.eventTimestamp).toISOString().slice(0, 16)}Z` : 'unknown';
    let limited = outcome === 'exceededMemory' || outcome === 'exceededCpu';
    for (const exception of Array.isArray(event.exceptions) ? event.exceptions : []) {
      const message = String(exception?.message ?? '');
      const found = CLASSES.find(([, pattern]) => pattern.test(message));
      const name = found ? found[0] : 'unclassed';
      bump(this.classes, name);
      if (LIMIT_CLASSES.has(name)) limited = true;
    }
    if (limited) bump(this.limitMinutes, minute);
  }

  result() {
    return {
      events: this.events,
      overload: this.overload,
      unparsed: this.unparsed,
      outcomes: this.outcomes,
      classes: this.classes,
      limitMinutes: this.limitMinutes,
    };
  }
}

/**
 * The header j11-media's SP9 near-cap probe sends on each upload, its value the upload's label. A second tail filters
 * on it (`--header`), so it sees every probe upload, not only the failures.
 */
export const SP9_PROBE_HEADER = 'x-sp9-probe';
const PROBE_LABELS = new Set(['near-cap', 'truncated']);

/** @param {unknown} value a millisecond count from the event, or null when it carries none */
const ms = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/**
 * SP9's Worker telemetry (T8.2): for each probe upload, the invocation's outcome, response status, CPU time and wall
 * time as the tail reports them (TraceItem `cpuTime`, `wallTime`). Cloudflare reports no per-invocation memory
 * figure; its memory telemetry is the outcome, `exceededMemory` when the isolate passed its limit, kept as
 * `withinMemoryLimit`. Labels outside the probe's are `other`; no URL, header value or text is kept.
 */
export class ProbeSummary {
  /** @type {Record<string, { outcome: string, status: number | null, cpuTimeMs: number | null, wallTimeMs: number | null, withinMemoryLimit: boolean, exceptions: Record<string, number> }[]>} */
  uploads = {};
  #stream = new EventStream((event) => this.#event(event));

  /** @param {string} chunk */
  push(chunk) {
    this.#stream.push(chunk);
  }

  /** @param {any} event */
  #event(event) {
    if (typeof event?.outcome !== 'string') return;
    const headers = event.event?.request?.headers;
    if (!headers || typeof headers !== 'object') return;
    const key = Object.keys(headers).find((name) => name.toLowerCase() === SP9_PROBE_HEADER);
    if (key === undefined) return;
    const value = String(headers[key]);
    const label = PROBE_LABELS.has(value) ? value : 'other';
    const outcome = OUTCOME.test(event.outcome) ? event.outcome : 'other';
    /** @type {Record<string, number>} */
    const exceptions = {};
    let memory = outcome === 'exceededMemory';
    for (const exception of Array.isArray(event.exceptions) ? event.exceptions : []) {
      const found = CLASSES.find(([, pattern]) => pattern.test(String(exception?.message ?? '')));
      const name = found ? found[0] : 'unclassed';
      bump(exceptions, name);
      if (name === 'memory limit') memory = true;
    }
    const status = event.event?.response?.status;
    (this.uploads[label] ??= []).push({
      outcome,
      status: Number.isInteger(status) ? status : null,
      cpuTimeMs: ms(event.cpuTime),
      wallTimeMs: ms(event.wallTime),
      withinMemoryLimit: !memory,
      exceptions,
    });
  }

  result() {
    return { uploads: this.uploads, unparsed: this.#stream.unparsed };
  }
}

/**
 * What is wrong with SP9's telemetry: the near-cap upload must have a tail event, `ok`, a 201, within the memory
 * limit and timed; the truncated upload, the probe's red control, must have an event too.
 * @param {{ uploads?: Record<string, { outcome: string, status: number | null, cpuTimeMs: number | null, wallTimeMs: number | null, withinMemoryLimit: boolean }[]> }} result
 */
export function probeProblems(result) {
  const problems = [];
  const uploads = result?.uploads ?? {};
  const near = uploads['near-cap'] ?? [];
  if (near.length === 0) problems.push('no tail event for the near-cap upload');
  for (const upload of near) {
    if (upload.outcome !== 'ok') problems.push(`the near-cap upload ended ${upload.outcome}`);
    if (!upload.withinMemoryLimit) problems.push('the near-cap upload passed the memory limit');
    if (upload.status !== 201) problems.push(`the near-cap upload returned ${upload.status ?? 'no status'}`);
    if (upload.cpuTimeMs === null) problems.push('the near-cap upload has no CPU time');
    if (upload.wallTimeMs === null) problems.push('the near-cap upload has no wall time');
  }
  if ((uploads.truncated ?? []).length === 0) problems.push('no tail event for the truncated upload');
  return problems;
}

/**
 * Runs `command` (the tail) and summarizes its stdout until it exits or this process gets SIGTERM or SIGINT, then
 * writes the summary to `out`. Its stderr is counted, never printed.
 * @param {string} out
 * @param {string[]} command
 * @param {{ push(chunk: string): void, result(): object }} summary
 */
export function runTail(out, command, summary = new TailSummary()) {
  let stderrLines = 0;
  const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8').on('data', (chunk) => summary.push(chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderrLines += chunk.split('\n').length - 1;
  });
  let done = false;
  const finish = (exit) => {
    if (done) return;
    done = true;
    writeFileSync(out, `${JSON.stringify({ ...summary.result(), tailExit: exit, tailStderrLines: stderrLines }, null, 2)}\n`);
  };
  const stop = () => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  child.on('exit', (code, signal) => finish(signal ? 'stopped' : String(code)));
  child.on('error', () => finish('failed to start'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, out, dashes, ...command] = process.argv.slice(2);
  if ((mode === 'run' || mode === 'probe') && out && dashes === '--' && command.length > 0) {
    runTail(out, command, mode === 'probe' ? new ProbeSummary() : new TailSummary());
  } else if (mode === 'check-probe' && out && dashes === undefined) {
    let problems;
    try {
      problems = probeProblems(JSON.parse(readFileSync(out, 'utf8')));
    } catch {
      problems = [`no probe summary at ${out}`];
    }
    for (const problem of problems) console.error(`::error::SP9 telemetry: ${problem}`);
    process.exitCode = problems.length ? 1 : 0;
  } else {
    console.error('usage: tail-summary.mjs run|probe OUT.json -- <command...> | check-probe OUT.json');
    process.exitCode = 1;
  }
}

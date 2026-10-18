#!/usr/bin/env node
// What staging's Worker and Durable Objects did while a full suite ran (T8.2): deploy-staging.yml's tail job runs
// `wrangler tail --format json --status error` and reduces each event to counts under fixed names, so the public log
// and artifact never hold a URL, header, log line or error text (docs/DEPLOY.md). An isolate that passed its memory or
// CPU limit resets every Durable Object it hosts, so the minutes it happened are kept to set against the failures.
//   node scripts/deploy/tail-summary.mjs run OUT.json -- <command...>   (runs the tail; SIGTERM ends it and writes OUT)
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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

export class TailSummary {
  #buffer = '';
  #object = /** @type {string[] | null} */ (null);
  events = 0;
  overload = 0;
  unparsed = 0;
  /** @type {Record<string, number>} */
  outcomes = {};
  /** @type {Record<string, number>} */
  classes = {};
  /** @type {Record<string, number>} */
  limitMinutes = {};

  /** @param {string} chunk wrangler's stdout, in any split */
  push(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf('\n')) !== -1) {
      this.#line(this.#buffer.slice(0, newline));
      this.#buffer = this.#buffer.slice(newline + 1);
    }
  }

  // wrangler prints each event as JSON.stringify(event, null, 4): `{` and `}` alone on their lines open and close it.
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
    this.#event(event);
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

// Red-first stubs (T8.2 SP9 telemetry); the implementation follows.
export const SP9_PROBE_HEADER = 'x-sp9-probe';
export class ProbeSummary {
  /** @param {string} _chunk */
  push(_chunk) {}
  result() {
    return { uploads: {} };
  }
}
/** @param {unknown} _result */
export function probeProblems(_result) {
  return /** @type {string[]} */ ([]);
}

/**
 * Runs `command` (the tail) and summarizes its stdout until it exits or this process gets SIGTERM or SIGINT, then
 * writes the summary to `out`. Its stderr is counted, never printed.
 * @param {string} out
 * @param {string[]} command
 */
export function runTail(out, command) {
  const summary = new TailSummary();
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
  if (mode === 'run' && out && dashes === '--' && command.length > 0) {
    runTail(out, command);
  } else {
    console.error('usage: tail-summary.mjs run OUT.json -- <command...>');
    process.exitCode = 1;
  }
}

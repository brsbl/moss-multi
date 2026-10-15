// T8.2: what the Worker and its Durable Objects did while the staging suite ran, from `wrangler tail`, reduced to
// counts and fixed class names so the public log and artifact never hold a URL, header, log line or error text.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { TailSummary } from './tail-summary.mjs';

const WORKFLOW = yaml.load(readFileSync(new URL('../../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8'));
const AT = Date.UTC(2026, 9, 14, 23, 54, 29);
const SECRET_URL = 'https://moss-multi-staging.secret-subdomain.workers.dev/api/docs?token=abc';

/** One event as `wrangler tail --format json` prints it: pretty JSON, 4-space indent, one object after another. */
const printed = (event) => `${JSON.stringify(event, null, 4)}\n`;

const docCreateOom = {
  outcome: 'exceededMemory',
  scriptName: 'moss-multi-staging',
  entrypoint: 'DocDO',
  event: { rpcMethod: 'create' },
  eventTimestamp: AT,
  logs: [{ message: ['secret log text ' + SECRET_URL], level: 'error', timestamp: AT }],
  exceptions: [{ name: 'Error', message: "Durable Object's isolate exceeded its memory limit and was reset.", timestamp: AT }],
};
const workerException = {
  outcome: 'exception',
  scriptName: 'moss-multi-staging',
  event: { request: { url: SECRET_URL, method: 'POST', headers: { cookie: 'session=secret' } }, response: { status: 500 } },
  eventTimestamp: AT + 61_000,
  logs: [],
  exceptions: [{ name: 'Error', message: 'Network connection lost. secret ' + SECRET_URL, timestamp: AT + 61_000 }],
};
const weird = {
  outcome: 'exception',
  entrypoint: 'Doc DO; rm -rf',
  event: { rpcMethod: 'x'.repeat(200) },
  eventTimestamp: AT,
  exceptions: [{ name: 'Error', message: 'something nobody classed ' + SECRET_URL }],
};

describe('the staging tail summary (T8.2) @p:R15', () => {
  it('counts error outcomes by entrypoint and method, classes exceptions by fixed patterns, and keeps no text', () => {
    const summary = new TailSummary();
    // A banner line before the first event, and an event split across chunks, as a pipe delivers it.
    const stream = `Connected to moss-multi-staging, waiting for logs...\n${printed(docCreateOom)}${printed(workerException)}${printed(weird)}`;
    for (let at = 0; at < stream.length; at += 37) summary.push(stream.slice(at, at + 37));
    const result = summary.result();
    expect(result.events).toBe(3);
    expect(result.outcomes).toEqual({
      'DocDO.create exceededMemory': 1,
      'worker POST /api/docs exception': 1,
      'other.other exception': 1,
    });
    expect(result.classes).toEqual({ 'memory limit': 1, 'network lost': 1, unclassed: 1 });
    // The minutes (UTC) a memory or CPU limit reset an isolate, to set against the suite's failures.
    expect(result.limitMinutes).toEqual({ '2026-10-14T23:54Z': 1 });
    const text = JSON.stringify(result);
    for (const secret of ['secret', 'workers.dev', 'token', 'cookie', 'rm -rf', 'nobody']) expect(text, secret).not.toContain(secret);
  });

  it('counts a tail overload notice and a line it cannot parse, and never throws on them', () => {
    const summary = new TailSummary();
    summary.push(printed({ event: { type: 'overload', message: 'Tail is currently in sampling mode' } }));
    summary.push('{\n    "outcome": "exception",\n    broken\n}\n');
    expect(summary.result()).toMatchObject({ events: 0, overload: 1, unparsed: 1 });
  });

  it('tails staging beside the suite, prints and uploads only the summary', () => {
    const job = WORKFLOW.jobs.tail;
    expect(job, 'a tail job').toBeDefined();
    expect(job.if).toMatch(/inputs\.suite == 'full'/);
    expect(job.needs).toEqual(expect.arrayContaining(['deploy']));
    expect(job.needs).not.toContain('suite');
    const run = job.steps.map((step) => step.run ?? '').join('\n');
    expect(run).toMatch(/tail-summary\.mjs run/);
    expect(run).toMatch(/--status error/);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.with.path.trim()).toMatch(/tail-summary\.json$/);
  });
});

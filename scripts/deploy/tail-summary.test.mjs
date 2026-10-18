// T8.2: what the Worker and its Durable Objects did while the staging suite ran, from `wrangler tail`, reduced to
// counts and fixed class names so the public log and artifact never hold a URL, header, log line or error text.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { probeProblems, ProbeSummary, SP9_PROBE_HEADER, TailSummary } from './tail-summary.mjs';

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

  it('times the SP9 uploads by their probe header: outcome, status, CPU and wall time, and no text', () => {
    const upload = (label, extra) => ({
      outcome: 'ok',
      scriptName: 'moss-multi-staging',
      event: { request: { url: `${SECRET_URL}&filename=${label}.webm`, method: 'POST', headers: { [SP9_PROBE_HEADER]: label, cookie: 'session=secret' } }, response: { status: 201 } },
      eventTimestamp: AT,
      logs: [{ message: ['secret ' + SECRET_URL], level: 'log', timestamp: AT }],
      exceptions: [],
      cpuTime: 41,
      wallTime: 23_118,
      ...extra,
    });
    const summary = new ProbeSummary();
    const stream = `Connected...\n${printed(upload('truncated', { cpuTime: 39, wallTime: 22_005 }))}${printed(upload('near-cap'))}${printed(upload('a-label-nobody-set'))}`;
    for (let at = 0; at < stream.length; at += 53) summary.push(stream.slice(at, at + 53));
    const result = summary.result();
    expect(result.uploads).toEqual({
      truncated: [{ outcome: 'ok', status: 201, cpuTimeMs: 39, wallTimeMs: 22_005, withinMemoryLimit: true, exceptions: {} }],
      'near-cap': [{ outcome: 'ok', status: 201, cpuTimeMs: 41, wallTimeMs: 23_118, withinMemoryLimit: true, exceptions: {} }],
      other: [{ outcome: 'ok', status: 201, cpuTimeMs: 41, wallTimeMs: 23_118, withinMemoryLimit: true, exceptions: {} }],
    });
    expect(probeProblems(result)).toEqual([]);
    const text = JSON.stringify(result);
    for (const secret of ['secret', 'workers.dev', 'token', 'cookie', 'nobody']) expect(text, secret).not.toContain(secret);
  });

  it('fails the SP9 telemetry when the near-cap upload is missing, past a limit, untimed or refused', () => {
    const timed = { outcome: 'ok', status: 201, cpuTimeMs: 41, wallTimeMs: 23_118, withinMemoryLimit: true, exceptions: {} };
    const result = (nearCap) => ({ uploads: { truncated: [timed], ...(nearCap ? { 'near-cap': [nearCap] } : {}) } });
    expect(probeProblems(result(timed))).toEqual([]);
    expect(probeProblems(result(null)), 'no event').toEqual(['no tail event for the near-cap upload']);
    expect(probeProblems({ uploads: { 'near-cap': [timed] } }), 'no red control').toEqual(['no tail event for the truncated upload']);
    expect(probeProblems(result({ ...timed, outcome: 'exceededMemory', withinMemoryLimit: false })), 'memory').toEqual(['the near-cap upload ended exceededMemory', 'the near-cap upload passed the memory limit']);
    expect(probeProblems(result({ ...timed, wallTimeMs: null })), 'untimed').toEqual(['the near-cap upload has no wall time']);
    expect(probeProblems(result({ ...timed, status: 503 })), 'refused').toEqual(['the near-cap upload returned 503']);
  });

  it('a probe event without CPU or wall time records null, never a guess', () => {
    const summary = new ProbeSummary();
    summary.push(printed({ outcome: 'exceededMemory', event: { request: { method: 'POST', url: SECRET_URL, headers: { [SP9_PROBE_HEADER]: 'near-cap' } } }, exceptions: [{ message: 'Worker exceeded its memory limit' }] }));
    expect(summary.result().uploads['near-cap']).toEqual([{ outcome: 'exceededMemory', status: null, cpuTimeMs: null, wallTimeMs: null, withinMemoryLimit: false, exceptions: { 'memory limit': 1 } }]);
  });

  it('tails the SP9 uploads apart from the errors, and fails the job on missing telemetry or a tail that ended early', () => {
    const job = WORKFLOW.jobs.tail;
    const run = job.steps.map((step) => step.run ?? '').join('\n');
    expect(run).toMatch(new RegExp(`tail-summary\\.mjs probe [^\\n]*--header ${SP9_PROBE_HEADER}`));
    expect(run).toMatch(/tail-summary\.mjs check-probe/);
    // It runs until every shard finished, however long the shards take at suite_parallel, never to a fixed deadline.
    expect(run).not.toMatch(/110 \* 60/);
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(340);
    expect(run, 'a tail that exits before the suite finished fails the job').toMatch(/::error::the (error|probe) tail ended before the suite finished/);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.with.path.trim().split('\n').map((line) => line.trim()).sort()).toEqual(['e2e/canary-artifacts/sp9-probe.json', 'e2e/canary-artifacts/tail-summary.json']);
  });

  it('the near-cap probe labels its uploads with the header the tail filters on', () => {
    const spec = readFileSync(new URL('../../e2e/journeys/j11-media.spec.ts', import.meta.url), 'utf8');
    expect(spec).toMatch(new RegExp(`'${SP9_PROBE_HEADER}': label`));
    expect(spec).toMatch(/nearCapProbe\(ada, docId, 'truncated'/);
    expect(spec).toMatch(/nearCapProbe\(ada, docId, 'near-cap'/);
  });
});

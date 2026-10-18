// T8.2: what the Worker and its Durable Objects did while the staging suite ran, from `wrangler tail`, reduced to
// counts and fixed class names so the public log and artifact never hold a URL, header, log line or error text.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { probeProblems, ProbeSummary, runTail, SP9_PROBE_HEADER, TailSummary } from './tail-summary.mjs';

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

  it('unfiltered, counts only failures: an ok 2xx-4xx is not one; an ok 5xx, an exception and a limit are', () => {
    const summary = new TailSummary();
    const fetch = (outcome, status) => printed({ outcome, event: { request: { url: SECRET_URL, method: 'GET' }, response: { status } }, eventTimestamp: AT, exceptions: [] });
    summary.push(fetch('ok', 200) + fetch('ok', 304) + fetch('ok', 404) + fetch('ok', 503) + fetch('exception', 500) + printed(docCreateOom));
    summary.push(printed({ outcome: 'ok', entrypoint: 'DocDO', event: { rpcMethod: 'pull' }, exceptions: [] }));
    expect(summary.result()).toMatchObject({
      events: 3,
      outcomes: { 'worker GET /api/docs ok': 1, 'worker GET /api/docs exception': 1, 'DocDO.create exceededMemory': 1 },
    });
  });

  it('restarts a tail that ends on its own, keeps summing, and counts the restarts', async () => {
    // wrangler's tail ended about two hours into run 39145040057's five-hour suite, with exit 0.
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    try {
      const out = join(dir, 'tail-summary.json');
      const script = `process.stdout.write(${JSON.stringify(printed(docCreateOom))})`;
      await runTail([[out, new TailSummary()]], [process.execPath, '-e', script], { maxRestarts: 2, restartDelayMs: 0 });
      expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ events: 3, tailRestarts: 2, tailExit: '0' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(run).toMatch(/tail-summary\.mjs run "\$out" -- /);
    // One unfiltered tail: a second, header-filtered tail left the error tail seeing only the probe's two uploads
    // (runs 39116654098 and 39130102453), as though one tail's filter applied to both.
    expect(run.match(/"\$WRANGLER" tail/g)?.length ?? 0, 'one tail').toBe(1);
    expect(run).not.toMatch(/--status|--header|--method|--search/);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.with.path).toMatch(/tail-summary\.json/);
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

  it('the tail job runs one unfiltered tail until every shard finished, and fails when it ends first', () => {
    const job = WORKFLOW.jobs.tail;
    const run = job.steps.map((step) => step.run ?? '').join('\n');
    // It runs until every shard finished, however long the shards take at suite_parallel, never to a fixed deadline.
    expect(run).not.toMatch(/110 \* 60/);
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(340);
    expect(run, 'a tail that exits before the suite finished fails the job').toMatch(/::error::the tail ended before the suite finished/);
    expect(run).toMatch(/kill -0 "\$pid"/);
    const upload = job.steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.with.path.trim()).toBe('e2e/canary-artifacts/tail-summary.json');
  });

  it("SP9's telemetry comes from a header-filtered tail in its own job, which no other tail overlaps", () => {
    // Unfiltered, the tail sampled the near-cap upload away (run 39145040057); beside a filtered tail, an unfiltered
    // one saw only the filtered one's events (runs 39116654098, 39130102453). So the probe runs alone, first.
    const { sp9, tail, suite } = WORKFLOW.jobs;
    expect(sp9, 'an sp9 job').toBeDefined();
    expect(sp9.if).toMatch(/inputs\.suite == 'full'/);
    expect(sp9.needs).toEqual(expect.arrayContaining(['deploy', 'canary']));
    expect(tail.needs, 'the error tail starts after it').toContain('sp9');
    expect(suite.needs, 'the suite starts after it').toContain('sp9');
    const steps = sp9.steps;
    const run = steps.map((step) => step.run ?? '').join('\n');
    expect(run).toMatch(new RegExp(`tail-summary\\.mjs probe "\\$probe" -- node "\\$WRANGLER" tail moss-multi-staging --format json --header ${SP9_PROBE_HEADER}`));
    expect(run).toMatch(/--project=staging-chromium[^\n]*--grep "SP9 near-cap probe"/);
    expect(run).toMatch(/tail-summary\.mjs check-probe "\$probe"/);
    // The Cloudflare token reaches only the step that starts the tail, never the journeys.
    for (const step of steps) {
      const env = JSON.stringify(step.env ?? {});
      if (/CLOUDFLARE_API_TOKEN/.test(env)) expect(step.run, step.name).toMatch(/tail-summary\.mjs probe/);
    }
    expect(JSON.stringify(sp9.env ?? {})).not.toMatch(/CLOUDFLARE/);
    // The suite does not upload the 95 MiB file a second time.
    const suiteRun = suite.steps.map((step) => step.run ?? '').join('\n');
    expect(suiteRun).toMatch(/--grep-invert "SP9 near-cap probe"/);
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact'));
    expect(upload.with.path.trim().split('\n').map((line) => line.trim()).sort()).toEqual(['e2e/canary-artifacts/sp9-probe.json', 'e2e/canary-artifacts/summary.json']);
  });

  it('the near-cap probe labels its uploads with the header the tail filters on', () => {
    const spec = readFileSync(new URL('../../e2e/journeys/j11-media.spec.ts', import.meta.url), 'utf8');
    expect(spec).toMatch(new RegExp(`'${SP9_PROBE_HEADER}': label`));
    expect(spec).toMatch(/nearCapProbe\(ada, docId, 'truncated'/);
    expect(spec).toMatch(/nearCapProbe\(ada, docId, 'near-cap'/);
  });
});

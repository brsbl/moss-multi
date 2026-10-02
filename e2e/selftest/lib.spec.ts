// The rest of e2e/lib proven able to fail: exact-bytes helpers, the allowlist expiry, the principal guard
// (invariant 8), the hibernation proof, infra classification, phase-clock budgets and percentiles, the shard guard,
// the sever and the UI verbs.
import { ALLOWLIST, expiredEntries, isAllowed, type AllowEntry } from '../lib/allowlist.ts';
import { inductionProblems } from '../lib/hibernate.ts';
import { classifyInfra, InfraBlocked, isInfraBlocked } from '../lib/infra.ts';
import { budgetProblem, latencyRows, Measure, percentile } from '../lib/measure.ts';
import { assertTestEmail, parseSetCookie, principalProblems } from '../lib/principals.ts';
import MossReporter, { emptyShardProblem } from '../lib/reporter.ts';
import { makeSeverable } from '../lib/sever.ts';
import { typedProblems, type Typed } from '../lib/text.ts';
import * as ui from '../lib/ui.ts';
import { expect, test } from './fixtures.ts';

const typed = (text: string, author = 'ada', ordered = true): Typed => ({ docId: 'd', field: 'body', text, author, ordered });

test.describe('exact bytes (invariant 7)', () => {
  test('a string typed once and in order passes', () => {
    expect(typedProblems('Hello, wörld… é! then more', [typed('Hello, wörld… é!'), typed('more')])).toEqual([]);
  });
  test('a missing, reordered or duplicated string fails', () => {
    expect(typedProblems('Helo', [typed('Hello')])).not.toEqual([]);
    expect(typedProblems('lolhe', [typed('hello')])).not.toEqual([]);
    expect(typedProblems('WORDWORD', [typed('WORD')])).not.toEqual([]);
  });
  test("one author's strings keep their order; another author's may interleave", () => {
    expect(typedProblems('two one', [typed('one'), typed('two')])).not.toEqual([]);
    expect(typedProblems('two one', [typed('one'), typed('two', 'ben')])).toEqual([]);
    expect(typedProblems('two one', [typed('one', 'ada', false), typed('two', 'ada', false)])).toEqual([]);
  });
});

test.describe('console allowlist', () => {
  const entry = (expires: string): AllowEntry => ({ pattern: /benign/, reason: 'selftest', ruling: 'T0.9a', scope: ['j00-shell'], expires });
  test('no live entry has expired', () => {
    expect(expiredEntries(ALLOWLIST)).toEqual([]);
  });
  test('an entry past its day is expired and stops allowing', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    expect(expiredEntries([entry('2026-10-01')], now)).toHaveLength(1);
    expect(expiredEntries([entry('2026-10-02')], now)).toEqual([]);
    expect(isAllowed('a benign line', 'j00-shell', [entry('2026-10-02')], now)).toBe(true);
    expect(isAllowed('a benign line', 'j00-shell', [entry('2026-10-01')], now)).toBe(false);
    expect(isAllowed('a benign line', 'j01-coedit', [entry('2026-10-02')], now)).toBe(false);
  });
});

test.describe('principals (invariant 8)', () => {
  const ada = { id: 'u1', email: 'mm-run-ada-1@example.invalid' };
  const ben = { id: 'u2', email: 'mm-run-ben-2@example.invalid' };
  test('two distinct @example.invalid principals pass', () => {
    expect(principalProblems([ada, ben], null)).toEqual([]);
  });
  test('one principal, one id twice, or a real address fails', () => {
    expect(principalProblems([ada], null)).not.toEqual([]);
    expect(principalProblems([ada, { ...ben, id: 'u1' }], null)).not.toEqual([]);
    expect(principalProblems([ada, { ...ben, email: 'someone@gmail.com' }], null)).not.toEqual([]);
  });
  test('solo needs a reason and still refuses real addresses', () => {
    expect(principalProblems([ada], 'one person in two windows')).toEqual([]);
    expect(principalProblems([ada], '')).not.toEqual([]);
    expect(principalProblems([{ ...ada, email: 'owner@example.com' }], 'reason')).not.toEqual([]);
  });
  test('minting refuses any address outside @example.invalid', () => {
    expect(() => assertTestEmail('owner@example.com')).toThrow(/example\.invalid/);
    expect(() => assertTestEmail('mm-x@example.invalid')).not.toThrow();
  });
  test('a session cookie keeps its flags', () => {
    expect(parseSetCookie('better-auth.session_token=abc.def; Path=/; HttpOnly; SameSite=Lax', 'http://127.0.0.1:8850')).toEqual({
      name: 'better-auth.session_token', value: 'abc.def', url: 'http://127.0.0.1:8850', httpOnly: true, secure: false, sameSite: 'Lax',
    });
  });
});

test.describe('hibernation proof', () => {
  const base = { instanceId: 'a', constructedAt: 1_000 };
  test('a new instance built by the decisive action is induced', () => {
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 100_500 }, 100_000)).toEqual([]);
  });
  test('the same instance, an older one, or one built long after the action is not', () => {
    expect(inductionProblems(base, base, 100_000)).not.toEqual([]);
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 500 }, 100_000)).not.toEqual([]);
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 110_000 }, 100_000)).not.toEqual([]);
  });
});

test.describe('infrastructure classification', () => {
  test('Cloudflare pages, D1 7429, Worker 1101 and dead stacks are infrastructure', () => {
    expect(classifyInfra('<!DOCTYPE html><!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> cloudflare')).not.toBeNull();
    expect(classifyInfra('D1_ERROR: Too many requests queued (7429)')).not.toBeNull();
    expect(classifyInfra('error code: 1101')).not.toBeNull();
    expect(classifyInfra('fetch failed: connect ECONNREFUSED 127.0.0.1:8850')).not.toBeNull();
  });
  test('product answers are not', () => {
    expect(classifyInfra('{"error":"not-found"}')).toBeNull();
    expect(classifyInfra('expected "hello" to be "hlelo"')).toBeNull();
  });
  test('InfraBlocked is recognizable in a reported error', () => {
    expect(isInfraBlocked(new InfraBlocked('stack died').message)).toBe(true);
    expect(isInfraBlocked('expect(received).toBe(expected)')).toBe(false);
  });
});

test.describe('phase clocks', () => {
  test('a latency over its budget fails', () => {
    expect(budgetProblem({ name: 'peer-text', ms: 2_400, budgetMs: 2_000 })).toMatch(/peer-text/);
    expect(budgetProblem({ name: 'peer-text', ms: 400, budgetMs: 2_000 })).toBeNull();
    expect(() => new Measure(test.info()).record({ name: 'title', ms: 6_000, budgetMs: 5_000 })).toThrow(/title/);
  });
  test('the clock starts after the click returns and measures the bind', async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'clock' });
    await ui.waitLive(actor, 'doc-a');
    const measure = new Measure(test.info());
    await actor.page.getByRole('button', { name: 'Create new note' }).click();
    const ms = await measure.until('bind', () => actor.page.locator('[data-doc-state="live"]').isVisible(), { budgetMs: 5_000 });
    expect(ms).toBeGreaterThanOrEqual(200);
  });
});

test.describe('percentiles (the p95 headroom table)', () => {
  test('nearest-rank percentiles', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });
  test('rows per latency and engine, with headroom as budget over p95', () => {
    const sample = (project: string, name: string, ms: number, budgetMs: number | null = null) => ({ project, name, ms, budgetMs });
    expect(latencyRows([
      sample('webkit', 'peer text', 500, 2_000),
      sample('chromium', 'peer text', 400, 2_000),
      sample('chromium', 'peer text', 800, 2_000),
      sample('chromium', 'theme switch', 30),
    ])).toEqual([
      { name: 'peer text', project: 'chromium', n: 2, p50: 400, p95: 800, max: 800, budgetMs: 2_000, headroom: 2.5 },
      { name: 'peer text', project: 'webkit', n: 1, p50: 500, p95: 500, max: 500, budgetMs: 2_000, headroom: 4 },
      { name: 'theme switch', project: 'chromium', n: 1, p50: 30, p95: 30, max: 30, budgetMs: null, headroom: null },
    ]);
  });
});

test.describe('shard guard', () => {
  test('a journey-group shard that plans no journey fails; the whole-suite shard may run only selftests', () => {
    expect(emptyShardProblem('shell', 0)).toMatch(/shell/);
    expect(emptyShardProblem('shell', 3)).toBeNull();
    expect(emptyShardProblem('all', 0)).toBeNull();
    expect(emptyShardProblem(undefined, 0)).toBeNull();
  });
  test('the reporter fails a group shard whose journey project plans no test, and passes one that plans some', async () => {
    const env = { group: process.env.E2E_GROUP, summary: process.env.GITHUB_STEP_SUMMARY, state: process.env.STACK_STATE };
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.STACK_STATE;
    process.env.E2E_GROUP = 'shell';
    const outputDir = test.info().outputPath('reporter');
    const project = (name: string, tests: number) => ({ project: () => ({ name }), allTests: () => Array.from({ length: tests }) });
    const run = async (journeys: number) => {
      const reporter = new MossReporter();
      const suite = { suites: [project('selftest-chromium', 4), project('chromium', journeys)] };
      reporter.onBegin({ projects: [{ outputDir }], rootDir: outputDir } as never, suite as never);
      return reporter.onEnd({ status: 'passed' } as never);
    };
    try {
      expect(await run(0)).toEqual({ status: 'failed' });
      expect(await run(2)).toBeUndefined();
    } finally {
      for (const [key, value] of [['E2E_GROUP', env.group], ['GITHUB_STEP_SUMMARY', env.summary], ['STACK_STATE', env.state]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

test.describe('UI verbs', () => {
  test('"+ Note" binds before focus, then title, Enter, body lands exactly', async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'verbs' });
    await ui.waitLive(actor, 'doc-a');
    const docId = await ui.createNote(actor);
    expect(docId).not.toBe('doc-a');
    await ui.typeTitle(actor, docId, 'Plan, v2 — é', { enter: true });
    await expect(ui.body(actor, docId)).toBeFocused();
    await ui.typeBody(actor, docId, 'First line, ü.');
    expect(await ui.fieldText(actor, docId, 'title')).toBe('Plan, v2 — é');
    expect(await ui.fieldText(actor, docId, 'body')).toBe('First line, ü.');
    expect(await actors.findings()).toEqual([]);
  });
});

test.describe('sever', () => {
  test('a black-holed doc socket delivers nothing until restored, and the census counts it', async ({ server, browser }) => {
    const context = await browser.newContext();
    const sever = await makeSeverable(context);
    const page = await context.newPage();
    await page.goto(`${server.url}/clean.html`);
    await page.evaluate(() => new Promise<void>((done) => {
      const socket = new WebSocket(`ws://${location.host}/parties/doc-d-o/doc-a`);
      const w = window as unknown as { received: string[]; socket: WebSocket };
      w.received = [];
      w.socket = socket;
      socket.onmessage = (event) => w.received.push(String(event.data));
      socket.onopen = () => done();
    }));
    const send = (text: string) => page.evaluate((t) => (window as unknown as { socket: WebSocket }).socket.send(t), text);
    const received = () => page.evaluate(() => (window as unknown as { received: string[] }).received);
    await send('one');
    await expect.poll(received).toEqual(['one']);
    sever.blackhole();
    await send('two');
    await expect.poll(() => sever.census().dropped.out).toBe(1);
    await page.waitForTimeout(500);
    expect(await received(), 'nothing crosses a black-holed socket').toEqual(['one']);
    sever.restore();
    await send('three');
    await expect.poll(received).toEqual(['one', 'three']);
    expect(sever.census().connections).toBe(1);
    await context.close();
  });
});

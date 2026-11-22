// The rest of e2e/lib proven able to fail: exact-bytes helpers, the allowlist expiry, the principal guard
// (invariant 8), the hibernation proof, infra classification, phase-clock budgets and percentiles, the shard guard,
// the sever, the reach sweep and the UI verbs.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { request, type Page } from '@playwright/test';
import { ALLOWLIST, expiredEntries, isAllowed, type AllowEntry } from '../lib/allowlist.ts';
import { inductionProblems } from '../lib/hibernate.ts';
import { browserLog, closeBrowserTimed } from '../lib/engine.ts';
import { browserCrashIn, classifyInfra, closeEachConnection, InfraBlocked, isInfraBlocked } from '../lib/infra.ts';
import { BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_PANE_ATTR, TITLE_BINDING_ATTR } from '../lib/contract.ts';
import { socketProblems, typedFindings, type ActorView } from '../lib/invariants.ts';
import { budgetProblem, latencyRows, Measure, percentile } from '../lib/measure.ts';
import { assertTestEmail, parseSetCookie, principalProblems } from '../lib/principals.ts';
import MossReporter, { emptyShardProblem } from '../lib/reporter.ts';
import { unreachableControls } from '../lib/reach.js';
import { makeSeverable } from '../lib/sever.ts';
import type { SocketEntry } from '../lib/telemetry.ts';
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

test.describe('settled panes (invariant 7)', () => {
  // A pane mid-mount (a note switch at teardown) shows an empty title until its binding settles (T9.48a).
  const pane = `<div ${EDITOR_PANE_ATTR} ${DOC_ID_ATTR}="d"><div ${TITLE_BINDING_ATTR}="unbound"></div><div ${BODY_BINDING_ATTR}="live"></div></div>`;
  const title: Typed = { docId: 'd', field: 'title', text: 'Button plan', author: 'ben', ordered: true };
  const view = (page: Page): ActorView => ({ label: 'ada', page, telemetry: null as never, declaredHttp: [], reconnects: new Map(), observations: new Map() });

  test('a pane whose title is not bound yet is judged once it binds', async ({ browser }) => {
    const page = await browser.newPage();
    await page.setContent(pane);
    await page.evaluate(({ attr, text }) => setTimeout(() => {
      const field = document.querySelector(`[${attr}]`);
      if (field) { field.textContent = text; field.setAttribute(attr, 'live'); }
    }, 300), { attr: TITLE_BINDING_ATTR, text: title.text });
    expect(await typedFindings([view(page)], [title])).toEqual([]);
    await page.close();
  });

  test('a pane that never binds is its own finding, not a missing string', async ({ browser }) => {
    const page = await browser.newPage();
    await page.setContent(pane);
    const found = (await typedFindings([view(page)], [title], { settleMs: 500 })).map((f) => f.detail);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('pane never bound');
    expect(found[0]).not.toContain('appears 0 time(s)');
    await page.close();
  });

  test('a terminal pane is judged as it stands', async ({ browser }) => {
    const page = await browser.newPage();
    await page.setContent(pane.replace('"unbound"', '"terminal"'));
    const found = (await typedFindings([view(page)], [title], { settleMs: 500 })).map((f) => f.detail);
    expect(found).toEqual([expect.stringContaining('appears 0 time(s)')]);
    await page.close();
  });
});

test.describe('API request connections', () => {
  test("each request through an actor's API context goes out on a connection of its own", async () => {
    const sockets = new Set<number>();
    const server = createServer((req, res) => {
      sockets.add(req.socket.remotePort ?? 0);
      res.end('ok');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const api = closeEachConnection(await request.newContext());
    try {
      await api.get(url);
      await api.post(url, { data: { a: 1 } });
      await api.fetch(url, { method: 'GET' });
      expect(sockets.size, 'no request reuses a pooled connection').toBe(3);
    } finally {
      await api.dispose();
      server.close();
    }
  });
});

test.describe('doc sockets (invariant 3)', () => {
  const socket = (openedAt: number, closedAt: number | null, close: string | null = null): SocketEntry => (
    { url: `ws://h/parties/doc-d-o/d?_pk=${openedAt}`, docId: 'd', epoch: 0, openedAt, closedAt, error: null, close }
  );
  test('two sockets the page lost to a navigation, with no close heard, are still two opens and an overlap', () => {
    expect(socketProblems([socket(0, 5_000), socket(100, 5_000)], new Map())).toHaveLength(2);
  });
  test("a browser-only socket closed at once, beside the page's one, is not the page's", () => {
    expect(socketProblems([socket(0, null), socket(10, 11)], new Map())).toEqual([]);
    expect(socketProblems([socket(0, null), socket(10, 11, '1000')], new Map())).not.toEqual([]);
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
  test('a wake during a long decisive action is induced; one before it or after it ended is not', () => {
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 109_000 }, 100_000, 110_000)).toEqual([]);
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 99_000 }, 100_000, 110_000)).not.toEqual([]);
    expect(inductionProblems(base, { instanceId: 'b', constructedAt: 110_500 }, 100_000, 110_000)).not.toEqual([]);
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

  // Run 44916988918's two forms of WebKit's own report (T9.48g), and its neighbours that must stay product verdicts.
  const WORKSPACE_CRASH = "WebSocket connection to 'ws://127.0.0.1:8850/api/workspace/ws' failed: WebSocket network error: Network process crashed.";
  const DOC_CRASH = "WebSocket connection to 'ws://127.0.0.1:8850/parties/doc-d-o/d6a6ed9e-56ea-409e-999f-72c8cdf79dc0?_pk=k1' failed: WebSocket network error: Network process crashed.";
  test("WebKit's network process crash is infrastructure, on the workspace and the doc socket", () => {
    expect(classifyInfra(WORKSPACE_CRASH)).toBe("the browser's network process crashed");
    expect(classifyInfra(DOC_CRASH)).toBe("the browser's network process crashed");
    expect(browserCrashIn(['an unrelated warning', DOC_CRASH])).toBe("the browser's network process crashed");
  });
  test('a socket failure without the crash, an internal error alone and a page crash are not', () => {
    const plain = "WebSocket connection to 'ws://127.0.0.1:8850/api/workspace/ws' failed: There was a bad response from the server.";
    const internal = 'Failed to load resource: WebKit encountered an internal error (http://127.0.0.1:8850/api/docs/d/backlinks)';
    for (const text of [plain, internal, 'page.evaluate: Target crashed']) {
      expect(classifyInfra(text), text).toBeNull();
      expect(browserCrashIn([text]), text).toBeNull();
    }
  });
  test('a journey failure whose page logged the crash is reported BLOCKED, with its census attached', async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'crashed' });
    await actor.page.evaluate((line) => console.error(line), WORKSPACE_CRASH);
    await expect.poll(() => actor.telemetry.console.length).toBe(1);
    const error = await actors.assertInvariants().then(() => null, (e: Error) => e);
    expect(error?.message).toContain('invariant 1 [crashed]');
    expect(isInfraBlocked(error?.message), 'the invariant failure is labelled infrastructure').toBe(true);
    const census = test.info().attachments.find((a) => a.name === 'invariants-census.json');
    expect(census, 'the census is attached as before').toBeTruthy();
    expect(JSON.parse(String(census?.body)).census[0].console[0].text).toBe(WORKSPACE_CRASH);

    const outputDir = test.info().outputPath('blocked-reporter');
    const env = { summary: process.env.GITHUB_STEP_SUMMARY, state: process.env.STACK_STATE, group: process.env.E2E_GROUP };
    delete process.env.GITHUB_STEP_SUMMARY;
    delete process.env.STACK_STATE;
    delete process.env.E2E_GROUP;
    try {
      const reporter = new MossReporter();
      reporter.onBegin({ projects: [{ outputDir }], rootDir: outputDir } as never, { suites: [] } as never);
      const testCase = { parent: { project: () => ({ name: 'webkit' }) }, titlePath: () => ['', 'webkit', 'j00-import.spec.ts', 'tabs.md'], timeout: 120_000 };
      reporter.onTestEnd(testCase as never, { status: 'failed', duration: 34_000, annotations: [], errors: [{ message: error?.message }] } as never);
      await reporter.onEnd({ status: 'failed' } as never);
      const summary = readFileSync(`${outputDir}/summary.md`, 'utf8');
      expect(summary).toContain('### e2e: BLOCKED (infra)');
      expect(summary).toContain('| webkit | j00-import.spec.ts › tabs.md | BLOCKED |');
      expect(existsSync(`${outputDir}/blocked.json`)).toBe(true);
    } finally {
      for (const [key, value] of [['GITHUB_STEP_SUMMARY', env.summary], ['STACK_STATE', env.state], ['E2E_GROUP', env.group]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// What a failed WebKit test carries so the next network-process fault can be diagnosed (T9.48g). Evidence only.
test.describe('engine evidence', () => {
  test('a line the browser writes to stderr is kept, and the browser close is timed', async ({ browserType }) => {
    test.skip(browserType.name() !== 'webkit', 'the WebKit projects carry the engine evidence');
    const marker = `selftest-stderr-${Date.now()}`;
    const wrapper = test.info().outputPath('browser-wrapper.sh');
    writeFileSync(wrapper, `#!/bin/sh\necho "${marker}" >&2\nexec "${browserType.executablePath()}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const browser = await browserType.launch({ executablePath: wrapper });
    const outputDir = test.info().outputPath('lifecycle');
    const closeMs = await closeBrowserTimed(browser, outputDir, 'selftest');
    await expect.poll(() => browserLog().some((line) => line.includes('[err]') && line.includes(marker))).toBe(true);
    const record = JSON.parse(readFileSync(`${outputDir}/engine-lifecycle.jsonl`, 'utf8').trim().split('\n').at(-1) ?? '{}');
    expect(record).toMatchObject({ label: 'selftest', closeMs });
  });

  test('a forced WebKit failure attaches every item of the engine evidence', async ({ actors, server, browserName }) => {
    test.skip(browserName !== 'webkit', 'the WebKit projects carry the engine evidence');
    const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'failing' });
    await ui.waitLive(actor, 'doc-a');
    await actors.dispose({ capture: true });
    const attachment = test.info().attachments.find((a) => a.name === 'engine.json');
    expect(attachment, 'engine.json is attached').toBeTruthy();
    const evidence = JSON.parse(String(attachment?.body));
    expect(evidence.browserLog.some((line: string) => /<launched> pid=/.test(line)), 'the browser log').toBe(true);
    expect(evidence.engine.browser).toBe('webkit');
    expect(evidence.engine.launchedSecondsAgo, 'seconds since the browser launched').toBeGreaterThanOrEqual(0);
    expect(evidence.engine.contextsCreated, 'contexts this worker created').toBeGreaterThanOrEqual(1);
    expect(evidence.engine.disconnectedAt, 'browser disconnects').toEqual([]);
    expect(evidence.pages).toEqual([expect.objectContaining({ label: 'failing', crashes: [] })]);
    expect(evidence.contextCloses).toEqual([{ label: 'failing', ms: expect.any(Number) }]);
    const probe = evidence.probe;
    expect(probe.url).toBe(`${server.url}/api/version`);
    expect(probe.mainThread).toEqual([expect.objectContaining({ label: 'failing', value: 1 })]);
    expect(probe.freshPage).toEqual([expect.objectContaining({ label: 'failing', value: 200 })]);
    expect(probe.freshContext).toMatchObject({ value: 200 });
    expect(probe.node).toMatchObject({ value: 200 });
    const system = evidence.system;
    for (const key of ['ps', 'networkProcesses', 'ulimitN', 'meminfo', 'shm', 'dmesg']) expect(system, key).toHaveProperty(key);
    if (process.platform === 'linux') {
      expect(system.ps).toMatch(/WebKit/);
      expect(system.networkProcesses.length, 'the network process is found').toBeGreaterThan(0);
      expect(typeof system.networkProcesses[0].fds, 'its descriptors are counted').toBe('number');
      expect(system.networkProcesses[0].status).toMatch(/VmRSS/);
      expect(system.networkProcesses[0].maxOpenFiles).toMatch(/Max open files/);
      expect(system.ulimitN).toMatch(/^\d+|unlimited/);
      expect(system.meminfo).toMatch(/MemAvailable/);
      expect(system.shm).toMatch(/\/dev\/shm/);
    }
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

  test('lost acks: until the next reset no DocDO ack reaches the page, while other frames do', async ({ server, browser }) => {
    const context = await browser.newContext();
    const sever = await makeSeverable(context);
    const page = await context.newPage();
    await page.goto(`${server.url}/clean.html`);
    const open = () => page.evaluate(() => new Promise<void>((done) => {
      const socket = new WebSocket(`ws://${location.host}/parties/doc-d-o/doc-a`);
      const w = window as unknown as { received: string[]; socket: WebSocket };
      w.received = [];
      w.socket = socket;
      socket.onmessage = (event) => w.received.push(String(event.data));
      socket.onopen = () => done();
    }));
    const send = (text: string) => page.evaluate((t) => (window as unknown as { socket: WebSocket }).socket.send(t), text);
    const received = () => page.evaluate(() => (window as unknown as { received: string[] }).received);
    const ack = (sv: string) => `__YPS:${JSON.stringify({ t: 'ack', sv })}`;
    await open();
    sever.loseAcks();
    await send(ack('first'));
    await send('one');
    await send(ack('second'));
    await send('two');
    await expect.poll(received).toEqual(['one', 'two']);
    expect(sever.census().acksLost).toBe(2);

    sever.reset();
    sever.restore();
    await open();
    await send(ack('third'));
    await expect.poll(received, { message: 'a reset ends the loss' }).toEqual([ack('third')]);
    expect(sever.census().acksLost).toBe(2);
    await context.close();
  });
});

test.describe('reach', () => {
  test('a visible control that ignores taps is unreachable; disabled and invisible ones are skipped', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(`<body style="margin:0;overflow:hidden">
      <button style="margin:20px">Tappable</button>
      <button style="margin:20px;pointer-events:none">Untappable</button>
      <button style="margin:20px;pointer-events:none" disabled>Disabled</button>
      <button style="margin:20px;pointer-events:none;opacity:0">Faded out</button>
      <div style="opacity:0"><button style="margin:20px;pointer-events:none">Inside a faded group</button></div>
      <button style="position:absolute;left:420px;top:20px">Off to the side</button>
    </body>`);
    const found = await page.evaluate(unreachableControls, { scope: null });
    expect(found).toHaveLength(2);
    expect(found[0]).toContain('"Untappable"');
    expect(found[1]).toContain('"Off to the side"');
    await page.close();
  });
});

// The rest of e2e/lib proven able to fail: exact-bytes helpers, the allowlist expiry, the principal guard
// (invariant 8), the hibernation proof, infra classification, phase-clock budgets and percentiles, the shard guard,
// the sever, the reach sweep and the UI verbs.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { request } from '@playwright/test';
import { ALLOWLIST, expiredEntries, isAllowed, type AllowEntry } from '../lib/allowlist.ts';
import { recordsScreens } from '../lib/actors.ts';
import { authHeadroom, paceAuth, recordAuth } from '../lib/auth-pace.ts';
import { RequestBudget } from '../lib/budget.ts';
import { probeSocket } from '../lib/doc-client.ts';
import { inductionProblems, ownerProbe } from '../lib/hibernate.ts';
import { classifyInfra, closeEachConnection, InfraBlocked, isInfraBlocked } from '../lib/infra.ts';
import { awaitingRecovery, errorProblems, socketProblems } from '../lib/invariants.ts';
import { budgetProblem, latencyRows, Measure, percentile } from '../lib/measure.ts';
import { assertTestEmail, parseSetCookie, principalProblems, signIn } from '../lib/principals.ts';
import MossReporter, { emptyShardProblem } from '../lib/reporter.ts';
import { unreachableControls } from '../lib/reach.js';
import { makeSeverable } from '../lib/sever.ts';
import type { Stack } from '../lib/stack.ts';
import { Telemetry, type SocketEntry } from '../lib/telemetry.ts';
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

test.describe('request budget', () => {
  // Every request a shard sends the Worker counts: Node's fetch (setup's sign-ups and sign-ins with their retries, a
  // leg's own pushes), Playwright API contexts, and child processes such as the CLI. Others and /assets/ do not.
  test('counts Node fetch, API request contexts and child processes, and only the Worker', async ({ server }) => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-'));
    const budget = new RequestBudget(join(dir, 'requests.json'), 4, server.url);
    try {
      budget.watchNode();
      await (await fetch(`${server.url}/api/version`)).text();
      await (await fetch(`${server.url}/assets/app.js`)).text();
      expect(budget.count, 'Node fetch to the Worker, not /assets/').toBe(1);

      const api = await request.newContext({ baseURL: server.url });
      budget.watchApi(api);
      await api.get('/api/version');
      await api.post('/missing', { data: {} });
      await api.dispose();
      expect(budget.count, 'API request context, relative URLs included').toBe(3);

      const child = "await fetch(process.argv[1] + '/api/version'); await fetch(process.argv[1] + '/assets/x.js');";
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', child, server.url], { env: { PATH: process.env.PATH ?? '', ...budget.childEnv() } });
      expect(budget.count, "a child process's fetch").toBe(4);
      expect(budget.exceeded).toBe(false);
      // A raw ws socket from Node (a protocol-level doc client), refused at the upgrade here: its handshake reached
      // the Worker.
      expect((await probeSocket(`${server.url}/refused`, 'd', null)).opened).toBe(false);
      expect(budget.exceeded, 'a Node ws socket counts, and passes the budget').toBe(true);
      expect(() => budget.assert('selftest')).toThrow(/5 Worker requests passed this run's budget of 4/);
      expect(new RequestBudget(join(dir, 'requests.json'), 4, server.url).count, 'a restarted worker keeps counting').toBe(5);
    } finally {
      budget.unwatchNode();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.describe('doc sockets per document (invariant 3)', () => {
  const socket = (openedAt: number, closedAt: number | null, document?: string | null): SocketEntry =>
    ({ url: `ws://h/parties/doc-d-o/d?_pk=${openedAt}`, docId: 'd', epoch: 2, openedAt, closedAt, error: null, close: null, document });
  test('two opens in one document fail, whichever epoch the navigation event gave them', () => {
    expect(socketProblems([socket(0, 100, 'doc-a'), socket(200, null, 'doc-a')], new Map())).not.toEqual([]);
    expect(socketProblems([socket(0, 100), socket(200, null)], new Map())).not.toEqual([]);
  });
  test("a socket the previous document opened as it unloaded is that document's, not the next one's", () => {
    // WebKit can deliver the old document's socket after the new navigation's response, at the new epoch.
    expect(socketProblems([socket(0, 100, 'doc-a'), socket(139, null, 'doc-b')], new Map())).toEqual([]);
  });
});

test('the auth pace carries its counts to the next worker of the run (a restart after a failure), off the hook stack', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-pace-'));
  try {
    const path = join(dir, 'auth-pace.json');
    paceAuth('https://staging.example', path);
    for (let i = 0; i < 9; i += 1) recordAuth('sign-in');
    // A fresh worker reads them back, so its next sign-in waits out the window instead of meeting a 429.
    paceAuth('https://staging.example', path);
    test.info().setTimeout(0);
    const started = Date.now();
    const waited = authHeadroom('sign-in', 3).then(() => Date.now() - started);
    const early = await Promise.race([waited, new Promise<number>((done) => setTimeout(() => done(-1), 1_000))]);
    expect(early, 'the next sign-in waits').toBe(-1);
    paceAuth(null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe('a network drop off loopback (invariants 1 and 3, T8.2)', () => {
  const OFF = { offLoopback: true };
  const socket = (openedAt: number, closedAt: number | null, code: number | null = null, extra: Partial<SocketEntry> = {}): SocketEntry => ({
    url: `wss://h/parties/doc-d-o/d?_pk=${openedAt}`, docId: 'd', epoch: 2, openedAt, closedAt, error: null,
    close: code === null ? null : String(code), code, document: 'doc-a', ...extra,
  });
  const synced = (openedAt: number) => socket(openedAt, null, null, { synced: true });
  test('off loopback, one 1006 drop whose replacement reached sync passes', () => {
    expect(socketProblems([socket(0, 100, 1006), synced(200)], new Map(), OFF)).toEqual([]);
    expect(socketProblems([socket(0, 100, 1006, { error: 'socket error' }), synced(200)], new Map(), OFF)).toEqual([]);
  });
  test('off loopback, a drop whose replacement never reached sync fails', () => {
    expect(socketProblems([socket(0, 100, 1006), socket(200, null)], new Map(), OFF)).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 1006)], new Map(), OFF)).not.toEqual([]);
    // Only a later socket recovers it: the one before the drop synced, the one after never did.
    expect(socketProblems([socket(0, 100, 1000, { synced: true }), socket(200, 300, 1006), socket(400, null)], new Map([['d', 1]]), OFF)).not.toEqual([]);
  });
  test("a drop whose replacement is still connecting is awaited; a recovered, replaced-and-closed or lone one is not", () => {
    expect(awaitingRecovery([socket(0, 100, 1006), socket(200, null)])).toBe(true);
    expect(awaitingRecovery([socket(0, 100, 1006), synced(200)])).toBe(false);
    expect(awaitingRecovery([socket(0, 100, 1006), socket(200, 300, 1000)])).toBe(false);
    expect(awaitingRecovery([socket(0, 100, 1006)])).toBe(false);
    expect(awaitingRecovery([socket(0, null)])).toBe(false);
  });
  test('off loopback, a 1013 the journey did not declare fails, even recovered and within its declared reconnects', () => {
    expect(socketProblems([socket(0, 100, 1013), synced(200)], new Map(), OFF)).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 1013), synced(200)], new Map([['d', 1]]), OFF)).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 1013), synced(200)], new Map([['d', 1]]), OFF, new Map([['d', 1]]))).toEqual([]);
  });
  test("a severable actor's routed socket keeps the server's close code, so its undeclared 1013 fails too", () => {
    const telemetry = new Telemetry();
    telemetry.routedSocket('wss://h/parties/doc-d-o/d?_pk=1').closed(1013, 'try again');
    // The proxy marks a routed socket synced when its server leg relays sync step 2, as CDP does for a page socket.
    telemetry.routedSocket('wss://h/parties/doc-d-o/d?_pk=2').received(Buffer.from([0, 1, 0]));
    expect(telemetry.sockets[0]).toMatchObject({ code: 1013, close: '1013 try again' });
    expect(telemetry.sockets[1].synced).toBe(true);
    expect(socketProblems(telemetry.sockets, new Map([['d', 1]]), OFF)).toEqual(['d: 1 try-again closes (1013), 0 declared']);
    // A close the proxy made itself (a sever) carries no server code.
    const proxy = new Telemetry();
    proxy.routedSocket('wss://h/parties/doc-d-o/d?_pk=1').closed();
    expect(proxy.sockets[0].close).toBe('closed at the proxy');
    expect(proxy.sockets[0].code ?? null).toBeNull();
  });
  test('on loopback the same drop fails, and off loopback a refusal, a second drop or two sockets at once still fail', () => {
    expect(socketProblems([socket(0, 100, 1006), synced(200)], new Map())).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 4408), synced(200)], new Map(), OFF)).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 1006), socket(200, 300, 1006, { synced: true }), synced(400)], new Map(), OFF)).not.toEqual([]);
    // A second drop fails even when the page opens no third socket.
    expect(socketProblems([socket(0, 100, 1006), socket(200, 300, 1006, { synced: true })], new Map(), OFF)).not.toEqual([]);
    expect(socketProblems([socket(0, 300, 1006), synced(200)], new Map(), OFF)).not.toEqual([]);
  });
  test("off loopback only the recovered drop's own log line, while it lived, is left to invariant 3", () => {
    const dropped = socket(0, 100, 1006);
    const census = (text: string, at = 100, sockets = [dropped, synced(200)]) => ({
      console: [{ type: 'error', text, url: '', at }], pageErrors: [], http: [], sockets,
    });
    const drop = `WebSocket connection to '${dropped.url}' failed: The network connection was lost.`;
    expect(errorProblems(census(drop), [], 'j01', OFF)).toEqual([]);
    expect(errorProblems(census(drop), [], 'j01')).not.toEqual([]);
    expect(errorProblems(census("WebSocket connection to 'wss://h/parties/doc-d-o/d?_pk=200' failed: x"), [], 'j01', OFF)).not.toEqual([]);
    // Not recovered, or logged long after that socket closed: an error.
    expect(errorProblems(census(drop, 100, [dropped, socket(200, null)]), [], 'j01', OFF)).not.toEqual([]);
    expect(errorProblems(census(drop, 60_000), [], 'j01', OFF)).not.toEqual([]);
    // A 1013's log line is never exempt.
    const refused = socket(0, 100, 1013);
    expect(errorProblems(census(`WebSocket connection to '${refused.url}' failed: x`, 100, [refused, synced(200)]), [], 'j01', OFF)).not.toEqual([]);
  });
});

test.describe('recording off loopback (T8.Ds)', () => {
  test('screenshots are taken against a loopback stack or a fixture page only', () => {
    expect(recordsScreens(null)).toBe(true);
    expect(recordsScreens({ baseUrl: 'http://127.0.0.1:8850' })).toBe(true);
    expect(recordsScreens({ baseUrl: 'https://moss-multi-staging.example.workers.dev' })).toBe(false);
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
  // Off the hook stack sign-ins are paced at 10 a minute, so a probe that signed in each time could wait out the
  // window after the decisive action while the woken DO idled out again; the probe itself then built the instance.
  test('the owner probe signs in once, so a probe after the decisive action never waits on the sign-in limit', async () => {
    let signIns = 0;
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/auth/sign-in/email') {
        signIns += 1;
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `session=s${signIns}; Path=/; HttpOnly` });
        res.end('{}');
        return;
      }
      const doc = /^\/api\/docs\/([^/]+)\/instance$/.exec(req.url ?? '');
      const ok = doc && req.headers.cookie === 'session=s1';
      res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? { instanceId: `i-${doc[1]}`, constructedAt: 1 } : { error: 'not-found' }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const probe = ownerProbe({ baseUrl } as Stack, { label: 'ada', name: 'Ada', email: 'mm-selftest-ada-1@example.invalid', password: 'p', id: null });
      expect(await Promise.all([probe('d1'), probe('d2')])).toEqual([{ instanceId: 'i-d1', constructedAt: 1 }, { instanceId: 'i-d2', constructedAt: 1 }]);
      expect(await probe('d1')).toEqual({ instanceId: 'i-d1', constructedAt: 1 });
      expect(signIns, 'one sign-in for every probe').toBe(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

test.describe('setup resends', () => {
  // The run log and summary count these (scripts/deploy/canary-reporter.mjs), so a resend is never silent.
  test('a sign-in resent after a 429 and after a lost forward is recorded on the test, with its count', async () => {
    let posts = 0;
    const server = createServer((req, res) => {
      posts += 1;
      if (posts === 1) {
        res.writeHead(429, { 'x-retry-after': '1' });
        res.end('limited');
      } else if (posts === 2) {
        res.writeHead(503);
        res.end('Your worker restarted mid-request.');
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=s; Path=/; HttpOnly' });
        res.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await signIn(baseUrl, { label: 'ada', name: 'Ada', email: 'mm-selftest-resend-1@example.invalid', password: 'p', id: null });
      expect(posts).toBe(3);
      const resends = test.info().annotations.filter((a) => a.type === 'setup-resend').map((a) => JSON.parse(a.description ?? ''));
      expect(resends).toEqual([{ kind: 'sign-in', cause: '429', count: 1 }, { kind: 'sign-in', cause: 'lost forward', count: 1 }]);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

test.describe('infrastructure classification', () => {
  test('Cloudflare pages, D1 7429, Worker 1101 and dead stacks are infrastructure', () => {
    expect(classifyInfra('<!DOCTYPE html><!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> cloudflare')).not.toBeNull();
    expect(classifyInfra('D1_ERROR: Too many requests queued (7429)')).not.toBeNull();
    expect(classifyInfra('error code: 1101')).not.toBeNull();
    // A Cloudflare page for the Worker's own exception or limit is named as such, never as an edge error page.
    const page = (code: string, title: string) =>
      `<!DOCTYPE html><!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--><title>${title} | Cloudflare</title><span class="cf-error-code">${code}</span>`;
    expect(classifyInfra(page('1101', 'Worker threw exception'))).toBe('Worker 1101');
    expect(classifyInfra(page('1102', 'Worker exceeded resource limits'))).toBe('Worker 1102');
    expect(classifyInfra(page('502', 'Bad gateway'))).toBe('a Cloudflare error page');
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

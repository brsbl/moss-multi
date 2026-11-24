// The rest of e2e/lib proven able to fail: exact-bytes helpers, the allowlist expiry, the principal guard
// (invariant 8), the hibernation proof, infra classification, phase-clock budgets and percentiles, the shard guard,
// the sever, the reach sweep and the UI verbs.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { request, type Page, type TestInfo } from '@playwright/test';
import { Actors, recordsScreens } from '../lib/actors.ts';
import { ALLOWLIST, expiredEntries, isAllowed, type AllowEntry } from '../lib/allowlist.ts';
import { authHeadroom, paceAuth, recordAuth } from '../lib/auth-pace.ts';
import { RequestBudget } from '../lib/budget.ts';
import { BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_PANE_ATTR, TITLE_BINDING_ATTR } from '../lib/contract.ts';
import { probeSocket } from '../lib/doc-client.ts';
import { browserLog, closeBrowserTimed } from '../lib/engine.ts';
import { inductionProblems, ownerProbe } from '../lib/hibernate.ts';
import { browserCrashIn, classifyInfra, InfraBlocked, isInfraBlocked } from '../lib/infra.ts';
import { awaitingRecovery, errorProblems, socketProblems, typedFindings, type ActorView } from '../lib/invariants.ts';
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
  test("each Node-side request goes out on a connection of its own", async ({ browser }) => {
    // Answers as the local Worker does: no `Connection: close` in the answer, whatever the request asked, and the
    // socket left open for the client to reuse.
    let connections = 0;
    let requests = 0;
    const open = new Set<Socket>();
    const server = createNetServer((socket) => {
      connections += 1;
      open.add(socket);
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString('latin1');
        for (;;) {
          const end = buffered.indexOf('\r\n\r\n');
          if (end < 0) return;
          const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(buffered.slice(0, end))?.[1] ?? 0);
          if (buffered.length < end + 4 + length) return;
          buffered = buffered.slice(end + 4 + length);
          requests += 1;
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\nok');
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const api = await request.newContext();
    const context = await browser.newContext();
    try {
      await api.get(url);
      await api.post(url, { data: { a: 1 } });
      await api.fetch(url, { method: 'GET' });
      await context.request.get(url);
      expect(requests, 'every request was answered').toBe(4);
      expect(connections, 'no request reuses a pooled connection').toBe(4);
    } finally {
      await api.dispose();
      await context.close();
      for (const socket of open) socket.destroy();
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
  test('an unrecovered drop is awaited, whether its replacement is connecting, closed or not yet opened; a recovered one is not', () => {
    expect(awaitingRecovery([socket(0, 100, 1006), socket(200, null)])).toBe(true);
    expect(awaitingRecovery([socket(0, 100, 1006), synced(200)])).toBe(false);
    expect(awaitingRecovery([socket(0, 100, 1006), socket(200, 300, 1000)])).toBe(true);
    // The client waits out its reconnect delay before it opens the replacement.
    expect(awaitingRecovery([socket(0, 100, 1006)])).toBe(true);
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
  test('on loopback the same drop fails, and off loopback a refusal, an unrecovered second drop or two sockets at once still fail', () => {
    expect(socketProblems([socket(0, 100, 1006), synced(200)], new Map())).not.toEqual([]);
    expect(socketProblems([socket(0, 100, 4408), synced(200)], new Map(), OFF)).not.toEqual([]);
    // A second drop that no later socket recovered fails, even when the page opens no third socket.
    expect(socketProblems([socket(0, 100, 1006), socket(200, 300, 1006, { synced: true })], new Map(), OFF)).toEqual([
      'd: a socket dropped (1006) and no later socket of its document reached sync',
    ]);
    expect(socketProblems([socket(0, 300, 1006), synced(200)], new Map(), OFF)).not.toEqual([]);
  });
  test('off loopback, 2 recovered drops pass and are both reported; 3 fail, as does any drop that never recovered (T8.F)', async () => {
    const { networkDrops } = await import('../lib/invariants.ts');
    const two = [socket(0, 100, 1006), socket(200, 300, 1006, { synced: true, syncedAt: 250 }), socket(400, null, null, { synced: true, syncedAt: 1_400 })];
    expect(socketProblems(two, new Map(), OFF)).toEqual([]);
    expect(networkDrops(two)).toEqual([
      { docId: 'd', at: 100, recovered: true, recoveryMs: 150 },
      { docId: 'd', at: 300, recovered: true, recoveryMs: 1_100 },
    ]);
    // Their browser failure lines are the drops invariant 3 judged, not console errors.
    const lines = two.slice(0, 2).map((s) => ({ type: 'error', text: `WebSocket connection to '${s.url}' failed: x`, url: '', at: s.closedAt ?? 0 }));
    expect(errorProblems({ console: lines, pageErrors: [], http: [], sockets: two }, [], 'j01', OFF)).toEqual([]);
    // A third, in another document: the run's allowance is passed in this one leg.
    const other = (openedAt: number, closedAt: number | null, code: number | null, extra: Partial<SocketEntry> = {}) => socket(openedAt, closedAt, code, { document: 'doc-b', ...extra });
    const three = [...two, other(500, 600, 1006), other(700, null, null, { synced: true, syncedAt: 800 })];
    expect(socketProblems(three, new Map(), OFF)).toEqual(['3 recovered network drops (1006), 2 allowed in a run']);
    expect(networkDrops(three)).toHaveLength(3);
    const lost = [socket(0, 100, 1006), socket(200, null)];
    expect(socketProblems(lost, new Map(), OFF)).toContain('d: a socket dropped (1006) and no later socket of its document reached sync');
    expect(networkDrops(lost)).toEqual([{ docId: 'd', at: 100, recovered: false, recoveryMs: null }]);
  });
  test('off loopback, a drop that resynced to a replica differing from the server\'s export fails and is not recovered (T8.F)', async () => {
    const { networkDrops } = await import('../lib/invariants.ts');
    const one = [socket(0, 100, 1006), socket(200, null, null, { synced: true, syncedAt: 300 })];
    expect(socketProblems(one, new Map(), { ...OFF, diverged: new Set(['d']) })).toContain(
      "d: a socket dropped (1006) and resynced, but its replica differs from the server's export",
    );
    expect(networkDrops(one, new Map([['d', 'different']]))).toEqual([{ docId: 'd', at: 100, recovered: false, recoveryMs: 200, export: 'different' }]);
    // The same drop with an identical export, or with no pane left to compare, is the reconnect path working.
    expect(socketProblems(one, new Map(), { ...OFF, diverged: new Set() })).toEqual([]);
    expect(networkDrops(one, new Map([['d', 'same']]))).toEqual([{ docId: 'd', at: 100, recovered: true, recoveryMs: 200, export: 'same' }]);
    expect(networkDrops(one, new Map([['d', 'closed']]))[0]).toMatchObject({ recovered: true, export: 'closed' });
  });
  test('a resynced replica matches a fresh load only on the same text; across modes only the title is compared (T8.F)', async () => {
    const { sameExport } = await import('../lib/actors.ts');
    const shown = (mode: string, title: string, body: string) => ({ mode, title, body });
    expect(sameExport(shown('edit', 'T', 'one two'), shown('edit', 'T', 'one two'))).toBe(true);
    expect(sameExport(shown('edit', 'T', 'one two'), shown('edit', 'T', 'one'))).toBe(false);
    expect(sameExport(shown('edit', 'T', 'x'), shown('edit', 'T2', 'x'))).toBe(false);
    expect(sameExport(shown('suggest', 'T', 'one two'), shown('edit', 'T', 'one'))).toBe(true);
    expect(sameExport(shown('edit', 'T', 'x'), null)).toBe(false);
  });
  test('a socket the page closed while it was still connecting hears 1006 but is no network drop', async () => {
    const { networkDrops } = await import('../lib/invariants.ts');
    const asked = [socket(0, 100, 1006, { close: 'asked -, then 1006' }), synced(200)];
    expect(networkDrops(asked)).toEqual([]);
    expect(awaitingRecovery([asked[0]])).toBe(false);
    expect(socketProblems(asked, new Map([['d', 1]]), OFF)).toEqual([]);
    // Not declared, its reopen is still counted as any other.
    expect(socketProblems(asked, new Map(), OFF)).not.toEqual([]);
    // The browser's line for that close is the page's own; another socket's is still a console error.
    const line = (url: string) => [{ type: 'error', text: `WebSocket connection to '${url}' failed: x`, url: '', at: 100 }];
    expect(errorProblems({ console: line(asked[0].url), pageErrors: [], http: [], sockets: asked }, [], 'j01', OFF)).toEqual([]);
    expect(errorProblems({ console: line('wss://h/parties/doc-d-o/d?_pk=9'), pageErrors: [], http: [], sockets: asked }, [], 'j01', OFF)).not.toEqual([]);
  });
  test("the page's close of a connecting socket is asked even when the browser's close event reaches the census first", async () => {
    const { networkDrops } = await import('../lib/invariants.ts');
    const telemetry = new Telemetry();
    const url = 'wss://h/parties/doc-d-o/d?_pk=1';
    const entry = telemetry.socketOpened(url);
    if (!entry) throw new Error('not a doc socket');
    // The page's close binding and the browser's close event come over different channels, in either order.
    entry.closedAt = entry.openedAt + 50;
    telemetry.pageClosed(url, entry.openedAt + 10, 'asked -');
    telemetry.closeHeard(url, '1006');
    expect(entry).toMatchObject({ close: 'asked -, then 1006', code: 1006, closedAt: entry.openedAt + 10 });
    expect(networkDrops(telemetry.sockets)).toEqual([]);
    // A socket the page never asked to close is still a drop.
    const dropped = new Telemetry();
    const lost = dropped.socketOpened('wss://h/parties/doc-d-o/d?_pk=2');
    if (!lost) throw new Error('not a doc socket');
    lost.closedAt = lost.openedAt + 50;
    dropped.closeHeard(lost.url, '1006');
    expect(networkDrops(dropped.sockets)).toHaveLength(1);
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
    const server = createServer((_req, res) => {
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

test.describe('setup on a stale connection', () => {
  // A pooled keep-alive connection the far end closed as a setup request went out on it fails as "fetch failed"
  // (other side closed) before any answer: the request is sent once more on a new connection, and counted.
  test('a sign-in whose connection closed under it is resent once and recorded', async () => {
    let posts = 0;
    const server = createServer((req, res) => {
      posts += 1;
      if (posts === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=s; Path=/; HttpOnly' });
      res.end('{}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await signIn(baseUrl, { label: 'ada', name: 'Ada', email: 'mm-selftest-stale-1@example.invalid', password: 'p', id: null });
      expect(posts).toBe(2);
      const resends = test.info().annotations.filter((a) => a.type === 'setup-resend').map((a) => JSON.parse(a.description ?? ''));
      expect(resends).toEqual([{ kind: 'sign-in', cause: 'stale connection', count: 1 }]);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test('a second close is not resent again', async () => {
    let posts = 0;
    const server = createServer((req) => {
      posts += 1;
      req.socket.destroy();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(signIn(baseUrl, { label: 'ada', name: 'Ada', email: 'mm-selftest-stale-2@example.invalid', password: 'p', id: null })).rejects.toThrow(/fetch failed/);
      expect(posts).toBe(2);
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
  test('a line the browser writes to stderr is kept, and the browser close is timed', async ({ playwright, browserName }) => {
    test.skip(browserName !== 'webkit', 'the WebKit projects carry the engine evidence');
    const browserType = playwright.webkit;
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

  // The real trigger, not a direct capture call: a fixture's teardown (Actors.settle, which both fixtures run) sees
  // the invariants fail on a live page and attaches the evidence; the same teardown on a clean page attaches none.
  test('a forced WebKit failure attaches every item of the engine evidence', async ({ browser, server, browserName }) => {
    test.skip(browserName !== 'webkit', 'the WebKit projects carry the engine evidence');
    let mark = 0;
    const engineFiles = () => test.info().attachments.slice(mark).filter((a) => a.name.startsWith('engine'));
    const fresh = (info: TestInfo = test.info()) => {
      const own = new Actors(browser, info, { stack: null, runToken: 'selftest' });
      own.solo('fixture pages have no principals; the guard has its own selftest');
      return own;
    };
    const clean = fresh();
    await ui.waitLive(await clean.anonymous(`${server.url}/clean.html`, { label: 'passing' }), 'doc-a');
    await clean.settle();
    expect(engineFiles(), 'a passing teardown attaches no engine evidence').toEqual([]);

    // A test whose body failed: the teardown reads the status the runner set (here a view of this test's info that
    // reports the body failed) and captures without any invariant finding, as the selftest fixture's teardown does.
    const info = test.info();
    const bodyFailed = { file: info.file, tags: info.tags, annotations: info.annotations, status: 'failed', expectedStatus: 'passed', attach: info.attach.bind(info) } as unknown as TestInfo;
    const failedBody = fresh(bodyFailed);
    await ui.waitLive(await failedBody.anonymous(`${server.url}/clean.html`, { label: 'body' }), 'doc-a');
    await failedBody.settle({ assert: false });
    expect(engineFiles().map((a) => a.name), 'a failed body is captured').toEqual(['engine.json', 'engine-closes.json']);
    mark = info.attachments.length;

    const actors = fresh();
    const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'failing' });
    await ui.waitLive(actor, 'doc-a');
    await actor.page.evaluate(() => console.error('selftest: forced failure'));
    await expect.poll(() => actor.telemetry.console.length).toBe(1);
    const error = await actors.settle().then(() => null, (e: Error) => e);
    expect(error?.message, 'the teardown fails the test').toContain('invariant 1 [failing]');
    expect(engineFiles().map((a) => a.name), 'the evidence is attached before the contexts close, their times after').toEqual(['engine.json', 'engine-closes.json']);
    expect(JSON.parse(String(engineFiles()[1].body)).contextCloses).toEqual([{ label: 'failing', ms: expect.any(Number) }]);
    const attachment = engineFiles().find((a) => a.name === 'engine.json');
    expect(attachment, 'engine.json is attached').toBeTruthy();
    const evidence = JSON.parse(String(attachment?.body));
    expect(evidence.browserLog.some((line: string) => /<launched> pid=/.test(line)), 'the browser log').toBe(true);
    expect(evidence.engine.browser).toBe('webkit');
    expect(evidence.engine.launchedSecondsAgo, 'seconds since the browser launched').toBeGreaterThanOrEqual(0);
    expect(evidence.engine.contextsCreated, 'contexts this worker created').toBeGreaterThanOrEqual(1);
    expect(evidence.engine.disconnectedAt, 'browser disconnects').toEqual([]);
    expect(evidence.pages).toEqual([expect.objectContaining({ label: 'failing', crashes: [] })]);
    const probe = evidence.probe;
    expect(probe.url).toBe(`${server.url}/api/version`);
    expect(probe.mainThread).toEqual([expect.objectContaining({ label: 'failing', value: 1 })]);
    expect(probe.freshPage).toEqual([expect.objectContaining({ label: 'failing', value: 200 })]);
    expect(probe.freshContext).toMatchObject({ value: 200 });
    expect(probe.node).toMatchObject({ value: 200 });
    const system = evidence.system;
    for (const key of ['ps', 'networkProcesses', 'ulimitN', 'meminfo', 'shm', 'dmesg']) expect(system, key).toHaveProperty(key);
    if (process.platform === 'linux') {
      expect(system.ps).toMatch(/NetworkProcess/);
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

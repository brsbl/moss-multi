// Every invariant detector can fail (S-test §3.8): each fixture violates exactly one invariant and must be flagged
// by that invariant alone; the clean fixture yields no findings.
import type { Page } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { BODY_BINDING_ATTR } from '../lib/contract.ts';
import * as ui from '../lib/ui.ts';
import { expect, test } from './fixtures.ts';

const DOC = 'doc-a';
const TYPED = 'Quick fox, wörld… é!';

interface Case {
  fixture: string;
  invariant: number;
  variant?: string;
  act?: (page: Page) => Promise<unknown>;
}

const CASES: Case[] = [
  { fixture: 'console-error', invariant: 1 },
  { fixture: 'pageerror', invariant: 1 },
  { fixture: 'http-error', invariant: 1 },
  { fixture: 'stale-build', invariant: 2 },
  { fixture: 'two-sockets', invariant: 3, act: (page) => page.waitForFunction(() => (window as unknown as { sockets: WebSocket[] }).sockets.every((s) => s.readyState === 1)) },
  { fixture: 'remount', invariant: 4, variant: 'with a generation bump', act: (page) => page.evaluate(() => (window as unknown as { remount: (o: object) => void }).remount({ bump: true })) },
  { fixture: 'remount', invariant: 4, variant: 'at the same generation', act: (page) => page.evaluate(() => (window as unknown as { remount: (o: object) => void }).remount({ bump: false })) },
  { fixture: 'floating', invariant: 5 },
  { fixture: 'marker-leak', invariant: 6 },
  { fixture: 'dropped-keystroke', invariant: 7 },
  { fixture: 'reordered', invariant: 7 },
  { fixture: 'duplicated', invariant: 7, act: (page) => page.locator('html[data-echoed]').waitFor({ state: 'attached' }) },
  // A field still binding is waited for, never skipped: one that never binds fails, and so does a rebind that loses text.
  { fixture: 'stuck-unbound', invariant: 7, act: (page) => page.locator('html[data-unbound]').waitFor({ state: 'attached' }) },
  { fixture: 'rebind-loses-text', invariant: 7, act: (page) => page.locator('html[data-unbound]').waitFor({ state: 'attached' }) },
  { fixture: 'editable-unbound', invariant: 9 },
];

/** The same user path on every fixture: observe the editor, then type into the body (the title may be unbound). */
async function exercise(actor: Actor): Promise<void> {
  await expect(ui.body(actor, DOC)).toHaveAttribute(BODY_BINDING_ATTR, 'live');
  await actor.observeEditor(DOC);
  await ui.typeBody(actor, DOC, TYPED);
}

test('the clean fixture yields no findings', async ({ actors, server }) => {
  const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'clean' });
  await exercise(actor);
  expect(await ui.fieldText(actor, DOC, 'body')).toBe(`Hello${TYPED}`);
  expect(await actors.findings()).toEqual([]);
});

for (const c of CASES) {
  test(`${c.fixture}${c.variant ? ` ${c.variant}` : ''} is flagged by invariant ${c.invariant} alone`, async ({ actors, server }) => {
    const actor = await actors.anonymous(`${server.url}/${c.fixture}.html`, { label: c.fixture });
    await exercise(actor);
    await c.act?.(actor.page);
    const findings = await actors.findings();
    test.info().annotations.push({ type: 'findings', description: JSON.stringify(findings) });
    expect(findings.length, `invariant ${c.invariant} must flag ${c.fixture}`).toBeGreaterThan(0);
    expect(findings.filter((f) => f.invariant !== c.invariant), `only invariant ${c.invariant} may flag ${c.fixture}`).toEqual([]);
  });
}

test('invariant 7 waits for a rebinding field and then reads its text', async ({ actors, server }) => {
  const actor = await actors.anonymous(`${server.url}/rebind-keeps-text.html`, { label: 'rebind' });
  await exercise(actor);
  await actor.page.locator('html[data-unbound]').waitFor({ state: 'attached' });
  expect(await actors.findings()).toEqual([]);
});

test('a declared 4xx is not a finding', async ({ actors, server }) => {
  const actor = await actors.anonymous(`${server.url}/http-error.html`, { label: 'declared' });
  actor.expectHttp(404, '/missing');
  await exercise(actor);
  await expect.poll(() => actor.telemetry.http.length).toBe(1);
  expect(await actors.findings()).toEqual([]);
});

test('a declared reconnect allows a second socket once the first has closed', async ({ actors, server }) => {
  const actor = await actors.anonymous(`${server.url}/clean.html`, { label: 'reconnect' });
  actor.expectReconnects(1, DOC);
  await actor.page.evaluate(async () => {
    const open = () => new Promise<WebSocket>((done) => {
      const socket = new WebSocket(`ws://${location.host}/parties/doc-d-o/doc-a`);
      socket.onopen = () => done(socket);
    });
    const first = await open();
    await new Promise((done) => { first.onclose = done; first.close(); });
    await open();
  });
  expect(await actors.findings()).toEqual([]);
});

test('checkpoints flag the DOM invariants mid-test', async ({ actors, server }) => {
  const actor = await actors.anonymous(`${server.url}/floating.html`, { label: 'checkpoint' });
  await ui.waitLive(actor, DOC);
  await expect(actors.checkpoint('mid-test')).rejects.toThrow(/invariant 5/);
});

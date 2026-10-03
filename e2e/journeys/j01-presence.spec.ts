import YProvider from 'y-partyserver/provider';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { expect, test, ui } from '../lib/test.ts';
import type { Actor, Actors } from '../lib/actors.ts';
const chips = (actor: Actor) => actor.page.locator('[data-presence-client]');
async function setup(actors: Actors, baseUrl: string, solo = false) {
  const principal = await actors.principal('ada');
  const ada = await actors.open(principal);
  const response = await ada.context.request.post('/api/docs', { headers: { Origin: baseUrl }, data: { title: 'Presence', markdown: 'A shared paragraph for our cursors.' } });
  expect(response.status()).toBe(201);
  const { doc: { id } } = await response.json();
  await ada.goto(`/d/${id}`);
  await expect(ui.body(ada, id)).toHaveAttribute('data-body-binding', 'live');
  await expect(chips(ada)).toHaveCount(0);
  const second = solo ? principal : await actors.principal('ben');
  if (!solo) expect((await ada.context.request.post(`/api/docs/${id}/members`, { headers: { Origin: baseUrl }, data: { email: second.email, role: 'editor' } })).ok()).toBe(true);
  const ben = await actors.open(second, { label: 'ben', path: `/d/${id}`, severable: true });
  await expect(ui.body(ben, id)).toHaveAttribute('data-body-binding', 'live');
  await expect(chips(ada)).toHaveCount(1);
  await expect(chips(ben)).toHaveCount(1);
  return { ada, ben, id };
}
test('j01 presence: three clients have stable distinct colors, matching carets and selections, typing labels and prompt leave @p:col-2 @evidence', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl);
  const benColor = await chips(ada).getAttribute('data-presence-color');
  const caraPrincipal = await actors.principal('cara');
  expect((await ada.context.request.post(`/api/docs/${id}/members`, { headers: { Origin: stack.baseUrl }, data: { email: caraPrincipal.email, role: 'editor' } })).ok()).toBe(true);
  const cara = await actors.open(caraPrincipal, { path: `/d/${id}` });
  for (const actor of [ada, ben, cara]) await expect(chips(actor)).toHaveCount(2);
  await actors.requireDistinct(3);
  const colors = [...await chips(ada).evaluateAll(es => es.map(e => e.getAttribute('data-presence-color'))), await chips(ben).filter({ hasText: 'A' }).getAttribute('data-presence-color')];
  expect(new Set(colors).size).toBe(3);
  const peer = chips(ada).filter({ hasText: 'B' });
  await expect(peer).toHaveAttribute('data-presence-color', benColor!);
  await ui.body(ben, id).click();
  await ben.page.keyboard.press('End');
  const caret = ada.page.locator('[data-remote-caret]').filter({ has: ada.page.locator('[data-cursor-label]', { hasText: ben.principal!.name }) });
  await expect(caret).toBeVisible();
  const before = await caret.boundingBox();
  expect(before).not.toBeNull();
  await ben.page.keyboard.press('ArrowLeft');
  await expect.poll(async () => {
    const after = await caret.boundingBox();
    return after !== null && after.x !== before!.x;
  }, { timeout: 1000, intervals: [20] }).toBe(true);
  await expect(caret).toHaveAttribute('data-presence-color', benColor!);
  const chipFill = await peer.evaluate(element => getComputedStyle(element).backgroundColor);
  expect(chipFill).not.toBe('rgba(0, 0, 0, 0)');
  await expect(caret).toHaveCSS('background-color', chipFill);
  await ben.page.keyboard.press('Shift+ArrowLeft');
  const selection = ada.page.locator('[data-remote-selection]');
  await expect(selection).toHaveAttribute('data-presence-color', benColor!);
  await expect(selection.locator(':scope > span:not([data-remote-caret])')).toHaveCSS('background-color', chipFill);
  await ben.page.keyboard.press('ArrowRight');
  await ben.page.keyboard.type(' typing');
  await expect(caret.locator('[data-cursor-label]')).toBeVisible();
  await actors.checkpoint('signature-presence');
  await expect(caret.locator('[data-cursor-label]')).toBeHidden({ timeout: 3000 });
  await ben.goto('/');
  await expect(chips(ada)).toHaveCount(1, { timeout: 3000 });
});
test('j01 presence: a hard drop clears within 8–20 seconds @p:col-2', async ({ actors, stack }) => {
  const { ada, ben } = await setup(actors, stack.baseUrl);
  ben.expectReconnects(5);
  const at = Date.now(); ben.sever!.blackhole();
  await expect(chips(ada)).toHaveCount(0, { timeout: 20_000 });
  expect(Date.now() - at).toBeGreaterThanOrEqual(8000);
  ben.sever!.restore();
  await expect(chips(ada)).toHaveCount(1, { timeout: 20_000 });
});
test('j01 presence: one principal in two windows sees the other client and undo keeps peer text @p:col-1 @p:col-2 @p:col-3', async ({ actors, stack }) => {
  actors.solo('PRODUCT counts each window as a user; this leg deliberately shares a principal.');
  const { ada, ben, id } = await setup(actors, stack.baseUrl, true);
  await ui.body(ada, id).click(); await ada.page.keyboard.press('ControlOrMeta+End');
  await ada.page.keyboard.type(' Ada');
  await expect(ui.body(ben, id)).toContainText(' Ada');
  await ui.typeBody(ben, id, ' Ben');
  await expect(ui.body(ada, id)).toContainText(' Ben');
  await ui.body(ada, id).click(); await ada.page.keyboard.press('ControlOrMeta+z');
  await expect(ui.body(ada, id)).toContainText(' Ben');
  await expect(ui.body(ada, id)).not.toContainText(' Ada');
  await expect(ui.body(ben, id)).not.toContainText(' Ada');
});

test('j01 presence: a spoofed awareness name never reaches a peer @p:col-2', async ({ actors, stack }) => {
  const { ada, ben, id } = await setup(actors, stack.baseUrl);
  const cookie = (await ben.context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  const doc = new Y.Doc();
  const provider = new YProvider(new URL(stack.baseUrl).host, id, doc, {
    party: 'doc-d-o', connect: false, disableBc: true,
    WebSocketPolyfill: class extends WebSocket { constructor(url: string) { super(url, { headers: { cookie, origin: stack.baseUrl } }); } } as unknown as typeof globalThis.WebSocket,
  });
  try {
    await provider.connect();
    await expect.poll(() => provider.synced).toBe(true);
    const user = { principalId: ben.principal!.id, name: ben.principal!.name, isAgent: false, color: 'var(--chart-blue)', colorSettled: true, slot: 0 };
    provider.awareness.setLocalState({ name: user.name, color: user.color, user });
    const chip = ada.page.locator(`[data-presence-client="${doc.clientID}"]`);
    await expect(chip).toHaveAttribute('title', user.name);
    provider.awareness.setLocalState({ name: 'Forged owner', color: user.color, user: { ...user, name: 'Forged owner' } });
    await ada.page.waitForTimeout(500);
    await expect(chip).toHaveAttribute('title', user.name);
    await expect(ada.page.getByTitle('Forged owner')).toHaveCount(0);
  } finally { provider.awareness.setLocalState(null); provider.destroy(); doc.destroy(); }
});

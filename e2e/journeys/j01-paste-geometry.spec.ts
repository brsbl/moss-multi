// j01-paste-geometry (T4.S5): a large paste lays out remote cursors in each batch (setBatchGeometry), and nothing that
// cursor geometry throws may stop the paste: it lands whole, one undo step that redoes whole (T3.S6). A throw that
// escaped a batch ended the paste after its first batch, so the rest never landed. Also a viewer peer whose cursor
// positions are malformed is present while the paste lands.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import YProvider from 'y-partyserver/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { grantDoc } from '../lib/grants.ts';
import { normalized, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

const LINES = Array.from({ length: 5_000 }, (_, i) => `Geometry line ${i}.`);
const NOTE = 'Top.\n\nTail.';

async function wants(ada: Parameters<typeof normalized>[0], stack: Parameters<typeof normalized>[1]) {
  const pasted = LINES.join('\n\n');
  return {
    whole: await normalized(ada, stack, `Top.\n\n${pasted}\n\nTail.`),
    typed: await normalized(ada, stack, `Top.\n\n${pasted}Z\n\nTail.`),
  };
}

const batches = (ada: { page: import('@playwright/test').Page }) =>
  ada.page.evaluate(() => performance.getEntriesByType('measure').filter((entry) => entry.name === 'moss-paste-batch').length);

test('j01-paste-geometry: a multi-batch plain paste lands whole when its batches’ cursor geometry throws, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, NOTE);
  const want = await wants(ada, stack);
  // Ben's caret is in "Tail.", so Ada's screen paints it in every batch.
  await ui.body(ben, docId).locator('p').filter({ hasText: /^Tail\.$/ }).click();
  await expect(ada.page.locator('[data-remote-caret]'), 'Ada sees Ben’s caret').toHaveCount(1, { timeout: 30_000 });
  // Cursor paint throws whenever it runs synchronously inside a task (a paste batch's geometry hook); the paints the
  // interval, awareness and edits schedule run in microtasks and are left alone.
  await ada.page.evaluate(() => {
    const probe = window as unknown as { __geometryThrows: number };
    probe.__geometryThrows = 0;
    let inTask = 0;
    const nativeTimeout = window.setTimeout;
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => nativeTimeout((...args: unknown[]) => {
      inTask += 1;
      try {
        if (typeof handler === 'function') (handler as (...a: unknown[]) => void)(...args);
      } finally {
        inTask -= 1;
      }
    }, delay, ...rest)) as typeof window.setTimeout;
    const nativeStyle = window.getComputedStyle;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      if (inTask > 0 && element instanceof HTMLElement && element.dataset.cursorLabel !== undefined) {
        probe.__geometryThrows += 1;
        throw new Error('cursor geometry failed');
      }
      return nativeStyle.call(window, element, pseudo);
    }) as typeof window.getComputedStyle;
  });
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Top\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId, wire }, LINES.join('\n'), want, 90_000);
  expect(await batches(ada), 'the paste landed in several batches').toBeGreaterThan(1);
  expect(await ada.page.evaluate(() => (window as unknown as { __geometryThrows: number }).__geometryThrows), 'the batches’ cursor geometry threw').toBeGreaterThan(0);
});

test('j01-paste-geometry: a multi-batch plain paste lands whole while a viewer with malformed cursor positions is present, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(300_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, NOTE);
  const want = await wants(ada, stack);
  const principal = await actors.principal('vic');
  await grantDoc(ada, docId, principal, 'viewer');
  const vic = await actors.session(principal);
  const cookie = (await vic.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const doc = new Y.Doc();
  const provider = new YProvider(new URL(stack.baseUrl).host, docId, doc, {
    party: 'doc-d-o', connect: false, disableBc: true,
    WebSocketPolyfill: class extends WebSocket { constructor(url: string) { super(url, { headers: { cookie, origin: stack.baseUrl } }); } } as unknown as typeof globalThis.WebSocket,
  });
  try {
    await provider.connect();
    await expect.poll(() => provider.synced, { timeout: 30_000 }).toBe(true);
    const user = { principalId: principal.id, name: principal.name, isAgent: false, color: 'var(--chart-blue)', colorSettled: true, slot: 0 };
    provider.awareness.setLocalState({ name: user.name, color: user.color, user, focusing: true, anchorPos: {}, focusPos: {} });
    await ui.body(ben, docId).locator('p').filter({ hasText: /^Tail\.$/ }).click();
    await expect(ada.page.locator('[data-remote-caret]'), 'Ada sees Ben’s caret').toHaveCount(1, { timeout: 30_000 });
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Top\.$/ }).click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.press('Enter');
    provider.awareness.setLocalState({ name: user.name, color: user.color, user, focusing: true, anchorPos: { item: { client: 'x' } }, focusPos: { type: 7 } });
    await pasteAndCheck({ ada, ben, docId, wire }, LINES.join('\n'), want, 90_000);
    expect(await batches(ada), 'the paste landed in several batches').toBeGreaterThan(1);
  } finally {
    provider.awareness.setLocalState(null);
    provider.destroy();
    doc.destroy();
  }
});

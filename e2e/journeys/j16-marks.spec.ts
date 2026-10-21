// j16-marks (T5.B3; docs/design/suggestions.md §5, §7): an Edit-mode wedge at a block's edge takes the hover and the
// click over moss's gap cursor, and a multi-word preview reads as a line, inside the viewport (B305); a formula typed
// while suggesting commits on Space and on Enter, is recorded, leaves the note alone until an accept, and idling sends
// nothing (B306).
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  SUGGEST_MARK_ATTR, SUGGEST_SENT_ATTR, SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, content, openIn, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** A note owned by ada that ben can suggest on, and its export before any suggestion. */
async function sharedNote(actors: Actors, markdown: string) {
  const ada = await actors.open(await actors.principal('ada'));
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  return { ada, ben, docId, before: await content(ada, docId) };
}

const panel = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
const sentCount = async (actor: Actor, docId: string): Promise<number> => Number(await ui.pane(actor, docId).getAttribute(SUGGEST_SENT_ATTR));

test('j16-marks wedges (B305): a wedge takes the hover and the click over the gap cursor, and a multi-word preview reads wide and stays in view @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Code below.\n\n```js\nseed\n```\n\nTail paragraph here.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  await ben.observeEditor(docId);
  await ui.body(ben, docId).locator('.moss-codeblock-pre').click();
  const field = ui.body(ben, docId).getByPlaceholder('Enter code...');
  await expect(field).toBeVisible();
  await field.press('End');
  await field.pressSequentially('!');
  await expect(field).toHaveValue('seed!');
  await settled(ben, docId, 'the code edit');

  // The code block's wedge sits at its bottom edge, where moss's gap cursor takes the pointer unless the wedge is above it.
  const wedge = ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"][aria-label*="seed!"]`);
  await expect(wedge, 'a wedge marks the code block').toHaveCount(1, { timeout: BIND_TIMEOUT });
  const hit = await wedge.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return top === element || element.contains(top);
  });
  expect(hit, 'the wedge is the topmost element at its centre').toBe(true);
  await wedge.hover({ timeout: 5_000 });
  await expect(wedge.locator('[data-suggest-preview]'), 'hovering shows the preview').toBeVisible();
  await expect(wedge.locator('[data-suggest-preview]')).toContainText('seed!');
  await wedge.click({ timeout: 5_000 });
  await expect(panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ACTIVE_ATTR}]`), 'the click reaches the wedge and opens its card').toHaveCount(1, { timeout: BIND_TIMEOUT });
  await ada.page.keyboard.press('Escape');
  await expect(panel(ada)).toBeHidden();

  // A long inline suggestion at a line end, in a narrow window: the preview is wider than a word and inside the viewport.
  await caret(ben, docId, 'Tail paragraph here.', 'Tail paragraph here.'.length);
  await ben.page.keyboard.type(' plus several more words that make a long preview line');
  await settled(ben, docId, 'the inline suggestion');
  await ada.page.setViewportSize({ width: 400, height: 800 });
  const inline = ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"][aria-label*="several more words"]`);
  await expect(inline, 'a wedge marks the inline suggestion').toHaveCount(1, { timeout: BIND_TIMEOUT });
  await inline.hover({ timeout: 5_000 });
  const preview = inline.locator('[data-suggest-preview]');
  await expect(preview).toBeVisible();
  const box = await preview.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size;
    return { left: rect.left, right: rect.right, width: rect.width, lines, viewport: document.documentElement.clientWidth };
  });
  expect(box.width, 'wider than one word').toBeGreaterThan(150);
  expect(box.lines, 'a few lines, not one word per line').toBeLessThanOrEqual(3);
  expect(box.left, 'inside the viewport on the left').toBeGreaterThanOrEqual(0);
  expect(box.right, 'inside the viewport on the right').toBeLessThanOrEqual(box.viewport);
});

test('j16-marks formulas (B306): a formula typed while suggesting commits with Space and with Enter, is recorded, leaves the note alone, and idling sends nothing @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId, before } = await sharedNote(actors, 'Sums below.\n\nTail line.');
  await openIn(ben, docId);
  await actors.requireDistinct(2);
  await ben.observeEditor(docId);
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'Tail line.', 'Tail line.'.length);
  await ben.page.keyboard.press('Enter');
  await ben.page.keyboard.type('=2+3');
  await ben.page.keyboard.press(' ');
  await expect(body.locator('[data-formula-id]'), 'Space commits the formula').toHaveCount(1, { timeout: BIND_TIMEOUT });
  await ben.page.keyboard.press('Enter');
  await ben.page.keyboard.type('=4*5');
  await ben.page.keyboard.press('Enter');
  await expect(body.locator('[data-formula-id]'), 'Enter commits the formula').toHaveCount(2, { timeout: BIND_TIMEOUT });
  await settled(ben, docId, 'the formulas');
  await expect.poll(() => content(ada, docId, 'working'), { message: 'both formulas are in the suggestion', timeout: BIND_TIMEOUT }).toMatch(/\{\{2\+3\|[^}]*\}\}[\s\S]*\{\{4\*5\|/);
  expect(await content(ada, docId), 'the note is unchanged until an accept').toBe(before);

  // Idle: nothing recalculates and writes on its own.
  const sent = await sentCount(ben, docId);
  const working = await content(ada, docId, 'working');
  await ben.page.waitForTimeout(3_000);
  await settled(ben, docId, 'idle');
  expect(await sentCount(ben, docId), 'idling sends no suggestion').toBe(sent);
  expect(await content(ada, docId, 'working')).toBe(working);
  expect(await content(ada, docId)).toBe(before);
});

// j16-review (T5.3; docs/design/suggestions.md §4, §8; PRODUCT ruling 16, 17): reviewing suggestions in the real app.
// A suggester's suggestion is listed in the peer's Suggestions panel and notifies the owner; the owner accepts it from
// the painted mark in Edit mode and both windows converge on the accepted text, then rejects the next one from the
// panel and it leaves both windows; and the author's withdraw removes the inserted text from every view, Review
// included, while the server's note stays byte-identical.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, SUGGEST_MARK_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR,
  SUGGESTION_ID_ATTR, SUGGESTION_ROW_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const BOOT_TIMEOUT = 30_000;
const BIND_TIMEOUT = 15_000;
const NOTE = 'Keep every original word.\n\nSecond paragraph here.';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

const content = async (actor: Actor, docId: string): Promise<string> => (await actor.context.request.get(`/api/docs/${docId}/content`)).text();

const frames = (actor: Actor) => actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

async function caret(actor: Actor, docId: string, text: string, offset: number): Promise<void> {
  await ui.body(actor, docId).evaluate((root, { text, offset }) => {
    (root as HTMLElement).focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + offset);
      range.collapse(true);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset });
  await frames(actor);
}

async function openIn(actor: Actor, docId: string, mode: 'suggest' | 'review' | 'edit'): Promise<void> {
  await actor.goto(`/d/${docId}`);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  await expect(ui.pane(actor, docId)).toHaveAttribute(EDIT_MODE_ATTR, mode, { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, mode === 'review' ? 'readonly' : 'live', { timeout: BIND_TIMEOUT });
}

/** The suggester types `text` at `offset` into the body text holding `at`; it is sent, acknowledged and never refused. */
async function suggestText(actor: Actor, docId: string, at: string, offset: number, text: string): Promise<void> {
  await caret(actor, docId, at, offset);
  await actor.page.keyboard.type(text);
  const pane = ui.pane(actor, docId);
  await expect(pane, 'acknowledged').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, 'never refused').toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
}

/** The centre of `text`'s first occurrence in `actor`'s body. */
async function pointAt(actor: Actor, docId: string, text: string): Promise<{ x: number; y: number }> {
  return ui.body(actor, docId).evaluate((root, text) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw new Error(`no body text "${text}"`);
  }, text);
}

/** A note owned by ada that ben can suggest on. */
async function sharedNote(actors: Actors, markdown = NOTE) {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  return { ada, ben, docId, adaPrincipal };
}

const button = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`);
const panel = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
const cards = (actor: Actor, status?: string): Locator =>
  panel(actor).locator(status ? `[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="${status}"]` : `[${SUGGESTION_CARD_ATTR}]`);

async function openPanel(actor: Actor): Promise<Locator> {
  if (!(await panel(actor).isVisible())) await button(actor).click();
  await expect(panel(actor)).toBeVisible();
  return panel(actor);
}

async function closePanel(actor: Actor): Promise<void> {
  if (await panel(actor).isVisible()) await actor.page.keyboard.press('Escape');
  await expect(panel(actor)).toBeHidden();
}

test("j16-review: the peer's panel lists a suggestion; an editor's accept from the painted mark and reject from the panel converge on both sides @p:mean-2 @p:ppl-3 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  // Each close of the author's own record (the accept, then the reject) rebuilds his fork on a fresh socket (§5).
  ben.expectReconnects(2, docId);

  await suggestText(ben, docId, 'original word', 8, ' plus');
  await expect(ui.body(ben, docId)).toContainText('Keep every original plus word.');

  // The peer's review UI lists it, and the owner's bell says so.
  await expect(button(ada), 'the count reaches the owner').toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const listed = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(listed).toHaveCount(1);
  await expect(listed, 'the card names the author').toContainText('Ben');
  await expect(listed, 'the card shows the inserted text').toContainText('plus', { timeout: BIND_TIMEOUT });
  await expect(listed.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  await closePanel(ada);
  await expect(ada.page.getByRole('button', { name: /Notifications, \d+ unread/ }), 'the owner is notified').toBeVisible({ timeout: BIND_TIMEOUT });
  await ada.page.getByRole('button', { name: /Notifications/ }).click();
  await expect(ada.page.getByText(/suggested changes in/)).toBeVisible();
  await ada.page.keyboard.press('Escape');

  // The author's own panel lists it with Withdraw and no Accept.
  const own = (await openPanel(ben)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(own).toHaveCount(1);
  await expect(own.getByRole('button', { name: 'Withdraw' })).toBeVisible();
  await expect(own.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await closePanel(ben);

  // Accept, reached from the painted insert mark in Edit mode.
  const mark = ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"][${SUGGESTION_ID_ATTR}]`).first();
  await expect(mark).toBeAttached({ timeout: BIND_TIMEOUT });
  await mark.click({ force: true });
  const active = panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ACTIVE_ATTR}]`);
  await expect(active, 'the painted mark opens its card').toHaveCount(1);
  await active.getByRole('button', { name: 'Accept' }).click();
  await expect(panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="accepted"]`)).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await closePanel(ada);
  await expect(ui.body(ada, docId), "the owner's body holds the accepted text").toContainText('Keep every original plus word.', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId), "the author's window keeps it").toContainText('Keep every original plus word.');
  await expect.poll(() => content(ada, docId), { message: 'the server has it', timeout: BIND_TIMEOUT }).toContain('Keep every original plus word.');
  await expect(button(ben)).toHaveAttribute('aria-label', /0 open|^Suggestions$/, { timeout: BIND_TIMEOUT });

  // The next one is rejected from the panel and leaves both windows.
  await suggestText(ben, docId, 'Second paragraph', 6, ' extra');
  await expect(ui.body(ben, docId)).toContainText('Second extra paragraph here.');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const next = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(next).toContainText('extra', { timeout: BIND_TIMEOUT });
  await next.getByRole('button', { name: 'Reject' }).click();
  await expect(cards(ada, 'rejected')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await closePanel(ada);
  await expect(ui.body(ben, docId), "the rejected text leaves the author's window").not.toContainText('extra', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toContainText('Second paragraph here.');
  await expect(ui.body(ada, docId)).not.toContainText('extra');
  const exported = await content(ada, docId);
  expect(exported).toContain('Second paragraph here.');
  expect(exported).not.toContain('extra');
});

test('j16-review: withdraw removes the inserted text from every view while the note stays byte-identical @p:mean-2 @p:R16 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await openIn(ben, docId, 'suggest');
  const carlPrincipal = await actors.principal('carl');
  await grantDoc(ada, docId, carlPrincipal, 'viewer');
  const carl = await actors.session(carlPrincipal);
  await openIn(carl, docId, 'review');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(3);
  // The withdraw rebuilds the author's fork, and Review remounts on a closed record (§5).
  ben.expectReconnects(1, docId);
  carl.expectReconnects(1, docId);
  const before = await content(ada, docId);

  await suggestText(ben, docId, 'original word', 8, ' plus');
  await expect(ui.body(carl, docId), 'Review shows it inline').toContainText('Keep every original plus word.', { timeout: BIND_TIMEOUT });
  await expect(ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"]`), 'Edit mode marks it').not.toHaveCount(0, { timeout: BIND_TIMEOUT });

  const own = (await openPanel(ben)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await own.getByRole('button', { name: 'Withdraw' }).click();
  await expect(cards(ben, 'withdrawn')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await closePanel(ben);

  await expect(ui.body(ben, docId), "it leaves the author's window").not.toContainText('plus', { timeout: BIND_TIMEOUT });
  await expect(ui.body(carl, docId), 'it leaves Review').not.toContainText('plus', { timeout: BIND_TIMEOUT });
  await expect(ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"]`), 'its mark leaves Edit mode').toHaveCount(0, { timeout: BIND_TIMEOUT });
  for (const actor of [ben, carl, ada]) await expect(ui.body(actor, docId)).toContainText('Keep every original word.');
  expect(await content(ada, docId), 'the note is byte-identical').toBe(before);
});

test("j16-review: a struck delete opens its card from the owner's body, and the card lists what it deletes @p:mean-2 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);

  await caret(ben, docId, 'paragraph here', 14);
  for (let i = 0; i < 4; i++) await ben.page.keyboard.press('Backspace');
  const pane = ui.pane(ben, docId);
  await expect(pane, 'acknowledged').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, 'never refused').toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });

  // The struck word in the owner's Edit-mode body is the way in to its card.
  const active = panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ACTIVE_ATTR}]`);
  await expect(async () => {
    const point = await ui.body(ada, docId).evaluate((root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf('here');
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 4);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error('no struck word');
    });
    await ada.page.mouse.click(point.x, point.y);
    await expect(active).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: BIND_TIMEOUT });
  await expect(active.locator(`[${SUGGESTION_ROW_ATTR}="delete"]`), 'the card lists the deleted word').toContainText('here', { timeout: BIND_TIMEOUT });
});

test('j16-review: struck text inside a link opens its card, not the link; a failed preview says so and can be retried @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Read the [tutorial](https://example.invalid/a) first.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);

  await caret(ben, docId, 'tutorial', 8);
  for (let i = 0; i < 6; i++) await ben.page.keyboard.press('Backspace');
  const pane = ui.pane(ben, docId);
  await expect(pane, 'acknowledged').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, 'never refused').toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });

  // Every preview fails until the route is lifted.
  const previews = '**/api/docs/*/suggestions/*/preview';
  await ada.page.route(previews, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
  const startUrl = ada.page.url();
  const active = panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ACTIVE_ATTR}]`);
  await expect(async () => {
    const point = await pointAt(ada, docId, 'torial');
    await ada.page.mouse.click(point.x, point.y);
    await expect(active).toHaveCount(1, { timeout: 1_000 });
  }).toPass({ timeout: BIND_TIMEOUT });
  expect(ada.page.url(), 'the link did not navigate').toBe(startUrl);
  await expect(ada.page.locator('iframe[src*="example.invalid"]'), 'the link did not open beside the note').toHaveCount(0);

  await expect(active.getByRole('alert'), 'the failure is said').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(active.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await ada.page.unroute(previews);
  await active.getByRole('button', { name: 'Try again' }).click();
  await expect(active.locator(`[${SUGGESTION_ROW_ATTR}="delete"]`), 'the retried preview lists the delete').toContainText('torial', { timeout: BIND_TIMEOUT });
  await expect(active.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
});

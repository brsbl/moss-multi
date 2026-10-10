// j16-review (T5.3; docs/design/suggestions.md §4, §8; PRODUCT ruling 16, 17): reviewing suggestions in the real app.
// A suggester's suggestion is listed in the peer's Suggestions panel and notifies the owner; the owner accepts it from
// the painted mark in Edit mode and both windows converge on the accepted text, then rejects the next one from the
// panel and it leaves both windows; and the author's withdraw removes the inserted text from every view, Review
// included, while the server's note stays byte-identical.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  SUGGEST_MARK_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR, SUGGESTION_ROW_ATTR,
  SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, content, mod, openIn, painted, settled as acked } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const NOTE = 'Keep every original word.\n\nSecond paragraph here.';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

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

  // Every preview is refused until the route is lifted.
  const previews = '**/api/docs/*/suggestions/*/preview';
  ada.expectHttp(429, /\/suggestions\/[^/]+\/preview$/);
  await ada.page.route(previews, (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate-limited"}' }));
  const startUrl = ada.page.url();
  const active = panel(ada).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_ACTIVE_ATTR}]`);
  // One click, once the whole strike is painted: Ben's six deletes reach Ada one by one, and a click on link text not
  // yet struck is an ordinary link click.
  const struck = () => ada.page.evaluate(() => {
    const ranges = (CSS as unknown as { highlights: Map<string, Iterable<Range>> }).highlights.get('suggest-delete');
    return ranges ? [...ranges].map((range) => range.toString()).join('') : '';
  });
  await expect.poll(struck, { timeout: BIND_TIMEOUT }).toBe('torial');
  const point = await pointAt(ada, docId, 'torial');
  await ada.page.mouse.click(point.x, point.y);
  await expect(active, 'the struck text opens its card').toHaveCount(1, { timeout: BIND_TIMEOUT });
  expect(ada.page.url(), 'the link did not navigate').toBe(startUrl);
  await expect(ada.page.locator('iframe[src*="example.invalid"]'), 'the link did not open beside the note').toHaveCount(0);

  await expect(active.getByRole('alert'), 'the failure is said').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(active.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await ada.page.unroute(previews);
  await active.getByRole('button', { name: 'Try again' }).click();
  await expect(active.locator(`[${SUGGESTION_ROW_ATTR}="delete"]`), 'the retried preview lists the delete').toContainText('torial', { timeout: BIND_TIMEOUT });
  await expect(active.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
});

test('j16-review: a word replacement reads as the word removed and the word added; a long card shows every row before Accept @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'We keep the old importer.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);

  // Ben removes "old" and types "legacy", then adds nine lines below, all in one suggestion.
  await caret(ben, docId, 'old importer', 3);
  for (let i = 0; i < 3; i++) await ben.page.keyboard.press('Backspace');
  await ben.page.keyboard.type('legacy');
  await caret(ben, docId, 'importer.', 9);
  for (let i = 1; i <= 9; i++) {
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.type(`Line ${i}`);
  }
  const pane = ui.pane(ben, docId);
  await expect(pane, 'acknowledged').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, 'never refused').toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });

  const card = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  const showAll = card.getByRole('button', { name: /Show all \d+ changes/ });
  await expect(showAll, 'a long card collapses its rows').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(card.locator(`[${SUGGESTION_ROW_ATTR}]`)).toHaveCount(8);
  await expect(card.getByRole('button', { name: 'Accept' }), 'Accept waits until every row is shown').toBeDisabled();
  await showAll.click();
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  const texts = (kind: string) => card.locator(`[${SUGGESTION_ROW_ATTR}="${kind}"] > span.min-w-0 > span:first-child`).allInnerTexts();
  expect(await texts('delete'), 'the removed word is one row').toEqual(['old']);
  const inserted = await texts('insert');
  expect(inserted, 'the added word is one row').toContain('legacy');
  expect(inserted.filter((text) => /^[legacy]+$/.test(text) && text !== 'legacy'), 'no letter of it is split off').toEqual([]);
  expect(inserted.filter((text) => text.startsWith('Line')), 'the new lines read top to bottom').toEqual(Array.from({ length: 9 }, (_, i) => `Line ${i + 1}`));

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { timeout: BIND_TIMEOUT }).toContain('We keep the legacy importer.');
  expect(await content(ada, docId)).toContain('Line 9');
});

test('j16-review: a code-block edit reads as its changed line before and after, never as character fragments @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Code below.\n\n```js\nconsole.log(x)\n```');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  await ben.observeEditor(docId);
  await ui.body(ben, docId).locator('.moss-codeblock-pre').click();
  const field = ui.body(ben, docId).getByPlaceholder('Enter code...');
  await expect(field).toBeVisible();
  await field.fill('console.debug(y)');
  await expect(field).toHaveValue('console.debug(y)');
  await acked(ben, docId, 'the code edit');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });

  const card = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  const rows = card.locator(`[${SUGGESTION_ROW_ATTR}]`);
  await expect(rows, 'one row for the one changed line').toHaveCount(1);
  await expect(rows.first()).toHaveAttribute(SUGGESTION_ROW_ATTR, 'change');
  expect(await rows.first().locator('> span.min-w-0 > span:first-child').innerText(), 'the row reads the new line whole').toBe('console.debug(y)');
  const row = await rows.first().innerText();
  expect(row, 'a separator, then the label').toContain('console.debug(y) — block content');
  expect(row, 'the old line, whole').toContain('"console.log(x)"');

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { timeout: BIND_TIMEOUT }).toContain('console.debug(y)');
});

/** The open card's inserted and deleted row texts, once its preview has loaded. */
async function cardRows(actor: Actor): Promise<{ card: Locator; inserted: string[]; deleted: string[] }> {
  const card = (await openPanel(actor)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  const texts = (kind: string) => card.locator(`[${SUGGESTION_ROW_ATTR}="${kind}"] > span.min-w-0 > span:first-child`).allInnerTexts();
  return { card, inserted: await texts('insert'), deleted: await texts('delete') };
}

test("j16-review: a strike, then Backspace at the block's start, keeps the strike through the join, its undo and redo and the strike's, the card and accept @p:mean-2 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  // Backspace after "a" strikes it; Backspace at the block's start joins the paragraphs without it.
  await caret(ben, docId, 'abc tail.', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the join');
  await expect(body, 'joined, without the struck "a"').toContainText('Intro line stays.bc tail.');
  await expect(body).not.toContainText('abc');

  // Undo takes the join back and the strike stands; redo joins again.
  await keyboard.press(`${mod}+z`);
  await acked(ben, docId, 'the undo');
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));
  await expect.poll(blocks, { message: 'split again, without the struck "a"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'bc tail.', 'Closing line stays too.']);
  // Undo of the strike brings the "a" back; redo strikes it again, then joins again.
  await keyboard.press(`${mod}+z`);
  await acked(ben, docId, 'the undo of the strike');
  await expect.poll(blocks, { message: 'the "a" is back', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'abc tail.', 'Closing line stays too.']);
  await keyboard.press(`${mod}+Shift+z`);
  await acked(ben, docId, 'the redo of the strike');
  await expect.poll(blocks, { message: 'the strike again', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'bc tail.', 'Closing line stays too.']);
  await keyboard.press(`${mod}+Shift+z`);
  await acked(ben, docId, 'the redo');
  await expect.poll(blocks, { message: 'joined again', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.bc tail.', 'Closing line stays too.']);
  await expect(body).not.toContainText('abc');

  // The owner's Edit-mode body paints the old block struck, and the card adds the moved text without the "a".
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await painted(ada, 'suggest-delete')).join(''), { message: 'the old block paints struck', timeout: BIND_TIMEOUT }).toContain('bc tail.');
  const { card, inserted, deleted } = await cardRows(ada);
  expect(inserted.join(''), 'the card adds the moved text without the struck "a"').toBe('bc tail.');
  expect(deleted.join(' '), 'the card removes the old block').toContain('abc tail.');

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'the accepted note', timeout: BIND_TIMEOUT }).toContain('Intro line stays.bc tail.');
  const accepted = await content(ada, docId);
  expect(accepted, 'the struck "a" is gone').not.toContain('abc');
  expect(accepted, 'unstruck text stays').toContain('Closing line stays too.');
  await expect(ui.body(ada, docId)).toContainText('Intro line stays.bc tail.', { timeout: BIND_TIMEOUT });
});

test('j16-review: a whole list item struck, then Backspace once more, leaves the item text out of the card and of the accepted note @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, '- alpha item\n- beta item\n- gamma item');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  await caret(ben, docId, 'beta item', 'beta item'.length);
  for (let i = 0; i < 'beta item'.length; i++) await keyboard.press('Backspace');
  await acked(ben, docId, 'the strikes');
  await expect.poll(async () => (await painted(ben, 'suggest-delete')).join(''), { message: 'the item paints struck', timeout: BIND_TIMEOUT }).toBe('beta item');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the unwrap');
  await expect(body, 'the struck item text stays out').not.toContainText('beta');
  await expect(body).toContainText('alpha item');
  await expect(body).toContainText('gamma item');

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await painted(ada, 'suggest-delete')).join(''), { message: 'the owner sees it struck', timeout: BIND_TIMEOUT }).toContain('beta item');
  const { card, inserted } = await cardRows(ada);
  expect(inserted.join(' '), 'the card adds no struck text').not.toContain('beta');

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept removes the item text', timeout: BIND_TIMEOUT }).not.toContain('beta');
  const accepted = await content(ada, docId);
  expect(accepted).toContain('alpha item');
  expect(accepted).toContain('gamma item');
});

test('j16-review: adjacent strikes made right to left, a join, then full undo and redo, keep the characters in order through accept @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  // After "b": Backspace strikes "b", then "a", then joins.
  await caret(ben, docId, 'abc tail.', 2);
  for (let i = 0; i < 3; i++) {
    await keyboard.press('Backspace');
    await acked(ben, docId, `Backspace ${i + 1}`);
  }
  await expect.poll(blocks, { message: 'joined without "a" and "b"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.c tail.', 'Closing line stays too.']);
  const rounds: [string, string[]][] = [
    [`${mod}+z`, ['Intro line stays.', 'abc tail.', 'Closing line stays too.']],
    [`${mod}+Shift+z`, ['Intro line stays.c tail.', 'Closing line stays too.']],
    [`${mod}+z`, ['Intro line stays.', 'abc tail.', 'Closing line stays too.']],
  ];
  for (const [key, expected] of rounds) {
    for (let i = 0; i < 3; i++) {
      await keyboard.press(key);
      await acked(ben, docId, `${key} ${i + 1}`);
    }
    await expect.poll(blocks, { message: `${key} three times, in order`, timeout: BIND_TIMEOUT }).toEqual(expected);
  }

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card } = await cardRows(ada);
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept lands the original text', timeout: BIND_TIMEOUT }).toContain('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
});

test('j16-review: Backspace beside an empty paragraph removes only that paragraph, and strikes either side of live text stay acceptable @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line here.\n\na**b**c tail.\n\nClosing line too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  await caret(ben, docId, 'Intro line here.', 'Intro line here.'.length);
  await keyboard.press('Enter');
  await acked(ben, docId, 'the empty paragraph');
  await expect.poll(blocks, { timeout: BIND_TIMEOUT }).toEqual(['Intro line here.', '', 'abc tail.', 'Closing line too.']);
  await caret(ben, docId, 'c tail.', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "c"');
  await caret(ben, docId, 'a', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "a"');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the Backspace at the block start');
  await expect.poll(blocks, { message: 'only the empty paragraph went', timeout: BIND_TIMEOUT }).toEqual(['Intro line here.', 'abc tail.', 'Closing line too.']);
  await expect.poll(async () => (await painted(ben, 'suggest-delete')).sort(), { message: 'both strikes still paint', timeout: BIND_TIMEOUT }).toEqual(['a', 'c']);

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card } = await cardRows(ada);
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept removes only the struck characters', timeout: BIND_TIMEOUT }).toContain('Intro line here.\n\n**b** tail.\n\nClosing line too.');
});

/** A real text/html paste at the caret. */
const pasteHtml = (actor: Actor, docId: string, html: string, plain: string): Promise<void> =>
  ui.body(actor, docId).evaluate((element, [h, p]) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', p);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [html, plain] as const);

const PASTES = [
  ["at the block's start, pasting the struck character itself", 1, '<p>a</p><p>x</p>', 'a\n\nx', ['Intro line stays.', 'a', 'xbc tail.', 'Closing line stays too.']],
  ['just before the struck character, pasting the same character', 2, '<p>b</p><p>x</p>', 'b\n\nx', ['Intro line stays.', 'ab', 'xc tail.', 'Closing line stays too.']],
] as const;

for (const [label, offset, html, plain, expected] of PASTES) {
  test(`j16-review: a paste ${label} keeps the pasted text and leaves the struck one out, through the card and accept @p:mean-2 @p:R17`, async ({ actors }) => {
    const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
    await openIn(ben, docId, 'suggest');
    await openIn(ada, docId, 'edit');
    await actors.requireDistinct(2);
    const body = ui.body(ben, docId);
    const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

    // Backspace strikes the character before the caret and leaves the caret before it; the paste lands there.
    await caret(ben, docId, 'abc tail.', offset);
    await ben.page.keyboard.press('Backspace');
    await acked(ben, docId, 'the strike');
    await pasteHtml(ben, docId, html, plain);
    await acked(ben, docId, 'the paste');
    await expect.poll(blocks, { message: 'the pasted text stays; the struck character stays out of the moved block', timeout: BIND_TIMEOUT }).toEqual([...expected]);

    await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
    const { card } = await cardRows(ada);
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
    await expect.poll(() => content(ada, docId), { message: 'accept lands the pasted text without the struck character', timeout: BIND_TIMEOUT })
      .toContain(expected.join('\n\n'));
  });
}

test("j16-review: a strike, then the '==' highlight shortcut around it, keeps the struck character out of the highlight, the card and accept @p:mean-2 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  await caret(ben, docId, 'abc tail.', 2);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "b"');
  await caret(ben, docId, 'abc tail.', 0);
  await keyboard.type('==');
  await acked(ben, docId, 'the opening "=="');
  await caret(ben, docId, '==abc tail.', 5);
  // The closing "=" triggers moss's highlight transformer, which replaces "==abc==" with a new highlighted node.
  await keyboard.type('==');
  await acked(ben, docId, 'the highlight');
  await expect.poll(blocks, { message: 'highlighted, without the struck "b"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'ac tail.', 'Closing line stays too.']);

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card, inserted } = await cardRows(ada);
  expect(inserted.join('|'), 'the card adds no struck text').not.toContain('b');
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept lands the highlight without the struck "b"', timeout: BIND_TIMEOUT })
    .toContain('Intro line stays.\n\n==ac== tail.\n\nClosing line stays too.');
});

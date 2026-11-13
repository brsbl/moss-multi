// j16-review (T5.3; docs/design/suggestions.md §4, §8; PRODUCT ruling 16, 17): reviewing suggestions in the real app.
// A suggester's suggestion is listed in the peer's Suggestions panel and notifies the owner; the owner accepts it from
// the painted mark in Edit mode and both windows converge on the accepted text, then rejects the next one from the
// panel and it leaves both windows; and the author's withdraw removes the inserted text from every view, Review
// included, while the server's note stays byte-identical. Reject and Withdraw ask first, so two clicks on a marker
// never reject.
import type { Actor } from '../lib/actors.ts';
import {
  BODY_BINDING_ATTR, EDIT_MODE_ATTR, FLOATING_TOOLBAR_ATTR, REVIEW_BAND_ATTR, SUGGEST_MARK_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTION_ACTIVE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ID_ATTR, SUGGESTION_ROW_ATTR,
  SUGGESTION_STATUS_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import {
  BIND_TIMEOUT, button, caret, cards, closePanel, confirmation, confirmClose, content, openIn, openPanel, panel, settled as acked, sharedNote,
} from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

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
  await confirmClose(ada, next, 'Reject');
  await expect(cards(ada, 'rejected')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await closePanel(ada);
  await expect(ui.body(ben, docId), "the rejected text leaves the author's window").not.toContainText('extra', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toContainText('Second paragraph here.');
  await expect(ui.body(ada, docId)).not.toContainText('extra');
  const exported = await content(ada, docId);
  expect(exported).toContain('Second paragraph here.');
  expect(exported).not.toContain('extra');
});

test('j16-review: two clicks on a marker never reject; Reject asks first, Cancel and Escape keep the suggestion, and confirming closes it for everyone @p:mean-2 @p:R17', async ({ actors }) => {
  // At 1440 px this line puts the marker after "opening" where the list then shows Reject.
  const { ada, ben, docId } = await sharedNote(actors, 'Keep every original word in this opening line of the note.\n\nSecond paragraph here.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  // The confirmed reject closes the author's own record, which rebuilds his fork (§5).
  ben.expectReconnects(1, docId);
  await suggestText(ben, docId, 'this opening', 12, ' plus');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const mark = ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"][${SUGGESTION_ID_ATTR}]`).first();
  await expect(mark).toBeAttached({ timeout: BIND_TIMEOUT });
  const reject = confirmation(ada, 'Reject');

  // A double click on the marker, fast and slow: the second click at worst opens the confirmation, on Cancel.
  for (const gap of [250, 700]) {
    await closePanel(ada);
    const box = (await mark.boundingBox())!;
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const first = Date.now();
    await ada.page.mouse.click(point.x, point.y);
    await expect(panel(ada)).toBeVisible();
    const under = await ada.page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.textContent?.trim() ?? '', point);
    await ada.page.waitForTimeout(Math.max(0, gap - (Date.now() - first)));
    await ada.page.mouse.click(point.x, point.y);
    test.info().annotations.push({ type: 'second click', description: `${gap} ms: ${under || 'no button'}` });
    if (under === 'Reject') {
      await expect(reject, `${gap} ms: the second click on Reject asks first`).toBeVisible();
      await expect(reject.getByRole('button', { name: 'Cancel' }), 'the dialog opens on Cancel').toBeFocused();
      await ada.page.keyboard.press('Escape');
      await expect(reject).toBeHidden();
    }
    await ada.page.waitForTimeout(500);
    await expect(button(ada), `${gap} ms: the suggestion is still open`).toHaveAttribute('aria-label', /1 open/);
    await expect(cards(ada, 'rejected')).toHaveCount(0);
  }

  // From the list: Reject asks, naming the author; Escape and Cancel keep the suggestion.
  const card = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  for (const dismiss of ['Escape', 'Cancel'] as const) {
    await card.getByRole('button', { name: 'Reject' }).click();
    await expect(reject).toBeVisible();
    await expect(reject).toContainText(/Ben.*['’]s proposed change will be discarded for everyone\. This action cannot be undone\./);
    await expect(reject.getByRole('button', { name: 'Cancel' }), 'the dialog opens on Cancel').toBeFocused();
    const dialogBox = (await reject.boundingBox())!;
    const onTop = await ada.page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[role="alertdialog"]'),
      { x: dialogBox.x + dialogBox.width / 2, y: dialogBox.y + dialogBox.height / 2 });
    expect(onTop, 'the dialog paints above the list').toBe(true);
    if (dismiss === 'Escape') await ada.page.keyboard.press('Escape');
    else await reject.getByRole('button', { name: 'Cancel' }).click();
    await expect(reject).toBeHidden();
    await expect(panel(ada), 'the list stays open under the dialog').toBeVisible();
    await expect(card, `${dismiss} keeps the suggestion`).toHaveCount(1);
  }
  await expect(ui.body(ben, docId)).toContainText('this opening plus line');

  await confirmClose(ada, card, 'Reject');
  await expect(cards(ada, 'rejected')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId), "the rejected text leaves the author's window").not.toContainText('plus', { timeout: BIND_TIMEOUT });
  await expect(ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"]`), 'its mark leaves Edit mode').toHaveCount(0, { timeout: BIND_TIMEOUT });
  await closePanel(ada);
});

test('j16-review: Review is offered only while a suggestion is open; Done and Escape leave it, and deciding the last one returns the owner to editing @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  const carlPrincipal = await actors.principal('carl');
  await grantDoc(ada, docId, carlPrincipal, 'viewer');
  const carl = await actors.session(carlPrincipal);
  const pane = ui.pane(ada, docId);
  await openIn(ada, docId, 'edit');
  await openIn(carl, docId, 'review');
  const review = (actor: Actor) => actor.page.getByRole('button', { name: 'Review suggestions' });
  const band = ada.page.locator(`[${REVIEW_BAND_ATTR}]`);
  const blur = () => ada.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // No suggestion yet: no Suggestions button and no Review control for anyone, and Escape changes nothing.
  await expect(button(ada), 'no Suggestions button on a note without suggestions').toHaveCount(0);
  await expect(review(ada), 'no Review control without an open suggestion').toHaveCount(0);
  await expect(button(carl)).toHaveCount(0);
  await expect(review(carl), "a viewer's top bar has no Review button").toHaveCount(0);
  await ada.page.keyboard.press('Escape');
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit');
  await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live');

  await openIn(ben, docId, 'suggest');
  await actors.requireDistinct(3);
  // Entering and leaving Review remounts the owner's body on a fresh socket each time (§5): three entries, three exits.
  ada.expectReconnects(6, docId);
  // The accept closes the author's own record, which rebuilds his fork.
  ben.expectReconnects(1, docId);
  carl.expectReconnects(1, docId);
  await suggestText(ben, docId, 'original word', 8, ' plus');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect(review(ada), 'one open suggestion offers Review').toBeVisible();
  await expect(review(ada)).toHaveAttribute('aria-pressed', 'false');
  for (const control of [review(ada), button(ada)]) expect(await control.getAttribute('title'), 'a Moss tooltip, not a title').toBeNull();
  await review(ada).hover();
  await expect(ada.page.getByRole('tooltip').filter({ hasText: /^Review suggestions$/ }), "Moss's tooltip names it").toBeVisible();
  await button(ada).hover();
  await expect(ada.page.getByRole('tooltip').filter({ hasText: /^Suggestions$/ })).toBeVisible();

  // The viewer stays in Review; only the list's header switch is theirs.
  await expect(ui.pane(carl, docId)).toHaveAttribute(EDIT_MODE_ATTR, 'review');
  await expect(review(carl)).toHaveCount(0);
  const header = (await openPanel(carl)).getByRole('button', { name: 'Review', exact: true });
  await expect(header, "the viewer's list offers the switch, pressed").toHaveAttribute('aria-pressed', 'true');
  await closePanel(carl);

  const enter = async () => {
    await review(ada).click();
    await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
    await expect(band, 'the band says why typing does nothing').toHaveText('Reviewing suggestions. Click a change to accept or reject it. Editing is paused. Done');
    await expect(review(ada)).toHaveAttribute('aria-pressed', 'true');
  };
  const left = async (how: string) => {
    await expect(pane, how).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
    await expect(band).toHaveCount(0);
  };

  await enter();
  await ada.page.mouse.move(0, 0);
  await blur();
  await ada.page.keyboard.type('zz');
  await expect(ui.body(ada, docId), 'typing in Review changes nothing').not.toContainText('zz');
  expect(await content(ada, docId)).not.toContain('zz');
  await ada.page.keyboard.press('Escape');
  await left('Escape leaves Review');
  await caret(ada, docId, 'Second paragraph', 0);
  await expect(ada.page.locator(`[${FLOATING_TOOLBAR_ATTR}]`), 'the toolbar is back').toBeVisible({ timeout: BIND_TIMEOUT });

  await enter();
  await band.getByRole('button', { name: 'Done' }).click();
  await left('Done leaves Review');

  // Accepting the last open suggestion in Review returns the owner to editing, and the next one does not bring it back.
  await enter();
  const card = (await openPanel(ada)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect(pane, 'back to editing within a second').toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: 1_000 });
  await closePanel(ada);
  await left('the last decision leaves Review');
  await expect(review(ada), 'nothing left to review').toHaveCount(0);
  await expect(button(ada), 'the reviewed suggestion keeps the list').toBeVisible();

  await suggestText(ben, docId, 'Second paragraph', 6, ' extra');
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect(review(ada)).toHaveAttribute('aria-pressed', 'false');
  await ada.page.waitForTimeout(500);
  await expect(pane, "a colleague's next suggestion leaves the owner editing").toHaveAttribute(EDIT_MODE_ATTR, 'edit');
  await expect(ui.pane(carl, docId), "the viewer's mode never moved").toHaveAttribute(EDIT_MODE_ATTR, 'review');
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
  // Withdraw asks first; Escape and Cancel keep the suggestion.
  const withdraw = confirmation(ben, 'Withdraw');
  for (const dismiss of ['Escape', 'Cancel'] as const) {
    await own.getByRole('button', { name: 'Withdraw' }).click();
    await expect(withdraw).toBeVisible();
    await expect(withdraw).toContainText('Your proposed change will be discarded. This action cannot be undone.');
    await expect(withdraw.getByRole('button', { name: 'Cancel' }), 'the dialog opens on Cancel').toBeFocused();
    if (dismiss === 'Escape') await ben.page.keyboard.press('Escape');
    else await withdraw.getByRole('button', { name: 'Cancel' }).click();
    await expect(withdraw).toBeHidden();
    await expect(own, `${dismiss} keeps the suggestion`).toHaveCount(1);
    await expect(panel(ben), 'the list stays open under the dialog').toBeVisible();
  }
  await expect(ui.body(carl, docId)).toContainText('Keep every original plus word.');
  await confirmClose(ben, own, 'Withdraw');
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

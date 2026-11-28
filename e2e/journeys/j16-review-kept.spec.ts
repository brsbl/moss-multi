// j16-review-kept (T5.S15; docs/design/suggestions.md §4, T5.S14): a Review window left open while the owner accepts,
// in another window, a suggestion whose accept keeps the originals reads as the stored note afterwards, without a
// reload: Review remounts on a fresh composite, as the author's fork rebuilds.
import type { Actor } from '../lib/actors.ts';
import {
  BODY_BINDING_ATTR, EDIT_MODE_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, content, openIn, painted, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

test('j16-review-kept: a Review window left open across an accept that keeps the originals shows the note as it now is, without a reload @p:mean-2 @p:R17', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const created = await ada.context.request.post('/api/docs', {
    headers: { origin: new URL(ada.page.url()).origin },
    data: { markdown: 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.' },
  });
  expect(created.status()).toBe(201);
  const docId = ((await created.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  // Ben's fork rebuilds on the kept accept (T5.S14); the Review window switches mode once and remounts once on it.
  ben.expectReconnects(1, docId);
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  const review = await actors.sameAs(ada);
  review.expectReconnects(2, docId);
  await openIn(review, docId, 'edit');
  await review.page.getByRole('button', { name: 'Review suggestions' }).click();
  await expect(ui.pane(review, docId)).toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
  await expect(ui.body(review, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
  await actors.requireDistinct(2);
  const blocks = (actor: Actor) => ui.body(actor, docId).evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));
  const expected = ['Intro line stays.', 'ab', 'xc tail.', 'Closing line stays too.'];

  // The pasted "b" reads as the struck one restored, so accept keeps the original "b" and removes the pasted copy.
  await caret(ben, docId, 'abc tail.', 2);
  await ben.page.keyboard.press('Backspace');
  await settled(ben, docId, 'the strike');
  await ui.body(ben, docId).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/html', '<p>b</p><p>x</p>');
    data.setData('text/plain', 'b\n\nx');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  await settled(ben, docId, 'the paste');
  await expect.poll(() => blocks(review), { message: 'Review shows the suggestion', timeout: BIND_TIMEOUT }).toEqual(expected);
  await expect.poll(() => painted(review, 'suggest-insert'), { message: 'Review paints it', timeout: BIND_TIMEOUT }).not.toEqual([]);

  // The owner accepts from her Suggestions panel.
  await expect(ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`).click();
  const panel = ada.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
  const card = panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="accepted"]`)).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'the accepted note', timeout: BIND_TIMEOUT }).toContain(expected.join('\n\n'));

  // The Review window, never reloaded, takes the accept (nothing left to paint) and reads as the stored note.
  await expect.poll(async () => [...await painted(review, 'suggest-insert'), ...await painted(review, 'suggest-delete')], { message: 'Review took the accept', timeout: BIND_TIMEOUT }).toEqual([]);
  await expect.poll(() => blocks(review), { message: 'Review shows the note as it now is', timeout: BIND_TIMEOUT }).toEqual(expected);
  await expect(ui.pane(review, docId)).toHaveAttribute(EDIT_MODE_ATTR, 'review');
  const stored = (await content(ada, docId)).trim();
  expect((await blocks(review)).join('\n\n'), "Review's text is the stored note's export").toBe(stored);
});

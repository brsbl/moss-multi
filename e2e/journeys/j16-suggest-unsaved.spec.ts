// j16-suggest-unsaved (T9.51; docs/design/suggestions.md §5 refusal path): the card that offers back what a closed
// suggestion could not keep is the only copy of that text. The refusal rebuilds the note and puts the caret back in it,
// so Moss's docked toolbar shows and the card stands above it. One real press on each of the card's actions works
// with the caret in the note (the press must not take focus: the toolbar would go and the card drop away under the
// pointer), and with the caret out of it.
import type { Actor } from '../lib/actors.ts';
import type { Locator } from '@playwright/test';
import { BODY_BINDING_ATTR, BOTTOM_REGION_ATTR, NAMES, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { BIND_TIMEOUT, caret, frames, openIn, settled, sharedNote } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** The paragraph as it stood in his window when the suggestion was closed. */
const TYPED = 'Draft line one. Online words. Offline words.';
const SENTENCE = 'This suggestion was closed while you typed, so your last changes were not saved.';

/**
 * Ben suggests " Online words." (acknowledged), loses his connection, types " Offline words." in the same paragraph,
 * and Ada rejects his suggestion meanwhile. When he is back, the card holds what was not saved and the note is live.
 */
async function closedWhileTyped(actors: Actors) {
  const { ada, ben, docId } = await sharedNote(actors, 'Draft line one.\n\nDraft line two.', { severable: true });
  ben.expectReconnects(8);
  await openIn(ben, docId);
  await caret(ben, docId, 'Draft line one.', 15);
  await ben.page.keyboard.type(' Online words.');
  await settled(ben, docId, 'the online suggestion');

  const sever = ben.sever!;
  sever.reset();
  await ben.page.keyboard.type(' Offline words.');
  await expect(ui.pane(ben, docId), 'the offline text is unacked').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  const origin = new URL(ada.page.url()).origin;
  const listed = (await (await ada.context.request.get(`/api/docs/${docId}/suggestions`)).json()) as { suggestions: { id: string }[] };
  expect(listed.suggestions.length, 'his suggestion is open').toBe(1);
  const rejected = await ada.context.request.post(`/api/docs/${docId}/suggestions/${listed.suggestions[0].id}/reject`, { headers: { origin }, data: {} });
  expect(rejected.status(), 'the owner rejects it').toBe(200);
  sever.reset();
  sever.restore();

  const card = ben.page.locator(`[${NAMES.suggestUnsaved}]`);
  await expect(card, 'the unsaved text is offered back').toContainText(SENTENCE, { timeout: 45_000 });
  const body = ui.body(ben, docId);
  await expect(body).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  const caretInNote = () => body.evaluate((element) => element.contains(document.activeElement));
  return { ben, docId, card, caretInNote };
}

/** One press on Show text shows exactly what he typed. */
async function showText(card: Locator): Promise<void> {
  await card.getByRole('button', { name: 'Show text', exact: true }).click();
  const shown = card.locator('pre');
  await expect(shown, 'one press shows the text').toHaveText(TYPED);
  expect(await shown.textContent(), 'the card shows exactly what he typed').toBe(TYPED);
  await expect(card.getByRole('button', { name: 'Hide text', exact: true })).toBeVisible();
}

/** One press on Dismiss removes the card and none of the text stays on the page. */
async function dismiss(actor: Actor, card: Locator): Promise<void> {
  await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(card, 'one press dismisses it').toHaveCount(0);
  await expect(actor.page.locator('body'), 'none of the unsaved text is left on the page').not.toContainText('Offline words.');
}

test('j16-suggest-unsaved: with the caret back in the note, one press shows what a closed suggestion could not keep, one copies it and one dismisses it @p:mean-2 @p:R17', async ({ actors, browserName }) => {
  const { ben, docId, card, caretInNote } = await closedWhileTyped(actors);
  await expect.poll(caretInNote, { message: 'his caret is back in the note', timeout: BIND_TIMEOUT }).toBe(true);
  await frames(ben);
  const region = ui.pane(ben, docId).locator(`[${BOTTOM_REGION_ATTR}]`);
  const edge = async () => {
    const box = await region.boundingBox();
    expect(box, 'the bottom region is laid out').not.toBeNull();
    return box!.y + box!.height;
  };
  const before = await edge();
  if (browserName === 'chromium') await ben.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(ben.page.url()).origin });

  await showText(card);
  expect(Math.abs((await edge()) - before), 'nothing moved under the pointer').toBeLessThan(1);

  await card.getByRole('button', { name: 'Copy what wasn’t saved', exact: true }).click();
  const copied = card.getByRole('button', { name: 'Copied', exact: true });
  const refused = card.getByText('Couldn’t copy. Select the text to copy it.', { exact: true });
  if (browserName === 'chromium') {
    await expect(copied, 'one press copies').toBeVisible();
    await expect(refused).toHaveCount(0);
    expect(await ben.page.evaluate(() => navigator.clipboard.readText()), 'the clipboard holds exactly what he typed').toBe(TYPED);
  } else {
    // WebKit's clipboard cannot be read back here: the card says it copied, or that it could not and keeps the text.
    await expect(copied.or(refused), 'one press copies, or says it could not').toBeVisible();
    const outcome = (await copied.isVisible()) ? 'Copied' : 'Couldn’t copy';
    test.info().annotations.push({ type: 'webkit copy', description: outcome });
    if (outcome !== 'Copied') expect(await card.locator('pre').textContent(), 'the text stays shown to select').toBe(TYPED);
  }

  await dismiss(ben, card);
});

test('j16-suggest-unsaved: with the caret out of the note, one press shows the text and one dismisses it @p:mean-2 @p:R17', async ({ actors }) => {
  const { ben, card, caretInNote } = await closedWhileTyped(actors);
  await card.getByText(SENTENCE, { exact: true }).click();
  await expect.poll(caretInNote, { message: 'a press on the card’s words takes the caret out of the note', timeout: BIND_TIMEOUT }).toBe(false);
  await frames(ben);

  await showText(card);
  await dismiss(ben, card);
});

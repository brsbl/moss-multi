// j16-review-race (T8.2; PRODUCT ruling 16): a review sent while its card's preview is still on the way leaves no
// refused preview behind. On staging the preview often reached the server after the withdraw closed the record, and
// its answer was a 409; here a route holds it until then. Its own group keeps j16-review's shard under budget.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import {
  SUGGEST_MARK_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR,
  SUGGESTIONS_PANEL_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, openIn } from '../lib/suggest.ts';
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

/** Ada's note, Ben a suggester on it (declared setup). */
async function sharedNote(actors: Actors) {
  const ada = await actors.open(await actors.principal('ada'));
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown: NOTE } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  return { ada, ben, docId };
}

const panel = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
const cards = (actor: Actor, status: string): Locator => panel(actor).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="${status}"]`);

async function openPanel(actor: Actor): Promise<Locator> {
  if (!(await panel(actor).isVisible())) await actor.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`).click();
  await expect(panel(actor)).toBeVisible();
  return panel(actor);
}

async function closePanel(actor: Actor): Promise<void> {
  if (await panel(actor).isVisible()) await actor.page.keyboard.press('Escape');
  await expect(panel(actor)).toBeHidden();
}

test("j16-review-race: a withdraw sent while the card's preview is still on the way leaves no refused preview behind @p:R16", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  ben.expectReconnects(1, docId);
  await suggestText(ben, docId, 'original word', 8, ' plus');
  await expect(ada.page.locator(`[${SUGGEST_MARK_ATTR}="insert"]`)).not.toHaveCount(0, { timeout: BIND_TIMEOUT });

  // Staging's latency, made certain: the card's preview reaches the server only after the withdraw has closed the
  // record. Its answer would then be a 409 for a suggestion that is no longer open.
  const PREVIEW = /\/suggestions\/[^/]+\/preview$/;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let caught = () => {};
  const intercepted = new Promise<void>((resolve) => { caught = resolve; });
  await ben.page.route(PREVIEW, async (route) => {
    caught();
    await held;
    await route.continue().catch(() => undefined);
  });
  // The held preview ends either dropped by the page (aborted) or answered by the server.
  const ended = new Promise<{ status: number | null }>((resolve) => {
    ben.page.on('requestfailed', (request) => { if (PREVIEW.test(request.url())) resolve({ status: null }); });
    ben.page.on('response', (response) => { if (PREVIEW.test(response.url())) resolve({ status: response.status() }); });
  });
  const own = (await openPanel(ben)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await intercepted;
  await own.getByRole('button', { name: 'Withdraw' }).click();
  await expect(cards(ben, 'withdrawn')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  release();
  const outcome = await Promise.race([ended, ben.page.waitForTimeout(15_000).then(() => 'pending' as const)]);
  expect(outcome, 'the held preview ends').not.toBe('pending');
  if (outcome !== 'pending') expect(outcome.status, 'dropped, or answered without a 409').not.toBe(409);
  await ben.page.unroute(PREVIEW);
  await closePanel(ben);
  await expect(ui.body(ben, docId), "it leaves the author's window").not.toContainText('plus', { timeout: BIND_TIMEOUT });
});

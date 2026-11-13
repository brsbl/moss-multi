// Suggest-mode journey helpers shared by j16-suggest, j16-review and the strike census (docs/design/suggestions.md §5).
import type { Locator } from '@playwright/test';
import type { Actor } from './actors.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_ROW_ATTR, SUGGESTION_STATUS_ATTR,
  SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR, SYNC_UNACKED_ATTR,
} from './contract.ts';
import { grantDoc } from './grants.ts';
import { expect, test, ui } from './test.ts';

export const BOOT_TIMEOUT = 30_000;
export const BIND_TIMEOUT = 15_000;
export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

export const frames = (actor: Actor) => actor.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** The note's export; `view` names an alternative view (`working`). */
export const content = async (actor: Actor, docId: string, view = ''): Promise<string> =>
  (await actor.context.request.get(`/api/docs/${docId}/content${view ? `?view=${view}` : ''}`)).text();

/** Puts the caret (or, with `length`, a selection) inside the first body text node holding `text`, at `offset`. */
export async function caret(actor: Actor, docId: string, text: string, offset: number, length = 0): Promise<void> {
  const body = ui.body(actor, docId);
  await body.evaluate((root, { text, offset, length }) => {
    (root as HTMLElement).focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at + offset);
      range.setEnd(node, at + offset + length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`no body text "${text}"`);
  }, { text, offset, length });
  // Lexical reads the selection on selectionchange.
  await frames(actor);
}

/** Opens `docId` in a fresh page load and waits for `mode` to go live (or read-only for Review). */
export async function openIn(actor: Actor, docId: string, mode: 'suggest' | 'review' | 'edit' = 'suggest'): Promise<Locator> {
  await actor.goto(`/d/${docId}`);
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const pane = ui.pane(actor, docId);
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, mode, { timeout: BIND_TIMEOUT });
  await expect(ui.body(actor, docId)).toHaveAttribute(BODY_BINDING_ATTR, mode === 'review' ? 'readonly' : 'live', { timeout: BIND_TIMEOUT });
  return pane;
}

/** The ranges painted `::highlight(name)` in this page, as their text. */
export const painted = (actor: Actor, name: string): Promise<string[]> =>
  actor.page.evaluate((highlight) => [...((CSS as unknown as { highlights?: Map<string, Set<Range>> }).highlights?.get(highlight) ?? [])].map((range) => range.toString()), name);

/** Everything sent is acknowledged and nothing was refused. */
export async function settled(actor: Actor, docId: string, what: string): Promise<void> {
  const pane = ui.pane(actor, docId);
  await expect(pane, `${what}: acknowledged`).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(pane, `${what}: never refused`).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
}

// The Suggestions list, as j16-review and j16-review-strikes drive it.
const NOTE = 'Keep every original word.\n\nSecond paragraph here.';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** A note owned by ada that ben can suggest on. */
export async function sharedNote(actors: Actors, markdown = NOTE) {
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

export const button = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`);
export const panel = (actor: Actor): Locator => actor.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
export const cards = (actor: Actor, status?: string): Locator =>
  panel(actor).locator(status ? `[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="${status}"]` : `[${SUGGESTION_CARD_ATTR}]`);

export async function openPanel(actor: Actor): Promise<Locator> {
  if (!(await panel(actor).isVisible())) await button(actor).click();
  await expect(panel(actor)).toBeVisible();
  return panel(actor);
}

export async function closePanel(actor: Actor): Promise<void> {
  if (await panel(actor).isVisible()) await actor.page.keyboard.press('Escape');
  await expect(panel(actor)).toBeHidden();
}

/** The confirmation Reject or Withdraw opens before anything is sent. */
export const confirmation = (actor: Actor, action: 'Reject' | 'Withdraw'): Locator =>
  actor.page.getByRole('alertdialog', { name: `${action} suggestion?` });

/** Presses `action` on `card` and confirms it in the dialog it opens. */
export async function confirmClose(actor: Actor, card: Locator, action: 'Reject' | 'Withdraw'): Promise<void> {
  await card.getByRole('button', { name: action, exact: true }).click();
  const dialog = confirmation(actor, action);
  await expect(dialog, `${action} asks first`).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' }), 'the dialog opens on Cancel').toBeFocused();
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

/** The open card's inserted and deleted row texts, once its preview has loaded. */
export async function cardRows(actor: Actor): Promise<{ card: Locator; inserted: string[]; deleted: string[] }> {
  const card = (await openPanel(actor)).locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
  await expect(card).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect(card.getByRole('button', { name: 'Accept' })).toBeEnabled({ timeout: BIND_TIMEOUT });
  const texts = (kind: string) => card.locator(`[${SUGGESTION_ROW_ATTR}="${kind}"] > span.min-w-0 > span:first-child`).allInnerTexts();
  return { card, inserted: await texts('insert'), deleted: await texts('delete') };
}

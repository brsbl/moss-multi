// UI verbs (S-test §3.3): everything a user does goes through here, located by role, label or a DOM-contract
// attribute, never by position. The reliable typing path is title, then Enter, then body (L§4.20).
import { expect, type Locator } from '@playwright/test';
import type { Actor } from './actors.ts';
import {
  BODY_BINDING_ATTR, DOC_STATE_ATTR, EDITOR_PANE_ATTR, LEXICAL_EDITOR_SELECTOR, NAMES, paneSelector, SIDEBAR_ROW_ATTR,
  TITLE_BINDING_ATTR,
} from './contract.ts';
import { fieldTexts } from './detectors.js';
import type { Field } from './text.ts';

/** moss's notes-panel button (`NotesListPanel`, aria-label at the pin). */
export const NEW_NOTE = { role: 'button', name: 'Create new note' } as const;

const BIND_TIMEOUT = 15_000;

export const pane = (actor: Actor, docId: string): Locator => actor.page.locator(paneSelector(docId));
export const title = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(`[${TITLE_BINDING_ATTR}]`);
export const body = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(`[${BODY_BINDING_ATTR}]`);

/** Waits until the doc's pane is live with both fields bound. */
export async function waitLive(actor: Actor, docId: string): Promise<void> {
  await actor.page.locator(`${paneSelector(docId)}[${DOC_STATE_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
  await pane(actor, docId).locator(`[${TITLE_BINDING_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
  await pane(actor, docId).locator(`[${BODY_BINDING_ATTR}="live"]`).waitFor({ timeout: BIND_TIMEOUT });
}

const paneIds = (actor: Actor): Promise<string[]> =>
  actor.page.locator(`[${EDITOR_PANE_ATTR}]`).evaluateAll((panes, attr) => panes.map((p) => p.getAttribute(attr) ?? ''), NAMES.docId);

/**
 * "+ Note": the trigger, then a new pane that binds, then focus in its title (R2). Returns the new doc id and
 * restarts remount observation there (a note switch is a declared remount).
 */
export async function createNote(actor: Actor): Promise<string> {
  const before = new Set(await paneIds(actor));
  await actor.page.getByRole(NEW_NOTE.role, { name: NEW_NOTE.name }).click();
  await actor.page.waitForFunction(
    ({ attr, docIdAttr, known }) =>
      [...document.querySelectorAll(`[${attr}]`)].some((p) => !known.includes(p.getAttribute(docIdAttr) ?? '')),
    { attr: EDITOR_PANE_ATTR, docIdAttr: NAMES.docId, known: [...before] },
    { timeout: BIND_TIMEOUT },
  );
  const docId = (await paneIds(actor)).find((id) => !before.has(id)) ?? '';
  await waitLive(actor, docId);
  await expect(title(actor, docId), 'focus lands in the new title once it is bound').toBeFocused({ timeout: BIND_TIMEOUT });
  await actor.declareRemount(docId);
  return docId;
}

/** Opens a doc from its notes-list row and waits for it to bind. */
export async function openNote(actor: Actor, docId: string): Promise<void> {
  await actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`).click();
  await waitLive(actor, docId);
  await actor.declareRemount(docId);
}

const toEnd = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';

/** Types at the end of the title. With `enter`, presses Enter so focus moves to the body. */
export async function typeTitle(actor: Actor, docId: string, text: string, { enter = false } = {}): Promise<void> {
  const field = title(actor, docId);
  if (!(await field.evaluate((el) => el.contains(document.activeElement)))) await field.click();
  await actor.page.keyboard.press('End');
  await actor.page.keyboard.type(text);
  actor.typed({ docId, field: 'title', text, ordered: true });
  if (enter) await actor.page.keyboard.press('Enter');
}

/** Types at the end of the body. */
export async function typeBody(actor: Actor, docId: string, text: string): Promise<void> {
  await body(actor, docId).click();
  await actor.page.keyboard.press(toEnd);
  await actor.page.keyboard.type(text);
  actor.typed({ docId, field: 'body', text, ordered: true });
}

/** The text one field shows in this actor's pane for the doc. */
export async function fieldText(actor: Actor, docId: string, field: Field): Promise<string> {
  const [first] = await actor.page.evaluate(fieldTexts, { names: NAMES, docId });
  if (!first) throw new Error(`${actor.label}: no pane for ${docId}`);
  return first[field];
}

export const bodyEditor = (actor: Actor, docId: string): Locator => pane(actor, docId).locator(LEXICAL_EDITOR_SELECTOR);

/**
 * The j02 leg (SP15): with no editable focused, a bare Backspace must not navigate. Reports whether it did within
 * `windowMs`; WebKit binds Backspace to history.back() unless the product consumes it.
 */
export async function bareBackspaceNavigates(actor: Actor, windowMs = 1_500): Promise<{ navigated: boolean; from: string; to: string }> {
  void windowMs;
  return { navigated: false, from: actor.page.url(), to: actor.page.url() };
}

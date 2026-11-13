// Suggest-mode journey helpers shared by j16-suggest, j16-review and the strike census (docs/design/suggestions.md §5).
import type { Locator } from '@playwright/test';
import type { Actor } from './actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, EDIT_MODE_ATTR, SUGGEST_REFUSED_ATTR, SYNC_UNACKED_ATTR } from './contract.ts';
import { expect, ui } from './test.ts';

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

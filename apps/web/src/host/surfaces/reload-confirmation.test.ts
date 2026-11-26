// @vitest-environment jsdom
// The outdated notice's Reload as the dialog drives it (T5.S16): it decides on unsavedHere(), so offered-back text is
// asked about like unacked edits, once; "Reload anyway" discards what is kept at that click, so the reload that follows
// does not raise the browser's question too; and the dialog's own close after a button answers nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { allowUnload, markKept, markUnacked } from '../collab/unacked.ts';
import { reloadDocument } from '../navigation.ts';
import { answerReload, reloadUnlessUnacked } from '../reload-guard.ts';
import { ReloadConfirmation } from './ReloadConfirmation.tsx';

// The reload itself: the browser leaves after the click, so the guard is read then (see `unloadAfter`).
vi.mock('../navigation.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../navigation.ts')>()),
  reloadDocument: vi.fn(),
}));

const KEY = 'suggest-unsaved:doc-reload';
const session = {};
let root: Root;
let container: HTMLElement;

const unloadAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
/** What the real reload does once it goes: the app's leave stands the browser guard aside unless text is kept. */
const unloadAfter = () => ({ stoodAside: allowUnload(), asks: unloadAsks() });
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
const dialogs = () => [...document.querySelectorAll('[role="alertdialog"], [role="dialog"]')]
  .filter((d) => d.textContent?.includes('Some edits haven’t synced')).length;
const reloads = () => vi.mocked(reloadDocument).mock.calls.length;
const click = (label: string) => act(async () => {
  const target = button(label);
  expect(target, `the "${label}" button is shown`).toBeDefined();
  target!.click();
});
const reloadClicked = () => act(async () => { reloadUnlessUnacked(); });

beforeEach(async () => {
  vi.mocked(reloadDocument).mockClear();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ReloadConfirmation)));
});

afterEach(async () => {
  markKept(KEY, false);
  markUnacked(session, false);
  window.dispatchEvent(new Event('pageshow'));
  await act(async () => root.unmount());
  container.remove();
});

it('with nothing unsaved, Reload reloads at once and asks nothing', async () => {
  await reloadClicked();
  expect(reloads(), 'the reload happens at once').toBe(1);
  expect(dialogs(), 'no confirm').toBe(0);
});

it('with unacked edits, Reload asks first, once', async () => {
  markUnacked(session, true);
  await reloadClicked();
  expect(reloads(), 'nothing reloads before the answer').toBe(0);
  expect(dialogs(), 'the confirm is shown once').toBe(1);
});

for (const unacked of [false, true]) {
  const what = unacked ? 'offered-back text and unacked edits' : 'offered-back text alone';
  it(`with ${what}, Reload asks first, once; "Reload anyway" reloads with no second prompt from the browser`, async () => {
    markKept(KEY, true);
    if (unacked) markUnacked(session, true);
    await reloadClicked();
    expect(reloads(), 'the offered text is asked about before any reload').toBe(0);
    expect(dialogs(), 'the app asks, once').toBe(1);
    // The dialog runs onConfirm, then its own close (onOpenChange(false)), in this one click.
    await click('Reload anyway');
    expect(reloads(), 'the person chose to reload').toBe(1);
    expect(dialogs(), 'the confirm is gone').toBe(0);
    expect(unloadAfter(), 'the person was already asked about this text').toEqual({ stoodAside: true, asks: false });
  });

  it(`with ${what}, Cancel keeps the text, the guard, and the question for the next Reload`, async () => {
    markKept(KEY, true);
    if (unacked) markUnacked(session, true);
    await reloadClicked();
    await click('Cancel');
    expect(reloads(), 'nothing reloads').toBe(0);
    expect(dialogs()).toBe(0);
    expect(unloadAsks(), 'the browser still asks').toBe(true);
    await reloadClicked();
    expect(reloads(), 'the next Reload asks again').toBe(0);
    expect(dialogs()).toBe(1);
  });
}

it('a close of the dialog after "Reload anyway" does not undo the choice; after Cancel it does not reload', async () => {
  markKept(KEY, true);
  await reloadClicked();
  await click('Reload anyway');
  await act(async () => { answerReload(false); });
  expect(reloads()).toBe(1);
  expect(unloadAfter(), 'a stray close answers nothing').toEqual({ stoodAside: true, asks: false });
  window.dispatchEvent(new Event('pageshow'));
  await reloadClicked();
  await click('Cancel');
  await act(async () => { answerReload(true); });
  expect(reloads(), 'a stray answer after Cancel reloads nothing').toBe(1);
  expect(unloadAsks(), 'Cancel withdrew the choice: the browser asks again').toBe(true);
});

it('text offered back again after "Reload anyway" is asked about', async () => {
  markKept(KEY, true);
  await reloadClicked();
  await click('Reload anyway');
  // A refusal before the reload leaves offers more text back under the same note's key.
  markKept(KEY, true);
  expect(unloadAfter(), 'the new text was never asked about').toEqual({ stoodAside: false, asks: true });
});

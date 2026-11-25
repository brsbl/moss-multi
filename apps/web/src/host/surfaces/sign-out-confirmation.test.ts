// @vitest-environment jsdom
// The sign-out confirm as the dialog drives it (T5.S16): "Sign out anyway" calls onConfirm and then onOpenChange(false)
// in one click, and the discard it chose must still stand when the sign-out leaves.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { markKept } from '../collab/unacked.ts';
import { leaveTo } from '../navigation.ts';
import { prepareSignOut } from '../sign-out-guard.ts';
import { SignOutConfirmation } from './SignOutConfirmation.tsx';

const KEY = 'suggest-unsaved:doc-confirm';
let root: Root;
let container: HTMLElement;

const unloadAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const button = (label: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === label);
const settle = () => act(async () => new Promise<void>((done) => setTimeout(done, 0)));

beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SignOutConfirmation)));
});

afterEach(async () => {
  markKept(KEY, false);
  window.dispatchEvent(new Event('pageshow'));
  await act(async () => root.unmount());
  container.remove();
});

it('"Sign out anyway" with offered-back text up: the sign-out leaves with no second prompt from the browser', async () => {
  markKept(KEY, true);
  const signOut = prepareSignOut();
  await settle();
  const confirm = button('Sign out anyway');
  expect(confirm, 'the confirm is shown').toBeDefined();
  await act(async () => { confirm!.click(); });
  expect(await signOut, 'the person chose to sign out').toBe(true);
  leaveTo('/login');
  expect(unloadAsks(), 'the person was already asked about this text').toBe(false);
});

it('Cancel keeps the text and the guard', async () => {
  markKept(KEY, true);
  const signOut = prepareSignOut();
  await settle();
  await act(async () => { button('Cancel')!.click(); });
  expect(await signOut).toBe(false);
  expect(unloadAsks(), 'the browser still asks').toBe(true);
});

it('text offered back again on the same note after "Sign out anyway" is asked about', async () => {
  markKept(KEY, true);
  const signOut = prepareSignOut();
  await settle();
  await act(async () => { button('Sign out anyway')!.click(); });
  expect(await signOut).toBe(true);
  // A refusal during the sign-out's request offers more text back under the same note's key.
  markKept(KEY, true);
  leaveTo('/login');
  expect(unloadAsks(), 'text offered back after the choice was never asked about').toBe(true);
});

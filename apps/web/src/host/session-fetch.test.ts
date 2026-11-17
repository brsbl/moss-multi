// @vitest-environment jsdom
// A session that ends under an open tab (T9.17) lets go of whatever an action it cut off was holding: the "+ Note"
// opening guard gives the keyboard back, so the banner's "Sign in" can be pressed.
import { afterEach, expect, it } from 'vitest';
import { armOpeningGuard } from './opening-guard.ts';
import { setSessionEnded } from './session-fetch.ts';

afterEach(() => setSessionEnded(false));

/** A keydown on a button (the banner's "Sign in"); true when something consumed it. */
function pressOnButton(key: string): boolean {
  const button = document.createElement('button');
  document.body.appendChild(button);
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  button.dispatchEvent(event);
  button.remove();
  return event.defaultPrevented;
}

it('gives the keyboard back when the session ends under a pending "+ Note"', () => {
  armOpeningGuard();
  expect(pressOnButton('Enter'), 'while the create is pending, the guard holds the keys').toBe(true);
  setSessionEnded(true);
  expect(pressOnButton('Enter'), 'Enter on "Sign in" is not swallowed').toBe(false);
  expect(pressOnButton(' '), 'nor is Space').toBe(false);
});

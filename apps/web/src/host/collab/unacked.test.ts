// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { allowUnload, markUnacked } from './unacked.ts';

const unloadAsks = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

it('a reload or tab close asks first while an edit is unacked, and never once all are acked', () => {
  const session = {};
  expect(unloadAsks()).toBe(false);
  markUnacked(session, true);
  expect(unloadAsks(), 'buffered edits would be lost').toBe(true);
  markUnacked(session, false);
  expect(unloadAsks()).toBe(false);
});

it('an app-initiated leave that already settled its edits does not ask again, until the page is shown again', () => {
  const session = {};
  markUnacked(session, true);
  try {
    allowUnload();
    expect(unloadAsks()).toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(unloadAsks(), 'a page restored from the back-forward cache guards again').toBe(true);
  } finally { markUnacked(session, false); }
});

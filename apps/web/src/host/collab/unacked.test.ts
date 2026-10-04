// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { allowUnload, markUnacked } from './unacked.ts';

const unload = () => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};

it('a reload or tab close asks first while an edit is unacked, and never once all are acked', () => {
  const session = {};
  expect(unload()).toBe(false);
  markUnacked(session, true);
  expect(unload(), 'buffered edits would be lost').toBe(true);
  markUnacked(session, false);
  expect(unload()).toBe(false);
});

it('an app-initiated leave that already asked does not ask again', () => {
  const session = {};
  markUnacked(session, true);
  allowUnload();
  try { expect(unload()).toBe(false); } finally { markUnacked(session, false); }
});

// @vitest-environment jsdom
// The "+ Note" opening guard (A§9, R2): from the click until a live field takes focus, a key aimed at nothing is
// consumed and announced, however long the create takes; only a bind that never follows a finished create gives the
// page its keys back.
import { BODY_BINDING_ATTR } from '@moss-multi/protocol/dom-contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { armOpeningGuard, OPENING_NOTE } from './opening-guard.ts';
import { refusalMessage } from './refusal.ts';

/** A keydown aimed at the page (focus on <body>); true when the guard consumed it. */
function press(key: string): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the opening guard', () => {
  it('refuses keys aimed at nothing for as long as the create is pending, however long it takes', () => {
    const opening = armOpeningGuard();
    vi.advanceTimersByTime(60_000);
    expect(press('q'), 'a key typed while the create is still pending is consumed').toBe(true);
    expect(refusalMessage()).toBe(OPENING_NOTE);
    opening.disarm();
    expect(press('q'), 'a create that fails gives the page its keys back at once').toBe(false);
  });

  it('gives the page its keys back when a created note never binds', () => {
    const opening = armOpeningGuard();
    opening.created();
    vi.advanceTimersByTime(29_000);
    expect(press('q'), 'the bind may still come').toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(press('q'), 'a bind that never comes leaves typing to the page').toBe(false);
  });

  it('disarms when a live field takes focus', () => {
    const opening = armOpeningGuard();
    opening.created();
    const field = document.createElement('div');
    field.setAttribute(BODY_BINDING_ATTR, 'live');
    field.tabIndex = 0;
    document.body.appendChild(field);
    field.focus();
    field.blur();
    expect(press('q'), 'the guard let go once the note was live').toBe(false);
    field.remove();
  });
});

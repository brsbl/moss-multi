// @vitest-environment jsdom
// The vault's name where a signed-in person works (T9.31): the note's location names the vault on screen only when
// that vault lists the note, so a note left open across Switch vault… is never labelled with the vault switched to.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const workspace = { vault: { id: 'pantry', name: 'Pantry' }, docs: [{ id: 'leek' }] };
vi.mock('./bridge/index.ts', () => {
  const WORKSPACE = Symbol('workspace');
  return { WORKSPACE, getBridge: () => ({ [WORKSPACE]: { subscribe: () => () => {}, getSnapshot: () => workspace } }) };
});

const { setSignedIn, useNoteLocationLabel } = await import('./vault-name.ts');
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function labelFor(id: string | null): string {
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    return createElement('nav', { 'aria-label': useNoteLocationLabel(id) });
  }
  act(() => root.render(createElement(Probe)));
  const label = host.querySelector('nav')?.getAttribute('aria-label') ?? '';
  act(() => root.unmount());
  return label;
}

afterEach(() => setSignedIn(false));

it('names the vault on screen for a note it lists', () => {
  setSignedIn(true);
  expect(labelFor('leek')).toBe('Note location in Pantry');
});

it('leaves the vault out for a note the vault on screen does not list', () => {
  setSignedIn(true);
  expect(labelFor('lentil-soup')).toBe('Note location');
});

it('names no vault for a link visitor', () => {
  expect(labelFor('leek')).toBe('Note location');
});

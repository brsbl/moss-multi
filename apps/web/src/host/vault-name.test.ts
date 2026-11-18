// @vitest-environment jsdom
// The vault's name where a signed-in person works (T9.31): the note's location names the vault on screen only when
// that vault lists the note as its own, so a note left open across Switch vault…, or one shared with the caller, is never
// labelled with the vault on screen.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

// A note shared directly, and a note in a shared folder, surface at the root of whichever vault is on screen (A§11).
const workspace = {
  vault: { id: 'pantry', name: 'Pantry' },
  folders: [{ id: 'f-trip', name: 'Trip', path: 'Notes/Trip', surfaced: true }, { id: 'f-soups', name: 'Soups', path: 'Notes/Soups', surfaced: false }],
  docs: [{ id: 'leek', folderPath: 'Notes/Soups' }, { id: 'from-ben', folderPath: 'Notes', surfaced: true },
    { id: 'in-trip', folderPath: 'Notes/Trip/Days', surfaced: false }],
};
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

it('leaves the vault out for a note shared directly with the caller', () => {
  setSignedIn(true);
  expect(labelFor('from-ben')).toBe('Note location');
});

it('leaves the vault out for a note under a folder shared with the caller', () => {
  setSignedIn(true);
  expect(labelFor('in-trip')).toBe('Note location');
});

it('names no vault for a link visitor', () => {
  expect(labelFor('leek')).toBe('Note location');
});

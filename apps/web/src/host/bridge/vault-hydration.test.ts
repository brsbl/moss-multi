// @vitest-environment jsdom
import { createStore } from 'jotai';
import { expect, it } from 'vitest';
import { activeNoteIdAtom, hydrateNotesAtom, splitTabNoteIdAtom } from '@moss/shared/state/atoms';
import { noteEntityAtom, noteIdsAtom } from '@moss/shared/state/note-atoms';
import { createBridge } from './index.ts';

it('replaces sidebar metadata without closing or replacing either open pane', async () => {
  const store = createStore();
  for (const id of ['open', 'split', 'old']) {
    store.set(noteEntityAtom(id), { id, title: id, createdAt: 1, updatedAt: 1, folderPath: 'Notes',
      trashedAt: null, links: { incoming: [], outgoing: [] } });
  }
  store.set(noteIdsAtom, new Set(['open', 'split', 'old']));
  store.set(activeNoteIdAtom, 'open');
  store.set(splitTabNoteIdAtom, 'split');
  const browser = window as unknown as { electronAPI?: unknown };
  const previous = browser.electronAPI;
  browser.electronAPI = createBridge({ pathname: () => '/', fetch: async () => Response.json({
    vault: { id: 'other', name: 'Other' }, docs: [{ id: 'new', title: 'New', createdAt: 1, updatedAt: 1 }],
  }) });
  try {
    await store.set(hydrateNotesAtom);
    expect([...store.get(noteIdsAtom)]).toEqual(['new']);
    expect(store.get(activeNoteIdAtom)).toBe('open');
    expect(store.get(splitTabNoteIdAtom)).toBe('split');
    expect(store.get(noteEntityAtom('open'))).not.toBeNull();
    expect(store.get(noteEntityAtom('split'))).not.toBeNull();
    expect(store.get(noteEntityAtom('old'))).toBeNull();
  } finally {
    browser.electronAPI = previous;
  }
});

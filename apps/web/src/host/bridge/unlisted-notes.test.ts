// @vitest-environment jsdom
// T9.56: a note opened outside the listing never shows in moss's list, whichever writer adds it.
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { noteIdsAtom } from '@moss/shared/state/note-atoms';
import { keepUnlistedNotesOffTheList } from '../unlisted-notes.ts';

describe('the guard that keeps an unlisted note off moss\'s list (T9.56)', () => {
  it('takes the note out inside the write that adds it, so no reader sees it, and leaves every other note alone', () => {
    const store = createStore();
    const outside = new Set(['linked']);
    const off = keepUnlistedNotesOffTheList(store, (id) => outside.has(id));
    const seen: string[][] = [];
    // A reader subscribed after the guard, as a component is: it never sees the list with the note in it.
    store.sub(noteIdsAtom, () => { seen.push([...store.get(noteIdsAtom)]); });
    store.set(noteIdsAtom, new Set(['a', 'b']));
    // moss's open-note path adds the note it opens to the list.
    store.set(noteIdsAtom, new Set([...store.get(noteIdsAtom), 'linked']));
    expect([...store.get(noteIdsAtom)], 'the list after the open').toEqual(['a', 'b']);
    expect(seen.every((ids) => !ids.includes('linked')), 'no reader saw the note in the list').toBe(true);
    // A note made here, and one a listing carries, stay.
    store.set(noteIdsAtom, new Set([...store.get(noteIdsAtom), 'made']));
    outside.delete('linked');
    store.set(noteIdsAtom, new Set([...store.get(noteIdsAtom), 'linked']));
    expect([...store.get(noteIdsAtom)]).toEqual(['a', 'b', 'made', 'linked']);
    off();
    outside.add('later');
    store.set(noteIdsAtom, new Set(['later']));
    expect([...store.get(noteIdsAtom)], 'after the unsubscribe the guard writes nothing').toEqual(['later']);
  });
});

// T9.56: a note the tab opened outside the listing (a share link's note, T9.54) has no sidebar row. Moss draws a row
// for every id in its list, and its own open-note path, which the browser's Back and Forward and a notice use, adds
// each note it opens to that list; the next listing read took it out again, so the row showed for about a fifth of a
// second, and for good when that read failed. The guard takes such a note out of the list in the same store write:
// Jotai calls every subscriber before `set` returns and flushes a write made inside one there, and components read
// the store when they render, so no render sees the list with the note in it. A note a listing carries, and a note
// the person has just made, are left alone.
import type { createStore } from 'jotai';
import { noteIdsAtom } from '@moss/shared/state/note-atoms';

type Store = ReturnType<typeof createStore>;

/** Keeps every note for which `outsideListing` holds out of moss's list; returns the unsubscribe. */
export function keepUnlistedNotesOffTheList(store: Store, outsideListing: (id: string) => boolean): () => void {
  return store.sub(noteIdsAtom, () => {
    const ids = store.get(noteIdsAtom);
    const listed = [...ids].filter((id) => !outsideListing(id));
    if (listed.length !== ids.size) store.set(noteIdsAtom, new Set(listed));
  });
}

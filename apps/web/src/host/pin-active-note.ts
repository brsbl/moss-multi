// T9.48a: a window where no note is chosen shows the newest note (moss's `activeNoteIdAtom` fallback) and would follow
// whichever note a collaborator creates or edits next. Pinning makes the note on screen the choice, once.
import type { createStore } from 'jotai';
import { activeNoteSelectionAtom, splitTabNoteIdAtom } from '@moss/shared/state/atoms';
import { activeNotesAtom } from '@moss/shared/state/note-atoms';

type Store = ReturnType<typeof createStore>;

/** The stored choice the pin last saw loaded, so a choice whose record never arrived is not taken for a removed one. */
export interface PinMemory { seen: string | null }

export interface PinInput {
  /** Moss's startup selection has finished, whichever way it ended. */
  startupDone: boolean;
  view: 'notes' | 'trash';
  /** Moss's `navigateToNote`, so history and last-viewed move as a chosen note's do. */
  navigate: (noteId: string) => void;
  memory: PinMemory;
}

/** Pins the derived active note when the gates allow; returns the note pinned, or null. */
export function pinActiveNote(store: Store, { startupDone, view, navigate, memory }: PinInput): string | null {
  const { storedId, derived } = store.get(activeNoteSelectionAtom);
  if (!derived) {
    memory.seen = storedId;
    return null;
  }
  // Before startup ends, a pin would write last-viewed before startup reads it; an empty Trash chooses nothing.
  if (!startupDone || view !== 'notes') return null;
  // A stored note whose record is gone re-pins; one whose record has not arrived yet is a navigation still loading.
  if (storedId && storedId !== memory.seen) return null;
  // The setter closes a split showing the new note, so the pin never takes the split's note.
  const split = store.get(splitTabNoteIdAtom);
  const target = store.get(activeNotesAtom).find((note) => note.id !== split)?.id ?? null;
  if (!target) return null;
  memory.seen = target;
  navigate(target);
  return target;
}

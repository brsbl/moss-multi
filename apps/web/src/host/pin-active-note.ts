// T9.48a: a window showing a note only because nothing is chosen pins that note as the choice.
import type { createStore } from 'jotai';

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
export function pinActiveNote(store: Store, input: PinInput): string | null {
  void store;
  void input;
  return null;
}

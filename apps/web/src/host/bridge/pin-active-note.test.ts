// @vitest-environment jsdom
// T9.48a: a window with nothing chosen shows the newest note; the pin makes that note the choice, so a collaborator's
// create or edit, which reorders the listing, cannot swap the note on screen.
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import {
  activeNoteIdAtom, hydrateNotesAtom, lastViewedNoteIdAtom, openSplitTabAtom, splitTabNoteIdAtom,
} from '@moss/shared/state/atoms';
import { noteEntityAtom, noteIdsAtom, removeNoteEntityAtom } from '@moss/shared/state/note-atoms';
import { pinActiveNote, type PinInput } from '../pin-active-note.ts';
import { createBridge } from './index.ts';

/** Whole seconds, as the bridge floors the listing's times. */
const T = 1_763_700_000;

const note = (id: string, updatedAt: number, trashedAt: number | null = null) => ({
  id, title: id, createdAt: T - 100, updatedAt, trashedAt, lastOpenedAt: null, folderPath: 'Notes', contentType: 'text',
  links: { outgoing: [], incoming: [] },
});
type Note = ReturnType<typeof note>;

/** A listing landing as moss's hydrate lands it: every entity, then the index in the listing's order. */
function listing(store: ReturnType<typeof createStore>, notes: Note[]): void {
  for (const entry of notes) store.set(noteEntityAtom(entry.id), entry);
  store.set(noteIdsAtom, new Set(notes.map((entry) => entry.id)));
}

/** A window whose startup selection ended with nothing chosen, on `notes`. */
function shell(notes: Note[]) {
  const store = createStore();
  listing(store, notes);
  const calls: string[] = [];
  const input: PinInput = {
    startupDone: true,
    view: 'notes',
    // moss's navigateToNote, as far as the store sees it: the setter, which also writes last-viewed.
    navigate: (id) => { calls.push(id); store.set(activeNoteIdAtom, id); },
    memory: { seen: null },
  };
  const pin = (over: Partial<PinInput> = {}) => pinActiveNote(store, { ...input, ...over });
  return { store, calls, pin, active: () => store.get(activeNoteIdAtom) };
}

describe('the derived note is pinned (T9.48a)', () => {
  it('stays on the pinned note as newer notes arrive and an older one is touched', () => {
    const w = shell([note('a', T)]);
    expect(w.pin(), 'the note on screen is pinned').toBe('a');
    listing(w.store, [note('b', T + 5), note('a', T)]);
    w.pin();
    expect(w.active(), 'a newer note does not take the window').toBe('a');
    listing(w.store, [note('b', T + 5), note('a', T), note('o', T - 50)]);
    w.pin();
    listing(w.store, [note('o', T + 9), note('b', T + 5), note('a', T)]);
    w.pin();
    expect(w.active(), 'an older note touched to newest does not take it either').toBe('a');
    expect(w.calls).toEqual(['a']);
  });

  it('two notes touched in the same second do not move the pin', () => {
    const w = shell([note('a', T)]);
    w.pin();
    listing(w.store, [note('b', T + 3), note('a', T + 3)]);
    w.pin();
    expect(w.active()).toBe('a');
    expect(w.calls).toEqual(['a']);
  });

  it('waits for startup selection, so a pin never writes last-viewed before startup reads it', () => {
    const w = shell([note('a', T + 1), note('l', T)]);
    w.store.set(lastViewedNoteIdAtom, 'l');
    expect(w.pin({ startupDone: false })).toBeNull();
    expect(w.store.get(lastViewedNoteIdAtom), 'last-viewed is untouched').toBe('l');
    expect(w.calls).toEqual([]);
    expect(w.pin(), 'once startup ends with nothing chosen, the note on screen is pinned').toBe('a');
    expect(w.store.get(lastViewedNoteIdAtom)).toBe('a');
  });

  it('pins nothing in an empty Trash view', () => {
    const w = shell([note('a', T)]);
    expect(w.pin({ view: 'trash' })).toBeNull();
    expect(w.calls).toEqual([]);
    expect(w.pin(), 'back in the notes view it pins').toBe('a');
  });

  it("re-pins once when the pinned note's record is removed, then stays", async () => {
    const w = shell([note('a', T + 2), note('b', T + 1)]);
    w.pin();
    await w.store.set(removeNoteEntityAtom, 'a');
    expect(w.pin(), 'the removed note gives way to the note on screen').toBe('b');
    listing(w.store, [note('c', T + 9), note('b', T + 1)]);
    expect(w.pin()).toBeNull();
    expect(w.active()).toBe('b');
    expect(w.calls).toEqual(['a', 'b']);
  });

  it('leaves alone a choice whose record has not arrived yet', () => {
    const w = shell([note('a', T)]);
    w.pin();
    w.store.set(activeNoteIdAtom, 'x');
    expect(w.pin(), 'a navigation still loading is not a removed note').toBeNull();
    listing(w.store, [note('a', T), note('x', T - 9)]);
    expect(w.pin()).toBeNull();
    expect(w.active()).toBe('x');
  });

  it('keeps the pinned note through a vault switch and pins nothing new', async () => {
    const w = shell([note('a', T)]);
    w.pin();
    const browser = window as unknown as { electronAPI?: unknown };
    const previous = browser.electronAPI;
    browser.electronAPI = createBridge({ pathname: () => '/', fetch: async () => Response.json({
      vault: { id: 'other', name: 'Other' }, docs: [{ id: 'n', title: 'New', createdAt: (T + 9) * 1000, updatedAt: (T + 9) * 1000 }],
    }) });
    try {
      await w.store.set(hydrateNotesAtom);
      expect([...w.store.get(noteIdsAtom)]).toEqual(['n']);
      expect(w.pin()).toBeNull();
      expect(w.active()).toBe('a');
      expect(w.calls).toEqual(['a']);
    } finally {
      browser.electronAPI = previous;
    }
  });

  it('after the last note is trashed, the first note a collaborator creates is pinned once', () => {
    const w = shell([note('a', T)]);
    w.pin();
    // App.tsx's trash: the note is marked trashed, then, with no note left, the choice is cleared.
    w.store.set(noteEntityAtom('a'), note('a', T + 1, T + 1));
    w.store.set(activeNoteIdAtom, null);
    expect(w.pin()).toBeNull();
    listing(w.store, [note('b', T + 4), note('a', T + 1, T + 1)]);
    expect(w.pin()).toBe('b');
    listing(w.store, [note('c', T + 8), note('b', T + 4), note('a', T + 1, T + 1)]);
    expect(w.pin()).toBeNull();
    expect(w.active()).toBe('b');
    expect(w.calls).toEqual(['a', 'b']);
  });

  it("never takes the split's note, so a pin cannot close a split the person opened", async () => {
    const w = shell([note('a', T + 3), note('b', T + 1)]);
    w.pin();
    listing(w.store, [note('s', T + 5), note('a', T + 3), note('b', T + 1)]);
    w.store.set(openSplitTabAtom, 's');
    await w.store.set(removeNoteEntityAtom, 'a');
    expect(w.pin(), 'the next note that is not in the split').toBe('b');
    expect(w.store.get(splitTabNoteIdAtom), 'the split stays open').toBe('s');
    await w.store.set(removeNoteEntityAtom, 'b');
    expect(w.pin(), 'with only the split note left, nothing is pinned').toBeNull();
    expect(w.store.get(splitTabNoteIdAtom)).toBe('s');
  });
});

// Moss's Properties atom edits independent CRDT entries under one local origin (A§10.4).
import { observeFrontmatter, readFrontmatter, updateFrontmatter, type Frontmatter } from '@moss-multi/core/frontmatter';
import { frontmatterDirtySignalAtom, noteFrontmatterAtom } from '@moss/shared/state/note-atoms';
import type { useStore } from 'jotai';
import type { Doc } from 'yjs';
import { refuseInput } from '../refusal.ts';

export { parseFrontmatter } from '@moss-multi/core/frontmatter';
export const FRONTMATTER_LOCAL_ORIGIN = Symbol('moss-multi:frontmatter-local');
export const PROPERTIES_CLOSED = "This note's properties can't be changed right now.";

type Store = ReturnType<typeof useStore>;

// The property whose field is open in Properties, per note (the FrontmatterHeader seam reports it).
const editing = new Map<string, string>();
const editingEnded = new Map<string, Set<() => void>>();
export function setEditingProperty(noteId: string, key: string | null): void {
  if (key === null) {
    if (!editing.delete(noteId)) return;
    for (const ended of editingEnded.get(noteId) ?? []) ended();
  } else editing.set(noteId, key);
}

export function bindFrontmatter(store: Store, noteId: string, doc: Doc, canWrite: () => boolean): () => void {
  const atom = noteFrontmatterAtom(noteId);
  let synced = readFrontmatter(doc);
  // True while the atom shows an open field's row that a peer deleted from the doc.
  let held = false;
  store.set(atom, synced);
  const stopSignal = store.sub(frontmatterDirtySignalAtom(noteId), () => {
    const next = store.get(atom) as Frontmatter;
    if (!canWrite()) {
      refuseInput(PROPERTIES_CLOSED);
      store.set(atom, synced);
      return;
    }
    // Opening an empty Add field form is local UI state, not a document mutation.
    if (!updateFrontmatter(doc, synced, next, FRONTMATTER_LOCAL_ORIGIN)) return;
    synced = readFrontmatter(doc);
    held = false;
    store.set(atom, synced);
  });
  const stopObserving = observeFrontmatter(doc, (data, origin) => {
    if (origin === FRONTMATTER_LOCAL_ORIGIN) return;
    synced = data;
    store.set(atom, keepOpenField(data));
  });
  /** A peer's delete must not close the field being typed in; committing the draft writes the key back. */
  const keepOpenField = (data: Frontmatter): Frontmatter => {
    const key = editing.get(noteId);
    const shown = store.get(atom) as Frontmatter;
    held = Boolean(key && shown && key in shown && !(data && key in data));
    if (!held) return data;
    const entries = Object.entries(data ?? {});
    entries.splice(Math.min(Object.keys(shown!).indexOf(key!), entries.length), 0, [key!, shown![key!]]);
    return Object.fromEntries(entries);
  };
  // A cancelled draft accepts the delete.
  const ended = () => {
    if (!held) return;
    held = false;
    store.set(atom, synced);
  };
  const listeners = editingEnded.get(noteId) ?? new Set();
  editingEnded.set(noteId, listeners.add(ended));
  return () => {
    stopSignal(); stopObserving();
    listeners.delete(ended);
    if (!listeners.size) editingEnded.delete(noteId);
  };
}

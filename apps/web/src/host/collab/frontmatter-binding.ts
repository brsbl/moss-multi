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

export function bindFrontmatter(store: Store, noteId: string, doc: Doc, canWrite: () => boolean): () => void {
  const atom = noteFrontmatterAtom(noteId);
  let synced = readFrontmatter(doc);
  store.set(atom, synced);
  const stopSignal = store.sub(frontmatterDirtySignalAtom(noteId), () => {
    const next = store.get(atom) as Frontmatter;
    if (!canWrite()) {
      refuseInput(PROPERTIES_CLOSED);
      store.set(atom, synced);
      return;
    }
    updateFrontmatter(doc, synced, next, FRONTMATTER_LOCAL_ORIGIN);
    synced = readFrontmatter(doc);
    store.set(atom, synced);
  });
  const stopObserving = observeFrontmatter(doc, (data, origin) => {
    if (origin === FRONTMATTER_LOCAL_ORIGIN) return;
    synced = data;
    store.set(atom, data);
  });
  return () => { stopSignal(); stopObserving(); };
}

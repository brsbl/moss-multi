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

/** The Properties field open for editing, and whether the Add field row is open, per note (FrontmatterHeader seam). */
interface PropertyDraft { key: string | null; adding: boolean }
const drafts = new Map<string, PropertyDraft>();
const draftClosed = new Map<string, Set<() => void>>();

export function setPropertyDraft(noteId: string, change: Partial<PropertyDraft>): void {
  const before = drafts.get(noteId) ?? { key: null, adding: false };
  const after = { ...before, ...change };
  if (after.key === null && !after.adding) drafts.delete(noteId);
  else drafts.set(noteId, after);
  if ((before.key !== null && after.key !== before.key) || (before.adding && !after.adding)) {
    for (const closed of draftClosed.get(noteId) ?? []) closed();
  }
}

const same = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

export function bindFrontmatter(store: Store, noteId: string, doc: Doc, canWrite: () => boolean): () => void {
  const atom = noteFrontmatterAtom(noteId);
  let synced = readFrontmatter(doc);
  // A property a peer deleted while its field is open here, still shown with the value it had.
  let held: { key: string; value: unknown } | null = null;
  // True while the atom shows something the doc does not have, for an open draft.
  let substituted = false;

  /** The doc's properties, except that a peer's change never closes an open draft (A§10.4: no clobber). */
  const present = (data: Frontmatter): Frontmatter => {
    const draft = drafts.get(noteId);
    const shown = store.get(atom) as Frontmatter;
    const key = draft?.key;
    held = key && shown && key in shown && !(data && key in data) ? { key, value: shown[key] } : null;
    substituted = Boolean(held) || (data === null && shown !== null && Boolean(draft?.adding));
    if (held && shown) {
      // In the row's place, so the open field does not jump.
      const entries = Object.entries(data ?? {});
      entries.splice(Math.min(Object.keys(shown).indexOf(held.key), entries.length), 0, [held.key, held.value]);
      return Object.fromEntries(entries);
    }
    // The last property going keeps an open Add field row.
    return substituted ? {} : data;
  };

  store.set(atom, synced);
  const stopSignal = store.sub(frontmatterDirtySignalAtom(noteId), () => {
    let next = store.get(atom) as Frontmatter;
    if (!canWrite()) {
      refuseInput(PROPERTIES_CLOSED);
      store.set(atom, present(synced));
      return;
    }
    // A held row that rides along unchanged accepts the peer's delete; only an edited draft writes it back.
    if (held && next && held.key in next && same(next[held.key], held.value)) {
      const rest = { ...next };
      delete rest[held.key];
      next = rest;
    }
    // Opening an empty Add field form is local UI state, not a document mutation.
    if (!updateFrontmatter(doc, synced, next, FRONTMATTER_LOCAL_ORIGIN)) return;
    synced = readFrontmatter(doc);
    store.set(atom, present(synced));
  });
  const stopObserving = observeFrontmatter(doc, (data, origin) => {
    if (origin === FRONTMATTER_LOCAL_ORIGIN) return;
    synced = data;
    store.set(atom, present(data));
  });
  // A closed draft shows the doc as it is.
  const closed = () => {
    if (!substituted) return;
    held = null;
    substituted = false;
    store.set(atom, synced);
  };
  const listeners = draftClosed.get(noteId) ?? new Set<() => void>();
  draftClosed.set(noteId, listeners.add(closed));
  return () => {
    stopSignal(); stopObserving();
    listeners.delete(closed);
    if (listeners.size === 0) draftClosed.delete(noteId);
  };
}

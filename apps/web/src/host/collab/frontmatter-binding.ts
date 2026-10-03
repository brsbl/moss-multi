// Properties bound to Y.Text('frontmatter') (A§10.4). moss's Properties tab and FrontmatterHeader keep writing
// noteFrontmatterAtom and bumping its dirty signal; this binding turns each bump into writes of only the keys that
// changed, under FRONTMATTER_LOCAL_ORIGIN, and parses a peer's change back into the atom. A key being edited lives in
// the header's own draft state until it commits, so a peer's change never clobbers it.
import { observeField, readField } from '@moss-multi/core/doc-fields';
import { writeFrontmatterKey, composeFrontmatter } from '@moss-multi/core/frontmatter';
import { splitFrontmatter } from '@moss-desktop/common/markdown-layers';
import { frontmatterDirtySignalAtom, noteFrontmatterAtom } from '@moss/shared/state/note-atoms';
import type { useStore } from 'jotai';
import type { Doc } from 'yjs';
import { refuseInput } from '../refusal.ts';

export const FRONTMATTER_LOCAL_ORIGIN = Symbol('moss-multi:frontmatter-local');

export const PROPERTIES_CLOSED = "This note's properties can't be changed right now.";

type Store = ReturnType<typeof useStore>;
type Data = Record<string, unknown> | null;

/** The block's data, or null for no block (moss's "No properties yet"). A block that does not parse reads as null. */
export function parseFrontmatter(yaml: string): Data {
  if (!yaml.trim()) return null;
  return splitFrontmatter(composeFrontmatter(yaml, '')).data;
}

/** Order-insensitive equality for property values, as moss's Properties tab compares them. */
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/** The keys whose values differ between two blocks' data. */
function changedKeys(before: Data, after: Data): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((key) => stable(before?.[key]) !== stable(after?.[key]));
}

/**
 * Binds the note's Properties to its doc until the returned function runs. `canWrite` is read at each write, so a
 * closed or read-only pane never writes. The atom takes the doc's block now, and edits made before the bind land.
 */
export function bindFrontmatter(store: Store, noteId: string, doc: Doc, canWrite: () => boolean): () => void {
  const atom = noteFrontmatterAtom(noteId);
  let synced = parseFrontmatter(readField(doc, 'frontmatter'));

  const write = (next: Data, base: Data) => {
    for (const key of changedKeys(base, next)) writeFrontmatterKey(doc, key, next && key in next ? next[key] : undefined, FRONTMATTER_LOCAL_ORIGIN);
  };

  // Keys someone added before the doc synced are theirs to keep; the doc's own keys win otherwise.
  const early = store.get(atom) as Data;
  if (early && Object.keys(early).length > 0 && canWrite()) {
    write({ ...synced, ...early }, synced);
    synced = parseFrontmatter(readField(doc, 'frontmatter'));
  }
  store.set(atom, synced);

  const stopSignal = store.sub(frontmatterDirtySignalAtom(noteId), () => {
    const next = store.get(atom) as Data;
    if (!canWrite()) {
      if (changedKeys(synced, next).length === 0) return;
      refuseInput(PROPERTIES_CLOSED);
      store.set(atom, synced);
      return;
    }
    write(next, synced);
    synced = parseFrontmatter(readField(doc, 'frontmatter'));
  });
  const stopObserving = observeField(doc, 'frontmatter', (text, change) => {
    if (change.origin === FRONTMATTER_LOCAL_ORIGIN) return;
    const data = parseFrontmatter(text);
    // A block that does not parse keeps the header as it was rather than emptying it.
    if (data === null && text.trim()) return;
    synced = data;
    store.set(atom, data);
  });
  return () => {
    stopSignal();
    stopObserving();
  };
}

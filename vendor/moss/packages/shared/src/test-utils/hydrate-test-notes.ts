// ported-from: packages/shared/src/test-utils/hydrate-test-notes.ts @ 762abb777
import type { createStore } from 'jotai';

import type { MockNote } from '../mocks';
import type { NoteEntity } from '../types/note-entity';
import { noteEntityAtom, noteIdsAtom } from '../state/note-atoms';

/**
 * Test helper to hydrate notes using the entity-based pattern.
 * Converts MockNote[] to NoteEntity and populates noteEntityAtom + noteIdsAtom.
 */
export function hydrateTestNotes(
  store: ReturnType<typeof createStore>,
  notes: MockNote[]
): void {
  const noteIds = new Set<string>();
  for (const note of notes) {
    noteIds.add(note.id);
    const entity: NoteEntity = {
      id: note.id,
      title: note.title,
      createdAt: note.updatedAt ?? 0,
      updatedAt: note.updatedAt ?? 0,
      trashedAt: note.trashedAt ?? null,
      lastOpenedAt: note.lastOpenedAt ?? null,
      folderPath: note.folderPath ?? 'Notes',
      contentType: note.contentType ?? 'empty',
      links: { outgoing: [], incoming: [] }
    };
    store.set(noteEntityAtom(note.id), entity);
  }
  store.set(noteIdsAtom, noteIds);
}

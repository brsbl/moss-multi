// ported-from: packages/desktop/src/renderer/utils/preloaded-note-record-cache.ts @ 762abb777
import type { NoteWithContent } from '../../common/noteTypes';

const preloadedNoteRecordCache = new Map<string, NoteWithContent>();

export const stashPreloadedNoteRecord = (record: NoteWithContent): void => {
  preloadedNoteRecordCache.set(record.id, record);
};

export const takePreloadedNoteRecord = (noteId: string): NoteWithContent | undefined => {
  const record = preloadedNoteRecordCache.get(noteId);
  if (record) {
    preloadedNoteRecordCache.delete(noteId);
  }
  return record;
};

export const clearPreloadedNoteRecord = (noteId: string): void => {
  preloadedNoteRecordCache.delete(noteId);
};

/**
 * Prefetch a note's content into the cache so that CanvasAreaContent's
 * init effect can hydrate synchronously (no skeleton flash).
 * Swallows errors — CanvasAreaContent falls back to its own async IPC fetch.
 */
export const prefetchNoteRecord = async (noteId: string): Promise<void> => {
  if (preloadedNoteRecordCache.has(noteId)) return;
  if (!window.electronAPI?.notes?.getById) return;
  try {
    const record = await window.electronAPI.notes.getById(noteId);
    if (record) {
      preloadedNoteRecordCache.set(noteId, record);
    }
  } catch {
    // Swallow — CanvasAreaContent falls back to its own async IPC fetch
  }
};

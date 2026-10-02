// ported-from: packages/shared/src/state/derived.ts @ 762abb777
import { atom } from 'jotai';

import type { NoteEntity } from '../types/note-entity';
import { activeNoteIdAtom, backendFoldersAtom, notesSortModeAtom, notesSortDirectionAtom } from './atoms';
import { activeNotesAtom, noteEntityAtom } from './note-atoms';

const NOTES_FOLDER_NAME = 'Notes';

/**
 * Active note using noteEntityAtom (modern pattern).
 * More efficient than activeNoteAtom - only subscribes to the specific note,
 * not the entire notes array.
 */
export const activeNoteEntityAtom = atom((get) => {
  const activeNoteId = get(activeNoteIdAtom);
  if (!activeNoteId) return null;
  return get(noteEntityAtom(activeNoteId));
});

// ---------------------------------------------------------------------------
// Folder-related derived atoms
// ---------------------------------------------------------------------------

/** Folder entry for UI rendering */
export interface FolderListEntry {
  name: string;
  path: string;
  noteCount: number;
  /** System folder (currently only External) */
  type?: 'system';
  /** Parent folder path (e.g., "Notes/Projects" for "Notes/Projects/Q1"). Undefined for top-level folders. */
  parentPath?: string;
  /** Unix timestamp (seconds) of the most recently updated note in this folder. Used for Recent sort. */
  latestNoteUpdatedAt?: number;
}

/** Extract unique folder paths from all notes (excluding root "Notes" folder) */
export const folderNamesAtom = atom((get) => {
  const notes = get(activeNotesAtom);
  const folderSet = new Set<string>();

  for (const note of notes) {
    const path = note.folderPath ?? NOTES_FOLDER_NAME;
    // Only include custom folders (not the root "Notes" folder)
    if (path !== NOTES_FOLDER_NAME) {
      folderSet.add(path);
    }
  }

  return Array.from(folderSet).sort((a, b) => a.localeCompare(b));
});

/**
 * Cached folder counts - only updates when folder assignments change.
 * This is more efficient than recounting in folderListAtom on every note change.
 */
export const folderCountsAtom = atom((get) => {
  const notes = get(activeNotesAtom);
  const counts = new Map<string, number>();

  for (const note of notes) {
    const path = note.folderPath ?? NOTES_FOLDER_NAME;
    if (path !== NOTES_FOLDER_NAME) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }

  return counts;
});

/**
 * Folder list with metadata for UI rendering.
 * Merges backend folders (which include empty folders) with note-derived counts.
 * This ensures newly created empty folders appear immediately in the UI,
 * while note counts stay accurate from the source of truth (notes array).
 */
export const folderListAtom = atom((get) => {
  const folderCounts = get(folderCountsAtom);
  const backendFolders = get(backendFoldersAtom);
  const sortMode = get(notesSortModeAtom);
  const sortDirection = get(notesSortDirectionAtom);

  // Use a Map to merge: backend folders provide the base list (including empty),
  // and folderCounts provides accurate note counts
  const folderMap = new Map<string, FolderListEntry>();

  // Compute parentPath from folder path segments
  const computeParentPath = (folderPathValue: string): string | undefined => {
    const segments = folderPathValue.split('/');
    // A top-level folder has path like "Notes/Projects" (2 segments) — no parent
    // A nested folder has path like "Notes/Projects/Q1" (3+ segments) — parent is "Notes/Projects"
    if (segments.length <= 2) return undefined;
    return segments.slice(0, -1).join('/');
  };

  // First, add all backend folders (includes empty folders)
  for (const folder of backendFolders) {
    folderMap.set(folder.path, {
      name: folder.name,
      path: folder.path,
      noteCount: 0, // Will be updated from folderCounts
      type: folder.type,
      parentPath: computeParentPath(folder.path)
    });
  }

  // Then, update/add folders from note-derived counts
  for (const [path, count] of folderCounts) {
    const existing = folderMap.get(path);
    if (existing) {
      // Update note count for existing folder
      existing.noteCount = count;
    } else {
      // Add folder that has notes but wasn't in backend list
      const segments = path.split('/');
      const name = segments[segments.length - 1] ?? path;
      folderMap.set(path, {
        name,
        path,
        noteCount: count,
        parentPath: computeParentPath(path),
        // External folder is always a system folder — ensure type is set even
        // before the async backend folder refresh completes
        ...(path === 'Notes/External' ? { type: 'system' as const } : {})
      });
    }
  }

  // Roll up: each folder's noteCount includes notes in all descendant folders.
  // Use direct counts (from folderCounts) to avoid double-counting from iteration order.
  for (const [path, directCount] of folderCounts) {
    let parent = computeParentPath(path);
    while (parent) {
      const parentEntry = folderMap.get(parent);
      if (parentEntry) {
        parentEntry.noteCount += directCount;
      }
      const nextParent = computeParentPath(parent);
      parent = nextParent;
    }
  }

  // Compute latestNoteUpdatedAt per folder (only needed for 'recent' sort)
  if (sortMode === 'recent') {
    const notesByFolder = get(notesByFolderAtom);
    for (const [folderPath, notes] of notesByFolder) {
      const entry = folderMap.get(folderPath);
      if (!entry) continue;
      let maxUpdatedAt = 0;
      for (const note of notes) {
        if (note.updatedAt > maxUpdatedAt) {
          maxUpdatedAt = note.updatedAt;
        }
      }
      if (maxUpdatedAt > 0) {
        entry.latestNoteUpdatedAt = maxUpdatedAt;
      }
    }
  }

  const folders = Array.from(folderMap.values());
  // Direction convention: 'asc' = natural default (A→Z for alpha, newest-first for recent).
  // In recent mode the comparator is (b - a) so dir=1 (asc) yields newest-first.
  const dir = sortDirection === 'asc' ? 1 : -1;
  if (sortMode === 'az') {
    return folders.sort((a, b) => dir * a.name.localeCompare(b.name));
  }
  // 'recent' — sort by latestNoteUpdatedAt (folders with no notes sort last)
  return folders.sort((a, b) => dir * ((b.latestNoteUpdatedAt ?? 0) - (a.latestNoteUpdatedAt ?? 0)));
});

/** User-created folders (excludes system folders like External) */
export const userFolderListAtom = atom((get) =>
  get(folderListAtom).filter((f) => f.type !== 'system')
);

/** External folder entry (the only system folder), or null if not yet registered */
export const externalFolderAtom = atom((get) =>
  get(folderListAtom).find((f) => f.type === 'system' && f.name === 'External') ?? null
);

/** Group notes by folder path for rendering, sorted per user's chosen sort mode */
export const notesByFolderAtom = atom((get) => {
  const notes = get(activeNotesAtom);
  const sortMode = get(notesSortModeAtom);
  const sortDirection = get(notesSortDirectionAtom);
  const dir = sortDirection === 'asc' ? 1 : -1;

  const grouped = new Map<string, NoteEntity[]>();

  for (const note of notes) {
    const folder = note.folderPath ?? NOTES_FOLDER_NAME;
    if (!grouped.has(folder)) {
      grouped.set(folder, []);
    }
    grouped.get(folder)!.push(note);
  }

  // Sort each folder's notes per the user's chosen sort mode
  for (const entries of grouped.values()) {
    if (sortMode === 'az') {
      entries.sort((a, b) => dir * a.title.localeCompare(b.title));
    } else {
      entries.sort((a, b) => dir * (b.updatedAt - a.updatedAt));
    }
  }

  return grouped;
});

/** Notes at the root level (not in any folder) */
export const rootNotesAtom = atom((get) => {
  const notesByFolder = get(notesByFolderAtom);
  return notesByFolder.get(NOTES_FOLDER_NAME) ?? [];
});

// ---------------------------------------------------------------------------
// Selective note queries for better performance
// ---------------------------------------------------------------------------

/**
 * Check if a note exists by ID using O(1) entity lookup.
 * Returns an atom factory - call with a noteId to get an atom for that specific note.
 */
export const noteExistsAtom = (noteId: string) =>
  atom((get) => get(noteEntityAtom(noteId)) !== null);

// ---------------------------------------------------------------------------
// Pinned / unpinned note atoms for panel rendering
// ---------------------------------------------------------------------------

/** Pinned notes sorted by pinnedAt descending (most recently pinned first). */
export const pinnedNotesAtom = atom((get) => {
  const notes = get(activeNotesAtom);
  return notes
    .filter((n) => n.pinned === true || n.pinnedAt != null)
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
});

/** Root notes for the sidebar list, excluding notes already shown in Pinned. */
export const unpinnedRootNotesAtom = atom((get) =>
  get(rootNotesAtom).filter((note) => note.pinned !== true && note.pinnedAt == null)
);

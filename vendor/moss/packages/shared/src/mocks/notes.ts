// ported-from: packages/shared/src/mocks/notes.ts @ 762abb777
import noteChecklist from './notes/files/checklist.md?raw';
import noteChecklistMeta from './notes/files/checklist.json';
import noteJournal from './notes/files/daily-journal.md?raw';
import noteJournalMeta from './notes/files/daily-journal.json';
import type { NoteContentType } from '../types/note-entity';

export type { NoteContentType };

export interface MockNote {
  id: string;
  title: string;
  updatedAt: number;
  folderPath?: string;
  lastOpenedAt?: number | null;
  trashedAt?: number | null;
  contentType?: NoteContentType;
}

interface RawNoteMetadata {
  id: string;
  title: string;
  updatedAt: number;
  folderPath?: string;
  lastOpenedAt?: number | null;
}

const createMockNote = (metadata: RawNoteMetadata, _content: string): MockNote => ({
  id: metadata.id,
  title: metadata.title,
  updatedAt: metadata.updatedAt,
  folderPath: metadata.folderPath ?? 'Notes',
  lastOpenedAt: metadata.lastOpenedAt ?? metadata.updatedAt,
  trashedAt: null
});

export const mockNotes: MockNote[] = [
  createMockNote(noteChecklistMeta, noteChecklist),
  createMockNote(noteJournalMeta, noteJournal)
];

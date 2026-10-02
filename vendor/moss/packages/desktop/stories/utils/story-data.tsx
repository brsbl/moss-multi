// ported-from: packages/desktop/stories/utils/story-data.tsx @ 762abb777
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { Provider as JotaiProvider, useStore } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';

import {
  activeNoteIdAtom,
  mockNotes,
  noteEntityAtom,
  noteIdsAtom,
  notesHydratedAtom,
  setActionTabTimestampNow,
  type MockNote,
  type NoteEntity
} from '@moss/shared';

import type {
  AgentExecuteResultDelta,
  NoteMetadataRecord,
  NoteRecord,
  NoteWithContent,
  StickyTabRecord
} from '../../src/common/noteTypes';
import type { ElectronAPI } from '../../src/types/electron-api';

export const STORY_NOW_ISO = '2025-01-09T12:00:00.000Z';
const deterministicStoryNowMs = Date.UTC(2025, 0, 9, 12, 0, 0);
const parsedStoryNowMs = Date.parse(STORY_NOW_ISO);

export const STORY_NOW_MS = Number.isFinite(parsedStoryNowMs) ? parsedStoryNowMs : deterministicStoryNowMs;
export const STORY_NOW_SECONDS = Math.floor(STORY_NOW_MS / 1000);

let activeStoryNowMs = STORY_NOW_MS;
setActionTabTimestampNow(new Date(activeStoryNowMs));

const syncActionTabTimestamp = () => {
  setActionTabTimestampNow(new Date(activeStoryNowMs));
};

export const setStoryNowMs = (value: number | string | Date): void => {
  const nextValue =
    typeof value === 'number'
      ? value
      : value instanceof Date
        ? value.getTime()
        : Date.parse(value);

  if (Number.isFinite(nextValue)) {
    activeStoryNowMs = nextValue;
    syncActionTabTimestamp();
  }
};

export const resetStoryNowMs = (): void => {
  activeStoryNowMs = STORY_NOW_MS;
  syncActionTabTimestamp();
};

const getStoryNowSeconds = (): number => Math.floor(activeStoryNowMs / 1000);

export const storyNotes: MockNote[] = mockNotes.map((note) => ({
  ...note
}));

const toUnixSeconds = (timestamp: number): number => {
  // timestamp is already in milliseconds, convert to seconds
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : getStoryNowSeconds();
};

const createDraftStickyTab = (id: string, timestamp: number): StickyTabRecord => ({
  id,
  status: 'draft',
  prompt: null,
  responseSummary: null,
  errorMessage: null,
  createdAt: timestamp,
  completedAt: null
});

const createCompletedStickyTab = (
  id: string,
  prompt: string,
  summary: string,
  createdAt: number,
  completedAt: number
): StickyTabRecord => ({
  id,
  status: 'completed',
  prompt,
  responseSummary: summary,
  errorMessage: null,
  createdAt,
  completedAt
});

const createPendingStickyTab = (id: string, prompt: string, createdAt: number): StickyTabRecord => ({
  id,
  status: 'pending',
  prompt,
  responseSummary: null,
  errorMessage: null,
  createdAt,
  completedAt: null
});

const createErrorStickyTab = (
  id: string,
  prompt: string,
  error: string,
  createdAt: number,
  completedAt: number
): StickyTabRecord => ({
  id,
  status: 'error',
  prompt,
  responseSummary: null,
  errorMessage: error,
  createdAt,
  completedAt
});

const mapNotesToRecords = (notes: MockNote[], nowSeconds = getStoryNowSeconds()): NoteWithContent[] =>
  notes.map((note, index) => {
    const timestamp = toUnixSeconds(note.updatedAt);
    const now = nowSeconds;

    // Create different action tab patterns for different notes
    const stickyTabs: StickyTabRecord[] = [];

    // First note gets multiple submitted actions
    if (index === 0) {
      stickyTabs.push(
        createCompletedStickyTab(
          `${note.id}-completed-1`,
          'Add meeting notes from yesterday',
          'Meeting notes added',
          now - 86400, // 1 day ago
          now - 86100
        ),
        createCompletedStickyTab(
          `${note.id}-completed-2`,
          'Summarize key points',
          'Key points summarized',
          now - 7200, // 2 hours ago
          now - 6900
        ),
        createCompletedStickyTab(
          `${note.id}-completed-3`,
          'Format checklist items',
          'Checklist formatted',
          now - 900, // 15 minutes ago
          now - 600
        ),
        createDraftStickyTab(`${note.id}-draft`, timestamp)
      );
    }
    // Second note gets a mix of states
    else if (index === 1) {
      stickyTabs.push(
        createCompletedStickyTab(
          `${note.id}-completed-1`,
          'Update journal entry',
          'Journal updated',
          now - 3600, // 1 hour ago
          now - 3300
        ),
        createPendingStickyTab(
          `${note.id}-pending-1`,
          'Analyze emotional patterns',
          now - 180 // 3 minutes ago
        ),
        createDraftStickyTab(`${note.id}-draft`, timestamp)
      );
    }
    // Default: just a draft tab
    else {
      stickyTabs.push(createDraftStickyTab(`${note.id}-draft`, timestamp));
    }

    return {
      id: note.id,
      title: note.title,
      createdAt: timestamp,
      updatedAt: timestamp,
      folderPath: note.folderPath ?? 'Notes',
      lastOpenedAt: timestamp,
      trashedAt: null,
      content: '',
      stickyTabs
    };
  });

let currentRecords: NoteWithContent[] = mapNotesToRecords(storyNotes);

const getNoteRecordById = (id: string): NoteWithContent | undefined =>
  currentRecords.find((record) => record.id === id);

const mapRecordToMetadata = (record: NoteWithContent): NoteMetadataRecord => ({
  id: record.id,
  title: record.title,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  folderPath: record.folderPath ?? 'Notes',
  lastOpenedAt: record.lastOpenedAt ?? null,
  trashedAt: record.trashedAt ?? null
});

const mapRecordToResponse = (record: NoteWithContent): NoteRecord => ({
  id: record.id,
  title: record.title,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  folderPath: record.folderPath ?? 'Notes',
  lastOpenedAt: record.lastOpenedAt ?? null,
  trashedAt: record.trashedAt ?? null,
  stickyTabs: record.stickyTabs
});

const createElectronBridge = (): ElectronAPI => ({
  notes: {
    getAll: async () => currentRecords.map(mapRecordToMetadata),
    getMetadataByIds: async (noteIds: string[]) =>
      currentRecords
        .filter((record) => noteIds.includes(record.id))
        .map(mapRecordToMetadata),
    getById: async (noteId: string) => getNoteRecordById(noteId),
    getContent: async (noteId: string) => {
      const record = getNoteRecordById(noteId);
      if (!record) return undefined;
      return { id: noteId, content: record.content ?? '', version: 1 };
    },
    create: async () => {
      throw new Error('Story bridge does not support note creation');
    },
    update: async (noteId: string, input: { title?: string; content?: string }) => {
      const record = getNoteRecordById(noteId);
      if (!record) {
        return undefined;
      }

      if (typeof input.title === 'string') {
        record.title = input.title;
      }
      if (typeof input.content === 'string') {
        record.content = input.content;
      }

      record.updatedAt = getStoryNowSeconds();
      return mapRecordToResponse(record);
    },
    delete: async (noteId: string) => {
      const record = getNoteRecordById(noteId);
      if (!record) {
        return false;
      }
      record.trashedAt = getStoryNowSeconds();
      return true;
    },
    restore: async (noteId: string) => {
      const record = getNoteRecordById(noteId);
      if (!record) {
        return undefined;
      }
      record.trashedAt = null;
      record.updatedAt = getStoryNowSeconds();
      return mapRecordToResponse(record);
    },
    search: async () => [],
    getHeadings: async () => [],
    showInFinder: async () => {},
    exportMarkdown: async () => ({ canceled: false, filePath: '' }),
    onExternalFileOpen: () => () => {},
    onInternalFileOpen: () => () => {},
    onDiskChange: (_callback: (_noteIds: string[]) => void) => () => {},
    onMetadataReindexed: (_callback: (_noteIds: string[]) => void) => () => {},
    onRequestFlush: (_callback: () => void) => () => {},
    flushComplete: async () => {}
  },
  folders: {
    list: async () => [],
    create: async () => {
      throw new Error('Story bridge does not support folder creation');
    },
    rename: async () => {
      throw new Error('Story bridge does not support folder rename');
    },
    delete: async () => {
      throw new Error('Story bridge does not support folder deletion');
    },
    moveNotes: async () => {
      throw new Error('Story bridge does not support moving notes');
    },
    moveFolder: async () => {
      throw new Error('Story bridge does not support moving folders');
    },
    showInFinder: async () => {}
  },
  agent: {
    execute: async (): Promise<AgentExecuteResultDelta> => {
      const record = currentRecords[0];
      return {
        noteId: record?.id ?? 'story-note-id',
        stickyTabs: record?.stickyTabs ?? [],
        updatedAt: STORY_NOW_SECONDS,
        executedTabId: 'story-tab',
        createdTabId: 'story-draft'
      };
    },
    cancel: async () => {},
    cancelByTabId: async () => {},
    onStream: () => () => {}
  },
  chat: {
    getMessages: async () => []
  },
  checkpoints: {
    getAll: async () => []
  },
  files: {
    search: async () => [],
    listDirectory: async () => [],
    open: async () => []
  },
  images: {
    save: async () => ({
      relativePath: 'assets/image.png',
      absolutePath: '/tmp/assets/image.png',
      filename: 'image.png'
    }),
    pick: async () => [],
    persistUrl: async () => ({
      relativePath: 'assets/image.png',
      absolutePath: '/tmp/assets/image.png',
      filename: 'image.png'
    }),
    copyFromPath: async () => ({
      relativePath: 'assets/image.png',
      absolutePath: '/tmp/assets/image.png',
      filename: 'image.png'
    }),
    copyFromNoteAsset: async () => ({
      relativePath: 'assets/image.png',
      absolutePath: '/tmp/assets/image.png',
      filename: 'image.png'
    })
  },
  system: {
    showEmojiPanel: async () => {},
    getGlobalShortcut: async () => ({ quickCapture: 'CommandOrControl+Shift+M', enabled: true }),
    setGlobalShortcut: async () => true,
    setGlobalShortcutEnabled: async () => {},
    createWindow: async () => ({ action: 'created' as const, windowId: 2 }),
    getWindowContext: async () => ({
      windowId: 1,
      initialNoteId: null,
      launchReason: 'initial-launch' as const,
      openedFromWindowId: null
    }),
    setFocusedNoteId: async () => {},
    startWindowDrag: async () => {},
    moveWindowDrag: async () => {},
    endWindowDrag: async () => {},
    onGlobalShortcutActivated: () => () => {},
    waitForReady: async () => {}
  },
  filesystem: {
    openFolderDialog: async () => [],
    openFileDialog: async () => [],
    readDirectory: async () => ({ path: '/Users/storybook', entries: [] }),
    getHomeDirectory: async () => '/Users/storybook',
    readFile: async () => ({ content: '', size: 0, truncated: false, mimeType: 'text/plain', isText: true })
  },
  grantedDirs: {
    list: async () => [],
    grant: async () => [],
    revoke: async () => []
  },
  externalNotes: {
    close: async () => false,
    closeByRoot: async () => [],
    resolveLink: async () => null
  },
  update: {
    install: async () => {},
    onReady: () => () => {}
  },
  analytics: {
    capture: async () => {},
  },
  shell: {
    revealPath: async () => {}
  },
  settings: {
    getNoteIntelligence: async () => true,
    setNoteIntelligence: async () => {},
    getTheme: async () => 'system',
    setTheme: async () => {},
    isDefaultMdEditor: async () => false,
    setDefaultMdEditor: async () => false,
    getDefaultEditorPromptDismissed: async () => true,
    setDefaultEditorPromptDismissed: async () => {}
  },
  appConfig: {
    getWorkspacePath: async () => ({ path: null, envOverride: false, effectivePath: '/Users/test/Moss' }),
    setWorkspacePath: async () => ({ success: true }),
    pickWorkspaceFolder: async () => null,
    restartApp: async () => {}
  },
  htmlPreview: {
    ensure: async () => null,
    onMaterialized: () => () => {},
    onFailed: () => () => {}
  },
  videoThumbnail: {
    ensure: async () => null,
    onMaterialized: () => () => {}
  }
});

export const registerStoryBridge = (notes: MockNote[]): void => {
  if (typeof window === 'undefined') {
    return;
  }

  currentRecords = mapNotesToRecords(notes);

  const storyWindow = window as typeof window & {
    electronAPI?: ElectronAPI;
  };

  storyWindow.electronAPI = createElectronBridge();
};

type StoryAppProviderProps = {
  notes: MockNote[];
  activeId: string | null;
  children: ReactNode;
};

export const StoryAppProvider = ({ notes, activeId, children }: StoryAppProviderProps) => {
  registerStoryBridge(notes);

  return (
    <JotaiProvider>
      <HydratedNotesProvider notes={notes} activeId={activeId}>
        {children}
      </HydratedNotesProvider>
    </JotaiProvider>
  );
};

/**
 * Hydrates entity atoms for story components.
 * All hydration happens synchronously via useHydrateAtoms to support SSR/static rendering.
 */
const HydratedNotesProvider = ({
  notes,
  activeId,
  children
}: {
  notes: MockNote[];
  activeId: string | null;
  children: ReactNode;
}) => {
  const store = useStore();

  // Hydrate activeNoteIdAtom
  useHydrateAtoms(useMemo(() => [[activeNoteIdAtom, activeId]], [activeId]));

  // Hydrate new noteEntityAtom and noteIdsAtom (atomFamily can't use useHydrateAtoms)
  useMemo(() => {
    const ids = new Set<string>();
    for (const note of notes) {
      ids.add(note.id);
      const entity: NoteEntity = {
        id: note.id,
        title: note.title,
        createdAt: note.updatedAt,
        updatedAt: note.updatedAt,
        trashedAt: note.trashedAt ?? null,
        lastOpenedAt: note.updatedAt,
        folderPath: note.folderPath ?? 'Notes',
        contentType: note.contentType ?? 'empty',
        links: { outgoing: [], incoming: [] }
      };
      store.set(noteEntityAtom(note.id), entity);
    }
    store.set(noteIdsAtom, ids);
    // Mark as hydrated so the App hydration gate passes
    store.set(notesHydratedAtom, true);
  }, [notes, store]);

  return <>{children}</>;
};

export const findStoryNote = (id: string): MockNote | undefined =>
  storyNotes.find((note) => note.id === id);

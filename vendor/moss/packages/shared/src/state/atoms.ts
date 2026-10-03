// ported-from: packages/shared/src/state/atoms.ts @ 762abb777
import { atom } from 'jotai';

import type { MockNote } from '../mocks';
import {
  MICRO_EDIT_RE,
  SHORT_DIRECTIVE_EDIT_RE,
  SHORT_DIRECTIVE_MAX_LEN,
  HEAVY_WORK_RE,
  GENERATIVE_WORK_RE
} from '../lib/prompt-classification';
import type { ActionPlanChange, ActionPlanTodo } from '../types/action-plan';
import type { ActionTabMetrics, ActionTabStageMetrics } from '../types/action-tab-metrics';
import type { NoteEntity } from '../types/note-entity';
import {
  activeNotesAtom,
  noteEntityAtom,
  noteIdsAtom,
  noteLinksAtom,
  notesHydratedAtom,
  removeNoteEntityAtom
} from './note-atoms';
import {
  activeAgentNoteIdsAtom,
  noteActionTabsAtom,
  noteExpandedActionTabIdsAtom,
  notePromptDraftAtom,
  pendingAgentExecutionNoteIdsAtom
} from './note-runtime-atoms';

export {
  activeAgentNoteIdsAtom,
  buildLinkResolutionCacheKey,
  cleanupLinkResolutionCache,
  initializedNoteIdsAtom,
  linkResolutionAtom,
  noteActionTabsAtom,
  noteExpandedActionTabIdsAtom,
  notePromptDraftAtom,
  pendingAgentExecutionNoteIdsAtom,
  type LinkResolutionCacheEntry
} from './note-runtime-atoms';

type ElectronNotesAPI = {
  getAll?: () => Promise<NoteMetadataRecord[]>;
  getMetadataByIds?: (noteIds: string[]) => Promise<NoteMetadataRecord[]>;
};

type ElectronAPI = {
  notes?: ElectronNotesAPI;
};

const getElectronAPI = (): ElectronAPI | undefined =>
  typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: ElectronAPI }).electronAPI;

/**
 * Sticky tab record persisted in note metadata (meta.json).
 * Timestamp fields use Unix seconds (number) for compact storage.
 * @deprecated Use ActionTabRecord from noteTypes.ts instead
 */
type StickyTabRecord = {
  id: string;
  status: 'draft' | 'pending' | 'completed' | 'error' | 'interrupted';
  prompt?: string | null;
  responseSummary: string | null;
  errorMessage?: string | null;
  /** Unix timestamp in seconds when the tab was created */
  createdAt?: number;
  /** Unix timestamp in seconds when the tab completed (null if not completed) */
  completedAt?: number | null;
};

type NoteContentType =
  | 'empty'
  | 'code'
  | 'charts'
  | 'images'
  | 'media'
  | 'large-text'
  | 'medium-text';

/** Link info for note connections (matches NoteLinkInfo) */
type NoteMetadataLinkInfo = {
  noteId: string;
  title: string;
  folderPath?: string;
  preview?: string;
  updatedAt?: number;
};

type NoteMetadataRecord = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderPath?: string;
  contentPath?: string;
  lastOpenedAt?: number | null;
  content?: string;
  noteHierarchyCache?: {
    hierarchy?: {
      headings?: NoteMetadataHeading[];
      contentSignalText?: unknown;
    };
  };
  stickyTabs?: StickyTabRecord[];
  trashedAt?: number | null;
  contentType?: NoteContentType;
  externalFilePath?: string;
  externalRootPath?: string;
  /** Notes this note links to (outgoing wiki links) */
  outgoingLinks?: NoteMetadataLinkInfo[];
  /** Notes that link to this note (backlinks) */
  incomingLinks?: NoteMetadataLinkInfo[];
  pinned?: boolean;
  pinnedAt?: number | null;
};

type NoteMetadataHeading = {
  text?: unknown;
  children?: NoteMetadataHeading[];
};

const CONTENT_SIGNAL_MAX_CHARS = 2400;

const resolvePinnedState = (
  pinned: boolean | undefined,
  pinnedAt: number | null | undefined
): boolean => pinned === true || (pinned == null && pinnedAt != null);

const collectHeadingSignalText = (headings: NoteMetadataHeading[] | undefined, output: string[]): void => {
  if (!Array.isArray(headings)) {
    return;
  }

  for (const heading of headings) {
    if (!heading || typeof heading !== 'object') {
      continue;
    }
    if (typeof heading.text === 'string' && heading.text.trim().length > 0) {
      output.push(heading.text.trim());
    }
    collectHeadingSignalText(heading.children, output);
  }
};

const buildContentSignalText = (record: NoteMetadataRecord): string | undefined => {
  const parts: string[] = [];
  if (typeof record.content === 'string' && record.content.trim().length > 0) {
    parts.push(record.content.slice(0, CONTENT_SIGNAL_MAX_CHARS));
  }
  const cachedContentSignal = record.noteHierarchyCache?.hierarchy?.contentSignalText;
  if (typeof cachedContentSignal === 'string' && cachedContentSignal.trim().length > 0) {
    parts.push(cachedContentSignal.slice(0, CONTENT_SIGNAL_MAX_CHARS));
  }
  collectHeadingSignalText(record.noteHierarchyCache?.hierarchy?.headings, parts);

  const signal = parts.join('\n').trim();
  return signal.length > 0 ? signal.slice(0, CONTENT_SIGNAL_MAX_CHARS) : undefined;
};

export const mapNoteMetadataToNoteEntity = (record: NoteMetadataRecord): NoteEntity => {
  const pinnedAt = record.pinnedAt ?? null;
  const contentSignalText = buildContentSignalText(record);

  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt ?? record.createdAt,
    trashedAt: record.trashedAt ?? null,
    lastOpenedAt: record.lastOpenedAt ?? null,
    folderPath: record.folderPath ?? 'Notes',
    contentPath: record.contentPath,
    contentType: record.contentType ?? 'empty',
    externalFilePath: record.externalFilePath,
    externalRootPath: record.externalRootPath,
    contentSignalText,
    pinned: resolvePinnedState(record.pinned, pinnedAt),
    pinnedAt,
    links: {
      outgoing: record.outgoingLinks ?? [],
      incoming: record.incomingLinks ?? []
    }
  };
};

const isNoteMetadataRecord = (value: unknown): value is NoteMetadataRecord =>
  Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as { id?: unknown }).id === 'string' &&
      typeof (value as { title?: unknown }).title === 'string' &&
      typeof (value as { createdAt?: unknown }).createdAt === 'number' &&
      typeof (value as { updatedAt?: unknown }).updatedAt === 'number'
  );

/**
 * Write-only atom for hydrating notes on app startup and reconciling state.
 * Fetches all notes from IPC and populates noteEntityAtom + noteIdsAtom.
 *
 * Reconciliation: If atoms already exist, compares against fresh backend data
 * and removes orphaned atoms (e.g., for permanently deleted notes after 30 days in trash).
 *
 * Usage: Call `store.set(hydrateNotesAtom)` in App.tsx useEffect on mount.
 */
export const hydrateNotesAtom = atom(null, async (get, set) => {
  const existingIds = get(noteIdsAtom);

  const api = getElectronAPI();

  const fetchNotes = api?.notes?.getAll;
  if (!fetchNotes) {
    return;
  }

  try {
    const fetchedNotes = await fetchNotes();
    if (!Array.isArray(fetchedNotes)) {
      return;
    }

    const validRecords = fetchedNotes.filter(isNoteMetadataRecord);

    // Collect all note IDs from backend
    const freshIds = new Set<string>();
    for (const record of validRecords) {
      freshIds.add(record.id);
    }

    // Reconcile: remove atoms for notes no longer in backend
    // This handles permanently deleted notes (30+ days in trash)
    // moss-multi seam: a vault switch replaces the sidebar, never an open editor.
    const orphanedIds = [...existingIds].filter((id) => !freshIds.has(id) && id !== get(activeNoteIdAtom) && id !== get(splitTabNoteIdAtom));
    if (orphanedIds.length > 0) {
      await Promise.all(orphanedIds.map((id) => set(removeNoteEntityAtom, id)));
    }

    // Hydrate/update noteEntityAtom from the metadata
    for (const record of validRecords) {
      // Populate noteEntityAtom with full entity data (includes links)
      const entity = mapNoteMetadataToNoteEntity(record);
      set(noteEntityAtom(record.id), entity);
    }

    // Update the noteIdsAtom index
    set(noteIdsAtom, freshIds);

    set(notesHydratedAtom, true);
  } catch (error) {
    // Log hydration errors during development for debugging
    console.error('[hydrateNotesAtom] Failed to hydrate notes:', error);
    // Still mark as hydrated so the app isn't permanently stuck on the loading gate
    set(notesHydratedAtom, true);
  }
});

/**
 * Write-only atom for a targeted note-list metadata refresh.
 *
 * Unlike hydrateNotesAtom (which fetches every note via getAll and re-sets
 * every note entity), this fetches metadata for only the given note IDs and
 * updates just those entities. A content-only disk change to a few notes can
 * therefore refresh only the affected rows instead of re-rendering the whole
 * note list.
 *
 * Returns the requested IDs that had no backend metadata record (e.g. deleted
 * or otherwise missing), so callers can fall back to a full hydrate for
 * reconciliation. If the targeted IPC is unavailable, every requested ID is
 * reported missing so the caller falls back.
 */
export const syncNotesMetadataByIdsAtom = atom(
  null,
  async (get, set, noteIds: string[]): Promise<{ missingIds: string[] }> => {
    const uniqueIds = [
      ...new Set(noteIds.filter((id) => typeof id === 'string' && id.length > 0))
    ];
    if (uniqueIds.length === 0) {
      return { missingIds: [] };
    }

    const api = getElectronAPI();
    const fetchMetadata = api?.notes?.getMetadataByIds;
    if (!fetchMetadata) {
      return { missingIds: uniqueIds };
    }

    try {
      const fetched = await fetchMetadata(uniqueIds);
      const validRecords = Array.isArray(fetched) ? fetched.filter(isNoteMetadataRecord) : [];

      const existingIds = get(noteIdsAtom);
      const foundIds = new Set<string>();
      const idsToAdd: string[] = [];

      for (const record of validRecords) {
        foundIds.add(record.id);
        const entity = mapNoteMetadataToNoteEntity(record);

        // Preserve existing links only when the record omits them (matches
        // the metadata pipeline, where records normally carry links).
        if (record.outgoingLinks == null && record.incomingLinks == null) {
          const currentEntity = get(noteEntityAtom(record.id));
          if (currentEntity) {
            entity.links = {
              outgoing: [...currentEntity.links.outgoing],
              incoming: [...currentEntity.links.incoming]
            };
          }
        }

        set(noteEntityAtom(record.id), entity);
        if (!existingIds.has(record.id)) {
          idsToAdd.push(record.id);
        }
      }

      if (idsToAdd.length > 0) {
        set(noteIdsAtom, (prev: Set<string>) => {
          const next = new Set(prev);
          for (const id of idsToAdd) {
            next.add(id);
          }
          return next;
        });
      }

      const missingIds = uniqueIds.filter((id) => !foundIds.has(id));
      return { missingIds };
    } catch (error) {
      console.warn('[syncNotesMetadataByIdsAtom] Failed targeted metadata refresh:', error);
      return { missingIds: uniqueIds };
    }
  }
);

/**
 * Helper to map NoteEntity to MockNote for backward compatibility.
 */
const mapEntityToMockNote = (entity: NoteEntity): MockNote => ({
  id: entity.id,
  title: entity.title,
  updatedAt: entity.updatedAt,
  folderPath: entity.folderPath,
  lastOpenedAt: entity.lastOpenedAt,
  trashedAt: entity.trashedAt,
  contentType: entity.contentType
});

/**
 * @deprecated Use `noteEntityAtom` from `@moss/shared/state/note-atoms` instead.
 * This atom is kept for backward compatibility during migration.
 * Access individual notes via `noteEntityAtom(noteId)` and iterate using `noteIdsAtom`.
 *
 * Now derived from noteEntityAtom + noteIdsAtom - read-only.
 */
export const notesAtom = atom<MockNote[]>((get) => {
  const noteIds = get(noteIdsAtom);
  return Array.from(noteIds)
    .map((id) => get(noteEntityAtom(id)))
    .filter((entity): entity is NoteEntity => entity !== null)
    .map(mapEntityToMockNote);
});

export const LAST_VIEWED_NOTE_STORAGE_KEY = 'moss/session:lastViewedNoteId';
export const LAST_VIEWED_TRASHED_NOTE_STORAGE_KEY = 'moss/session:lastViewedTrashedNoteId';

const baseActiveNoteIdAtom = atom<string | null>(null);

export const activeNoteIdAtom = atom(
  (get) => {
    const storedId = get(baseActiveNoteIdAtom);
    const noteIds = get(noteIdsAtom);

    // Check if stored ID exists (allow trashed notes - needed for trash view)
    if (storedId && noteIds.has(storedId)) {
      const entity = get(noteEntityAtom(storedId));
      if (entity) {
        return storedId;
      }
    }

    // Fall back to most recent non-trashed note
    const activeNotes = get(activeNotesAtom);
    return activeNotes[0]?.id ?? null;
  },
  (get, set, update: string | null | ((prev: string | null) => string | null)) => {
    const nextValue = typeof update === 'function' ? update(get(baseActiveNoteIdAtom)) : update;
    set(baseActiveNoteIdAtom, nextValue);
    // moss-multi seam: one-doc-split (A§10.1): the left pane moving to the split's note closes the split, as moss's
    // sidebar already does, whatever the path (back, forward, a link).
    if (nextValue && nextValue === get(splitTabNoteIdAtom)) set(closeSplitTabAtom);

    if (!nextValue) {
      return;
    }

    const matchingNote = get(noteEntityAtom(nextValue));
    if (!matchingNote) {
      return;
    }

    if (matchingNote.trashedAt != null) {
      set(lastViewedTrashedNoteIdAtomInternal, nextValue);
    } else {
      set(lastViewedNoteIdAtom, nextValue);
    }
  }
);

const getStoredValue = (key: string): string | null => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const rememberValue = (key: string, value: string | null): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }

  try {
    if (value) {
      window.localStorage.setItem(key, value);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage issues (e.g., private browsing restrictions).
  }
};

const baseLastViewedNoteIdAtom = atom<string | null>(getStoredValue(LAST_VIEWED_NOTE_STORAGE_KEY));

export const lastViewedNoteIdAtom = atom(
  (get) => get(baseLastViewedNoteIdAtom),
  (get, set, update: string | null | ((prev: string | null) => string | null)) => {
    const nextValue = typeof update === 'function' ? update(get(baseLastViewedNoteIdAtom)) : update;
    rememberValue(LAST_VIEWED_NOTE_STORAGE_KEY, nextValue);
    set(baseLastViewedNoteIdAtom, nextValue);
  }
);

const baseLastViewedTrashedNoteIdAtom = atom<string | null>(
  getStoredValue(LAST_VIEWED_TRASHED_NOTE_STORAGE_KEY)
);

// Internal atom for trashed note tracking - not exported directly.
// Use lastViewedNoteIdForViewAtom for unified access.
const lastViewedTrashedNoteIdAtomInternal = atom(
  (get) => get(baseLastViewedTrashedNoteIdAtom),
  (get, set, update: string | null | ((prev: string | null) => string | null)) => {
    const nextValue =
      typeof update === 'function' ? update(get(baseLastViewedTrashedNoteIdAtom)) : update;
    rememberValue(LAST_VIEWED_TRASHED_NOTE_STORAGE_KEY, nextValue);
    set(baseLastViewedTrashedNoteIdAtom, nextValue);
  }
);

/**
 * View type for note selection tracking.
 * Used with lastViewedNoteIdForViewAtom for unified localStorage routing.
 */
export type NoteViewType = 'notes' | 'trash';

// Pre-created atoms for stable references (avoid creating new atoms on each call)
const lastViewedNoteIdForNotesAtomInstance = atom(
  (get) => get(lastViewedNoteIdAtom),
  (_get, set, update: string | null | ((prev: string | null) => string | null)) => {
    set(lastViewedNoteIdAtom, update);
  }
);

const lastViewedNoteIdForTrashAtomInstance = atom(
  (get) => get(lastViewedTrashedNoteIdAtomInternal),
  (_get, set, update: string | null | ((prev: string | null) => string | null)) => {
    set(lastViewedTrashedNoteIdAtomInternal, update);
  }
);

/**
 * Unified atom for getting/setting the last viewed note ID based on view type.
 * Routes to correct localStorage key internally:
 * - 'notes' -> moss/session:lastViewedNoteId
 * - 'trash' -> moss/session:lastViewedTrashedNoteId
 *
 * @param viewType - The current view ('notes' or 'trash')
 * @returns A writable atom for the last viewed note ID in that view
 */
export const lastViewedNoteIdForViewAtom = (viewType: NoteViewType) =>
  viewType === 'trash'
    ? lastViewedNoteIdForTrashAtomInstance
    : lastViewedNoteIdForNotesAtomInstance;

/** Represents an active tool execution */
export interface ActiveToolExecution {
  toolId: string;
  toolName: string;
  startedAt: number;
}

/** Per-tab execution timing telemetry (all timestamps are Unix seconds). */
export interface ActionTabTiming {
  startedAt?: number;
  firstTextAt?: number;
  lastTextAt?: number;
  firstToolStartAt?: number;
  firstEditorUpdateAt?: number;
  lastToolEndAt?: number;
  completedAt?: number;
  persistedAt?: number;
}

/** Mention metadata captured from prompt submission for read-only timeline rendering. */
export interface ActionPromptMention {
  id: string;
  title: string;
  type: 'note' | 'directory' | 'folder';
  /** Cached file count: 1 for notes, readdir length for directories/folders */
  fileCount?: number;
}

/**
 * Original execution inputs for an action, captured at submit time so a
 * "Try again" retry can reproduce the run with the same skills, referenced
 * notes/directories, and images (independent of current context pills).
 */
export interface ActionRetryInputs {
  /** Skills injected for the run (e.g. ['html'] for mockup mode). */
  skills?: string[];
  /** @-mentioned note ids passed into the original run. */
  referencedNoteIds?: string[];
  /** @-mentioned directory paths passed into the original run. */
  referencedDirectories?: string[];
  /** Context-pill folder paths merged into the original run (connectedFolderPaths). */
  connectedFolderPaths?: string[];
  /** Pasted/attached image data URLs from the original run. */
  imageUrls?: string[];
  /** Comment-sourced image paths from the original run. */
  commentImagePaths?: string[];
}

/**
 * Action tab entry for in-memory UI state.
 * Timestamp fields use ISO 8601 strings for display formatting and JSON serialization.
 * Note: StickyTabRecord uses Unix seconds (number) for persistence; convert when hydrating.
 */
export interface ActionTabEntry {
  id: string;
  /**
   * Tab status. 'draft' is deprecated and will be removed in future versions.
   * New code should only use 'pending' | 'completed' | 'error' | 'interrupted'.
   */
  status: 'draft' | 'pending' | 'completed' | 'error' | 'interrupted';
  prompt: string | null;
  /** Mention metadata for rendering @-pills in submitted user prompts. */
  promptMentions?: ActionPromptMention[];
  /**
   * Context added above the command-palette input (connected folders or
   * carried-over pills) at submit time, deduped against in-prompt mentions.
   * Rendered as read-only pills in the timeline user message so it is a
   * faithful receipt of every context source.
  */
  contextMentions?: ActionPromptMention[];
  /** Structured comment quote context captured at submit for timeline display. */
  commentContext?: PendingAgentCommentContext;
  /** Absolute paths of images uploaded with the prompt (command palette). */
  imageUrls?: string[];
  /**
   * Reason for interruption (only set when status is 'interrupted').
   * - 'trashed': Note was moved to trash while agent was running
   * - 'user-cancelled': User clicked stop button
   * - 'app-reload': App was closed/reloaded while agent was running
   */
  interruptReason?: 'trashed' | 'user-cancelled' | 'app-reload';
  /**
   * @deprecated Use messages[] instead. Preserved for backward compatibility with old notes.
   */
  responseSummary: string | null;
  errorMessage: string | null;
  /** ISO 8601 timestamp string when the tab was created (null if not set) */
  createdAt: string | null;
  /** ISO 8601 timestamp string when the tab completed (null if not completed) */
  completedAt: string | null;
  submittedLabel: string | null;
  todos: ActionPlanTodo[];
  changes: ActionPlanChange[];
  trigger?: 'agent';
  /** Model used for this execution (e.g. 'haiku', 'sonnet', 'opus') */
  model?: string;
  /** Routing profile tier that selected the model */
  profile?: 'fast' | 'balanced' | 'quality';
  /** Whether this action used the mockup skill */
  mockupMode?: boolean;
  /**
   * Original execution inputs captured at submit time so "Try again" can
   * faithfully reproduce the run (skills, @-mentioned notes/dirs, images).
   * In-memory only (not persisted to disk), matching mockupMode.
   */
  retryInputs?: ActionRetryInputs;
  /** Execution timing telemetry captured across stream + persistence boundaries */
  timing?: ActionTabTiming;
  /** Extended structured metrics persisted with the tab for QA scorecards */
  metrics?: ActionTabMetrics;
  /**
   * @deprecated Use messages[] instead. Preserved for backward compatibility with old notes.
   */
  completionText?: string;
  /** Canonical message storage - array of agent response turns */
  messages: string[];
  /** Scratch pad content */
  scratchPadContent?: string;
  /** Full markdown snapshot of the note at the time this action started executing */
  contentSnapshot?: string;

  // Streaming state (unified - replaces tabStreamingStatesAtom)
  /** Current text being streamed (accumulated within current turn) */
  streamingText: string;
  /** Whether the agent is currently streaming for this tab */
  isStreaming: boolean;
  /** Tools currently executing (tool_start received but not tool_end) */
  activeTools: ActiveToolExecution[];
  /** Last tool that started - persists its status message until the next tool starts */
  lastToolName: string | null;
  /** Last error if any */
  streamError: {
    code: string;
    message: string;
    /** Specific runtime/result cause used to select recovery actions. */
    classification?: string;
    /** Whether re-running the original prompt is offered ("Try again"). */
    retryable?: boolean;
    /**
     * Visual treatment for the outcome card:
     * - 'error'   → red error card
     * - 'neutral' → muted card (e.g. empty_success, "agent returned nothing")
     */
    severity?: 'error' | 'neutral';
  } | null;
  /** Counts how many times each tool has been called during this streaming session */
  toolCallCounts: Record<string, number>;
  /** Comment ID that triggered this agent run via "Send to Agent" */
  sourceCommentId?: string;
  /** Anchor text from selection pill — used to scroll editor to relevant area during streaming */
  sourceContextText?: string;
  /** Optional icon for the source context pill shown in the submitted user message. */
  sourceContextIconUrl?: string;
  /** Keyword-matched ack injected at stream start, displayed as first timeline message */
  syntheticAck: string | null;
}

/**
 * Reason for agent interruption.
 * - 'trashed': Note was moved to trash while agent was running
 * - 'user-cancelled': User clicked stop button
 * - 'app-reload': App was closed/reloaded while agent was running
 */
export type InterruptReason = 'trashed' | 'user-cancelled' | 'app-reload';

/**
 * User-friendly messages for each interruption reason.
 * Displayed in the action tab when agent is interrupted.
 */
export const INTERRUPT_MESSAGES: Record<InterruptReason, string> = {
  'trashed': 'Agent stopped: Note was moved to trash',
  'user-cancelled': 'Agent stopped by user',
  'app-reload': 'Agent stopped: App was closed'
};

// ── Split tab state ─────────────────────────────────────────────────────
// Defined here (before derived consumers) because activeActionTabsAtom,
// activeExpandedActionTabIdsAtom, and promptDraftAtom read focusedNoteIdAtom.

/** Note ID shown in the split (right) pane. null when no split is open. */
export const splitTabNoteIdAtom = atom<string | null>(null);

/** Left-pane width fraction, clamped to [0.3, 0.7]. */
export const splitRatioAtom = atom<number>(0.5);

/** Which pane currently has focus. */
export const focusedPaneAtom = atom<'left' | 'right'>('left');

/** Whether a split tab is currently open. */
export const isSplitOpenAtom = atom((get) => get(splitTabNoteIdAtom) !== null);

/**
 * Resolves to the note ID of whichever pane has focus.
 * When split is closed, always equals activeNoteIdAtom.
 */
export const focusedNoteIdAtom = atom((get) => {
  const splitNoteId = get(splitTabNoteIdAtom);
  if (splitNoteId === null) return get(activeNoteIdAtom);
  const focused = get(focusedPaneAtom);
  return focused === 'right' ? splitNoteId : get(activeNoteIdAtom);
});

/** Navigation history for the split (right) pane. Mirrors NavigationHistoryState. */
const splitNavHistoryAtom = atom<NavigationHistoryState>({ stack: [], index: -1 });

export const splitCanGoBackAtom = atom((get) => {
  const { index } = get(splitNavHistoryAtom);
  return index > 0;
});

export const splitCanGoForwardAtom = atom((get) => {
  const { stack, index } = get(splitNavHistoryAtom);
  return index < stack.length - 1;
});

/**
 * Write-only: open a note in the split tab.
 * Replaces any existing split tab content. Rejects if noteId matches the active note.
 * Seeds the split nav history with the opened note.
 */
export const openSplitTabAtom = atom(null, (get, set, noteId: string) => {
  const activeId = get(activeNoteIdAtom);
  if (noteId === activeId) return;
  set(splitTabNoteIdAtom, noteId);
  set(splitNavHistoryAtom, { stack: [noteId], index: 0 });
  // A note split replaces any browser split (single split slot).
  set(browserSplitTargetAtom, null);
  set(browserSplitFullPaneAtom, false);
  set(browserSplitNativeNavigationStateAtom, null);
});

/** Write-only: close the split tab and return to single-pane mode. Clears split nav history. */
export const closeSplitTabAtom = atom(null, (_get, set) => {
  set(splitTabNoteIdAtom, null);
  set(focusedPaneAtom, 'left');
  set(splitNavHistoryAtom, { stack: [], index: -1 });
  set(browserSplitTargetAtom, null);
  set(browserSplitFullPaneAtom, false);
  set(browserSplitNativeNavigationStateAtom, null);
});

/** Write-only: close a specific split-view pane. Closing the left pane promotes the right pane. */
export const closeSplitPaneAtom = atom(null, (get, set, pane: 'left' | 'right') => {
  if (get(browserSplitTargetAtom) !== null) {
    if (pane === 'left') {
      set(browserSplitFullPaneAtom, true);
      set(focusedPaneAtom, 'right');
    } else {
      set(browserSplitTargetAtom, null);
      set(browserSplitFullPaneAtom, false);
      set(browserSplitNativeNavigationStateAtom, null);
      set(focusedPaneAtom, 'left');
    }
    return;
  }

  if (pane === 'left') {
    const splitNoteId = get(splitTabNoteIdAtom);
    if (splitNoteId) {
      set(activeNoteIdAtom, splitNoteId);
    }
  }

  set(splitTabNoteIdAtom, null);
  set(focusedPaneAtom, 'left');
  set(splitNavHistoryAtom, { stack: [], index: -1 });
});

/** Write-only: navigate within the split pane (e.g., wiki-link click). Pushes to split history. */
export const splitNavigateToNoteAtom = atom(
  null,
  (get, set, noteId: string, heading: string | null = null) => {
    const normalizedHeading = heading?.trim() || null;
    const currentId = get(splitTabNoteIdAtom);
    const history = get(splitNavHistoryAtom);
    const currentHeading = history.headings?.[history.index] ?? null;
    if (noteId === currentId && (!normalizedHeading || currentHeading === normalizedHeading)) return;
    // Don't navigate to the same note as the left pane
    const activeId = get(activeNoteIdAtom);
    if (noteId === activeId) return;
    set(splitTabNoteIdAtom, noteId);
    set(splitNavHistoryAtom, (prev) => {
      const newStack = prev.index >= 0
        ? [...prev.stack.slice(0, prev.index + 1), noteId]
        : [noteId];
      const newHeadings = prev.headings || normalizedHeading
        ? [
            ...(prev.headings ?? prev.stack.map(() => null)).slice(0, prev.index + 1),
            normalizedHeading
          ]
        : undefined;
      const cappedStack = newStack.length > 50 ? newStack.slice(-50) : newStack;
      const cappedHeadings = newHeadings && newHeadings.length > 50
        ? newHeadings.slice(-50)
        : newHeadings;
      return {
        stack: cappedStack,
        ...(cappedHeadings ? { headings: cappedHeadings } : {}),
        index: cappedStack.length - 1
      };
    });

    if (normalizedHeading) {
      set(pendingScrollTargetAtom, { noteId, heading: normalizedHeading });
    }
  }
);

/** Write-only: go back in split pane history. */
export const splitGoBackAtom = atom(null, (get, set) => {
  const hist = get(splitNavHistoryAtom);
  if (hist.index <= 0) return;
  const newIndex = hist.index - 1;
  const targetNoteId = hist.stack[newIndex];
  if (targetNoteId) {
    // moss-multi seam: one-doc-split (A§10.1): back to the left pane's note closes the split, as moss's sidebar does
    if (targetNoteId === get(activeNoteIdAtom)) {
      set(closeSplitTabAtom);
      return;
    }
    if (hist.headings) {
      set(pendingScrollTargetAtom, {
        noteId: targetNoteId,
        heading: hist.headings[newIndex] ?? null
      });
    }
    set(splitTabNoteIdAtom, targetNoteId);
    set(splitNavHistoryAtom, { ...hist, index: newIndex });
  }
});

/** Write-only: go forward in split pane history. */
export const splitGoForwardAtom = atom(null, (get, set) => {
  const hist = get(splitNavHistoryAtom);
  if (hist.index >= hist.stack.length - 1) return;
  const newIndex = hist.index + 1;
  const targetNoteId = hist.stack[newIndex];
  if (targetNoteId) {
    // moss-multi seam: one-doc-split (A§10.1): forward to the left pane's note closes the split, as moss's sidebar does
    if (targetNoteId === get(activeNoteIdAtom)) {
      set(closeSplitTabAtom);
      return;
    }
    if (hist.headings) {
      set(pendingScrollTargetAtom, {
        noteId: targetNoteId,
        heading: hist.headings[newIndex] ?? null
      });
    }
    set(splitTabNoteIdAtom, targetNoteId);
    set(splitNavHistoryAtom, { ...hist, index: newIndex });
  }
});

/** Write-only: set which pane has focus. */
export const setFocusPaneAtom = atom(null, (_get, set, pane: 'left' | 'right') => {
  set(focusedPaneAtom, pane);
});

/** Whether the actions panel is hidden. Shared atom so any handler can show/hide it. */
export const actionsPanelHiddenAtom = atom<boolean>(true);

// ── Browser split + web embed lightbox ──────────────────────────────────
// The single split slot holds EITHER a note split (splitTabNoteIdAtom) OR a
// browser split (browserSplitTargetAtom) — never both. Opening one clears the
// other (see openSplitTabAtom / openBrowserSplitAtom). The web embed lightbox
// is the modal browser surface used when no browser split is open.

/** A website target shown in a browser surface (split pane or lightbox). */
export interface WebBrowserTarget {
  url: string;
  title: string;
  /** Note context that created the browser surface, used for asset/session scoping. */
  sourceNoteId?: string | null;
}

/** Request payload for {@link openWebEmbedAtom} and friends. */
export interface WebEmbedOpenRequest {
  url: string;
  title?: string;
  sourceNoteId?: string | null;
}

export interface BrowserSplitNavigationState {
  url: string;
  title?: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Website shown in the browser split (right) pane. null when no browser split is open. */
export const browserSplitTargetAtom = atom<WebBrowserTarget | null>(null);

const browserSplitNavigationRequestIdStateAtom = atom(0);
const browserSplitFocusRequestIdStateAtom = atom(0);

/** Monotonic token for explicit browser split navigation requests, including same-URL retries. */
export const browserSplitNavigationRequestIdAtom = atom((get) =>
  get(browserSplitNavigationRequestIdStateAtom)
);

/** Monotonic token for explicit requests to move keyboard focus into browser chrome. */
export const browserSplitFocusRequestIdAtom = atom((get) =>
  get(browserSplitFocusRequestIdStateAtom)
);

/** Write-only: focus the open browser split without changing its navigation state. */
export const requestBrowserSplitFocusAtom = atom(null, (get, set) => {
  if (get(browserSplitTargetAtom) === null) return;
  set(browserSplitFocusRequestIdStateAtom, (requestId) => requestId + 1);
  set(focusedPaneAtom, 'right');
});

/**
 * Whether the browser split owns the whole canvas after the left note tab was
 * closed. Kept separate from `activeNoteIdAtom` because that atom falls back to
 * the most recent note when set to null.
 */
export const browserSplitFullPaneAtom = atom(false);

/** Whether a browser split tab is currently open. */
export const isBrowserSplitOpenAtom = atom((get) => get(browserSplitTargetAtom) !== null);

/** Website shown in the modal web embed lightbox. null when the lightbox is closed. */
export const webEmbedLightboxTargetAtom = atom<WebBrowserTarget | null>(null);

const browserSplitNativeNavigationStateAtom = atom<BrowserSplitNavigationState | null>(null);

export const browserSplitNativeNavigationAvailableAtom = atom(
  (get) => get(browserSplitNativeNavigationStateAtom) !== null
);

export const browserSplitCanGoBackAtom = atom((get) => {
  const native = get(browserSplitNativeNavigationStateAtom);
  return native?.canGoBack ?? false;
});

export const browserSplitCanGoForwardAtom = atom((get) => {
  const native = get(browserSplitNativeNavigationStateAtom);
  return native?.canGoForward ?? false;
});

export const browserSplitCurrentUrlAtom = atom((get) => {
  const native = get(browserSplitNativeNavigationStateAtom);
  const target = get(browserSplitTargetAtom);
  return native?.url ?? target?.url ?? '';
});

const deriveBrowserTitle = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const resolveBrowserTarget = (
  request: WebEmbedOpenRequest,
  sourceNoteId?: string | null
): WebBrowserTarget => ({
  url: request.url,
  title:
    request.title && request.title.trim().length > 0 ? request.title : deriveBrowserTitle(request.url),
  ...(request.sourceNoteId || sourceNoteId ? { sourceNoteId: request.sourceNoteId ?? sourceNoteId } : {})
});

/**
 * Write-only: open a website as the browser split tab.
 * Single slot — clears any note split and closes the lightbox. Browser
 * back/forward state is native-authoritative and starts disabled until the
 * WebContentsView reports its navigation state.
 */
export const openBrowserSplitAtom = atom(null, (get, set, request: WebEmbedOpenRequest) => {
  set(browserSplitTargetAtom, resolveBrowserTarget(request, request.sourceNoteId ?? get(activeNoteIdAtom)));
  set(browserSplitNavigationRequestIdStateAtom, (requestId) => requestId + 1);
  set(browserSplitFocusRequestIdStateAtom, 0);
  set(browserSplitFullPaneAtom, false);
  set(browserSplitNativeNavigationStateAtom, null);
  // The browser split owns the right side of the app; collapse the Actions panel
  // before rendering so the browser surface has the expected space.
  set(actionsPanelHiddenAtom, true);
  // A browser split replaces any note split (single split slot).
  set(splitTabNoteIdAtom, null);
  set(splitNavHistoryAtom, { stack: [], index: -1 });
  // The lightbox and the split are mutually exclusive surfaces.
  set(webEmbedLightboxTargetAtom, null);
});

/** Write-only: navigate the open browser split to another url. */
export const navigateBrowserSplitAtom = atom(null, (get, set, request: WebEmbedOpenRequest) => {
  const current = get(browserSplitTargetAtom);
  if (current === null) return;
  set(browserSplitTargetAtom, resolveBrowserTarget(request, request.sourceNoteId ?? current.sourceNoteId));
  set(browserSplitNavigationRequestIdStateAtom, (requestId) => requestId + 1);
  set(browserSplitNativeNavigationStateAtom, null);
});

/** Write-only: close the browser split tab. */
export const closeBrowserSplitAtom = atom(null, (_get, set) => {
  set(browserSplitTargetAtom, null);
  set(browserSplitFocusRequestIdStateAtom, 0);
  set(browserSplitFullPaneAtom, false);
  set(browserSplitNativeNavigationStateAtom, null);
  set(focusedPaneAtom, 'left');
});

/** Write-only: close the left note tab and let the browser split fill the canvas. */
export const promoteBrowserSplitToFullPaneAtom = atom(null, (get, set) => {
  if (get(browserSplitTargetAtom) === null) return;
  set(browserSplitFullPaneAtom, true);
  set(focusedPaneAtom, 'right');
});

/** Write-only: sync browser split state from the native WebContentsView. */
export const syncBrowserSplitNavigationStateAtom = atom(
  null,
  (get, set, state: BrowserSplitNavigationState) => {
    const current = get(browserSplitTargetAtom);
    if (!current) return;
    const previous = get(browserSplitNativeNavigationStateAtom);
    if (
      previous?.url === state.url &&
      previous.title === state.title &&
      previous.canGoBack === state.canGoBack &&
      previous.canGoForward === state.canGoForward
    ) {
      return;
    }
    set(browserSplitNativeNavigationStateAtom, state);
  }
);

/** Write-only: close the modal web embed lightbox. */
export const closeWebEmbedLightboxAtom = atom(null, (_get, set) => {
  set(webEmbedLightboxTargetAtom, null);
});

/**
 * Write-only: the shared entry point any web link surface (pill, etc.) calls to
 * "open" a website. Destination:
 *  - a browser split is already open  -> navigate that split to the url,
 *  - otherwise                        -> open the 75%-of-canvas modal lightbox.
 */
export const openWebEmbedAtom = atom(null, (get, set, request: WebEmbedOpenRequest) => {
  if (get(browserSplitTargetAtom) !== null) {
    set(navigateBrowserSplitAtom, request);
    return;
  }
  set(webEmbedLightboxTargetAtom, resolveBrowserTarget(request));
});

/**
 * Derived atom for the active note's action tabs.
 * UI components can use this for convenience.
 */
export const activeActionTabsAtom = atom((get) => {
  const noteId = get(focusedNoteIdAtom);
  if (!noteId) return [];
  return get(noteActionTabsAtom(noteId));
});

/**
 * Derived atom for the active note's expanded action tab IDs.
 */
export const activeExpandedActionTabIdsAtom = atom(
  (get) => {
    const noteId = get(focusedNoteIdAtom);
    if (!noteId) return new Set<string>();
    return get(noteExpandedActionTabIdsAtom(noteId));
  },
  (get, set, update: Set<string> | ((prev: Set<string>) => Set<string>)) => {
    const noteId = get(focusedNoteIdAtom);
    if (!noteId) return;
    const noteAtom = noteExpandedActionTabIdsAtom(noteId);
    if (typeof update === 'function') {
      set(noteAtom, update(get(noteAtom)));
    } else {
      set(noteAtom, update);
    }
  }
);

/** Whether the command palette overlay is open. */
export const showCommandPaletteAtom = atom<boolean>(false);

const COMMAND_PALETTE_DOCKED_STORAGE_KEY = 'moss.commandPalette.docked';

const baseCommandPaletteDockedAtom = atom<boolean>(
  getStoredValue(COMMAND_PALETTE_DOCKED_STORAGE_KEY) === 'true'
);

/**
 * Whether the command palette is docked into the Actions panel. Persisted so
 * docking survives relaunches. While docked the palette renders inside the
 * Actions panel regardless of showCommandPaletteAtom — only an explicit
 * undock removes it.
 */
export const commandPaletteDockedAtom = atom(
  (get) => get(baseCommandPaletteDockedAtom),
  (_get, set, value: boolean) => {
    rememberValue(COMMAND_PALETTE_DOCKED_STORAGE_KEY, value ? 'true' : null);
    set(baseCommandPaletteDockedAtom, value);
  }
);

/** Whether a floating command palette is currently previewing its docked position. */
export const commandPaletteDockPreviewAtom = atom<boolean>(false);

/**
 * Live host element inside the Actions panel timeline that the docked palette
 * portals into. Registered by the panel via ref callback so remounts (note
 * switches, panel hide/reopen, timeline changes) always re-point the palette
 * at the current DOM node instead of a stale querySelector result.
 */
export const commandPaletteDockHostAtom = atom<HTMLElement | null>(null);

/** Where the command palette was triggered from — determines positioning. */
export type CommandPaletteOrigin = 'toolbar' | 'context';
export const commandPaletteOriginAtom = atom<CommandPaletteOrigin>('toolbar');

/** Portal target element for rendering the command palette above the toolbar. */
export const toolbarPortalTargetAtom = atom<HTMLElement | null>(null);

/** Whether note intelligence (auto-inferred metadata + suggested links) is enabled. */
export const noteIntelligenceEnabledAtom = atom<boolean>(false);

/** Cached workspace frontmatter values for property typeahead. Refreshed after saves. */
export const workspaceFrontmatterSuggestionsAtom = atom<Record<string, string[]>>({});

// ---------------------------------------------------------------------------
// Zen mode state (distraction-free writing)
// ---------------------------------------------------------------------------

/** Whether the notes sidebar panel is hidden */
export const notesPanelHiddenAtom = atom<boolean>(false);

/** Whether zen mode is active (both panels hidden) */
export const zenModeAtom = atom<boolean>(false);

/** Snapshot of panel state before entering zen mode, used to restore on exit */
export const zenModeSnapshotAtom = atom<{
  actionsPanelHidden: boolean;
  notesPanelHidden: boolean;
} | null>(null);

/**
 * Write-only atom to toggle zen mode.
 * Enter: saves current panel state snapshot, hides both panels, sets zen true.
 * Exit: restores pre-zen panel state, sets zen false.
 */
export const toggleZenModeAtom = atom(null, (get, set) => {
  const isZen = get(zenModeAtom);

  if (isZen) {
    // Exit zen mode — restore snapshot
    const snapshot = get(zenModeSnapshotAtom);
    set(actionsPanelHiddenAtom, snapshot?.actionsPanelHidden ?? false);
    set(notesPanelHiddenAtom, snapshot?.notesPanelHidden ?? false);
    set(zenModeSnapshotAtom, null);
    set(zenModeAtom, false);
  } else {
    // Enter zen mode — save snapshot, hide both panels
    set(zenModeSnapshotAtom, {
      actionsPanelHidden: get(actionsPanelHiddenAtom),
      notesPanelHidden: get(notesPanelHiddenAtom),
    });
    set(actionsPanelHiddenAtom, true);
    set(notesPanelHiddenAtom, true);
    set(zenModeAtom, true);
  }
});

// ---------------------------------------------------------------------------
// Prompt draft persistence (session-only, keyed by noteId)
// ---------------------------------------------------------------------------

/** Comment ID pending submission to agent (set by "Send to Agent", consumed by prompt submit) */
export const pendingAgentCommentIdAtom = atom<string | null>(null);

export type PendingAgentCommentContextMessage = {
  id: string;
  authorLabel: string;
  source?: 'user' | 'agent' | 'external';
  color?: number;
  text: string;
  kind: 'comment' | 'reply';
};

export type PendingAgentCommentContextThread = {
  rootId: string;
  messages: PendingAgentCommentContextMessage[];
};

export type PendingAgentCommentContext = {
  scope: 'comment' | 'thread' | 'all';
  title: string;
  promptText: string;
  /** Compact ID-only context sent to the agent; quote text stays in threads[].messages for UI preview. */
  agentContextText: string;
  threads: PendingAgentCommentContextThread[];
};

/** Structured comment context shown in the prompt box and compacted before agent submission. */
export const pendingAgentCommentContextAtom = atom<PendingAgentCommentContext | null>(null);

/** Annotated text from the comment's MarkNode (set by "Send to Agent", consumed by prompt box) */
export const pendingAgentContextAtom = atom<string | null>(null);

/** Optional icon shown beside pending selected context in the prompt box. */
export const pendingAgentContextIconUrlAtom = atom<string | null>(null);

/** Optional source URL for pending selected context. Sent to the agent, not shown in the pill text. */
export const pendingAgentContextSourceUrlAtom = atom<string | null>(null);

/** Image paths from comment context (annotated ImageNode src + comment attachments). Relative paths resolved in main. */
export const pendingAgentImageUrlsAtom = atom<string[] | null>(null);

/** Gets/sets the prompt draft for the focused note (follows split tab focus) */
export const promptDraftAtom = atom(
  (get) => {
    const noteId = get(focusedNoteIdAtom);
    if (!noteId) return '';
    return get(notePromptDraftAtom(noteId));
  },
  (get, set, value: string) => {
    const noteId = get(focusedNoteIdAtom);
    if (!noteId) return;
    set(notePromptDraftAtom(noteId), value);
  }
);

// Navigation history for back/forward navigation between notes
export interface NavigationHistoryState {
  stack: string[]; // Array of note IDs
  headings?: Array<string | null>; // Optional heading at each history location
  index: number; // Current position in the stack (-1 means empty)
}

const initialNavigationHistory: NavigationHistoryState = {
  stack: [],
  index: -1
};

export const navigationHistoryAtom = atom<NavigationHistoryState>(initialNavigationHistory);

export const canGoBackAtom = atom((get) => {
  const { index } = get(navigationHistoryAtom);
  return index > 0;
});

export const canGoForwardAtom = atom((get) => {
  const { stack, index } = get(navigationHistoryAtom);
  return index < stack.length - 1;
});

// ---------------------------------------------------------------------------
// Folder UI state
// ---------------------------------------------------------------------------

/**
 * Tracks which folders are expanded in the sidebar.
 * Empty set = all folders collapsed (the default on app start).
 * Folders are added when the user expands them or navigates to a note inside.
 */
export const expandedFoldersAtom = atom<Set<string>>(new Set<string>());

// ---------------------------------------------------------------------------
// Active folder tracking (for note creation context)
// ---------------------------------------------------------------------------

/** Tracks the currently active/selected folder path for note creation context */
export const activeFolderPathAtom = atom<string>('Notes');

const getSidebarRevealFolderPaths = (folderPath: string): string[] => {
  const pathsToExpand: string[] = [];
  let current = folderPath;

  while (current && current !== 'Notes') {
    pathsToExpand.push(current);
    const lastSlash = current.lastIndexOf('/');
    current = lastSlash > 0 ? current.slice(0, lastSlash) : '';
  }

  return pathsToExpand;
};

/** Reveals a folder path in the sidebar by selecting it and expanding its ancestors. */
export const revealFolderPathAtom = atom(
  null,
  (_get, set, folderPath: string | null | undefined) => {
    const normalizedFolderPath = folderPath || 'Notes';
    set(activeFolderPathAtom, normalizedFolderPath);

    const pathsToExpand = getSidebarRevealFolderPaths(normalizedFolderPath);
    if (pathsToExpand.length === 0) return;

    set(expandedFoldersAtom, (prev) => {
      if (pathsToExpand.every((path) => prev.has(path))) return prev;

      const next = new Set(prev);
      for (const path of pathsToExpand) {
        next.add(path);
      }
      return next;
    });
  }
);

/**
 * Signal atom for navigating to an external folder in the sidebar.
 * Set to an absolute filesystem path (e.g. "/Users/x/repos/project/src")
 * to make ExternalNotesList expand and scroll to that folder.
 * Consumers should reset to null after handling.
 */
export const externalFolderNavigateAtom = atom<string | null>(null);

// ---------------------------------------------------------------------------
// Granular note update atoms for better performance
// ---------------------------------------------------------------------------

/**
 * Write-only atom for syncing note entity updates.
 * Replaces the legacy syncNote pattern that operated on notesAtom array.
 */
export const syncNoteEntityAtom = atom(
  null,
  (get, set, params: { noteId: string; updates: Partial<NoteEntity> }) => {
    const { noteId, updates } = params;
    const current = get(noteEntityAtom(noteId));
    if (!current) {
      // Note doesn't exist yet - this can happen during creation
      // In this case, skip the sync (the note will be created via another path)
      return;
    }
    const changed = Object.entries(updates).some(
      ([key, value]) => !Object.is(current[key as keyof NoteEntity], value)
    );
    if (!changed) {
      return;
    }
    set(noteEntityAtom(noteId), { ...current, ...updates });
  }
);

// ---------------------------------------------------------------------------
// Backend folders state (for empty folders not derived from notes)
// ---------------------------------------------------------------------------

export interface BackendFolderEntry {
  name: string;
  path: string;
  noteCount: number;
  createdAt: number;
  /** System folder (currently only External) */
  type?: 'system';
}

/**
 * Stores folder list from the backend (filesystem).
 * This includes empty folders that wouldn't appear in note-derived folder lists.
 * Updated when folders are created, renamed, or deleted.
 */
export const backendFoldersAtom = atom<BackendFolderEntry[]>([]);

// ---------------------------------------------------------------------------
// Agent streaming state - unified in ActionTabEntry
// ---------------------------------------------------------------------------

/** Agent stream event type (matches electron-api.d.ts) */
export type AgentStreamEvent =
  | { type: 'start'; tabId: string; noteId: string }
  | { type: 'text'; tabId: string; noteId: string; text: string }
  | { type: 'tool_start'; tabId: string; noteId: string; toolId: string; toolName: string; editTarget?: string }
  | { type: 'tool_end'; tabId: string; noteId: string; toolId: string }
  | { type: 'turn_end'; tabId: string; noteId: string }
  | { type: 'complete'; tabId: string; noteId: string }
  | {
      type: 'error';
      tabId: string;
      noteId: string;
      code: string;
      message: string;
      /** Specific runtime/result cause used to select recovery actions. */
      classification?: string;
      /**
       * Whether this outcome can be retried by re-running the original prompt.
       * Surfaced so the timeline card can offer a "Try again" action. Optional
       * for backward-compatibility with older event producers (defaults to
       * non-retryable when absent).
       */
      retryable?: boolean;
      /**
       * Presentation hint chosen in the main process:
       * - 'error'   → red error card (alert icon, support link)
       * - 'neutral' → muted/informational card, no red styling, no support link
       *               (used for `empty_success` — the agent returned nothing).
       * Defaults to 'error' when absent.
       */
      severity?: 'error' | 'neutral';
    }
  | {
      type: 'editor_update';
      tabId: string;
      noteId: string;
      content: string;
    };

/** Write-only helper to toggle renderer-side execution lifecycle tracking. */
export const setPendingAgentExecutionAtom = atom(
  null,
  (_get, set, payload: { noteId: string; pending: boolean }) => {
    const { noteId, pending } = payload;
    set(pendingAgentExecutionNoteIdsAtom, (prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(noteId);
      } else {
        next.delete(noteId);
      }
      return next;
    });
  }
);

/**
 * Union of stream-active notes and renderer-finalizing notes.
 * UI loading states should read from this atom.
 */
export const uiAgentBusyNoteIdsAtom = atom((get) => {
  const active = get(activeAgentNoteIdsAtom);
  const pending = get(pendingAgentExecutionNoteIdsAtom);
  if (pending.size === 0) {
    return active;
  }
  if (active.size === 0) {
    return pending;
  }
  return new Set<string>([...active, ...pending]);
});

type AgentExecutionTabParams = { noteId: string; tabId: string };

export const canStartPendingAgentExecutionAtom = atom(
  null,
  (get, _set, { noteId, tabId }: AgentExecutionTabParams) => {
    if (!get(pendingAgentExecutionNoteIdsAtom).has(noteId)) {
      return false;
    }

    const tab = get(noteActionTabsAtom(noteId)).find((entry) => entry.id === tabId);
    return tab?.status === 'pending';
  }
);

export const canApplyAgentExecuteResultAtom = atom(
  null,
  (get, _set, { noteId, tabId }: AgentExecutionTabParams) => {
    if (!get(pendingAgentExecutionNoteIdsAtom).has(noteId)) {
      return false;
    }

    const tab = get(noteActionTabsAtom(noteId)).find((entry) => entry.id === tabId);
    return Boolean(tab && tab.status !== 'interrupted');
  }
);


const nowInUnixSeconds = (): number => Math.floor(Date.now() / 1000);
const nowInUnixMs = (): number => Date.now();

// ---------------------------------------------------------------------------
// Synthetic ack — keyword-matched contextual acknowledgments (no inference).
// Regexes imported from shared prompt-classification module (single source of truth).
// ---------------------------------------------------------------------------

const MICRO_EDIT_ACKS = [
  'Got it — cleaning that up.',
  "I'll tidy this up real quick.",
  'Say less — fixing now.',
  "Good catch — I'll fix that.",
  "I got you — tidying up.",
  "I'll polish this up.",
  'Already on it.',
  'Nothing gets past you. Fixing now.',
];

const SHORT_DIRECTIVE_ACKS = [
  'On it.',
  'Say less.',
  'Got you.',
  'Yep, one sec.',
  'You got it.',
  'Already on it.',
  'Heard.',
  'Making that change now.',
];

const HEAVY_WORK_ACKS = [
  'Ooh, let me dig into this.',
  'Give me a sec — this one\'s interesting.',
  'Alright, let me think through this.',
  'Going deep on this one.',
  'Let me break this down.',
  'Let me nerd out on this for a sec.',
  'Oh this is gonna be good.',
  'Working through the details now.',
  'Diving in.',
  'This one\'s fun — let me dig in.',
];

const GENERATIVE_ACKS = [
  "I'll draft something up.",
  'Alright, let me cook.',
  'Ooh, this\'ll be fun — writing now.',
  "I'll whip something together.",
  "Leave it to me.",
  'Let me put something together.',
  "I'll get started on a draft.",
  'Ooh, time to get creative.',
  "I've got a vision — give me a sec.",
  'Let me get to work on this.',
];

const DEFAULT_ACKS = [
  'Got it, working on this now.',
  'On it — give me a sec.',
  'I got you.',
  'Working on it.',
  "I'm on it.",
  'Let me handle that.',
  'Got you — one sec.',
  'Already on it.',
  "Got it — I'll take it from here.",
  'Let me take care of that.',
];

const SYNTHETIC_ACK_PATTERNS: Array<{ pattern: RegExp; acks: string[]; maxLen?: number }> = [
  { pattern: MICRO_EDIT_RE, acks: MICRO_EDIT_ACKS },
  { pattern: SHORT_DIRECTIVE_EDIT_RE, acks: SHORT_DIRECTIVE_ACKS, maxLen: SHORT_DIRECTIVE_MAX_LEN },
  { pattern: HEAVY_WORK_RE, acks: HEAVY_WORK_ACKS },
  { pattern: GENERATIVE_WORK_RE, acks: GENERATIVE_ACKS },
];

const pick = (acks: string[]): string =>
  acks.length === 0 ? 'On it' : acks[Math.floor(Math.random() * acks.length)];

/** Derive a synthetic first-turn ack from the raw prompt using keyword matching. */
export function getSyntheticAck(prompt: string | null | undefined): string {
  if (!prompt?.trim()) return pick(DEFAULT_ACKS);
  // Strip [Selected text: "..."] envelope so ^-anchored regexes match the user's instruction
  const trimmed = prompt.trim().replace(/^\[Selected text:.*?\]\s*/s, '');

  for (const { pattern, acks, maxLen } of SYNTHETIC_ACK_PATTERNS) {
    if (maxLen && trimmed.length > maxLen) continue;
    if (pattern.test(trimmed)) return pick(acks);
  }
  return pick(DEFAULT_ACKS);
}

/**
 * Merges stage metric fields into an ActionTabEntry's metrics.
 * Always creates a metrics object — intentional so every streamed tab has a
 * metrics container ready for stage timestamps (latency optimization).
 */
const withStageMetric = (
  tab: ActionTabEntry,
  stageOverrides: Partial<ActionTabStageMetrics>
): Pick<ActionTabEntry, 'metrics'> => ({
  metrics: {
    ...(tab.metrics ?? {}),
    stage: { ...(tab.metrics?.stage ?? {}), ...stageOverrides },
  },
});

/** Update action tabs in response to agent stream events */
export const updateAgentStreamAtom = atom(null, (get, set, event: AgentStreamEvent) => {
  const { noteId, tabId } = event;
  if (!noteId) return;

  // GUARD: Skip events for notes no longer in active set (interrupted)
  // This prevents race conditions where stream events arrive after interruption.
  // The interruptAgentForNoteAtom removes from activeAgentNoteIdsAtom FIRST,
  // so any stale events arriving after will be ignored here.
  if (event.type === 'start') {
    // For start events, check if the tab was already interrupted (stale start)
    const noteTabsAtom = noteActionTabsAtom(noteId);
    const tabs = get(noteTabsAtom);
    const targetTab = tabs.find((t) => t.id === tabId);
    if (targetTab?.status === 'interrupted') {
      return; // Stale start event for interrupted tab, ignore
    }
    set(activeAgentNoteIdsAtom, (prev) => new Set(prev).add(noteId));
  } else if (!get(activeAgentNoteIdsAtom).has(noteId)) {
    return; // Stale event for non-active note, ignore
  }

  // Track session completion
  if (event.type === 'complete' || event.type === 'error') {
    set(activeAgentNoteIdsAtom, (prev) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });
  }

  // Get the atom for THIS specific note and update it
  const noteTabsAtom = noteActionTabsAtom(noteId);

  // Handle editor_update events: update timing metrics on the action tab.
  // Content application happens directly in CanvasAreaContent's onStream handler
  // for minimum latency (synchronous, no React scheduler hop).
  if (event.type === 'editor_update') {
    const editorUpdateAt = nowInUnixSeconds();
    set(noteTabsAtom, (prev) => prev.map((tab) => {
      if (tab.id !== tabId) return tab;

      return {
        ...tab,
        timing: {
          ...tab.timing,
          firstEditorUpdateAt: tab.timing?.firstEditorUpdateAt ?? editorUpdateAt
        },
        // Note: no withStageMetric here — editor_update only records timing.
      };
    }));
    return; // editor_update bypasses transcript changes; only timing metadata update.
  }

  set(noteTabsAtom, (prev) => prev.map(tab => {
    if (tab.id !== tabId) return tab;

    switch (event.type) {
      case 'start': {
        const startedAt = nowInUnixSeconds();
        return {
          ...tab,
          isStreaming: true,
          streamingText: '',
          activeTools: [],
          lastToolName: null,
          streamError: null,
          toolCallCounts: {},
          timing: {
            startedAt
          },
          ...withStageMetric(tab, {}),
          syntheticAck: getSyntheticAck(tab.prompt),
        };
      }
      case 'text': {
        const textAt = nowInUnixSeconds();
        const textAtMs = nowInUnixMs();
        return {
          ...tab,
          streamingText: tab.streamingText + event.text,
          timing: {
            ...tab.timing,
            firstTextAt: tab.timing?.firstTextAt ?? textAt,
            lastTextAt: textAt
          },
          ...withStageMetric(tab, {
            firstTextAtMs: tab.metrics?.stage?.firstTextAtMs ?? textAtMs
          }),
        };
      }
      case 'tool_start': {
        // Guard against duplicate tool_start events from IPC
        if (tab.activeTools.some(t => t.toolId === event.toolId)) return tab;
        const toolStartedAt = nowInUnixSeconds();
        const toolStartedAtMs = nowInUnixMs();
        return {
          ...tab,
          activeTools: [
            ...tab.activeTools,
            { toolId: event.toolId, toolName: event.toolName, startedAt: Date.now() }
          ],
          lastToolName: event.toolName,
          toolCallCounts: {
            ...tab.toolCallCounts,
            [event.toolName]: (tab.toolCallCounts[event.toolName] ?? 0) + 1
          },
          timing: {
            ...tab.timing,
            firstToolStartAt: tab.timing?.firstToolStartAt ?? toolStartedAt
          },
          ...withStageMetric(tab, {
            firstToolStartAtMs: tab.metrics?.stage?.firstToolStartAtMs ?? toolStartedAtMs
          }),
        };
      }
      case 'tool_end':
        return {
          ...tab,
          activeTools: tab.activeTools.filter(t => t.toolId !== event.toolId),
          timing: {
            ...tab.timing,
            lastToolEndAt: nowInUnixSeconds()
          }
        };
      case 'turn_end':
        return {
          ...tab,
          messages: tab.streamingText.trim() ? [...tab.messages, tab.streamingText.trim()] : tab.messages,
          streamingText: ''
        };
      case 'complete': {
        const completedAtSec = nowInUnixSeconds();
        const completedAtMs = nowInUnixMs();
        return {
          ...tab,
          isStreaming: false,
          status: tab.status === 'pending' ? 'completed' : tab.status,
          completedAt: tab.status === 'pending' ? new Date().toISOString() : tab.completedAt,
          messages: tab.streamingText.trim() ? [...tab.messages, tab.streamingText.trim()] : tab.messages,
          streamingText: '',
          activeTools: [],
          lastToolName: null,
          toolCallCounts: {},
          timing: {
            ...tab.timing,
            completedAt: completedAtSec
          },
          ...withStageMetric(tab, { executionCompletedAtMs: completedAtMs }),
        };
      }
      case 'error': {
        const erroredAtSec = nowInUnixSeconds();
        const erroredAtMs = nowInUnixMs();

        return {
          ...tab,
          isStreaming: false,
          status: 'error',
          streamError: {
            code: event.code,
            message: event.message,
            classification: event.classification,
            retryable: event.retryable ?? false,
            severity: event.severity ?? 'error'
          },
          errorMessage: event.message,
          activeTools: [],
          lastToolName: null,
          toolCallCounts: {},
          timing: {
            ...tab.timing,
            completedAt: erroredAtSec
          },
          ...withStageMetric(tab, { executionCompletedAtMs: erroredAtMs }),
        };
      }
      default:
        return tab;
    }
  }));

  // Source comment resolution is tied to the renderer persistence path after an
  // agent result is accepted. The stream atom only updates timeline state.
});

/**
 * Write-only atom for interrupting an agent session on a note.
 * Used when trashing a note, user cancels, or app reloads.
 *
 * IMPORTANT: Removes from activeAgentNoteIdsAtom FIRST to guard against
 * race conditions where stale stream events arrive after interruption.
 * The guard in updateAgentStreamAtom checks this set to skip stale events.
 *
 * @returns The updated action tabs for persistence
 */
export const interruptAgentForNoteAtom = atom(
  null,
  (get, set, params: { noteId: string; reason: InterruptReason }) => {
    const { noteId, reason } = params;

    // 1. Remove from active tracking FIRST (guards against race condition)
    set(activeAgentNoteIdsAtom, (prev) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });

    set(pendingAgentExecutionNoteIdsAtom, (prev) => {
      const next = new Set(prev);
      next.delete(noteId);
      return next;
    });

    // 2. Update action tabs with interrupted status
    const noteTabsAtom = noteActionTabsAtom(noteId);
    set(noteTabsAtom, (prev) =>
      prev.map((tab) => {
        if (!tab.isStreaming && tab.status !== 'pending') return tab;

        const message = INTERRUPT_MESSAGES[reason];
        const interruptedAt = nowInUnixSeconds();
        const interruptedAtMs = nowInUnixMs();
        const finalMessages = tab.streamingText.trim()
          ? [...tab.messages, tab.streamingText, message]
          : [...tab.messages, message];

        return {
          ...tab,
          messages: finalMessages,
          streamingText: '',
          isStreaming: false,
          activeTools: [],
          lastToolName: null,
          streamError: null,
          toolCallCounts: {},
          status: 'interrupted' as const,
          interruptReason: reason,
          completedAt: new Date().toISOString(),
          timing: {
            ...tab.timing,
            completedAt: interruptedAt
          },
          ...withStageMetric(tab, { executionCompletedAtMs: interruptedAtMs })
        };
      })
    );

    return get(noteTabsAtom);
  }
);

// ---------------------------------------------------------------------------
// Search state (unified Cmd+F search)
// ---------------------------------------------------------------------------

export interface SearchState {
  query: string;
  isActive: boolean;
  matchCount: number;
  currentMatchIndex: number;
  /** Incremented on every navigate action so scroll effects re-fire even when index doesn't change */
  navigateVersion: number;
}

const defaultSearchState: SearchState = {
  query: '',
  isActive: false,
  matchCount: 0,
  currentMatchIndex: -1,
  navigateVersion: 0
};

export const searchStateAtom = atom<SearchState>(defaultSearchState);

/** Write-only: update query and reset match index */
export const setSearchQueryAtom = atom(null, (_get, set, query: string) => {
  set(searchStateAtom, (prev) => ({
    ...prev,
    query,
    isActive: true,
    currentMatchIndex: -1,
    matchCount: 0
  }));
});

/** Write-only: deactivate search and clear everything */
export const clearSearchAtom = atom(null, (_get, set) => {
  set(searchStateAtom, defaultSearchState);
});

/** Write-only: cycle currentMatchIndex forward or backward */
export const navigateSearchMatchAtom = atom(
  null,
  (get, set, direction: 'next' | 'prev') => {
    const state = get(searchStateAtom);
    if (state.matchCount === 0) return;

    let nextIndex: number;
    if (direction === 'next') {
      nextIndex = state.currentMatchIndex + 1 >= state.matchCount ? 0 : state.currentMatchIndex + 1;
    } else {
      nextIndex = state.currentMatchIndex - 1 < 0 ? state.matchCount - 1 : state.currentMatchIndex - 1;
    }

    set(searchStateAtom, { ...state, currentMatchIndex: nextIndex, navigateVersion: state.navigateVersion + 1 });
  }
);

/** Write-only: called by SearchPlugin to publish match data */
export const updateSearchMatchesAtom = atom(
  null,
  (get, set, update: { matchCount: number }) => {
    const state = get(searchStateAtom);
    const newIndex = update.matchCount > 0
      ? Math.min(Math.max(state.currentMatchIndex, 0), update.matchCount - 1)
      : -1;
    set(searchStateAtom, {
      ...state,
      matchCount: update.matchCount,
      currentMatchIndex: newIndex
    });
  }
);

// ---------------------------------------------------------------------------
// Links panel state
// ---------------------------------------------------------------------------

export type LinksTabType = 'backlinks' | 'file-links' | 'suggested-links';

const LINKS_TAB_STORAGE_KEY = 'moss/ui:linksTab';

const getStoredLinksTab = (): LinksTabType => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return 'backlinks';
  }
  try {
    const stored = window.localStorage.getItem(LINKS_TAB_STORAGE_KEY);
    if (stored === 'file-links' || stored === 'backlinks' || stored === 'suggested-links') {
      return stored;
    }
    return 'backlinks';
  } catch {
    return 'backlinks';
  }
};

const baseLinksTabAtom = atom<LinksTabType>(getStoredLinksTab());

/** Tracks which tab is active in the links section (persisted to localStorage) */
export const linksTabAtom = atom(
  (get) => get(baseLinksTabAtom),
  (_get, set, update: LinksTabType) => {
    if (typeof window !== 'undefined' && typeof window.localStorage !== 'undefined') {
      try {
        window.localStorage.setItem(LINKS_TAB_STORAGE_KEY, update);
      } catch {
        // Ignore storage issues
      }
    }
    set(baseLinksTabAtom, update);
  }
);

// ---------------------------------------------------------------------------
// Context file types (used by prompt components)
// ---------------------------------------------------------------------------

/** Represents a file or directory that can be added to agent context */
export interface ContextFile {
  path: string;
  name: string;
  type: 'file' | 'directory';
}

// ---------------------------------------------------------------------------
// Cross-note anchor navigation state
// ---------------------------------------------------------------------------

export interface PendingScrollTarget {
  noteId: string;
  heading: string | null;
}

/** Stores destination note + heading for cross-note anchor navigation */
export const pendingScrollTargetAtom = atom<PendingScrollTarget | null>(null);

/** Cycles through playful placeholder pairs for new notes */
export const placeholderIndexAtom = atom(0);

// ---------------------------------------------------------------------------
// Link resolution cache (atomFamily keyed by noteTitle)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Note links storage (atomFamily for instant access without IPC)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `NoteLink` from `@moss/shared/types/note-entity` instead.
 * This alias is preserved for backward compatibility.
 */
export type { NoteLink as NoteLinkInfo } from '../types/note-entity';

// Re-import NoteLink for use in NoteLinkData below
import type { NoteLink } from '../types/note-entity';

/**
 * Links data for a note - both outgoing (notes this links TO)
 * and incoming (backlinks - notes that link TO this note).
 */
export interface NoteLinkData {
  outgoing: NoteLink[];
  incoming: NoteLink[];
}

// Re-export noteLinksAtom from note-atoms.ts
// It now derives from noteEntityAtom for reads, and updates noteEntityAtom for writes
export { noteLinksAtom };

/**
 * Write-only atom for bulk hydration of links on app startup.
 * Takes a map of noteId -> NoteLinkData and hydrates all atoms at once.
 */
export const hydrateLinksAtom = atom(
  null,
  (_get, set, updates: Record<string, NoteLinkData>) => {
    for (const [noteId, linkData] of Object.entries(updates)) {
      set(noteLinksAtom(noteId), linkData);
    }
  }
);

// ---------------------------------------------------------------------------
// Stats bar visibility (persisted to localStorage)
// ---------------------------------------------------------------------------

const STATS_BAR_STORAGE_KEY = 'moss/ui:statsBarVisible';

const readStatsBarVisible = (): boolean => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(STATS_BAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

const writeStatsBarVisible = (value: boolean): void => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(STATS_BAR_STORAGE_KEY, String(value));
  } catch {
    // Ignore storage errors
  }
};

/** Toggle-persisted visibility for the note stats bar (word count, char count, reading time) */
export const statsBarVisibleAtom = atom(
  readStatsBarVisible(),
  (_get, set, update: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof update === 'function' ? update(_get(statsBarVisibleAtom)) : update;
    set(statsBarVisibleAtom, next);
    writeStatsBarVisible(next);
  }
);

// ---------------------------------------------------------------------------
// Notes panel: sort mode and pinned section state
// ---------------------------------------------------------------------------

export type NotesSortMode = 'recent' | 'az';
export type NotesSortDirection = 'asc' | 'desc';
export type NotesSortState = { mode: NotesSortMode; direction: NotesSortDirection };

const NOTES_SORT_MODE_KEY = 'moss/ui:notesSortMode';
const NOTES_SORT_DIR_KEY = 'moss/ui:notesSortDirection';

const getStoredNotesSortMode = (): NotesSortMode => {
  const stored = getStoredValue(NOTES_SORT_MODE_KEY);
  if (stored === 'recent' || stored === 'az') return stored;
  return 'recent';
};

const getStoredNotesSortDirection = (): NotesSortDirection => {
  const stored = getStoredValue(NOTES_SORT_DIR_KEY);
  if (stored === 'asc' || stored === 'desc') return stored;
  return 'asc';
};

const baseNotesSortModeAtom = atom<NotesSortMode>(getStoredNotesSortMode());
const baseNotesSortDirectionAtom = atom<NotesSortDirection>(getStoredNotesSortDirection());

/** Sort mode for the notes panel (persisted to localStorage). Applies to folders and unpinned notes only. */
export const notesSortModeAtom = atom(
  (get) => get(baseNotesSortModeAtom),
  (_get, set, update: NotesSortMode) => {
    rememberValue(NOTES_SORT_MODE_KEY, update);
    set(baseNotesSortModeAtom, update);
  }
);

/** Sort direction for the notes panel (persisted to localStorage). */
export const notesSortDirectionAtom = atom(
  (get) => get(baseNotesSortDirectionAtom),
  (_get, set, update: NotesSortDirection) => {
    rememberValue(NOTES_SORT_DIR_KEY, update);
    set(baseNotesSortDirectionAtom, update);
  }
);

/** Whether the PINNED section in the notes panel is expanded. Session-only (not persisted). */
export const pinnedSectionExpandedAtom = atom(true);

// ---------------------------------------------------------------------------
// Split tab state (document-level split pane)
// ---------------------------------------------------------------------------

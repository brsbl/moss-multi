// ported-from: packages/desktop/src/renderer/App.tsx @ 762abb777
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { recoverableLazy } from '@moss-multi/host/recoverable-lazy';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { useThemeEffect } from '@moss/shared/themes';

import {
  AppShell,
  ActionsPanelWrapper,
  activeNoteEntityAtom,
  activeNoteIdAtom,
  showCommandPaletteAtom,
  commandPaletteDockedAtom,
  commandPaletteOriginAtom,
  actionsPanelActiveTabAtom,
  noteActionTabsAtom,
  noteExpandedActionTabIdsAtom,
  activeActionTabsAtom,
  activeExpandedActionTabIdsAtom,
  activeNotesAtom,
  lastViewedNoteIdAtom,
  trashedNotesEntityAtom,
  activeFolderPathAtom,
  expandedFoldersAtom,
  activeAgentNoteIdsAtom,
  uiAgentBusyNoteIdsAtom,
  setPendingAgentExecutionAtom,
  canApplyAgentExecuteResultAtom,
  canStartPendingAgentExecutionAtom,
  interruptAgentForNoteAtom,
  actionsPanelHiddenAtom,
  notesPanelHiddenAtom,
  zenModeAtom,
  toggleZenModeAtom,
  pendingAgentCommentIdAtom,
  pendingAgentContextAtom,
  pendingAgentContextIconUrlAtom,
  pendingAgentContextSourceUrlAtom,
  pendingAgentImageUrlsAtom,
  generateMockTodos,
  generateMockChanges,
  noteEntityAtom,
  noteIdsAtom,
  notesHydratedAtom,
  backendFoldersAtom,
  mapNoteMetadataToNoteEntity,
  syncNoteEntityAtom,
  hydrateNotesAtom,
  externalFolderAtom,
  notesByFolderAtom,
  syncNotesMetadataByIdsAtom,
  type MockNote,
  type ActionTabMetrics,
  type ActionTabEntry,
  type ActionRetryInputs,
  type NoteEntity,
  searchStateAtom,
  setSearchQueryAtom,
  clearSearchAtom,
  noteFrontmatterAtom,
  NO_NOTE_SENTINEL,
  pendingSavePromiseAtom,
  navigationHistoryAtom,
  focusedNoteIdAtom,
  isSplitOpenAtom,
  isBrowserSplitOpenAtom,
  browserSplitFullPaneAtom,
  openBrowserSplitAtom,
  requestBrowserSplitFocusAtom,
  closeBrowserSplitAtom,
  splitTabNoteIdAtom,
  openSplitTabAtom,
  closeSplitTabAtom,
  closeSplitPaneAtom,
  promoteBrowserSplitToFullPaneAtom,
  focusedPaneAtom,
  setFocusPaneAtom,
  splitNavigateToNoteAtom,
  externalFolderNavigateAtom,
  Button,
  ConfirmationDialog,
  type NoteComment,
} from '@moss/shared';
import { AddContextPopover } from '@moss/shared/components/ui/connected-folders-dropdown';
import { TimelinePopoutModal } from '@moss/shared/components/ui/timeline-popout-modal';
import { ImageLightbox, lightboxSrcAtom } from './editor/components/ImageLightbox';
import { WebEmbedLightbox } from './editor/preview/WebEmbedLightbox';
import { toDisplaySrc } from './editor/utils/asset-url';
import { CommentInputPopover } from './editor/components/CommentInputPopover';
import { CommentPopover } from './editor/components/CommentPopover';
import { TypeaheadMenu } from './editor/typeahead/TypeaheadMenu';
import type { TypeaheadItem } from './editor/typeahead/types';
import { MediaSourceDialog } from './editor/dialogs/MediaSourceDialog';
import type { CommandPaletteOverlayHandle } from './prompt';
import { buildPromptWithSelectedContext } from './prompt/selected-context';
import {
  buildPromptWithPendingCommentContext,
  clearPendingCommentAgentContext,
  getCommentRootIdsForAgentContext
} from './editor/utils/comment-agent-context';
import { ActionsPanel } from '@moss/shared/components/ui/actions-panel';
import { LinksSection } from './components/LinksSection';
import { CopyForAgentDialog } from './components/CopyForAgentDialog';
import { AlertTriangle, CircleHelp, FileText, SquarePlus } from 'lucide-react';
import { renderInlineMarkdown } from '@moss/shared/lib/markdown-inline';
import {
  classifyNormalizedAgentExecuteErrorMessage,
  normalizeAgentExecuteErrorMessage
} from './utils/agent-error-message';
import { RenameFolderDialog } from './panels/RenameFolderDialog';

import type {
  AgentExecuteResultDelta,
  NoteMetadataRecord,
  NoteWithContent,
  StickyTabRecord as ActionTabRecord
} from '../common/noteTypes';
import { commentDirtySignalAtom, noteCommentsMapAtom } from '@moss/shared/state/note-atoms';
import type {
  AutomationPane,
  MossAutomationController,
  RendererAutomationCommand,
  RendererAutomationResult,
  RendererAutomationState,
  SnapshotUiFixtureKind,
} from '../common/automation';
import {
  disableSnapshotMode,
  enableSnapshotMode,
  waitForCodeblocksReady,
} from './automation/snapshot-mode';
import { agentApi, foldersApi, notesApi, systemApi } from './api/electron';
import { useAgentStream } from './hooks/useAgentStream';
import { useNavigationHistory } from './hooks/useNavigationHistory';
import { stashPreloadedNoteRecord, prefetchNoteRecord } from './utils/preloaded-note-record-cache';
import {
  cloneTodos,
  cloneChanges,
  generateId,
  createDraftActionEntry,
  createPendingActionEntry,
  ensureDraftActionExists,
  updateActionTabEntry,
  mapActionTabRecordToEntry,
  mapActionTabEntryToRecord
} from './utils/action-tab-utils';
import type { CanvasAreaContentHandle } from './panels/CanvasAreaContent';
import { SplitPaneContainer } from './panels/SplitPaneContainer';
import { NotesListPanelContent, type NotesListPanelContentHandle } from './panels/NotesListPanelContent';
import { NotesPanelFooter } from './panels/NotesPanelFooter';
import { resolveExternalFolderRevealPath } from './panels/SystemFolderSection';
import type { TrashedNotesPanelContentHandle } from './panels/TrashedNotesPanelContent';
import { PropertiesTabContent } from './panels/PropertiesTabContent';
import { DefaultEditorPrompt } from './components/DefaultEditorPrompt';
import type { MossWindowContext, UpdateReadyInfo } from '../types/electron-api';
// moss-multi seam: duplicate from the server's Yjs snapshot.
import { duplicateNote } from '@moss-multi/host/duplicate';
import { hydrateComments } from './editor/utils/comment-import';
import { noteIntelligenceEnabledAtom, pendingAgentCommentContextAtom, promptDraftAtom } from '@moss/shared/state/atoms';
import { connectedFolderEntriesAtom, contextPillsAtom, setMentionPillsAtom } from './state/granted-dirs-atoms';
import { refreshConnectedFolderEntriesAtom } from './state/granted-dirs-atoms';
import { ensureSettingsWarmupAtom } from './state/settings-warmup-atoms';
import {
  getUpdateDismissedStorageKey,
  shouldIgnoreIncomingUpdate
} from './utils/update-ready';
import {
  isQuitProfilingEnabled,
  isRendererDevelopment,
  isRendererProduction
} from './utils/renderer-env';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
// moss-multi seam: new-note (A§9, R2)
import { armOpeningGuard } from '@moss-multi/host/opening-guard';
// moss-multi seam: phone-shell (T2.7, deviation 11): below 640 px the notes panel overlays the canvas
import { useNarrow } from '@moss-multi/host/viewport';

const nowInSeconds = (): number => Math.floor(Date.now() / 1000);
const NOTE_LIST_SYNC_DEBOUNCE_MS = 150;
const OPERATION_NOTICE_AUTO_DISMISS_MS = 4000;
const NOTES_LIST_WIDTH_DEFAULT = 260;
// Min keeps the new-note button's "Cmd N" shortcut affordance visible at the
// narrowest resize (below this the ⌘N pill clips inside the +Note button).
const NOTES_LIST_WIDTH_MIN = 248;
const NOTES_LIST_WIDTH_MAX = 560;
const NOTES_LIST_WIDTH_VIEWPORT_MAX_RATIO = 0.5;
const NOTES_PANEL_RESIZER_WIDTH_PX = 4;
const ZEN_NOTES_REVEAL_EDGE_PX = 10;
const ZEN_TOP_BAR_REVEAL_EDGE_PX = 88;
const NEW_BROWSER_TAB_URL = 'https://www.google.com/';

const getInitialNoteIdFromLocation = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const initialNoteId = new URLSearchParams(window.location.search).get('initialNoteId');
  return initialNoteId && initialNoteId.trim().length > 0 ? initialNoteId : null;
};

const withLocationInitialNoteFallback = (
  context: MossWindowContext | null | undefined
): MossWindowContext | null => {
  const initialNoteId = getInitialNoteIdFromLocation();
  if (!initialNoteId || context?.initialNoteId) {
    return context ?? null;
  }

  if (context) {
    return { ...context, initialNoteId };
  }

  return {
    windowId: 0,
    initialNoteId,
    launchReason: 'new-window',
    openedFromWindowId: null
  };
};

const ACTIONS_PANEL_WIDTH_STORAGE_KEY = 'moss:actions-panel-width';
const ACTIONS_PANEL_WIDTH_DEFAULT = 336;
// Smallest measured width where an ordinary docked prompt stays at two lines
// beside the inline action buttons instead of collapsing into three or four.
const ACTIONS_PANEL_WIDTH_MIN = 336;
const ACTIONS_PANEL_WIDTH_MAX = 480;
const ACTIONS_PANEL_WIDTH_VIEWPORT_MAX_RATIO = 0.5;

const getActionsPanelWidthMax = (): number => {
  if (typeof window === 'undefined') {
    return ACTIONS_PANEL_WIDTH_MAX;
  }

  const viewportLimit = Math.floor(window.innerWidth * ACTIONS_PANEL_WIDTH_VIEWPORT_MAX_RATIO);
  return Math.min(ACTIONS_PANEL_WIDTH_MAX, Math.max(ACTIONS_PANEL_WIDTH_MIN, viewportLimit));
};

const clampActionsPanelWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return ACTIONS_PANEL_WIDTH_DEFAULT;
  }
  return Math.min(getActionsPanelWidthMax(), Math.max(ACTIONS_PANEL_WIDTH_MIN, Math.round(width)));
};

const readStoredActionsPanelWidth = (): number => {
  if (typeof window === 'undefined') {
    return ACTIONS_PANEL_WIDTH_DEFAULT;
  }
  const raw = window.localStorage.getItem(ACTIONS_PANEL_WIDTH_STORAGE_KEY);
  if (!raw) {
    return ACTIONS_PANEL_WIDTH_DEFAULT;
  }

  const parsed = Number(raw);
  return clampActionsPanelWidth(parsed);
};

const getNotesListWidthMax = (): number => {
  if (typeof window === 'undefined') {
    return NOTES_LIST_WIDTH_MAX;
  }

  const viewportLimit = Math.floor(window.innerWidth * NOTES_LIST_WIDTH_VIEWPORT_MAX_RATIO);
  return Math.min(NOTES_LIST_WIDTH_MAX, Math.max(NOTES_LIST_WIDTH_MIN, viewportLimit));
};

const clampNotesListWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return NOTES_LIST_WIDTH_DEFAULT;
  }
  return Math.min(getNotesListWidthMax(), Math.max(NOTES_LIST_WIDTH_MIN, Math.round(width)));
};

const mergeActionTabMetrics = (
  base: ActionTabMetrics | undefined,
  overlay: ActionTabMetrics | undefined
): ActionTabMetrics | undefined => {
  if (!base && !overlay) {
    return undefined;
  }

  const merged: ActionTabMetrics = {};
  const stage = { ...(base?.stage ?? {}), ...(overlay?.stage ?? {}) };
  if (Object.values(stage).some((v) => v !== undefined)) merged.stage = stage;
  const sdk = { ...(base?.sdk ?? {}), ...(overlay?.sdk ?? {}) };
  if (Object.values(sdk).some((v) => v !== undefined)) merged.sdk = sdk;
  const context = { ...(base?.context ?? {}), ...(overlay?.context ?? {}) };
  if (Object.values(context).some((v) => v !== undefined)) merged.context = context;
  const derived = { ...(base?.derived ?? {}), ...(overlay?.derived ?? {}) };
  if (Object.values(derived).some((v) => v !== undefined)) merged.derived = derived;
  return merged;
};

const mergeAgentCommentsWithLocalEdits = (
  currentComments: Record<string, NoteComment>,
  incomingComments: Record<string, NoteComment>
): Record<string, NoteComment> => ({
  ...incomingComments,
  ...currentComments
});

type CachedActionDetails = {
  todos?: ActionTabEntry['todos'];
  changes?: ActionTabEntry['changes'];
};

type OperationFailureNotice = {
  id: number;
  message: string;
};

const mapRecordToMockNote = (record: NoteMetadataRecord): MockNote => {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt ?? record.createdAt ?? Math.floor(Date.now() / 1000),
    folderPath: record.folderPath ?? 'Notes',
    trashedAt: record.trashedAt ?? null
  };
};

// moss-multi seam: optional imports fail in place without unmounting a bound editor.
const LazyCommandPaletteOverlay = recoverableLazy(async () => {
  const module = await import('./prompt/CommandPaletteOverlay');
  return { default: module.CommandPaletteOverlay };
}) as typeof import('./prompt/CommandPaletteOverlay').CommandPaletteOverlay;

const LazySettingsModal = recoverableLazy(async () => {
  const module = await import('./components/SettingsModal');
  return { default: module.SettingsModal };
});

const LazyFeedbackDialog = recoverableLazy(async () => {
  const module = await import('./components/FeedbackDialog');
  return { default: module.FeedbackDialog };
});

const LazyUpdateWidget = recoverableLazy(async () => {
  const module = await import('./components/UpdateWidget');
  return { default: module.UpdateWidget };
});

const LazyTrashedNotesPanelContent = recoverableLazy(async () => {
  const module = await import('./panels/TrashedNotesPanelContent');
  return { default: module.TrashedNotesPanelContent };
}) as typeof import('./panels/TrashedNotesPanelContent').TrashedNotesPanelContent;

type AppMode = 'notes' | 'trash';

const SNAPSHOT_FIXED_ISO = '2026-01-01T00:00:00.000Z';
const SNAPSHOT_FIXED_COMPLETED_ISO = '2026-01-01T00:02:00.000Z';
const SNAPSHOT_FIXED_UNIX = 1_767_225_600;

const createSnapshotActionTabs = (
  kind: 'streaming' | 'streaming-long' | 'completed-expanded'
): ActionTabEntry[] => {
  const isStreamingFixture = kind === 'streaming' || kind === 'streaming-long';
  const base: ActionTabEntry = {
    id: `snapshot-action-${kind}`,
    status: isStreamingFixture ? 'pending' : 'completed',
    prompt:
      isStreamingFixture
        ? 'Summarize the fixture note and update the checklist.'
        : 'Review @Getting Started with Moss and list the changed surfaces.',
    responseSummary: null,
    errorMessage: null,
    createdAt: SNAPSHOT_FIXED_ISO,
    completedAt:
      isStreamingFixture ? null : SNAPSHOT_FIXED_COMPLETED_ISO,
    submittedLabel: isStreamingFixture ? 'Running fixture' : 'Completed fixture',
    todos: [],
    changes: [],
    trigger: 'agent',
    model: 'sonnet',
    profile: 'balanced',
    messages:
      kind === 'streaming-long'
        ? Array.from(
            { length: 18 },
            (_, index) => `Streaming progress ${index + 1}: checked another note section and kept the action timeline moving.`
          )
        : kind === 'streaming'
        ? ['I found the typography section and am checking the visible list state.']
        : [
            'Checked the prose, decorator, and actions-panel surfaces.',
            'Captured one deterministic note-list state for the visual baseline.',
          ],
    streamingText:
      kind === 'streaming-long'
        ? Array.from(
            { length: 36 },
            (_, index) => `Live update ${index + 1}: reviewing the next section while the docked composer stays available.`
          ).join('\n\n')
        : isStreamingFixture
        ? 'Updating the remaining checklist item while the action timeline stays open.'
        : '',
    isStreaming: isStreamingFixture,
    activeTools:
      isStreamingFixture
        ? [
            {
              toolId: 'snapshot-tool-edit',
              toolName: 'Edit',
              startedAt: SNAPSHOT_FIXED_UNIX,
            },
          ]
        : [],
    lastToolName: isStreamingFixture ? 'Edit' : null,
    streamError: null,
    toolCallCounts: isStreamingFixture ? { Edit: 1 } : {},
    syntheticAck:
      isStreamingFixture
        ? 'I will update the note and keep the action visible.'
        : 'I reviewed the seeded note surfaces.',
  };

  if (kind === 'completed-expanded') {
    base.mockupMode = true;
    base.promptMentions = [
      {
        id: 'snapshot-note-getting-started',
        title: 'Getting Started with Moss',
        type: 'note',
      },
    ];
    base.contextMentions = [
      {
        id: 'snapshot-folder-notes',
        title: 'Notes',
        type: 'folder',
        fileCount: 3,
      },
    ];
    base.imageUrls = [
      'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22200%22 viewBox=%220 0 320 200%22%3E%3Crect width=%22320%22 height=%22200%22 rx=%2224%22 fill=%22%23f5f1ea%22/%3E%3Crect x=%2232%22 y=%2236%22 width=%22256%22 height=%22128%22 rx=%2216%22 fill=%22%23dfeae2%22/%3E%3Ccircle cx=%2288%22 cy=%22100%22 r=%2228%22 fill=%22%232f855a%22/%3E%3Cpath d=%22M132 82h104M132 106h84M132 130h64%22 stroke=%22%232f855a%22 stroke-width=%2210%22 stroke-linecap=%22round%22/%3E%3C/svg%3E',
      'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22200%22 viewBox=%220 0 320 200%22%3E%3Crect width=%22320%22 height=%22200%22 rx=%2224%22 fill=%22%23eef2ff%22/%3E%3Crect x=%2248%22 y=%2248%22 width=%22224%22 height=%22104%22 rx=%2214%22 fill=%22%23c7d2fe%22/%3E%3Cpath d=%22M76 126l44-42 34 34 30-26 60 58H76z%22 fill=%22%234f46e5%22/%3E%3C/svg%3E',
    ];
  }

  return [base];
};

const SNAPSHOT_COMMENT: NoteComment = {
  id: 'snapshot-comment',
  text: 'Tighten the checklist language before approving the visual baseline.',
  createdAt: SNAPSHOT_FIXED_UNIX,
  updatedAt: SNAPSHOT_FIXED_UNIX,
  color: 1,
  source: 'user',
  imageUrls: [
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22200%22 viewBox=%220 0 320 200%22%3E%3Crect width=%22320%22 height=%22200%22 rx=%2224%22 fill=%22%23fff7ed%22/%3E%3Crect x=%2242%22 y=%2248%22 width=%22236%22 height=%22104%22 rx=%2214%22 fill=%22%23fed7aa%22/%3E%3Ccircle cx=%2294%22 cy=%22100%22 r=%2228%22 fill=%22%23f97316%22/%3E%3Cpath d=%22M138 82h92M138 106h70M138 130h52%22 stroke=%22%23c2410c%22 stroke-width=%2210%22 stroke-linecap=%22round%22/%3E%3C/svg%3E',
    'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22320%22 height=%22200%22 viewBox=%220 0 320 200%22%3E%3Crect width=%22320%22 height=%22200%22 rx=%2224%22 fill=%22%23ecfeff%22/%3E%3Crect x=%2252%22 y=%2244%22 width=%22216%22 height=%22112%22 rx=%2214%22 fill=%22%23a5f3fc%22/%3E%3Cpath d=%22M86 126l42-40 34 34 30-30 58 60H86z%22 fill=%22%230e7490%22/%3E%3C/svg%3E',
  ],
};

const SNAPSHOT_TYPEAHEAD_ITEMS: TypeaheadItem[] = [
  {
    id: 'snapshot-prose',
    label: 'Fixture Prose Checklist',
    description: 'Notes/Fixture',
    icon: FileText,
    category: 'Notes',
  },
  {
    id: 'snapshot-decorators',
    label: 'Fixture Decorators',
    description: 'Notes/Fixture/Media',
    icon: FileText,
    category: 'Notes',
  },
  {
    id: 'snapshot-code',
    label: 'Fixture Code Block',
    description: 'Notes/Fixture/Code',
    icon: FileText,
    category: 'Notes',
  },
];

function SnapshotUiFixtureLayer({
  fixture,
}: {
  fixture: SnapshotUiFixtureKind | null;
}) {
  if (!fixture) {
    return null;
  }

  const anchorRect = { x: 640, y: 330, width: 160, height: 28 };
  const openOnly = () => undefined;

  if (fixture === 'empty-workspace') {
    return (
      <div
        className="fixed inset-0 z-dialog-content flex bg-surface-canvas-bg text-ink-default"
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <aside className="flex h-full w-56 shrink-0 flex-col border-r border-border-subtle bg-surface-notes-list">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border-subtle/60 px-4">
            <span className="text-xs font-medium text-ink-muted">Notes</span>
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded text-ink-faint"
              aria-label="New Note"
            >
              <SquarePlus aria-hidden className="h-4 w-4" />
            </button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col justify-between px-3 py-4">
            <div className="rounded-xl border border-dashed border-border-subtle bg-surface-raised-card p-4 text-sm text-ink-muted">
              No notes yet
            </div>
            <div className="flex items-center justify-between border-t border-border-subtle/60 pt-3">
              <span className="text-xs text-ink-faint">Settings</span>
              <CircleHelp aria-hidden className="h-3.5 w-3.5 text-ink-faint" />
            </div>
          </div>
        </aside>
        <main className="relative flex min-w-0 flex-1 items-center justify-center bg-surface-canvas">
          <div className="flex max-w-sm flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border-subtle bg-surface-canvas text-accent-brand shadow-sm">
              <FileText aria-hidden className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h2 className="text-lg font-semibold text-ink-default">No note selected</h2>
              <p className="text-sm text-ink-muted">Create a new note to get started</p>
            </div>
            <Button size="sm">
              <SquarePlus aria-hidden className="h-4 w-4" />
              New Note
            </Button>
          </div>
        </main>
        <aside className="flex h-full w-56 shrink-0 flex-col border-l border-border-subtle bg-surface-notes-list">
          <div className="flex h-12 shrink-0 items-center border-b border-border-subtle/60 px-4">
            <span className="text-xs font-medium text-ink-muted">Actions</span>
          </div>
          <div className="flex flex-1 items-center justify-center px-4 text-center text-caption text-ink-faint">
            No note selected
          </div>
        </aside>
      </div>
    );
  }

  if (fixture === 'mention-typeahead') {
    return (
      <TypeaheadMenu
        items={SNAPSHOT_TYPEAHEAD_ITEMS}
        selectedIndex={0}
        position={{ top: 360, left: 560 }}
        onSelect={openOnly}
        onClose={openOnly}
        width={300}
      />
    );
  }

  if (fixture === 'comment-input-popover') {
    return (
      <CommentInputPopover
        open
        onOpenChange={openOnly}
        anchorRect={anchorRect}
        noteId="snapshot-prose"
        onCreate={() => false}
      />
    );
  }

  if (fixture === 'comment-popover') {
    return (
      <CommentPopover
        open
        onOpenChange={openOnly}
        anchorRect={anchorRect}
        placement="bottom-end"
        comment={SNAPSHOT_COMMENT}
        commentsMap={{ [SNAPSHOT_COMMENT.id]: SNAPSHOT_COMMENT }}
        noteId="snapshot-prose"
        onUpdate={openOnly}
        onDelete={openOnly}
        onReply={() => false}
        onSendToAgent={openOnly}
      />
    );
  }

  if (fixture === 'connected-folders-popover') {
    return (
      <div
        className="fixed z-dialog-content"
        style={{ left: 560, top: 560 } as CSSProperties}
      >
        <AddContextPopover
          open
          onOpenChange={openOnly}
          allFolders={[
            'Notes/Fixture',
            'Notes/Fixture/Media',
            'Notes/Research',
          ]}
          enabledPaths={new Set(['Notes/Fixture'])}
          onToggle={openOnly}
          onAddFolder={openOnly}
          onInsertMention={openOnly}
        >
          <button
            type="button"
            className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2 text-xs text-ink-default shadow-sm"
          >
            Add context
          </button>
        </AddContextPopover>
      </div>
    );
  }

  if (fixture === 'media-source-dialog') {
    return (
      <MediaSourceDialog
        open
        onOpenChange={openOnly}
        onSelectFile={openOnly}
        onSelectUrl={openOnly}
      />
    );
  }

  if (fixture === 'rename-folder-dialog') {
    return (
      <RenameFolderDialog
        open
        onOpenChange={openOnly}
        folderPath="Notes/Fixture"
        currentName="Fixture"
        onSuccess={openOnly}
      />
    );
  }

  if (fixture === 'confirmation-dialog') {
    return (
      <ConfirmationDialog
        open
        onOpenChange={openOnly}
        title="Move fixture note to trash?"
        description="This confirms the shared confirmation dialog styling without changing fixture data."
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={openOnly}
      />
    );
  }

  if (fixture === 'copy-for-agent-dialog') {
    return (
      <CopyForAgentDialog
        open
        onOpenChange={openOnly}
        message={[
          '## Fixture prompt',
          'I\'m working in: /tmp/moss-visual-workspace/Notes/Fixture/Fixture Prose Checklist.md',
          '',
          '! Review the current note and keep the response concise.',
          '---',
          '> Fixture Prose Checklist',
        ].join('\n')}
      />
    );
  }

  if (fixture === 'timeline-popout-dialog') {
    const tab = createSnapshotActionTabs('completed-expanded')[0] ?? null;
    return (
      <TimelinePopoutModal
        open
        tab={tab}
        onClose={openOnly}
        hasPrev={false}
        hasNext={true}
        onPrev={openOnly}
        onNext={openOnly}
        onCopyPrompt={openOnly}
      />
    );
  }

  if (fixture === 'slot-button-as-child') {
    return (
      <div className="fixed bottom-10 left-1/2 z-dialog-content -translate-x-1/2 rounded-xl border border-border-subtle bg-surface-raised-card p-4 shadow-lg">
        <Button asChild>
          <a href="#snapshot-as-child">Open fixture link</a>
        </Button>
      </div>
    );
  }

  return null;
}

export function App() {
  useThemeEffect();

  const [activeNoteId, setActiveNoteId] = useAtom(activeNoteIdAtom);
  const activeNote = useAtomValue(activeNoteEntityAtom);
  const splitTabNoteId = useAtomValue(splitTabNoteIdAtom);
  const focusedNoteId = useAtomValue(focusedNoteIdAtom);
  const focusedNoteFrontmatter = useAtomValue(noteFrontmatterAtom(focusedNoteId ?? NO_NOTE_SENTINEL));
  const noteIntelligenceEnabled = useAtomValue(noteIntelligenceEnabledAtom);
  const actionTabs = useAtomValue(activeActionTabsAtom);
  const [expandedActionTabIds, setExpandedActionTabIds] = useAtom(activeExpandedActionTabIdsAtom);
  const [showCommandPalette, setShowCommandPalette] = useAtom(showCommandPaletteAtom);
  const commandPaletteDocked = useAtomValue(commandPaletteDockedAtom);
  const [activeFolderPath, setActiveFolderPath] = useAtom(activeFolderPathAtom);
  const setBackendFolders = useSetAtom(backendFoldersAtom);
  const [notesListWidth, setNotesListWidth] = useState<number>(NOTES_LIST_WIDTH_DEFAULT);
  const resizePointerIdRef = useRef<number | null>(null);
  const resizeStartXRef = useRef<number>(0);
  const resizeStartWidthRef = useRef<number>(NOTES_LIST_WIDTH_DEFAULT);

  const [actionsPanelWidth, setActionsPanelWidth] = useState<number>(() => readStoredActionsPanelWidth());
  const actionsResizePointerIdRef = useRef<number | null>(null);
  const actionsResizeStartXRef = useRef<number>(0);
  const actionsResizeStartWidthRef = useRef<number>(ACTIONS_PANEL_WIDTH_DEFAULT);
  const actionsResizeCurrentWidthRef = useRef<number>(actionsPanelWidth);
  const actionsResizeHandleRef = useRef<HTMLDivElement>(null);
  const actionsPanelScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleWindowResize = () => {
      setNotesListWidth((current) => clampNotesListWidth(current));
    };

    window.addEventListener('resize', handleWindowResize, { passive: true });
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (typeof document !== 'undefined') {
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
      }
    };
  }, []);

  const stopResizingNotesPanel = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && resizePointerIdRef.current !== pointerId) {
      return;
    }

    resizePointerIdRef.current = null;
    if (typeof document !== 'undefined') {
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    }
  }, []);

  const startResizingNotesPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      resizePointerIdRef.current = event.pointerId;
      resizeStartXRef.current = event.clientX;
      resizeStartWidthRef.current = notesListWidth;
      event.currentTarget.setPointerCapture(event.pointerId);

      if (typeof document !== 'undefined') {
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }
    },
    [notesListWidth]
  );

  const handleNotesPanelResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizePointerIdRef.current !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - resizeStartXRef.current;
    setNotesListWidth(clampNotesListWidth(resizeStartWidthRef.current + deltaX));
  }, []);

  const handleNotesPanelResizeRelease = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (resizePointerIdRef.current !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResizingNotesPanel(event.pointerId);
    },
    [stopResizingNotesPanel]
  );

  const handleNotesPanelResizeCaptureLost = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      stopResizingNotesPanel(event.pointerId);
    },
    [stopResizingNotesPanel]
  );

  const resetNotesPanelWidth = useCallback(() => {
    stopResizingNotesPanel();
    setNotesListWidth(clampNotesListWidth(NOTES_LIST_WIDTH_DEFAULT));
  }, [stopResizingNotesPanel]);

  // --- Actions panel resize ---

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const clampedWidth = clampActionsPanelWidth(actionsPanelWidth);
    actionsResizeCurrentWidthRef.current = clampedWidth;
    window.localStorage.setItem(ACTIONS_PANEL_WIDTH_STORAGE_KEY, String(clampedWidth));
    document.documentElement.style.setProperty('--actions-panel-width', `${clampedWidth}px`);
  }, [actionsPanelWidth]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty(
      '--notes-panel-width',
      `${notesListWidth + NOTES_PANEL_RESIZER_WIDTH_PX}px`
    );
  }, [notesListWidth]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleWindowResize = () => {
      setActionsPanelWidth((current) => clampActionsPanelWidth(current));
    };

    window.addEventListener('resize', handleWindowResize, { passive: true });
    return () => {
      window.removeEventListener('resize', handleWindowResize);
    };
  }, []);

  const stopResizingActionsPanel = useCallback((pointerId?: number) => {
    if (pointerId !== undefined && actionsResizePointerIdRef.current !== pointerId) {
      return;
    }

    const wasResizing = actionsResizePointerIdRef.current !== null;
    actionsResizePointerIdRef.current = null;
    actionsResizeHandleRef.current?.classList.remove('bg-surface-notes-list');

    if (wasResizing) {
      setActionsPanelWidth(actionsResizeCurrentWidthRef.current);
    }

    if (typeof document !== 'undefined') {
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    }
  }, []);

  const startResizingActionsPanel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      actionsResizePointerIdRef.current = event.pointerId;
      actionsResizeStartXRef.current = event.clientX;
      actionsResizeStartWidthRef.current = actionsPanelWidth;
      actionsResizeCurrentWidthRef.current = actionsPanelWidth;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add('bg-surface-notes-list');

      if (typeof document !== 'undefined') {
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }
    },
    [actionsPanelWidth]
  );

  const handleActionsPanelResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (actionsResizePointerIdRef.current !== event.pointerId) {
      return;
    }

    // Inverted: dragging LEFT increases width (panel is on right side)
    const deltaX = event.clientX - actionsResizeStartXRef.current;
    const nextWidth = clampActionsPanelWidth(actionsResizeStartWidthRef.current - deltaX);
    actionsResizeCurrentWidthRef.current = nextWidth;
    document.documentElement.style.setProperty('--actions-panel-width', `${nextWidth}px`);
  }, []);

  const handleActionsPanelResizeRelease = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (actionsResizePointerIdRef.current !== event.pointerId) {
        return;
      }

      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      stopResizingActionsPanel(event.pointerId);
    },
    [stopResizingActionsPanel]
  );

  const handleActionsPanelResizeCaptureLost = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      stopResizingActionsPanel(event.pointerId);
    },
    [stopResizingActionsPanel]
  );

  const resetActionsPanelWidth = useCallback(() => {
    stopResizingActionsPanel();
    setActionsPanelWidth(clampActionsPanelWidth(ACTIONS_PANEL_WIDTH_DEFAULT));
  }, [stopResizingActionsPanel]);

  // Jotai store for synchronous atom reads (bypasses React render timing)
  const store = useStore();

  const notesHydrated = useAtomValue(notesHydratedAtom);

  const [appMode, setAppMode] = useState<AppMode>('notes');
  const appModeRef = useRef<AppMode>('notes');
  appModeRef.current = appMode;
  const automationFixtureNotesActiveRef = useRef(false);
  const automationMaterializedNoteIdsRef = useRef(new Map<string, string>());
  const [automationUiFixture, setAutomationUiFixture] =
    useState<SnapshotUiFixtureKind | null>(null);
  const [ipcReady, setIpcReady] = useState(false);
  const [windowContext, setWindowContext] = useState<MossWindowContext | null>(null);
  const [windowContextReady, setWindowContextReady] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [searchBarAutoFocus, setSearchBarAutoFocus] = useState(true);
  const clearSearch = useSetAtom(clearSearchAtom);
  const setSearchQuery = useSetAtom(setSearchQueryAtom);
  const setLightboxSrc = useSetAtom(lightboxSrcAtom);
  const [operationFailure, setOperationFailure] = useState<OperationFailureNotice | null>(null);
  const operationFailureDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const renameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Single source of truth for search bar visibility — derived from the atom
  const showSearchBar = useAtomValue(searchStateAtom).isActive;

  const hasElectronBridge =
    typeof window !== 'undefined' &&
    Boolean((window as typeof window & { electronAPI?: unknown }).electronAPI?.notes);

  useEffect(() => {
    if (!hasElectronBridge || !ipcReady) {
      return;
    }

    const noteIds = [...new Set(
      [activeNoteId, splitTabNoteId].filter((noteId): noteId is string => typeof noteId === 'string' && noteId.length > 0)
    )];

    void notesApi.setOpenFileWatchTargets.invoke(noteIds).catch(() => undefined);
  }, [activeNoteId, hasElectronBridge, ipcReady, splitTabNoteId]);

  useEffect(() => {
    if (!hasElectronBridge || !ipcReady) {
      return;
    }

    void systemApi.setFocusedNoteId.invoke(focusedNoteId ?? null).catch(() => undefined);
  }, [focusedNoteId, hasElectronBridge, ipcReady]);

  // =========================================================================
  // Quit-flush: main process requests the window to flush before quitting.
  // Listener lives here (not in CanvasAreaContent) because both panes in a
  // split window share the same webContents.id — two per-pane listeners
  // would each call flushComplete and the second arrival could overwrite
  // the first's failure in main.ts:flushFailures, silently dropping a
  // pane's error. This single reporter awaits every pane via
  // Promise.allSettled and emits one aggregated flushComplete per window.
  // =========================================================================
  useEffect(() => {
    if (!hasElectronBridge) return;

    const cleanup = window.electronAPI.notes.onRequestFlush(() => {
      const flushStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const durationSince = () => {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return Math.max(0, Math.round(now - flushStart));
      };
      const profileQuit = (phase: string, details?: Record<string, unknown>) => {
        if (!isQuitProfilingEnabled()) {
          return;
        }
        console.log('[quit-profile:renderer]', JSON.stringify({
          phase,
          atMs: durationSince(),
          ...(details ?? {})
        }));
      };
      profileQuit('request-received');

      // Collect every mounted pane's handle. splitRightPaneRef may be null
      // when the split isn't open — treat missing handles as a resolved
      // no-op so the aggregator still reports success.
      const paneHandles = [canvasRef.current, splitRightPaneRef.current];
      const paneNoteIds = paneHandles.map((handle) => handle?.getMountedNoteId() ?? null);
      profileQuit('panes-collected', {
        paneCount: paneHandles.filter(Boolean).length,
        paneNoteIds
      });

      const flushPromises = paneHandles.map((handle) =>
        handle ? handle.flushAndWait() : Promise.resolve()
      );

      void Promise.allSettled(flushPromises)
        .then((results) => {
          profileQuit('panes-settled', {
            results: results.map((result, index) => ({
              noteId: paneNoteIds[index],
              status: result.status
            }))
          });
          const failures: Array<{ noteId: string | null; errorMessage: string }> = [];
          results.forEach((result, index) => {
            if (result.status === 'rejected') {
              const error = result.reason;
              failures.push({
                noteId: paneNoteIds[index],
                errorMessage:
                  error instanceof Error ? error.message : 'Failed to save note before quit.'
              });
            }
          });

          if (failures.length === 0) {
            const firstNoteId = paneNoteIds.find((id): id is string => typeof id === 'string' && id.length > 0) ?? null;
            return window.electronAPI.notes.flushComplete({
              status: 'success',
              noteId: firstNoteId,
              durationMs: durationSince()
            });
          }

          console.warn('[quit-flush] One or more panes failed to save before quit', { failures });
          const primary = failures[0];
          const combinedMessage = failures
            .map((failure) => failure.errorMessage)
            .filter((msg) => typeof msg === 'string' && msg.length > 0)
            .join('; ');

          return window.electronAPI.notes.flushComplete({
            status: 'error',
            noteId: primary.noteId,
            durationMs: durationSince(),
            errorMessage: combinedMessage.length > 0 ? combinedMessage : 'Failed to save note before quit.'
          });
        })
        .catch(() => {});
    });

    return cleanup;
  }, [hasElectronBridge]);

  const reconcileNotesFromDisk = useCallback(async (reason: string, noteId?: string) => {
    if (!hasElectronBridge) {
      return;
    }

    try {
      await store.set(hydrateNotesAtom);
    } catch (error) {
      console.warn('[note-integrity] Failed to reconcile notes after renderer/main mismatch', {
        reason,
        noteId,
        error
      });
    }
  }, [hasElectronBridge, store]);

  const applyNoteRecordToStore = useCallback((record: NoteMetadataRecord) => {
    const currentEntity = store.get(noteEntityAtom(record.id));
    const entity = mapNoteMetadataToNoteEntity(record);

    if (currentEntity) {
      entity.links = {
        outgoing: record.outgoingLinks ?? [...currentEntity.links.outgoing],
        incoming: record.incomingLinks ?? [...currentEntity.links.incoming]
      };
    }

    store.set(noteEntityAtom(record.id), entity);
    store.set(noteIdsAtom, (prev: Set<string>) => {
      if (prev.has(record.id)) {
        return prev;
      }
      const next = new Set(prev);
      next.add(record.id);
      return next;
    });
  }, [store]);

  const showOperationFailure = useCallback((message: string) => {
    if (operationFailureDismissTimerRef.current) {
      clearTimeout(operationFailureDismissTimerRef.current);
      operationFailureDismissTimerRef.current = null;
    }

    const displayMessage = message.includes('External note file is unavailable:')
      ? 'File was moved or deleted. Re-open the file and try again.'
      : message;

    setOperationFailure({ id: Date.now(), message: displayMessage });

    operationFailureDismissTimerRef.current = setTimeout(() => {
      operationFailureDismissTimerRef.current = null;
      setOperationFailure(null);
    }, OPERATION_NOTICE_AUTO_DISMISS_MS);
  }, []);

  const activeNoteIsTrashed = activeNote?.trashedAt != null;
  const viewSelectionRef = useRef<{ notes: string | null; trash: string | null }>({
    notes: null,
    trash: null
  });
  const didInitializeStartupSelectionRef = useRef(false);
  const commandPaletteRef = useRef<CommandPaletteOverlayHandle>(null);

  // moss-multi seam: only the requested note may consume a title-focus intent.
  const [titleFocusNoteId, setTitleFocusNoteId] = useState<string | null>(null);
  const [shouldFocusBody, setShouldFocusBody] = useState(false);
  const handleTitleFocusComplete = useCallback(() => {
    setTitleFocusNoteId(null);
  }, []);
  const handleBodyFocusComplete = useCallback(() => {
    setShouldFocusBody(false);
  }, []);
  const activeAgentNoteIds = useAtomValue(activeAgentNoteIdsAtom);
  const uiAgentBusyNoteIds = useAtomValue(uiAgentBusyNoteIdsAtom);
  const setPendingAgentExecution = useSetAtom(setPendingAgentExecutionAtom);
  const [actionsPanelHidden, setActionsPanelHidden] = useAtom(actionsPanelHiddenAtom);
  const zenModeActive = useAtomValue(zenModeAtom);
  const [notesPanelHidden, setNotesPanelHidden] = useAtom(notesPanelHiddenAtom);
  const toggleZenMode = useSetAtom(toggleZenModeAtom);
  const notesPanelWrapperRef = useRef<HTMLDivElement | null>(null);
  const [showZenNotesPanel, setShowZenNotesPanel] = useState(false);
  const narrow = useNarrow(); // moss-multi seam: phone-shell (T2.7): opened by its toggle; open while no note is
  const [narrowNotesOpen, setNarrowNotesOpen] = useState(false);
  const narrowNotesVisible = narrow && (narrowNotesOpen || !activeNoteId);
  const [showZenTopBar, setShowZenTopBar] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<UpdateReadyInfo | null>(null);
  const [selectedContext, setSelectedContext] = useState<string | null>(null);
  const pendingAgentContext = useAtomValue(pendingAgentContextAtom);
  const pendingAgentContextIconUrl = useAtomValue(pendingAgentContextIconUrlAtom);
  const pendingAgentContextSourceUrl = useAtomValue(pendingAgentContextSourceUrlAtom);
  const effectiveSelectedContext = selectedContext ?? pendingAgentContext;
  const effectiveSelectedContextIconUrl = selectedContext ? null : pendingAgentContextIconUrl;
  const effectiveSelectedContextSourceUrl = selectedContext ? null : pendingAgentContextSourceUrl;
  const tabDetailsCacheRef = useRef<Record<string, CachedActionDetails>>({});

  const isActiveNoteAgentBusy = uiAgentBusyNoteIds.has(activeNoteId ?? '');
  // Single gate for prompt availability: note must exist, not be trashed, and not be executing.
  const canOpenPrompt = Boolean(activeNote && !activeNoteIsTrashed && !isActiveNoteAgentBusy);

  useEffect(() => {
    if (isActiveNoteAgentBusy && showCommandPalette) {
      setShowCommandPalette(false);
    }
  }, [isActiveNoteAgentBusy, showCommandPalette, setShowCommandPalette]);

  useEffect(() => {
    return () => {
      if (operationFailureDismissTimerRef.current) {
        clearTimeout(operationFailureDismissTimerRef.current);
        operationFailureDismissTimerRef.current = null;
      }
      if (renameTimerRef.current) {
        clearTimeout(renameTimerRef.current);
        renameTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (zenModeActive) {
      return;
    }
    setShowZenNotesPanel(false);
    setShowZenTopBar(false);
  }, [zenModeActive]);

  useEffect(() => {
    if (!zenModeActive) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const nearLeftEdge = event.clientX <= ZEN_NOTES_REVEAL_EDGE_PX;
      const nearTopEdge = event.clientY <= ZEN_TOP_BAR_REVEAL_EDGE_PX;
      const panelRect = notesPanelWrapperRef.current?.getBoundingClientRect();
      const overNotesPanel = Boolean(
        panelRect &&
        panelRect.width > 0 &&
        event.clientX >= panelRect.left &&
        event.clientX <= panelRect.right &&
        event.clientY >= panelRect.top &&
        event.clientY <= panelRect.bottom
      );

      const shouldShowNotesPanel = nearLeftEdge || overNotesPanel;
      setShowZenNotesPanel((current) => (current === shouldShowNotesPanel ? current : shouldShowNotesPanel));
      setShowZenTopBar((current) => (current === nearTopEdge ? current : nearTopEdge));
    };

    const handleWindowExit = () => {
      setShowZenNotesPanel(false);
      setShowZenTopBar(false);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('blur', handleWindowExit);
    window.addEventListener('mouseleave', handleWindowExit);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('blur', handleWindowExit);
      window.removeEventListener('mouseleave', handleWindowExit);
    };
  }, [zenModeActive]);

  // Hydrate notes from IPC on mount.
  // Uses a cancelled flag so the .then() callback is a no-op if the component
  // unmounts before waitForReady resolves (e.g. during HMR).
  useEffect(() => {
    let cancelled = false;
    const loadWindowContext = async (): Promise<void> => {
      try {
        const context = await window.electronAPI?.system?.getWindowContext?.();
        if (!cancelled) {
          setWindowContext(withLocationInitialNoteFallback(context));
        }
      } catch {
        if (!cancelled) {
          setWindowContext(withLocationInitialNoteFallback(null));
        }
      } finally {
        if (!cancelled) {
          setWindowContextReady(true);
        }
      }
    };

    if (hasElectronBridge) {
      const waitForReady = window.electronAPI?.system?.waitForReady;
      if (waitForReady) {
        setIpcReady(false);
        setWindowContextReady(false);
        // Wait for main process IPC handlers before hydrating
        void waitForReady().then(async () => {
          if (cancelled) return;
          setIpcReady(true);
          await loadWindowContext();
          if (cancelled) return;
          store.set(hydrateNotesAtom);
          const settingsWarmup = store.set(ensureSettingsWarmupAtom);
          void settingsWarmup.then(() => {
            if (!cancelled) store.set(refreshConnectedFolderEntriesAtom);
          });
        }).catch(() => {
          if (cancelled) return;
          setIpcReady(false);
          setWindowContextReady(true);
          // Unblock the UI even if waitForReady rejects (e.g. main process crash)
          store.set(notesHydratedAtom, true);
        });
      } else {
        setIpcReady(true);
        setWindowContextReady(false);
        void loadWindowContext();
        store.set(hydrateNotesAtom);
        const settingsWarmup = store.set(ensureSettingsWarmupAtom);
        void settingsWarmup.then(() => {
          if (!cancelled) store.set(refreshConnectedFolderEntriesAtom);
        });
      }
    } else {
      setIpcReady(true);
      setWindowContextReady(true);
      // No bridge — mark hydrated immediately so stories/tests aren't stuck
      store.set(notesHydratedAtom, true);
    }

    return () => { cancelled = true; };
  }, [hasElectronBridge, store]);

  // Keep note list synchronized with disk changes and app foreground transitions.
  useEffect(() => {
    if (!hasElectronBridge) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let queued = false;
    let targetedRefreshInFlight = false;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Accumulated work for the next debounced flush. A full hydrate is a
    // superset of any targeted refresh, so if both are pending we run the
    // full hydrate and drop the targeted ids.
    let pendingFullHydrate = false;
    const pendingTargetedIds = new Set<string>();
    const queuedTargetedIds = new Set<string>();

    const runHydrate = () => {
      if (cancelled) {
        return;
      }
      if (automationFixtureNotesActiveRef.current) {
        return;
      }

      if (inFlight) {
        queued = true;
        return;
      }

      inFlight = true;
      void store.set(hydrateNotesAtom).catch((error) => {
        console.warn('[note-sync] Failed to hydrate notes from disk:', error);
      }).finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          runHydrate();
        }
      });
    };

    // Refresh metadata for only the affected notes. If any requested note has
    // no backend record (deleted/moved out), fall back to a full hydrate so the
    // note list can reconcile removals.
    const runTargetedRefresh = (ids: string[]) => {
      if (cancelled || automationFixtureNotesActiveRef.current) {
        return;
      }

      for (const id of ids) {
        queuedTargetedIds.add(id);
      }
      if (targetedRefreshInFlight) {
        return;
      }

      const refreshIds = [...queuedTargetedIds];
      queuedTargetedIds.clear();
      if (refreshIds.length === 0) {
        return;
      }

      // A rename can produce separate unlink/add watcher batches. Serialize
      // targeted metadata reads so an older response cannot land after the
      // newer batch and restore a stale title or path in one renderer window.
      targetedRefreshInFlight = true;
      void store
        .set(syncNotesMetadataByIdsAtom, refreshIds)
        .then((result) => {
          if (cancelled) {
            return;
          }
          if (result.missingIds.length > 0) {
            runHydrate();
          }
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          console.warn('[note-sync] Targeted metadata refresh failed; falling back to hydrate:', error);
          runHydrate();
        })
        .finally(() => {
          targetedRefreshInFlight = false;
          if (!cancelled && queuedTargetedIds.size > 0) {
            runTargetedRefresh([]);
          }
        });
    };

    const flushPending = () => {
      if (cancelled) {
        return;
      }
      const doFullHydrate = pendingFullHydrate;
      const targetedIds = [...pendingTargetedIds];
      pendingFullHydrate = false;
      pendingTargetedIds.clear();

      if (doFullHydrate || targetedIds.length === 0) {
        runHydrate();
      } else {
        runTargetedRefresh(targetedIds);
      }
    };

    const scheduleFlush = () => {
      if (cancelled) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flushPending();
      }, NOTE_LIST_SYNC_DEBOUNCE_MS);
    };

    // Background note-list sync is metadata-only so unopened notes do not go
    // through full content reads and trigger migrations.
    let connectedEntriesRefreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleConnectedFolderEntriesRefresh = () => {
      if (connectedEntriesRefreshTimer) {
        clearTimeout(connectedEntriesRefreshTimer);
      }
      connectedEntriesRefreshTimer = setTimeout(() => {
        connectedEntriesRefreshTimer = null;
        store.set(refreshConnectedFolderEntriesAtom);
      }, 150);
    };

    // A folder deleted/moved on disk is unregistered in the backend index, but the
    // note-list hydrate refreshes notes only — backendFoldersAtom would keep the
    // stale row until the next note switch. Refresh it on structural disk changes.
    let backendFoldersRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleBackendFoldersRefresh = () => {
      if (backendFoldersRefreshTimer) {
        clearTimeout(backendFoldersRefreshTimer);
      }
      backendFoldersRefreshTimer = setTimeout(() => {
        backendFoldersRefreshTimer = null;
        void foldersApi.list
          .invoke({ cleanupEmpty: false })
          .then((folders) => {
            if (cancelled) {
              return;
            }
            store.set(
              backendFoldersAtom,
              folders.map((folder) => ({
                name: folder.name,
                path: folder.path,
                noteCount: folder.noteCount,
                createdAt: folder.createdAt ?? 0,
                type: folder.type
              }))
            );
          })
          .catch(() => undefined);
      }, 200);
    };

    // Full metadata re-hydrate: creates/deletes/moves, metadata sidecars,
    // structure changes, reindex, and unresolved (noteIds-empty) changes.
    const requestFullHydrate = () => {
      if (automationFixtureNotesActiveRef.current) {
        return;
      }
      pendingFullHydrate = true;
      scheduleFlush();
    };

    // Targeted refresh: metadata-only refresh for affected note IDs. For known
    // content-only changes this avoids a full note-list hydrate; for newly
    // adopted notes it adds the unknown ID directly and falls back to hydrate if
    // the backend reports the ID as missing.
    const requestTargetedRefresh = (noteIds: string[]) => {
      if (automationFixtureNotesActiveRef.current) {
        return;
      }
      for (const id of noteIds) {
        pendingTargetedIds.add(id);
      }
      scheduleFlush();
    };

    const requestImmediateMetadataRefresh = (noteIds: string[]) => {
      if (automationFixtureNotesActiveRef.current) {
        return;
      }
      runTargetedRefresh(noteIds);
    };

    const onDiskChange = window.electronAPI?.notes?.onDiskChange;
    const cleanupDiskChange =
      typeof onDiskChange === 'function'
        ? onDiskChange((noteIds, contentNoteIds) => {
            if (noteIds.length === 0) {
              // Unresolved change: refresh connected-folder entries and do a
              // full hydrate so newly-appeared/removed notes are reconciled.
              scheduleConnectedFolderEntriesRefresh();
              scheduleBackendFoldersRefresh();
              requestFullHydrate();
              return;
            }

            // Content-only iff every affected note id is a content note id
            // (no meta.json / folder metadata touched => no structure change).
            const contentIds = contentNoteIds ?? [];
            const isContentOnly =
              contentIds.length === noteIds.length &&
              noteIds.every((id) => contentIds.includes(id));

            // Only take the targeted path for notes the renderer already lists.
            // Unknown ids (creates, external imports) need a full hydrate.
            const knownIds = store.get(noteIdsAtom);
            const allKnown = noteIds.every((id) => knownIds.has(id));

            if (isContentOnly && allKnown) {
              requestTargetedRefresh(noteIds);
            } else {
              // Structural change (creates/deletes/moves, metadata): folders may
              // have appeared or disappeared on disk — refresh the backend folders.
              scheduleBackendFoldersRefresh();
              if (noteIds.length > 0 && allKnown) {
                requestImmediateMetadataRefresh(noteIds);
              } else {
                requestFullHydrate();
              }
            }
          })
        : () => {};
    const onMetadataReindexed = window.electronAPI?.notes?.onMetadataReindexed;
    const cleanupMetadataReindexed =
      typeof onMetadataReindexed === 'function'
        ? onMetadataReindexed(() => requestFullHydrate())
        : () => {};

    return () => {
      cancelled = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      if (connectedEntriesRefreshTimer) {
        clearTimeout(connectedEntriesRefreshTimer);
      }
      if (backendFoldersRefreshTimer) {
        clearTimeout(backendFoldersRefreshTimer);
      }
      cleanupDiskChange();
      cleanupMetadataReindexed();
    };
  }, [hasElectronBridge, store]);

  // Listen for update-ready push from main process.
  // Skip if the user already dismissed this specific version.
  useEffect(() => {
    if (!hasElectronBridge) return;
    return window.electronAPI.update.onReady((info) => {
      const dismissed = localStorage.getItem(getUpdateDismissedStorageKey(info.canInstall));
      setUpdateInfo((current) => {
        if (shouldIgnoreIncomingUpdate(info, current, dismissed)) {
          return current;
        }
        return info;
      });
    });
  }, [hasElectronBridge]);

  // Dev helper for quickly previewing update widget states without packaged auto-updater.
  useEffect(() => {
    if (isRendererProduction()) {
      return;
    }
    const devWindow = window as Window & {
      __devShowUpdateWidget?: (info?: Partial<UpdateReadyInfo>) => void;
      __devHideUpdateWidget?: () => void;
      __devShowUpdateWidgetFromChangelog?: (url?: string) => Promise<void>;
    };
    const DEFAULT_CHANGELOG_PAGE_URL = 'http://localhost:3000/changelog';
    const DEFAULT_CHANGELOG_JSON_URL = 'http://localhost:3000/changelog.json';

    const showWidget = (info: UpdateReadyInfo) => {
      setUpdateInfo(info);
    };

    devWindow.__devShowUpdateWidget = (info) => {
      const version = info?.version ?? '0.0.0-dev';
      showWidget({
        version,
        highlights: info?.highlights ?? '## Highlights\n\n- Dev preview update.',
        changelogUrl: info?.changelogUrl ?? DEFAULT_CHANGELOG_PAGE_URL
      });
    };
    devWindow.__devShowUpdateWidgetFromChangelog = async (url) => {
      const changelogJsonUrl = url ?? DEFAULT_CHANGELOG_JSON_URL;
      const changelogPageUrl = changelogJsonUrl.replace(/\/changelog\.json(?:\?.*)?$/, '/changelog');
      try {
        const response = await fetch(changelogJsonUrl, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to fetch changelog: ${response.status}`);
        }
        const entries = await response.json() as Array<{ version: string; body: string }>;
        const latest = entries[0];
        if (!latest?.body) {
          throw new Error('Missing changelog entry');
        }
        const highlightsMatch = latest.body.match(/## Highlights\s*\n([\s\S]*?)(?=\n##|\n*$)/);
        const highlights = highlightsMatch
          ? highlightsMatch[1].trim()
          : latest.body.split('\n\n')[0]?.replace(/^#+\s*/gm, '').trim() || 'A new version is ready.';
        showWidget({
          version: latest.version ?? 'new',
          highlights,
          changelogUrl: changelogPageUrl
        });
      } catch {
        showWidget({
          version: '0.0.0-dev',
          highlights: 'A new version is ready.',
          changelogUrl: DEFAULT_CHANGELOG_PAGE_URL
        });
      }
    };
    devWindow.__devHideUpdateWidget = () => {
      setUpdateInfo(null);
    };

    return () => {
      delete devWindow.__devShowUpdateWidget;
      delete devWindow.__devHideUpdateWidget;
      delete devWindow.__devShowUpdateWidgetFromChangelog;
    };
  }, []);

  const lastFolderRefreshKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!hasElectronBridge) {
      return;
    }

    const refreshKey = appMode;
    if (lastFolderRefreshKeyRef.current === refreshKey) {
      return;
    }
    lastFolderRefreshKeyRef.current = refreshKey;

    void foldersApi.list
      .invoke({ cleanupEmpty: false })
      .then((folders) => {
        setBackendFolders(
          folders.map((folder) => ({
            name: folder.name,
            path: folder.path,
            noteCount: folder.noteCount,
            createdAt: folder.createdAt ?? 0,
            type: folder.type
          }))
        );
      })
      .catch((error) => {
        if (isRendererDevelopment()) {
          console.warn('[FolderList] Failed to refresh folders:', error);
        }
      });
  }, [appMode, hasElectronBridge, setBackendFolders]);

  // Prevent Electron's default file drop behavior (navigating to the file)
  // Only preventDefault - don't stopPropagation so ImageDropPlugin still receives events
  useEffect(() => {
    const preventNavigation = (e: DragEvent) => {
      e.preventDefault();
    };

    // Must prevent on both dragover AND drop to stop browser navigation
    document.addEventListener('dragover', preventNavigation);
    document.addEventListener('drop', preventNavigation);

    return () => {
      document.removeEventListener('dragover', preventNavigation);
      document.removeEventListener('drop', preventNavigation);
    };
  }, []);

  const canvasRef = useRef<CanvasAreaContentHandle>(null);
  const splitRightPaneRef = useRef<CanvasAreaContentHandle>(null);
  const notesListRef = useRef<NotesListPanelContentHandle>(null);
  const trashListRef = useRef<TrashedNotesPanelContentHandle>(null);
  const isBrowserSplitOpen = useAtomValue(isBrowserSplitOpenAtom);
  const noteSwitchQueueRef = useRef<Promise<void>>(Promise.resolve());

  // Agent streaming subscription - all events go through updateAgentStreamAtom
  // for tab state. Comment sidecar edits are written by the agent directly.
  useAgentStream();

  const {
    canGoBack,
    canGoForward,
    goBack,
    goForward,
    navigateToNote
  } = useNavigationHistory();

  // Restore startup note selection from explicit window context when present.
  // Otherwise fall back to the last viewed note, then the most recent note.
  useEffect(() => {
    if (!notesHydrated || !windowContextReady || didInitializeStartupSelectionRef.current) {
      return;
    }

    let cancelled = false;
    const initialNoteId = windowContext?.initialNoteId ?? null;

    const selectStartupNote = (noteId: string): void => {
      if (cancelled || didInitializeStartupSelectionRef.current) {
        return;
      }
      navigateToNote(noteId);
      viewSelectionRef.current.notes = noteId;
      didInitializeStartupSelectionRef.current = true;
    };

    const initializeStartupSelection = async (): Promise<void> => {
      let availableNotes = store.get(activeNotesAtom);
      if (availableNotes.length === 0 && !initialNoteId) {
        didInitializeStartupSelectionRef.current = true;
        return;
      }

      if (initialNoteId) {
        if (availableNotes.some((note) => note.id === initialNoteId)) {
          selectStartupNote(initialNoteId);
          return;
        }

        if (hasElectronBridge) {
          try {
            const record = await notesApi.getById.invoke(initialNoteId, { skipAnalytics: true });
            if (cancelled || didInitializeStartupSelectionRef.current) {
              return;
            }
            if (store.get(activeNoteIdAtom)) {
              didInitializeStartupSelectionRef.current = true;
              return;
            }
            if (record && record.trashedAt == null) {
              applyNoteRecordToStore({ ...record, id: initialNoteId });
              stashPreloadedNoteRecord(record);
              selectStartupNote(initialNoteId);
              return;
            }
          } catch {
            // Fall back below if the explicit initial note no longer exists.
          }
        }
      }

      if (cancelled || didInitializeStartupSelectionRef.current) {
        return;
      }

      availableNotes = store.get(activeNotesAtom);
      if (availableNotes.length === 0) {
        didInitializeStartupSelectionRef.current = true;
        return;
      }

      const lastViewedNoteId = store.get(lastViewedNoteIdAtom);
      const targetNoteId =
        lastViewedNoteId && availableNotes.some((note) => note.id === lastViewedNoteId)
          ? lastViewedNoteId
          : availableNotes[0].id;

      selectStartupNote(targetNoteId);
    };

    void initializeStartupSelection();

    return () => {
      cancelled = true;
    };
  }, [
    applyNoteRecordToStore,
    hasElectronBridge,
    notesHydrated,
    navigateToNote,
    store,
    windowContext,
    windowContextReady
  ]);

  const runSerializedNoteSwitch = useCallback((task: () => Promise<void>) => {
    noteSwitchQueueRef.current = noteSwitchQueueRef.current.then(task, task);
    return noteSwitchQueueRef.current;
  }, []);

  const flushBeforeNoteSwitch = useCallback(async (): Promise<boolean> => {
    try {
      await canvasRef.current?.flushAndWait();
      return true;
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Could not save the current note before switching.';
      showOperationFailure(message);
      return false;
    }
  }, [showOperationFailure]);

  const handlePanelViewChange = useCallback(
    (nextView: AppMode) => {
      void runSerializedNoteSwitch(async () => {
        const currentAppMode = appModeRef.current;
        if (nextView === currentAppMode) {
          return;
        }
        const currentActiveNoteId = store.get(activeNoteIdAtom);
        const currentSortedNotes = store.get(activeNotesAtom);
        const currentTrashedNotes = store.get(trashedNotesEntityAtom);

        // Save current selection when switching between notes/trash
        if (nextView === 'trash' && currentAppMode === 'notes') {
          if (currentActiveNoteId && currentSortedNotes.some((note) => note.id === currentActiveNoteId)) {
            viewSelectionRef.current.notes = currentActiveNoteId;
          }
        } else if (nextView === 'notes' && currentAppMode === 'trash') {
          if (currentActiveNoteId && currentTrashedNotes.some((note) => note.id === currentActiveNoteId)) {
            viewSelectionRef.current.trash = currentActiveNoteId;
          }
        }

        // Compute target selection for the target view
        const targetCollection = nextView === 'trash' ? currentTrashedNotes : currentSortedNotes;
        const viewKey = nextView === 'trash' ? 'trash' : 'notes';
        const storedSelection = viewSelectionRef.current[viewKey];

        const targetNoteId =
          storedSelection && targetCollection.some((n) => n.id === storedSelection)
            ? storedSelection
            : targetCollection[0]?.id ?? null;

        if (targetNoteId !== currentActiveNoteId) {
          const [canSwitch] = await Promise.all([
            flushBeforeNoteSwitch(),
            targetNoteId ? prefetchNoteRecord(targetNoteId) : Promise.resolve()
          ]);
          if (!canSwitch) {
            return;
          }
        }

        setAppMode(nextView);

        // Set selection immediately when switching views
        // No swap needed - activeActionTabsAtom auto-derives from activeNoteId
        if (targetNoteId !== currentActiveNoteId) {
          setActiveNoteId(targetNoteId);
        }
      });
    },
    [flushBeforeNoteSwitch, runSerializedNoteSwitch, setActiveNoteId, store]
  );

  const handleSelectNote = useCallback(
    (noteId: string, heading: string | null = null) => {
      void runSerializedNoteSwitch(async () => {
        // Selecting a note while the browser split fills the whole canvas
        // (full-pane: the note pane was closed and is not rendered) must dismiss
        // the browser so the chosen note becomes visible; otherwise the canvas
        // keeps showing the browser and the note is unreachable. Side-by-side
        // browser splits keep their browser (the left note pane still renders the
        // new selection).
        if (store.get(browserSplitFullPaneAtom)) {
          store.set(closeBrowserSplitAtom);
        }
        const currentNoteId = store.get(activeNoteIdAtom);
        const targetEntity = store.get(noteEntityAtom(noteId));
        const targetView: AppMode = targetEntity?.trashedAt != null ? 'trash' : 'notes';
        const currentView = appModeRef.current;
        const isSplit = store.get(isSplitOpenAtom);
        const focused = store.get(focusedPaneAtom);

        // Right-pane path: route to split navigation when right pane is focused
        if (isSplit && focused === 'right') {
          const splitNoteId = store.get(splitTabNoteIdAtom);
          if (splitNoteId === noteId && !heading) return; // already showing this note location

          // If clicking the same note as the left pane, close the split instead
          if (currentNoteId === noteId) {
            store.set(closeSplitTabAtom);
            return;
          }

          await splitRightPaneRef.current?.flushAndWait();
          store.set(splitNavigateToNoteAtom, noteId, heading);
          return;
        }

        // Left-pane path (default): existing behavior
        if (currentNoteId === noteId && targetView === currentView && !heading) {
          return;
        }

        // Auto-close split if navigating to the same note shown in the split pane
        const splitNoteId = store.get(splitTabNoteIdAtom);
        if (splitNoteId === noteId) {
          store.set(closeSplitTabAtom);
        }

        if (targetView !== currentView) {
          const currentSortedNotes = store.get(activeNotesAtom);
          const currentTrashedNotes = store.get(trashedNotesEntityAtom);

          // Preserve the user's selection in the view we're leaving.
          if (currentView === 'notes') {
            if (currentNoteId && currentSortedNotes.some((note) => note.id === currentNoteId)) {
              viewSelectionRef.current.notes = currentNoteId;
            }
          } else if (currentView === 'trash') {
            if (currentNoteId && currentTrashedNotes.some((note) => note.id === currentNoteId)) {
              viewSelectionRef.current.trash = currentNoteId;
            }
          }
        }

        if (currentNoteId !== noteId) {
          const [canSwitch] = await Promise.all([
            flushBeforeNoteSwitch(),
            prefetchNoteRecord(noteId)
          ]);
          if (!canSwitch) {
            return;
          }
        }

        setAppMode(targetView);
        viewSelectionRef.current[targetView] = noteId;
        navigateToNote(noteId, heading);
        // No swap needed - activeActionTabsAtom auto-derives from activeNoteId
      });
    },
    [flushBeforeNoteSwitch, navigateToNote, runSerializedNoteSwitch, store]
  );

  const handleCloseSplitPane = useCallback(
    (paneId: 'left' | 'right') => {
      if (store.get(isBrowserSplitOpenAtom)) {
        if (paneId === 'right') {
          store.set(closeSplitPaneAtom, 'right');
          return;
        }

        void runSerializedNoteSwitch(async () => {
          const currentNoteId = store.get(activeNoteIdAtom);
          if (!currentNoteId) {
            return;
          }

          const canSwitch = await flushBeforeNoteSwitch();
          if (!canSwitch) {
            return;
          }

          store.set(promoteBrowserSplitToFullPaneAtom);
        });
        return;
      }
      if (paneId === 'right') {
        store.set(closeSplitPaneAtom, 'right');
        return;
      }

      void runSerializedNoteSwitch(async () => {
        const splitNoteId = store.get(splitTabNoteIdAtom);
        if (!splitNoteId) {
          return;
        }

        const canSwitch = await flushBeforeNoteSwitch();
        if (!canSwitch) {
          return;
        }

        try {
          await splitRightPaneRef.current?.flushAndWait();
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : 'Could not save the split note before closing.';
          showOperationFailure(message);
          return;
        }

        await prefetchNoteRecord(splitNoteId);

        const targetEntity = store.get(noteEntityAtom(splitNoteId));
        const targetView: AppMode = targetEntity?.trashedAt != null ? 'trash' : 'notes';
        setAppMode(targetView);
        viewSelectionRef.current[targetView] = splitNoteId;
        store.set(closeSplitPaneAtom, 'left');
        navigateToNote(splitNoteId);
      });
    },
    [flushBeforeNoteSwitch, navigateToNote, runSerializedNoteSwitch, showOperationFailure, store]
  );

  const waitForNextPaint = useCallback(async (frames = 2): Promise<void> => {
    if (typeof window === 'undefined') {
      return;
    }

    for (let index = 0; index < frames; index += 1) {
      if (document.visibilityState === 'hidden') {
        // Electron throttles requestAnimationFrame for background windows. The
        // automation controller still needs to let React and queued DOM work
        // settle without bringing the QA app to the foreground.
        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 0);
        });
        continue;
      }
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      });
    }
  }, []);

  const getAutomationState = useCallback((): RendererAutomationState => {
    const currentActiveNoteId = store.get(activeNoteIdAtom);
    const currentSplitNoteId = store.get(splitTabNoteIdAtom);
    const currentActiveNote = currentActiveNoteId ? store.get(noteEntityAtom(currentActiveNoteId)) : null;
    const currentSplitNote = currentSplitNoteId ? store.get(noteEntityAtom(currentSplitNoteId)) : null;

    return {
      activeNoteId: currentActiveNoteId,
      activeNoteTitle: currentActiveNote?.title ?? null,
      splitNoteId: currentSplitNoteId,
      splitNoteTitle: currentSplitNote?.title ?? null,
      isSplitOpen: currentSplitNoteId !== null,
      focusedPane: store.get(focusedPaneAtom),
      visibilityState: typeof document === 'undefined' ? null : document.visibilityState,
    };
  }, [store]);

  const resolveAutomationNote = useCallback((input: { noteId?: string; title?: string }): NoteEntity | null => {
    const noteId = input.noteId?.trim();
    if (noteId) {
      const materializedNoteId =
        automationMaterializedNoteIdsRef.current.get(noteId) ?? noteId;
      return store.get(noteEntityAtom(materializedNoteId)) ?? null;
    }

    const title = input.title?.trim();
    if (!title) {
      return null;
    }

    const normalizedTitle = title.toLocaleLowerCase();
    const noteEntities = Array.from(store.get(noteIdsAtom))
      .map((id) => store.get(noteEntityAtom(id)))
      .filter((note): note is NoteEntity => note != null && note.trashedAt == null);

    return (
      noteEntities.find((note) => note.title === title) ??
      noteEntities.find((note) => note.title.trim().toLocaleLowerCase() === normalizedTitle) ??
      noteEntities.find((note) => note.title.trim().toLocaleLowerCase().startsWith(normalizedTitle)) ??
      null
    );
  }, [store]);

  const getAutomationPaneHandle = useCallback((pane?: AutomationPane): CanvasAreaContentHandle | null => {
    const resolvedPane = pane ?? (store.get(isSplitOpenAtom) ? store.get(focusedPaneAtom) : 'left');
    if (resolvedPane === 'right') {
      return store.get(isSplitOpenAtom) ? splitRightPaneRef.current : null;
    }
    return canvasRef.current;
  }, [store]);

  useEffect(() => {
    if (typeof window === 'undefined' || !hasElectronBridge) {
      return;
    }
    // Gate the controller to automation-enabled launches only. The
    // preload mirrors `MOSS_AUTOMATION === '1'` from the main process.
    if (window.__MOSS_AUTOMATION_ENABLED__ !== true || !notesHydrated) {
      return;
    }

    const buildResult = (ok: boolean, reason?: string, data?: unknown): RendererAutomationResult => ({
      ok,
      state: getAutomationState(),
      ...(reason ? { reason } : {}),
      ...(data === undefined ? {} : { data }),
    });

    const controller: MossAutomationController = {
      getState: getAutomationState,
      run: async (command: RendererAutomationCommand): Promise<RendererAutomationResult> => {
        try {
          switch (command.type) {
            case 'getState':
              return buildResult(true);
            case 'openNote': {
              const target = resolveAutomationNote(command);
              if (!target) {
                return buildResult(false, 'Note not found');
              }

              store.set(setFocusPaneAtom, 'left');
              handleSelectNote(target.id);
              await noteSwitchQueueRef.current;
              await waitForNextPaint();
              return store.get(activeNoteIdAtom) === target.id
                ? buildResult(true)
                : buildResult(false, 'Failed to open note');
            }
            case 'openSplit': {
              const target = resolveAutomationNote(command);
              if (!target) {
                return buildResult(false, 'Note not found');
              }

              const currentActiveNoteId = store.get(activeNoteIdAtom);
              if (currentActiveNoteId === target.id) {
                return buildResult(false, 'Target note is already open in the left pane');
              }

              await runSerializedNoteSwitch(async () => {
                const currentSplitNoteId = store.get(splitTabNoteIdAtom);
                if (currentSplitNoteId === target.id) {
                  store.set(setFocusPaneAtom, command.focusPane ?? 'right');
                  return;
                }

                const [canSwitch] = await Promise.all([
                  flushBeforeNoteSwitch(),
                  prefetchNoteRecord(target.id),
                ]);
                if (!canSwitch) {
                  return;
                }

                if (store.get(isSplitOpenAtom)) {
                  await splitRightPaneRef.current?.flushAndWait();
                  store.set(splitNavigateToNoteAtom, target.id);
                } else {
                  store.set(openSplitTabAtom, target.id);
                }
                store.set(setFocusPaneAtom, command.focusPane ?? 'right');
              });

              await noteSwitchQueueRef.current;
              await waitForNextPaint();
              return store.get(splitTabNoteIdAtom) === target.id
                ? buildResult(true)
                : buildResult(false, 'Failed to open split note');
            }
            case 'closeSplit':
              store.set(closeSplitTabAtom);
              await waitForNextPaint(1);
              return buildResult(true);
            case 'focusPane':
              if (command.pane === 'right' && !store.get(isSplitOpenAtom)) {
                return buildResult(false, 'Split pane is not open');
              }
              store.set(setFocusPaneAtom, command.pane);
              await waitForNextPaint(1);
              return buildResult(true);
            case 'scrollToHeading': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const ok = handle.scrollToHeading(command.heading);
              return ok ? buildResult(true) : buildResult(false, 'Heading not found');
            }
            case 'selectTab': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const ok = await handle.selectTab(command.label);
              if (ok) {
                await waitForNextPaint(2);
              }
              return ok
                ? buildResult(true)
                : buildResult(false, `Failed to select tab "${command.label}"`);
            }
            case 'setHeadingCollapsed': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const ok = await handle.setHeadingCollapsed(command.heading, command.collapsed);
              if (ok) {
                await waitForNextPaint(2);
              }
              return ok
                ? buildResult(true)
                : buildResult(false, `Failed to set collapse state for heading "${command.heading}"`);
            }
            case 'createPdfExportSession': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const sessionId = await handle.createPdfExportSession();
              if (!sessionId) {
                return buildResult(false, 'Failed to prepare PDF export session');
              }
              return buildResult(true, undefined, { sessionId });
            }
            case 'openPdfPreview': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const sessionId = await handle.createPdfExportSession();
              if (!sessionId) {
                return buildResult(false, 'Failed to prepare PDF preview session');
              }
              const previewWindowId = await notesApi.openPdfExportPreview.invoke(sessionId);
              if (previewWindowId === null) {
                return buildResult(false, 'Failed to open PDF preview window');
              }
              await waitForNextPaint(2);
              return buildResult(true);
            }
            case 'openPdfRenderSurface': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
                await waitForNextPaint(1);
              }
              const sessionId = await handle.createPdfExportSession();
              if (!sessionId) {
                return buildResult(false, 'Failed to prepare PDF render surface session');
              }
              const previewWindowId = await notesApi.openPdfExportRenderSurface.invoke(sessionId);
              if (previewWindowId === null) {
                return buildResult(false, 'Failed to open PDF render surface window');
              }
              await waitForNextPaint(2);
              return buildResult(true);
            }
            case 'forceReloadFromDisk': {
              const handle = getAutomationPaneHandle(command.pane);
              if (!handle) {
                return buildResult(false, 'Target pane is not available');
              }
              if (command.pane) {
                store.set(setFocusPaneAtom, command.pane);
              }
              const ok = await handle.forceReloadFromDisk();
              if (ok) {
                await waitForNextPaint();
              }
              return ok ? buildResult(true) : buildResult(false, 'Failed to reload note from disk');
            }
            case 'enableSnapshotMode': {
              enableSnapshotMode(command.fixture);
              return buildResult(true);
            }
            case 'disableSnapshotMode': {
              automationFixtureNotesActiveRef.current = false;
              setAutomationUiFixture(null);
              disableSnapshotMode();
              return buildResult(true);
            }
            case 'waitForCodeblocksReady': {
              const ok = await waitForCodeblocksReady(command.timeoutMs);
              return ok
                ? buildResult(true)
                : buildResult(false, 'codeblock-ready wait timed out');
            }
            case 'seedFixtureNotes': {
              automationFixtureNotesActiveRef.current = true;
              setAutomationUiFixture(null);
              const materializedNotes: Array<{
                note: (typeof command.notes)[number];
                noteId: string;
              }> = [];
              try {
                for (const note of command.notes) {
                  let noteId =
                    automationMaterializedNoteIdsRef.current.get(note.id) ?? null;

                  if (hasElectronBridge) {
                    let record: NoteWithContent | undefined;
                    if (noteId) {
                      record = await notesApi.getById
                        .invoke(noteId, { skipAnalytics: true })
                        .catch(() => undefined);
                    }

                    if (!record) {
                      record = await notesApi.create.invoke(note.title, note.folderPath);
                      noteId = record.id;
                      automationMaterializedNoteIdsRef.current.set(note.id, noteId);
                    }

                    if (!noteId) {
                      throw new Error(`No materialized id for fixture note "${note.title}"`);
                    }

                    await notesApi.update.invoke(noteId, {
                      title: note.title,
                      content: note.content,
                      updatedAt: note.updatedAt,
                      trashedAt: note.trashedAt ?? null,
                    });
                  }

                  materializedNotes.push({ note, noteId: noteId ?? note.id });
                }
              } catch (error) {
                return buildResult(
                  false,
                  `Failed to materialize fixture notes: ${
                    error instanceof Error ? error.message : 'Unknown error'
                  }`
                );
              }

              const applySeededNotes = () => {
                const seededIds = new Set<string>();
                for (const { note, noteId } of materializedNotes) {
                  const createdAt = note.createdAt ?? note.updatedAt;
                  const contentType = note.contentType ?? 'medium-text';
                  const entity: NoteEntity = {
                    id: noteId,
                    title: note.title,
                    createdAt,
                    updatedAt: note.updatedAt,
                    trashedAt: note.trashedAt ?? null,
                    lastOpenedAt: note.updatedAt,
                    folderPath: note.folderPath,
                    contentType,
                    pinned: note.pinned,
                    pinnedAt: note.pinned ? note.updatedAt : null,
                    links: { outgoing: [], incoming: [] },
                  };

                  seededIds.add(noteId);
                  store.set(noteEntityAtom(noteId), entity);
                  store.set(noteActionTabsAtom(noteId), []);
                  store.set(noteExpandedActionTabIdsAtom(noteId), new Set());
                  stashPreloadedNoteRecord({
                    ...entity,
                    stickyTabs: [],
                    content: note.content,
                  });
                }

                store.set(noteIdsAtom, seededIds);
                store.set(notesHydratedAtom, true);
                setBackendFolders([]);
                store.set(activeFolderPathAtom, 'Notes');
                store.set(expandedFoldersAtom, new Set([
                  'Notes/Fixture',
                  'Notes/Fixture/Code',
                  'Notes/Fixture/Media',
                  'Notes/Research',
                ]));
                store.set(actionsPanelActiveTabAtom, 'actions');
                store.set(closeSplitTabAtom);
                setActionsPanelHidden(false);
                setNotesPanelHidden(false);
                setSettingsModalOpen(false);
                setFeedbackDialogOpen(false);
                setShowCommandPalette(false);
                store.set(activeNoteIdAtom, materializedNotes[0]?.noteId ?? null);
              };

              applySeededNotes();
              await new Promise((resolve) => window.setTimeout(resolve, 750));
              applySeededNotes();
              await waitForNextPaint(2);
              return buildResult(true);
            }
            case 'seedFixtureActionTabs': {
              const noteId = command.noteId
                ? automationMaterializedNoteIdsRef.current.get(command.noteId) ?? command.noteId
                : store.get(activeNoteIdAtom);
              if (!noteId) {
                return buildResult(false, 'No active note available for action tabs');
              }
              const tabs = createSnapshotActionTabs(command.kind);
              store.set(noteActionTabsAtom(noteId), tabs);
              store.set(
                noteExpandedActionTabIdsAtom(noteId),
                command.expanded === false
                  ? new Set()
                  : new Set(tabs.map((tab) => tab.id))
              );
              store.set(activeNoteIdAtom, noteId);
              store.set(setFocusPaneAtom, 'left');
              store.set(actionsPanelActiveTabAtom, 'actions');
              setAutomationUiFixture(null);
              setActionsPanelHidden(false);
              await waitForNextPaint(2);
              return buildResult(true);
            }
            case 'setSettingsModalOpen':
              setAutomationUiFixture(null);
              setSettingsModalOpen(command.open);
              await waitForNextPaint(2);
              return buildResult(true);
            case 'setFeedbackDialogOpen':
              setAutomationUiFixture(null);
              setFeedbackDialogOpen(command.open);
              await waitForNextPaint(2);
              return buildResult(true);
            case 'setCommandPaletteOpen':
              setAutomationUiFixture(null);
              if (command.open) {
                store.set(commandPaletteOriginAtom, 'toolbar');
              }
              setShowCommandPalette(command.open);
              await waitForNextPaint(2);
              return buildResult(true);
            case 'setAppMode':
              setAutomationUiFixture(null);
              setSettingsModalOpen(false);
              setFeedbackDialogOpen(false);
              setShowCommandPalette(false);
              setActionsPanelHidden(false);
              setNotesPanelHidden(false);
              setAppMode(command.mode);
              await waitForNextPaint(2);
              return buildResult(true);
            case 'setSnapshotUiFixture':
              setSettingsModalOpen(false);
              setFeedbackDialogOpen(false);
              setShowCommandPalette(false);
              setAutomationUiFixture(command.fixture);
              await waitForNextPaint(2);
              return buildResult(true);
            default:
              return buildResult(false, 'Unsupported automation command');
          }
        } catch (error) {
          return buildResult(
            false,
            error instanceof Error ? error.message : 'Unknown automation error'
          );
        }
      },
    };

    window.__MOSS_AUTOMATION__ = controller;
    return () => {
      // During automation, note fixture commands intentionally churn atoms that
      // recreate controller dependencies. Keep the previous controller alive
      // until the next effect commit so the harness never observes a transient
      // "controller unavailable" gap between screens.
      if (
        window.__MOSS_AUTOMATION_ENABLED__ !== true &&
        window.__MOSS_AUTOMATION__ === controller
      ) {
        delete window.__MOSS_AUTOMATION__;
      }
    };
  }, [
    closeSplitTabAtom,
    flushBeforeNoteSwitch,
    getAutomationPaneHandle,
    getAutomationState,
    handleSelectNote,
    hasElectronBridge,
    notesHydrated,
    openSplitTabAtom,
    resolveAutomationNote,
    runSerializedNoteSwitch,
    setActionsPanelHidden,
    setBackendFolders,
    setNotesPanelHidden,
    setShowCommandPalette,
    store,
    waitForNextPaint,
  ]);

  // Listen for external .md file open events from main process.
  // Route through the same serialized note-switch path used by in-app navigation
  // so pending edits are flushed before selecting the external note.
  useEffect(() => {
    if (!hasElectronBridge) return;
    const cleanup = window.electronAPI.notes.onExternalFileOpen((noteId) => {
      void runSerializedNoteSwitch(async () => {
        try {
          // Fetch only the single note instead of re-hydrating the entire list
          const record = await window.electronAPI.notes.getById(noteId);
          if (record) {
            applyNoteRecordToStore({ ...record, id: noteId });
            stashPreloadedNoteRecord(record);
          } else {
            // Fallback: note not found by ID, do full hydration
            await store.set(hydrateNotesAtom);
          }

          // Refresh folder list so the External system folder is available
          // before the sidebar re-renders. cleanupEmpty: false avoids disk I/O.
          try {
            const folders = await foldersApi.list.invoke({ cleanupEmpty: false });
            setBackendFolders(
              folders.map((folder) => ({
                name: folder.name,
                path: folder.path,
                noteCount: folder.noteCount,
                createdAt: folder.createdAt ?? 0,
                type: folder.type
              }))
            );
            lastFolderRefreshKeyRef.current = appModeRef.current;
          } catch (error) {
            console.warn('[external-file] Failed to refresh folders:', error);
          }

          const currentNoteId = store.get(activeNoteIdAtom);
          if (currentNoteId !== noteId) {
            const canSwitch = await flushBeforeNoteSwitch();
            if (canSwitch) {
              navigateToNote(noteId);
            }
          }

          // Expand the External folder tree to reveal the note — runs
          // unconditionally so re-opening an already-active note still works
          const entity = store.get(noteEntityAtom(noteId));
          const externalFolder = store.get(externalFolderAtom);
          const externalNotes = externalFolder
            ? store.get(notesByFolderAtom).get(externalFolder.path) ?? []
            : [];
          const rootPath = resolveExternalFolderRevealPath(externalNotes, noteId)
            ?? entity?.externalRootPath
            ?? entity?.externalFilePath?.replace(/\/[^/]+$/, '');
          if (rootPath) {
            store.set(externalFolderNavigateAtom, rootPath);
          }
        } catch (error) {
          console.error('[external-file] Failed to open:', error);
        }
      });
    });
    return cleanup;
  }, [applyNoteRecordToStore, flushBeforeNoteSwitch, hasElectronBridge, navigateToNote, runSerializedNoteSwitch, setBackendFolders, store]);

  // Listen for workspace-local .md file open events from the main process. These
  // are real internal notes (the OS/default-editor opened a file under
  // ~/Moss/Notes/**), so route through the standard internal note-switch path —
  // NOT the External-specific behavior above — and reveal the note in its real
  // workspace folder rather than under the External section.
  useEffect(() => {
    if (!hasElectronBridge) return;
    const subscribe = window.electronAPI.notes.onInternalFileOpen;
    if (typeof subscribe !== 'function') return;
    const cleanup = subscribe((noteId) => {
      void runSerializedNoteSwitch(async () => {
        try {
          const record = await window.electronAPI.notes.getById(noteId);
          if (record) {
            applyNoteRecordToStore({ ...record, id: noteId });
            stashPreloadedNoteRecord(record);
          } else {
            // Fallback: note not found by ID (e.g. just adopted), do full hydration
            await store.set(hydrateNotesAtom);
          }

          // navigateToNote selects the note and sets the active folder to its real
          // workspace folderPath, revealing it in the sidebar. Runs unconditionally
          // so re-opening an already-active note still reveals it.
          const currentNoteId = store.get(activeNoteIdAtom);
          if (currentNoteId !== noteId) {
            const canSwitch = await flushBeforeNoteSwitch();
            if (!canSwitch) return;
          }
          navigateToNote(noteId);
        } catch (error) {
          console.error('[open-file] Failed to open internal note:', error);
        }
      });
    });
    return cleanup;
  }, [applyNoteRecordToStore, flushBeforeNoteSwitch, hasElectronBridge, navigateToNote, runSerializedNoteSwitch, store]);

  const insertNote = useCallback(
    (note: MockNote) => {
      // Update noteEntityAtom (source of truth)
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
      store.set(noteIdsAtom, (prev) => new Set(prev).add(note.id));
    },
    [store]
  );

  const cacheTabDetails = useCallback((entries: ActionTabEntry[]) => {
    entries.forEach((entry) => {
      const hasTodos = entry.todos.length > 0;
      const hasChanges = entry.changes.length > 0;
      if (hasTodos || hasChanges) {
        tabDetailsCacheRef.current[entry.id] = {
          todos: hasTodos ? cloneTodos(entry.todos) : undefined,
          changes: hasChanges ? cloneChanges(entry.changes) : undefined
        };
        return;
      }

      delete tabDetailsCacheRef.current[entry.id];
    });
  }, []);

  const mergeCachedDetails = useCallback(
    (entries: ActionTabEntry[]): ActionTabEntry[] =>
      entries.map((entry) => {
        const cached = tabDetailsCacheRef.current[entry.id];
        if (!cached) {
          return entry;
        }

        return {
          ...entry,
          todos: entry.todos.length > 0 ? entry.todos : cloneTodos(cached.todos),
          changes: entry.changes.length > 0 ? entry.changes : cloneChanges(cached.changes)
        };
      }),
    []
  );

  /**
   * Updates action tabs for a specific note using the atomFamily pattern.
   * Each note has its own isolated atom - no more swap/cache logic needed.
   */
  const setActionTabsForNote = useCallback(
    (
      noteId: string,
      nextTabs: ActionTabEntry[] | ((previous: ActionTabEntry[]) => ActionTabEntry[])
    ): ActionTabEntry[] => {
      // Get the atom for this specific note
      const noteTabsAtom = noteActionTabsAtom(noteId);
      const previousTabs = store.get(noteTabsAtom);
      const resolvedTabs = typeof nextTabs === 'function' ? nextTabs(previousTabs) : nextTabs;

      // Clean up tab details cache for removed tabs
      previousTabs.forEach((tab) => {
        if (!resolvedTabs.some((entry) => entry.id === tab.id)) {
          delete tabDetailsCacheRef.current[tab.id];
        }
      });

      cacheTabDetails(resolvedTabs);

      // Update the note-specific atom directly
      store.set(noteTabsAtom, resolvedTabs);

      return resolvedTabs;
    },
    [store, cacheTabDetails]
  );

  const syncActionTabsFromRecords = useCallback(
    (noteId: string, records: ActionTabRecord[]): ActionTabEntry[] => {
      // Read current tabs from the note-specific atom
      const noteTabsAtom = noteActionTabsAtom(noteId);
      const currentTabs = store.get(noteTabsAtom);

      // Identify tabs that are actively streaming - these should be preserved
      const streamingTabsMap = new Map<string, ActionTabEntry>();
      for (const tab of currentTabs) {
        if (tab.isStreaming || tab.status === 'pending') {
          streamingTabsMap.set(tab.id, tab);
        }
      }

      const mapped = mergeCachedDetails(records.map(mapActionTabRecordToEntry));

      // Merge: for streaming tabs, preserve streaming state over backend data
      // Build a map of ALL current tabs for preserving promptMentions
      const currentTabsMap = new Map<string, ActionTabEntry>();
      for (const tab of currentTabs) {
        currentTabsMap.set(tab.id, tab);
      }

      const mergedTabs = mapped.map((tab) => {
        const currentTab = currentTabsMap.get(tab.id);
        const streamingTab = streamingTabsMap.get(tab.id);
        // Preserve renderer-only receipt fields and retry inputs from in-memory
        // state. Backend records can lag the optimistic tab immediately after
        // submission, and retry inputs are not persisted.
        const mergedWithMentions: ActionTabEntry = {
          ...tab,
          promptMentions: currentTab?.promptMentions ?? tab.promptMentions,
          contextMentions: currentTab?.contextMentions ?? tab.contextMentions,
          commentContext: currentTab?.commentContext ?? tab.commentContext,
          imageUrls: currentTab?.imageUrls ?? tab.imageUrls,
          retryInputs: currentTab?.retryInputs ?? tab.retryInputs
        };

        if (streamingTab) {
          return {
            ...mergedWithMentions,
            // Preserve streaming state from current atom
            isStreaming: streamingTab.isStreaming,
            streamingText: streamingTab.streamingText,
            messages: streamingTab.messages,
            activeTools: streamingTab.activeTools,
            lastToolName: streamingTab.lastToolName,
            streamError: streamingTab.streamError,
            metrics: mergeActionTabMetrics(tab.metrics, streamingTab.metrics),
            status: streamingTab.isStreaming ? streamingTab.status : tab.status,
            syntheticAck: streamingTab.syntheticAck ?? tab.syntheticAck
          };
        }
        return mergedWithMentions;
      });

      const tabsWithDraft = mergedTabs.length > 0 ? ensureDraftActionExists(mergedTabs) : [createDraftActionEntry()];
      setActionTabsForNote(noteId, tabsWithDraft);
      return tabsWithDraft;
    },
    [store, mergeCachedDetails, setActionTabsForNote]
  );

  const persistActionTabs = useCallback(
    async (noteId: string, tabs: ActionTabEntry[]): Promise<void> => {
      if (!hasElectronBridge) {
        return;
      }

      const timestamp = nowInSeconds();
      canvasRef.current?.expectStickyTabMetadataUpdate(timestamp);
      const stickyTabsPayload = tabs.map(mapActionTabEntryToRecord);
      notesApi.update.reset?.();

      try {
        const updated = await notesApi.update.invoke(noteId, {
          stickyTabs: stickyTabsPayload,
          updatedAt: timestamp
        });

        if (updated?.stickyTabs) {
          syncActionTabsFromRecords(noteId, updated.stickyTabs);
        }

        if (updated) {
          canvasRef.current?.expectStickyTabMetadataUpdate(updated.updatedAt);
          // Update noteEntityAtom (source of truth)
          store.set(syncNoteEntityAtom, {
            noteId: updated.id,
            updates: { updatedAt: updated.updatedAt }
          });
        }
      } catch (error) {
        if (isRendererDevelopment()) {
          console.error('Failed to persist sticky tabs', error);
        }
      }
    },
    [hasElectronBridge, store, syncActionTabsFromRecords]
  );


  const applyExecuteErrorState = useCallback(
    (noteId: string, tabId: string, error: unknown) => {
      const message = normalizeAgentExecuteErrorMessage(error);
      const fallbackClassification = classifyNormalizedAgentExecuteErrorMessage(message);
      const updatedTabs = setActionTabsForNote(noteId, (prev) =>
        prev.map((entry) => {
          // Don't override interrupted status with error - interrupt takes precedence
          if (entry.id === tabId && entry.status !== 'interrupted') {
            return updateActionTabEntry(entry, {
              status: 'error' as const,
              errorMessage: message,
              streamError: entry.streamError ?? (fallbackClassification
                ? {
                    code: 'SDK_ERROR',
                    message,
                    classification: fallbackClassification,
                    retryable: false,
                    severity: 'error' as const
                  }
                : null),
              metrics: mergeActionTabMetrics(entry.metrics, {
                stage: {
                  executionCompletedAtMs: Date.now()
                }
              })
            });
          }
          return entry;
        })
      );
      persistActionTabs(noteId, updatedTabs);

      return message;
    },
    [persistActionTabs, setActionTabsForNote]
  );

  const createAndActivateNote = useCallback(async ({ focusTarget }: { focusTarget: 'title' | 'body' }): Promise<MockNote | null> => {
    if (appModeRef.current !== 'notes') {
      return null;
    }

    // Always create regular notes in a non-system folder.
    // If the active folder is a system folder, fall back to root.
    const folders = store.get(backendFoldersAtom);
    const isBlockedSystemFolder = folders.some(
      (f) => f.path === activeFolderPath && f.type === 'system'
    );
    const targetFolderPath = isBlockedSystemFolder ? 'Notes' : activeFolderPath;

    const finishCreation = (note: MockNote, preloadedRecord?: NoteWithContent): MockNote => {
      insertNote(note);
      if (preloadedRecord) {
        stashPreloadedNoteRecord(preloadedRecord);
      }
      navigateToNote(note.id);
      if (focusTarget === 'title') {
        setTitleFocusNoteId(note.id);
      } else {
        setShouldFocusBody(true);
      }
      // Initialize with empty array - no draft tabs needed
      setActionTabsForNote(note.id, []);
      viewSelectionRef.current.notes = note.id;
      setAppMode('notes');
      return note;
    };

    if (!hasElectronBridge) {
      return finishCreation({
        id: generateId(),
        title: 'Untitled',
        updatedAt: Math.floor(Date.now() / 1000),
        folderPath: targetFolderPath,
        trashedAt: null
      });
    }

    try {
      notesApi.create.reset?.();
      // Pass the active folder path to create the note in the correct location
      const record = await notesApi.create.invoke('Untitled', targetFolderPath);
      if (record) {
        const note = finishCreation(mapRecordToMockNote(record), record);
        applyNoteRecordToStore(record);
        return note;
      }
      console.warn('[note-integrity] Skipping local note creation because backend returned no record', {
        targetFolderPath
      });
      showOperationFailure('Could not create note. Try again.');
      await reconcileNotesFromDisk('create-empty-response');
      return null;
    } catch (error) {
      console.warn('[note-integrity] Skipping local note creation because backend create threw', {
        targetFolderPath,
        error
      });
      showOperationFailure('Could not create note. Try again.');
      await reconcileNotesFromDisk('create-error');
      return null;
    }
  }, [
    activeFolderPath,
    applyNoteRecordToStore,
    hasElectronBridge,
    insertNote,
    navigateToNote,
    reconcileNotesFromDisk,
    setActionTabsForNote,
    showOperationFailure,
    store
  ]);

  const handleCreateNote = useCallback(async () => {
    // moss-multi seam: new-note (A§9, R2): the trigger lets go of focus, and keys typed before the note binds are
    // refused visibly rather than lost or pressing "+ Note" again.
    const opening = armOpeningGuard();
    const canSwitch = await flushBeforeNoteSwitch();
    if (!canSwitch) {
      opening.disarm();
      return;
    }
    if (await createAndActivateNote({ focusTarget: 'title' })) opening.created();
    else opening.disarm();
  }, [createAndActivateNote, flushBeforeNoteSwitch]);

  const handleDuplicateNote = useCallback(async (noteId: string) => {
    const canSwitch = await flushBeforeNoteSwitch();
    if (!canSwitch) return;

    const entity = store.get(noteEntityAtom(noteId));
    if (!entity) return;

    try {
      const persistedRecord = await duplicateNote(noteId);
      const note = mapRecordToMockNote(persistedRecord);
      insertNote(note);
      applyNoteRecordToStore(persistedRecord);
      setActiveNoteId(note.id);
      setActionTabsForNote(note.id, []);
      viewSelectionRef.current.notes = note.id;
      setAppMode('notes');
    } catch (error) {
      console.warn('[note-integrity] Failed to duplicate note', { noteId, error });
      showOperationFailure('Could not duplicate note. Try again.');
      await reconcileNotesFromDisk('duplicate-error');
    }
  }, [applyNoteRecordToStore, flushBeforeNoteSwitch, insertNote, reconcileNotesFromDisk, setActionTabsForNote, setActiveNoteId, showOperationFailure, store]);

  const handleGoBack = useCallback(() => {
    if (!canGoBack) {
      return;
    }
    void runSerializedNoteSwitch(async () => {
      const canSwitch = await flushBeforeNoteSwitch();
      if (!canSwitch) {
        return;
      }
      const hist = store.get(navigationHistoryAtom);
      const targetId = hist.stack[hist.index - 1];
      if (targetId) await prefetchNoteRecord(targetId);
      // Determine correct view before navigating
      if (targetId) {
        const targetEntity = store.get(noteEntityAtom(targetId));
        const targetView: AppMode = targetEntity?.trashedAt != null ? 'trash' : 'notes';
        setAppMode(targetView);
        viewSelectionRef.current[targetView] = targetId;
      }
      goBack();
    });
  }, [canGoBack, flushBeforeNoteSwitch, goBack, runSerializedNoteSwitch, store]);

  const handleGoForward = useCallback(() => {
    if (!canGoForward) {
      return;
    }
    void runSerializedNoteSwitch(async () => {
      const canSwitch = await flushBeforeNoteSwitch();
      if (!canSwitch) {
        return;
      }
      const hist = store.get(navigationHistoryAtom);
      const targetId = hist.stack[hist.index + 1];
      if (targetId) await prefetchNoteRecord(targetId);
      // Determine correct view before navigating
      if (targetId) {
        const targetEntity = store.get(noteEntityAtom(targetId));
        const targetView: AppMode = targetEntity?.trashedAt != null ? 'trash' : 'notes';
        setAppMode(targetView);
        viewSelectionRef.current[targetView] = targetId;
      }
      goForward();
    });
  }, [canGoForward, flushBeforeNoteSwitch, goForward, runSerializedNoteSwitch, store]);

  const handleNoteDeleted = useCallback(
    async (noteId: string) => {
      // Interrupt active agent if running on this note (renderer owns state)
      if (activeAgentNoteIds.has(noteId)) {
        // 1. Update atom state synchronously (authoritative)
        // This also removes from activeAgentNoteIdsAtom, enabling the race guard
        const interruptedTabs = store.set(interruptAgentForNoteAtom, {
          noteId,
          reason: 'trashed'
        });

        // 2. Persist to disk before continuing
        await persistActionTabs(noteId, interruptedTabs);

        // 3. Fire-and-forget cancel to main process (cleanup only)
        agentApi.cancel.invoke(noteId).catch(console.warn);
      }

      if (hasElectronBridge) {
        try {
          notesApi.delete.reset?.();
          const deleted = await notesApi.delete.invoke(noteId);
          if (!deleted) {
            console.warn('[note-integrity] Refusing to mark note trashed locally because backend delete failed', {
              noteId
            });
            showOperationFailure('Could not delete note. Try again.');
            await reconcileNotesFromDisk('delete-rejected', noteId);
            return;
          }
        } catch (error) {
          console.warn('[note-integrity] Refusing to mark note trashed locally because backend delete threw', {
            noteId,
            error
          });
          showOperationFailure('Could not delete note. Try again.');
          await reconcileNotesFromDisk('delete-error', noteId);
          return;
        }
      }

      const trashedTimestamp = Math.floor(Date.now() / 1000);

      // Update noteEntityAtom (source of truth)
      store.set(syncNoteEntityAtom, {
        noteId,
        updates: {
          trashedAt: trashedTimestamp,
          updatedAt: trashedTimestamp
        }
      });

      // Clean up tab details cache for this note's tabs
      const noteTabsAtom = noteActionTabsAtom(noteId);
      const noteTabs = store.get(noteTabsAtom);
      noteTabs.forEach((tab) => {
        delete tabDetailsCacheRef.current[tab.id];
      });
      // Note: We don't remove the atom from the family here as the note
      // is only trashed (not permanently deleted). The tabs may be needed
      // if the note is restored.

      viewSelectionRef.current.trash = noteId;
      if (viewSelectionRef.current.notes === noteId) {
        viewSelectionRef.current.notes = null;
      }

      // Close command palette if it was open for this note
      if (showCommandPalette) {
        setShowCommandPalette(false);
      }

      // Select adjacent note in the list (below the trashed note, or above if last)
      // Read active notes directly from the Jotai store for latest state
      const currentNotes = store.get(activeNotesAtom);
      const deletedIndex = currentNotes.findIndex((n) => n.id === noteId);
      let nextNoteId: string | null = null;
      if (deletedIndex >= 0 && currentNotes.length > 1) {
        // Prefer the note below; if last in list, take the one above
        const nextIndex = deletedIndex < currentNotes.length - 1 ? deletedIndex + 1 : deletedIndex - 1;
        nextNoteId = currentNotes[nextIndex]?.id ?? null;
      }

      if (nextNoteId) {
        await prefetchNoteRecord(nextNoteId);
        setActiveNoteId(nextNoteId);
        viewSelectionRef.current.notes = nextNoteId;
      } else {
        // No notes left — fall through to default
        setActiveNoteId(null);
      }

      // Set folder to match the next selected note (or default to root)
      if (store.get(activeNoteIdAtom) === noteId) {
        const nextFolder = nextNoteId
          ? store.get(noteEntityAtom(nextNoteId))?.folderPath ?? 'Notes'
          : 'Notes';
        setActiveFolderPath(nextFolder);
      }
    },
    [activeAgentNoteIds, hasElectronBridge, persistActionTabs, reconcileNotesFromDisk, setActiveNoteId, showOperationFailure, store, showCommandPalette, setShowCommandPalette, setActiveFolderPath]
  );

  const handleRenameNote = useCallback(
    (noteId: string) => {
      handleSelectNote(noteId);
      // moss-multi seam: the pane consumes this focus intent after first sync.
      setTitleFocusNoteId(noteId);
    },
    [handleSelectNote]
  );

  const handleNoteRestored = useCallback(
    async (noteId: string) => {
      let restoredRecord: NoteMetadataRecord | undefined;
      if (hasElectronBridge) {
        try {
          notesApi.restore.reset?.();
          restoredRecord = await notesApi.restore.invoke(noteId);
          if (!restoredRecord) {
            console.warn('[note-integrity] Refusing to restore note locally because backend restore returned no record', {
              noteId
            });
            showOperationFailure('Could not restore note. Try again.');
            await reconcileNotesFromDisk('restore-empty-response', noteId);
            return;
          }
        } catch (error) {
          console.warn('[note-integrity] Refusing to restore note locally because backend restore threw', {
            noteId,
            error
          });
          // moss-multi seam: a refused restore shows the server's sentence (T2.3s).
          showOperationFailure(error instanceof Error && error.message ? error.message : 'Could not restore note. Try again.');
          await reconcileNotesFromDisk('restore-error', noteId);
          return;
        }
      }

      const restoredTimestamp = restoredRecord?.updatedAt ?? Math.floor(Date.now() / 1000);
      // Use the folderPath from the restored record (which contains the correct location)
      // or fall back to "Notes" if not available
      const restoredFolderPath = restoredRecord?.folderPath ?? 'Notes';

      // Update noteEntityAtom (source of truth)
      store.set(syncNoteEntityAtom, {
        noteId,
        updates: {
          trashedAt: null,
          updatedAt: restoredTimestamp,
          folderPath: restoredFolderPath,
          ...(typeof restoredRecord?.contentPath === 'string' ? { contentPath: restoredRecord.contentPath } : {})
        }
      });

      if (viewSelectionRef.current.trash === noteId) {
        viewSelectionRef.current.trash = null;
      }
      viewSelectionRef.current.notes = noteId;
      setAppMode('notes');
      await prefetchNoteRecord(noteId);
      setActiveNoteId(noteId);
      // No swap needed - activeActionTabsAtom auto-derives from activeNoteId
    },
    [hasElectronBridge, reconcileNotesFromDisk, setActiveNoteId, showOperationFailure, store]
  );

  /**
   * Handles user clicking Stop button in ActionsPanel.
   * Interrupts the active agent session for the given note.
   */
  const handleUserCancel = useCallback(
    async (noteId: string) => {
      if (!uiAgentBusyNoteIds.has(noteId)) return;

      // 1. Update atom state synchronously
      const interruptedTabs = store.set(interruptAgentForNoteAtom, {
        noteId,
        reason: 'user-cancelled'
      });

      // 2. Persist to disk
      await persistActionTabs(noteId, interruptedTabs);

      // 3. Fire-and-forget cancel to main process.
      // The disk watcher will detect partial tool writes and reconcile.
      agentApi.cancel
        .invoke(noteId)
        .catch(console.warn);
    },
    [uiAgentBusyNoteIds, persistActionTabs, store]
  );

  const executeAgentForNote = useCallback(async ({
    noteId,
    prompt,
    rawPrompt,
    referencedNoteIds,
    referencedDirectories,
    promptMentions,
    contextMentions,
    commentContext,
    sourceCommentId,
    sourceCommentIds,
    sourceContextText,
    sourceContextIconUrl,
    imageUrls,
    commentImagePaths,
    skills,
    connectedFolderPaths,
    isRetry
  }: {
    noteId: string;
    prompt: string;
    rawPrompt?: string;
    referencedNoteIds?: string[];
    referencedDirectories?: string[];
    promptMentions?: ActionTabEntry['promptMentions'];
    contextMentions?: ActionTabEntry['contextMentions'];
    commentContext?: ActionTabEntry['commentContext'];
    sourceCommentId?: string;
    sourceCommentIds?: string[];
    sourceContextText?: string;
    sourceContextIconUrl?: string;
    imageUrls?: string[];
    commentImagePaths?: string[];
    skills?: string[];
    /** Folder paths for agent context. Only passed by retries replaying captured inputs. */
    connectedFolderPaths?: string[];
    /**
     * Retry invocations replay the ORIGINAL run's captured inputs only — the
     * live context-pill merge is skipped entirely so pills active at retry
     * time can't leak into the replayed run.
     */
    isRetry?: boolean;
  }): Promise<{ noteId: string; tabId: string } | null> => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || uiAgentBusyNoteIds.has(noteId)) {
      return null;
    }
    const commentSourceIds = Array.from(
      new Set([...(sourceCommentIds ?? []), ...(sourceCommentId ? [sourceCommentId] : [])])
    );
    const primarySourceCommentId = commentSourceIds[0];

    setPendingAgentExecution({ noteId, pending: true });
    try {
      const submitClickedAtMs = Date.now();
      const timelinePrompt = rawPrompt ?? prompt;
      const newPendingTab = createPendingActionEntry(timelinePrompt, promptMentions ?? []);
      newPendingTab.metrics = {
        stage: {
          submitClickedAtMs
        },
        context: {
          promptChars: timelinePrompt.length,
          referencedNotesCount: referencedNoteIds?.length ?? 0,
          promptSource: primarySourceCommentId ? 'comment' : 'prompt',
          mode: 'prompt'
        }
      };
      if (primarySourceCommentId) {
        newPendingTab.sourceCommentId = primarySourceCommentId;
      }
      if (sourceContextText) {
        newPendingTab.sourceContextText = sourceContextText;
      }
      if (sourceContextIconUrl) {
        newPendingTab.sourceContextIconUrl = sourceContextIconUrl;
      }
      if (skills?.includes('html') || sourceContextText?.startsWith('[Mockup:')) {
        newPendingTab.mockupMode = true;
      }
      if (contextMentions && contextMentions.length > 0) {
        newPendingTab.contextMentions = contextMentions.map((mention) => ({ ...mention }));
      }
      if (commentContext) {
        newPendingTab.commentContext = {
          ...commentContext,
          threads: commentContext.threads.map((thread) => ({
            ...thread,
            messages: thread.messages.map((message) => ({ ...message }))
          }))
        };
      }
      if (imageUrls && imageUrls.length > 0) {
        newPendingTab.imageUrls = [...imageUrls];
      }

      // Resolve the EFFECTIVE execution inputs at submit time. For normal runs
      // the live context pills are merged in here (folders → connectedFolderPaths,
      // pill notes → referencedNoteIds). Retries skip the live-pill merge entirely
      // and replay only the captured inputs passed in by the caller.
      const activePills = isRetry ? [] : store.get(contextPillsAtom);
      const pillFolderPaths = activePills
        .filter(p => p.type === 'directory' || p.type === 'folder')
        .map(p => p.id);
      const pillNoteIds = activePills
        .filter(p => p.type === 'note')
        .map(p => p.id);
      const mergedNoteIds = pillNoteIds.length > 0 || (referencedNoteIds && referencedNoteIds.length > 0)
        ? Array.from(new Set([...pillNoteIds, ...(referencedNoteIds ?? [])]))
        : referencedNoteIds;
      const effectiveFolderPaths = isRetry
        ? connectedFolderPaths
        : pillFolderPaths.length > 0 ? pillFolderPaths : undefined;

      // Compute external file count for model routing (sum of all @-mentioned files/notes).
      // Retries can't reconstruct per-pill file counts, so each replayed folder counts
      // as 1 (matching the `fileCount ?? 1` fallback used for live pills).
      const pillFolderFileCount = isRetry
        ? (connectedFolderPaths?.length ?? 0)
        : activePills
            .filter(p => p.type === 'directory' || p.type === 'folder')
            .reduce((sum, p) => sum + (p.fileCount ?? 1), 0);
      const externalFileCount =
        (mergedNoteIds?.length ?? 0) +
        pillFolderFileCount +
        (referencedDirectories?.length ?? 0);

      // Persist the FULL effective execution inputs (incl. pill-derived note ids
      // and folder paths) so "Try again" can faithfully reproduce this run
      // (skills, @-mentioned notes/dirs, pills, images) instead of re-running with
      // only the prompt text + whatever pills are live later.
      // mockupMode-derived html skill is folded in so mockup retries re-inject it.
      const retrySkills = newPendingTab.mockupMode
        ? Array.from(new Set([...(skills ?? []), 'html']))
        : skills;
      const retryInputs: ActionRetryInputs = {
        skills: retrySkills && retrySkills.length > 0 ? retrySkills : undefined,
        referencedNoteIds: mergedNoteIds && mergedNoteIds.length > 0 ? [...mergedNoteIds] : undefined,
        referencedDirectories: referencedDirectories && referencedDirectories.length > 0 ? [...referencedDirectories] : undefined,
        connectedFolderPaths: effectiveFolderPaths && effectiveFolderPaths.length > 0 ? [...effectiveFolderPaths] : undefined,
        imageUrls: imageUrls && imageUrls.length > 0 ? [...imageUrls] : undefined,
        commentImagePaths: commentImagePaths && commentImagePaths.length > 0 ? [...commentImagePaths] : undefined
      };
      newPendingTab.retryInputs = retryInputs;

      const updatedTabs = setActionTabsForNote(noteId, (prev) => [...prev, newPendingTab]);
      persistActionTabs(noteId, updatedTabs);

      if (store.get(activeNoteIdAtom) === noteId) {
        setExpandedActionTabIds(new Set([newPendingTab.id]));
      }

      if (!hasElectronBridge) {
        const mockTodos = generateMockTodos();
        const mockChanges = generateMockChanges();

        setActionTabsForNote(noteId, (prev) =>
          prev.map((tab) => {
            if (tab.id !== newPendingTab.id) {
              return tab;
            }
            return updateActionTabEntry(tab, {
              status: 'completed' as const,
              responseSummary: `Mock update applied for "${trimmedPrompt}"`,
              completedAt: new Date().toISOString(),
              todos: mockTodos,
              changes: mockChanges,
              isStreaming: false
            });
          })
        );

        return { noteId, tabId: newPendingTab.id };
      }

      let commentDirtySignalAtAgentStart = store.get(commentDirtySignalAtom(noteId));
      const applyExecuteResult = (result: AgentExecuteResultDelta): boolean => {
        if (result.noteId !== noteId) return false;
        if (!store.set(canApplyAgentExecuteResultAtom, { noteId, tabId: result.executedTabId })) {
          return false;
        }

        const noteTabsAtom = noteActionTabsAtom(noteId);
        const currentTab = store.get(noteTabsAtom).find((tab) => tab.id === result.executedTabId);
        const backendTab = result.stickyTabs?.find((tab) => tab.id === result.executedTabId);

        if (!backendTab) {
          return false;
        }

        const backendEntry = mapActionTabRecordToEntry(backendTab);
        const persistedAt = nowInSeconds();
        const mergedMetrics = mergeActionTabMetrics(backendEntry.metrics, currentTab?.metrics);
        const mergedTab: ActionTabEntry = {
          ...backendEntry,
          prompt: currentTab?.prompt ?? backendEntry.prompt,
          promptMentions: currentTab?.promptMentions ?? backendEntry.promptMentions,
          contextMentions: currentTab?.contextMentions ?? backendEntry.contextMentions,
          commentContext: currentTab?.commentContext ?? backendEntry.commentContext,
          imageUrls: currentTab?.imageUrls ?? backendEntry.imageUrls,
          messages: currentTab?.messages ?? [],
          streamingText: currentTab?.streamingText ?? '',
          isStreaming: currentTab?.isStreaming ?? false,
          activeTools: currentTab?.activeTools ?? [],
          lastToolName: currentTab?.lastToolName ?? null,
          streamError: currentTab?.streamError ?? null,
          toolCallCounts: currentTab?.toolCallCounts ?? {},
          model: backendEntry.model ?? currentTab?.model,
          profile: backendEntry.profile ?? currentTab?.profile,
          timing: {
            ...(backendEntry.timing ?? {}),
            ...(currentTab?.timing ?? {}),
            persistedAt
          },
          metrics: mergedMetrics,
          syntheticAck: currentTab?.syntheticAck ?? backendEntry.syntheticAck
        };

        const mergedTabs = setActionTabsForNote(noteId, (prev) =>
          prev.map((tab) => (tab.id === result.executedTabId ? mergedTab : tab))
        );
        persistActionTabs(noteId, mergedTabs);

        store.set(syncNoteEntityAtom, {
          noteId,
          updates: {
            updatedAt: result.updatedAt,
            ...(typeof result.title === 'string' ? { title: result.title } : {}),
            ...(typeof result.contentPath === 'string' ? { contentPath: result.contentPath } : {})
          }
        });
        if (result.commentMetadata) {
          const hydratedComments = hydrateComments(result.commentMetadata);
          const hasLocalCommentEditsDuringRun =
            store.get(commentDirtySignalAtom(noteId)) !== commentDirtySignalAtAgentStart;
          store.set(
            noteCommentsMapAtom(noteId),
            hasLocalCommentEditsDuringRun
              ? mergeAgentCommentsWithLocalEdits(store.get(noteCommentsMapAtom(noteId)), hydratedComments)
              : hydratedComments
          );
        }
        return true;
      };

      try {
        const isTargetNoteActive = store.get(activeNoteIdAtom) === noteId;

      // Await any in-flight save for the target note before reading content.
      // The cleanup save is fire-and-forget (void saveContentRef.current()),
      // so it can race with agent writes if we don't wait for it.
      const pendingSave = store.get(pendingSavePromiseAtom(noteId));
      if (pendingSave) {
        await pendingSave;
      }

      // Flush pending saves before reading content.
      // flushAndWait serializes dirty editor state to disk.
      if (isTargetNoteActive) {
        await canvasRef.current?.flushAndWait();
      } else if (store.get(splitTabNoteIdAtom) === noteId) {
        // Split pane: flush the right pane so debounced saves don't
        // race with agent writes and overwrite agent output.
        await splitRightPaneRef.current?.flushAndWait();
      }

      const preflightDoneAtMs = Date.now();

      // Always source content by target noteId to avoid canvas note-switch races.
      const freshNote = await notesApi.getById.invoke(noteId, { skipAnalytics: true });
      const latestContentForAgent = freshNote?.content ?? '';

      // Prefer fresh note title for the target note.
      const noteTitle = freshNote?.title;

      // Batch preflight + IPC timing into a single atom write to avoid intermediate renders
      const ipcExecuteSentAtMs = Date.now();
      setActionTabsForNote(noteId, (prev) =>
        prev.map((tab) =>
          tab.id === newPendingTab.id
            ? {
                ...tab,
                metrics: mergeActionTabMetrics(tab.metrics, {
                  stage: {
                    preflightDoneAtMs,
                    ipcExecuteSentAtMs
                  },
                  context: {
                    contentChars: latestContentForAgent.length,
                    nonEmptyNoteAtStart: latestContentForAgent.trim().length > 0
                  }
                })
              }
            : tab
        )
      );

      if (!store.set(canStartPendingAgentExecutionAtom, { noteId, tabId: newPendingTab.id })) {
        return { noteId, tabId: newPendingTab.id };
      }

      commentDirtySignalAtAgentStart = store.get(commentDirtySignalAtom(noteId));
      agentApi.execute.reset?.();
      const result = await agentApi.execute.invoke({
        context: 'notes',
        noteId,
        tabId: newPendingTab.id,
        prompt,
        rawPrompt,
        promptSource: primarySourceCommentId ? 'comment' : 'prompt',
        content: latestContentForAgent,
        noteTitle,
        referencedNoteIds: mergedNoteIds,
        referencedDirectories,
        connectedFolderPaths: effectiveFolderPaths && effectiveFolderPaths.length > 0 ? effectiveFolderPaths : undefined,
        imageUrls,
        commentImagePaths,
        skills,
        externalFileCount: externalFileCount > 0 ? externalFileCount : undefined,
        clientTiming: {
          submitClickedAtMs,
          preflightDoneAtMs,
          ipcExecuteSentAtMs
        },
      });

      // Main returns undefined for cancelled executions (user/system interrupt).
      // The disk watcher will detect partial tool writes and reconcile.
      if (!result) {
        return { noteId, tabId: newPendingTab.id };
      }

      applyExecuteResult(result);

      // If the agent created new notes, register them in the atom store so they
      // appear in the sidebar. Navigate only when exactly one note was created.
      if (result.createdNotes?.length) {
        for (const record of result.createdNotes) {
          const entity = mapNoteMetadataToNoteEntity(record);
          store.set(noteEntityAtom(entity.id), entity);
        }
        store.set(noteIdsAtom, (prev) => {
          const next = new Set(prev);
          for (const record of result.createdNotes!) next.add(record.id);
          return next;
        });
        if (result.createdNotes.length === 1) {
          navigateToNote(result.createdNotes[0].id);
        }
      }
        // Disk watcher handles editor refresh for agent writes.
      } catch (error) {
        applyExecuteErrorState(noteId, newPendingTab.id, error);
      }

      return { noteId, tabId: newPendingTab.id };
    } finally {
      setPendingAgentExecution({ noteId, pending: false });
    }
  }, [
    uiAgentBusyNoteIds,
    hasElectronBridge,
    applyExecuteErrorState,
    setExpandedActionTabIds,
    setActionTabsForNote,
    persistActionTabs,
    navigateToNote,
    setPendingAgentExecution,
    store
  ]);

  const handleActionPromptSubmit = useCallback(async (
    prompt: string,
    noteIds?: string[],
    mentions?: ActionTabEntry['promptMentions'],
    directoryPaths?: string[],
    imageUrls?: string[],
    skills?: string[]
  ) => {
    const trimmedPrompt = prompt.trim();
    const targetNoteId = store.get(focusedNoteIdAtom);
    const noteHasActiveAgent = uiAgentBusyNoteIds.has(targetNoteId ?? '');
    if (!trimmedPrompt || !targetNoteId || noteHasActiveAgent || !canOpenPrompt) {
      return;
    }

    const mockupPrefix = skills?.includes('html')
      ? '[HTML mode — create embedded moss-html preview/prototype using the moss-html skill]\n\n'
      : '';
    const selectedContextPrompt = buildPromptWithSelectedContext({
      prompt: trimmedPrompt,
      selectedContext: effectiveSelectedContext,
      selectedContextSourceUrl: effectiveSelectedContextSourceUrl,
      prefix: mockupPrefix,
    });
    const commentContextForSubmit = store.get(pendingAgentCommentContextAtom);
    const basePrompt = buildPromptWithPendingCommentContext({
      prompt: selectedContextPrompt,
      context: commentContextForSubmit
    });

    let noteId = targetNoteId;
    const promptMentions =
      mentions && mentions.length > 0
        ? Array.from(
            new Map(
              mentions.map((mention) => [
                `${mention.type}:${mention.id}`,
                { id: mention.id, title: mention.title, type: mention.type } as NonNullable<ActionTabEntry['promptMentions']>[number]
              ])
            ).values()
          )
        : [];

    const sourceCommentId = store.get(pendingAgentCommentIdAtom);
    if (sourceCommentId) {
      store.set(pendingAgentCommentIdAtom, null);
    }
    const sourceCommentIds = Array.from(
      new Set([
        ...getCommentRootIdsForAgentContext(commentContextForSubmit),
        ...(sourceCommentId ? [sourceCommentId] : [])
      ])
    );
    const commentImagePaths = store.get(pendingAgentImageUrlsAtom);
    store.set(pendingAgentImageUrlsAtom, null);

    setSelectedContext(null);
    store.set(pendingAgentCommentContextAtom, null);
    store.set(pendingAgentContextAtom, null);
    store.set(pendingAgentContextIconUrlAtom, null);
    store.set(pendingAgentContextSourceUrlAtom, null);
    canvasRef.current?.clearContextMark();

    setShowCommandPalette(false);
    store.set(promptDraftAtom, '');

    // Capture the context pills shown above the input at submit time, deduped
    // against this action's in-prompt mentions, so the timeline user message is
    // a faithful receipt of every context source. Read before setMentionPillsAtom
    // replaces the pills below.
    const promptMentionKeys = new Set(promptMentions.map((m) => `${m.type}:${m.id}`));
    const aboveInputContextMentions = store
      .get(contextPillsAtom)
      .filter((pill) => !promptMentionKeys.has(`${pill.type}:${pill.id}`))
      .map((pill) => ({ id: pill.id, title: pill.title, type: pill.type, fileCount: pill.fileCount }));

    // Replace context pills with this action's @mentions (notes + directories)
    const entriesCache = store.get(connectedFolderEntriesAtom);
    const mentionPills = promptMentions
      .filter(m => m.type === 'note' || m.type === 'directory' || m.type === 'folder')
      .map(m => {
        let fileCount = 1;
        if (m.type === 'directory') {
          fileCount = entriesCache.get(m.id)?.length ?? 1;
        } else if (m.type === 'folder') {
          fileCount = store.get(activeNotesAtom)
            .filter(e => {
              const fp = e.folderPath ?? 'Notes';
              return fp === m.id || fp.startsWith(`${m.id}/`);
            }).length;
        }
        return { id: m.id, title: m.title, type: m.type, fileCount };
      });
    store.set(setMentionPillsAtom, mentionPills);

    const resolvedDirPaths = directoryPaths && directoryPaths.length > 0
      ? directoryPaths
      : mentions?.filter(m => m.type === 'directory').map(m => m.id) ?? [];
    const folderMentionPaths = mentions
      ?.filter((mention) => mention.type === 'folder')
      .map((mention) => mention.id) ?? [];
    const expandedFolderNoteIds = folderMentionPaths.length > 0
      ? store
          .get(activeNotesAtom)
          .filter((entity) => {
            const folderPath = entity.folderPath ?? 'Notes';
            return folderMentionPaths.some((path) => folderPath === path || folderPath.startsWith(`${path}/`));
          })
          .map((entity) => entity.id)
      : [];
    const resolvedNoteIds = Array.from(
      new Set([...(noteIds ?? []), ...expandedFolderNoteIds])
    );

    await executeAgentForNote({
      noteId,
      prompt: basePrompt,
      rawPrompt: trimmedPrompt,
      referencedNoteIds: resolvedNoteIds.length > 0 ? resolvedNoteIds : undefined,
      referencedDirectories: resolvedDirPaths.length > 0 ? resolvedDirPaths : undefined,
      promptMentions,
      contextMentions: aboveInputContextMentions.length > 0 ? aboveInputContextMentions : undefined,
      commentContext: commentContextForSubmit ?? undefined,
      sourceCommentId: sourceCommentId ?? undefined,
      sourceCommentIds: sourceCommentIds.length > 0 ? sourceCommentIds : undefined,
      sourceContextText: effectiveSelectedContext ?? undefined,
      sourceContextIconUrl: effectiveSelectedContextIconUrl ?? undefined,
      imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
      commentImagePaths: commentImagePaths && commentImagePaths.length > 0 ? commentImagePaths : undefined,
      skills: skills && skills.length > 0 ? skills : undefined
    });
  }, [
    activeNoteId,
    uiAgentBusyNoteIds,
    canOpenPrompt,
    createAndActivateNote,
    executeAgentForNote,
    setShowCommandPalette,
    effectiveSelectedContext,
    effectiveSelectedContextIconUrl,
    effectiveSelectedContextSourceUrl,
    store
  ]);

  // Global shortcut activation handler (system-wide shortcut from main process)
  useEffect(() => {
    if (!hasElectronBridge) {
      return;
    }

    const handleGlobalShortcutActivation = () => {
      void createAndActivateNote({ focusTarget: 'body' });
    };

    const cleanup = systemApi.onGlobalShortcutActivated(handleGlobalShortcutActivation);
    return cleanup;
  }, [createAndActivateNote, hasElectronBridge]);

  const handlePromptClose = useCallback(() => {
    setShowCommandPalette(false);
    setSelectedContext(null);
    clearPendingCommentAgentContext(store);
    canvasRef.current?.clearContextMark();
  }, [setShowCommandPalette, store]);

  const handleOpenPrompt = useCallback(() => {
    // Single gate check for prompt availability
    if (!canOpenPrompt) return;

    // Mark and capture selected text - the highlight persists when editor loses focus
    const selection = canvasRef.current?.markSelectionAsContext() ?? '';
    setSelectedContext(selection.trim() || null);
    clearPendingCommentAgentContext(store);

    // Open the command palette overlay above the toolbar
    store.set(commandPaletteOriginAtom, 'toolbar');
    setShowCommandPalette(true);
  }, [canOpenPrompt, setShowCommandPalette, store]);

  const handleCloseSearch = useCallback(() => {
    clearSearch();
  }, [clearSearch]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Global Escape: dismiss all search regardless of focus
      if (e.key === 'Escape' && showSearchBar) {
        e.preventDefault();
        handleCloseSearch();
        return;
      }

      if (!e.metaKey && !e.ctrlKey) {
        return;
      }

      const key = e.key.toLowerCase();

      // moss-multi seam: hide-registry (A§9)
      if (key === 'k' && !e.shiftKey && !hidden('ai-run-action')) {
        e.preventDefault();
        if (showCommandPalette) {
          // Already open - just focus the input
          commandPaletteRef.current?.focus();
        } else {
          handleOpenPrompt();
        }
        return;
      }

      if (key === 'n' && !e.shiftKey) {
        e.preventDefault();
        handleCreateNote();
        return;
      }

      if (key === 't') {
        const isMacPlatform =
          typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
        const hasPrimaryModifier = isMacPlatform ? e.metaKey : e.ctrlKey;
        const hasSecondaryModifier = isMacPlatform ? e.ctrlKey : e.metaKey;
        if (!hasPrimaryModifier || hasSecondaryModifier || e.altKey) {
          return;
        }

        if (e.shiftKey) {
          if (!store.get(activeNoteIdAtom)) {
            return;
          }
          e.preventDefault();
          if (!store.get(isBrowserSplitOpenAtom)) {
            store.set(openBrowserSplitAtom, { url: NEW_BROWSER_TAB_URL });
          }
          store.set(requestBrowserSplitFocusAtom);
          return;
        }

        e.preventDefault();
        canvasRef.current?.focusTitle();
        return;
      }

      if (key === 'g' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handlePanelViewChange('notes');
        setNotesPanelHidden(false);
        window.setTimeout(() => notesListRef.current?.focusSearch(), 0);
        return;
      }

      // Cmd+F searches the focused note only. Cross-note search stays available
      // from the notes panel search button.
      if (key === 'f') {
        if (appMode === 'notes' && focusedNoteId) {
          e.preventDefault();
          setSearchQuery('');
          setSearchBarAutoFocus(true);
        }
        return;
      }

      // Backslash shortcuts — use e.code exclusively (macOS Option+\ produces '«')
      if (e.code === 'Backslash') {
        e.preventDefault();
        if (e.shiftKey && !e.altKey) {
          // Cmd+Shift+\: toggle zen mode (hides/restores both panels)
          toggleZenMode();
        } else if (e.altKey && !e.shiftKey) {
          // Cmd+Option+\: toggle actions panel (always works, even in zen)
          setActionsPanelHidden((prev) => !prev);
        } else if (!e.altKey && !e.shiftKey) {
          // Cmd+\: toggle notes panel, or exit zen mode if active
          if (zenModeActive) {
            toggleZenMode();
          } else {
            setNotesPanelHidden((prev) => !prev);
          }
        }
        return;
      }

      // Switch to Notes tab: Cmd+1
      if (key === '1') {
        e.preventDefault();
        handlePanelViewChange('notes');
        return;
      }

      // Switch to Trash tab: Cmd+2
      if (key === '2') {
        e.preventDefault();
        handlePanelViewChange('trash');
        return;
      }

      // Navigation shortcuts: Cmd+Opt+Left (back) and Cmd+Opt+Right (forward)
      // Uses Alt modifier to avoid conflict with Cmd+[/] list indentation in editor
      if (e.altKey) {
        if (key === 'arrowleft' && canGoBack) {
          e.preventDefault();
          handleGoBack();
          return;
        }

        if (key === 'arrowright' && canGoForward) {
          e.preventDefault();
          handleGoForward();
        }
      }

    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreateNote, handleOpenPrompt, handlePanelViewChange, showCommandPalette, canGoBack, canGoForward, handleGoBack, handleGoForward, appMode, toggleZenMode, setActionsPanelHidden, setNotesPanelHidden, zenModeActive, showSearchBar, setSearchQuery, handleCloseSearch, focusedNoteId, store]);

  // Check if any tabs are currently streaming for the active note
  // Use store.get() for synchronous read to get latest streaming state
  const hasActiveStreaming = useCallback(() => {
    if (!activeNoteId) return false;
    const noteTabsAtom = noteActionTabsAtom(activeNoteId);
    return store.get(noteTabsAtom).some((tab) => tab.isStreaming);
  }, [store, activeNoteId]);

  const handleCollapseNotesPanel = useCallback(() => {
    if (narrow) { setNarrowNotesOpen(false); return; } // moss-multi seam: phone-shell (T2.7)
    setNotesPanelHidden(true);
  }, [narrow, setNotesPanelHidden]);

  // moss-multi seam: phone-shell (T2.7): a tap outside the overlaid notes panel closes it
  useEffect(() => {
    if (!narrowNotesVisible || !activeNoteId) return;
    const close = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target || notesPanelWrapperRef.current?.contains(target) || target.closest('[data-overlay-surface]')) return;
      setNarrowNotesOpen(false);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [narrowNotesVisible, activeNoteId]);

  const handleOpenActionImages = useCallback((sources: string[], startIndex: number) => {
    if (!sources.length) return;
    const displaySources = sources.map((src) => toDisplaySrc(src, focusedNoteId));
    const clampedIndex = Math.min(Math.max(startIndex, 0), displaySources.length - 1);
    setLightboxSrc({ kind: 'carousel', sources: displaySources, index: clampedIndex });
  }, [focusedNoteId, setLightboxSrc]);

  // Hydration gate: prevent rendering the full UI until notes are loaded.
  // Eliminates the empty-state flash on startup.
  // All hooks are above this point to satisfy Rules of Hooks.
  if (!notesHydrated) {
    return (
      <div className="flex h-full min-h-screen w-full items-center justify-center rounded-xl border-2 border-border-subtle bg-surface-canvas-bg" />
    );
  }

  if (automationUiFixture === 'empty-workspace') {
    return <SnapshotUiFixtureLayer fixture={automationUiFixture} />;
  }

  const canvasSharedProps = {
    onDeleteNote: handleNoteDeleted,
    onRestoreNote: handleNoteRestored,
    onNavigateToNote: handleSelectNote,
    isActionsPanelHidden: actionsPanelHidden,
    isNotesPanelHidden: narrow ? !narrowNotesVisible : notesPanelHidden, // moss-multi seam: phone-shell (T2.7)
    onExpandNotesPanel: () => { if (narrow) { setNarrowNotesOpen(true); return; } zenModeActive ? toggleZenMode() : setNotesPanelHidden(false); },
    onExpandActionsPanel: () => { zenModeActive ? toggleZenMode() : setActionsPanelHidden(false); },
    isAgentStreaming: hasActiveStreaming,
    onCanvasClick: handlePromptClose,
    // moss-multi seam: hide-registry (A§9)
    onActionClick: hidden('ai-run-action') ? undefined : handleOpenPrompt,
  };

  const actionsPanelContent = (
    <ActionsPanelWrapper
      // In browser-split the panel renders inside <main> next to the note pane,
      // so it needs its own divider. In the normal placement the canvas area's
      // border-r already draws the seam — no border here to avoid doubling.
      className={isBrowserSplitOpen ? 'border-l border-border-subtle' : undefined}
      hidden={actionsPanelHidden}
      onHiddenChange={setActionsPanelHidden}
      width="var(--actions-panel-width, 280px)"
      scrollContainerRef={actionsPanelScrollRef}
      isAgentStreaming={actionTabs.some(tab => tab.isStreaming)}
      propertiesContent={<PropertiesTabContent />}
      resizeHandle={
        <div
          ref={actionsResizeHandleRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize actions panel"
          onPointerDown={startResizingActionsPanel}
          onPointerMove={handleActionsPanelResizeMove}
          onPointerUp={handleActionsPanelResizeRelease}
          onPointerCancel={handleActionsPanelResizeRelease}
          onLostPointerCapture={handleActionsPanelResizeCaptureLost}
          onDoubleClick={resetActionsPanelWidth}
          className={[
            'absolute left-0 top-0 z-10 h-full w-0 shrink-0 cursor-col-resize touch-none select-none transition-colors before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-[""]',
            'hover:bg-surface-notes-list'
          ].join(' ')}
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        />
      }
      linksSection={
        <LinksSection
          activeNoteId={focusedNoteId}
          onNavigateToNote={handleSelectNote}
          activeFrontmatter={focusedNoteFrontmatter}
          noteIntelligenceEnabled={noteIntelligenceEnabled}
          showDivider
        />
      }
    >
      <ActionsPanel
        tabs={actionTabs}
        expandedIds={expandedActionTabIds}
        onExpandedIdsChange={setExpandedActionTabIds}
        onCancelAction={focusedNoteId ? () => handleUserCancel(focusedNoteId) : undefined}
        onCopyPrompt={(prompt: string) => { void navigator.clipboard.writeText(prompt); }}
        onOpenImages={handleOpenActionImages}
        onRetry={focusedNoteId
          ? (action) => {
              // "Try again": re-run the original agent-facing prompt for this
              // action via the same path PromptBox submission uses
              // (executeAgentForNote → agent.execute IPC). action.prompt already
              // holds the full prompt (incl. any [Selected text: …] prefix), so
              // it is passed straight through as `prompt`. The other execution
              // inputs (skills, @-mentioned notes/dirs, pill-derived refs,
              // images) were captured at submit time in action.retryInputs. The
              // retry button only renders while that in-memory replay marker is
              // present; reloaded error tabs keep their classification but avoid
              // prompt-only retries that could silently drop context.
              if (!action.prompt || action.retryInputs === undefined) return;
              const retry = action.retryInputs;
              void executeAgentForNote({
                noteId: focusedNoteId,
                prompt: action.prompt,
                promptMentions: action.promptMentions,
                skills: retry?.skills,
                referencedNoteIds: retry?.referencedNoteIds,
                referencedDirectories: retry?.referencedDirectories,
                connectedFolderPaths: retry?.connectedFolderPaths,
                imageUrls: retry?.imageUrls,
                commentImagePaths: retry?.commentImagePaths,
                isRetry: true
              });
            }
          : undefined}
        retryDisabled={focusedNoteId ? uiAgentBusyNoteIds.has(focusedNoteId) : false}
        scrollContainerRef={actionsPanelScrollRef}
      />
    </ActionsPanelWrapper>
  );

  const canvasArea = (
    <SplitPaneContainer
      leftPaneRef={canvasRef}
      rightPaneRef={splitRightPaneRef}
      onCloseSplitPane={handleCloseSplitPane}
      leftActionsPanel={isBrowserSplitOpen ? actionsPanelContent : null}
      {...canvasSharedProps}
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onGoBack={handleGoBack}
      onGoForward={handleGoForward}
      showSearchBar={showSearchBar}
      searchBarAutoFocus={searchBarAutoFocus}
      onCloseSearch={handleCloseSearch}
      onOpenSearch={() => { setSearchQuery(''); setSearchBarAutoFocus(true); }}
      leftAutoFocusTitle={titleFocusNoteId !== null && titleFocusNoteId === activeNoteId}
      onLeftTitleFocusComplete={handleTitleFocusComplete}
      leftAutoFocusBody={shouldFocusBody}
      onLeftBodyFocusComplete={handleBodyFocusComplete}
      showFloatingTitleBar={!zenModeActive || showZenTopBar || showSearchBar}
      isFocusMode={zenModeActive}
    />
  );

  const feedbackTooltipFixtureOpen = automationUiFixture === 'feedback-tooltip';

  const panelFooter = (
    <NotesPanelFooter
      feedbackTooltipOpen={feedbackTooltipFixtureOpen}
      mode={appMode}
      onModeChange={handlePanelViewChange}
      onTrashNote={handleNoteDeleted} // moss-multi seam: trash-drop (T2.3)
      onOpenFeedback={() => setFeedbackDialogOpen(true)}
      onOpenSettings={async () => {
        handleCloseSearch();
        await store.set(ensureSettingsWarmupAtom);
        setSettingsModalOpen(true);
      }}
    />
  );

  const notesPanelOverlay = narrow || (zenModeActive && notesPanelHidden); // moss-multi seam: phone-shell (T2.7)
  const notesPanelVisible = narrow ? narrowNotesVisible : notesPanelOverlay ? showZenNotesPanel : !notesPanelHidden;
  const notesPanelWidthPx = notesListWidth + NOTES_PANEL_RESIZER_WIDTH_PX;

  const notePanelContent =
    appMode === 'trash' ? (
      <Suspense fallback={null}>
        <LazyTrashedNotesPanelContent
          ref={trashListRef}
          onSelectNote={handleSelectNote}
          onRestoreNote={handleNoteRestored}
          onCollapse={handleCollapseNotesPanel}
          footerContent={panelFooter}
        />
      </Suspense>
    ) : (
      <NotesListPanelContent
        ref={notesListRef}
        onSelectNote={handleSelectNote}
        onCreateNote={handleCreateNote}
        onDeleteNote={handleNoteDeleted}
        onDuplicateNote={handleDuplicateNote}
        onRenameNote={handleRenameNote}
        onCollapse={handleCollapseNotesPanel}
        footerContent={panelFooter}
      />
    );

  const notesPanel = (
    <div
      ref={notesPanelWrapperRef}
      className={[
        'flex h-full shrink-0 overflow-hidden bg-surface-notes-list',
        notesPanelOverlay ? 'absolute inset-y-0 left-0 z-40 border-r border-border-subtle/50 shadow-[0_8px_24px_var(--ink-shadow-soft)]' : '',
        notesPanelOverlay && notesPanelVisible ? 'translate-x-0 opacity-100' : '',
        notesPanelOverlay && !notesPanelVisible ? '-translate-x-full opacity-0 pointer-events-none' : '',
        narrow && !notesPanelVisible ? 'invisible' : '', // moss-multi seam: phone-shell (T2.7): put away, not just transparent
        !notesPanelOverlay && !notesPanelVisible ? 'hidden' : ''
      ].join(' ')}
      style={{ width: notesPanelVisible || notesPanelOverlay ? `${notesPanelWidthPx}px` : undefined }}
      inert={!notesPanelVisible || undefined}
      aria-hidden={!notesPanelVisible}
      data-overlay-surface={narrow && notesPanelVisible ? '' : undefined} // moss-multi seam: phone-shell (T2.7, A§19)
    >
      <div
        className="flex h-full min-w-0 shrink-0 overflow-hidden"
        style={{
          width: `${notesListWidth}px`,
          minWidth: `${NOTES_LIST_WIDTH_MIN}px`,
          maxWidth: `${getNotesListWidthMax()}px`
        } as CSSProperties}
      >
        {notePanelContent}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize note list"
        onPointerDown={startResizingNotesPanel}
        onPointerMove={handleNotesPanelResizeMove}
        onPointerUp={handleNotesPanelResizeRelease}
        onPointerCancel={handleNotesPanelResizeRelease}
        onLostPointerCapture={handleNotesPanelResizeCaptureLost}
        onDoubleClick={resetNotesPanelWidth}
        className={[
          'relative z-30 h-full w-1 shrink-0 cursor-col-resize touch-none select-none bg-surface-transparent before:absolute before:inset-y-0 before:-left-2 before:-right-2 before:content-[""]'
        ].join(' ')}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      />
    </div>
  );

  return (
    <>
      <AppShell
        className="relative"
        notesPanel={notesPanel}
        canvasArea={canvasArea}
        actionsPanel={isBrowserSplitOpen ? null : actionsPanelContent}
        showFocusModeLeftDragZone={zenModeActive && showZenNotesPanel}
        focusModeLeftDragWidthPx={notesPanelWidthPx}
      />
      {/* Global-level lightbox for triggers outside any canvas pane (e.g. CommandPaletteOverlay) */}
      <div className="pointer-events-none fixed inset-0 z-50">
        <ImageLightbox />
      </div>
      {/* App-level web embed browser lightbox (the interactive surface for openWebEmbed). */}
      <WebEmbedLightbox />
      {showCommandPalette || commandPaletteDocked ? (
        <Suspense fallback={null}>
          <LazyCommandPaletteOverlay
            ref={commandPaletteRef}
            open={showCommandPalette}
            onOpenChange={setShowCommandPalette}
            onSubmit={handleActionPromptSubmit}
            isSubmitting={isActiveNoteAgentBusy}
            selectedContext={effectiveSelectedContext}
            selectedContextIconUrl={effectiveSelectedContextIconUrl}
            anchorSelector={isBrowserSplitOpen ? '[data-command-palette-note-pane="true"]' : undefined}
            isActionsPanelHidden={actionsPanelHidden}
            isNotesPanelHidden={notesPanelHidden}
            onClearSelectedContext={() => {
              setSelectedContext(null);
              clearPendingCommentAgentContext(store);
              canvasRef.current?.clearContextMark();
            }}
          />
        </Suspense>
      ) : null}
      {settingsModalOpen ? (
        <Suspense fallback={null}>
          <LazySettingsModal
            open={settingsModalOpen}
            onOpenChange={setSettingsModalOpen}
          />
        </Suspense>
      ) : null}
      <DefaultEditorPrompt />
      {feedbackDialogOpen ? (
        <Suspense fallback={null}>
          <LazyFeedbackDialog
            open={feedbackDialogOpen}
            onOpenChange={setFeedbackDialogOpen}
          />
        </Suspense>
      ) : null}
      <SnapshotUiFixtureLayer fixture={automationUiFixture} />
      {operationFailure ? (
        <div
          className="pointer-events-none fixed bottom-8 left-1/2 z-50 -translate-x-1/2"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
        >
          <div className="pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg border border-status-error-border/50 bg-status-error-surface/95 px-4 py-2.5 shadow-floating backdrop-blur-sm">
            <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-status-error-text/80" />
            <span className="break-words text-xs text-status-error-text">{renderInlineMarkdown(operationFailure.message)}</span>
          </div>
        </div>
      ) : null}
      {updateInfo ? (
        <Suspense fallback={null}>
          <LazyUpdateWidget
            info={updateInfo}
            onDismiss={() => {
              localStorage.setItem(
                getUpdateDismissedStorageKey(updateInfo.canInstall),
                updateInfo.version
              );
              setUpdateInfo(null);
            }}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export default App;

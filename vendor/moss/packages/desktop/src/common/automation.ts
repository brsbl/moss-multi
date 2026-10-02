// ported-from: packages/desktop/src/common/automation.ts @ 762abb777
export type AutomationPane = 'left' | 'right';

export type RendererAutomationState = {
  activeNoteId: string | null;
  activeNoteTitle: string | null;
  splitNoteId: string | null;
  splitNoteTitle: string | null;
  isSplitOpen: boolean;
  focusedPane: AutomationPane;
  visibilityState: string | null;
};

export type SnapshotFileLinkFixtureEntry = {
  href: string;
  noteId?: string | null;
  noteTitle?: string | null;
  headingText?: string | null;
  resolutionState?:
    | 'note_resolved'
    | 'not_found'
    | 'fully_resolved'
    | 'heading_not_found';
};

export type SnapshotFixtureData = {
  fileLinks?: SnapshotFileLinkFixtureEntry[];
};

export type SnapshotSeededNote = {
  id: string;
  title: string;
  folderPath: string;
  content: string;
  /** Unix seconds; harness defaults to a fixed value so the list ordering is stable. */
  updatedAt: number;
  /** Unix seconds; defaults to updatedAt. */
  createdAt?: number;
  /** Unix seconds; when present the note is rendered in the Trash view. */
  trashedAt?: number | null;
  contentType?:
    | 'empty'
    | 'code'
    | 'charts'
    | 'images'
    | 'media'
    | 'large-text'
    | 'medium-text';
  pinned?: boolean;
};

export type SnapshotActionTabsFixtureKind =
  | 'streaming'
  | 'streaming-long'
  | 'completed-expanded';

export type SnapshotUiFixtureKind =
  | 'empty-workspace'
  | 'feedback-tooltip'
  | 'mention-typeahead'
  | 'comment-input-popover'
  | 'comment-popover'
  | 'connected-folders-popover'
  | 'media-source-dialog'
  | 'rename-folder-dialog'
  | 'confirmation-dialog'
  | 'copy-for-agent-dialog'
  | 'timeline-popout-dialog'
  | 'slot-button-as-child';

export type RendererAutomationCommand =
  | { type: 'getState' }
  | { type: 'openNote'; noteId?: string; title?: string }
  | { type: 'openSplit'; noteId?: string; title?: string; focusPane?: AutomationPane }
  | { type: 'closeSplit' }
  | { type: 'focusPane'; pane: AutomationPane }
  | { type: 'scrollToHeading'; heading: string; pane?: AutomationPane }
  | { type: 'selectTab'; label: string; pane?: AutomationPane }
  | { type: 'setHeadingCollapsed'; heading: string; collapsed: boolean; pane?: AutomationPane }
  | { type: 'createPdfExportSession'; pane?: AutomationPane }
  | { type: 'openPdfPreview'; pane?: AutomationPane }
  | { type: 'openPdfRenderSurface'; pane?: AutomationPane }
  | { type: 'forceReloadFromDisk'; pane?: AutomationPane }
  | { type: 'enableSnapshotMode'; fixture?: SnapshotFixtureData }
  | { type: 'disableSnapshotMode' }
  | { type: 'waitForCodeblocksReady'; timeoutMs?: number }
  | { type: 'seedFixtureNotes'; notes: SnapshotSeededNote[] }
  | { type: 'setSettingsModalOpen'; open: boolean }
  | { type: 'setFeedbackDialogOpen'; open: boolean }
  | { type: 'setCommandPaletteOpen'; open: boolean }
  | { type: 'setAppMode'; mode: 'notes' | 'trash' }
  | {
      type: 'seedFixtureActionTabs';
      noteId?: string;
      kind: SnapshotActionTabsFixtureKind;
      expanded?: boolean;
    }
  | { type: 'setSnapshotUiFixture'; fixture: SnapshotUiFixtureKind | null };

export type RendererAutomationResult = {
  ok: boolean;
  state: RendererAutomationState;
  reason?: string;
  data?: unknown;
};

export type MossAutomationController = {
  getState: () => RendererAutomationState;
  run: (command: RendererAutomationCommand) => Promise<RendererAutomationResult>;
};

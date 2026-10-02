// ported-from: packages/desktop/src/common/noteTypes.ts @ 762abb777
import type { ActionPlanChange, ActionPlanTodo } from '@moss/shared/types/action-plan';
import type { ActionTabMetrics } from '@moss/shared/types/action-tab-metrics';
import type { NoteComment } from '@moss/shared/types/note-comment';
import type { NoteContentType, NoteLink as LinkInfo } from '@moss/shared/types/note-entity';
import type { CommentMetadataMap } from './markdown-layers';

// ---------------------------------------------------------------------------
// Heading and Link Resolution types (for anchor links)
// ---------------------------------------------------------------------------

export interface HeadingInfo {
  level: 1 | 2 | 3 | 4;
  text: string;
}

export interface NotesFlushCompletePayload {
  status: 'success' | 'error';
  durationMs?: number;
  noteId?: string | null;
  errorMessage?: string;
}

export type LinkResolutionState =
  | 'unresolved' // Not yet checked (optimistic — renders as valid)
  | 'not_found' // Checked and note doesn't exist
  | 'note_resolved' // Note found, heading not checked or not applicable
  | 'fully_resolved' // Note + heading both found
  | 'heading_not_found'; // Note found, but heading doesn't exist

/**
 * @deprecated Use ActionTabStatus instead
 */
export type StickyTabStatus = 'draft' | 'pending' | 'completed' | 'error' | 'interrupted';

/**
 * Status for action tabs. Draft status has been removed - tabs are created
 * directly in pending status when an action is submitted.
 */
export type ActionTabStatus = 'pending' | 'completed' | 'error' | 'interrupted';

export type StickyTabTodo = ActionPlanTodo;
export type StickyTabChange = ActionPlanChange;

export interface StickyTabPromptMention {
  id: string;
  title: string;
  type: 'note' | 'directory' | 'folder';
}

export interface StickyTabCommentContextMessage {
  id: string;
  authorLabel: string;
  source?: NoteComment['source'];
  color?: number;
  text: string;
  kind: 'comment' | 'reply';
}

export interface StickyTabCommentContextThread {
  rootId: string;
  messages: StickyTabCommentContextMessage[];
}

export interface StickyTabCommentContext {
  scope: 'comment' | 'thread' | 'all';
  title: string;
  promptText: string;
  agentContextText: string;
  threads: StickyTabCommentContextThread[];
}

export interface StickyTabTiming {
  /** Unix timestamp in seconds when stream start was received */
  startedAt?: number;
  /** Unix timestamp in seconds of the first text delta */
  firstTextAt?: number;
  /** Unix timestamp in seconds of the latest text delta */
  lastTextAt?: number;
  /** Unix timestamp in seconds when the first tool began executing */
  firstToolStartAt?: number;
  /** Unix timestamp in seconds when the first in-editor update was emitted */
  firstEditorUpdateAt?: number;
  /** Unix timestamp in seconds when the most recent tool finished */
  lastToolEndAt?: number;
  /** Unix timestamp in seconds when stream completion was received */
  completedAt?: number;
  /** Unix timestamp in seconds when final tab metadata persisted */
  persistedAt?: number;
}

export interface StickyTabRecord {
  id: string;
  status: StickyTabStatus;
  prompt: string | null;
  /** @-mention metadata for rendering pills in timeline prompts */
  promptMentions?: StickyTabPromptMention[];
  /** Above-input context pills captured at submit (deduped vs promptMentions) */
  contextMentions?: StickyTabPromptMention[];
  /** Structured comment quote context captured at submit for timeline display */
  commentContext?: StickyTabCommentContext;
  /** Absolute paths of images uploaded with the prompt */
  imageUrls?: string[];
  /**
   * @deprecated Use messages[] instead. Preserved for backward compatibility with old notes.
   */
  responseSummary: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
  todos?: StickyTabTodo[];
  changes?: StickyTabChange[];
  trigger?: 'agent';
  /**
   * @deprecated Use messages[] instead. Preserved for backward compatibility with old notes.
   */
  completionText?: string;
  /** Canonical message storage - array of agent response turns */
  messages?: string[];
  /** Scratch pad markdown content */
  scratchPadContent?: string;
  /** Reason for interruption (only set when status is 'interrupted') */
  interruptReason?: 'trashed' | 'user-cancelled' | 'app-reload';
  /** Model used for this execution (e.g. 'haiku', 'sonnet', 'opus') */
  model?: string;
  /** Routing profile tier that selected the model */
  profile?: 'fast' | 'balanced' | 'quality';
  /** Per-tab execution timing telemetry (all timestamps are Unix seconds) */
  timing?: StickyTabTiming;
  /** Structured latency + usage + streaming metrics for optimization analysis */
  metrics?: ActionTabMetrics;
  /** Keyword-matched ack injected at stream start */
  syntheticAck?: string;
  /** Optional icon for the source context pill shown in the submitted user message */
  sourceContextIconUrl?: string;
  /** Full markdown snapshot of the note at the time this action started executing */
  contentSnapshot?: string;
  /**
   * Error classification for a persisted error tab. Without these, a reloaded
   * error tab lost its streamError, so neutral outcomes (empty_success) reloaded
   * as a red card. The message is reused from `errorMessage`; these carry the
   * rest of the streamError shape so the card reloads with the correct treatment.
   */
  errorCode?: string;
  errorClassification?: string;
  errorRetryable?: boolean;
  errorSeverity?: 'error' | 'neutral';
}

/**
 * Action tab record with new naming convention.
 * Alias for StickyTabRecord during transition period.
 */
export type ActionTabRecord = StickyTabRecord;

export type { NoteContentType };

// ---------------------------------------------------------------------------
// Comment types
// ---------------------------------------------------------------------------

/**
 * Comment is an alias for NoteComment from the shared package (single source of truth).
 * Re-exported here for backward compatibility with existing desktop imports.
 */
export type Comment = NoteComment;

export interface NoteMetadataRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folderPath: string;
  /** Absolute path to the note's canonical markdown content file. */
  contentPath?: string;
  trashedAt?: number | null;
  lastOpenedAt?: number | null;
  contentType?: NoteContentType;
  /** Absolute path to the original external .md file (only present for external notes) */
  externalFilePath?: string;
  /** Root directory for this external note's source tree (for boundary checks and link resolution) */
  externalRootPath?: string;
  /** Per-frontmatter-field provenance metadata (user vs inferred). */
  frontmatterMeta?: FrontmatterMetaMap;
  /** Last successful inference fingerprint for deduping periodic inference runs. */
  frontmatterInference?: FrontmatterInferenceState;
  /** Deterministic cached note hierarchy for structural queries. */
  noteHierarchyCache?: NoteHierarchyCache;
  /** Notes this note links to (outgoing wiki links) */
  outgoingLinks?: LinkInfo[];
  /** Notes that link to this note (backlinks) */
  incomingLinks?: LinkInfo[];
  /** Monotonic counter for cycling user comment colors (persisted in meta.json). */
  nextCommentColorIndex?: number;
  /** Per-comment color indices keyed by comment ID (persisted in meta.json). */
  commentColors?: Record<string, number>;
  /** Collapsed heading identities ("level:text:ordinal") persisted across sessions. */
  collapsedHeadings?: string[];
  /** Whether the note is pinned to the top of the notes panel. */
  pinned?: boolean;
  /** Unix timestamp (seconds) when the note was pinned, or null if unpinned. */
  pinnedAt?: number | null;
}

export interface NoteRecord extends NoteMetadataRecord {
  stickyTabs: StickyTabRecord[];
}

/**
 * Result from updateNote that includes affected links when content changes.
 * affectedLinks contains updated link data for all notes whose links changed:
 * - The updated note itself
 * - Notes that were previously linked but aren't anymore (their backlinks changed)
 * - Notes that are now linked (their backlinks changed)
 */
export interface UpdateNoteResult extends NoteRecord {
  /** Map of noteId -> updated link data for all affected notes */
  affectedLinks?: Record<string, GetLinksResult>;
}

export interface NoteWithContent extends NoteRecord {
  content: string;                              // Markdown (always present for export)
  commentMetadata?: CommentMetadataMap;
  layoutMetadata?: NoteLayoutMetadata;
}

export interface ChatMessageRecord {
  id: string;
  noteId: string;
  role: 'user' | 'agent';
  userId: string | null;
  content: string;
  createdAt: number;
  checkpointId: string | null;
}

export interface VersionCheckpointRecord {
  id: string;
  noteId: string;
  checkpointType: 'mdx' | 'vfs_diff';
  createdAt: number;
  createdBy: 'agent' | 'user';
  versionNumber: number | null;
  label: string | null;
  mdxContent: string | null;
}

export interface UpdateNoteInput {
  title?: string;
  content?: string;                             // Markdown
  commentMetadata?: CommentMetadataMap;
  /** Optional presentation metadata sidecars saved with note content. */
  layoutMetadata?: NoteLayoutMetadata;
  /** Optional compare-and-swap guard for table layout metadata. */
  expectedLayoutMetadata?: NoteLayoutMetadata | null;
  /** Optional compare-and-swap guard for data-integrity writes. */
  expectedDiskContent?: string;
  /** Optional compare-and-swap guard for sidecar comment metadata. */
  expectedCommentMetadata?: CommentMetadataMap;
  /**
   * Resolve stale guards atomically under the note lock by keeping the active
   * editor body and merging compatible latest title/frontmatter/comments.
   */
  activeUserWins?: boolean;
  updatedAt?: number;
  stickyTabs?: StickyTabRecord[];
  /** Per-field frontmatter source updates merged into existing metadata. */
  frontmatterMetaUpdates?: FrontmatterMetaMap;
  /**
   * Frontmatter-meta keys to delete after the merge. Because
   * `frontmatterMetaUpdates` is merge-applied, an aged-out inferred key that the
   * update omits would otherwise linger; the inference path lists such keys here
   * so their stale provenance is cleared. Never includes user-owned keys.
   */
  frontmatterMetaRemovals?: string[];
  /** Latest successful inference content hash metadata. */
  frontmatterInference?: FrontmatterInferenceState | null;
  /** Cached deterministic hierarchy payload for this note. */
  noteHierarchyCache?: NoteHierarchyCache;
  trashedAt?: number | null;
  lastOpenedAt?: number | null;
  /** Monotonic counter for cycling user comment colors. */
  nextCommentColorIndex?: number;
  /** Per-comment color indices keyed by comment ID. */
  commentColors?: Record<string, number>;
  /** Collapsed heading identities ("level:text:ordinal") persisted across sessions. */
  collapsedHeadings?: string[];
  /** Whether the note is pinned to the top of the notes panel. */
  pinned?: boolean;
  /** Unix timestamp (seconds) when the note was pinned, or null if unpinned. */
  pinnedAt?: number | null;
}

export type FrontmatterFieldSource = 'user' | 'inferred' | 'user-removed';

export interface FrontmatterFieldMeta {
  source: FrontmatterFieldSource;
  /** Unix timestamp (seconds) of the last source update for this field. */
  lastModified: number;
  /** Consecutive inference passes that omitted this field (only for source: 'inferred'). */
  missedInferenceCount?: number;
}

export type FrontmatterMetaMap = Record<string, FrontmatterFieldMeta>;

export interface FrontmatterInferenceState {
  /** Content hash used for the latest successful inference run. */
  contentHash: string;
  /** Unix timestamp (seconds) when inference was last applied. */
  updatedAt: number;
}

export interface NoteHeadingNode {
  id: string;
  text: string;
  level: number;
  line: number;
  children: NoteHeadingNode[];
}

export interface NoteBlockDiff {
  added: string[];
  removed: string[];
  modified: string[];
  unchanged: string[];
}

export interface NoteHierarchyLinkInternal {
  id: string;
  displayName?: string;
}

export interface NoteHierarchyLinkExternal {
  url: string;
}

export interface NoteHierarchyLinkEmbed {
  url: string;
  mimeType?: string;
}

export interface NoteHierarchyLinks {
  internal: NoteHierarchyLinkInternal[];
  external: NoteHierarchyLinkExternal[];
  embed: NoteHierarchyLinkEmbed[];
}

export interface NoteHierarchyComment {
  id: string;
  text: string;
  position?: {
    line: number;
    start: number;
    end: number;
  };
}

export interface NoteHierarchyStickyTab {
  id: string;
  status: StickyTabRecord['status'];
  createdAt: number;
  completedAt: number | null;
  prompt: string | null;
  responseSummary: string | null;
}

export interface NoteHierarchyTimeline {
  id: string;
  events: Array<{
    type: 'created' | 'completed' | 'error' | 'interrupted' | 'pending';
    at: number;
  }>;
}

export interface NoteHierarchyData {
  headings: NoteHeadingNode[];
  /** Bounded markdown-stripped lead/body text for lightweight related-note topic overlap. */
  contentSignalText?: string;
  nodeTypes: string[];
  wordCount: number;
  links: NoteHierarchyLinks;
  taskCount: {
    total: number;
    completed: number;
  };
  comments: NoteHierarchyComment[];
  stickyTabs: NoteHierarchyStickyTab[];
  timelines: NoteHierarchyTimeline[];
}

export interface NoteHierarchyCache {
  /** Content hash of the markdown used to build this cache. */
  contentHash: string;
  /** Stable block-id to hash map used for cheap diffing between parses. */
  blockHashes: Record<string, string>;
  /** Coarse block-level diff relative to the previous cached parse. */
  changedBlocksDiff: NoteBlockDiff;
  /** Parsed deterministic hierarchy payload. */
  hierarchy: NoteHierarchyData;
  /** Unix timestamp (seconds) when this hierarchy cache was generated. */
  updatedAt: number;
}

/**
 * Notes context input for agent execution.
 * Targets a specific note file for editing.
 */
export interface NotesContextInput {
  /** Notes mode - targets a specific note file */
  context: 'notes';
  /** ID of the note to edit (required for notes context) */
  noteId: string;
  /** ID of the action tab tracking this execution */
  tabId: string;
  /** User prompt for the agent (may include selection prefix) */
  prompt: string;
  /** Original user-typed prompt without selection prefix, used for execution profile routing */
  rawPrompt?: string;
  /** Current note content (markdown) */
  content?: string;
  /** Note title from renderer (avoids redundant getNote read in main) */
  noteTitle?: string;
  /** Origin of the prompt, used for routing and tuning behavior */
  promptSource?: 'prompt' | 'comment';
  /** Note IDs referenced via @-mention, whose content is included as context */
  referencedNoteIds?: string[];
  /** Directory paths referenced via @-mention for agent exploration */
  referencedDirectories?: string[];
  /** Enabled connected folder paths for agent context */
  connectedFolderPaths?: string[];
  /** Absolute paths to attached images for agent context */
  imageUrls?: string[];
  /** Relative image paths from comment context (annotated ImageNode src + comment attachments). Resolved in main. */
  commentImagePaths?: string[];
  /** Canonical comments.json sidecar path for the active note. */
  commentSidecarPath?: string;
  /** Total file count across connected folders + referenced directories (for routing) */
  externalFileCount?: number;
  /** Stage timing markers captured in renderer before dispatch */
  clientTiming?: AgentClientTimingInput;
  /** Skill modules to inject beyond the always-inject set (e.g. 'html' via + menu). */
  skills?: string[];
}

export interface AgentClientTimingInput {
  submitClickedAtMs?: number;
  preflightDoneAtMs?: number;
  ipcExecuteSentAtMs?: number;
}

/**
 * Agent execution input type - targets a specific note file for editing.
 */
export type AgentExecuteInput = NotesContextInput;

/**
 * Slim delta result for agent execution.
 * Contains only the changed data needed to update the renderer state,
 * avoiding transfer of full note content that the renderer already has.
 */
export interface AgentExecuteResultDelta {
  noteId: string;
  stickyTabs: StickyTabRecord[];
  updatedAt: number;
  /** Updated note title when execution changes the first H1 heading */
  title?: string;
  /** Updated canonical content path when execution renames or relocates the note file. */
  contentPath?: string;
  /** Updated comment metadata when the agent wrote comments.json directly. */
  commentMetadata?: CommentMetadataMap;
  executedTabId: string;
  createdTabId: string;
  /** Metadata for notes created by the agent (new directories with note.md) */
  createdNotes?: NoteMetadataRecord[];
}

export interface FileSearchInput {
  query: string;
  limit?: number;
}

export interface FileSearchResult {
  id: string;
  title: string;
  path: string;
  type: 'note' | 'file' | 'directory' | 'folder';
}

export interface FileListDirectoryInput {
  dirPath: string;
}

export interface NoteSearchInput {
  query: string;
  limit?: number;
  /** Exclude a specific note from results (e.g., the currently active note) */
  excludeNoteId?: string;
  /** When true, search trashed notes instead of active notes */
  searchTrashed?: boolean;
}

export interface NoteSearchResult {
  id: string;
  title: string;
  folderPath?: string;
  updatedAt?: number;
  contentType?: NoteContentType;
  /** Content snippet around the first match (when matched by content) */
  snippet?: string;
  /** Whether this result matched by title or content */
  matchType?: 'title' | 'content';
}

export interface ResolveLinkInput {
  noteTitle: string;
}

export interface ResolveLinkResult {
  noteId: string | null;
  noteTitle: string;
  isResolved: boolean;
  preview?: string;
  updatedAt?: number;
  folderPath?: string;
}

/**
 * @deprecated Use `NoteLink` from `@moss/shared/types/note-entity` instead.
 * This alias is preserved for backward compatibility.
 */
export type { LinkInfo };

export interface GetLinksResult {
  outgoing: LinkInfo[];  // Notes this note links to
  incoming: LinkInfo[];  // Notes that link to this note
}

// Image handling types
export interface ImageSaveInput {
  /** Base64-encoded image data (without data URL prefix) */
  data: string;
  /** Original filename or suggested name */
  filename: string;
  /** MIME type of the image */
  mimeType: string;
  /** Optional note ID to save under note-local assets */
  noteId?: string;
}

export interface ImageSaveResult {
  /** Workspace-relative path to the saved image */
  relativePath: string;
  /** Absolute path for display/loading */
  absolutePath: string;
  /** Original filename */
  filename: string;
}

export interface ImagePickResult {
  /** Workspace-relative path to the image */
  relativePath: string;
  /** Absolute path for display/loading */
  absolutePath: string;
  /** Original filename */
  filename: string;
}

export interface ImagePickInput {
  /** Optional note ID to copy under note-local assets */
  noteId?: string;
}

export interface ImagePersistUrlInput {
  /** Note ID for note-local asset persistence */
  noteId: string;
  /** Remote image URL */
  url: string;
  /** Optional filename hint */
  filename?: string;
}

export interface ImageCopyFromPathInput {
  /** Absolute filesystem path to an existing local image file */
  filePath: string;
  /** Optional note ID to copy under note-local assets */
  noteId?: string;
  /** Optional filename hint for the copied asset */
  filename?: string;
}

export interface ImageCopyFromNoteAssetInput {
  /** Source note containing the asset to copy */
  sourceNoteId: string;
  /** Source note-relative asset path (e.g. assets/foo.png, assets/foo.mp4, assets/foo.html) */
  sourceRelativePath: string;
  /** Destination note receiving the copied asset */
  destinationNoteId: string;
  /** Optional destination filename hint (defaults to source basename) */
  filename?: string;
}

// Node analysis types for content classification
export type NoteNodeType =
  | 'paragraph'
  | 'heading'
  | 'listitem'
  | 'checklist'
  | 'code'
  | 'table'
  | 'image'
  | 'chart'
  | 'sketch'
  | 'link'
  | 'fileLink'
  | 'formula'
  | 'text'
  | 'other';

export interface NoteNode {
  /** Node type category */
  type: NoteNodeType;
  /** Original Lexical node type */
  lexicalType: string;
  /** Text content if applicable */
  text?: string;
  /** Character count for text nodes */
  characterCount?: number;
  /** Heading level (1-6) for heading nodes */
  level?: number;
  /** Language for code blocks */
  language?: string;
  /** Source URL for images */
  src?: string;
  /** Alt text for images */
  alt?: string;
  /** Link URL for link nodes */
  url?: string;
  /** Note title for file links */
  noteTitle?: string;
  /** Raw node data for debugging */
  raw?: Record<string, unknown>;
}

export interface NoteNodesResult {
  noteId: string;
  /** Array of all nodes in the note */
  nodes: NoteNode[];
}

/** Response from getNoteContent for the notes:getContent IPC channel */
export interface NoteContentResult {
  /** Note ID */
  id: string;
  /** Markdown content */
  content: string;
  /** Structured comment metadata loaded from sidecar or legacy footer. */
  commentMetadata?: CommentMetadataMap;
  /** Optional presentation metadata loaded from layout.json. */
  layoutMetadata?: NoteLayoutMetadata;
  /** Version number for optimistic concurrency control (future use) */
  version: number;
}

export interface NoteTableLayoutMetadata {
  columnWidths?: number[];
}

export interface NoteTabGroupLayoutMetadata {
  tabWidths?: (number | null)[];
  panelLabels?: string[];
}

export interface NoteLayoutMetadata {
  version: 1;
  tableCount: number;
  tables: NoteTableLayoutMetadata[];
  tabGroupCount?: number;
  tabGroups?: NoteTabGroupLayoutMetadata[];
}

export type NoteContentReadMode = 'editor' | 'raw';

export interface NoteReadOptions {
  /**
   * Controls read-time markdown compatibility transforms.
   * - editor: apply in-memory transforms needed to safely hydrate the editor.
   * - raw: return disk markdown byte-for-byte for background scans/search.
   */
  contentReadMode?: NoteContentReadMode;
  /** Background reads can skip sidecar/footer hydration when they only need markdown text. */
  includeCommentMetadata?: boolean;
  /** Background reads should not emit comment migration analytics/observations. */
  emitCommentMigrationEvents?: boolean;
}

export const RAW_BACKGROUND_NOTE_READ_OPTIONS: Readonly<Required<NoteReadOptions>> = Object.freeze({
  contentReadMode: 'raw',
  includeCommentMetadata: false,
  emitCommentMigrationEvents: false
});

export interface PdfExportCommentSnapshot {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
  color: number;
  source?: 'user' | 'agent' | 'external';
  imageUrl?: string;
  imageUrls?: string[];
}

export interface PdfExportSessionPayload {
  noteId: string;
  title: string;
  markdown: string;
  renderedHtml?: string;
  serializedEditorState?: unknown;
  commentsMap?: Record<string, PdfExportCommentSnapshot>;
  collapsedHeadingIdentities?: string[];
  tabGroupActiveIndices?: number[];
}

export type PdfExportPath = 'renderer-backed' | 'fallback';

export interface ExportNotePdfInput {
  title: string;
  markdown: string;
  /** Optional rendered HTML snapshot captured from the editor DOM. */
  renderedHtml?: string;
  /** Optional serialized Lexical state captured from the live editor. */
  serializedEditorState?: unknown;
  /** Runtime comments map so print rendering preserves highlight colors. */
  commentsMap?: Record<string, PdfExportCommentSnapshot>;
  /** Collapsed heading identities from the visible note state. */
  collapsedHeadingIdentities?: string[];
  /** Active tab indices captured from the visible note state. */
  tabGroupActiveIndices?: number[];
}

export interface ExportNotePdfResult {
  canceled: boolean;
  filePath?: string;
  exportPath?: PdfExportPath;
}

export interface ExportNoteMarkdownInput {
  title: string;
  markdown: string;
}

export interface ExportNoteMarkdownResult {
  canceled: boolean;
  filePath?: string;
}

/** Frontmatter typeahead suggestion pools across workspace notes. */
export type FrontmatterTypeaheadSuggestions = Record<string, string[]>;

/** Options for creating an external note */
export interface CreateExternalNoteOptions {
  /** Root directory of the external source tree (for boundary checks and link resolution) */
  externalRootPath?: string;
}

/**
 * Result of resolving an OS/default-editor markdown open. Workspace-local files
 * resolve to the internal note; files outside the workspace open as External.
 */
export type MarkdownOpenTarget =
  | { kind: 'internal'; noteId: string }
  | { kind: 'external'; note: NoteRecord }
  | null;

/** Outcome of the bounded workspace-local External alias cleanup migration. */
export interface WorkspaceLocalAliasMigrationResult {
  /** Alias note ids whose metadata directory was removed. */
  removedNoteIds: string[];
  /** Alias note ids preserved (open in a window, carry state, or unresolved target). */
  deferredNoteIds: string[];
  /** Number of workspace-local External aliases inspected. */
  scannedAliasCount: number;
}

/** Outcome of pruning stale/noisy External aliases from the user-visible list. */
export interface MissingExternalAliasCleanupResult {
  /** Empty alias mirrors removed directly. */
  removedNoteIds: string[];
  /** Stateful alias mirrors moved to system Trash before unregistering. */
  trashedNoteIds: string[];
  /** Missing aliases preserved because they are open or could not be cleaned. */
  deferredNoteIds: string[];
  /** Number of candidate aliases inspected. */
  scannedAliasCount: number;
}

/** Result from retrying asset localization for an external note */
export interface RetryExternalAssetsResult {
  /** Note ID that was retried */
  noteId: string;
  /** Number of assets attempted */
  attempted: number;
  /** Number of assets successfully recovered */
  recovered: number;
  /** Number of assets still missing/errored */
  remaining: number;
  /** Number of stale manifest entries pruned */
  prunedEntries: number;
  /** Number of stale local files pruned */
  prunedFiles: number;
}

export interface AdoptOrphanNotesOptions {
  paths?: string[];
}

export interface NoteStore {
  listNoteMetadata(): Promise<NoteMetadataRecord[]>;
  /** Targeted metadata read for a known set of note IDs (no full workspace scan, read-only). */
  getNoteMetadataByIds(noteIds: string[]): Promise<NoteMetadataRecord[]>;
  /** Aggregate saved frontmatter values without opening notes or mutating content. */
  getWorkspaceFrontmatterSuggestions(): Promise<FrontmatterTypeaheadSuggestions>;
  getNote(noteId: string, options?: NoteReadOptions): Promise<NoteWithContent | undefined>;
  /** Get note content (markdown) and version for the notes:getContent IPC channel */
  getNoteContent(noteId: string, options?: NoteReadOptions): Promise<NoteContentResult | undefined>;
  createNote(title: string, folderPath?: string, systemNoteType?: string): Promise<NoteWithContent>;
  /** Create a temporary note backed by an external .md file */
  createExternalNote(filePath: string, options?: CreateExternalNoteOptions): Promise<NoteRecord | null>;
  /** Validate and register an external note in memory only (no mirror-dir writes). Returns a NoteRecord for immediate sidebar display. */
  registerExternalNoteInMemory(filePath: string, options?: CreateExternalNoteOptions): Promise<NoteRecord | null>;
  /** Persist a pending external note to disk (mkdir + meta.json). No-op if already persisted. */
  ensureExternalNotePersisted(noteId: string): Promise<void>;
  /** Persist all pending external notes in batched background I/O. */
  persistPendingExternalNotes(): Promise<void>;
  /** Remove all external notes from the workspace */
  cleanupExternalNotes(): Promise<void>;
  /** Close a single external note (remove metadata, don't touch source file) */
  closeExternalNote(noteId: string): Promise<boolean>;
  /** Close all external notes from a given root directory */
  closeExternalNotesByRoot(externalRootPath: string): Promise<string[]>;
  /** Cheap path-boundary check: is this absolute markdown path inside the active Moss workspace roots? */
  isWorkspaceLocalPath(filePath: string): boolean;
  /** Symlink-following path-boundary check for existing markdown paths. */
  isWorkspaceLocalPathResolved(filePath: string): Promise<boolean>;
  /**
   * General "open markdown path" flow shared by the OS/default-editor open hook and
   * external imports. Workspace-local files resolve/adopt the internal note (no
   * External alias); files outside the workspace open as External notes.
   */
  openMarkdownPath(filePath: string): Promise<MarkdownOpenTarget>;
  /**
   * Bounded background migration that safely removes External aliases pointing back
   * inside the workspace. Aliases open in any window (per the optional isNoteOpen
   * predicate) or carrying user-visible state are deferred; source markdown is never
   * touched. Idempotent.
   */
  migrateWorkspaceLocalExternalAliases(
    options?: { isNoteOpen?: (noteId: string) => boolean }
  ): Promise<WorkspaceLocalAliasMigrationResult>;
  /**
   * Remove broken or generated-output External sidebar entries. Empty alias
   * mirrors are deleted; mirrors with local-only state are moved to system Trash
   * before unregistering so the state remains recoverable.
   */
  cleanupMissingExternalNotes(
    options?: { isNoteOpen?: (noteId: string) => boolean }
  ): Promise<MissingExternalAliasCleanupResult>;
  /**
   * Resolve a wiki-link target inside an external note to a sibling markdown
   * file on disk under the same external root, registering it if needed.
   * Returns the matching note record, or null when no sibling matches.
   */
  resolveExternalLinkTarget(sourceNoteId: string, target: string): Promise<NoteRecord | null>;
  updateNote(noteId: string, input: UpdateNoteInput): Promise<UpdateNoteResult | undefined>;
  deleteNote(noteId: string): Promise<boolean>;
  restoreNote(noteId: string): Promise<NoteRecord | undefined>;
  getNoteFilesystemPaths(
    noteId: string
  ): Promise<
    | {
        noteId: string;
        dirPath: string;
        folderName: string;
        metadataPath: string;
        contentPath: string;
        commentMetadataPath?: string;
        watchPaths?: string[];
        externalFilePath?: string;
        externalRootPath?: string;
      }
    | undefined
  >;
  /** Migrate existing notes to include contentType in metadata */
  migrateContentTypes(): Promise<number>;
  /** Resolve a note by title using the title index for O(1) lookup */
  resolveNoteByTitle(
    title: string
  ): Promise<{
    noteId: string;
    metadata: NoteMetadataRecord;
    preview?: string;
  } | null>;
  /** Get incoming and outgoing links for a note */
  getLinks(noteId: string): Promise<GetLinksResult>;
  /** Wait for the background backlink index to finish building (deferred at startup) */
  waitForBacklinkIndex(): Promise<void>;
  /** Returns the error if backlink indexing failed, or null if it succeeded/is still running */
  getBacklinkIndexError(): Error | null;
  /** Get headings (h1-h4) from a note's markdown content */
  getHeadings(noteId: string): Promise<HeadingInfo[]>;
  // Folder operations
  listFolders(options?: ListFoldersOptions): Promise<FolderEntry[]>;
  createFolder(input: CreateFolderInput): Promise<FolderEntry>;
  /** Ensure a folder exists and is registered in the index. Creates if missing. */
  ensureFolder(name: string, type?: 'system'): Promise<void>;
  renameFolder(input: RenameFolderInput): Promise<FolderEntry>;
  moveFolder(input: MoveFolderInput): Promise<FolderEntry>;
  deleteFolder(input: DeleteFolderInput): Promise<boolean>;
  moveNotesToFolder(input: MoveNotesToFolderInput): Promise<NoteMetadataRecord[]>;
  /** Map an absolute file path back to a primary note ID using the internal path index */
  getNoteIdForFilePath(filePath: string): string | undefined;
  /**
   * Map an absolute file path back to every note ID backed by that file.
   *
   * A source markdown file can be represented by both its canonical internal note
   * and an External note alias. Disk-change notifications must target every open
   * alias so editors viewing the External note refresh too.
   */
  getNoteIdsForFilePath?(filePath: string): string[];
  /** Register an agent-created directory (has note.md but no meta.json) as a proper note */
  adoptOrphanNote(dirPath: string): Promise<NoteMetadataRecord | null>;
  /** Scan note directories for orphans and adopt them all */
  adoptOrphanNotes(options?: AdoptOrphanNotesOptions): Promise<NoteMetadataRecord[]>;
  /** Wait for the deferred startup orphan adoption to complete (no-op in test mode). */
  awaitStartupOrphanAdoption?(): Promise<void>;
  /** Await any in-flight deferred folder-reorg flush (agent-idle backlog). */
  awaitPendingAgentIdleFlush?(): Promise<void>;
  /** Walk active notes and remove "aborted note" directories (no .md/meta/folder marker/assets, stale mtime). Returns count removed. */
  pruneEmptyNoteDirectories(): Promise<number>;
  /** Force a metadata index rebuild from disk (used by fs watcher reconciliation). */
  refreshMetadataFromDisk?(): Promise<void>;
  /** Refresh metadata only for the changed paths when a full rebuild is unnecessary. */
  refreshMetadataForPaths?(changedPaths: string[]): Promise<string[]>;
  /** Import newly discovered markdown files under already-tracked external roots. */
  reconcileExternalNotesFromPaths?(
    changedPaths: string[],
    options?: {
      externalRoots?: string[];
    }
  ): Promise<NoteRecord[]>;
  /**
   * Remove notes whose on-disk content was deleted or moved away. Scoped — never
   * triggers a full rebuildMetadataIndex. Returns the IDs of removed notes.
   */
  pruneMissingNotesForPaths?(changedPaths: string[]): Promise<string[]>;
  /** Localize external image references into note-local assets/ directory */
  localizeExternalImages?(noteId: string, markdown: string, externalRootPath: string): Promise<{ markdown: string }>;
  /** Invalidate external asset localization cache for all notes whose .md lives in the given directory */
  invalidateExternalAssetCacheByDir?(dir: string): void;
  /** Retry localization for entries with missing/error status */
  retryExternalAssetLocalization?(noteId: string): Promise<{ attempted: number; recovered: number; remaining: number }>;
  /** Prune stale asset entries unreferenced >30 days */
  pruneStaleAssets?(noteId: string): Promise<{ prunedEntries: number; prunedFiles: number }>;
  /** Invalidate a single note's metadata cache entry so the next read re-fetches from disk */
  invalidateMetadataCache(noteId: string): void;
  /** Finalize any pending source-asset deletions for a note once no editor session keeps it open. */
  finalizePendingSourceAssetDeletes(noteId: string): Promise<void>;
  /** Finalize all pending source-asset deletions during app shutdown or test teardown. */
  finalizeAllPendingSourceAssetDeletes(): Promise<void>;
  /** Returns directory roots explicitly opened for recursive external-note import. */
  getExternalNoteParentDirs(): Set<string>;
  /** Returns exact external files that are not covered by a recursive directory root. */
  getExternalNoteFilePaths?(): Set<string>;
  /** Updates all external notes under oldRoot to point to newRoot. Returns affected note IDs. */
  replaceExternalRoot(oldRoot: string, newRoot: string): Promise<string[]>;
  /** Re-reads H1 from a note's content file and updates the metadata title if changed. */
  syncNoteTitleFromH1?(noteId: string): Promise<boolean>;
  /** Materialize HTML preview sidecars for the editor-facing markdown projection. */
  materializeHtmlPreviewsForNote?(
    noteId: string,
    priority?: 'visible' | 'background'
  ): Promise<void>;
  /** Materialize derived media sidecars such as local-video thumbnails. */
  materializeMediaPreviewsForNote?(
    noteId: string,
    priority?: 'visible' | 'background'
  ): Promise<void>;
  /** Await pending background external-image-localization jobs (test helper) */
  awaitPendingExternalLocalization?(noteId?: string): Promise<void>;
  /** Dispose background store work such as periodic orphan scans. */
  close?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Folder types (filesystem-based folders)
// ---------------------------------------------------------------------------

/** Metadata stored in .folder.json within folder directories */
export interface FolderMetadataFile {
  /** Unix timestamp when folder was created */
  createdAt: number;
  /** System folder (currently only External) */
  type?: 'system';
}

/** Folder entry returned from folder operations */
export interface FolderEntry {
  /** Display name (last segment of path) */
  name: string;
  /** Full path e.g., "Notes/Projects" */
  path: string;
  /** Number of notes in this folder */
  noteCount: number;
  /** Unix timestamp when folder was created (from .folder.json) */
  createdAt?: number;
  /** System folder (currently only External) */
  type?: 'system';
}

export interface ListFoldersOptions {
  /**
   * When true, prune empty folders before returning folder entries.
   * Used when the active note changes so stale empty folders disappear.
   */
  cleanupEmpty?: boolean;
}

/** Input for creating a new folder */
export interface CreateFolderInput {
  /** @deprecated Legacy local user ID placeholder; ignored for local folders. */
  userId?: string;
  /** Folder name (will be sanitized) */
  name: string;
  /** Note IDs to move into the new folder */
  noteIds?: string[];
  /** Parent folder path to create inside (e.g., "Notes/Projects"). Omit for top-level. */
  parentPath?: string;
}

/** Input for renaming a folder */
export interface RenameFolderInput {
  /** @deprecated Legacy local user ID placeholder; ignored for local folders. */
  userId?: string;
  /** Current folder path */
  currentPath: string;
  /** New folder name */
  newName: string;
}

/** Input for deleting a folder */
export interface DeleteFolderInput {
  /** @deprecated Legacy local user ID placeholder; ignored for local folders. */
  userId?: string;
  /** Folder path to delete */
  path: string;
  /** What to do with notes in the folder: move to root or trash them */
  moveNotesTo: 'root' | 'trash';
}

/** Input for moving notes to a folder */
export interface MoveNotesToFolderInput {
  /** @deprecated Legacy local user ID placeholder; ignored for local folder moves. */
  userId?: string;
  /** Note IDs to move */
  noteIds: string[];
  /** Target folder path (use "Notes" for root) */
  targetFolderPath: string;
}

/** Input for moving a folder to a new parent (reparenting) */
export interface MoveFolderInput {
  /** @deprecated Legacy local user ID placeholder; ignored for local folder moves. */
  userId?: string;
  /** Full folder path to move, e.g. "Notes/Projects" */
  sourcePath: string;
  /** Target parent folder path, e.g. "Notes/Archive" or "Notes" for root */
  targetParentPath: string;
}

// ---------------------------------------------------------------------------
// Filesystem browser types
// ---------------------------------------------------------------------------

/** A single entry (file or directory) in a directory listing */
export interface DirectoryEntry {
  /** Entry name (filename or folder name) */
  name: string;
  /** Full absolute path */
  path: string;
  /** Whether this is a directory */
  isDirectory: boolean;
}

/** Result from reading a directory */
export interface ReadDirectoryResult {
  /** The path that was read */
  path: string;
  /** Entries in the directory */
  entries: DirectoryEntry[];
  /** Error message if the read failed */
  error?: string;
}

/** Result from reading a file */
export interface ReadFileResult {
  /** The file content (text for text files, base64 for binary) */
  content: string;
  /** Total file size in bytes */
  size: number;
  /** Whether the content was truncated (true if file > 100KB) */
  truncated: boolean;
  /** Detected MIME type */
  mimeType: string;
  /** Whether this is a text file */
  isText: boolean;
  /** Error message if the read failed */
  error?: string;
}

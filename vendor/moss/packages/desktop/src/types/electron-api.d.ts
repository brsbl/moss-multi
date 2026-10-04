// ported-from: packages/desktop/src/types/electron-api.d.ts @ 762abb777
import type {
  AgentExecuteInput,
  AgentExecuteResultDelta,
  ChatMessageRecord,
  CreateFolderInput,
  DeleteFolderInput,
  FileListDirectoryInput,
  FileSearchInput,
  FileSearchResult,
  ExportNoteMarkdownInput,
  ExportNoteMarkdownResult,
  ExportNotePdfInput,
  ExportNotePdfResult,
  PdfExportSessionPayload,
  FrontmatterTypeaheadSuggestions,
  FolderEntry,
  HeadingInfo,
  ListFoldersOptions,
  ImagePickResult,
  ImagePickInput,
  ImageCopyFromPathInput,
  ImageCopyFromNoteAssetInput,
  ImagePersistUrlInput,
  ImageSaveInput,
  ImageSaveResult,
  MoveFolderInput,
  MoveNotesToFolderInput,
  NoteContentReadMode,
  NoteContentResult,
  NoteMetadataRecord,
  NotesFlushCompletePayload,
  NoteRecord,
  NoteSearchInput,
  NoteSearchResult,
  NoteWithContent,
  ReadDirectoryResult,
  ReadFileResult,
  RenameFolderInput,
  UpdateNoteInput,
  UpdateNoteResult,
  VersionCheckpointRecord
} from '../common/noteTypes';
import type { MossAutomationController } from '../common/automation';
import type {
  DerivedPreviewMaterializedPushPayload,
  ThemeChoice
} from '../common/ipcChannels';
import type {
  DerivedPreviewKind,
  DerivedPreviewResult,
  DerivedPreviewStatus
} from '../common/derived-preview';
import type { EnsureWebEmbedPreviewInput } from '../common/web-embed-preview';
import type {
  RemoteWebSurfaceBoundsInput,
  RemoteWebSurfaceCreateInput,
  RemoteWebSurfaceCommandPaletteShortcutState,
  RemoteWebSurfaceDestroyForNoteInput,
  RemoteWebSurfaceDestroyInput,
  RemoteWebSurfaceFindInput,
  RemoteWebSurfaceFocusedState,
  RemoteWebSurfaceFindShortcutState,
  RemoteWebSurfaceFindResultState,
  RemoteWebSurfaceMenuInput,
  RemoteWebSurfaceNavigationState,
  RemoteWebSurfaceResult,
  RemoteWebSurfaceSavePdfResult,
  RemoteWebSurfaceSelectionState
} from '../common/remote-web-surface';
export interface GetByIdOptions {
  signal?: AbortSignal;
  skipAnalytics?: boolean;
}

export interface GetContentOptions {
  contentReadMode?: NoteContentReadMode;
}

export interface NotesApi {
  getAll(): Promise<NoteMetadataRecord[]>;
  getMetadataByIds(noteIds: string[]): Promise<NoteMetadataRecord[]>;
  getById(noteId: string, options?: GetByIdOptions): Promise<NoteWithContent | undefined>;
  getContent(noteId: string, options?: GetContentOptions): Promise<NoteContentResult | undefined>;
  getFrontmatterSuggestions?(): Promise<FrontmatterTypeaheadSuggestions>;
  getHeadings(noteId: string): Promise<HeadingInfo[]>;
  create(title: string, folderPath?: string): Promise<NoteWithContent>;
  update(noteId: string, input: UpdateNoteInput): Promise<UpdateNoteResult | undefined>;
  delete(noteId: string): Promise<boolean>;
  restore(noteId: string): Promise<NoteRecord | undefined>;
  search(input: NoteSearchInput): Promise<NoteSearchResult[]>;
  getFilesystemPath?(noteId: string): Promise<string | undefined>;
  setOpenFileWatchTargets?(noteIds: string[]): Promise<void>;
  copyLinkToClipboard?(
    noteId: string,
    input: {
      noteTitle?: string;
      wikiLink?: string;
      surface?: string;
      shareSessionId?: string;
    }
  ): Promise<boolean>;
  showInFinder(noteId: string): Promise<void>;
  getPdfExportSession?(sessionId: string): Promise<PdfExportSessionPayload | null>;
  createPdfExportSession?(noteId: string, input: ExportNotePdfInput): Promise<string | null>;
  openPdfExportPreview?(sessionId: string): Promise<number | null>;
  openPdfExportRenderSurface?(sessionId: string): Promise<number | null>;
  exportPdf?(noteId: string, input: ExportNotePdfInput): Promise<ExportNotePdfResult>;
  exportMarkdown?(noteId: string, input: ExportNoteMarkdownInput): Promise<ExportNoteMarkdownResult>;
  onExternalFileOpen(callback: (noteId: string) => void): () => void;
  onInternalFileOpen(callback: (noteId: string) => void): () => void;
  onDiskChange(callback: (noteIds: string[], contentNoteIds?: string[]) => void): () => void;
  onMetadataReindexed(callback: (noteIds: string[]) => void): () => void;
  onRequestFlush(callback: () => void): () => void;
  flushComplete(payload?: NotesFlushCompletePayload): Promise<void>;
}

export interface FoldersApi {
  list(options?: ListFoldersOptions): Promise<FolderEntry[]>;
  create(input: CreateFolderInput): Promise<FolderEntry>;
  rename(input: RenameFolderInput): Promise<FolderEntry>;
  delete(input: DeleteFolderInput): Promise<boolean>;
  moveNotes(input: MoveNotesToFolderInput): Promise<NoteMetadataRecord[]>;
  moveFolder(input: MoveFolderInput): Promise<FolderEntry>;
  showInFinder(folderPath: string): Promise<void>;
}

export interface ChatApi {
  getMessages(noteId: string): Promise<ChatMessageRecord[]>;
}

export interface CheckpointsApi {
  getAll(noteId: string): Promise<VersionCheckpointRecord[]>;
}

export interface AgentError {
  code: 'AUTH_REQUIRED' | 'AUTH_INVALID' | 'RATE_LIMITED' | 'NETWORK' | 'SDK_ERROR' | 'CANCELLED' | 'UNKNOWN';
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

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
      /** Whether re-running the original prompt is offered ("Try again"). */
      retryable?: boolean;
      /** Card treatment: 'error' (red) vs 'neutral' (muted, e.g. empty_success). */
      severity?: 'error' | 'neutral';
    }
  | {
      type: 'editor_update';
      tabId: string;
      noteId: string;
      content: string;
    };

export interface AgentApi {
  execute(input: AgentExecuteInput): Promise<AgentExecuteResultDelta>;
  cancel(noteId: string): Promise<void>;
  cancelByTabId(tabId: string): Promise<void>;
  onStream(callback: (data: AgentStreamEvent) => void): () => void;
}

export interface FilesApi {
  search(input: FileSearchInput): Promise<FileSearchResult[]>;
  listDirectory(input: FileListDirectoryInput): Promise<FileSearchResult[]>;
  open(input?: { surface?: 'notes_list_header' | 'native_menu'; paths?: string[] }): Promise<NoteRecord[]>;
}

export interface ImagesApi {
  save(input: ImageSaveInput): Promise<ImageSaveResult>;
  pick(input?: ImagePickInput): Promise<ImagePickResult[]>;
  persistUrl(input: ImagePersistUrlInput): Promise<ImageSaveResult>;
  copyFromPath(input: ImageCopyFromPathInput): Promise<ImageSaveResult>;
  copyFromNoteAsset?(input: ImageCopyFromNoteAssetInput): Promise<ImageSaveResult>;
}

export interface HtmlPreviewMaterializedEntry {
  descriptorKey: string;
  relativePath: string;
  source?: 'cache' | 'legacy-cache' | 'generated';
}

export interface HtmlPreviewMaterializedPayload {
  noteId: string;
  previews: HtmlPreviewMaterializedEntry[];
  result?: { total: number; reused: number; generated: number; failed: number };
}

export interface HtmlPreviewFailedEntry {
  descriptorKey: string;
  relativePath: string;
  reason?: string;
}

export interface HtmlPreviewFailedPayload {
  noteId: string;
  previews: HtmlPreviewFailedEntry[];
  result?: { total: number; reused: number; generated: number; failed: number };
}

export interface HtmlPreviewApi {
  ensure(input: {
    noteId: string;
    rawHtml: string;
    priority?: 'visible' | 'background';
    force?: boolean;
  }): Promise<{ relativePath: string; source?: 'cache' | 'legacy-cache' | 'generated' } | null>;
  onMaterialized(callback: (payload: HtmlPreviewMaterializedPayload) => void): () => void;
  onFailed(callback: (payload: HtmlPreviewFailedPayload) => void): () => void;
}

export interface WebEmbedPreviewApi {
  ensure(input: EnsureWebEmbedPreviewInput): Promise<DerivedPreviewResult | null>;
  subscribe(callback: (payload: DerivedPreviewMaterializedPushPayload) => void): () => void;
}

export interface RemoteWebSurfaceApi {
  create(input: RemoteWebSurfaceCreateInput): Promise<RemoteWebSurfaceResult>;
  updateBounds(input: RemoteWebSurfaceBoundsInput): Promise<RemoteWebSurfaceResult>;
  hide(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  goBack(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  goForward(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  findInPage(input: RemoteWebSurfaceFindInput): Promise<RemoteWebSurfaceResult>;
  openPageFind(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  stopFindInPage(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  copySelection(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  savePdf(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceSavePdfResult>;
  showMenu(input: RemoteWebSurfaceMenuInput): Promise<RemoteWebSurfaceResult>;
  destroy(input: RemoteWebSurfaceDestroyInput): Promise<RemoteWebSurfaceResult>;
  destroyForNote(input: RemoteWebSurfaceDestroyForNoteInput): Promise<RemoteWebSurfaceResult>;
  onNavigationState(callback: (payload: RemoteWebSurfaceNavigationState) => void): () => void;
  onSelection(callback: (payload: RemoteWebSurfaceSelectionState) => void): () => void;
  onFindResult(callback: (payload: RemoteWebSurfaceFindResultState) => void): () => void;
  onFindShortcut(callback: (payload: RemoteWebSurfaceFindShortcutState) => void): () => void;
  onCommandPaletteShortcut(
    callback: (payload: RemoteWebSurfaceCommandPaletteShortcutState) => void
  ): () => void;
  onFocused(callback: (payload: RemoteWebSurfaceFocusedState) => void): () => void;
}

export interface VideoThumbnailApi {
  ensure(input: {
    noteId: string;
    src: string;
  }): Promise<{ relativePath: string } | null>;
  onMaterialized(callback: (payload: VideoThumbnailMaterializedPayload) => void): () => void;
}

export interface VideoThumbnailMaterializedEntry {
  relativePath: string;
  source?: 'cache' | 'generated';
  // Shared derived-preview vocabulary (additive; see AC10).
  status?: DerivedPreviewStatus;
  kind?: DerivedPreviewKind;
}

export interface VideoThumbnailMaterializedPayload {
  noteId: string;
  thumbnails: VideoThumbnailMaterializedEntry[];
  result?: { total: number; reused: number; generated: number; failed: number };
}


export interface GlobalShortcutSettings {
  quickCapture: string;
  enabled: boolean;
}

export type NativeMenuCommand = 'edit-image-alt-text';

export type MossWindowLaunchReason =
  | 'initial-launch'
  | 'new-window'
  | 'app-activate'
  | 'external-open';

export interface CreateWindowInput {
  noteId?: string | null;
}

export interface CreateWindowResult {
  action: 'created' | 'focused-existing';
  windowId: number;
}

export interface MossWindowContext {
  windowId: number;
  initialNoteId: string | null;
  launchReason: MossWindowLaunchReason;
  openedFromWindowId: number | null;
}

export interface SystemApi {
  showEmojiPanel(): Promise<void>;
  getMediaServerInfo(): Promise<{ port: number; token: string } | null>;
  getGlobalShortcut(): Promise<GlobalShortcutSettings>;
  setGlobalShortcut(accelerator: string): Promise<boolean>;
  setGlobalShortcutEnabled(enabled: boolean): Promise<void>;
  setImageAltTextMenuEnabled?(enabled: boolean): Promise<void>;
  createWindow(input?: CreateWindowInput): Promise<CreateWindowResult>;
  getWindowContext(): Promise<MossWindowContext>;
  setFocusedNoteId(noteId: string | null): Promise<void>;
  startWindowDrag(screenX: number, screenY: number): Promise<void>;
  moveWindowDrag(screenX: number, screenY: number): Promise<void>;
  endWindowDrag(): Promise<void>;
  onGlobalShortcutActivated(callback: () => void): () => void;
  onNativeMenuCommand?(callback: (command: NativeMenuCommand) => void): () => void;
  waitForReady(): Promise<void>;
}

export interface FilesystemApi {
  openFolderDialog(): Promise<string[]>;
  openFileDialog(filters?: Array<{ name: string; extensions: string[] }>): Promise<string[]>;
  readDirectory(dirPath: string): Promise<ReadDirectoryResult>;
  getHomeDirectory(): Promise<string>;
  readFile(filePath: string): Promise<ReadFileResult>;
}

export interface GrantedDirsApi {
  list(): Promise<string[]>;
  grant(input?: { surface?: 'settings_modal' }): Promise<string[]>;
  revoke(dirPath: string): Promise<string[]>;
}

export interface ExternalNotesApi {
  close(noteId: string): Promise<boolean>;
  closeByRoot(rootPath: string): Promise<string[]>;
  /**
   * Resolve a wiki-link target inside an external note to a sibling markdown
   * file on disk, registering it if needed. Returns the matched note record,
   * or null when no sibling matches.
   */
  resolveLink(sourceNoteId: string, target: string): Promise<NoteRecord | null>;
}

export interface UpdateReadyInfo {
  version: string;
  highlights: string;
  changelogUrl?: string;
  canInstall?: boolean;
}

export interface UpdateApi {
  install(): Promise<void>;
  onReady(callback: (info: UpdateReadyInfo) => void): () => void;
}

export interface AnalyticsApi {
  capture(event: string, properties?: Record<string, unknown>): Promise<void>;
}

export interface ShellApi {
  revealPath(absolutePath: string): Promise<void>;
}

export interface SettingsApi {
  getNoteIntelligence: () => Promise<boolean>;
  setNoteIntelligence: (enabled: boolean) => Promise<void>;
  getTheme: () => Promise<ThemeChoice>;
  setTheme: (theme: ThemeChoice) => Promise<void>;
  isDefaultMdEditor: () => Promise<boolean>;
  setDefaultMdEditor: () => Promise<boolean>;
  getDefaultEditorPromptDismissed: () => Promise<boolean>;
  setDefaultEditorPromptDismissed: (dismissed: boolean) => Promise<void>;
}

export interface SetWorkspacePathResult {
  success: boolean;
  warnings?: string[];
  error?: string;
}

export interface GetWorkspacePathResult {
  path: string | null;
  envOverride: boolean;
  effectivePath: string;
}

export interface AppConfigApi {
  getWorkspacePath(): Promise<GetWorkspacePathResult>;
  setWorkspacePath(path: string | null): Promise<SetWorkspacePathResult>;
  pickWorkspaceFolder(): Promise<string | null>;
  restartApp(): Promise<void>;
}

export interface ElectronAPI {
  notes: NotesApi;
  folders: FoldersApi;
  agent: AgentApi;
  chat: ChatApi;
  checkpoints: CheckpointsApi;
  files: FilesApi;
  images: ImagesApi;
  htmlPreview: HtmlPreviewApi;
  webEmbedPreview?: WebEmbedPreviewApi;
  remoteWebSurface?: RemoteWebSurfaceApi;
  system: SystemApi;
  filesystem: FilesystemApi;
  grantedDirs: GrantedDirsApi;
  externalNotes: ExternalNotesApi;
  update: UpdateApi;
  analytics: AnalyticsApi;
  shell: ShellApi;
  settings: SettingsApi;
  appConfig: AppConfigApi;
  videoThumbnail: VideoThumbnailApi;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
    __MOSS_AUTOMATION__?: MossAutomationController;
    __MOSS_AUTOMATION_ENABLED__?: boolean;
  }
}

export {};

// ported-from: packages/desktop/src/common/ipcChannels.ts @ 762abb777
import type { DerivedPreviewKind, DerivedPreviewStatus } from './derived-preview';

export const IPC_CHANNELS = {
  notes: {
    getAll: 'notes:getAll',
    getMetadataByIds: 'notes:getMetadataByIds',
    getById: 'notes:getById',
    getContent: 'notes:getContent',
    getFrontmatterSuggestions: 'notes:getFrontmatterSuggestions',
    create: 'notes:create',
    update: 'notes:update',
    delete: 'notes:delete',
    restore: 'notes:restore',
    search: 'notes:search',
    getHeadings: 'notes:getHeadings',
    getFilesystemPath: 'notes:getFilesystemPath',
    setOpenFileWatchTargets: 'notes:setOpenFileWatchTargets',
    copyLinkToClipboard: 'notes:copyLinkToClipboard',
    showInFinder: 'notes:showInFinder',
    getPdfExportSession: 'notes:getPdfExportSession',
    createPdfExportSession: 'notes:createPdfExportSession',
    openPdfExportPreview: 'notes:openPdfExportPreview',
    openPdfExportRenderSurface: 'notes:openPdfExportRenderSurface',
    exportPdf: 'notes:exportPdf',
    exportMarkdown: 'notes:exportMarkdown',
    flushComplete: 'notes:flushComplete'
  },
  folders: {
    list: 'folders:list',
    create: 'folders:create',
    rename: 'folders:rename',
    delete: 'folders:delete',
    moveNotes: 'folders:moveNotes',
    moveFolder: 'folders:moveFolder',
    showInFinder: 'folders:showInFinder'
  },
  agent: {
    execute: 'agent:execute',
    cancel: 'agent:cancel',
    cancelByTabId: 'agent:cancelByTabId'
  },
  chat: {
    getMessages: 'chat:getMessages'
  },
  checkpoints: {
    getAll: 'checkpoints:getAll'
  },
  files: {
    search: 'files:search',
    listDirectory: 'files:listDirectory',
    open: 'files:open'
  },
  images: {
    save: 'images:save',
    pick: 'images:pick',
    persistUrl: 'images:persistUrl',
    copyFromPath: 'images:copyFromPath',
    copyFromNoteAsset: 'images:copyFromNoteAsset'
  },
  htmlPreview: {
    ensure: 'htmlPreview:ensure'
  },
  webEmbedPreview: {
    ensure: 'webEmbedPreview:ensure'
  },
  remoteWebSurface: {
    create: 'remoteWebSurface:create',
    updateBounds: 'remoteWebSurface:updateBounds',
    hide: 'remoteWebSurface:hide',
    goBack: 'remoteWebSurface:goBack',
    goForward: 'remoteWebSurface:goForward',
    findInPage: 'remoteWebSurface:findInPage',
    openPageFind: 'remoteWebSurface:openPageFind',
    stopFindInPage: 'remoteWebSurface:stopFindInPage',
    copySelection: 'remoteWebSurface:copySelection',
    savePdf: 'remoteWebSurface:savePdf',
    showMenu: 'remoteWebSurface:showMenu',
    destroy: 'remoteWebSurface:destroy',
    destroyForNote: 'remoteWebSurface:destroyForNote'
  },
  videoThumbnail: {
    ensure: 'videoThumbnail:ensure'
  },
  system: {
    showEmojiPanel: 'system:showEmojiPanel',
    getMediaServerInfo: 'system:getMediaServerInfo',
    getGlobalShortcut: 'system:getGlobalShortcut',
    setGlobalShortcut: 'system:setGlobalShortcut',
    setGlobalShortcutEnabled: 'system:setGlobalShortcutEnabled',
    setImageAltTextMenuEnabled: 'system:setImageAltTextMenuEnabled',
    createWindow: 'system:createWindow',
    getWindowContext: 'system:getWindowContext',
    setFocusedNoteId: 'system:setFocusedNoteId',
    startWindowDrag: 'system:startWindowDrag',
    moveWindowDrag: 'system:moveWindowDrag',
    endWindowDrag: 'system:endWindowDrag',
    waitForReady: 'system:waitForReady'
  },
  filesystem: {
    openFolderDialog: 'filesystem:openFolderDialog',
    openFileDialog: 'filesystem:openFileDialog',
    readDirectory: 'filesystem:readDirectory',
    getHomeDirectory: 'filesystem:getHomeDirectory',
    readFile: 'filesystem:readFile'
  },
  grantedDirs: {
    list: 'grantedDirs:list',
    grant: 'grantedDirs:grant',
    revoke: 'grantedDirs:revoke'
  },
  externalNotes: {
    close: 'externalNotes:close',
    closeByRoot: 'externalNotes:closeByRoot',
    resolveLink: 'externalNotes:resolveLink'
  },
  update: {
    install: 'update:install'
  },
  analytics: {
    capture: 'analytics:capture'
  },
  shell: {
    revealPath: 'shell:revealPath'
  },
  settings: {
    getNoteIntelligence: 'settings:getNoteIntelligence',
    setNoteIntelligence: 'settings:setNoteIntelligence',
    getTheme: 'settings:getTheme',
    setTheme: 'settings:setTheme',
    isDefaultMdEditor: 'settings:isDefaultMdEditor',
    setDefaultMdEditor: 'settings:setDefaultMdEditor',
    getDefaultEditorPromptDismissed: 'settings:getDefaultEditorPromptDismissed',
    setDefaultEditorPromptDismissed: 'settings:setDefaultEditorPromptDismissed'
  },
  appConfig: {
    getWorkspacePath: 'appConfig:getWorkspacePath',
    setWorkspacePath: 'appConfig:setWorkspacePath',
    pickWorkspaceFolder: 'appConfig:pickWorkspaceFolder',
    restartApp: 'appConfig:restartApp'
  }
} as const;

export const IPC_PUSH_CHANNELS = {
  agent: {
    stream: 'agent:stream'
  },
  notes: {
    openExternal: 'notes:open-external-file',
    openInternal: 'notes:open-internal-file',
    diskChanged: 'notes:disk-changed',
    metadataReindexed: 'notes:metadata-reindexed',
    requestFlush: 'notes:request-flush'
  },
  htmlPreview: {
    materialized: 'htmlPreview:materialized',
    failed: 'htmlPreview:failed'
  },
  webEmbedPreview: {
    materialized: 'webEmbedPreview:materialized',
    failed: 'webEmbedPreview:failed'
  },
  remoteWebSurface: {
    navigationState: 'remoteWebSurface:navigation-state',
    selection: 'remoteWebSurface:selection',
    findResult: 'remoteWebSurface:find-result',
    findShortcut: 'remoteWebSurface:find-shortcut',
    commandPaletteShortcut: 'remoteWebSurface:command-palette-shortcut',
    focused: 'remoteWebSurface:focused'
  },
  videoThumbnail: {
    materialized: 'videoThumbnail:materialized'
  },
  system: {
    globalShortcutActivated: 'system:globalShortcutActivated',
    nativeMenuCommand: 'system:nativeMenuCommand'
  },
  update: {
    ready: 'update:ready'
  },
} as const;

/**
 * Channel the scoped selection preload (assets/remote-web-surface/selection-preload.js)
 * uses to report text-selection state from a native browser surface to main.
 * The preload is plain JS shipped as an asset and cannot import this module, so
 * it hardcodes the same literal — keep the two in sync.
 */
export const REMOTE_WEB_SURFACE_HOST_SELECTION_CHANNEL = 'remoteWebSurface:hostSelection';

/**
 * Shared push-payload vocabulary for derived-preview materialization channels.
 *
 * The `htmlPreview:{materialized,failed}` and `videoThumbnail:materialized`
 * channel names are unchanged. Their per-item entries carry `DerivedPreviewResult`
 * fields — notably `status` — so HTML preview, local video thumbnail, and (W2)
 * web-embed previews share one status vocabulary across the IPC boundary.
 */
export interface DerivedPreviewPushEntry {
  relativePath: string;
  status: DerivedPreviewStatus;
  kind?: DerivedPreviewKind;
  descriptorKey?: string;
  sourceKey?: string;
  sourceSignature?: string;
  cacheKey?: string;
  assetRelativePath?: string;
  html?: string;
  metadata?: Record<string, string | number | boolean | null>;
  generatedAt?: string;
  expiresAt?: string;
  errorCode?: string;
  source?: string;
  reason?: string;
}

export interface DerivedPreviewMaterializedPushPayload {
  noteId: string;
  previews: DerivedPreviewPushEntry[];
  result?: { total: number; reused: number; generated: number; failed: number };
}

export const NOTE_INTELLIGENCE_DEFAULT = false;
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICE_DEFAULT: ThemeChoice = 'system';

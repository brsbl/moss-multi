// The bridge inventory (A§9): every ElectronAPI method at the pin and how the web treats it.
//   real    works on the web.
//   stub    moss never reaches it on the web (or it never fires); it answers harmlessly.
//   hidden  its entry points are withheld through the hide registry (`affordance`).
//   staged  its backend lands in `milestone`; until then it is minimally real or its entry points are hidden.
//   absent  the optional namespace is left undefined (R4: the in-app browser is a sandboxed iframe).
// inventory.test.ts fails on an ElectronAPI method this lacks, on a bridge method it does not list, and on a
// staged entry whose milestone has closed.

export type Treatment = 'real' | 'stub' | 'hidden' | 'staged' | 'absent';

export interface Routing {
  treatment: Treatment;
  /** For `staged`: the milestone that makes it real. */
  milestone?: number;
  /** What the web does. */
  note: string;
}

export interface InventoryEntry extends Routing {
  /** The hide-registry id that keeps its entry points out of the UI. */
  affordance?: string;
  /** Per-field routing, for methods that route by input field. */
  fields?: Record<string, Routing>;
}

const real = (note: string): InventoryEntry => ({ treatment: 'real', note });
const stub = (note: string): InventoryEntry => ({ treatment: 'stub', note });
const hidden = (affordance: string, note: string): InventoryEntry => ({ treatment: 'hidden', affordance, note });
const staged = (milestone: number, note: string, affordance?: string): InventoryEntry => ({ treatment: 'staged', milestone, note, ...(affordance ? { affordance } : {}) });
const absent = (note: string): InventoryEntry => ({ treatment: 'absent', note });

const REMOTE_WEB_SURFACE = 'left undefined: RemoteWebSurface is substituted with a sandboxed iframe (R4, T3.2)';

export const INVENTORY: Record<string, InventoryEntry> = {
  'notes.getAll': real('GET /api/workspace, mapped to NoteMetadataRecord in seconds under Notes'),
  'notes.getMetadataByIds': real('the same listing, filtered'),
  'notes.getById': real("listing metadata plus this viewer's local extras; content '' for a doc that will bind"),
  'notes.getContent': staged(1, "the DocDO export behind a limit of 3 (T1.8); '' until then"),
  'notes.getFrontmatterSuggestions': staged(1, 'per-vault keys and values with Properties (T1.4); {} until then'),
  'notes.getHeadings': staged(3, 'headings from the DO export (T3.4); [] until then'),
  'notes.create': real('POST /api/docs; the DocDO seeds the doc and "Untitled" is never authored'),
  'notes.update': {
    treatment: 'real',
    note: 'routes by field',
    fields: {
      content: real('refused loudly, before any request: the bridge cannot wipe a doc (P:Tech)'),
      title: real('Y.Text write when bound, otherwise a DocDO rename'),
      pinned: staged(2, "user_doc_prefs; this viewer's localStorage until then"),
      layoutMetadata: real('localStorage, per viewer (R11)'),
      collapsedHeadings: real('localStorage, per viewer (R11)'),
      commentMetadata: staged(4, 'CRDT comments (M4); ignored until then'),
      stickyTabs: stub('agent tabs stay local; ignored'),
    },
  },
  'notes.delete': staged(2, 'REST trash (T2.3); refused until then', 'trash'),
  'notes.restore': staged(2, 'REST restore (T2.3); refused until then', 'trash'),
  'notes.search': staged(3, 'SearchDO (T3.4); title matches over the listing until then'),
  'notes.getFilesystemPath': real('the doc URL'),
  'notes.setOpenFileWatchTargets': stub('a hint; the workspace channel needs no per-doc watch'),
  'notes.copyLinkToClipboard': real("text/plain doc URL plus moss's HTML note-link payload"),
  'notes.showInFinder': hidden('reveal-in-finder', 'no Finder'),
  'notes.getPdfExportSession': staged(3, 'sessionStorage session for /pdf-export (T3.7)', 'save-as-pdf'),
  'notes.createPdfExportSession': staged(3, 'sessionStorage session for /pdf-export (T3.7)', 'save-as-pdf'),
  'notes.openPdfExportPreview': staged(3, 'window.open of /pdf-export (T3.7)', 'save-as-pdf'),
  'notes.openPdfExportRenderSurface': staged(3, 'window.open of /pdf-export (T3.7)', 'save-as-pdf'),
  'notes.exportPdf': stub('unused at the pin; rejects'),
  'notes.exportMarkdown': staged(3, 'a download of the DO export (T3.7)', 'save-as-markdown'),
  'notes.onExternalFileOpen': stub('never fires'),
  'notes.onInternalFileOpen': real('fires on popstate to /d/$docId'),
  'notes.onDiskChange': staged(2, 'metadata-only events from the workspace channel (T2.1); silent until then'),
  'notes.onMetadataReindexed': staged(1, 'fires after a vault switch (T1.2); silent until then'),
  'notes.onRequestFlush': stub('never fires: the Y.Doc persists every update'),
  'notes.flushComplete': stub('no-op'),

  'folders.list': staged(2, 'the folders API (T2.2); [] until then'),
  'folders.create': staged(2, 'the folders API (T2.2); refused until then', 'new-folder'),
  'folders.rename': staged(2, 'the folders API (T2.2); unreachable with no folders'),
  'folders.delete': staged(2, 'subtree to trash (T2.2); unreachable with no folders', 'trash'),
  'folders.moveNotes': staged(2, 'the folders API (T2.2); unreachable with no folders'),
  'folders.moveFolder': staged(2, 'the folders API (T2.2); unreachable with no folders'),
  'folders.showInFinder': hidden('reveal-in-finder', 'no Finder'),

  'agent.execute': hidden('ai-run-action', 'rejects: in-app agent execution is out of scope'),
  'agent.cancel': stub('no-op'),
  'agent.cancelByTabId': stub('no-op'),
  'agent.onStream': stub('a silent subscription that must exist (CanvasAreaContent calls it unconditionally)'),
  'chat.getMessages': stub('[]'),
  'checkpoints.getAll': stub('[]: not version history'),

  'files.search': stub('[]'),
  'files.listDirectory': stub('[]: no directory @-mentions'),
  'files.open': hidden('open-directory', '[]'),
  'filesystem.openFolderDialog': stub('[]'),
  'filesystem.openFileDialog': stub('[]'),
  'filesystem.readDirectory': stub('an empty listing'),
  'filesystem.getHomeDirectory': stub("''"),
  'filesystem.readFile': stub('rejects; its surface needs connected folders'),
  'grantedDirs.list': hidden('settings-connected-folders', '[]'),
  'grantedDirs.grant': hidden('settings-connected-folders', '[]'),
  'grantedDirs.revoke': hidden('settings-connected-folders', '[]'),
  'externalNotes.close': stub('false: external notes never exist on the web'),
  'externalNotes.closeByRoot': stub('[]'),
  'externalNotes.resolveLink': stub('null'),

  'images.save': staged(3, 'folder-scoped upload (T3.1); refused loudly until then', 'media-upload'),
  'images.pick': staged(3, '<input type=file>, then upload (T3.1)', 'media-upload'),
  'images.persistUrl': staged(3, 'SSRF-safe fetch-and-store (T3.2); refused loudly until then', 'media-upload'),
  'images.copyFromPath': stub('rejects: browsers have no file paths'),
  'images.copyFromNoteAsset': staged(3, 'a server copy (T3.1); refused loudly until then'),
  'htmlPreview.ensure': staged(3, 'null; the preview decision renders the live sandboxed iframe (T3.2)'),
  'htmlPreview.onMaterialized': stub('silent'),
  'htmlPreview.onFailed': stub('silent'),
  'webEmbedPreview.ensure': staged(3, 'POST /api/unfurl (T3.2); null until then'),
  'webEmbedPreview.subscribe': stub('silent'),
  'videoThumbnail.ensure': stub('null: <video> streams from R2'),
  'videoThumbnail.onMaterialized': stub('silent'),

  'remoteWebSurface.create': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.updateBounds': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.hide': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.goBack': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.goForward': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.findInPage': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.openPageFind': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.stopFindInPage': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.copySelection': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.savePdf': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.showMenu': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.destroy': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.destroyForNote': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onNavigationState': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onSelection': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onFindResult': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onFindShortcut': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onCommandPaletteShortcut': absent(REMOTE_WEB_SURFACE),
  'remoteWebSurface.onFocused': absent(REMOTE_WEB_SURFACE),

  'system.showEmojiPanel': hidden('emoji-panel', 'no OS emoji API'),
  'system.getMediaServerInfo': stub('null: the asset-url substitution serves media'),
  'system.getGlobalShortcut': stub('quick capture is never enabled'),
  'system.setGlobalShortcut': stub('false'),
  'system.setGlobalShortcutEnabled': stub('no-op'),
  'system.setImageAltTextMenuEnabled': staged(3, "drives the image context menu's Edit Alt Text (T3.1); no-op until then"),
  'system.createWindow': real('opens the doc in a browser tab (R4)'),
  'system.getWindowContext': real('the startup note from /d/$docId'),
  'system.setFocusedNoteId': real('history.replaceState to /d/$docId'),
  'system.startWindowDrag': stub('no-op'),
  'system.moveWindowDrag': stub('no-op'),
  'system.endWindowDrag': stub('no-op'),
  'system.onGlobalShortcutActivated': stub('never fires'),
  'system.onNativeMenuCommand': staged(3, 'Edit Alt Text from the image context menu (T3.1); silent until then'),
  'system.waitForReady': real('resolves once the vault listing has answered'),

  'update.install': stub('unreachable'),
  'update.onReady': stub('never fires, so UpdateWidget never shows'),
  'analytics.capture': real('feedback_submitted is POST /api/feedback; every other event is a no-op'),
  'shell.revealPath': hidden('reveal-in-finder', 'no Finder'),
  'settings.getNoteIntelligence': staged(3, "user_prefs (T3.6); this viewer's localStorage until then"),
  'settings.setNoteIntelligence': staged(3, "user_prefs (T3.6); this viewer's localStorage until then"),
  'settings.getTheme': real('localStorage moss_theme'),
  'settings.setTheme': real('localStorage moss_theme'),
  'settings.isDefaultMdEditor': hidden('settings-default-md-editor', 'true'),
  'settings.setDefaultMdEditor': hidden('settings-default-md-editor', 'true'),
  'settings.getDefaultEditorPromptDismissed': hidden('settings-default-md-editor', 'true, so the prompt never renders'),
  'settings.setDefaultEditorPromptDismissed': hidden('settings-default-md-editor', 'no-op'),
  'appConfig.getWorkspacePath': hidden('settings-workspace-location', 'an empty location'),
  'appConfig.setWorkspacePath': hidden('settings-workspace-location', 'refuses'),
  'appConfig.pickWorkspaceFolder': hidden('settings-workspace-location', 'null'),
  'appConfig.restartApp': stub('no-op'),
};

/** ElectronAPI methods the inventory does not list. */
export function unlistedMethods(methods: readonly string[], inventory: Record<string, InventoryEntry> = INVENTORY): string[] {
  return methods.filter((method) => !(method in inventory));
}

/** Staged entries and fields (`method#field`) whose milestone is at or before the last closed milestone. */
export function expiredStaged(inventory: Record<string, InventoryEntry>, closedThrough: number | null): string[] {
  if (closedThrough === null) return [];
  const expired = (routing: Routing) => routing.treatment === 'staged' && (routing.milestone ?? -1) <= closedThrough;
  return Object.entries(inventory).flatMap(([key, entry]) => [
    ...(expired(entry) ? [key] : []),
    ...Object.entries(entry.fields ?? {}).filter(([, routing]) => expired(routing)).map(([field]) => `${key}#${field}`),
  ]);
}

/** CI's TRACE_MILESTONE (plan.mjs): the last closed milestone, or null when none has closed. */
export function closedMilestone(value: string | undefined): number | null {
  return value && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

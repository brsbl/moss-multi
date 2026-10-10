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

const REMOTE_WEB_SURFACE = 'left undefined: RemoteWebSurface is substituted with a sandboxed iframe (R4)';

export const INVENTORY: Record<string, InventoryEntry> = {
  'notes.getAll': real('GET /api/workspace, mapped to NoteMetadataRecord in seconds under Notes; opened notes carry backlinks'),
  'notes.getMetadataByIds': real('the same listing, filtered'),
  'notes.getById': real("listing metadata plus this viewer's local extras; content '' for a doc that will bind, GET /api/trash/:id for a trashed one"),
  'notes.getContent': staged(1, "the DocDO export behind a limit of 3 (T1.8); '' until then"),
  'notes.getFrontmatterSuggestions': staged(1, 'per-vault keys and values with Properties (T1.4); {} until then'),
  'notes.getHeadings': real('GET /api/docs/:id/headings: h1–h4 of the DO export (A§15)'),
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
  'notes.delete': real('DELETE /api/docs/:id after the doc closes to writes and acks (A§10.6); the owner only'),
  'notes.restore': real('POST /api/docs/:id/restore; the owner only'),
  'notes.search': real('title matches over the listing, then GET /api/search over every doc the caller can discover (A§15)'),
  'notes.getFilesystemPath': real('the doc URL'),
  'notes.setOpenFileWatchTargets': stub('a hint; the workspace channel needs no per-doc watch'),
  'notes.copyLinkToClipboard': real("text/plain doc URL plus moss's HTML note-link payload"),
  'notes.showInFinder': hidden('reveal-in-finder', 'no Finder'),
  'notes.getPdfExportSession': real('the /pdf-export tab reads its session from session storage, its own copy or its opener'),
  'notes.createPdfExportSession': real('one session in session storage, without renderedHtml (PdfExportApp never reads it)'),
  'notes.openPdfExportPreview': real('window.open of /pdf-export, which calls window.print once ready (R4)'),
  'notes.openPdfExportRenderSurface': real('the same /pdf-export tab'),
  'notes.exportPdf': stub('unused at the pin; rejects'),
  'notes.exportMarkdown': real('a download of GET /api/docs/:id/content, the DocDO export (A§12)'),
  'notes.onExternalFileOpen': stub('never fires'),
  'notes.onInternalFileOpen': real('fires on popstate to /d/$docId'),
  'notes.onDiskChange': staged(2, 'metadata-only events from the workspace channel (T2.1); silent until then'),
  'notes.onMetadataReindexed': staged(1, 'fires after a vault switch (T1.2); silent until then'),
  'notes.onRequestFlush': stub('never fires: the Y.Doc persists every update'),
  'notes.flushComplete': stub('no-op'),

  'folders.list': real("the listing's folders, mapped to Notes/... paths"),
  'folders.create': real("POST /api/folders under the path's id (the refreshed id↔path map), then the listing again"),
  'folders.rename': real('PATCH /api/folders/:id {name}'),
  'folders.delete': real('DELETE /api/folders/:id: the subtree goes to Trash as one batch and its open docs close 4410'),
  'folders.moveNotes': real('PATCH /api/docs/:id {folderId} for each note'),
  'folders.moveFolder': real('PATCH /api/folders/:id {parentId}, within the vault'),
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

  'images.save': real("the bytes to POST /api/docs/:id/assets in the note's folder (A§16); a refusal is announced"),
  'images.pick': real('<input type=file multiple>, then each file uploads as save does'),
  'images.persistUrl': real("POST /api/docs/:id/assets/from-url: the server fetches through the SSRF guard (A§18) and stores the note's own media"),
  'images.copyFromPath': stub('rejects: browsers have no file paths'),
  'images.copyFromNoteAsset': real("POST /api/docs/:id/assets/copy: the bytes the source's media record names, bound in the target's"),
  'htmlPreview.ensure': stub('null: an HTML block previews as its live sandboxed frame, never a screenshot'),
  'htmlPreview.onMaterialized': stub('silent'),
  'htmlPreview.onFailed': stub('silent'),
  'webEmbedPreview.ensure': real('POST /api/unfurl: the OpenGraph card, through the SSRF guard; null when refused, so moss shows its URL card'),
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
  'system.setImageAltTextMenuEnabled': stub("no-op: the image context menu offers Edit Alt Text… on any image in an editable note"),
  'system.createWindow': real('opens the doc in a browser tab, keeping a share link (R4)'),
  'system.getWindowContext': real('the startup note from /d/$docId'),
  'system.setFocusedNoteId': real('history.replaceState to /d/$docId'),
  'system.startWindowDrag': stub('no-op'),
  'system.moveWindowDrag': stub('no-op'),
  'system.endWindowDrag': stub('no-op'),
  'system.onGlobalShortcutActivated': stub('never fires'),
  'system.onNativeMenuCommand': real("receives the image context menu's Edit Alt Text…; no other native command fires"),
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

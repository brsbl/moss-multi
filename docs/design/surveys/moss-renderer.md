# Survey: porting the moss renderer to the web (moss @ 762abb777)

This survey covers what the web port of the moss renderer needs to know: what to copy, what to change, and where `@lexical/yjs` plugs in. It is input for the architecture.

**Sources.** Everything was read from `.refs/moss` (the pin snapshot). The `@lexical/react` and `@lexical/yjs` 0.48.0 sources were read, without changes, from `~/Code/moss/node_modules`, which is the same version moss pins. `.refs/moss-collab` was consulted as a reference only.

**Path prefixes** (all relative to `.refs/moss/`):

| Prefix | Path |
|---|---|
| `R/` | `packages/desktop/src/renderer/` |
| `S/` | `packages/shared/src/` |
| `C/` | `packages/desktop/src/common/` |
| `T/` | `packages/desktop/src/types/` |

Line numbers are at the pin.

---

## 0. Findings that change the architecture

1. **"+ Note" focuses the body, not the title.** At the pin, `handleCreateNote` calls `createAndActivateNote({ focusTarget: 'body' })` (`R/App.tsx:2919-2925`). The global quick-capture does the same (`R/App.tsx:3744`). The title gets focus only through ⌘T (`R/App.tsx:3808-3831`), the context-menu Rename (a 150 ms timer, `R/App.tsx:3127-3140`), or ArrowUp from the start of the body (`R/panels/CanvasAreaContent.tsx:4146-4161`). Restart ruling 2 says "focus then moves to the title", which diverges from the pinned UI. The coordinator should either align the ruling with the pin (body) or record the change as a deliberate deviation.
2. **The title is a plain `contentEditable` div, not Lexical** (`R/panels/CanvasAreaContent.tsx:4858-4937`). It is saved as the leading `# Title` line of the markdown file: `buildMarkdownForSave` calls `assembleNote({ h1Title })` (`:2242-2277`), and `C/markdown-layers.ts:525-560` splits and joins it. The body editor never contains that H1; it is stripped on import (`R/editor/MarkdownEditor.tsx:7684-7688`, `:7965`).
   - Every user-originated title write passes through `setTitleValue`: the `onInput` handler, paste, drop, and the emoji typeahead. That is the single chokepoint for a `Y.Text` binding (§4).
3. **Moss has a single writer per note and is keyed on `updatedAt`.** The note-init effect re-fetches `notes.getById` whenever `note.updatedAt` changes (`:1651-1934`, dependency at `:1930`). It then remounts the editor with `remountEditorPreservingScroll('disk_content_changed')` (`:1550-1554`). A 1.5 s debounced autosave sends whole-file markdown through `notes.update({content, expectedDiskContent…})` (`:1238-1266`, `:2517-3149`).
   - For a bound doc, these paths must be removed at about 8 sites in `CanvasAreaContent`; gating them is not enough (§3.7). This is the root of the flash, keystroke-drop, and race bugs in LEARNINGS §4.1.
4. **What the official `CollaborationPlugin` does in 0.48.** These facts come from the source and drive the seam design:
   - Both V1 and `CollaborationPluginV2__EXPERIMENTAL` call `provider.connect()` themselves on mount and `disconnect()` on unmount. Create the provider with `connect:false`, so the plugin's call is the single explicit connect.
   - Neither variant reconciles a Y.Doc that already has content when the binding is created. Both depend on `observeDeep` seeing the provider's sync updates *after* the binding exists. So mount the editor against a **fresh, empty** Y.Doc, and gate editability on the provider's `sync` event. Do not mount the editor after an out-of-band sync.
   - Both install their own Yjs UndoManager with `trackedOrigins = {binding, null}` and Yjs' default capture timeout. Moss's `<HistoryPlugin/>` (`MarkdownEditor.tsx:8076`) and `CLEAR_HISTORY_COMMAND` (`:8013`) must not run on a bound editor.
   - In 0.48, `$ensureEditorNotEmpty` runs after a remote change only when `binding.root.isEmpty()`. That fixes cause #1 of LEARNINGS §4.2's error #343. The `HISTORIC_TAG` early return in `syncLexicalUpdateToYjs` is still present, so the "never use historic tags" rule still applies.
5. **Moss caches serialized editor states, which can replay an empty state.** A module-level LRU (`MarkdownEditor.tsx:4234-4268`) is written one animation frame after `onReady` (`:7610-7631`) and read in `initialConfig` (`:7666`). This is exactly the "rAF editor-state cache serialized the empty root" source of error #38 in LEARNINGS §4.2. It must be bypassed for bound editors.
6. **A `readOnly` change remounts the whole editor.** The `LexicalComposer` key is `` `${noteId}-${readOnly ? 'locked' : 'edit'}` `` (`:8053`). A role demotion or trash event that flips `readOnly` therefore tears down the binding. For bound editors, the key must not depend on `readOnly`; use `editor.setEditable()` instead.
7. **The one converter lives inside an 8,187-line React module.** `MARKDOWN_EDITOR_TRANSFORMERS` (`:4108-4154`), `MARKDOWN_EDITOR_NODES` (`:4161-4190`), `normalizeMarkdownForImport` / `escapeHtmlEntities` / `unescapeHtmlEntities` (`:3675-4092`) and `$postImportNormalize` (`:3508`) are all in `MarkdownEditor.tsx`. That file also imports `./MarkdownEditor.css` (`:324`).
   - No module under `R/editor`, `R/utils`, `C/` or `S/` touches the DOM at module scope; the only top-level `window` use is the guarded one in `prism-setup.ts:48`.
   - So the Durable Object can probably import the files unchanged, with `.css` and `.png` loader stubs, React present, and Prism on `globalThis`. This avoids "server twin" drift. Prove it with a spike before choosing to extract the converter.
8. **Many web needs can be met in the bridge adapter with no change to moss code:**
   - **URL routing.** `getWindowContext().initialNoteId` sets the startup note (`R/App.tsx:1246`). `system.setFocusedNoteId` fires on every focus change (`:976-981`), so the adapter can `history.replaceState` the URL there. `notes.onInternalFileOpen` provides an in-app "navigate to note" path that already serializes note switches (`:2586-2620`).
   - **Hidden by return value.** The adapter's return values alone hide the default-`.md`-editor prompt (`getDefaultEditorPromptDismissed → true`), the update widget (`update.onReady` never fires), the External section (it renders `null` with no External notes, `R/panels/SystemFolderSection.tsx:168-170`), global quick-capture, and the native alt-text menu.
   - **Read fan-out.** A concurrency limiter in the adapter on `notes.getContent` bounds `MathCalculationPlugin`'s fan-out across every note (`R/editor/MathCalculationPlugin.tsx:1340`, `Promise.all`).
9. **The adapter needs every namespace, even when inert.** `hasElectronBridge` only checks `window.electronAPI.notes` (`R/App.tsx:960-962`; `R/panels/CanvasAreaContent.tsx:936-937`). Behind that check, `CanvasAreaContent` calls `agentApi.onStream` unconditionally (`:3612-3616`). If the adapter left out `agent`, that call would throw. Inert namespaces must exist with no-op subscriptions.
10. **Browsers reserve shortcuts that moss binds.**
    - Chrome and Safari never deliver ⌘N or ⌘T to a page. ⌘N creates a note (`R/App.tsx:3802`) and ⌘T focuses the title (`:3808`); the ⌘T chip in the title placeholder is at `R/panels/CanvasAreaContent.tsx:4947-4952`.
    - PRODUCT already hides the ⌘N label. The ⌘T chip and ⌘⇧T (open the browser split) are not in PRODUCT's named hidden set and need a ruling.
    - ⌘1, ⌘2 and ⌘⌥←/→ are also tab shortcuts in Chrome. Verify in the browser whether `preventDefault` wins.
11. **Per-viewer state goes through the save path.**
    - Collapsed headings call `window.electronAPI.notes.update(noteId, { collapsedHeadings })` directly (`R/editor/plugins/CollapsibleHeadingPlugin.tsx:752`).
    - Table column widths and tab widths travel as `layoutMetadata` inside `saveContent` (`R/panels/CanvasAreaContent.tsx:2559-2575`). They are applied only on markdown import (`$postImportNormalize(..., {layoutMetadata})`, `MarkdownEditor.tsx:7693`, and `:7995` for in-place re-import).
    - With the save path removed for bound docs, ruling 11 (keep these in localStorage) needs a new local apply-and-persist plugin.
12. **The Ladle oracle has a few artifacts.**
    - There are two Ladle configs. Only the root one (`.ladle/`) imports Prism; `packages/desktop/.ladle/components.tsx` does not. Neither loads the webfonts that `R/main.tsx:5-10` imports.
    - The story bridge gives every note `content: ''`.
    - The story bridge divides second-based mock timestamps by 1000 (`stories/utils/story-data.tsx:65-68`), so sidebar times render as January 1970.
    - `notes.create` throws in the story bridge (`:232-234`), so "+ Note" fails there.
13. **The HTML-block preview needs a code change.** Desktop renders HTML blocks as screenshot images through `htmlPreview.ensure`, and shows the live iframe only on activation. With `ensure → null`, the block falls to `'static-placeholder'` (`R/editor/nodes/HtmlBlockquoteNode.tsx:71-83`, `:604`). PRODUCT's "live sandboxed iframe" therefore needs a change to the preview-mode decision.
    - The iframes use `data:` URLs (`R/editor/iframe/IframeFrame.tsx:37-40`), so they keep an opaque origin even with `allow-same-origin` (`C/embed-iframe-policy.ts:38-44`).
    - The web CSP must still allow `frame-src data:`.
14. **Decorators with whole-value properties merge last-writer-wins.** Under `@lexical/yjs` these properties are replaced as a whole on concurrent edits:

    | Node | Property |
    |---|---|
    | code block | `__code` |
    | HTML block | `__rawHtml` |
    | sketch | `__grid` |
    | chart | `__config` |
    | image, video, web embed | `__altText` |

    Some properties are per-viewer or derived and must stay off the wire:

    | Node | Property |
    |---|---|
    | tab group | `__activeIndex`, `__tabWidths` |
    | formula | `__result`, `__stale`, `__name` |
    | file link | `__isResolved`, `__resolutionState` |
    | table | `__colWidths` (from `@lexical/table`) |

    The source is `R/editor/nodes/*.tsx` (§3.8).

---

## 1. App structure

### 1.1 Entry and boot

`R/index.html` sets up the page:

- A synchronous theme script: `localStorage.moss_theme` → `documentElement.dataset.theme` (`:7-9`).
- An Electron content security policy that allows `moss-asset:` and a `127.0.0.1` media server (`:6`).
- A `#root` element.

`R/main.tsx` then runs in this order:

1. `prism-setup` first (`:3`).
2. Fonts (`:5-10`).
3. `App`, `PdfExportApp`, and error analytics.
4. `styles.css` (`:17`).
5. `createRoot(...)` inside `<React.StrictMode>`. When `?mossMode=pdf-export` is set it renders `<PdfExportApp/>` instead (`:27-52`).

There is **no Jotai `<Provider>`**: the app uses the default store. `R/state/default-editor-atoms.ts:50` and `R/state/workspace-info-atoms.ts:37` call `getDefaultStore()` directly. The web host must keep the default store; wrapping `App` in a custom store would split state.

`App` boot, starting at `R/App.tsx:1239`:

1. If a bridge exists: `system.waitForReady()` → `system.getWindowContext()` → `store.set(hydrateNotesAtom)`, which calls `notes.getAll` → `ensureSettingsWarmupAtom` (`settings.getNoteIntelligence`) → `refreshConnectedFolderEntriesAtom` (`grantedDirs.list`, `files.listDirectory`).
2. If there is no bridge, it sets `notesHydratedAtom = true` (`:1294-1299`).
3. `App` renders an empty bordered div until `notesHydratedAtom` is true (`:3930-3934`).
4. The startup note comes from window context (`?initialNoteId=` fallback, `:185-212`), then the last-viewed note (`localStorage['moss/session:lastViewedNoteId']`, `S/state/atoms.ts:363`), then the most recent note (`:1713+`).
5. Folders load through `folders.list({cleanupEmpty:false})` on each `appMode` change (`:1646-1677`).

### 1.2 Layout tree

```
App (R/App.tsx:695)
└─ AppShell  (S/components/layout/AppShell.tsx:19)  [data-moss-app-shell] 3 flex columns
   ├─ notesPanel  (App :4103-4145; width 260, min 248, max 560 or 50vw; resizable)
   │   ├─ NotesListPanelContent (R/panels/NotesListPanelContent.tsx:396)   — mode 'notes'
   │   │   └─ NotesListPanel (S/components/layout/NotesListPanel.tsx)     header row (drag region +
   │   │        collapse btn), search, "+ Note ⌘N", sort dropdown, folder-actions dropdown
   │   │        ├─ Pinned section, root notes (NoteCard S/components/notes/NoteCard.tsx)
   │   │        ├─ FolderGroup (R/panels/FolderGroup.tsx) per folder, context menus
   │   │        └─ SystemFolderSection (External; null when empty)
   │   ├─ TrashedNotesPanelContent (R/panels/TrashedNotesPanelContent.tsx) — mode 'trash' (lazy)
   │   └─ NotesPanelFooter (R/panels/NotesPanelFooter.tsx) Settings · Feedback · Trash toggle
   ├─ <main> canvas (AppShell :49-56)
   │   └─ SplitPaneContainer (R/panels/SplitPaneContainer.tsx) — left pane + optional right pane
   │       ├─ CanvasAreaContent (R/panels/CanvasAreaContent.tsx:883)  ×1 or ×2 (split)
   │       │   ├─ TopNavBar (R/panels/TopNavControls.tsx:64)  [staticTopBar :4435-4810]
   │       │   │   back/fwd · NoteBreadcrumb · Search · Copy link · CommentsMenuButton (:260)
   │       │   │   · "Share with Agent" · ⋮ (Copy markdown / Save as PDF / Save as Markdown /
   │       │   │   Note stats / Trash|Restore|Close) · actions-panel toggle
   │       │   └─ CanvasArea (S/components/layout/CanvasArea.tsx) scroll container
   │       │       ├─ hydration skeleton (:4840-4849) | load error | ↓
   │       │       ├─ title contentEditable (:4858-4937) + placeholder (:4939-4953)
   │       │       └─ MarkdownEditor (R/editor/MarkdownEditor.tsx:7556) or mount skeleton
   │       │   + trash countdown pill, status label, action feedback, retry toast, ImageLightbox
   │       └─ BrowserSplitPane (R/panels/BrowserSplitPane.tsx) — in-app browser (Electron view)
   └─ actionsPanel (hidden by default: actionsPanelHiddenAtom = true, S/state/atoms.ts:846)
       └─ ActionsPanelWrapper (S/components/layout/ActionsPanelWrapper.tsx)
           tabs "Actions" | "Properties"
           ├─ ActionsPanel (S/components/ui/actions-panel.tsx) + action-timeline-card (agent)
           ├─ PropertiesTabContent (R/panels/PropertiesTabContent.tsx) → FrontmatterHeader
           └─ LinksSection (R/components/LinksSection.tsx) backlinks / links / suggested
Overlays (App :4147-4229): global ImageLightbox, WebEmbedLightbox, CommandPaletteOverlay (⌘K,
lazy), SettingsModal (lazy), DefaultEditorPrompt, FeedbackDialog (lazy), SnapshotUiFixtureLayer
(automation), operation-failure toast, UpdateWidget (lazy).
```

### 1.3 Surface inventory

| Surface | Main files | Notes for the web |
|---|---|---|
| Sidebar / notes list | `R/panels/NotesListPanelContent.tsx` (1708 lines), `S/components/layout/NotesListPanel.tsx` (337), `S/components/notes/NoteCard.tsx`, `R/panels/FolderGroup.tsx`, `R/panels/notesPanelUtils.ts` | Note context menu: Open in New Window, Split, Pin, Rename, Duplicate, Copy Link, Open in Finder, Trash (`:121-195`). Folder context menu: Open in Finder, Trash (`:1308-1316`). Folder actions: "Open…" and "New Folder" (`:1667-1676`). Drag-and-drop moves notes and folders (`:850`, `:940`). Search uses `notes.search` (`:494`). |
| Trash | `R/panels/TrashedNotesPanelContent.tsx` (317) | Copy reads "Deleted notes stay here for 30 days…" (`:215`). Searches with `searchTrashed: true` (`:118-122`). The note shows a "Note will be deleted in N days" pill (`R/panels/CanvasAreaContent.tsx:166`, `:4813`). |
| Folders | `S/state/derived.ts:25-243`, `R/panels/RenameFolderDialog.tsx` | **Folders are identified by path** (`"Notes/Projects/Q1"`). The renderer hard-codes a single root `'Notes'` in 37 places. |
| Canvas / note pane | `R/panels/CanvasAreaContent.tsx` (5100), `S/components/layout/CanvasArea.tsx` | Prose column `max-w-canvas-prose` is 53.125rem (850px), inside `max-w-canvas-blocks` at 68rem (`:4836`, `:4856`). |
| Editor | `R/editor/MarkdownEditor.tsx` (8187) + `R/editor/MarkdownEditor.css` (1175) + 167 other files under `R/editor/` | About 45 plugins (`:8053-8180`), 25 node classes, a floating selection toolbar (`FloatingSelectionTools :5522`, `SelectionToolbarShell` `[data-floating-selection-toolbar]` `:7427`). |
| Title field | `R/panels/CanvasAreaContent.tsx:4858-4953`, `R/panels/useTitleEmojiTypeahead.tsx` (340) | §4 |
| Top bar | `R/panels/TopNavControls.tsx` (78), `R/components/NoteBreadcrumb.tsx` (194), `R/components/NoteSearchInput.tsx`, `R/components/SearchToolbarInput.tsx` | The presence face pile belongs at the start of the right-hand control group (`:4557-4560`), before Search. On macOS the empty notes-panel header row is the traffic-light drag region (`NotesListPanel.tsx:197-223`). On the web it is a candidate slot for the vault switcher. |
| Command palette / prompt | `R/prompt/CommandPaletteOverlay.tsx` (1478), `PromptInput.tsx`, `MentionPlugin.tsx`, `DesktopPromptBox.tsx`, `InlinePromptBox.tsx` | Agent prompt. ⌘K opens it (`R/App.tsx:3791-3800`). The floating toolbar's action button renders only when `onActionClick` is passed (`MarkdownEditor.tsx:7339`). That is how PRODUCT's "AI run action" gets hidden. |
| Agent panel | `S/components/ui/actions-panel.tsx`, `action-timeline-card.tsx` (1394), `R/hooks/useAgentStream.ts`, `R/utils/action-tab-utils.ts` | Present but inert (PRODUCT). Action tabs persist through `notes.update({stickyTabs})` (`R/App.tsx:2764-2800`). |
| Properties | `R/panels/PropertiesTabContent.tsx`, `R/editor/components/FrontmatterHeader.tsx` (1425) | Edits `noteFrontmatterAtom` and bumps `frontmatterDirtySignalAtom`, which triggers autosave (`R/panels/CanvasAreaContent.tsx:3215-3218`). For the web this must become a `Y.Text('frontmatter')` write. |
| Comments UI | `R/editor/plugins/CommentPlugin.tsx` (357), `CommentAnchorTrackerPlugin.tsx`, `R/editor/components/CommentUIWrapper.tsx` (770), `CommentGutter.tsx`, `CommentPopover.tsx` (1243), `CommentInputPopover.tsx`, `CommentTextInput.tsx`, `MentionInput.tsx` (its own `LexicalComposer`), `R/editor/utils/comment-*.ts` (13 files), `CommentsMenuButton` (`R/panels/CanvasAreaContent.tsx:260`) | Anchors are `MarkNode`s wrapped in the synced tree (`CommentPlugin.tsx:254-267`). Metadata lives in `noteCommentsMapAtom` and goes out through the save path as `commentMetadata`. Cmd+Shift+A adds a comment. CRDT comments are M4 (LEARNINGS §4.11). |
| Settings | `R/components/SettingsModal.tsx` (337), `ModalShell.tsx` | Sections: Appearance (theme), Workspace Location (`appConfig`), default `.md` editor, Note intelligence toggle, Connected Folders (`:165-330`). |
| Others | `FeedbackDialog.tsx`, `CopyForAgentDialog.tsx`, `UpdateWidget.tsx`, `DefaultEditorPrompt.tsx`, `FileViewer.tsx`, `LinksSection.tsx` | |
| Split view | `R/panels/SplitPaneContainer.tsx` | Two `CanvasAreaContent` panes, so every collaboration context must be scoped **per pane** (LEARNINGS §4.3 split-view crash). |
| PDF | `R/PdfExportApp.tsx` (787) + `.css` | A separate `?mossMode=pdf-export&pdfExportSessionId=` page (§2, notes PDF). |

### 1.4 Jotai state that owns notes, folders and selection

| Atom | Location | Role |
|---|---|---|
| `noteEntityAtom(id)` | `S/state/note-atoms.ts:41` | Per-note `NoteEntity`. Fields: `id`, `title`, timestamps in **Unix seconds**, `folderPath`, `contentType`, `pinned`, `links` (`S/types/note-entity.ts:50-95`). |
| `noteIdsAtom`, `notesHydratedAtom` | `:49`, `:56` | Index of all notes, and the boot gate. |
| `activeNotesAtom` / `trashedNotesEntityAtom` / `noteListEntityAtom` | `:343`, `:359`, `:382` | Derived lists, sorted by `updatedAt` and `trashedAt`. |
| `removeNoteEntityAtom` | `:453` | Purges every family entry for a note. |
| `noteContentAtom(id)` | `:524` | Markdown body; the editor's `value`. Also read for `hasBodyContent` (`R/panels/CanvasAreaContent.tsx:4327`) and by `CommandPaletteOverlay`. |
| `pendingSavePromiseAtom` | `:533` | In-flight save. |
| `noteFrontmatterAtom`, `frontmatterDirtySignalAtom`, `pendingFrontmatterMetaAtom` | `:554`, `:568`, `:580` | Frontmatter lane. |
| `noteCommentsMapAtom`, `noteCommentAnchorIdsAtom`, `commentDirtySignalAtom`, `commentThreadFilterAtom`, `noteCollapsedHeadingsAtom` | `:113`, `:122`, `:128`, `:133`, `:152` | Comments and collapsed headings. |
| `hydrateNotesAtom` | `S/state/atoms.ts:206` | `notes.getAll` → entities; reconciles deletions. |
| `syncNotesMetadataByIdsAtom` | `:270` | Targeted refresh through `notes.getMetadataByIds`. |
| `activeNoteIdAtom` | `:368` | Selection. Falls back to the most recent active note. Writes `lastViewed*` keys to localStorage. |
| `lastViewedNoteIdAtom`, `lastViewedNoteIdForViewAtom` | `:436`, `:491` | `moss/session:lastViewedNoteId`, `…TrashedNoteId`. |
| `splitTabNoteIdAtom`, `focusedPaneAtom`, `focusedNoteIdAtom`, `open/close/navigate split` atoms | `:676-845` | Split view. |
| Browser split atoms, `webEmbedLightboxTargetAtom` | `:855-1040` | In-app browser. |
| `showCommandPaletteAtom` and related | `:1069-1107` | Command palette. |
| `notesPanelHiddenAtom`, `zenModeAtom`, `actionsPanelHiddenAtom` | `:1120`, `:1123`, `:846` | Panels. The host can preset `notesPanelHiddenAtom` for 390px Tier A layouts with no code change. |
| `navigationHistoryAtom`, `canGoBack/ForwardAtom` | `:1229-1240` | In-memory back and forward (`R/hooks/useNavigationHistory.ts`). |
| `expandedFoldersAtom`, `activeFolderPathAtom`, `revealFolderPathAtom` | `:1250`, `:1257`, `:1273` | Folder UI and the folder used for note creation. |
| `syncNoteEntityAtom` | `:1310` | Partial entity patch, used for title and `updatedAt` echoes. |
| `backendFoldersAtom` | `:1348` | `folders.list` result, which includes empty folders. |
| `searchStateAtom`, `notesSortModeAtom` / `Direction`, `pinnedSectionExpandedAtom`, `placeholderIndexAtom` | `:1833`, `:2059-2077`, `:1949` | Misc UI state. |
| `activeNoteEntityAtom`, `folderListAtom`, `userFolderListAtom`, `externalFolderAtom`, `notesByFolderAtom`, `rootNotesAtom`, `pinnedNotesAtom` | `S/state/derived.ts:14-243` | Derived folder trees. |
| `noteActionTabsAtom` and related | `S/state/note-runtime-atoms.ts` | Agent action tabs. |
| `themeChoiceAtom`, `effectiveThemeAtom`, `useThemeEffect` | `S/state/theme.ts` | Already web-aware: uses localStorage when `electronAPI.settings.getTheme` is absent. |
| Renderer-local atoms | `R/state/*.ts`, `CommentPlugin.tsx:52-115`, `ImageLightbox` `lightboxSrcAtom` | Granted directories, settings warmup, default editor, workspace info, comment input state. |

**Folder model consequences for the server mapping:**

- One vault maps to the root `'Notes'`.
- A D1 folder maps to the path `'Notes/<a>/<b>'`.
- Folder names must not contain `/`, and names must be unique per parent.
- A rename or move changes the paths of every descendant. The adapter keeps an id↔path map and refreshes metadata afterwards.
- Docs shared into a user's view from someone else's vault have no place in moss's model (see §7).

---

## 2. The `window.electronAPI` surface

**Type:** `T/electron-api.d.ts:399-420` defines 20 namespaces; `webEmbedPreview` and `remoteWebSurface` are optional.

**Desktop implementation:** `packages/desktop/src/preload/preload.ts:54-427`, a `contextBridge` over IPC.

**How the renderer reaches it:**

- Most calls go through `R/api/electron.ts`, where `createInvoker` wrappers throw `Electron API not found on window` if the bridge is missing (`:29-39`). Optional members fall back to `[]`, `null` or `{ ok:false, errorCode:'unsupported' }`.
- About 30 sites call `window.electronAPI.*` directly:
  - `R/App.tsx`: `onRequestFlush`, `flushComplete`, `onDiskChange`, `onMetadataReindexed`, `update.onReady`, `onExternal/InternalFileOpen`, `getById`, `getWindowContext`, `waitForReady`.
  - `R/panels/CanvasAreaContent.tsx`: `onDiskChange`, `getById`, `analytics`.
  - `R/editor/MathCalculationPlugin.tsx:1757` (`onDiskChange`).
  - `R/editor/plugins/CollapsibleHeadingPlugin.tsx:752` (`notes.update`).
  - `R/state/*` (`settings.*`), `R/components/*` (`settings.*`, `analytics`, `update.install`).
  - `R/error-analytics.ts:295`, `S/state/atoms.ts:52`, `S/state/theme.ts:80`.

**Rule:** the web adapter installs a **complete** `ElectronAPI` object before `App` mounts. Every namespace and every subscription must exist; subscriptions return a no-op unsubscribe function.

**Columns in the tables below:**

- **Callers** lists where the renderer calls the method.
- **Web treatment** is one of:
  - **REST**: a Worker API call.
  - **Y**: a write or read on the bound Y.Doc.
  - **Browser**: a web platform API.
  - **Local**: localStorage.
  - **Hide**: the UI that calls it is removed; the adapter returns a harmless value.
  - **Stub**: not called by the renderer at the pin; return a harmless value.

### 2.1 `notes`

| Method | Callers | Web treatment |
|---|---|---|
| `getAll()` | `S/state/atoms.ts:206` (boot, reconcile, full rehydrate) | **REST** list of the vault's live and trashed docs. Map each to `NoteMetadataRecord` (`C/noteTypes.ts:167-202`): timestamps in **seconds** (LEARNINGS §4.8), `folderPath` as `Notes/...`, `contentType`, `pinned`/`pinnedAt`, `outgoingLinks`/`incomingLinks`, `contentPath` = the doc URL. **Overlay the live `Y.Text('title')` value for any bound doc**, so a lagging D1 title never reaches the entity. |
| `getMetadataByIds(ids)` | `S/state/atoms.ts:270` (targeted refresh after `onDiskChange`) | **REST** batch metadata, with the same mapping and title overlay. |
| `getById(id, {signal, skipAnalytics})` | `R/App.tsx:1747` (startup), `:2524`, `:2593` (file-open events), `:3491`; `R/panels/CanvasAreaContent.tsx:1773`, `:1862` (init effect), `:3509` (`forceReloadFromDisk`); `R/utils/preloaded-note-record-cache.ts:28-36` (prefetch on every note switch) | **REST** metadata plus per-viewer extras: `stickyTabs: []`, `collapsedHeadings` from local storage, `commentMetadata: {}`, `layoutMetadata` from local storage. **For a doc that will be bound, return `content: ''` and never feed content to the editor**; the binding fills it. The trash view (unbound, read-only) needs real markdown; see §7. |
| `getContent(id, {contentReadMode})` | `R/App.tsx:2936` (duplicate), `R/editor/MathCalculationPlugin.tsx:222`, `:1340` (workspace formulas, fan-out over every note), `R/editor/plugins/FileLinkPlugin.tsx:757` (`raw`), `R/panels/CanvasAreaContent.tsx:2451`, `:2822`, `:2886`, `:2922`, `:3672` (revalidate, save CAS, agent reload) | **REST** markdown export from the Durable Object (one converter). The adapter limits concurrency to about 3 requests. It must never be used to repaint a bound editor; the seam removes those callers (§3.7). |
| `getFrontmatterSuggestions()` | `R/panels/CanvasAreaContent.tsx:3024` (after save) | **REST** keys and values aggregated per vault. `{}` is acceptable early. |
| `getHeadings(id)` | `R/editor/plugins/FileLinkTypeaheadPlugin.tsx:150` (`[[Note#heading]]`) | **REST**, derived from the server export. |
| `create(title, folderPath?)` | `R/App.tsx:2886` (`'Untitled'`), `:2947` (duplicate), `:2330` (automation) | **REST** `POST` doc in the folder. The Durable Object seeds one empty paragraph and an **empty** `Y.Text('title')`; never seed "Untitled" as text (LEARNINGS §4.4). Return `title: 'Untitled'` as a projection, which moss displays as an empty field (`normalizeTitleDisplayValue`, `R/panels/CanvasAreaContent.tsx:740-743`). |
| `update(id, input)` | `R/App.tsx:2778` (`stickyTabs`), `R/panels/CanvasAreaContent.tsx:1481` (`{title}` from `syncH1ToTitle`), `:2834`, `:2862` (save: `content`, `commentMetadata`, `layoutMetadata`, `expected*` CAS, `activeUserWins`, `frontmatterMetaUpdates`, `commentColors`, `updatedAt`), `R/panels/NotesListPanelContent.tsx:1111` (`pinned`/`pinnedAt`), `CollapsibleHeadingPlugin.tsx:752` (`collapsedHeadings`) | Route by field: |
| | | • `title`: **Y** if bound; otherwise **REST** "rename request", which the Durable Object applies as a CRDT write (LEARNINGS §4.4 RW-1). |
| | | • `content`: **REST** structural-merge endpoint (the same one as CLI push) when the doc is unbound, e.g. duplicate's create-then-update. If the doc is **bound**, refuse loudly: throw and log, never drop silently (PRODUCT). |
| | | • `commentMetadata` / `commentColors`: CRDT in M4; until then refuse loudly or ignore with a log. |
| | | • `layoutMetadata`, `collapsedHeadings`: **Local** (ruling 11). |
| | | • `pinned` / `pinnedAt`: **REST**. Whether pins are per-user or per-doc is open (§7). |
| | | • `stickyTabs`, `frontmatterMeta*`, `frontmatterInference`, `noteHierarchyCache`, `lastOpenedAt`: no-op, return the record. |
| | | • `trashedAt`: use `delete`/`restore`. `updatedAt` is server-owned and ignored. |
| | | Always return an `UpdateNoteResult` with seconds timestamps. |
| `delete(id)` | `R/App.tsx:3045` | **REST** soft delete. The Durable Object closes peers with 4410 (LEARNINGS §4.6). Return `true` only after the server acknowledges. |
| `restore(id)` | `R/App.tsx:3148` | **REST** restore, returning the `NoteRecord`. |
| `search({query, limit, searchTrashed})` | `R/panels/NotesListPanelContent.tsx:494`, `R/panels/TrashedNotesPanelContent.tsx:118`, `R/editor/plugins/FileLinkTypeaheadPlugin.tsx:143`, `:163` | **REST** `SearchDO`, returning `NoteSearchResult` (`C/noteTypes.ts:501`). |
| `getFilesystemPath(id)` | `R/panels/CanvasAreaContent.tsx:3833` (Copy note link), `:3871` (Share with Agent) | **Browser**: return the doc URL. Copy note link then puts the URL in `text/plain` and moss's HTML payload (`R/editor/utils/note-link-clipboard.ts`); the clipboard code is already web-standard (`:3846-3853`). |
| `setOpenFileWatchTargets(ids)` | `R/App.tsx:964-974` | Adapter hint: the set of open docs, which drives the workspace-channel subscription. No sockets from unsettled sets (LEARNINGS §4.6). |
| `copyLinkToClipboard(id, input)` | `R/panels/NotesListPanelContent.tsx:1130` | **Browser** `navigator.clipboard.write` with a `text/plain` URL and a `text/html` span payload (mirrors `main/ipc-handlers.ts:4175-4215`). |
| `showInFinder(id)` | `R/panels/NotesListPanelContent.tsx:1080`, `R/panels/TrashedNotesPanelContent.tsx:173` | **Hide** (PRODUCT "reveal in Finder"). |
| `createPdfExportSession` / `openPdfExportPreview` / `openPdfExportRenderSurface` / `getPdfExportSession` | `R/panels/CanvasAreaContent.tsx:3950`, `:3976` (Save as PDF), `R/App.tsx:2252`, `:2272` (automation), `R/PdfExportApp.tsx:469` | **Browser print** (ruling 4). Store the session payload in same-origin storage keyed by session id, and `window.open('/?mossMode=pdf-export&pdfExportSessionId=…&pdfExportPreview=1')`. The web entry honours `mossMode` like `R/main.tsx:46` and calls `window.print()` once `body[data-pdf-export-status=ready]` (`R/PdfExportApp.tsx:31-39`). This reuses moss's own print layout with no change to moss code. Risk: the popup blocker if more than about 5 s pass between the click and `window.open`. |
| `exportPdf` | (unused) | Stub. |
| `exportMarkdown(id, input)` | `R/panels/CanvasAreaContent.tsx:4010` (Save as Markdown) | **Browser** download of the server export (one converter). Return `{canceled:false}`. |
| `onExternalFileOpen(cb)` | `R/App.tsx:2519` | Never fires. |
| `onInternalFileOpen(cb)` | `R/App.tsx:2586` | **Routing seam.** Fire on `popstate` or in-app navigation to `/d/:id`; App already runs a serialized note switch. |
| `onDiskChange(cb(noteIds, contentNoteIds))` | `R/App.tsx:1503`, `R/panels/CanvasAreaContent.tsx:3257`, `R/editor/MathCalculationPlugin.tsx:1757` | Workspace-channel bridge. Emit **metadata-only** changes (`contentNoteIds = []`) for renames, moves, trash and peer edits. **Never include a bound doc id in `contentNoteIds`.** `CanvasAreaContent` then returns early (`:3260-3262`), and `App` does targeted metadata refreshes (`:1505-1540`). |
| `onMetadataReindexed(cb)` | `R/App.tsx:1542` | Fire after a reconnect or vault switch, which triggers a full rehydrate. |
| `onRequestFlush(cb)` / `flushComplete()` | `R/App.tsx:993-1080` | Never fires; no-op. The Y.Doc persists every update. |

### 2.2 `folders`

The input types are in `C/noteTypes.ts:1006-1077`.

| Method | Callers | Web treatment |
|---|---|---|
| `list({cleanupEmpty})` | `R/App.tsx:1451`, `:1657`, `:2537`; `R/panels/NotesListPanelContent.tsx:465` | **REST** list of folders as `FolderEntry {name, path:'Notes/…', noteCount, createdAt(s)}`. Never return `type:'system'`. |
| `create({name, parentPath?, noteIds?})` | `R/panels/NotesListPanelContent.tsx:732` | **REST**: map the parent path to an id, create the folder, optionally move `noteIds`. |
| `rename({currentPath, newName})` | `R/panels/NotesListPanelContent.tsx:1237`, `R/panels/RenameFolderDialog.tsx` | **REST**, then remap descendant paths and refresh metadata. |
| `delete({path, moveNotesTo:'trash'})` | `R/panels/NotesListPanelContent.tsx:1184` | **REST** soft-deletes the subtree to Trash. Each doc gets 4410. Restore must work (LEARNINGS §4.10). |
| `moveNotes({noteIds, targetFolderPath})` | `:850` | **REST**, returning `NoteMetadataRecord[]`. |
| `moveFolder({sourcePath, targetParentPath})` | `:940` | **REST**. |
| `showInFinder(path)` | `:1196` | **Hide**: the folder context-menu item at `:1309-1312`. |

### 2.3 `agent`, `chat`, `checkpoints`

| Method | Callers | Web treatment |
|---|---|---|
| `agent.execute(input)` | `R/App.tsx` prompt submit (`handleActionPromptSubmit :3593`, retry `:4001`) | The prompt UI is hidden (PRODUCT "AI run action"). Reject with a clear "unavailable on web" error. |
| `agent.cancel(noteId)` | `R/App.tsx` (trash or cancel paths) | No-op. |
| `agent.cancelByTabId` | (unused) | Stub. |
| `agent.onStream(cb)` | `R/hooks/useAgentStream.ts:25`, `R/panels/CanvasAreaContent.tsx:3615` (**unconditional behind `hasElectronBridge`**) | No-op subscription. **It must exist.** |
| `chat.getMessages`, `checkpoints.getAll` | (unused at the pin) | Stub `[]`. Version history is a new web surface (PRODUCT); moss's `TimelinePopoutModal` is used only in the automation fixture (`R/App.tsx:669`), and `VersionHistoryEmptyState` is exported but not mounted. |

### 2.4 `files`, `filesystem`, `grantedDirs`, `externalNotes`, `shell`, `appConfig`

| Method | Callers | Web treatment |
|---|---|---|
| `files.search` | (unused) | Stub `[]`. |
| `files.listDirectory` | `R/editor/typeahead/mentionSearch.ts`, `R/state/granted-dirs-atoms.ts` | `[]`, so there are no directory @-mentions. |
| `files.open` | `R/panels/NotesListPanelContent.tsx:641` ("Open…") | **Hide** the "Open…" item (`:1667-1671`). |
| `filesystem.openFolderDialog/openFileDialog/readDirectory/getHomeDirectory` | (unused) | Stubs. |
| `filesystem.readFile` | `R/components/FileViewer.tsx` (connected-folder files) | Reject. The surface is unreachable without connected folders. |
| `grantedDirs.list/grant/revoke` | `R/state/granted-dirs-atoms.ts` | Return `[]`. **Hide** the Connected Folders section in Settings (PRODUCT). |
| `externalNotes.close/closeByRoot` | `R/panels/CanvasAreaContent.tsx`, `R/panels/NotesListPanelContent.tsx:1089`, `R/panels/SystemFolderSection.tsx` | `false` / `[]`; external notes never exist on the web. |
| `externalNotes.resolveLink` | `R/editor/plugins/FileLinkPlugin.tsx:356` (external notes only) | `null`. |
| `shell.revealPath` | `R/panels/CanvasAreaContent.tsx`, `R/panels/SystemFolderSection.tsx` | **Hide**. |
| `appConfig.getWorkspacePath` | `R/state/workspace-info-atoms.ts`, Settings | **Hide** the Workspace Location row; the vault switcher replaces it. |
| `appConfig.setWorkspacePath/pickWorkspaceFolder` | Settings | **Hide**. |
| `appConfig.restartApp` | (unused) | Stub. |

### 2.5 `images`

The asset types are in `C/noteTypes.ts:538-600`. Uploading requires editor role (PRODUCT).

| Method | Callers | Web treatment |
|---|---|---|
| `save({data: base64, filename, mimeType, noteId})` | `R/editor/plugins/MediaDropPlugin.tsx:588`, `:606`; `R/editor/plugins/VideoPastePlugin.tsx:160` | **REST** upload to folder-scoped R2, returning `{relativePath:'assets/<file>', absolutePath:<URL>, filename}`. Browsers have no `File.path`, so drop and paste already use this path (`MediaDropPlugin.tsx:564-606`). |
| `pick({noteId})` | `R/editor/slash-commands/registry.ts:486` (`/media` → "From computer"), `R/editor/components/CommentPopover.tsx`, `R/editor/components/CommentInputPopover.tsx`, `R/prompt/CommandPaletteOverlay.tsx` | **Browser** `<input type=file accept=image/*,video/* multiple>`, then upload each file and return the results. Risk: `pick` runs after an `await` on the dialog, so the transient user activation can expire; test it. |
| `persistUrl({noteId, url})` | `R/editor/utils/remote-image-url.ts` | **REST** SSRF-safe fetch-and-store (LEARNINGS §4.17). |
| `copyFromPath({filePath})` | `MediaDropPlugin.tsx:579`, `:659`; `VideoPastePlugin.tsx:132` | Unreachable on the web (no paths). Reject. |
| `copyFromNoteAsset({sourceNoteId, sourceRelativePath, destinationNoteId})` | `R/editor/plugins/ExternalImagePastePlugin.tsx:272` (paste between notes) | **REST** server-side copy within storage. |

**Asset URLs need a code change.** `toDisplaySrc` (`R/editor/utils/asset-url.ts:74-94`) emits `moss-asset://…?noteId=`, and `media-server-url.ts` emits `http://127.0.0.1:<port>/media?…` (`:80`). Neither loads in a browser. The importers are App, MarkdownEditor, the comment popovers, Image, Video, WebEmbed, the EmbedPill nodes and hover card, `useHtmlPreviewImage`, `ExternalImagePastePlugin`, `BrowserSplitPane` and `CommandPaletteOverlay`. **Substitute these two modules** with web versions that produce `/api/docs/:id/assets/<file>` URLs aware of folder and vault scope (LEARNINGS §4.15). `C/moss-asset-url.ts` is the shared parser.

### 2.6 Derived previews: `htmlPreview`, `webEmbedPreview?`, `videoThumbnail`, `remoteWebSurface?`

| Method | Callers | Web treatment |
|---|---|---|
| `htmlPreview.ensure` | `R/editor/nodes/html/useHtmlPreviewImage.ts` | Return `null`. **Code change**: HTML blocks render the live sandboxed iframe as their static preview (`R/editor/nodes/HtmlBlockquoteNode.tsx:71-83` preview-mode decision, `:1001-1022` interactive layer). Otherwise every block shows a placeholder (LEARNINGS §4.1). |
| `htmlPreview.onMaterialized/onFailed` | same file | No-op. |
| `webEmbedPreview.ensure(input)` | `R/editor/nodes/web-embed/useWebEmbedPreview.ts`, `R/editor/plugins/EmbedPillPlugin.tsx` (×3), `R/panels/BrowserSplitPane.tsx` | **REST** SSRF-safe unfurl (oEmbed or OpenGraph), returning `DerivedPreviewResult` (`C/derived-preview.ts`). Without it, web embeds and pills show no preview card. |
| `webEmbedPreview.subscribe` | `useWebEmbedPreview.ts` | No-op, or a push channel if the unfurl is asynchronous. |
| `videoThumbnail.ensure` | (unused by the renderer) | Stub. |
| `videoThumbnail.onMaterialized` | `R/editor/nodes/VideoNode.tsx` | No-op. `<video>` streams from R2 with HTTP Range requests (LEARNINGS §4.1). |
| `remoteWebSurface.*`: 13 invokes and 6 subscriptions | `R/editor/preview/RemoteWebSurface.tsx`, `useRemoteWebSurfaceSelection.ts`, `WebEmbedLightbox.tsx`, `R/panels/BrowserSplitPane.tsx` (back, forward, find, focus, palette shortcut), `R/panels/CanvasAreaContent.tsx:3184` (`destroyForNote`) | Leave the namespace **undefined**; the wrapper returns `{ok:false, errorCode:'unsupported'}`. **Code change**: substitute `RemoteWebSurface.tsx` with a `remote-webpage`-policy iframe (`C/embed-iframe-policy.ts:69-84`), per ruling 4. The browser split loses back/forward, find-in-page and `copySelection` across origins. Many sites refuse framing, so keep moss's "open externally" fallback as a browser tab. |

### 2.7 `system`

| Method | Callers | Web treatment |
|---|---|---|
| `showEmojiPanel()` | `R/editor/slash-commands/registry.ts:467` (`/emoji`) | No web API exists. **Decision needed**: hide `/emoji`, or open moss's own emoji typeahead (`R/editor/emoji-picker/EmojiPickerPlugin.tsx`). |
| `getMediaServerInfo()` | `R/editor/utils/media-server-url.ts:25` | `null`; superseded by the asset URL substitution in §2.5. |
| `getGlobalShortcut/setGlobalShortcut/setGlobalShortcutEnabled` | (unused) | Stubs. |
| `setImageAltTextMenuEnabled` | `R/panels/CanvasAreaContent.tsx` | No-op. **Note:** image alt text can only be edited through the native Edit menu (`onNativeMenuCommand('edit-image-alt-text')`, `:3546-3570` → `MarkdownEditor.tsx:7879` → `OPEN_IMAGE_ALT_TEXT_EDITOR_COMMAND`). On the web this is unreachable unless an affordance is added. Treat it as a documented deviation. |
| `createWindow({noteId})` | `R/panels/NotesListPanelContent.tsx:1144` ("Open in New Window"), `R/editor/plugins/FileLinkPlugin.tsx:1001` | **Browser** `window.open('/d/<id>', '_blank', 'noopener')` (ruling 4). Return `{action:'created', windowId:-1}`. |
| `getWindowContext()` | `R/App.tsx:1246` | Return `{windowId:1, initialNoteId:<route param>, launchReason:'initial-launch', openedFromWindowId:null}`. |
| `setFocusedNoteId(id)` | `R/App.tsx:976-981` | **URL sync**: `history.replaceState` to `/d/<id>`. Use `pushState` only if browser back should mirror moss's back/forward; moss keeps its own in-memory history. |
| `startWindowDrag/moveWindowDrag/endWindowDrag` | `R/panels/CanvasAreaContent.tsx:4248-4297` (canvas top drag strip) | No-op. |
| `onGlobalShortcutActivated` | `R/App.tsx:3738-3749` | No-op (PRODUCT: global quick-capture is hidden). |
| `onNativeMenuCommand` | `R/panels/CanvasAreaContent.tsx:3546` | No-op. |
| `waitForReady()` | `R/App.tsx:1262` | Resolve after the session and vault are resolved. This is the boot gate. |

### 2.8 `update`, `analytics`, `settings`

| Method | Callers | Web treatment |
|---|---|---|
| `update.onReady` | `R/App.tsx:1566-1578` | Never fires, so `UpdateWidget` never shows (PRODUCT "auto-update"). |
| `update.install` | `R/components/UpdateWidget.tsx` | Unreachable. |
| `analytics.capture(event, props)` | `R/components/FeedbackDialog.tsx:42` (`feedback_submitted`), `R/editor/plugins/EditorInputSamplingPlugin.tsx:68`, `R/panels/CanvasAreaContent.tsx:3901`, `R/error-analytics.ts:295` (window errors) | **REST**: send `feedback_submitted` to the D1 `feedback` table (the schema in LEARNINGS §4.8). Error events may go to a log endpoint; everything else is a no-op. |
| `settings.getTheme/setTheme` | `S/state/theme.ts:98-140` | **Local**: the `moss_theme` localStorage key, which `theme.ts` already uses as its fallback. |
| `settings.getNoteIntelligence/setNoteIntelligence` | `R/state/settings-warmup-atoms.ts:30`, `R/components/SettingsModal.tsx:116` | **REST** `user_prefs`, or Local. It drives "Default Properties" and "Related Notes"; decide whether to keep the toggle. |
| `settings.isDefaultMdEditor/setDefaultMdEditor` | `R/state/default-editor-atoms.ts`, `R/components/SettingsModal.tsx:145`, `R/components/DefaultEditorPrompt.tsx` | **Hide** the Settings row (PRODUCT). Return `true` / `false`. |
| `settings.getDefaultEditorPromptDismissed/set…` | `R/components/DefaultEditorPrompt.tsx` | Return `true`, so the prompt never renders. |

### 2.9 Globals besides the bridge

| Global | Treatment |
|---|---|
| `window.__MOSS_AUTOMATION_ENABLED__` | Set by preload from `MOSS_AUTOMATION=1` (`preload.ts:435-438`). It gates the automation controller (`R/App.tsx:2088-2100`; contract in `C/automation.ts`: `openNote`, `openSplit`, `scrollToHeading`, …). It is useful for dev-only drivers; production must not set it (LEARNINGS §4.20). |
| `window.__MOSS_AUTOMATION__` | The controller itself. |
| `process.env` | Read through `R/utils/renderer-env.ts`, which guards against `globalThis.process` being undefined. It is safe in browsers. |

### 2.10 Hide registry: every site that needs a JSX change

Moss renders all of the following unconditionally, because `hasElectronBridge` is true on the web too (LEARNINGS §4.1). Keep one registry module (`id`, site, reason) and change each site with a single seam:

| Registry id | Site | Ruling |
|---|---|---|
| `share-with-agent` | `R/panels/CanvasAreaContent.tsx:4612-4634` | Hide |
| `ai-run-action` | `R/App.tsx` canvas props `onActionClick: handleOpenPrompt` (`:3950`) and the ⌘K handler (`:3791`) | Hide: pass `undefined`; then `MarkdownEditor.tsx:7339` drops the button |
| `reveal-in-finder` | `R/panels/NotesListPanelContent.tsx:172-175`, `:1308-1312`; `R/panels/TrashedNotesPanelContent.tsx:57-61` | Hide |
| `open-directory` | `R/panels/NotesListPanelContent.tsx:1667-1671` ("Open…") | Hide |
| `open-in-new-window` | `R/panels/NotesListPanelContent.tsx:139-142` | Keep; the adapter opens a browser tab |
| `save-as-pdf`, `save-as-markdown` | `R/panels/CanvasAreaContent.tsx:4666-4681` | Keep; they are enabled because the bridge exists. Behaviour per §2.1. |
| `create-note-shortcut-label` | `S/components/layout/NotesListPanel.tsx:288` (⌘N chip) | Hide (PRODUCT) |
| `title-shortcut-label` | `R/panels/CanvasAreaContent.tsx:4947-4952` (⌘T chip) | **Ruling needed** |
| `settings-native-sections` | `R/components/SettingsModal.tsx:169-330`: Workspace Location, default `.md` editor, Connected Folders | Hide (PRODUCT) |
| `emoji-panel` | `R/editor/slash-commands/registry.ts:460-469` | **Ruling needed** |

---

## 3. The content load and save path, and the collaboration seam

### 3.1 Load: from switching notes to an editor showing markdown

1. **Selection.** `handleSelectNote` (`R/App.tsx:1873`) runs inside `runSerializedNoteSwitch` (`:1801`). It first awaits `flushBeforeNoteSwitch` (`:1806-1817`), which calls `canvasRef.flushAndWait()` and therefore saves the current note. Next it awaits `prefetchNoteRecord(id)`, which runs `notes.getById` into a module cache (`R/utils/preloaded-note-record-cache.ts:28-37`). Then it sets `activeNoteIdAtom`.
2. **Hydration gate.** `CanvasAreaContent` reads `activeNoteEntityAtom` (`:918-920`). On a note change the init effect calls `setContentHydratedForNoteId(null)` (`:1676-1678`), so the skeleton shows (`:4840-4849`).
3. **Init effect** (`:1651-1934`, **dependencies `note?.id` and `note?.updatedAt`**, `:1928-1933`):
   - If the note id is unchanged, it runs "own-write echo guards" (`:1681-1709`): an `updatedAt` matching the last local save, an expected sticky-tab timestamp, an agent reload already applied, or a dirty user editor. Any match returns early.
   - Without a bridge (stories and tests): content `''`, marked hydrated (`:1713-1745`).
   - With a preloaded record: `hydrateFetchedNoteRecord` (`:1758-1764`), then a **verification `notes.getById`**. If the content, comments or layout differ, it hydrates again and may force a remount (`:1770-1856`).
   - Otherwise: `notes.getById` (`:1861-1916`) → `hydrateFetchedNoteRecord`.
4. **`hydrateFetchedNoteRecord`** (`:1496-1595`) does the following:
   - Refuses if the editor is dirty with user edits.
   - Strips the legacy comment footer and records `lastKnownDiskContentRef`.
   - Checks markdown safety, so very large notes become a load error (`:1515-1524`).
   - `disassembleNote(raw)` → frontmatter, `h1Title`, body, comments (`C/markdown-layers.ts:525-534`).
   - `noteFrontmatterAtom` ← frontmatter.
   - **`syncH1ToTitle(noteId, h1Title)`** (`:1468-1494`): if the H1 differs from the entity title, it updates the entity **and calls `notes.update({title})`**. Moss's title therefore follows the file's H1 on load.
   - `noteContentAtom` ← body; `setContentHydratedForNoteId(noteId)` (`:1544-1548`).
   - If the note is unchanged but the body differs from the previous disk content → `remountEditorPreservingScroll('disk_content_changed')` (`:1550-1554`).
   - Entity `updatedAt` and `trashedAt` patched; sticky tabs merged; `noteCommentsMapAtom` ← `hydrateComments(...)`; `noteCollapsedHeadingsAtom` ← record (`:1556-1594`).
5. **Editor mount.** After hydration, the editor mount is deferred by one animation frame when a bridge exists (`:1340-1365`). `shouldMountEditor` is at `:4819-4821`. The editor element is `<MarkdownEditor key={`${note.id}-${editorVersion}`} value={content} layoutMetadata=… readOnly={isTrashed} onReady={handleEditorReady} …/>` (`:4976-5000`).

### 3.2 Parse into Lexical

In `R/editor/MarkdownEditor.tsx`:

- `initialConfig` (`:7664-7727`) builds `editorState` as either `cachedEditorState ?? importMarkdownValue` (`:7697-7712`). `cachedEditorState` comes from the module LRU (`:7666`; the cache key is note id plus hashes of content, comments and layout, `:4237-4243`).
- `importMarkdownValue` (`:7668-7695`): strip the legacy footer → read comment metadata from `noteCommentsMapAtom` → strip the leading H1 (`:7684-7688`) → `normalizeMarkdownForImport` → `$convertFromMarkdownString(escapeHtmlEntities(body), MARKDOWN_EDITOR_TRANSFORMERS)` → `$postImportNormalize(commentMetadata, undefined, {layoutMetadata})`.
- `$postImportNormalize` turns `%%m:ID:start%%` markers into `MarkNode`s, converts custom code nodes, normalises list nesting, and applies table and tab widths (`:3361-3525`).
- Other `initialConfig` fields: `editable: !readOnly` (`:7719`), `nodes: MARKDOWN_EDITOR_NODES`, `onError: throw` (`:7721-7723`).
- `handleEditorReady` (`:7610-7631`) writes the serialized state into the LRU one animation frame later.
- `updateContentFromMarkdown` (`:7939-8020`), the in-place re-import used for disk and agent updates: `root.clear()` then re-convert, tag `'agent-content-update'`, then `CLEAR_HISTORY_COMMAND` (`:8013`).

### 3.3 Save path

| Step | Where | What happens |
|---|---|---|
| Dirty tracking | `handleEditorReady` in `CanvasAreaContent` (`:4079-4111`) | `editor.registerUpdateListener` → `markDirty('user' \| 'derived')` → `scheduleDebouncedAutosave()`. Tag sets are in `R/editor/utils/editorUpdateTags.ts`. The `MarkdownEditor` `onChange` is a deliberate no-op (`:3790-3795`). |
| Debounce | `:1242-1266` | 1500 ms idle, with a 15000 ms maximum window (`:170-171`). |
| Periodic save | `:3204-3231` | Every 30 minutes, plus subscriptions to `commentDirtySignalAtom` and `frontmatterDirtySignalAtom` (`:3213-3219`). |
| `saveContent` | `:2517-3149` | Serializes the editor (`getEditorBodyMarkdown(true)`, `:1935`), prunes comments, collects layout metadata. `buildMarkdownForSave` = `assembleNote({frontmatter / rawFrontmatterBlock, h1Title: liveTitleText \|\| 'Untitled', body})` (`:2242-2277`). Rebases on the latest disk content on conflict (`C/markdown-layers.ts:603-700`), then `notes.update({content, expectedDiskContent, commentMetadata, expectedCommentMetadata, layoutMetadata?, expectedLayoutMetadata?, updatedAt, frontmatterMetaUpdates?, commentColors})` (`:2830-2853`). After 3 CAS conflicts it retries with `activeUserWins:true` (`:2861-2880`). |
| Flushes | `:3160-3196`, `R/App.tsx:993-1080` | Flush on note change or unmount (`useLayoutEffect` cleanup). The quit flush is in App. |

### 3.4 Every path that re-fetches or remounts the editor

| # | Path | Location |
|---|---|---|
| 1 | Init effect keyed on `updatedAt` → `hydrateFetchedNoteRecord` → remount | `:1651-1934`, `:1550-1554` |
| 2 | Preload verification re-fetch → layout or body divergence → forced remount | `:1770-1856` |
| 3 | Disk watcher `onDiskChange` → `revalidateActiveNoteFromDisk` → `applyDiskUpdate` → `updateContentFromMarkdown` (in-place clear and re-import); remounts on failure | `:3233-3293`, `:2406-2515`, `:2314-2397` |
| 4 | Agent `editor_update` / `complete` → `applyDiskUpdate` / `getContent` | `:3612-3780` |
| 5 | `forceReloadFromDisk` (automation) | `:3505` |
| 6 | `readOnly` flip → `LexicalComposer` key change | `MarkdownEditor.tsx:8053` |
| 7 | `editorVersion` bump → `MarkdownEditor` key change | `:1088-1098` |
| 8 | Note id change: a new key, so a fresh editor | expected |

### 3.5 Effects keyed on `updatedAt`

- The init effect dependency (`:1930`) is the one that hurts.
- Sidebar ordering (`activeNotesAtom` sorts by `updatedAt`, `S/state/note-atoms.ts:343-352`), folder "recent" sort (`S/state/derived.ts:145-160`) and relative times in `NoteCard` all read it, harmlessly.
- `persistActionTabs` uses `expectStickyTabMetadataUpdate` to pre-arm the echo guard (`R/App.tsx:2771-2789`).

On the web, peers' edits bump `updatedAt` through the workspace channel, and that must keep sorting working. The bound note's init effect must therefore ignore `updatedAt` entirely; do not freeze `updatedAt` as a workaround.

### 3.6 Facts about `@lexical/react` 0.48.0 `CollaborationPlugin`

These were read from `src/LexicalCollaborationPlugin.tsx` and `src/shared/useYjsCollaboration.tsx`:

- **Placement.** It must sit inside `<LexicalCollaboration>`, which holds `yjsDocMap`, `name`, `color` and `isCollabActive`.
- **V1 props:** `{id, providerFactory(id, yjsDocMap) → Provider, shouldBootstrap, username, cursorColor, cursorsContainerRef, initialEditorState, excludedProperties, awarenessData, syncCursorPositionsFn, selectionHighlight, rootName='root'}`. The root shared type is an `XmlText`.
- **V2 props** (`CollaborationPluginV2__EXPERIMENTAL`): `{id, doc, provider, __shouldBootstrapUnsafe, …, rootName='root-v2'}`. The root is an `XmlElement`. **The two Yjs layouts are incompatible**, so the server converter must use the same variant (`createBinding`/`sync*` vs `createBindingV2__EXPERIMENTAL`/`sync*V2`). V2 also offers `DIFF_VERSIONS_COMMAND__EXPERIMENTAL` (render a snapshot diff in place), which is relevant to the M6 history diff.
- **Provider lifecycle.** V1 creates the provider once, inside an effect guarded by a ref, and disconnects it on cleanup. `useProvider` calls `connect()` on mount and `disconnect()` on unmount. There is a known StrictMode race (lexical #6640). Moss wraps the app in `StrictMode` (`R/main.tsx:44-52`); that only double-invokes effects in development builds, and the dev stack is a production vite build, but verify it.
- **Bootstrap.** On the provider's `sync(true)`, it bootstraps only if `shouldBootstrap` is set and the root is empty. Use `shouldBootstrap:false`; the server seeds content (LEARNINGS §4.3).
- **No initial reconcile.** No path reconciles an already-populated doc when the binding is created. Remote content arrives only through `observeDeep`. A remount must therefore use a **fresh** Y.Doc. If a warm doc must be reused, apply `Y.encodeStateAsUpdate(warm)` to the fresh doc *after* the binding exists.
- **History.** `useYjsHistory` creates `createUndoManager(binding, root)` with `trackedOrigins: {binding, null}`. It handles `UNDO_COMMAND`/`REDO_COMMAND`, so moss's `UndoRedoPlugin` (`MarkdownEditor.tsx:4339-4380`) keeps working. The 1000 ms `captureTimeout` that LEARNINGS asks for needs an extension, because `createUndoManager` takes no options.
- **Cursors.** The plugin renders remote cursors itself, into a portal (`cursorsContainerRef`) or a default container. `useYjsFocusTracking` publishes focus. The prior custom binding never rendered cursors; the official plugin does.
- **Exclusions.** `excludedProperties` is a `Map<Klass<LexicalNode>, Set<string>>` keyed by **class**. Bundle exactly one instance of each node module, or exclusion silently fails (LEARNINGS §4.3).

### 3.7 The seam: the exact edits

The goal is that for a bound doc the Y.Doc is the only content source, and no REST response can repaint or remount the editor (LEARNINGS §7.1 rule 5). Keep each edit small and mark it `// moss-multi seam: <name>` so re-pinning stays a reviewable patch.

**A. `R/editor/MarkdownEditor.tsx`.** About 5 seam sites, roughly 40 lines.

1. Add a prop `collaboration?: { plugin: ReactNode } | null`. Its presence makes the editor **bound**.
2. In `initialConfig` (`:7697-7726`), when bound:
   - `editorState: null`, so `LexicalComposer` does nothing (`LexicalComposer.tsx:178`).
   - Skip `readMarkdownEditorStateCache`.
   - `editable: false`. It becomes editable after the first sync; see C.
3. In `handleEditorReady` (`:7610-7631`), when bound, do not call `rememberMarkdownEditorStateCache`. Removing it removes the error #38 source.
4. At `:8076`, render `{collaboration ? collaboration.plugin : <HistoryPlugin />}`. The plugin must be a child of `LexicalComposer`, and this file is the only place that is true.
5. At `:8053`, when bound the key is `` `${noteId}` ``, without the `readOnly` flag. Role and trash changes go through `editor.setEditable`.
6. `updateContentFromMarkdown` is never called for a bound doc (B removes its callers). Add a guard that throws if it is.
7. `FormulaAwareMarkdownShortcutsPlugin` (`:4382-4391`) stays. Re-verify the LEARNINGS §4.2 cascade, cause #2, at 0.48.

**B. `R/panels/CanvasAreaContent.tsx`.** About 10 seam sites, roughly 150 to 250 lines changed.

1. **Collaboration context per pane.** Wrap the title and `MarkdownEditor` (`:4855-5000`) in `<LexicalCollaboration>` (one per pane), plus a host hook `useDocBinding(note.id)` that returns `{bound, synced, ydoc, provider, canEdit, terminal}`.
2. **Init effect** (`:1651`): if the doc is bindable, set `noteFrontmatterAtom` from `Y.Text('frontmatter')` and `setContentHydratedForNoteId(note.id)` immediately, then **return before any `getById`**. A same-id `updatedAt` change is ignored.
3. **Remove** for bound docs:
   - the disk watcher effect (`:3233-3293`), `revalidateActiveNoteFromDisk`, `applyDiskUpdate`;
   - the agent reload effect (`:3612-3780`; agents are inert);
   - the periodic save and dirty-signal subscriptions (`:3204-3231`);
   - the flush-on-switch save (`:3160-3196`);
   - `saveContent` (`:2517`; early return when bound);
   - the dirty and autosave listener in `handleEditorReady` (`:4089-4111`; keep the ArrowUp and scroll-to-cursor commands, `:4140-4197`);
   - `syncH1ToTitle` (`:1468`), `forceReloadFromDisk` (`:3505`).
   - `flushAndWait` and `captureMarkdownForSave` become pure local exports. "Copy markdown" stays client-side or uses the server export.
4. **Mount gate.** Mount `MarkdownEditor` as soon as the doc is bindable. Keep the existing skeleton (`:4840-4849` / `:5000-5009`) **on top** until `synced`, so the contenteditable stays invisible and non-editable. On provider `sync(true)`, call `editor.setEditable(canEdit && !trashed && !terminal)`, reveal the editor, publish `data-collab-input-state=live`, then run the pending focus (`autoFocusBody` / `autoFocusTitle`).
5. **`hasBodyContent`** (`:4327`) and the placeholder (`:4984`) read `noteContentAtom`. For bound docs, derive them from the editor root's text instead, with a cheap update listener.
6. **Title**: see §4.
7. **Top bar**: a presence slot at `:4558` (face pile) and a connection indicator. The hide-registry seams are listed in §2.10.
8. **Frontmatter writes** from `PropertiesTabContent` / `FrontmatterHeader` still go through `noteFrontmatterAtom` + `frontmatterDirtySignalAtom`. Subscribe to the signal and write a minimal diff to `Y.Text('frontmatter')`, instead of `markDirty` + autosave at `:3215-3218`.

**C. Binding lifecycle per editor instance** (V1 shown):

```
note switch → useDocBinding(id): new Y.Doc (fresh), provider = new YProvider(host,'doc-d-o', id,
  {connect:false, params:{share}}) — not yet connected
→ <MarkdownEditor key=id collaboration={{plugin:
     <CollaborationPlugin id={id} shouldBootstrap={false}
        providerFactory={(id, map) => { map.set(id, doc); return provider; }}
        username={me.name} cursorColor={me.color} awarenessData={{user}}
        excludedProperties={EXCLUDED} cursorsContainerRef={overlayRef} />}} />
→ plugin: createBinding(doc) → observeDeep → useProvider: provider.connect()   (the one connect)
→ provider 'sync'(true): remote state folds in via observeDeep; editor.setEditable(...);
  title binding opens; reveal; focus; data-*-binding=live
→ unmount: plugin disconnects; host destroys doc/awareness (setLocalState(null)), close 1000
```

**D. Other remount triggers to neutralise for bound docs.**

- An `editorVersion` bump (`:1088`) must not happen while bound.
- A `readOnly` flip must not change the key (A5).
- A trash event from a peer arrives as 4410. Moss would then refetch the entity because `trashedAt` changed, and the entity flip re-renders the trash UI. That is fine as long as no remount is involved: the doc-level terminal store sets `setEditable(false)` and disables the title (LEARNINGS §4.6).

**E. `R/App.tsx`.** A few seam sites:

- `canvasSharedProps.onActionClick` and the ⌘K handler (hide registry).
- `handleDuplicateNote` (`:2927-2976`): replace create + `getContent` + `update(content)` with a server-side duplicate endpoint. This avoids a markdown round trip and keeps comment anchors. The alternative is to let the adapter route `update(content)` on the fresh doc to the merge endpoint.
- The ruling 2 focus target (§0.1).
- The narrow-viewport overlay for the Tier A phone layout: preset `notesPanelHiddenAtom` from the host, or overlay the notes panel below 640 px (LEARNINGS §4.1).

### 3.8 Wire exclusions and last-writer-wins properties

This table comes from `R/editor/nodes/*.tsx`; `getType()` lines are noted.

| Node (type) | Fields | Wire policy |
|---|---|---|
| `TabGroupNode` (`tab-group`, `:37`) | `__activeIndex`, `__tabWidths` | **Exclude**: per viewer, persisted locally (ruling 11) |
| `TableNode` (`@lexical/table`) | `__colWidths` | **Exclude**: local |
| `FormulaNode` (`formula`, `:135`) | `__result`, `__stale`, `__name` (derived); `__formula`, `__formulaId` (content) | Exclude derived fields. Note: `__format` collided in an earlier version (LEARNINGS §4.2); at the pin the fields are `__commentIds __formula __formulaId __name __result __stale` |
| `FileLinkNode` (`file-link`, `:120`) | `__isResolved`, `__resolutionState` (derived per client); `__noteId`, `__noteTitle`, `__headingText`, `__displayText` (content) | Exclude derived fields |
| `CodeBlockNode` (`code-block`, DecoratorNode, `:462`) | `__code`, `__language`, `__theme` | `__code` is **last-writer-wins whole-string**; concurrent code edits lose text. Check whether `__theme` is per viewer. |
| `HtmlBlockquoteNode` (`html-block`, `:1156`) | `__rawHtml`, `__source` | Whole-value last-writer-wins |
| `SketchNode` (`sketch`, `:1555`) | `__grid`, `__labels` | Whole-value last-writer-wins |
| `ChartNode` (`chart`, `:622`) | `__config` | Whole-value last-writer-wins |
| `ImageNode` / `VideoNode` / `WebEmbedNode` / `EmbedPillNode` / `ColorCodeNode` / `CalloutNode` / `TabPanelNode` | `src`, `altText`, `url`, `value`, `calloutType`, `label` | Atomic properties; fine |
| all decorator nodes | `__commentIds` | Comment anchors on decorators; M4 must decide (CRDT data vs a node property) |

### 3.9 Other local mutations of the synced tree to watch

- **Context mark.** `markSelectionAsContext` applies `$patchStyleText({'--context-selection':'true'})` (`MarkdownEditor.tsx:7776-7795`, the patch at `:7792`) for the agent prompt's selected context. It would replicate to peers. It is unreachable while the AI action is hidden; keep it unreachable.
- **Link-edit selection mark (reachable on the web).** Opening the link editor, from a hyperlink click or the toolbar link tool, applies `$patchStyleText(selection, {'--link-selection':'true'})` (`MarkdownEditor.tsx:6407`, `:6511`, tagged `history-merge` and `skip-dirty`). `clearLinkSelectionMark` removes it later. Under `@lexical/yjs`, `__style` replicates, so peers would see the mark, and it splits text nodes in the shared tree. Make it a decoration that never enters the tree (for example the CSS Highlights API), or exclude it from the wire. This needs a seam in `MarkdownEditor.tsx`.
- **Comment `MarkNode`s.** Wrapped with `$wrapSelectionInMarkNode` (`CommentPlugin.tsx:254-267`) and created from markers on import. Under Yjs they replicate as content, and LEARNINGS §4.11 says naive marks duplicated text with concurrent painters. This is M4 design work.
- **Derived updates.** `runDerivedEditorUpdate` (formula refresh, localized images; `editorUpdateTags.ts:58-66`) writes to the tree. These must use a derived origin or be excluded (LEARNINGS §4.3 "derived-origin fold-back").
- **Checklist sort.** `ChecklistSortPlugin` uses `'history-merge'` (`:138`). That is not `HISTORIC_TAG`, so it is fine for Yjs, but the write still replicates.

---

## 4. The title field

### 4.1 How it works at the pin

**Element** (`R/panels/CanvasAreaContent.tsx:4858-4937`):

```
<div ref={titleRefCallback} contentEditable={!isTrashed} suppressContentEditableWarning role="textbox"
  aria-label="Note title" data-placeholder={currentPlaceholder.title}
  className="mb-1 min-h-12 w-full text-left text-h1 font-semibold tracking-title text-ink-default outline-none …"
  onFocus onInput onBlur onKeyDown onKeyUp onMouseUp onDrop onPaste />
```

It is the first `[role=textbox]` in the pane. The body is `[data-lexical-editor]` / `[data-moss-note-editor-root]` (`MarkdownEditor.tsx:8057-8061`).

**Placeholder.** Shown when the trimmed `titleValue` is empty. It is an overlay with `PLACEHOLDER_PAIRS[i].title` and a ⌘T chip (`:4939-4953`). The pairs are at `:205-214`; the index rotates on each autofocus (`placeholderIndexAtom`).

**Display value.** `normalizeTitleDisplayValue` maps `'Untitled'` to `''` (`:740-743`). A new note therefore shows the placeholder, not the word "Untitled".

**State.** `titleValue` / `titleValueRef` (`:942-946`). `getLiveTitleText` reads the DOM `textContent` (`:1173-1175`). `setTitleDisplayValue` writes the DOM only if it differs (`:1177-1188`).

**Writes into the DOM.** Every DOM write funnels through `setTitleValue`:

| Write | Code |
|---|---|
| Typing | `onInput` → `setTitleValue(textContent)` (`:4877-4880`) |
| Paste and drop | Single-line plain-text insertion through `Range`, then `syncTitleValueFromDom()` → `setTitleValue` (`:4903-4931`) |
| Emoji typeahead | Sets `container.textContent` directly, then `onTitleValueChange(next)`, which is `setTitleValue` (`R/panels/useTitleEmojiTypeahead.tsx:196-204`) |
| External sync | `useEffect` on `note.title` writes the DOM **unless the field is focused** (`:3591-3605`). This is the focus-gated adoption LEARNINGS warns about. |
| After hydration | `setTitleDisplayValue(note.title)` on each hydration (`:1328-1334`) |

**Keys.**

| Key | Behaviour |
|---|---|
| Enter or Tab | `commitTitleChange()` + `focusEditorStart()` |
| ArrowDown on the last visual line | Moves to the body (`:4888-4901`) |
| ArrowUp at the start of the body | `titleInputRef.focus()`; this is a Lexical command (`:4146-4161`) |

### 4.2 How a rename reaches storage

`commitTitleChange` (`:4201-4219`) runs on blur, Enter and Tab:

1. Reads the live text and trims it, falling back to `'Untitled'`.
2. Patches `noteEntityAtom.title` through `syncNoteEntityAtom`. The sidebar and breadcrumb update immediately.
3. Cleans the link-resolution cache.
4. `markDirty('user')` + `scheduleDebouncedAutosave()`.

The **save** then writes markdown whose leading `# <title>` comes from the live DOM text (`:2257`, `assembleNote`). The main process derives the note's folder and file name from that H1 (`main/storage/note-store.ts:6982-7005`, `renameNoteFolder`).

So at the pin the title has two writers: the field, and `syncH1ToTitle` on load (`:1468-1494`), which issues `notes.update({title})`.

### 4.3 Focus timing

| Trigger | Mechanism |
|---|---|
| New note via "+ Note", ⌘N or global capture | `focusTarget:'body'` → `shouldFocusBody` → `useLayoutEffect` waits until `contentHydratedForNoteId === id` **and** `editorReadyForFocusNoteId === id`, then `markdownEditorRef.focusStart()` (`:1385-1408`) |
| `focusTarget:'title'` (only the `createAndActivateNote` variant, unused by "+ Note") | `useLayoutEffect` once hydrated: `el.focus()`, select all contents (`:1367-1383`) |
| Context-menu Rename | `handleSelectNote(id)`, then **`setTimeout(…, 150)` → `canvasRef.focusTitle()`**. The code's own comment says "Race… TODO" (`R/App.tsx:3127-3140`). |
| ⌘T | `canvasRef.focusTitle()` (`R/App.tsx:3808-3831`); browsers swallow ⌘T |
| ArrowUp from the start of the body | `titleInputRef.focus()` |

`focusTitle` focuses the field and selects all its contents (`:3313-3323`).

### 4.4 Binding the title to `Y.Text('title')` without it being focusable before bind

**Principles.** These come from PRODUCT, ruling 2 and ruling 3, and LEARNINGS §4.4:

- `Y.Text('title')` is the only writer.
- Never seed a placeholder as text.
- The field is not focusable before the doc is bound **and** has completed its first sync.
- Gate on binding identity, not on liveness.
- Use minimal character diffs, and remap the caret when remote edits land.

**Recipe.** Introduce a small host module `useTitleBinding({ydoc, synced, docId, el})` and change the field at three seams.

1. **Editability gate** (in the JSX at `:4860`):
   - Use `contentEditable={titleOpen}`, where `titleOpen = bound && synced && canEdit && !isTrashed && !terminal && bindingDocId === note.id`.
   - When closed:
     - `contentEditable={false}`, with **no `tabIndex`** (so `.focus()` is a no-op and Tab skips it), `aria-disabled="true"`, `data-title-binding="none"`.
     - Render the metadata title, or the placeholder, as non-interactive text.
   - When open: `data-title-binding="live"`.
   - Then `focusTitle()` (`:3313`), the autofocus effect (`:1367`), Rename's 150 ms timer and ArrowUp all become harmless before the bind, because focusing a non-editable div without `tabindex` does nothing.
   - **Deferred focus.** When the binding opens, run any pending focus request. Replace the 150 ms timer with a "focus title when live" intent: set an atom in `handleRenameNote`, and have the binding consume it.
2. **Write chokepoint.** Replace `setTitleValue` in the four user paths (`onInput`, paste, drop, emoji `onTitleValueChange`) with `writeTitleFromDom()`:
   - Read `el.textContent`.
   - `diffTextToOps(ytext.toString(), domText)` (moss-collab `title-crdt.ts` is the reference).
   - Apply inside `ydoc.transact(…, TITLE_LOCAL_ORIGIN)`.
   - Then `setTitleValue(domText)` for the placeholder logic.
   - When the field is closed, `onInput` and the paste and drop handlers are unreachable, so there is nothing to swallow. As defense in depth, refuse `beforeinput`, paste, drop and composition at one chokepoint if any of them ever fires while closed (LEARNINGS §4.4).
3. **Remote render.** `ytext.observe` with `transaction.origin !== TITLE_LOCAL_ORIGIN`:
   - Compute the new text.
   - Remap the caret through the delta (keep it on its character).
   - Write `el.textContent`.
   - `setTitleValue`.
   - **Delete** the focus-gated external-sync effect (`:3591-3605`) and the post-hydration `setTitleDisplayValue` (`:1328-1334`) for bound docs: the title is rendered, not adjudicated.
4. **Projection to the sidebar, breadcrumb and tabs.**
   - On every title change (local or remote), `store.set(syncNoteEntityAtom, {noteId, updates:{title: text.trim() || 'Untitled'}})`. This keeps moss's `'Untitled'` convention for empty titles, which `NoteBreadcrumb.tsx:114` and `normalizeTitleDisplayValue` expect.
   - The bridge adapter overlays the same value onto any metadata record for a bound doc (§2.1), so a stale D1 title never wins.
   - The server Durable Object maintains D1 `docs.title` and the filename (ruling 3).
   - `commitTitleChange` becomes a no-op for bound docs, apart from `cleanupLinkResolutionCache(oldTitle)`.
   - `syncH1ToTitle` is removed for bound docs.
5. **Trimming.** Do not trim the CRDT text on each keystroke; trim only at projection and serialization (LEARNINGS §4.4). Moss's `commitTitleChange` already trims only into the entity.
6. **Edge case.** A user who literally types "Untitled" sees it vanish on reload, because moss's display normalization runs at hydration. With the bound renderer reading `Y.Text` directly, the text is shown as typed. This is acceptable and slightly better than the pin.
7. **WebKit.** Backspace with no editable focus can navigate back in WebKit (LEARNINGS §4.4). When the title is closed and the body is not yet editable, consume a bare Backspace at the document level while a bind is pending. This is a host-level guard; it needs no moss change.

---

## 5. Build specifics

### 5.1 Entry, HTML and content security policy

| Concern | Detail |
|---|---|
| Import order | Copy from `R/main.tsx`: Prism **first** (`:3`), then fonts (`:5-10`), then `styles.css` (`:17`). |
| HTML document | Carry over `R/index.html`'s FOUC theme script (`:7-9`, key `moss_theme`, sets `data-theme`). |
| Content security policy | Drop the Electron one (`:6`; `moss-asset:`, the `127.0.0.1` media server, `api.anthropic.com`). Web needs: `frame-src data: https:` for live HTML and embeds; `connect-src 'self' wss:`; `img-src 'self' data: https:` for remote images and R2 asset routes; `media-src 'self' blob:`. |
| Global CSS | Import it at the root of the host app, not inside a lazy chunk (LEARNINGS §4.1). |

### 5.2 `packages/desktop/vite.renderer.config.mts`

- `root: 'src/renderer'`, `base: './'`, `build.outDir: '../../.vite/renderer/main_window'`, `chunkSizeWarningLimit: 1500`.
- Aliases, **in this order**:
  1. `/^@\/(.*)/` → `packages/shared/src/$1` (used heavily inside `S/`)
  2. `'@'` → `packages/desktop/src/renderer`
  3. `'@moss/shared'` → `packages/shared/src` (151 imports in `R/`, including subpaths like `@moss/shared/state/note-atoms`, `@moss/shared/themes`, `@moss/shared/components/ui/...`)
- `plugins: [react()]` (`@vitejs/plugin-react` ^4.3.1); vite ^5.4.21.
- A custom logger silences "Could not Fast Refresh". `server.strictPort` and an HMR timeout of 60 s are set.
- The root `.ladle/vite.config.mjs:14-61` has a ready-made `manualChunks` split: `app-state`, `app-shared-components`, `app-panels`, `app-components`, `app-editor`, `vendor-charts` (recharts/d3), `vendor-lexical`, `vendor-react`, `vendor-state` (jotai), `vendor-code` (prismjs). Reuse it for the web client build.
- **TypeScript paths** (`packages/desktop/tsconfig.renderer.json`): `@moss/shared` → `../shared/src/index.ts`, `@moss/shared/*`, `@/*` → `../shared/src/*`. `S/` uses `baseUrl: ./src` with `@/*` (`packages/shared/tsconfig.json`).
- **Vite version.** If the web host uses Vite 8 (rolldown), LEARNINGS §4.18 says the client environment ignored `resolve.alias` and `resolveId`. Prefer a Vite major where aliases work, or `enforce:'pre'` transforms. Settle this early, because every `@moss/shared` import depends on it.

### 5.3 Tailwind and PostCSS

- **Tailwind 3.4.19** (not v4).
- `packages/desktop/postcss.config.cjs` and `packages/shared/postcss.config.cjs`: `{ tailwindcss: {}, autoprefixer: {} }`.
- `packages/desktop/tailwind.config.ts` reuses `sharedConfig.theme` and `.plugins`. Its content globs are `./src/renderer/**/*.{ts,tsx,html}` and `../shared/src/**/*.{ts,tsx}`.
- **`packages/shared/tailwind.config.ts`** is the real configuration:
  - `colors` are generated from `S/themes/tokens.ts`: `tokenColors` → `rgb(var(--x-rgb) / calc(var(--x-alpha) * <alpha-value>))`. There are **no default Tailwind colors**, so `text-white` does not exist (LEARNINGS §4.1).
  - A typography theme (`moss` variant).
  - `zIndex` scale: `dialog-overlay 120`, `dialog-content 130`, `nested-overlay 140`, `nested-content 150`, `typeahead 160`, `tooltip 170`.
  - Panel and canvas widths and maximum widths, including `canvas-prose 53.125rem` and `canvas-blocks 68rem`.
  - Spacing tokens, including `panel-inset`, `sidebar-*`, `canvas-*`.
  - Font sizes: `h1 28px/36px 600`, `body 15px/23px`, `code 13px/20px`.
  - `fontFamily.sans: ['Inter Variable','Inter',…]`, `mono: ['JetBrains Mono',…]`.
  - Plugins: `@tailwindcss/typography`, `@tailwindcss/container-queries`.
- The shared config's own globs also list `../desktop/stories/**` and `../web/src/**`. `packages/web` is moss's Next.js marketing site and is irrelevant here.
- The root `tailwind.config.js` is an eslint-only mirror.
- **Web globs** must cover the vendored `packages/desktop/src/renderer/**/*.{ts,tsx,html}`, `packages/shared/src/**/*.{ts,tsx}`, **and every host or web-only file that writes a `className`** (LEARNINGS §4.1).

### 5.4 CSS entry and cascade

`R/styles.css` is the CSS entry:

1. `@import '@moss/shared/themes/tokens.css'`. This file is 1652 lines: `:root` light tokens, `[data-theme="dark"]` from line 800, and shared `-rgb`/`-alpha` channels around 1605.
2. `@import '../../../shared/src/tailwind.css'` (`@tailwind base/components/utilities` plus base rules for selection, focus outline and modal blur).
3. Base layer: `html, body, #root { height:100% }`, the body font stack, `bg-surface-panel`, and the scrollbar classes `canvas-scroll`, `agent-dialog-scroll`, `comment-thread-scroll`, `sidebar-scroll`.
4. Utilities: `app-region-*` (harmless on the web), `bg-grid-subtle`, and `.moss-agent-sprout-mark`, which masks with **`url('../../../../logos/moss-sprout-icon.png')`**. That path resolves to the repo-root `logos/`.

Other style entry points:

- `R/editor/MarkdownEditor.css` (1175 lines) is imported by `MarkdownEditor.tsx:324`. It holds editor node styles.
- `R/PdfExportApp.css` (241) is imported by `PdfExportApp.tsx`.
- Two more repo-root asset imports use the same relative trick: `S/components/brand/SproutIcon.tsx:1` (`../../../../../logos/moss-sprout-icon.png`) and `R/editor/components/CommentPopover.tsx:25` (`../../../../../../logos/...`). `R/assets/x-logo-black.png` is used by `TweetEmbedCard.tsx:23`.

### 5.5 Fonts

These are imported in `R/main.tsx:5-10` (packages at the pin, `packages/desktop/package.json`):

| Import | Version | Registers |
|---|---|---|
| `@fontsource-variable/inter/wght.css` + `/wght-italic.css` | ^5.2.8 | Family **`Inter Variable`**, weights 100–900. Used by `styles.css` and Tailwind `font-sans`. |
| `@fontsource-variable/jetbrains-mono/wght.css` | ^5.3.0 | Family **`JetBrains Mono Variable`**. Used by the chart font (`R/editor/components/ChartRenderer.tsx:33`) and PDF code (`R/PdfExportApp.css:56`). |
| `@fontsource/jetbrains-mono/latin-400.css` + `latin-500.css` | ^5.3.0 | Family **`JetBrains Mono`** (Tailwind `font-mono`, code). |
| `charter-webfont/charter.css` | 4.1.0 | Family **`Charter`**, with `local('Charter')` first, so macOS uses the system face. Used by the editor's serif option (`MarkdownEditor.tsx:483`). |

**The fonts are not imported by either Ladle `components.tsx`.** The pixel oracle has to inject the same CSS and await `document.fonts.ready` (LEARNINGS §4.19).

### 5.6 Prism

`R/editor/plugins/code-block/prism-setup.ts`:

- Imports `prismjs` plus components in dependency order: clike, markup, c, cpp, java, javascript, typescript, jsx, tsx, python, rust, swift, go, json, css, markdown, bash, sql, yaml. `prism-c` is required because `@lexical/code` bundles Objective-C.
- Sets `window.Prism` and `globalThis.Prism` (`:48-53`).

At 0.48, `@lexical/code` depends on `@lexical/code-core` and `@lexical/code-prism`, and the latter depends on `prismjs ^1.30`.

- **Client:** import `prism-setup` first in the web entry, and also inside any entry that could evaluate `@lexical/code` early.
- **Server:** if the Durable Object imports the transformer stack, import `prism-setup` (or a `globalThis.Prism` shim) first in the worker too (LEARNINGS §4.1).
- **Ladle:** the root `.ladle/components.tsx:7` imports Prism; `packages/desktop/.ladle/components.tsx` does not.

### 5.7 Runtime dependency set to pin

Collected from imports in `R/` and `S/`, with versions from package.json and the lockfile:

| Group | Packages |
|---|---|
| React | `react` and `react-dom` ^19.3.0 |
| Lexical | `lexical` 0.48.0, plus `@lexical/{react, rich-text, list, table (exact 0.48.0), utils, mark, code, markdown, link, clipboard, selection, html}` 0.48.0. Add `@lexical/yjs` 0.48.0, which needs `yjs >=13.5.22` (the moss lock has yjs 13.6.27; LEARNINGS pins 13.6.31 everywhere). |
| UI | `@base-ui/react` **1.6.0** (exact), `@floating-ui/react` ^0.27.20, `lucide-react` ^0.577.0, `react-colorful` ^5.8.0, `recharts` ^3.10.1 (lazy charts), `prismjs` ^1.30.0 |
| State | `jotai` ^2.20.2, `jotai-family` ^1.1.0 |
| Utilities | `class-variance-authority` ^0.7.0, `clsx` ^2.1.1, `tailwind-merge` ^2.6.1 |
| Fonts | The packages in §5.5 |
| Dev | `tailwindcss` 3.4.19, `@tailwindcss/typography` ^0.5.20, `@tailwindcss/container-queries` ^0.1.1, `postcss`, `autoprefixer`, `@vitejs/plugin-react` |

Moss uses `node-linker=hoisted` (`.npmrc`) and pnpm 9.10.0. The desktop package does not declare `jotai` or `@base-ui/react`; it relies on hoisting from `@moss/shared`. The web package must declare them explicitly.

Lexical needs **one copy**. Use pnpm overrides for `lexical`, all `@lexical/*`, `yjs` and `@lexical/yjs>yjs`, and include react, lexical, yjs and jotai in `resolve.dedupe` (LEARNINGS §4.2, §4.18).

### 5.8 Ladle: the visual oracle

**Two configurations exist; use the root one.**

| | Root `.ladle/` | `packages/desktop/.ladle/` |
|---|---|---|
| Stories | `config.mjs`: `packages/desktop/stories/**/*.stories.*`; width addon disabled | `stories/**`, via `vite.ladle.config.ts` |
| Vite | `vite.config.mjs`: aliases plus **inline Tailwind** with explicit content globs (stories, renderer, shared) and `manualChunks` | Aliases only; relies on `packages/desktop/postcss.config.cjs`, whose desktop globs exclude stories |
| `components.tsx` | Imports Prism and `R/styles.css`, injects full-width overrides inside the story iframe, `Provider` enforces 100% width (`:1-131`) | Imports `styles.css` only, **no Prism** |
| Run | Root scripts `pnpm ladle` (`ladle serve`) / `pnpm ladle:build` (`--outDir .ladle-build`) | |

**The story.** `packages/desktop/stories/App.stories.tsx` gives Ladle id **`app--default`** (from the file name) and `app--empty-notes` (export `EmptyState`, `storyName` "Empty Notes"; the id matches the one used in LEARNINGS §4.19). Its structure:

```
<StoryAppProvider notes={storyNotes} activeId={storyNotes[0].id}><App/></StoryAppProvider>
```

**The mock bridge** (`packages/desktop/stories/utils/story-data.tsx`):

- `registerStoryBridge` assigns `window.electronAPI = createElectronBridge()` **synchronously during render** (`:420-432`, `:440-452`).
- `HydratedNotesProvider` (`:456-492`) runs inside a Jotai `<Provider>`. It sets `activeNoteIdAtom` through `useHydrateAtoms`, and `noteEntityAtom` / `noteIdsAtom` / `notesHydratedAtom` in a `useMemo`.
- The bridge (`:219-418`):
  - `getAll` / `getById` serve two notes from `S/mocks/notes.ts`: "Packing Checklist" `note-checklist` and "Tuesday Reflections" `note-journal`, both in folder `Notes`, with sticky tabs, **and `content: ''`** (`:178-190`).
  - `create` throws (`:232-234`).
  - `update` mutates in memory.
  - `folders.*` are empty or throw.
  - `settings.getNoteIntelligence` is `true`; `getTheme` is `'system'`.
  - `htmlPreview.ensure` and `videoThumbnail.ensure` return `null`.
  - `webEmbedPreview` and `remoteWebSurface` are absent.

**What `app--default` renders.** `App` boots with a bridge (`waitForReady` resolves at once), rehydrates from `getAll`, selects "Packing Checklist", and shows:

- the title "Packing Checklist" and an **empty** body;
- the actions panel collapsed (default hidden);
- light or dark from `prefers-color-scheme`.

**Oracle artifacts to mask or know about:**

- No webfonts load.
- Sidebar relative times are wrong: `toUnixSeconds` divides seconds by 1000, giving January 1970.
- Content is empty, so oracle comparisons of node families need a different fixture (LEARNINGS §4.19 authoring notes).
- The story bridge's `getById` ignores the abort signal.

**Building the oracle without touching references.** `.refs/moss` has no `.git` and must not be modified (no installs). Two options:

1. Copy `.refs/moss` into a gitignored, task-scoped directory inside moss-multi (for example `.oracle/moss-762abb777/`), and run `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile` with pnpm 9.10.0.
2. Clone the owner's repo read-only and check out 762abb777. Do not use `git worktree add` on `~/Code/moss`; that writes into its `.git`.

Then `pnpm ladle:build` and serve the static output. Static output is cheaper on this machine than `ladle serve`. Expect `@anthropic-ai/claude-agent-sdk` platform binaries for darwin x64 and arm64 in the install (`package.json` `supportedArchitectures`); that is large but needed only once. Then inject the §5.5 font CSS before capture.

---

## 6. Porting recipe

### 6.1 Layout: mirror moss's tree so relative imports survive unchanged

Vendor under one root (for example `vendor/moss/`) **with the same relative layout as the moss repo**:

```
vendor/moss/
  logos/moss-sprout-icon.png                      (needed by styles.css, SproutIcon, CommentPopover)
  packages/shared/{src/**, tailwind.config.ts, tsconfig.json}
  packages/desktop/src/{renderer/**, common/**, types/electron-api.d.ts, renderer-env.d.ts}
  packages/desktop/{tailwind.config.ts, postcss.config.cjs}        (reference; web has its own)
  packages/desktop/stories/** + .ladle/**                           (optional: in-repo oracle copy)
```

Every relative import then resolves with **no edits**:

- `R/styles.css:2` `../../../shared/src/tailwind.css` and `:194` `../../../../logos/...`
- `R/**` → `../../common/...` and `../../types/...`
- `CommentPopover.tsx:25` `../../../../../../logos/...`, `SproutIcon.tsx:1`
- the `.ladle` relative paths

The web host and the collaboration layer live **outside** `vendor/` (for example `apps/web/src/host/**`), and reach moss through four channels only:

1. `window.electronAPI` (the adapter);
2. the default Jotai store (presetting atoms);
3. a handful of seam props and hooks (§3.7, §4.4, §2.10);
4. module substitution of leaf modules.

### 6.2 Copy unchanged (with only the `ported-from` header added)

- **`packages/desktop/src/common/**`**: 31 files, 6,557 lines. Pure TypeScript with no node or electron imports (verified). Includes the markdown layers, fences, comment markers, `moss-html-*`, web-embed URL helpers, and `note-markdown-migrations/*`. The server must run the **same migrations** on import that desktop runs in `main/storage/note-store.ts`.
- **`packages/desktop/src/types/electron-api.d.ts`**: the adapter's type contract.
- **`packages/shared/src/**`**: 85 files, 14,648 lines. The exceptions are `components/layout/NotesListPanel.tsx` (the ⌘N seam) and any web adaptation of `state/atoms.ts` (none needed). `mocks/notes/files/*.md` and `*.json` are imported with `?raw` or as JSON: **do not add headers to them**; record them in the manifest instead.
- **`packages/shared/tailwind.config.ts`** and `packages/shared/src/themes/tokens.{css,ts}`, unchanged. `tokens.ts` is generated; re-copy, never regenerate.
- **`packages/desktop/src/renderer/**`** unchanged **except** the files in §6.4. That is about 215 of 229 files, around 62k of 80.8k lines.

### 6.3 Exclude

- `R/dev/base-ui-sandbox/**`: lazy and dev-only behind `?mossMode=base-ui-sandbox`.
- `R/main.tsx` and `R/index.html`: the web host writes its own entry that mirrors their import order (§5.1). Keep them vendored, unused, for re-pin diffs.
- The Electron `main/` and `preload/` folders, `forge.config.ts`, and the `vite.main` / `vite.preload` configs. Read `preload.ts` once as the adapter's specification.
- `packages/web` and `packages/db`: these are moss's marketing site and a libSQL placeholder, and are irrelevant.

### 6.4 Files that need changes, and why

| File | Why | Estimated diff |
|---|---|---|
| `R/editor/MarkdownEditor.tsx` | Collaboration slot replacing `<HistoryPlugin/>`; `editorState:null`, `editable:false` and no state cache when bound; composer key without `readOnly`; guard on `updateContentFromMarkdown`; keep the link-edit `--link-selection` mark out of the shared tree (§3.9) | about 40–70 lines |
| `R/panels/CanvasAreaContent.tsx` | Bound mode: skip the init fetch, remove the save, disk, agent and flush paths, mount gate on sync, title binding gate and chokepoint, frontmatter to `Y.Text`, presence slot, hide registry (Share with Agent) | about 150–250 lines |
| `R/App.tsx` | AI action and ⌘K hide, duplicate via server, focus-target ruling, narrow-viewport notes-panel overlay (Tier A) | about 20–60 lines |
| `R/panels/NotesListPanelContent.tsx` | Hide Open in Finder (note and folder), "Open…" | about 10 lines |
| `R/panels/TrashedNotesPanelContent.tsx` | Hide Open in Finder | about 3 lines |
| `S/components/layout/NotesListPanel.tsx` | ⌘N chip hide | about 2 lines |
| `R/components/SettingsModal.tsx` | Hide Workspace Location, default editor and Connected Folders; possibly a vault or account section | about 15 lines |
| `R/editor/nodes/HtmlBlockquoteNode.tsx` (or `html/useHtmlPreviewImage.ts`) | Live sandboxed iframe as the static preview (ruling 4) | about 15 lines |
| `R/editor/utils/asset-url.ts`, `R/editor/utils/media-server-url.ts` | `moss-asset://` and the `127.0.0.1` media server become `/api/...` URLs. **Prefer module substitution**: replace the whole module at build time with a web version exporting the same API. | 0 in vendor; about 100 new |
| `R/editor/preview/RemoteWebSurface.tsx` | Electron `WebContentsView` becomes a sandboxed iframe (ruling 4). **Prefer module substitution.** | 0 in vendor; about 200 new |
| `R/editor/slash-commands/registry.ts` | `/emoji` (OS emoji panel); only if ruled hidden | about 3 lines |
| `R/editor/plugins/CollapsibleHeadingPlugin.tsx` | **No change**: the adapter routes `notes.update({collapsedHeadings})` to localStorage | 0 |
| `R/editor/MathCalculationPlugin.tsx` | **No change**: the adapter limits `getContent` concurrency and never lists bound ids as content changes | 0 |
| New, non-moss: per-viewer table and tab width plugin | Excluded properties plus a localStorage apply-and-persist (ruling 11) | about 150 new |

**Patch versus substitution.** Use a **patch** when the change is inside a large file whose other code must track upstream, for example MarkdownEditor or CanvasAreaContent. Use **module substitution** when an entire small leaf module is platform-specific, so the vendored file stays byte-identical.

Implement substitution as a Vite plugin keyed on the absolute vendored path, with the matching server stub for workerd if needed. If the chosen Vite ignores `resolveId` (LEARNINGS §4.18, Vite 8), implement it as an `enforce:'pre'` transform that swaps the module source.

### 6.5 `ported-from` headers and mechanical re-pinning

**Header** (ruling 1), on line 1 of every vendored source file. Use `/* … */` for CSS:

```ts
// ported-from: packages/desktop/src/renderer/App.tsx @ 762abb777
```

Do not add the header to JSON, `?raw` markdown or binary assets; list them in the manifest.

**Manifest** `vendor/moss/PORTED.json`, one entry per file:

```json
{ "path": "...", "pin": "762abb777", "upstreamSha256": "<hash of pristine upstream bytes>",
  "mode": "verbatim" | "patched" | "substituted", "patch": "patches/moss/<path>.patch" }
```

**Patches.** Keep every change to a vendored file as a `git diff` patch under `patches/moss/` against the pristine file, and also apply it in the tree. Inside the files, mark each change with `// moss-multi seam: <id> (<PRODUCT/ruling ref>)`.

**Re-pin script** (for example `scripts/moss-vendor.mjs <newPin>`):

1. Read the new upstream bytes for each manifest path, from a pinned snapshot or with `git show <pin>:<path>` (a read-only command).
2. Write `header + upstream`.
3. `git apply --3way` each patch, reporting conflicts.
4. Re-record hashes.
5. Detect new and deleted upstream files under the vendored roots and print them.
6. Fail if any vendored file without a patch differs from upstream once the header is stripped. That is the drift check, and it must run in CI.

Keep a single pin across all vendored files. The prior attempt mixed two pins and its drift check pointed at a path that no longer existed (LEARNINGS §4.1).

### 6.6 Size

**Vendored:** about 103k lines in about 345 files:

| Part | Lines |
|---|---|
| Renderer | 80.8k (229 files, 3.3 MB) |
| Shared | 14.6k |
| Common | 6.6k |
| Types | 0.4k |

The three largest files are `MarkdownEditor.tsx` 8,187, `CanvasAreaContent.tsx` 5,100 and `App.tsx` 4,229 lines.

**Changes to vendored code:** about 10 files and roughly 300–450 changed lines, plus 2–3 substituted modules.

**New host code next to the vendor tree:**

| Piece | Estimated lines |
|---|---|
| Bridge adapter | ~1.5–2.5k (the prior `web-api.ts` was 2,061) |
| Collaboration binding glue: provider factory, title and frontmatter binding, presence, connection truth, terminal store, excluded properties | ~1.5–2.5k |
| Hide registry | ~150 |
| Substituted modules | ~300 |
| Per-viewer layout plugin | ~150 |
| Host UI that moss lacks (login, share dialog, vault switcher, bell, history, banner) | separate milestones |

**Client bundle:** expect several MB of JS before chunking. Lexical, recharts and React are the bulk; reuse the Ladle `manualChunks`. Add the Durable Object bundle if it imports the converter unchanged; measure it in the spike. Headless Lexical alone was about 246 KB gzipped (LEARNINGS §4.2).

### 6.7 Suggested order

1. **M0, foundation.**
   - Vendor script, manifest and drift check.
   - Host entry with Prism, fonts and CSS.
   - Adapter with full namespaces backed by REST stubs, then real REST.
   - Shell parity against `app--default` in light and dark.
   - Converter spike: import `MARKDOWN_EDITOR_TRANSFORMERS` and the nodes unchanged into workerd with CSS and PNG stubs, plus a round-trip parity test.
2. **M1.**
   - MarkdownEditor and CanvasAreaContent seams, `CollaborationPlugin` with a fresh doc per mount.
   - Title binding (§4.4) and frontmatter binding.
   - Workspace channel to `onDiskChange`.
   - Excluded properties and the local layout plugin.
   - Presence slot, then the hide registry.
3. **Later.** Comments (M4) will need `CommentPlugin`, the `noteCommentsMapAtom` writers and `$postImportNormalize` comment handling; plan seams there, not in M0/M1.

---

## 7. Open questions for the architecture

1. **Focus after "+ Note".** The pin focuses the body; ruling 2 says the title (§0.1). Which wins?
2. **Binding variant.** V1 is stable, ruling 12's "official plugin", and uses an `XmlText` root. V2 is experimental, lets the app own the doc and provider, renders snapshot diffs that help M6, and uses an `XmlElement` root. The choice fixes the Yjs schema for the server converter and CLI merge forever, so make it before M1.
3. **Undo capture timeout.** The official `createUndoManager` takes no options. Accept the Yjs default, or extend it to the 1000 ms `captureTimeout` that LEARNINGS asks for? Any extension must stay minimal (ruling 12).
4. **Shortcuts and native-only affordances.** Hide or replace the ⌘T title hint, ⌘⇧T, `/emoji` (OS panel), and image alt-text editing (native menu only)?
5. **Pinning scope.** Is a pin per user (a preference) or per doc (shared)? Moss stores `pinned` in the note's `meta.json`.
6. **Docs shared from other vaults.** Moss's model has one root, `'Notes'`, per workspace. Where do docs shared into a user from someone else's vault appear? LEARNINGS §4.10 warns against a synthetic "Shared" folder with mutation affordances.
7. **Trash view content.** A trashed doc reads as a 404 on a fresh load (PRODUCT), but moss's trash view opens trashed notes read-only. Does the owner's trash view get a REST markdown read, a read-only socket, or a server-rendered state?
8. **Note-intelligence toggle.** "Default Properties" and "Related Notes": keep, hide, or make it a server preference?
9. **Version history UI.** Moss mounts no version-history UI at the pin (`TimelinePopoutModal` appears only in the automation fixture). Confirm that the history panel is a new surface built from moss primitives, per PRODUCT's invented-surfaces rule.

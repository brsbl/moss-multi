# @moss-multi/editor

## 0.3.0

**API version 2. BREAKING:** a host built for API 1 (0.1.0, 0.2.0) must change before it mounts this bundle; an API 1
host that mounts it gets `ready` rejected with `apiMismatch` and nothing is read or written. Approved by the owner on
2026-10-06. Migration, item by item: docs/design/editor-embed.md section 13. 0.1.0 and 0.2.0 stay published unchanged.

- **`MOSS_EDITOR_API` is 2**, as are `MOSS_EDITOR_INFO.api`, editor.json `api` and the host helpers'
  (`moss-editor-host.js`, `editor-host.json`). `bridge.api` must be 2.
- **A moss-html block renders inert until the user presses Run** on it (PRODUCT ruling 21); Run lasts for that
  block alone (its static, interactive and fullscreen frames, never another block with the same HTML) while the
  editor is mounted.
- **The frame policy refuses a running moss-html block's requests, frame loads and navigations**; one that tries to
  navigate is torn down. editor.json `htmlFrame.policy` is now
  `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:
  blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`, and `moss-html-frame.html` runs
  the block in a sandboxed child. Blocks still run their inline scripts and styles. As defense in depth only, a guard
  in the block's own realm deletes WebRTC and keeps child frames out before the block's scripts run.
- **Residual risks, accepted because a block runs only when the user presses Run on it:** once running, a block's
  own script can undo that guard (for example by tampering with built-in prototypes to slip in a child frame) and
  send WebRTC packets to any server; a navigation it tries, though refused, or a connection hint it adds can still
  make the browser look up and connect to a host it names; and it may find other tricks inside its own realm. So a
  deliberately malicious block the user runs can leak its own content and what the user types into it. It still
  cannot reach the editor, the host page, the host's origin or the host's files.
- **`assets.copyFromNote` copies only out of notes the user opened in the host**; any other source is
  `{kind:'refused', reason:'sourceNotOpen'}`, and the editor drops the pasted reference.
- **Host security obligations are normative in contract.ts:** read confinement with realpath, re-validation of every
  write name, and the served-asset headers.
- **A case-only retitle keeps the markdown entry's spelling**, as Moss desktop does on APFS: the host has no respell
  step.
- contract.ts states that `onEvent` is required for a host that retains save receipts, and the retitle step onto a
  distinct existing `<folderName>.md` exactly.
- `selection-1` and `share-with-agent-1` are unchanged.
- The `removed` event comes once the drafts open at removal (a focused title, a chart or HTML draft) are committed,
  so `hadUnsavedEdits` counts them; input is frozen meanwhile, and while an in-place reload settles.
- `allocateFolderName` treats a sibling that differs only by Unicode normalization as taken on any volume, and folds
  case fully on a case-insensitive one (σ and ς), so a retitle takes a free suffixed name instead of failing.
- **The package is a directory, not one script** (T3.12): `moss-editor.js` imports content-hashed chunks under
  `assets/`, listed in editor.json `chunks` (with the ones every mount loads in `preload`). Charts, canvases and HTML
  blocks load their code when a note first holds one. The host serves the whole package directory from the entry's
  origin, caching `assets/` immutably (contract.ts host obligation 5; docs/design/editor-embed.md §13 item 8).

## 0.2.0

API version 1; additions only, listed in `MOSS_EDITOR_INFO.features` and editor.json `features`
(docs/design/editor-embed.md §8.1).

- **`selection-1`: `handle.selection()`** returns the user's selection as `MossSelection` (`text`, `markdown`,
  `lines`, `headings`, `blocks`), or null when it is collapsed, outside the note body or the note is not loaded.
  `lines` are 1-based in the file exactly as a save would write the current buffer, unsaved edits included.
- **`share-with-agent-1`: optional `services.shareWithAgent(selection)`.** With it, Moss's Share with Agent button
  shows above the note and a press calls the service with the current selection (or null). Without it nothing changes.
- `contract.d.ts` adds `MossSelection`, `MossEditorServices.shareWithAgent` and `MossEditorHandle.selection`; nothing
  else in it changes.

## 0.1.0

API version 1 (`src/contract.ts`), no feature strings.

- **`mountMossEditor`** mounts moss's own editor at the pin, editable, on one note of a host's Moss workspace: the
  title field, the body with moss's shortcuts, slash menu and formatting, every node family, and moss's comment UI
  (Cmd+Shift+A, the gutter, threads, replies, resolve). Comments are stored as Moss desktop stores them: `%%m:`
  markers in the markdown and `comments.json`.
- **Byte-compatible saves.** Every save writes the bytes Moss desktop's own save path writes for the same edit:
  the markdown (`<folder>.md`, legacy names moved), `comments.json`, `layout.json` and `meta.json`, and the folder
  rename a title edit causes. CI holds this to desktop's code at the pin, file by file.
- **Files only through the host.** Reads, writes, companions and media go through the host's `MossEditorBridge`;
  the frame has no network and no file system. Writes carry the version they were based on, and a stale write is
  refused by the host and shown as "Changed in Moss" with Reload, Keep editing and Overwrite.
- **Autosave on desktop's timing** (1.5 s idle, a 15 s cap checked on edits, a 30 min safety net), `flush()` before
  hiding or quitting, `unmount()` that keeps unsaved edits unless told to drop them, drafts and save receipts.
- **Release:** `moss-editor-<version>.tgz` unpacks to `moss-editor/` with `moss-editor.js`, `moss-editor.css`,
  `moss-editor-host.js`, `moss-html-frame.html` and `editor.json` (version, API, moss pin, source commit, CI run,
  per-file SHA-256 and the frame's CSP).

### Not in 0.1.0

- External `.md` files, trashed and unadopted notes open in the viewer (`noteEditability`).
- No asset garbage collection, no automatic merge with concurrent Moss edits (M7), no Properties panel.
- Remote images stay remote references; a cross-note paste of a host-issued URL is not yet recognised.

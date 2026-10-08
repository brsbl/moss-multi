# Porting moss-multi back onto moss desktop

moss-multi is the working reference for making moss desktop multiplayer (PRODUCT.md, intro). This file maps each part of it onto moss at the pin, brsbl/moss@762abb777, for whoever ports it: what exists here, where it lives, what moss desktop would change, and the risks. ARCHITECTURE.md (cited as A§) is the design of record; this file only points into it.

Paths are repo paths. `moss:<path>` is a path in moss at the pin, vendored under `vendor/moss/` or, for Electron main-process files, ported by a file that names it in its `ported-from` header. `path#Symbol` names a declaration in that file. `scripts/ci/doc-links.mjs` checks every citation in CI.

## Summary

| Area | What exists here | Where | What moss desktop changes | Main risk |
|---|---|---|---|---|
| Vendor seams and patches | moss at the pin, 406 files: 317 verbatim, 70 patched, 19 extracted. Every change is a marked seam calling a host hook; CI checks the bytes | `vendor/moss/`, `vendor/patches/moss/`, `scripts/moss-vendor.mjs` | Land each seam upstream as a real extension point, then delete the patch | Upstream edits to `CanvasAreaContent.tsx` and `App.tsx` conflict with the largest patches |
| Bridge namespaces | `window.electronAPI` rebuilt over REST, the Y.Doc and browser APIs; 116 methods, each listed with its treatment | `apps/web/src/host/bridge/` | Keep IPC for local-only namespaces; route `notes` content and title through the doc binding instead of `note-store` | `notes.update({content})` must never write a bound note |
| Converter extraction | moss's markdown pipeline split out of `MarkdownEditor.tsx` into pure modules, and 8 decorator nodes split into class and view, so one converter runs in the browser, the DocDO and the CLI | `vendor/extract/moss.json`, `vendor/moss/packages/desktop/src/renderer/editor/markdown/`, `packages/sync/src/converter/` | Adopt the same split upstream (no behavior change); the main process gets the converter for server-free merges | A transformer edit upstream changes stored docs; L3 parity must run on every pin |
| Collaboration layer | @lexical/yjs V1 binding per pane, a fresh Y.Doc per mount, one socket per doc, the undo stack over the body and its payload docs, title and frontmatter as CRDT fields | `vendor/lexical-react/`, `apps/web/src/host/collab/` | `MarkdownEditor` gains the `collaboration` prop; `CanvasAreaContent` stops saving bound notes; `<HistoryPlugin/>` is replaced | The Yjs schema (V1, `root` XmlText) is permanent once data exists |
| Registers and payload docs | Decorator payloads (code, HTML, formula, chart, sketch) live in their own Y.Docs keyed by a stable `__regId`; the server withholds unnamed ones | `packages/sync/src/registers.ts`, `packages/sync/src/payload-docs.ts`, `packages/sync/src/payloads.ts` | Node classes gain `__regId` and getter and setter seams; the `.md` stays unchanged | A node property that bypasses its getter is last-writer-wins and loses edits |
| Comments | `Y.Map('comments')`, written only by the server under a reserved Yjs client id R; anchors are RelativePositions moved by a frame-scoped engine; paint is CSS Custom Highlights, with no marks in the tree | `packages/sync/src/doc/comments.ts`, `packages/core/src/anchor-frame.ts`, `apps/web/src/host/comments/` | `CommentPlugin`'s MarkNodes, `%%m:` markers and `comments.json` become an import/export interchange only | Two anchor models during migration; a desktop that writes MarkNodes into a shared tree loses keystrokes |
| Suggestions | Records beside the body: a suggester types into a private fork under leased Yjs client ids; an editor's Accept applies the record through gates G0 to G8 | `packages/sync/src/suggest/`, `packages/sync/src/doc/suggest.ts`, `apps/web/src/host/collab/suggest/` | New surface: the suggest toggle in the floating toolbar and the Suggestions panel next to `CommentsMenuButton` | Needs a server; offline suggesting cannot be accepted until it syncs |
| History | Server versions (auto, named, restore points) in DocDO SQLite with R2 spill; restore is a three-way, identity-preserving reconcile | `packages/sync/src/doc/versions.ts`, `packages/sync/src/reconcile.ts`, `apps/web/src/host/history/` | New History view in the editor pane; moss's `checkpoints` stay agent checkpoints | Restoring by rebuilding the tree instead of reconciling breaks comments and peers' typing |
| Server model | One Worker: DocDO per doc, PrincipalDO per principal, SearchDO global, D1 for accounts, folders, grants and projections, R2 for blobs | `packages/sync/src/`, `apps/web/src/server.ts`, `apps/web/src/db/schema.ts` | Desktop becomes a client of this server; the local folder becomes a synced projection | Access, revocation and limits are server-enforced; a desktop-side shortcut around them is a security hole |
| CLI and daemon | `moss-multi` binary: pull, push with three-way merge, sync and watch over REST, with moss interchange (`--moss`) | `packages/cli/src/`, `packages/sync/src/push.ts`, `packages/core/src/merge.ts` | The same loop is the model for desktop's folder sync of `~/Moss/Notes` | Disk edits made while desktop is offline merge three-way and can fail hunks |
| Viewer and editor packages | `@moss-multi/viewer` (read-only, any page) and `@moss-multi/editor` (file-backed, writes the same bytes as desktop's save) | `packages/viewer/`, `packages/editor/` | None to adopt; they prove moss's editor runs outside Electron and pin desktop's save bytes in golden tests | `packages/editor/src/desktop/` is a copy of main-process code and drifts on re-pin |

## 1. Vendor seams and patches

**Here.** `vendor/moss/` mirrors moss at the pin in moss's own layout, so relative imports resolve unchanged. `vendor/moss/PORTED.json` lists each file with its upstream hash and mode: verbatim, patched or extracted. Line 1 of each source file reads `// ported-from: <path> @ 762abb777`. A patched file carries `// moss-multi seam: <id> (<cite>)` at each hunk; 79 files hold seams, and the largest groups are `comments` (63 markers), `read-only-decorators` (50), `hide-registry` (27), `bound-pane` (20), `converter-split` (19), `register` (16) and `node-views` (16). Seams call into host code through the `@moss-multi/host/*` alias, which resolves to `apps/web/src/host/`, so later milestones change host files only (A§2.2). Three leaf modules are substituted whole by a Vite `enforce:'pre'` transform and stay byte-identical: `asset-url.ts`, `media-server-url.ts` and `RemoteWebSurface.tsx` (`apps/web/vite.config.ts`). The two dependency patches outside moss are `patches/y-partyserver@2.2.0.patch` (`unload` becomes `pagehide`) and `patches/wrangler@4.113.0.patch` (a dev-only proxy replay).

**Where.**
- `scripts/moss-vendor.mjs`: `drift` (the CI check), `vendor`, `repin`, `extract` and `pristine` (the Ladle oracle fallback). `scripts/moss-vendor.mjs#ROOTS` holds the two roots, moss and `vendor/lexical-react/`.
- `vendor/patches/moss/<path>.patch`, made against the pristine bytes; a hand edit to a generated file is stored as `vendor/patches/moss/<path>.seam.patch`.
- The CI step "Vendor drift" in `.github/workflows/ci.yml`: a verbatim file hashes to its upstream bytes, a patched file equals upstream plus its patch, and an extracted file equals a fresh extraction.
- The seam table in A§2.2; the deviations each seam implements in `docs/DEVIATIONS.md`.
- The hide registry `apps/web/src/host/affordances.ts#AFFORDANCES`, read through `apps/web/src/host/affordances.ts#hidden`; capability reads in `apps/web/src/host/capabilities.ts#noteCan`.

**Desktop changes.** Each seam id is a candidate upstream extension point. In order of payoff:
1. `bound-pane`: one hook in `moss:packages/desktop/src/renderer/panels/CanvasAreaContent.tsx` (`apps/web/src/host/collab/pane.tsx#useMossMultiPane`) that, for a bound note, skips the `getById` content load, the save and disk-change paths, the flush and `syncH1ToTitle`. Upstream, that is a "note source" abstraction with two implementations: file-backed (today) and doc-bound.
2. `collaboration`: the `collaboration` prop on `moss:packages/desktop/src/renderer/editor/MarkdownEditor.tsx` (bound mode mounts empty and closed, and the plugin replaces `<HistoryPlugin/>`).
3. `hide-registry` and `capabilities`: upstream gets a role-aware capability check (`packages/protocol/src/roles.ts#can`) wherever moss now assumes the user owns the note.
4. `read-only-decorators`, `read-only-tabs` and `read-only-media`: moss gates few decorator controls on `isEditable()`; a commenter or viewer needs every control gated.
5. `overlay-surface`, `phone-shell` and `sidebar-row` are web and test concerns; desktop can skip them.

Once a seam exists upstream, its patch is deleted here and the file returns to verbatim.

**Risks.**
- Re-pinning cost grows with the patched set; `CanvasAreaContent.tsx`, `App.tsx` and `MarkdownEditor.tsx` change often upstream, and `repin` reports each 3-way conflict for a person to resolve.
- The `drift` check proves the bytes, not the behavior; a seam can still mean something different after an upstream refactor. Rerun the journeys after every re-pin.
- Pin changes are owner-gated single commits (A§2.1). Mixed pins were the failure of the earlier attempt (`docs/history/LEARNINGS.md`, §4.1).

## 2. Bridge namespaces

**Here.** moss's renderer talks to Electron only through `window.electronAPI` (`moss:packages/desktop/src/types/electron-api.d.ts`). The web installs a complete object before App mounts (`apps/web/src/host/bridge/index.ts#installBridge`, built by `apps/web/src/host/bridge/index.ts#createBridge`). `apps/web/src/host/bridge/inventory.ts#INVENTORY` lists all 116 methods across 21 namespaces with a treatment: `real`, `stub`, `hidden` (its entry points withheld through the hide registry), `staged` or `absent`. A unit test fails when `ElectronAPI` gains a method the inventory lacks. The rules that matter for a port (A§9):
- `notes.update` routes by field: `title` is a `Y.Text` write when bound; `content` is always refused, so the bridge has no path that can overwrite a doc; layout and collapsed headings are per-viewer localStorage.
- `notes.getContent` is the server export and never repaints a bound editor; `notes.onDiskChange` is metadata-only and comes from the workspace channel (`apps/web/src/host/workspace-channel.ts#subscribeWorkspace`).
- `agent.onStream` must exist as a no-op subscription, because `CanvasAreaContent` calls it unconditionally.

**Where.** `apps/web/src/host/bridge/`, `apps/web/src/host/navigation.ts`, `apps/web/src/host/affordances.ts`, and the moss side in `moss:packages/desktop/src/main/ipc-handlers.ts`.

**Desktop changes.**
- Desktop keeps its preload bridge. The `notes` namespace splits: content and title of a bound note go through the doc binding (section 4), never IPC; metadata, listing and search come from the server listing, with `note-store` as a local cache.
- `notes.update({content})` from the renderer must be refused for bound notes, as here. At the pin only duplicate and dev automation fixtures write content through it; duplicate moves server-side (`apps/web/src/host/duplicate.ts#duplicateNote`).
- `folders`, `notes.delete` and `notes.restore` become server calls that return after the server acknowledges; move and trash need the `manage` capability (A§8).
- Native-only namespaces stay native on desktop: `agent`, `chat`, `checkpoints`, `files`, `filesystem`, `grantedDirs`, `externalNotes`, `shell`, `htmlPreview`, `remoteWebSurface`. The hide registry is web-only; desktop shows those affordances.

**Risks.** Any IPC path that writes a note's `.md` while the note is bound races the CRDT and is the "wiped doc" family of bugs (`docs/history/LEARNINGS.md`, §4.6). Audit every `persistFile` caller in `moss:packages/desktop/src/main/storage/note-store.ts` before binding, including agent writes and the file watcher's reloads.

## 3. Converter extraction

**Here.** moss's markdown import and export lived inside `MarkdownEditor.tsx` and in decorator node files that import React views. `scripts/moss-vendor.mjs` (`extract`, driven by `scripts/moss-extract.mjs`) reads the AST symbol manifest `vendor/extract/moss.json` and generates, from pristine upstream, the pure modules (19 files with mode `extracted`):
- `vendor/moss/packages/desktop/src/renderer/editor/markdown/pipeline.ts#$importNoteBody` and `vendor/moss/packages/desktop/src/renderer/editor/markdown/pipeline.ts#$exportNoteBody`, with `transformers.ts`, `normalize.ts`, `text-style.ts`, `fixes.ts` and `format-whitespace.ts` beside them;
- `vendor/moss/packages/desktop/src/renderer/editor/commands.ts#CREATE_COMMENT_COMMAND`;
- eight decorator classes (Chart, CodeBlock, EmbedPill, HtmlBlockquote, Image, Sketch, Video, WebEmbed) split into `X.ts` and `X.view.tsx`, whose `decorate()` calls `vendor/moss/packages/desktop/src/renderer/editor/nodes/node-views.ts#renderNodeView`, filled only on the client by `vendor/moss/packages/desktop/src/renderer/editor/nodes/register-views.tsx`.

Function bodies stay byte-identical to upstream. The same converter runs in the browser, in the DocDO (`packages/sync/src/converter/index.ts#exportMarkdown`, `packages/sync/src/server-doc.ts#exportDocMarkdown`) and in the CLI's server path. Fixes over moss are deviations with fixtures: the line-loss fix (deviation 8) and deterministic formula ids (deviation 13).

**Where.** `vendor/extract/`, `packages/sync/src/converter/`, `packages/sync/src/formula-export.ts`, A§12, and the gates L1 to L5 (`packages/sync/test/parity/` holds L3, parity against moss's pristine pipeline).

**Desktop changes.** Adopt the split upstream: moving symbols between files changes no behavior and removes 19 generated files and their seams here. Then the main process (or a worker) can import the converter without React, which a desktop folder sync needs to merge a disk edit into a doc without a renderer. The title rule must be decided once: here the title is the doc's name and import never lifts an H1 (deviation 2); moss's interchange, a leading `# Title` line plus a `comments.json` sidecar, is a separate explicit path (`packages/cli/src/moss-format.ts#renderMoss`, `packages/sync/src/title-line.ts`).

**Risks.**
- A transformer change upstream changes the export of every stored doc, and therefore CLI merges and search. L3 parity and the golden fixtures must run on every re-pin.
- The extraction manifest names symbol ranges; an upstream rename breaks generation loudly (good), and an upstream reorder can pull an unintended symbol into a pure module (check `scripts/ci/deps.mjs`, the bundle-boundary rule).

## 4. Collaboration layer

**Here.**
- **Binding.** `vendor/lexical-react/` vendors `LexicalCollaborationPlugin.tsx` and `useYjsCollaboration.tsx` from @lexical/react 0.48.0, V1 (an `XmlText` root named `root`), with four seams (A§10.2): (a) undo, (b) derived-update origins (`apps/web/src/host/collab/origins.ts#DERIVED_ORIGIN`), (c) awareness fixed at mount, (d) cursor labels and an ordered teardown. Their patches are `vendor/patches/lexical-react/`.
- **Session.** Per pane, `apps/web/src/host/collab/doc-session.ts#openDocSession` creates a fresh Y.Doc on every mount and one hardened y-partyserver provider; one socket per open doc, and split view never shows one doc in both panes (deviation 12, seam `one-doc-split` in `moss:packages/shared/src/state/atoms.ts`). Nothing is editable before first sync (A§10.3).
- **Undo.** `packages/sync/src/payload-docs.ts#BodyUndo` is the body's one stack across the note and its payload docs, built by `apps/web/src/host/collab/undo.ts#createBindingUndoManager` with a 1000 ms capture window; it tracks only this binding's origins, so server writes (seed, push, restore, accept) never enter it (A§10.8). The title has its own manager.
- **Title and frontmatter.** `Y.Text('title')` is the only writer of the name (`apps/web/src/host/collab/title-binding.ts#TitleField`, `packages/core/src/doc-fields.ts#writeField`). Frontmatter is `Y.Map('frontmatter')` plus `Y.Array('frontmatterOrder')` (`apps/web/src/host/collab/frontmatter-binding.ts#bindFrontmatter`, `packages/core/src/frontmatter.ts#composeFrontmatter`); YAML exists only at export (deviation 19).
- **Connection truth, presence, terminal states.** `apps/web/src/host/collab/connection.ts#startLink`, `apps/web/src/host/collab/presence.ts#startPresence`, `apps/web/src/host/collab/terminal.ts#setTerminal`, close codes in `packages/protocol/src/sync.ts#CLOSE`.
- **Wire exclusions and local layout.** `packages/sync/src/excluded-properties.ts#EXCLUDED_FIELDS` keeps per-viewer fields (table widths, tab widths, active tab, file-link resolution) off the wire; `apps/web/src/host/collab/layout-local.ts#bindLocalLayout` keeps them in localStorage (deviations 6 and 20).
- **Background writers** (ColorCode, CodeNodeNormalization, ChecklistSort, FileLink, MathCalculation) skip collaboration updates and run no initial sweep on a bound doc (A§10.10).

**Where.** `vendor/lexical-react/`, `apps/web/src/host/collab/`, `packages/sync/src/payload-docs.ts`, `packages/core/src/doc-fields.ts`, A§10.

**Desktop changes.**
- `MarkdownEditor` takes the `collaboration` prop and drops `<HistoryPlugin/>` when bound; `UndoRedoPlugin` keeps dispatching undo.
- `CanvasAreaContent` no longer saves, reloads from disk or syncs the H1 to the title for a bound note; the title field binds to `Y.Text('title')`, and Properties writes per-key map entries.
- Desktop needs offline persistence of each Y.Doc (the web keeps unacked edits only in memory and refuses to drop them, A§10.1): a local Yjs store in the main process, sent to the server on reconnect. That is new work with no counterpart here.
- The folder on disk becomes a projection of the doc, written through the converter export, with disk edits merged back three-way as the CLI does (section 10).
- Per-viewer layout moves from `layout.json` to local state keyed by Yjs identities.

**Risks.**
- V1 fixes the Yjs schema permanently for the converter, the CLI merge and comment anchors; V2's `XmlElement` root is wire-incompatible (A§10.2).
- `HISTORIC_TAG` must never be used to keep a write out of undo; a lint rule enforces it (`scripts/lint/moss-plugin.mjs`).
- Any plugin that writes the tree in response to a remote update produces doubled writes across clients (the "WORDWORD" family); each new moss plugin needs the remote-origin and read-only guards.
- Undoing a block's creation that another person typed into hides their typing until redo (`docs/design/registers.md`, owner summary, item 1).

## 5. Registers and payload docs

**Here.** @lexical/yjs stores node properties as whole-value attributes, so concurrent edits to a code block's code would lose one side. Each payload is instead its own Y.Doc whose guid is the node's `__regId`, 128 random bits minted at creation and on import; the note's doc carries only the id (A§10.10, `docs/design/registers.md`).
- Text payloads: `code-block.__code`, `html-block.__rawHtml`, `formula.__formula` (`packages/sync/src/payload-docs.ts#REGISTER_FIELDS`), written as minimal diffs.
- Map payloads: `chart.__config` and the sketch grid and labels (`packages/sync/src/payload-docs.ts#MAP_REGISTER_FIELDS`, codecs in `packages/sync/src/map-codecs.ts#MAP_REGISTERS`).
- Node getters read the payload doc and setters diff into it under `packages/sync/src/registers.ts#REGISTER_LOCAL_ORIGIN`; the node field is an excluded render cache, so the converter reads through getters and export bytes do not change.
- Payload docs sync on the doc socket under message 7 (`packages/protocol/src/sync.ts#PAYLOAD_MESSAGE`). The DocDO keeps a naming index and serves a payload only while a live element names it; an unnamed one is withheld, stored and acked but never sent, and dropped after `packages/sync/src/payloads.ts#PAYLOAD_TTL_MS` (30 days). `packages/sync/src/payloads.ts#migratePayloads` moves M1-era attributes into payload docs on load.

**Where.** `packages/sync/src/registers.ts`, `packages/sync/src/payload-docs.ts`, `packages/sync/src/payloads.ts`, `packages/sync/src/map-codecs.ts`, `apps/web/src/host/collab/registers.ts`, `apps/web/src/host/collab/register-input.ts`, `apps/web/src/host/collab/sketch-sync.ts#useSketchPeerSync`, and the `register` seams in the extracted node classes.

**Desktop changes.**
- The CodeBlock, HtmlBlockquote, Chart and Sketch node classes and `FormulaNode` gain `__regId` and getter and setter seams upstream; their views edit through the register hooks (bound code and HTML fields publish typing immediately, deviation 21).
- Nothing changes in the `.md`: export reads through getters. A `__regId` is not persisted in markdown, so import mints fresh ids and copies (`$copyNode`, clipboard, import) get fresh ids seeded with the source text.
- A desktop-local store must keep payload docs beside the note's doc and apply the same withholding when it serves another client; a desktop that only consumes the server can rely on the DocDO for that.

**Risks.**
- A view that writes `node.__code` (or any payload field) directly instead of through its setter silently becomes last-writer-wins again. New decorator types need their payload fields added to `REGISTER_FIELDS` or `MAP_REGISTER_FIELDS` before they ship.
- `callout.__level` and the code language stay whole-value; a concurrent change to them keeps one side.
- When two people move one block at the same moment, a setting changed on the removed copy is lost (`docs/design/registers.md`, item 3).

## 6. Comments

**Here.** Comments are CRDT data beside the body, never marks in it (A§13, `docs/design/comments.md`).
- **Records.** `Y.Map('comments')` holds JSON `c:<id>` thread records and `a:<id>` anchor records (`packages/sync/src/doc/comments.ts#CommentRecord`).
- **The R writer.** Only the DocDO writes the map, through `packages/sync/src/doc/comments-guard.ts#CommentsWriter`, under a reserved Yjs client id R persisted in meta (`packages/sync/src/doc/comments.ts#COMMENTS_CLIENT_META`) and the origin `packages/sync/src/doc/comments-guard.ts#COMMENT_ORIGIN`. Clients call REST (`apps/web/src/api/comments.ts#createComment`); gate 2b in `packages/sync/src/doc/comments-host.ts#CommentsHost` refuses any client frame that carries an R struct, references R, names a root outside `packages/sync/src/doc/comments-guard.ts#CLIENT_ROOTS`, or deletes a live R item.
- **Anchors.** Base64 RelativePositions on the first and last unit, moved by a frame-scoped engine (`packages/core/src/anchor-frame.ts#AnchorEngine`) that shrinks, re-mints or orphans a comment and reattaches an orphan only when the same text returns. A comment never jumps (restart ruling 18). The quote is searched once, at create or import (`packages/core/src/tree-anchor.ts#findQuote`).
- **Paint and UI.** CSS Custom Highlights plus geometry (`apps/web/src/host/comments/paint.ts#bindCommentPaint`); an adapter answers moss's tree queries (`apps/web/src/host/comments/adapter.ts`), and `CREATE_COMMENT_COMMAND` is the single write seam. Reactions come from glyphdown (`apps/web/src/host/comments/Reactions.tsx`). Deviation 23 lists the visible differences.
- **Converter.** On import, `%%m:` markers plus the sidecar become anchors; export is clean. The CLI's `--moss` mode maps both ways (`packages/cli/src/moss-format.ts#parseMoss`).

**Where.** `packages/sync/src/doc/comments.ts`, `packages/sync/src/doc/comments-guard.ts`, `packages/sync/src/doc/comments-host.ts`, `packages/core/src/anchor-frame.ts`, `packages/core/src/comment-units.ts`, `apps/web/src/host/comments/`, `apps/web/src/api/comments.ts`, the 63 `comments` seams across moss's comment components and `moss:packages/desktop/src/renderer/editor/plugins/CommentPlugin.tsx`.

**Desktop changes.**
- `CommentPlugin` stops wrapping selections in MarkNodes and stops putting `__commentIds` on decorators; it reads anchors and paints highlights through the adapter. Moss's gutter, popover and thread components stay, behind the seams.
- `comments.json` and the `%%m:` markers (`moss:packages/desktop/src/common/comment-markers.ts`) become an interchange format for migration in and out, no longer the store.
- Comment writes go to the server, where authorship comes from the authenticated principal. Offline comments need a queue that replays on reconnect; the web has none.
- Migrating an existing vault: import each note with its sidecar once (the anchor search runs only then), then never again.

**Risks.**
- Any MarkNode or `__commentIds` written into a shared tree splits text nodes under a peer's caret, which drops keystrokes (`docs/history/LEARNINGS.md`, §4.3). Desktop must not mix the two models in one bound note.
- An orphaned comment stays orphaned until identical text returns; people used to moss's text search re-anchoring will see more detached comments.
- The R gate depends on Yjs internals (struct ids, parent references); a Yjs upgrade needs the gate's fuzz tests rerun.

## 7. Suggestions

**Here.** Designed in `docs/design/suggestions.md`; a pending suggestion stays beside the body until an editor accepts it (deviation 22).
- **Records.** `Y.Map('suggestions')` maps id to `{meta, ops, parts}` (`packages/sync/src/suggest/records.ts#SUGGESTIONS`), written only by the DocDO under its own client (`packages/sync/src/suggest/records.ts#newSuggestionsClient`). `ops` are the author's fork updates stored verbatim; `parts` are delete parts naming live body items.
- **Leases.** `suggest-lease` hands the author Yjs client ids absent from the body and every other lease (`packages/sync/src/doc/suggest.ts#LeaseStore`); `suggest-ops` checks that every struct comes from a leased client bound to the record, with no clock gap, before appending (`packages/sync/src/doc/suggest.ts#SuggestIngest`). An editor's frame that names a leased client is refused.
- **Live suggest mode.** The pane binds a real moss editor to a fork (the body plus the author's open records) and forwards each transaction (`packages/sync/src/suggest/client.ts#SuggestFork`, `packages/sync/src/suggest/fork-shim.ts#ForkShim`, `apps/web/src/host/collab/suggest/SuggestPlugin.tsx#SuggestPlugin`).
- **Gates.** Accept (`packages/sync/src/suggest/review.ts#acceptRecord`) applies the record to a mirror (`packages/core/src/suggest/apply.ts#applyRecord`) and lands its diff only if G0 to G8 pass: the previewed record, nothing parked, only leased clients, only `root` and `registers`, no register aliasing, not outdated, the reviewer's projection hash (`packages/core/src/suggest/apply.ts#previewHash`), a headless bind, and the state cap. Otherwise 409 and nothing applies. Reject and withdraw write only the record.
- **The card.** The Suggestions button sits beside moss's `CommentsMenuButton` (`apps/web/src/host/collab/suggest/SuggestionsPanel.tsx#SuggestionsButton`); each record renders as glyphdown's card in the moss DS (`apps/web/src/host/collab/suggest/SuggestionsPanel.tsx#SuggestionCard`) with Accept and Reject for editors and Withdraw for the author. The toggle and the "Suggesting" chip live in the floating toolbar (`apps/web/src/host/collab/suggest/SuggestChrome.tsx#SuggestModeChip`).
- **Export** is the clean body; `?view=working` adds open suggestions (`packages/sync/src/suggest/review.ts#exportWorkingMarkdown`).

**Where.** `packages/sync/src/suggest/`, `packages/sync/src/doc/suggest.ts`, `packages/core/src/suggest/`, `packages/protocol/src/suggest.ts`, `apps/web/src/api/suggestions.ts#handleSuggestion`, `apps/web/src/host/collab/suggest/`.

**Desktop changes.** All new: moss has no suggestion model. Desktop adds the toolbar toggle (seam `suggest-toggle`), the Suggestions panel and the review paint, and needs a server connection to take a lease. The `suggester` role must exist in desktop's capability checks (`packages/protocol/src/roles.ts#ROLES`).

**Risks.**
- Suggesting needs a lease from the server; a desktop offline cannot start a suggestion, and one resumed later may be outdated and only offered back as text.
- Gates G4 and G5 reason over Yjs item ids; a change to how Lexical V1 rewrites siblings on a move changes which records go outdated.
- `ops` are stored V1 updates; the record format is tied to the Yjs encoding.

## 8. History

**Here.**
- **Versions.** A DocDO table holds auto, named and restore-point versions with title, frontmatter, markdown, Lexical JSON, payloads and comments (`packages/sync/src/doc/versions.ts#VersionStore`, content in `packages/sync/src/doc/version-content.ts#captureContent`). Content over 1.5 MB spills to R2. Pruning bounds storage per note (`packages/sync/src/doc/versions.ts#VERSION_BOUNDS`, limits in `packages/protocol/src/limits.ts`). Triggers: the last disconnect after a change, every push, activity (500 updates or 10 minutes), a named version on request, and a restore point before each restore.
- **Restore is an edit.** It runs `packages/sync/src/server-doc.ts#serverWrite` with an identity-preserving two-tier reconcile (`packages/core/src/reconcile.ts#$reconcileRoot`, `packages/sync/src/reconcile.ts#reconcileBody`), three-way against the base the restorer previewed (`packages/sync/src/restore-base.ts#captureRestoreBase`): inserts made after the base stay, and the result is verified or refused with 409 `restore-unverified` or `restore-base-stale` (A§14).
- **UI.** Glyphdown's history page rebuilt in the moss DS, occupying the editor pane (`apps/web/src/host/history/HistoryView.tsx#HistoryView`), with View, Diff vs current (`apps/web/src/host/history/diff.ts`) and Restore through moss's ConfirmationDialog; `moss:packages/shared/src/components/notes/VersionHistoryEmptyState.tsx` is the empty state.

**Where.** `packages/sync/src/doc/versions.ts`, `packages/sync/src/doc/version-content.ts`, `packages/sync/src/reconcile.ts`, `packages/core/src/reconcile.ts`, `packages/sync/src/restore-base.ts`, `apps/web/src/api/versions.ts#handleVersions`, `apps/web/src/host/history/`.

**Desktop changes.** Moss at the pin has no version history (its `TimelinePopoutModal` is the agent timeline, and `checkpoints` are agent checkpoints). Desktop adds the History control in the top bar (seam `history`) and the view. Versions live on the server; a desktop that keeps local history too must restore through the same reconcile, never by replacing the file.

**Risks.**
- A restore that rebuilds the tree from markdown would give every block new Yjs identity: comments orphan, a peer's concurrent typing is lost, and payload docs are renamed. The reconcile is the contract.
- The reconcile is re-derived for Lexical 0.48 (SP12); a Lexical upgrade that changes node serialization needs the restore fuzz tests rerun.

## 9. Server model

**Here.** One Worker script (`apps/web/src/server.ts`) routes, in order, `/api/version`, test hooks, auth, the workspace socket, `/api/*`, the one party `/parties/doc-d-o/<docId>`, `/frame/html`, then SSR (A§4.1).
- **DocDO**, one per doc (`packages/sync/src/doc-do.ts#DocDO`): a y-partyserver `YServer` with hibernation; SQLite tables for updates, chunked state, meta, revocations, payloads, bases, leases and versions (`packages/sync/src/doc/persistence.ts#DocStore`). It classifies each frame as a write or inert (`packages/sync/src/doc/admission.ts#classifySync`), refuses by role before Yjs applies anything, validates awareness against the connection (`packages/sync/src/doc/awareness.ts#receivePresence`), acks persisted frames, and projects the title and filename to D1 (`packages/sync/src/doc/projections.ts#d1Projections`).
- **PrincipalDO**, one per user or agent (`packages/sync/src/principal-do.ts#PrincipalDO`): the workspace channel (sidebar updates without polling), the sign-out registry `doc_sockets`, and the push rate window.
- **SearchDO**, global (`packages/sync/src/search-do.ts#SearchDO`): FTS5 over the converter's markdown export plus a links table for backlinks.
- **D1** (`apps/web/src/db/schema.ts`, migrations in `apps/web/drizzle/`): better-auth tables, `agents`, `folders` (a vault is a root folder), `docs`, `doc_members`, `folder_members`, `share_links`, `invites`, `notifications`, assets, `doc_media`, prefs, `feedback`, and `access_epochs`.
- **R2**: content-addressed asset blobs (`apps/web/src/api/assets.ts`, keys `asset-blobs/sha256/<hash>`) and version spills.
- **Access.** One roles module (`packages/protocol/src/roles.ts#can`), one resolver (`apps/web/src/api/access.ts#resolveDocAccess`), one kick path (`packages/sync/src/fanout.ts#kick`). Correctness rests on pull validation: every frame waits for a D1 read of the owner's access epoch and the sockets' credentials (`packages/sync/src/access-epoch.ts#readStamp`); kicks are hints.

**Where.** `packages/sync/src/`, `apps/web/src/server.ts`, `apps/web/src/worker/`, `apps/web/src/api/`, `apps/web/src/auth/`, `apps/web/src/db/schema.ts`, `apps/web/wrangler.jsonc`, A§4 to A§8.

**Desktop changes.**
- Desktop gains an account, a session and a server URL; the device flow the CLI uses (`packages/cli/src/config.ts#deviceLogin`) fits a desktop app.
- `~/Moss/Notes` maps onto vaults and folders. Folder identity moves from paths to ids (the web keeps an id-to-path map for moss's path-based UI, `apps/web/src/host/bridge/index.ts#folderIdFromPath`). meta.json's per-note fields move to D1 rows and per-user prefs; pins are per user.
- Assets move from each note's `assets/` folder to a per-doc media record with content-addressed blobs; markdown keeps `assets/<file>` references.
- Moss's reserved database package (excluded from the vendor tree) is the natural home for a desktop client of this API.

**Risks.**
- Every limit (2 MB of markdown per doc, 50 connections, 300 writes per 5 s, 8 KB awareness) and every access rule is enforced in the DocDO and the Worker; a desktop path that writes D1 or R2 directly bypasses them.
- Durable Object storage is bound to the Worker name, so names are permanent once data exists (A§21).
- Revocation is pull-validated per frame; a desktop client that caches a role locally must still treat 4403 and 4402 as authoritative (`packages/protocol/src/sync.ts#closeAction`).

## 10. CLI and daemon

**Here.** `packages/cli/` builds `moss-multi`, never `moss` (moss desktop's launcher). Commands are in `packages/cli/src/program.ts#USAGE`: login (device flow or agent key), list, cat, new, add, url, mv, rm, pull, push, init, sync, watch, history, comments, suggestions, snapshot, comment, share.
- **Push** sends the base and the edited text; the DocDO runs the three-way merge (`packages/core/src/merge.ts#computeMergedTarget`), refuses degenerate pushes (`packages/core/src/merge.ts#isDegenerate`) unless forced, and lands the result through the identity-preserving reconcile in one server write (`packages/sync/src/push.ts#landPush`, route `apps/web/src/api/push.ts#handlePush`). Exit codes: 0 clean, 1 other, 2 failed hunks, 3 degenerate.
- **Sync and watch** (`packages/cli/src/sync.ts#syncOnce`, `packages/cli/src/sync.ts#watchLoop`): tracked-file classification from glyphdown, untracked `.md` files become docs, server renames rename local files, and deletes never propagate. Workspace state is `.moss-multi/<docId>/` with confinement checks on every read and write (`packages/cli/src/workspace.ts#confined`).
- **Moss interchange.** `add --moss` imports a moss note with its `# Title` line and `comments.json`; tracked files in moss mode keep markers moving with the text (`packages/cli/src/moss-format.ts#remapMarkers`).

**Where.** `packages/cli/src/`, `packages/core/src/merge.ts`, `packages/sync/src/push.ts`, `packages/protocol/src/push.ts`, A§17.

**Desktop changes.** Desktop's file watcher and `note-store` become this loop for `~/Moss/Notes`: a disk edit made outside the app (another editor, git, an agent) is pushed as a three-way merge against the last synced base, and the server's changes are written back as the folder projection. The `.moss-multi/` base store is the model for desktop's per-note base. Agents use keys (`mm_sk_…`) and are attributed with a Bot badge.

**Risks.**
- A disk edit against a stale base can leave failed hunks that need a person; desktop needs a conflict surface the CLI does not have.
- Folder names come from the filename projection (unique per folder, `-N` on collisions) rather than desktop's folder-per-note layout; a migration must map one onto the other without renaming notes people link to.

## 11. Viewer and editor packages

**Here.**
- `@moss-multi/viewer` (`packages/viewer/`, API 1.1): `packages/viewer/src/mount.tsx#mountMossViewer` mounts moss's editor read-only from markdown and layout in any page, with no socket and only host-passed services; features include `selection-1` and `share-with-agent-1` (`packages/viewer/README.md`).
- `@moss-multi/editor` (`packages/editor/`): `packages/editor/src/mount.tsx#mountMossEditor` mounts moss's editor editable over a file bridge (`packages/editor/src/contract.ts#MossEditorBridge`) and produces the exact bytes of every file a moss desktop save writes: the `.md`, `comments.json`, `layout.json` and `meta.json` (`packages/editor/src/contract.ts#MossNoteWrite`, `packages/editor/src/desktop/pipeline.ts#planSave`). Desktop's main-process read and save steps are copied verbatim into `packages/editor/src/desktop/note-store.port.ts`, and golden tests run fixture notes through desktop's own save path at the pin (`packages/editor/src/desktop/desktop-save.ref.ts`) and through the editor, comparing every byte. Host helpers (`packages/editor/src/host/moss-editor-host.js#noteEditability`, `packages/editor/src/host/moss-editor-host.js#allocateFolderName`) port desktop's folder and id rules. Design and open owner items: `docs/design/editor-embed.md`.

**Where.** `packages/viewer/`, `packages/editor/`, `scripts/ci/viewer-pack.mjs`, `scripts/ci/editor-pack.mjs`.

**Desktop changes.** None to adopt. They matter to the port in two ways: they prove moss's editor runs outside Electron with only the substituted leaf modules (`packages/editor/vite.config.ts`), and `packages/editor/src/desktop/` is an executable specification of desktop's save bytes that a desktop folder projection (sections 4 and 10) must keep producing.

**Risks.**
- `note-store.port.ts` and `desktop-save.ref.ts` are copies of Electron main-process code identified by sha256 in their headers, outside the `drift` check; a re-pin must re-copy them and rerun the golden tests.
- The editor package edits files that moss desktop may rewrite concurrently; it detects and preserves, but cannot prevent, a later desktop overwrite (`docs/design/editor-embed.md`, section 1).

## Order of work for a port

1. Upstream the converter split and the node class and view split (section 3); nothing changes for users.
2. Upstream the `collaboration` prop, the bound-pane hook and the register seams (sections 1, 4 and 5) behind a flag, file-backed by default.
3. Stand up this server model (section 9) and bind desktop panes to it, with the folder as a synced projection (section 10) and a local Yjs store for offline.
4. Switch comments to anchors (section 6), with `comments.json` as a one-time import.
5. Add suggestions and history (sections 7 and 8), which are new surfaces with no desktop counterpart.

# moss-multi architecture

Design of record for the restart (2026-10-02). PRODUCT.md holds the owner's decisions; this file says how they are built. Changing a PRODUCT line needs the owner. Changing this file needs a stated reason in the same commit.

**Citation key.** `P:<section>` is a PRODUCT.md section (Collab, Notes, People, Meaning, Agents, Tech, Viewports). `Rn` is restart ruling n. `L§x.y` is docs/history/LEARNINGS.md. `S-ren`, `S-conv`, `S-gd`, `S-prior`, `S-test` are the surveys in docs/design/surveys (moss-renderer, moss-nodes-converter, glyphdown-backend, prior-solutions, test-infra). `SPn` is a spike (§22). `Tm.n` is a BUILDPLAN task.

## 0. Invariants every section serves

1. **One source of truth per value.** For an open doc, the Y.Doc is the only content, title and frontmatter source. Everything else (D1 title and filename, sidebar rows, search, exports) is a projection with one writer. [P:Tech; L§7.1 #5; L§3 pattern 3]
2. **Nothing editable before it is bound and synced.** Every input either lands or is visibly refused. [R2; P:Notes title rule; L§4.4]
3. **Port moss, don't reimplement it.** Changes are small marked seams at module boundaries, so a re-pin is mechanical. [P intro; R1; R13; L§7.1 #4]
4. **One of each.** One converter, one roles module, one kick path, one navigation owner, one terminal store, one DOM contract. [P:Tech; L§4.6; L§4.10]
5. **Glyphdown as-is wherever PRODUCT is silent.** Each divergence below cites the line that forces it. [P:Tech last bullet; L§1.1]
6. **The real stack and a real browser, with tests run in remote CI only.** [R6; L§7.1 #3]

## 1. System at a glance

```
Browser tab
  moss App (vendored, client-only) ──window.electronAPI──► host/bridge  (REST · Y.Doc · browser APIs · localStorage)
  per editor pane: <LexicalCollaboration> + MossCollaborationPlugin ──1 WS /parties/doc-d-o/<docId>──► DocDO(docId)
  workspace channel (one per tab) ──────────────────────1 WS /api/workspace/ws──────────────► PrincipalDO(principalId)
Worker (one script): /api/version → /__test → /api/auth → /api/workspace/ws → /api/* → /parties/doc-d-o → /frame/html → Start SSR
  D1: accounts, vaults/folders/docs, grants, links, invites, notifications, assets, prefs
  R2: content-addressed asset blobs; version spill
  DocDO ─RPC─► SearchDO('global'), PrincipalDO(*)      DocDO ─D1─► docs.title / filename / updated_at projections
CLI + folder-watch daemon ──REST (Bearer)──► /api/docs/:id/{content,push} …
```

## 2. Repository layout

```
PRODUCT.md  BUILDPLAN.md  PROGRESS.md  README.md
docs/        ARCHITECTURE.md  METHOD.md (gotchas every agent reads)  DEVIATIONS.md (registry)
             design/<topic>.md (milestone design reviews)  design/surveys/  history/  briefs/ (pruned at milestone close)
package.json (packageManager, pnpm.overrides, patchedDependencies)  pnpm-workspace.yaml  .node-version
patches/y-partyserver@2.2.0.patch                      # the only dependency patch
vendor/
  moss/                       # mirror of moss@762abb777, same relative layout, so relative imports resolve unchanged
    PORTED.json               # per file: path, pin, upstreamSha256, mode verbatim|patched|substituted|extracted, patch
    logos/moss-sprout-icon.png  tsconfig.base.json (extended by shared's tsconfig)
    packages/shared/{src/**, tailwind.config.ts, tsconfig.json}
    packages/desktop/src/{renderer/**, common/**, types/electron-api.d.ts, renderer-env.d.ts}
    .ladle/**  packages/desktop/stories/**   # unused by the app; `pristine` builds the Ladle oracle from them (§22 OA1)
  lexical-react/              # LexicalCollaborationPlugin.tsx + shared/useYjsCollaboration.tsx @ @lexical/react 0.48.0
  patches/{moss,lexical-react}/<path>.patch
apps/web/                     # TanStack Start app + Worker
  wrangler.jsonc  vite.config.ts  tailwind.config.ts  postcss.config.cjs  drizzle.config.ts  drizzle/*.sql
  src/server.ts  src/env.ts  src/routes/**  src/client/**  src/auth/**  src/db/**
  src/api/       router, docs, folders, vaults, workspace, trash, members, share-links, invites, notifications,
                 assets, unfurl+ssrf, search, agents, prefs, access (the one resolver), fanout (the one kick path), test-hooks
  src/host/      everything moss lacks, outside vendor/: bridge/ (electronAPI adapter), affordances.ts, navigation.ts,
                 substitutes/ (asset-url, media-server-url, RemoteWebSurface), collab/ (doc-session, provider, hardening,
                 heartbeat, connection-truth, terminal, title-binding, frontmatter-binding, presence, colors, cursors,
                 undo, origins, excluded-properties, layout-local, registers), workspace/ (channel), surfaces/
                 (LoginCard, DenialPage, ShareDialog, VaultSwitcher, Bell, HistoryView, SuggestionsPanel,
                 ConnectionIndicator, ConnectionBanner, AgentsSettings)
packages/
  protocol/   close codes, messages, routes, roles.ts, limits, retention constant, dom-contract.ts
  core/       pure: doc-fields, text-diff, merge (3-way), reconcile (identity-preserving), anchors, quote, filenames,
              folder-tree, search-core, ratelimit
  sync/       DocDO (modules: persistence, admission+gates, projections, awareness, registers), PrincipalDO, SearchDO,
              server-doc (headless binding + serverWrite), converter host
  ui/         moss DS extensions (AvatarChip, FacePile, Banner, MemberRow, InboxItem, VaultSwitcher parts) + stories
  cli/        moss-multi CLI and folder-watch daemon
  viewer/     the read-only viewer bundle (T0.13): moss's MarkdownEditor unbound, with host-injected services
e2e/          playwright.config.ts, lib/, selftest/, journeys/, parity/, calibration/, qa/
scripts/      stack.mjs, qa.mjs, moss-vendor.mjs, provenance.mjs, ci/plan.mjs, ci/minutes.mjs, ci/trace.mjs
.github/workflows/  ci.yml, red-proof.yml, deploy-staging.yml (canary from M1)
```

- **Web-only code never lives in a mirrored vendor directory**, so the vendor tree stays diffable against upstream. [S-prior §15]
- **Aliases are global and match moss's order.** `@/*` maps to `vendor/moss/packages/shared/src/*`. `@moss/shared` maps to that package's `index.ts`, and `@moss/shared/*` to its subpaths. `@moss-desktop/*` maps to `vendor/moss/packages/desktop/src/*` for host and server imports. SP1 proves that the client build resolves them. [S-ren §5.2; L§4.18]
- **`packages/ui` extends the moss DS before any new surface uses it.** It imports moss primitives and tokens only, and a lint rule forbids raw color literals. Each primitive has a Ladle story that CI builds and screenshots. [P intro; L§1.1; L§4.1]

### 2.1 Vendoring and re-pinning

- **Source.** `scripts/moss-vendor.mjs` copies from a read-only snapshot of moss@762abb777 (`.refs/moss`, or a `git archive` of a temp clone of brsbl/moss). It never reads or writes `~/Code/moss`. [R1; L§0 inventory]
- **Header.** Line 1 of every vendored source file reads `// ported-from: <path> @ 762abb777`, using `/* */` in CSS. JSON, `?raw` markdown and binaries get no header and are listed in `PORTED.json`. [R1; S-ren §6.5]
- **Patches.** A change to a vendored file is applied in the tree and also stored as `vendor/patches/moss/<path>.patch` against the pristine bytes. Each hunk is marked `// moss-multi seam: <id> (<cite>)`.
- **Substitution.** When a whole small leaf module is platform-specific, a Vite `enforce:'pre'` transform swaps its source by absolute path and the vendored file stays byte-identical. This applies to `editor/utils/asset-url.ts`, `editor/utils/media-server-url.ts` and `editor/preview/RemoteWebSurface.tsx`. [S-ren §6.4; L§4.18]
- **Extraction.** The converter split (§12) is generated, never hand-moved. `moss-vendor.mjs extract` reads a committed AST symbol manifest and emits, from pristine upstream, the pure modules (`mode: extracted`, listing their source symbols) and the residual files that now import them (`mode: patched`, generated). A 3.7k-line deletion patch would conflict on every upstream edit and hide upstream transformer changes from the drift check. [S-conv §2.3; L§4.1]
- **Re-pinning.** `moss-vendor.mjs repin <sha>` rewrites header plus upstream bytes, re-runs extraction, runs `git apply --3way` for each remaining patch, reports conflicts and new or deleted upstream files, and re-hashes.
- **The CI drift check.** A verbatim file, with its header stripped, must hash to `upstreamSha256`. A patched file must equal upstream plus its patch. Extracted files must equal a fresh extraction from pristine.
- **One pin for every file.** Pin changes are owner-gated, single-commit baseline reviews. At each milestone close, `drift` reports upstream changes since the pin that touch vendored files; it changes nothing. [L§4.1 mixed pins, re-audit; L§1.1]
- **The same mechanism covers `vendor/lexical-react`** at @lexical/react 0.48.0. [R12]
- **Excluded from the vendor tree:** `R/dev/base-ui-sandbox`, Electron `main/` and `preload/`, `packages/web` and `packages/db`. `R/main.tsx` and `index.html` are vendored but unused; they are the reference for the host entry. [S-ren §6.3]

### 2.2 Seam once, fill in host

Each patched vendor file gets all of its seams in one task, as calls into host hooks or slots. Later milestones then change host files only, which keeps vendor diffs small and lets lanes run in parallel. [S-prior §15 "plan the note-view seam"]

| Vendored file | Seams | Installed |
|---|---|---|
| `R/editor/MarkdownEditor.tsx` | `collaboration` prop (bound mode: `editorState:null`, `editable:false`, no serialized-state cache, plugin replaces `<HistoryPlugin/>`, composer key without `readOnly`, throw if `updateContentFromMarkdown` runs bound); re-exports from `markdown/*`; `--link-selection` mark becomes a CSS highlight (§10.10) | T0.6, T0.8, T0.P |
| `R/panels/CanvasAreaContent.tsx` | one `useMossMultiPane(note)` hook: bound init returns early before `getById`; save, disk, agent, flush and `syncH1ToTitle` paths removed when bound; mount gate on first sync; title binding slot; frontmatter binding; top-bar collab slot; terminal subscription; hide-registry reads; the `data-top-bar`, `data-editor-canvas` and `data-editor-pane` attributes (§19) | T0.8 |
| `R/App.tsx` | AI action and ⌘K hidden; Rename hidden until the title binds; duplicate through the server; "+ Note" blurs its trigger and arms the opening guard (T0.P), then focuses the title (R2, §9); phone notes-panel overlay | T0.5b, T0.P, T1.4, T1.8, T2.7 |
| NotesListPanelContent, TrashedNotesPanelContent, `S/…/NotesListPanel`, SettingsModal, slash registry, VideoPastePlugin, MediaDropPlugin | hide-registry and `staged` reads (a pasted or dropped file is refused visibly while `media-upload` is staged); `data-sidebar-row`; a folder "Share…" item slot; no move or folder actions on surfaced shared rows (§11); Agents section in Settings | T0.5b, T0.P, T3.6 |
| Shared DS primitives (dialog, alert-dialog, dropdown-menu, context-menu, popover, tooltip) | `data-overlay-surface` on every opened surface (§19); moss at the pin has none of the §19 attributes | T0.5b |
| `S/state/atoms.ts` | split navigation (back, forward, left pane) never shows one doc in both panes (§10.1) | T1.6 |
| 8 decorator nodes and `CommentPlugin`, `comment-import` | class/view split and `commands.ts`, generated by extraction (§2.1); register getter and setter seams in the extracted classes (§10.10) | T0.6, T1.9 |
| ColorCodePlugin, CodeNodeNormalization, ChecklistSortPlugin, FileLinkPlugin, MathCalculationPlugin | remote-origin and read-only guards; no initial sweep on a bound doc; overlays instead of tree writes | T1.6, T3.3 |
| `R/editor/plugins/TabBarPlugin.tsx` | a read-only editor's tabs switch but never add, rename, delete or reorder (moss gates only tab-width resize) | T0.13 |
| `HtmlBlockquoteNode.tsx` view, `useHtmlPreviewImage` | no request for a moss-asset:// preview screenshot, which a browser never loads (T0.P); live sandboxed iframe as the static preview (T3.2) | T0.P, T3.2 |
| Comment UI (8 call sites, `CommentPlugin`) | CRDT comment adapter | M4 |

## 3. Toolchain and pinned versions

Every runtime dependency is pinned exactly. `pnpm.overrides` force `lexical` and every `@lexical/*` to 0.48.0, and force `yjs` to 13.6.31 (including `@lexical/yjs>yjs`). `resolve.dedupe` covers react, react-dom, jotai, jotai-family, lexical, `@lexical/*`, yjs and prismjs. [L§4.2; L§4.18; S-ren §5.7] The base is the set proven together at moss-collab@9104ceb, except where moss@762abb777 dictates otherwise. [S-prior §19]

| Area | Pins |
|---|---|
| Runtime and tooling | Node 24 LTS (arm64 locally, verified per run; translated Node refused), pnpm 10.30.1, TypeScript 5.9.3 [L§4.18; L§5.1] |
| React | react and react-dom **19.3.0**, moss's version; unproven with Start (SP1) |
| Web framework | @tanstack/react-start 1.168.32, react-router 1.170.18, router-plugin 1.168.23, react-query 5.101.0 |
| Build | vite 8.1.5, @vitejs/plugin-react 6.0.2 (glyphdown's; 4.x peers stop at vite 7), @cloudflare/vite-plugin 1.46.0, wrangler 4.113.0 (workerd 1.20260721.1), @cloudflare/workers-types 4.20260702.1; `compatibility_date` 2025-09-02 with `nodejs_compat` |
| Data and auth | better-auth 1.6.23, drizzle-orm 0.45.2, drizzle-kit 0.31.10 |
| CRDT | yjs 13.6.31, y-protocols 1.0.7, lib0 0.2.117, y-partyserver 2.2.0 (patched `unload`→`pagehide`), partyserver 0.5.8 |
| Lexical | lexical and every `@lexical/*` at **0.48.0**, including yjs, headless, code-core, code-prism and extension (R1). No `@lexical/yjs` patch: its two fixes are upstream or obsolete at 0.48. [S-prior §2.2] |
| Moss UI | tailwindcss 3.4.19 (not v4), @base-ui/react 1.6.0, jotai 2.20.2, jotai-family 1.1.0, lucide-react 0.577.0, @floating-ui/react 0.27.20, recharts 3.10.1, prismjs 1.30.0, react-colorful, cva, clsx, tailwind-merge, js-yaml and moss's font packages, all at moss's lockfile versions |
| Merge and CLI | @sanity/diff-match-patch 3.2.0, commander 14.0.3 |
| Tests (CI only) | vitest 4.1.10, fast-check 4.9.0, @playwright/test 1.61.1, @cloudflare/vitest-pool-workers matching wrangler, pixelmatch, pngjs |

## 4. Worker and web app

### 4.1 Routing order (`apps/web/src/server.ts`)

The Worker exports `createServerEntry({fetch})` and re-exports the DO classes. [S-gd §1; S-prior §12; L§4.7]

1. **`/api/version`** answers GET only (405 otherwise) with `cache-control: no-store` and `{commit, headSha, dirty, diffHash, bundleHash, clientHash, buildTime, env}`. [L§4.18; S-test §2.4]
2. **`/__test/*`** works only behind the four-condition gate (§19). Otherwise it returns the same 404 as an unknown route.
3. **`/api/auth/*`** goes to `handleAuthRoute`, which wraps better-auth built per request. Sign-out fans out first (§7).
4. **`/api/workspace/ws`** authenticates through the origin gate (§18), then upgrades to `PrincipalDO(principalId)` (§5.2).
5. **`/api/*`** goes to `handleApi`, which runs the origin gate (§18) before any unsafe method. Unknown paths get a JSON 404.
6. **`/parties/doc-d-o/<docId>`** is the only party namespace; any other gets 404.
   - Authenticate by cookie, bearer or `?share=`, pass the origin gate (§18), then resolve the role (§8).
   - Never refuse before the upgrade: a refused handshake reaches the client as a transient 1006, and it would retry forever [L§4.6]. On a denial the Worker accepts the upgrade itself (`WebSocketPair`) and closes it, without waking the DocDO: 4401 with no credential or a cookie from another origin; 4404 for a missing, inaccessible, forged-token or revoked-token doc (one code for all four, so nothing is disclosed); 4410 for a trashed doc the caller could otherwise open.
   - Strip every client `x-moss-*` and `x-partykit-*` header by prefix, then set the trusted `x-moss-principal|role|session|share` headers.
   - Clone the request without an init before setting headers, so `Upgrade` and `Sec-WebSocket-*` survive. Then call `routePartykitRequest`. [L§4.7 upgrade trap; S-gd §1.3]
7. **`/frame/html`** serves the HTML-block frame: a fixed document whose only policy is `sandbox allow-scripts`, which writes the block HTML its embedding page posts to it (SP13).
8. **Everything else** goes to TanStack Start SSR.

Errors are logged through `waitUntil` and rethrown. `/api` never answers with HTML.

### 4.2 Routes

| Route | Renders |
|---|---|
| `/` | Redirects to the last-viewed doc in the active vault, or shows the empty shell |
| `/d/$docId[?share=]` | moss App with `initialNoteId=docId` [L§4.1 real routes] |
| `/f/$folderId[?share=]` | Folder or vault share landing: the App with that vault active and the folder revealed |
| `/login[?next=]` | LoginCard (sign in or sign up) |
| `/device` | Device-flow approval |
| `/invite/$token` | Accepts the invite, then redirects to its target |
| `/pdf-export?pdfExportSessionId=` | moss `PdfExportApp`, client-only; calls `window.print()` once `body[data-pdf-export-status=ready]` [R4] |
| `/d` or `/f` the caller cannot open | DenialPage: one moss-DS "doesn't exist or you don't have access" surface for every cause, with Sign in and `next=` when signed out. The API 404s behind it stay byte-identical (§8). [L§4.10 D-G1; L§1.3 honest states] |

**The root route** uses `shellComponent` with an inline theme script that reads `moss_theme`, plus `<HeadContent/>` and `<Scripts/>`. It imports all global CSS: moss `styles.css` and the font CSS. [L§4.1; L§4.18]

**`beforeLoad`** reads the session through one `createServerFn`. No session redirects to `/login?next=`. A failed lookup renders `data-app-state=degraded` and retries in place, never redirecting to `/login` [R10; L§4.6]. A `?share=` URL skips the redirect. [S-gd §5.2]

### 4.3 Client boot

**Entry order** (`src/client/entry.tsx`): Prism global install, moss `prism-setup`, fonts in moss `main.tsx` order (Inter Variable, JetBrains Mono, Charter), `styles.css`, then Start hydration. `html[data-client-build]` is stamped before React mounts. [L§4.1 Prism; S-ren §5.1]

**Mounting moss.** `MossAppHost` combines `ClientOnly`, a `ChunkReloadBoundary` (one hard reload when a dynamic import fails), and `lazy(boot)`. The bridge is installed before App's module evaluates. App keeps Jotai's default store (no Provider) and `React.StrictMode`, as moss does, and honors `?mossMode=pdf-export` as `R/main.tsx` does. [S-ren §1.1]

**Content security policy:** `default-src 'self'`; `script-src 'self' 'nonce-<per request>'`; `style-src 'self' 'unsafe-inline'`; `connect-src 'self'` plus the same-origin `ws(s):` URL; `frame-src 'self' data: https:`; `img-src 'self' data: https: blob:`; `media-src 'self' blob:`. Start's SSR injects per-request inline scripts and `ScriptOnce` rewrites the theme script, so a static hash would block hydration; the Worker mints the nonce, passes it as the router's `ssr.nonce`, and sets the header. A `data:` iframe inherits this policy (SP13, settled at T0.5a in Chromium), so its inline scripts are refused; HTML blocks load `/frame/html` instead (§4.1), and T3.2 points moss's `IframeFrame` there. [S-ren §5.1, §0.13; router-core `ssr-server.js`]

**Tailwind.** The content globs cover vendored renderer and shared code, `apps/web/src/**` and `packages/ui/**`. A CI test fails when any file that writes a `className` falls outside them. [L§4.1]

### 4.4 Bundle boundary

The Worker script contains server code, the DO classes and the converter closure only. The moss shell and editor are reachable only through the client-only dynamic import, which sits behind `import.meta.env.SSR` so the Worker build never bundles it. A CI dependency rule over static imports fails if anything reachable from `server.ts` imports `*.view.tsx`, `*.css`, the `@moss/shared` barrel, `react-dom`, `jotai`, `@lexical/code` (only `@lexical/code-core` is allowed) or `api/electron`. [S-conv §2.3, §2.5]

## 5. Durable Objects

There are three classes, DocDO, PrincipalDO and SearchDO, all SQLite-backed under migration `v1 new_sqlite_classes`. HtmlDocDO is not built, because HTML is content, not an asset. [P:Notes; S-gd §6.6] Internal calls are RPC methods on fresh `getServerByName` stubs (never cached), never HTTP with trusted headers. `getServerByName` awaits `onStart`, but user RPC methods don't initialize themselves, so a stub that outlives an eviction would export an empty doc: every RPC method starts with a `ready()` guard that runs `onStart` if it has not run. [S-prior §7.6; S-gd App. A; partyserver 0.5.8 `getServerByName`]

### 5.1 DocDO, one per doc (`packages/sync/src/doc-do.ts`)

It starts from glyphdown's `do.ts` shape, not moss-collab's 3,511-line class, and is split into modules (persistence, admission and gates, projections, awareness, registers) so lanes own disjoint files. [S-prior §7]

**Basics.** `extends YServer` with `static options = {hibernate: true}`, addressed by `idFromName(docId)`. Shared types are `root` (`Y.XmlText`, @lexical/yjs V1), `title` (`Y.Text`), `frontmatter` (`Y.Map`) with `frontmatterOrder` (`Y.Array`, §10.4), `registers` (`Y.Map`, M1, §10.10), and later `comments` (`Y.Map`, M4) and `suggestions` (`Y.Map`, M5). [P:Tech; R3; L§1.2] Tables are `yupdates(seq, data)`; `ystate(idx, data)` chunked at 1.5 MB; `meta(key, value)` for the deleted flag, seeded flag, `stateBytes`, folder and owner; `revocations(kind token|session|principal, id, at)`; `bases(hash, text, created_at)` with a 14-day TTL (M7); and `versions` (M6). [S-gd §2.1]

**Load and persistence.** `onLoad` applies the `ystate` chunks, then every `yupdates` row in seq order, under origin `persistence`. `doc.on('update')` INSERTs each update immediately (skipping `persistence`) and adds its bytes to `stateBytes`. Compaction runs above 500 rows or 1 MB as `encodeStateAsUpdate` inside `transactionSync`, which preserves item identity; `onSave` (debounced 2 s / 10 s) compacts and feeds search. [L§4.7; S-prior §7.1] partyserver runs `onStart` inside `blockConcurrencyWhile`, so a woken DO replays before it sees any frame. That is the restore-after-hibernation guarantee. [P:Tech; S-gd §2.2]

**Seed.** When the root is empty and `seeded` is unset, `create` and `onLoad` seed one empty paragraph under origin `server-seed`. Title and frontmatter start empty; placeholder text such as "Untitled" is never authored into the CRDT. [L§4.3; L§4.4; S-prior §7.2]

**Server writes.** One helper, `serverWrite(origin, mutate)`, serves seed, import, push, restore and accept/reject: hydrate a mirror Y.Doc bound to a headless editor (same nodes and exclusions as the client), mutate headlessly, diff from the hydration state vector, and apply the diff to the live doc under `origin`. Converter calls stay synchronous. [S-prior §7.2; S-conv B10] Markdown export is memoized per state behind a dirty flag. [S-gd §2.10.2]

**`onConnect` order.** Parse the trusted headers. Then close 4401 for no principal, 4402 for an ended session, 4403 for a revoked token or principal, 4410 for a deleted doc, and 4429 for a 51st connection. Then set the hibernation-safe attachment `{principalId, kind, name, role, sessionId, shareToken}` with a functional `setState` (an object-form call would wipe y-partyserver's `__ypsAwarenessIds` and leave ghost presence; names are length-capped), register the socket with the PrincipalDO through `waitUntil` (never awaiting D1 in the upgrade; a reply of `ended` closes 4402, §5.2), and call `super.onConnect`. [S-prior §7.3; y-partyserver 2.2.0]

**The write classifier.** A sync frame (step 2 or update) is a *write* only if applying it would change the doc: it carries a struct the server's state vector lacks, or deletes an item the server has not deleted. Every connect and every wake sends a step 1, and the provider always answers with a step 2, so most viewer frames are inert; inert frames are applied silently whatever the role. The same classifier feeds the rate count and suggester vetting. [y-partyserver `onConnect`, `onStart`]

**`onMessage` order.**
1. Revoked session closes 4402; revoked token or principal closes 4403. String frames go to custom handlers. Awareness frames are validated (§10.7). Sync step 1 goes to super.
2. A write from a role below suggester gets a unicast `__YPS:{t:'write-refused', reason:'role'}` and close 4403. A refusal is never silent. [P:Tech]
3. Above 300 writes per 5 s on one connection, the frame is not applied and the DO closes 4420, a transient code; the client keeps its Y.Doc and reconnects with backoff, so its step 2 re-delivers everything and nothing is discarded.
4. A write that would push `stateBytes` past the cap (Limits, below) is refused with `doc-cap`, simulated only near the cap. A suggest-mode write is vetted by item identity before it applies (M5, docs/design/suggestions.md §4). These refusals close 4409, and the client discards its optimistic state. [S-prior §7.5]
5. Super applies the frame with `origin = connection`.

**Acks.** After persisting, the DocDO unicasts `{t:'ack', sv, ds}` to the originating connection, coalesced over 250 ms. The additive optional `ds` field encodes the deletes carried by the acknowledged frames as a Yjs snapshot with an empty state vector; legacy vector-only acks can settle inserts but never pending deletes. Coalescing and rate counts are keyed by socket identity, not the client-provided connection id. Delete-only edits do not advance a state vector, so deletion coverage is required to avoid reporting an unsent deletion as durable. This drives `data-sync-unacked`. An editor's sync frame the doc already holds is acked too: a socket that drops inside the window loses its ack, and the reconnect's step 2 then changes nothing, so without that ack the edits would read as unsynced forever (T0.P). [L§4.6 durability honesty]

**Projections.** The DO writes D1 directly; glyphdown's DO does not, but R3 forces it. [S-gd §2.10.9; S-prior §6.2] A `title` observer, throttled to 750 ms with a trailing flush and serialized on one chain, writes `docs.title = trim(text)` and `docs.filename = availableFilename(slug(title))`, unique among live docs in the folder (collisions get `-N`, never a 409). An empty title never projects: the column keeps its last value, so clearing and retyping a title cannot churn the filename. [L§4.4] Principal edits touch `docs.updated_at` at most every 5 s. Each change feeds SearchDO and publishes a meta event (§11). Origins `persistence` and `server-seed` never project.

**RPC surface.** `create({folderId, ownerId, title?, markdown?})`; `exportMarkdown()`; `importMarkdown()`; `renameTitle(principal, text)` (a REST rename becomes a CRDT write; failure is a 503); `trash()` (persist the deleted flag, broadcast `{t:'doc-deleted'}`, close everyone 4410); `restore()`; `recheck({principalIds?, tokens?, sessions?})` (re-resolve roles, persist revocations, close 4403 or 4402); `push` (M7); comments, suggestions and versions (M4–M6); and `probeInstance()`, which returns the constructor-set `instanceId` and `constructedAt`. The probe is called through a raw `ns.get(idFromName(id))` stub and skips `ready()`, so it never runs `onStart`. [S-test §3.7]

**In-memory state** (rate counters, timers, the export cache, ack coalescing) is either rebuilt from storage or safe to reset (`stateBytes` lives in `meta`), because on Cloudflare a doc whose clients are idle hibernates after about 10 s and every wake starts empty. [SP14]

**Limits.**
- **Size: one metric everywhere.** PRODUCT's "2 MB/doc" is the markdown a doc can hold, glyphdown's unit (its doc is a `Y.Text` of the markdown). A Lexical tree encodes larger than its markdown, so enforcing 2 MB on Yjs bytes would leave a legal 2 MB push untypeable. Every entry point (frames, import, push, restore) therefore checks the projected `stateBytes`, the encoded doc state, against `STATE_CAP = 2 MB × r × 1.25`, where SP2 measures the worst state-to-markdown ratio `r` over the family corpus. `stateBytes` is exact at load and at each compaction, which re-bases it, and between them adds each update's bytes. Import, push and restore simulate the merge on the mirror first. A doc whose markdown is under 2 MB therefore always stays typeable.
- 50 connections; awareness payloads of 8 KB at most. [P:Tech]

### 5.2 PrincipalDO, one per principal, user or agent (`packages/sync/src/principal-do.ts`)

This is a new DO and a deliberate divergence from glyphdown, forced by three requirements: the sidebar must update live without polling [L§4.4 "prefer a workspace push channel"; L§4.1 remount family]; sign-out must reach live sockets [P:People; L§4.9]; and the push limit is per identity, where glyphdown counts per doc. [P:Tech; S-gd §2.6]

**Workspace channel.** It holds the hibernatable sockets of that user's tabs (`/api/workspace/ws`). JSON events are `meta {docIds, folderIds}`, `notifications`, `vaults` and `session-ended {sessionId}`. The client sends a ping every 25 s while visible. The `publish(event)` RPC is called by the Worker and by DocDOs.

**Sign-out registry.** The table `doc_sockets(session_id, doc_id)` is maintained by DocDOs. `endSession(sessionId)` runs an awaited `DocDO.recheck({sessions})` on every listed doc, then closes that session's workspace sockets. It also records the session as ended for the session's maximum lifetime, so a socket whose registration arrives after the sign-out gets `ended` and is closed 4402 (the B0 race). This replaces a D1 `live_collab_sockets` table. [S-prior §13; L§4.9]

**Push limit.** A sliding window of 60 pushes per minute per identity. Denied attempts count. The DO is single-threaded, so the count is exact.

**Why per principal and not per vault.** Shared docs live in other owners' vaults, and a vault channel would leak sibling doc ids to people with partial access. [L§1.6 non-disclosure]

### 5.3 SearchDO('global')

Glyphdown's SearchDO as-is: FTS5 with bm25 weights (0, 5, 1), a LIKE fallback, and a `links` table. [S-gd §6.4] Bodies are always the converter's markdown export, never `toString()`. [L§4.14] Titles come from `Y.Text`. Wiki targets are indexed under both the normalized title and the filename stem. [R3] The DO re-feeds once on wake and on byte-identical pushes. SearchDO is unreachable from `/parties`.

## 6. D1 schema

The schema is drizzle (`apps/web/src/db/schema.ts`). Migrations are generated by drizzle-kit as one squashed `0000_init` and applied with `wrangler d1 migrations apply`. Tests apply the real SQL and assert that every `references(onDelete)` appears in the DDL. [S-gd §4; L§4.8] Timestamps are epoch ms; the bridge converts to seconds. [L§4.8] Multi-statement writes use `db.batch`, because D1 has no interactive transactions. Cleanup uses `PRAGMA defer_foreign_keys=ON`. [S-gd §4.2; L§4.8]

| Table | Columns and constraints |
|---|---|
| better-auth | `user`, `session`, `account`, `verification`, `device_code`, `rateLimit` |
| `agents` | `id, owner_user_id, name, key_hash UNIQUE` (sha256 of `mm_sk_…`), `created_at, revoked_at` |
| `folders` | `id, owner_user_id, created_by, name, kind folder\|vault, parent_id` (NULL ⟺ vault), `deleted_at, trash_batch_id, created_at`. Unique per owner on `(lower(name))` for live vaults. Unique per parent on `(parent_id, lower(name))` for live folders, because moss identifies folders by path. |
| `docs` | `id, owner_user_id` (the vault owner), `created_by, folder_id NOT NULL, title` (DO projection), `filename` (DO projection, unique per folder among live docs), `created_at, updated_at` (DO-touched), `deleted_at, trash_batch_id`. Index `(owner_user_id, deleted_at)`. |
| `doc_members`, `folder_members` | PK `(target, principal_id)`, `principal_type user\|agent`, `role` viewer..editor, `added_by, created_at`. The owner is never stored. Vault grants are `folder_members` rows on the vault. |
| `share_links` | `token` PK (24 random bytes, hex), `target_type doc\|folder, target_id, role, created_by, created_at, revoked_at` |
| `invites` | `token` PK, `email, target_type, target_id, role, invited_by, created_at, accepted_at, accepted_by, revoked_at` |
| `notifications` | `id, user_id, type` (mention, comment-reply, share-invite, suggestion, invite-accepted), `payload_json, created_at, read_at`. Index `(user_id, read_at)`. |
| `assets`, `content_objects`, `asset_versions` | `assets`: `folder_id, filename, kind image\|video, current_version_id`, unique `(folder_id, filename)`. `content_objects`: sha256 hash, size, refcount. Versions cascade on asset delete. |
| `user_prefs` | `user_id` PK, `default_vault_id, note_intelligence` |
| `user_doc_prefs` | PK `(user_id, doc_id)`, `pinned_at`. Pins are per user, so one collaborator's pin never pins for everyone. |
| `feedback` | `id, user_id, body, page, created_at`. This keeps moss's Feedback dialog from being a dead affordance. |

Folder delete stamps `deleted_at` and one `trash_batch_id` across the whole subtree, and restore works by batch. [P:Notes]

## 7. Auth

[S-gd §3; S-prior §11; L§4.9; P:People]

**Setup.** `createAuth(env)` is built per request with the drizzle adapter and `cookieCache` off. `emailAndPassword` is enabled (minimum 12 characters, 8 on loopback; `requireEmailVerification: false`). A social provider is registered only when both its id and secret exist, and the login card renders buttons from the same helper; none are configured. [P:People] Plugins are `deviceAuthorization` (client `moss-multi-cli`, 15 min expiry, 5 s interval), `bearer()`, and `tanstackStartCookies()` last. `user.create.after` runs `ensureDefaultVault("Home")`.

**Rate limits are explicit.** By default better-auth 1.6.23 limits only when `NODE_ENV=production`, which workerd may not set, and counts in per-isolate memory. So: `rateLimit: {enabled: true, storage: 'database', customRules}` for sign-in and sign-up, and `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']`. Only the loopback test-hook stack raises the limits; a staging smoke expects a 429. [better-auth `create-context.mjs`, `rate-limiter`]

**Fail closed.** The Worker refuses to serve if `BETTER_AUTH_SECRET` is missing, is the placeholder, or is under 32 characters. It also refuses if `MOSS_TEST_HOOKS=1` while `BETTER_AUTH_URL` is not loopback. [L§4.9 SEC-4]

**Principal resolution order:**
1. `Bearer mm_sk_…`: a sha256 lookup that ignores revoked keys. The result is an agent acting with its owner's access.
2. Any other bearer value, or a cookie: a session user. A request with a bearer is judged by it alone and never falls back to its cookie.
3. A share token alone (`?share=` or `x-moss-share`): an anonymous principal, capped at viewer. [S-gd §3.1]

**Sign-out.** The client posts JSON `{}`. The wrapper resolves the session first, lets better-auth delete it, then awaits `PrincipalDO.endSession` before responding. The client stops subscriptions synchronously on the gesture, through the single auth-state writer. [L§4.9; L§4.6 background work]

**No playground and no DEV_AUTH.** [R7] Test principals are minted by API sign-up with a same-origin `Origin` header, and only at `@example.invalid` addresses. The owner's account is unreachable by construction. [R8; L§4.20]

**Device page.** It uses moss button tokens. Tests cover claim-on-GET, approval by a different principal, deny-then-approve replay, and several sessions from one code. [L§4.9]

## 8. Access control and revocation

- **One roles module.** `packages/protocol/src/roles.ts` is copied from moss-collab: ROLES are viewer < commenter < suggester < editor < owner; `CAPABILITY_FLOORS` cover `{view, comment, suggest, edit, manage}`; `can()` checks them. Client affordances and server enforcement both import it, and an unknown role gets no actions. [L§4.10; L§1.3; S-prior §10]
- **One resolver** (`api/access.ts`).
  - `resolveDocAccess(principal, docId, token?)` takes the maximum of owner, the doc grant, folder-chain grants including the vault (depth ≤ 11), and the link role. The link role is a ceiling: anonymous visitors are capped at viewer, and signing in lifts them to the link role.
  - `accessibleDocs(principal)` feeds lists, search and backlinks.
  - `principalsWithAccess(docId)` is the inverse used for fan-out. [S-gd §5.1; L§4.10]
  - **Agents** act with their owner's access, and a direct grant to the agent adds to it by MAX, as in glyphdown's `computeDocRole`. Another person's agent can therefore hold a role on a doc its owner cannot open. [P:People; S-gd §5.3]
- **Capabilities.**
  - Commenter and above: comment, reply, react, resolve.
  - Suggester and above: suggest.
  - Editor and above: edit content and title, rename, duplicate, create in shared vaults (the row owner stays the vault owner and `created_by` records the creator), upload, take named versions, restore, accept and reject.
  - Owner only: trash and restore, moving notes and folders (a move changes who can open them), share, members, links, invites, vault actions.
  - The share UI offers viewer, commenter, editor and owner; suggester appears in M5. Its add field takes an email or an agent id (copied from the agent's row in its owner's Settings → Agents); agent rows are tagged "agent", as in glyphdown's ShareDialog. [P:People; S-gd §5.8; L§1.3]
- **Non-disclosure.** A missing, inaccessible, trashed, revoked-token or forged-token doc returns one byte-identical 404. The only exception is a 401 for a credential-less CLI, so it can prompt. Member emails are shown to the owner only. The owner's trash view and every owner GET of a trashed doc share one read path; mutations stay strict. [L§1.6; S-gd §5.1, §5.3; L§4.10 I-14]
- **Notifications** are re-checked against the live grant when read, and unreachable targets are omitted. [L§1.6 D-G6]
- **One kick path** (`api/fanout.ts`).
  - Covered events: member removal, role change (including upserts and invites), link revocation (every connection that presented the token, signed in or not), agent-key revocation, sign-out, and doc or folder moves and deletes.
  - **Recipients.** A doc grant or doc link reaches that doc's DO; a folder or vault grant or link reaches every live doc in the subtree (one folder-tree query); a session reaches the docs in the PrincipalDO's `doc_sockets`; an agent key reaches the agent's PrincipalDO registry. No registry of anonymous holders is needed, because each recipient closes every connection whose attachment carries the revoked token.
  - The revocation is persisted in each recipient DocDO through an awaited `recheck` (which wakes a hibernated DO) before the REST call returns. If a DO fails to acknowledge, the call fails with 503 so the owner can retry.
  - Durable revocations replace moss-collab's frame-hold queue, because a woken DO already knows. [S-prior §7.4; L§4.7; L§4.10]
  - A promotion takes effect on reload, as in glyphdown. [L§1.6]
- **Client handling of 4403.** The client asks the server over REST. A lower role rebinds read-only with a visible message, and the fresh doc's step 2 is inert, so the rebind never loops. No role is terminal `revoked`. [L§4.6]

## 9. The web electronAPI adapter (`apps/web/src/host/bridge/`)

**Shape.** Modeled on moss's own story bridge and installed as a complete object before App mounts. Every namespace and subscription exists (subscriptions return no-op unsubscribers), because `CanvasAreaContent` calls `agent.onStream` unconditionally. [S-ren §2, §0.9; S-prior §14] Timestamps are converted to seconds; folder ids map to `Notes/<a>/<b>` paths (the active vault is the root `Notes`) through a refreshed id↔path map. [S-ren §1.4]

**The inventory.** `bridge/inventory.ts` lists every method with its treatment: `real`, `stub`, `hidden` or `staged:<M>`. A staged method's backend lands in milestone M (folders and trash in M2; search, media upload and unfurl in M3), so until then it is minimally real or its entry points are hidden through the registry; no live control ever 404s. A unit test fails if `ElectronAPI` gains a method the inventory lacks, if a stub is unlisted, or if an entry is still staged after its milestone closed. [L§4.1 host UI found late; L§1.11]

| Namespace | Web treatment |
|---|---|
| `notes` | **Lists.** `getAll` and `getMetadataByIds` read the vault listing (§11), with the live `Y.Text` title overlaid for any bound doc. `getById` returns metadata plus local per-viewer extras, and `content:''` for any doc that will bind.<br>**Content.** `getContent` is the DO export behind a concurrency limit of 3, and it never repaints a bound editor. `create` POSTs a doc, and the DO seeds it. `getHeadings` and `getFrontmatterSuggestions` are REST.<br>**`update` routes by field.** `title`: a `Y.Text` write when bound, otherwise a REST rename request. `content`: always refused loudly. At the pin only duplicate (server-side here) and dev automation fixtures write content through the bridge, so the bridge has no path to the merge endpoint and cannot wipe a doc [L§4.6 D-F3]. `pinned`: `user_doc_prefs`. `layoutMetadata` and `collapsedHeadings`: localStorage. `stickyTabs` and frontmatter-meta fields: no-op.<br>**Lifecycle and links.** `delete`/`restore`: REST, returning only after the server acknowledges. `search`: SearchDO. `getFilesystemPath`: the doc URL. `copyLinkToClipboard`: text/plain plus moss's HTML payload.<br>**Events.** `setOpenFileWatchTargets` is a channel hint. `onDiskChange` comes from the workspace channel and is metadata-only. `onInternalFileOpen` comes from `popstate` and in-app navigation. `onMetadataReindexed` fires after a reconnect or vault switch. `onExternalFileOpen` and `onRequestFlush` never fire; `flushComplete` is a no-op.<br>**Export.** The PDF session methods use sessionStorage plus `window.open('/pdf-export…')`. `exportMarkdown` downloads the DO export. `showInFinder` is **hidden**. |
| `folders` | REST with the id↔path map: list, create, rename, `moveNotes`, `moveFolder`. `delete` moves the subtree to trash. `showInFinder` is **hidden**. |
| `agent` | `execute` rejects with "unavailable on web". `cancel` and `cancelByTabId` are no-ops. `onStream` is a no-op subscription that **must exist**. |
| `chat`, `checkpoints` | `[]`. These are not version history. |
| `files` | `search` and `listDirectory` return `[]`. `open` (the "Open…" item) is **hidden**. |
| `filesystem` | Stubs. `readFile` rejects; its surface is unreachable. |
| `grantedDirs` | `[]`. Connected Folders is **hidden**. |
| `externalNotes` | `false`, `[]` or `null`. The External section renders nothing. |
| `shell` | `revealPath` is **hidden**. |
| `appConfig` | Workspace Location, `setWorkspacePath` and `pickWorkspaceFolder` are **hidden**; the vault switcher replaces them. `restartApp` is a stub. |
| `images` | `save`: folder-scoped upload, editor and above. `pick`: `<input type=file>`, then upload. `persistUrl`: SSRF-safe fetch-and-store. `copyFromNoteAsset`: server copy. `copyFromPath` rejects. |
| `htmlPreview` | `ensure` returns `null`. The patched preview decision renders the live sandboxed iframe. |
| `webEmbedPreview` | `ensure` calls `POST /api/unfurl`. `subscribe` is a no-op. |
| `videoThumbnail` | Stub. `<video>` streams from R2 with Range requests. |
| `remoteWebSurface` | Left undefined. `RemoteWebSurface.tsx` is substituted with a sandboxed iframe [R4] |
| `system` | `createWindow` opens a browser tab (`/d/<id>`) [R4]. `getWindowContext` comes from the route. `setFocusedNoteId` calls `history.replaceState`. `waitForReady` resolves once the session and vault resolve. `showEmojiPanel` is **hidden** (`/emoji`). `getMediaServerInfo` returns `null`. Drags, global shortcuts and the native menu are no-ops, except that `setImageAltTextMenuEnabled` drives an "Edit Alt Text…" item in a moss-DS image context menu, which fires `onNativeMenuCommand('edit-image-alt-text')` into moss's existing editor (T3.1). |
| `update` | `onReady` never fires, so UpdateWidget never shows. |
| `analytics` | `capture` is a no-op, except that `feedback_submitted` writes a D1 `feedback` row. |
| `settings` | Theme uses localStorage `moss_theme`. Note intelligence uses `user_prefs`. The default-`.md`-editor setting is **hidden** (it returns `true` and the prompt counts as dismissed). |

**Hide registry** (`host/affordances.ts`). Each entry is `{id, site, reason, cite}`. Render sites read `hidden(id)`, and a drift test checks the list. [L§4.1; S-prior §14.2]
- **PRODUCT's named set** [P:Agents]: `share-with-agent`, `ai-run-action` (toolbar action and ⌘K prompt), `reveal-in-finder` (note, folder, trash), `open-directory`, `settings-workspace-location`, `settings-default-md-editor`, `settings-connected-folders`, `create-note-shortcut-label` (⌘N).
- **The same "cannot work on the web" rule:** `title-shortcut-label` (browsers reserve ⌘T) [S-ren §0.10], `emoji-panel` (no OS emoji API), and the in-app browser's `browser-back-forward` and `browser-find` (a cross-origin iframe exposes neither).
- **Unlisted** because they never render at the pin: quick capture, auto-update, open in default app, in-embed ⌘K capture. A test asserts that.
- **Kept with web behavior:** Open in New Window (a browser tab), Save as PDF (browser print), Save as Markdown (a download). [R4]

**Navigation** (`host/navigation.ts`) owns every programmatic navigation: route changes, sign-out, chunk reloads, invite and inbox links. Before navigating, it synchronously commits a refused or read-only input state. Mark-read requests use `keepalive`. [L§4.6 navigation mid-typing] Moss keeps its own back and forward history; the URL is updated with `replaceState`.

**New note** [R2]. "+ Note" calls `notes.create`, which POSTs `/api/docs`: the D1 row is written and `DocDO.create` seeds the doc. Moss awaits that round trip with focus still on the button (`createAndActivateNote`, `App.tsx:2842`), and binds took up to 2.7 s on a warm stack, so the seam first blurs the trigger synchronously and arms a document-level guard that consumes printable keys, Space, Enter and Backspace and announces "Opening note…" in the refusal band until a live field takes focus (until T1.4 that is the body; the notice is `[data-input-refusal]`, centered over the top bar until T1.3 builds the band). No keystroke vanishes, and Space or Enter cannot create a second note. App then activates the note with `focusTarget:'title'` (the pin focuses the body). The pane binds, the title opens at first sync, and the pending focus lands. This is deviation 1 in §23. [S-ren §0.1; L§4.4]

## 10. Collaboration binding

### 10.1 Doc session

**Provider.** Per pane per doc, `useDocBinding(docId)` creates a **fresh** Y.Doc on every mount, because neither official plugin variant reconciles a populated doc [S-ren §3.6], plus one hardened `YProvider(origin, docId, doc, {party:'doc-d-o', connect:false, disableBc:true, resyncInterval:4000, params:() => share ? {share} : {}})`. [S-prior §4.1–4.2; S-gd §12.7] Hardening broadcasts awareness on `update` with an origin filter (so tabs don't echo), makes `disconnect()` close with 1000, and registers the socket in a per-tab registry so sign-out severs it in-window.

**One socket per open doc.** Moss's `openSplitTabAtom` and `splitNavigateToNoteAtom` refuse to show the active note in the split pane, but `splitGoBackAtom`, `splitGoForwardAtom` and left-pane navigation do not (`atoms.ts:716–835`). A seam makes moss's rule total: those paths skip or close the split instead. The doc-session registry also refuses a second session for a doc already open in the tab. Sharing one Y.Doc between panes is not an option, because a second binding cannot reconcile a populated doc [S-ren §3.6]. Each pane gets its own `<LexicalCollaboration>`, so split view never shares a binding context. [L§4.3 split-view crash]

**Teardown order:** cursors, listeners, `setLocalState(null)`, disconnect (1000), `doc.destroy()`. [S-prior §3.1] A pane released while its edits are unacked (typed while the socket was down) would destroy the only copy, so the session leaves presence and stays connected without its pane until the DocDO acks them, then tears down in this order; the doc stays held meanwhile, and a pane reopening it binds once the edits are on the server (§10.6). [T0.P; P:Collab "neither ever loses work"]

### 10.2 The plugin: official V1 with four seams

`vendor/lexical-react/` holds `LexicalCollaborationPlugin.tsx` and `useYjsCollaboration.tsx` from @lexical/react 0.48.0. They are V1, with an `XmlText` root named `root`, and carry four marked seams, each forced by a requirement [R12; S-prior §3.3]:

- **(a) Undo.** The plugin uses `new UndoManager([root, registers], {trackedOrigins:{binding, REGISTER_LOCAL_ORIGIN}, captureTimeout:1000})`. The official `createUndoManager` also tracks `null` and uses 500 ms. [P:Collab undo; L§4.3]
- **(b) Origins.** A Lexical→Yjs update carrying a derived tag runs inside `doc.transact(…, DERIVED_ORIGIN)`. The Yjs→Lexical path skips both `binding` and `DERIVED_ORIGIN`. [L§4.3 derived fold-back]
- **(c) Awareness.** Identity, color and focus come from the presence layer. `username`, `cursorColor` and a memoized `awarenessData` are fixed at mount, because the provider effect depends on all three and any change reconnects. [S-prior §3.3; `useYjsCollaboration.tsx` `useProvider`]
- **(d) Cursors and teardown.** `useAwareness` calls `syncCursorPositions` directly and ignores `syncCursorPositionsFn`, so the label pass (§10.7) hooks the awareness update itself. The official teardown only disconnects; ours also destroys the doc and clears the doc map (§10.1 order).

V2 is rejected because its experimental `XmlElement` root is wire-incompatible. V1 fixes the Yjs schema permanently for the converter, the CLI merge and comment anchors. [S-ren §7.2] `HISTORIC_TAG` is never used to keep a write out of undo; a lint rule over vendor and host code enforces it (moss at the pin has no use). [L§4.3]

The plugin is passed as MarkdownEditor's `collaboration` prop in place of `<HistoryPlugin/>`, and moss's `UndoRedoPlugin` still dispatches undo and redo. [S-ren §3.7]

### 10.3 Seed, first sync, focus

**Before first sync.** The DocDO has seeded the doc and clients use `shouldBootstrap:false`. [L§4.3] The editor mounts with `editorState:null`, `editable:false` and no state cache, and the pane skeleton stays on top until the provider reports `sync(true)`.

**First-sync deadline.** If `sync(true)` has not arrived 8 s after the provider is created, the pane publishes `data-doc-state=retrying` and the banner says it is still connecting. Recovery needs no remount. [R10; L§4.6 57 s invitee open]

**At first sync, in one effect:** `editor.setEditable(canEdit && !terminal)`; open the title; apply the local layout (§10.9); publish `data-doc-state=live`, `data-body-binding=live` and `data-title-binding=live`; then run any pending focus (the title for a new note, the body otherwise). [R2; L§4.19 readiness]

**Closed fields.** Until then the title and body are non-focusable: no tabindex, `contenteditable=false`, `aria-disabled`. Nothing can be typed, so nothing can be swallowed. As defense in depth, one chokepoint refuses `beforeinput`, paste, drop and composition into any closed field and announces it in `[data-input-refusal]`, and a document-level guard consumes a bare Backspace while a bind is pending, so WebKit cannot navigate history. Keys typed while "+ Note" is creating are handled by the opening guard (§9). [P:Notes; L§4.4]

**Editability** is gated only on first sync and role; there is no editable fallback editor. [L§4.6 D-F3] Role and trash changes call `setEditable` and never change the composer key, so they never remount. [S-ren §0.6]

### 10.4 Title and frontmatter

`Y.Text('title')` is the only writer of the name. [R3] The binding lives in `host/collab/title-binding.ts`. [S-ren §4.4; S-prior §6]

- **When the field is open.** `bound ∧ synced ∧ canEdit ∧ ¬terminal ∧ bindingDocId === note.id`. It keys on binding identity, not liveness. [L§4.4]
- **Local writes.** `onInput`, paste, drop and the emoji typeahead all call `writeField(doc, 'title', domText)`. That writes a minimal LCS diff in one transaction under `TITLE_LOCAL_ORIGIN`.
- **Remote writes.** An observer renders `textContent` and remaps the caret from the `YTextEvent` delta. For bound docs, moss's focus-gated sync effect and post-hydration writes are deleted. A mid-edit title is never clobbered, because remote ops merge character by character. During an IME composition, remote ops merge into `Y.Text` at once but the repaint waits for `compositionend`, so the composition is never aborted. [P:Collab title]
- **Projection.** Every change, local or remote, sets `syncNoteEntityAtom` to `title.trim() || 'Untitled'`, so the sidebar, breadcrumb and tabs update locally. The bridge overlays the live title for bound docs. The DO projects the D1 title and filename (§5.1).
- **Trimming.** Only at projection. "Untitled" is never seeded as text. [L§4.4]
- **Undo.** Cmd+Z in the title uses a title-scoped `UndoManager` that tracks `TITLE_LOCAL_ORIGIN`. [P:Collab undo]

**Frontmatter (revised 2026-10-03 after T1.4 failed three checks on concurrent property edits).** Frontmatter is structured CRDT data, not text: `Y.Map('frontmatter')` maps each property key to its value (one entry per key, last writer wins per key), with a `Y.Array('frontmatterOrder')` of keys for display and export order. A per-key text diff over one YAML `Y.Text` could not be made safe: two people adding the same key, or deleting a key while another edits it, merged into corrupted YAML that renamed or dropped neighbouring properties. With a map, concurrent edits to different keys never interact, concurrent edits to one key converge to one value, and a delete removes only that key. Properties and `FrontmatterHeader` keep writing `noteFrontmatterAtom`; the host maps each change to map writes under `FRONTMATTER_LOCAL_ORIGIN`, and the observer parses remote changes back, except for the key being edited (no clobber). YAML is produced only at the serialization boundary (export, CLI pull, the converter), from the map in `frontmatterOrder` order; an import or a moss-format file seeds the map once. Byte-identical round trips of an untouched non-canonical YAML block are no longer promised; the export is canonical YAML of the same keys and values (recorded as a deviation). [P:Tech; P:Collab no-clobber; L§7.1 #5 "fix the sourcing"]

`packages/core/doc-fields.ts` provides read, write and observe for both fields. The LCS diff has a 4M-cell budget, falling back to lines and then to a coarse replace. [S-prior §6.1]

### 10.5 Connection truth and close codes

**Heartbeat.** The provider's 4 s `resyncInterval` keeps frames flowing; `channel-heartbeat` checks `wsLastMessageReceived` every 1 s. If an OPEN socket stays silent for more than 12 s, the client closes it with 4408, detaches it without waiting for its `close` event (a half-open socket may never deliver one), and reconnects. A half-open socket is therefore detected within 13 s, matching L§7.3's "about 13 s". [L§4.6; S-prior §4.3]

**Indicator and banner.** A `connection-truth` reducer combines provider status and heartbeat verdicts; it never consults `navigator.onLine`. It drives `data-connection` on a persistent connection indicator in the top-bar collab slot (glyphdown's ConnectionPill) and the DS Banner, which sits in a reserved notice band under the top bar (z-index below opened surfaces). The same band shows input refusals, so a refusal is always visible. Edits keep buffering in the bound Y.Doc and resync on reconnect. [P:Collab; L§4.1 phone shell; glyphdown `DocEditorPage`]

**Handshake failures.** After 3 consecutive handshakes that fail before opening, the client stops and asks REST; a 404 goes terminal `unavailable`. A designed refusal is never retried on a ladder. [L§4.6]

**Hibernation.** Heartbeats pause while `document.hidden` and stop on `pagehide`, so DOs can hibernate. [S-test §6.5]

**Close codes,** defined once in `packages/protocol`. Unicast events use the `__YPS:` envelope so the provider delivers them. [L§4.6; L§4.3; S-prior §20]

| Code | Meaning | Client response |
|---|---|---|
| 1000 | Normal close, or socket superseded | none |
| 1001, 1006, 1011, 1012, 1013, 4408, 4420 | Transient (4408 is the client's heartbeat timeout; 4420 ends a connection over the write rate) | reconnect with backoff, keeping the Y.Doc; banner |
| 4401 | No principal | terminal `session-ended`, then the login route |
| 4402 | Session ended | terminal `session-ended` |
| 4403 | Access revoked or lowered | REST re-ask, then a read-only rebind or terminal `revoked` |
| 4404 | Doc unavailable: missing, no access, forged or revoked link (§4.1) | terminal `unavailable`; the DenialPage on next load |
| 4409 | Write refused; the reason arrives in the unicast just before | discard the local Y.Doc, rebind fresh, announce the refusal; in suggest mode, offer back the unacked text first (docs/design/suggestions.md §5.2) |
| 4410 | Doc deleted | terminal `deleted` |
| 4429 | Connection limit | terminal `conn-limit`, with a retry action |

### 10.6 Terminal states and durability honesty

**Terminal store.** `host/collab/terminal.ts` is a doc-level `useSyncExternalStore` store keyed by docId, with reasons `deleted`, `revoked`, `session-ended`, `unavailable` and `conn-limit`. A terminal close sets `provider.shouldConnect=false` synchronously inside the close handler, before y-partyserver can schedule a reconnect. Every editable surface (title, body, frontmatter, comment composer, decorator controls) subscribes and goes inert in place, and `data-terminal-reason` is published on the pane. [L§4.6; S-prior §3.4]

**Before a destructive action** (trash or sign-out), the client closes the doc to writes and waits for `data-sync-unacked=0`, at most 5 s; past that, a ConfirmationDialog says some edits have not synced, with Cancel as the default. That attribute is driven by the DO's acks (§5.1). Copy-link never vouches for bytes while unacked. [L§4.6 C-12]

### 10.7 Presence, colors, cursors

[P:Collab; L§4.5; S-prior §4.4–4.5]

**Each client is a user.** PRODUCT counts every client as a user, including the same person's second window. Presence is therefore keyed by awareness client id, never de-duplicated by account. [P:Collab; L§1.4; L§4.5 dedupe lesson]

**Awareness lifecycle.** The local state is `user = {principalId, name, color, colorSettled, isAgent}`. It is republished every 4 s, preserving anchor and focus; the heartbeat pauses while hidden and re-announces on becoming visible. A client sweep every 2 s removes states older than 12 s, because y-partyserver disables Yjs's own 30 s check, so hard drops clear in 8–14 s. Teardown and `pagehide` call `setLocalState(null)` and `removeAwarenessStates`. A tab hidden for more than 12 s therefore leaves other people's piles and returns within about 1 s of becoming visible; that is what lets an idle doc hibernate (confirmed with the owner at the M0 hand-off).

**Server validation.** The DocDO checks every awareness frame: each client id must belong to the connection, and `user.principalId`, `name` and `isAgent` must equal the connection state, or the frame is dropped. [S-gd §2.10.8] A REST push adds a server-side `isAgent` awareness entry for 15 s. [S-gd §7.5]

**Colors.** A 10-slot palette built from moss DS tokens, each fill with initials ink at contrast ≥ 4.5:1. An FNV hash only seeds the choice; a claim is provisional for 500 ms, then settles. Settled beats provisional, and ties break by UTF-16 `<`, never `localeCompare`. One color per client, remembered in the tab's sessionStorage; hidden tabs never re-claim. Chips and carets read one getter. [L§4.5]

**Face pile.** DS `FacePile` and `AvatarChip` are portaled into the top-bar slot at the start of the right control group, never over the canvas. Zero chips when no other client is present; one per other client, with one principal's chips adjacent; 3 plus "+N" when space runs out; and a Bot badge for agents. [P:Collab; L§1.3; L§1.9]

**Cursors.** The official cursor rendering draws into a pointer-transparent overlay, mounted as a sibling of the editor root through `cursorsContainerRef`. A coalesced decoration pass adds the name label, shown while the peer types and for about 1.5 s after, plus the Bot glyph. Carets and selections use the chip color. [S-prior §4.5; P:Collab]

### 10.8 Undo

The body uses seam (a) and the title its own `UndoManager`. Server-origin writes (seed, push, restore, accept/reject, the comment and suggestion maps) never enter a client manager. History clears on note switch because it lives in the per-mount Y.Doc. Meta+Z from an empty command-palette prompt is routed to the note's `UNDO_COMMAND`. [P:Collab; L§4.3; L§1.4]

### 10.9 Wire exclusions and per-viewer layout

**Exclusions.** A type-aware `excludedProperties` map, shared by the client and the DocDO, falls back from the constructor to `getType()` and throws on an unregistered type. [S-prior §5] It excludes `tab-group.__activeIndex`, `tab-group.__tabWidths`, `table.__colWidths` and `file-link.__resolutionState`, plus the register-owned fields (§10.10). It does **not** exclude `formula.__name`, `__result` or `__formulaId`: they are content at this pin, and excluding them would export `undefined` (this corrects L§4.3 and S-test §3.8). [S-conv §4.1–4.2] Frame scans verify the list, with `__type`, `__result` and `__name` as positive controls. [L§4.3]

**Per-viewer layout** (table widths, tab widths, collapsed headings, active tab) persists in localStorage through `host/collab/layout-local.ts`, which reuses moss's ordinal collect and apply functions. It is applied only after first sync, from ordinal identities rather than Lexical keys captured before hydration (the A-39 family). [R11; S-ren §0.11; L§3 pattern 4]

### 10.10 Background writers, transient styles, decorator payloads

- **Background writers** (ColorCodeConversion, CodeNodeNormalization, ChecklistSort, FileLink resolution, MathCalculation) skip updates tagged `COLLABORATION_TAG`, never run without edit rights, and run no initial sweep on a bound doc (ColorCodeConversion's sweep runs even read-only at the pin); the server importer normalizes instead. Two editors opening one doc can then never rewrite the same text twice (the "WORDWORD" family). [S-conv §4.5; L§4.3]
- **Per-viewer overlays, not tree writes.** Executable formula results, stale flags and file-link resolution are computed per viewer. The DocDO recomputes formula results when it exports. [S-conv §4.3 option 1]
- **Transient `__style` markers.** `--link-selection` (T0.P: `::highlight(link-selection)`) and the formula draft chip move to CSS Custom Highlights or decorations. `--context-selection` stays unreachable while the AI action is hidden. [S-conv §4.4]
- **Decorator payloads use registers.** @lexical/yjs stores node properties as whole-value attributes that merge last-writer-wins, which loses one side of concurrent edits. Each such payload lives instead in `Y.Map('registers')` under a stable `__regId`, minted at creation and deterministically on import (Lexical keys differ across clients):
  - `Y.Text` for `code-block.__code`, `html-block.__rawHtml` and `formula.__formula` (T1.9), written through the title binding's minimal-diff and caret-remap code;
  - per-key `Y.Map`s for `chart.__config` and the sketch grid and labels (T3.3).

  Register fields join the exclusions. The getter and setter seams sit in the extracted node classes, and views get the register through a host wrapper registered in `node-views.ts`. The converter reads through the getters, so export is unchanged. Registers are in the client undo scope (§10.2), the DocDO mirror, the CLI merge and suggester vetting. `callout.__level` and the code language stay whole-value, since each is a single choice. If SP8 shows a payload cannot take a register, the owner gets the data loss stated plainly before anything ships. [P:Collab "neither ever loses work"; L§4.3; S-conv §4.6]

## 11. Workspace metadata and vaults

**Metadata for docs that aren't bound** comes over REST plus push:
- `GET /api/workspace?vault=` returns the active vault's accessible docs and folders, the surfaced shared items (below), and the owner's trashed docs for the Trash view, mapped to `NoteMetadataRecord`.
- Every change (create, rename or filename, move, trash, restore, share, `updated_at`) runs `fanout.publishMeta(docIds)`. That calls `PrincipalDO.publish` for each id in `principalsWithAccess`.
- The tab's channel then calls `notes.onDiskChange(ids, [])`, metadata-only. A bound id never appears in `contentNoteIds`. Moss refetches `getMetadataByIds`. [S-ren §2.1; L§4.4]

There is no polling and no per-doc watch socket. [S-prior §14.1] Bound docs ignore `updatedAt` entirely: no init refetch and no remount. [S-ren §3.5] Background content reads, such as the MathCalculation fan-out, pass through the 3-request limiter. [L§4.1 remounts mid-typing]

**Vaults and discovery** [P:Notes; L§1.11 a capability with no UI; glyphdown `fileTree.ts`, `useActiveVault.ts`]. A vault is moss's root `Notes`, and the sidebar lists the active vault.
- **Shared items surface at the root.** A doc or folder shared directly with the caller, whose parent the caller cannot see, is listed at the root of whichever vault is active (glyphdown's never-lose-a-node rule). A person therefore finds what was shared with them without a URL or a bell. These rows offer no move, drag or folder-create actions, and the id↔path map gives them collision-free path segments. There is still no synthetic "Shared" folder. [L§4.10 FOLDER-CREATE-WEB]
- **The active vault** follows the URL when the caller can see the doc's vault. Otherwise it stays the persisted choice (Home by default), with the doc at its root. An explicit switch wins until the next navigation.
- **The vault switcher,** glyphdown's rebuilt in the moss DS, sits in the notes-panel header row (empty on the web; the macOS drag region on desktop). It lists owned vaults, then vaults with a root grant badged with the role. Switching ships in M1, "Share vault…" in M2, and inline "New vault", rename and the owner-only trash in M3. Members see no vault actions. [S-ren §1.3]
- **The bell** sits in the top-bar collab slot with Share, the connection indicator and the face pile, as L§1.3 records, so it stays visible when the notes panel is collapsed. [L§1.3 nothing floats]

## 12. One converter

[P:Tech; L§4.16; S-conv]

**The split** is generated by extraction (§2.1); function bodies stay byte-identical to upstream.
- New pure modules: `editor/markdown/{text-style, transformers, normalize, pipeline}.ts` and `editor/commands.ts`.
- Eight decorators (Chart, CodeBlock, EmbedPill, HtmlBlockquote, Image, Sketch, Video, WebEmbed) split into `X.ts` and `X.view.tsx`. `decorate()` returns `renderNodeView(type, props)` from `nodes/node-views.ts`, which only the client fills. Every view is wrapped in its own error boundary with a placeholder. [L§4.2 throwing decorator]
- `MarkdownEditor.tsx` re-exports the old names. [S-conv §2.3]

**Same code on both sides.** `pipeline.ts` exports `$importNoteBody(md, {comments?, layout?})` and `$exportNoteBody()`. Client paste and import, the DocDO and the CLI path all call them with the same `MARKDOWN_EDITOR_NODES` and the same 45-entry `MARKDOWN_EDITOR_TRANSFORMERS`, whose order tests pin. [S-conv §1.2]

**File shape.** A `.md` file is the frontmatter block (canonical YAML from the `frontmatter` map, §10.4) followed by the body.
- The title is the doc's name, carried by the filename projection, and is never written into the body.
- Import never lifts an H1 into the title, so both of moss's H1 rules are bypassed.
- A doc created from a file takes its title from the file stem. [R3; P:Notes "H1 is content"; S-gd §7.5]
- **Moss interchange** is a separate, explicit path (migrating a moss vault in, or exporting for moss). Moss saves the title as a leading `# Title` line and strips it on import, so this path maps that line to and from `Y.Text('title')` and carries the comments sidecar. The default import and export never lift or write a title line. [S-ren §0.2]

**Fixes and runtime rules.**
- Formulas get deterministic ids on import, so the client, the DO and the CLI agree. [S-conv B9]
- Moss's silent line loss on rejected IMAGE and TABLE lines is fixed by returning `false`. This is a deviation with a regression fixture. [S-conv §1.2; P:Tech]
- The converter closure uses `@lexical/code-core`. A one-line `prism-global-install` precedes any code-prism import in a server entry. [S-conv B4; L§4.1]
- Server bindings pass a no-op `syncCursorPositionsFn` and register no mutation listeners. [S-conv B8]

**Gates** (remote CI). [S-conv §5]
- L1: per-family fixtures in Node without a DOM (goldens and a fixpoint).
- L2: a workerd import smoke plus 2 MB CPU timing.
- L3: parity against moss's pristine pipeline at the pin.
- L4: replication A → Y.Doc → B → server export, plus a wire scan.
- L5: journeys G1–G3.
- Plus the negative controls in S-conv §5.6.

## 13. Comments and suggestions as CRDT data (sketch; the design review is T4.0 and T5.0)

[P:Meaning; P:Tech; L§4.11–4.12; S-conv §3; S-gd §6.1–6.2]

### Comments

- **Data.** `Y.Map('comments')` maps id → `{text` (moss's mention encoding), `author` (server principal id), `createdAt`/`updatedAt` (seconds at the moss boundary), `source, parentId, imageUrls, resolvedAt, resolvedBy`, `reactions {emoji → principalIds}`, `anchor {start, end` (base64 RelativePositions), `quote {exact, prefix, suffix}, hint, status anchored|orphaned}}`.
- **Only the DocDO writes the map.**
  - Clients call REST (later also socket custom messages). The DO checks role ≥ commenter, takes authorship from the server principal, writes through `serverWrite` under a server origin, and returns the root author so the Worker can write notifications.
  - Commenters never get CRDT write access. Client frames that touch `comments` or `suggestions` are refused; SP7 is the classifier. [S-gd §12 option a]
- **Anchors** are RelativePositions into the V1 paragraph `XmlText`, where a decorator counts as one embed. Clients mint them from their binding. Re-anchoring uses glyphdown's thresholds: 0.5, 0.8, and an 8-character minimum. [S-conv §3.2; S-gd §6.1]
- **Paint is derived, with zero tree mutation:** CSS Custom Highlight ranges plus per-comment geometry for the gutter and popover.
  - An adapter answers moss's 8 tree queries.
  - `CREATE_COMMENT_COMMAND` is the single write seam.
  - No MarkNode or `__commentIds` ever enters the synced tree, so typing after a comment cannot lose keystrokes. [L§4.3 B24]
- **Converter.** On import, `%%m:` markers plus the sidecar become anchors. Export is clean by construction. An optional moss interchange export (markers plus `comments.json`) supports migration back.

### Suggestions

Designed in [docs/design/suggestions.md](design/suggestions.md) (T5.0), which wins where this summary is shorter. [S-gd §6.2; L§4.12]

- **Records.** `Y.Map('suggestions')` maps id → `{author, status open|accepted|rejected|withdrawn, parts, moved}`, written only by the DO. An `insert` part is a set of Yjs item ids the author created, item by item, carried to the copies when any writer splits or reformats that text; `delete` and `format` parts carry a comment `TreeAnchor`; `attr`, `indent`, `join` and `replace` parts name a block or register. `moved` lists original text the author's splits moved. There is no baseline.
- **Live suggest mode** is a toggle in moss's floating toolbar; a role-locked suggester sees a "Suggesting" chip instead. [L§1.3] Additive edits (typing, paste, Enter anywhere, new list items, rows and decorators) enter the tree and are registered as insert parts in the same transaction that applies them. Deleting, formatting or changing original content never touches the tree: the client sends a proposal part, painted as an overlay. Title and properties are read-only in suggest mode.
- **Vetting** decodes each suggest-mode frame against the live doc before it applies, by item identity, never by re-diffing text, and judges exactly what Yjs would integrate (no gaps, no parked structs, only the principal's own Yjs client ids): inserts anywhere in the body pass; deletes pass only on the author's own items and attribute writes only on their own containers; a frame that moves original text (a split) is proven on a mirror and its copy stays original; everything else is refused with `write-refused('suggest')` and 4409. Ownership is judged on the record changes the client has acknowledged. The client runs the same rules in `afterTransaction` before sending, closes to input and rebinds; text a server-only refusal discards is offered back. [L§4.12 DEF-1, false 4403s]
- **Structural ops are parts** (SP11): checkbox, block type and alignment are `attr` parts, list indent an `indent` part, Backspace at a block start a `join` part, a row or column delete a `delete` part, an original decorator payload edit a `replace` part. None is refused.
- **Review UI.** A Suggestions button beside moss's `CommentsMenuButton` lists glyphdown's suggestion cards in the moss DS, and the painted suggestion opens the same card, each with Accept and Reject (editor and above) or Withdraw (the author). Moss's ActionsPanel stays the inert agent panel. [P:Agents; P intro]
- **Lifecycle.** Accept, reject and withdraw are one `serverWrite` that applies each part with Lexical's own operations on the mirror, behind the quote ≥ 0.8 drift guard; outdated parts are reported, never applied. Orphaned suggestions are auto-rejected. Live suggestions notify the doc's owner, not just pushed ones. Export is the working text, with no markers.

## 14. History

[P:Meaning; L§4.13; S-gd §6.3]

- **Storage.** A DocDO table `versions(id, kind auto|named|restore-point, name, created_at, author_ids, title, frontmatter, markdown, lexical_json | r2_key)`. Payloads over 1.5 MB spill to R2.
- **Triggers:**
  - the last disconnect, when the doc changed;
  - every push;
  - activity: 500 updates or 10 minutes since the last auto version, checked in `onSave`;
  - a named version on request, rate-limited;
  - a restore point before each restore and an auto version after.
- **Restore is an edit.** It runs `serverWrite` with an identity-preserving two-tier reconcile from the version's Lexical JSON. That is moss-collab's `tree-markdown` reconcile, re-derived on 0.48 (SP12).
  - Title and frontmatter restore by minimal diffs.
  - The result's export is verified against the target; on a mismatch the restore is refused with 409.
  - Anchors and concurrent peer inserts survive. Clients cannot undo a restore. [S-prior §8.3; L§4.13]
- **UI.** Moss has no history surface at the pin: `TimelinePopoutModal` is the agent action-timeline modal (`tab: ActionTabEntry`), and only `VersionHistoryEmptyState` exists. The History view is glyphdown's history page (`d.$docId.history.tsx`) rebuilt in the moss DS, opened from a History control inline in the top bar and occupying the editor pane, never floating. This corrects L§4.13's "port TimelinePopoutModal".
  - A version list with auto, named and restore-point badges.
  - View renders the version in an unbound read-only MarkdownEditor; Diff vs current uses glyphdown's diff library.
  - Restore asks through moss's ConfirmationDialog.
  - `VersionHistoryEmptyState`, from which a first named checkpoint can be saved.
  - A failed fetch shows an error, never an empty state. [L§4.13; L§1.3 honest states]

## 15. Search and links

- `notes.search` (including `searchTrashed`) and the FileLink typeahead call `GET /api/search`, which filters by `accessibleDocs` and can scope to a vault.
- Backlinks come from `GET /api/docs/:id/backlinks` and render in `LinksSection`.
- `[[X]]` resolves within the vault against the normalized title, then the filename stem. Unresolved links show the unresolved state. `getHeadings` comes from the DO export.

[R3; S-gd §6.4; L§1.3]

## 16. Assets, HTML, embeds

[P:Notes media; L§4.15; S-gd §6.5]

**Upload.** `POST /api/folders/:id/assets?filename=` takes a raw body and requires editor or above.
- Storage is content-addressed (`asset-blobs/sha256/<hash>`) with refcounts and versions. A name collision gets `-2`.
- Allowed types are exactly png, jpg, jpeg, gif, webp, svg, mp4, webm and mov. Anything else gets 415.
- Caps: 10 MB for images and 95 MB for video, through the Worker (SP9).

**References.**
- Markdown keeps moss's relative form, `![alt](assets/<file>)`.
- The substituted `asset-url.ts` maps that to `/api/docs/:docId/assets/<file>`, resolved in the doc's folder scope, with the share token appended.
- A copied note carries its media. [S-ren §2.5]

**Serving.**
- The current version is `private, max-age=0, stale-while-revalidate=86400` with ETag/304. A specific version is immutable.
- HTTP Range (206) serves video.
- SVG gets `content-security-policy: sandbox` and `nosniff`. [L§4.15; L§4.17]

**HTML and embeds.**
- **HTML blocks** render live in a `data:` iframe with `sandbox="allow-scripts"`, which gives them an opaque origin.
- **Web embeds and pills** call `POST /api/unfurl`: SSRF-safe, oEmbed or OpenGraph, cached, throttled with 429.
- **The in-app browser** is a sandboxed iframe, with "open in new tab" as the fallback for sites that refuse framing.
- **YouTube** embeds by URL.
- **Pasting a remote image** runs an SSRF-safe fetch-and-store.

[R4; P:Notes; S-ren §0.13, §2.6]

## 17. CLI and daemon

[P:Agents; R9; S-gd §7; L§4.16]

**Package.** `packages/cli` builds the binary `moss-multi`, never `moss` (`~/.local/bin/moss` is moss desktop's launcher). It is glyphdown's command surface:
- login (device flow or `--key`), logout;
- list, vaults, cat (raw bytes, no trailing newline), new, add, url;
- mv (a title write);
- rm (trash; prints "moved to Trash — you can restore it for 30 days" and `{action:'trashed', restorable:true, retentionDays:30}`);
- clone, pull, push `[--suggest] [--force]`, sync `[--json]`;
- history, snapshot, comments, comment, suggestions, share.

Configuration lives in `~/.config/moss-multi/config.json` (mode 0600) and `MOSS_MULTI_API_KEY` / `MOSS_MULTI_SERVER`. Each workspace keeps `.moss-multi/<docId>/{meta.json, base.md}`. Exit codes: 0 clean, 1 other, 2 failed hunks, 3 degenerate. Doc references take an id, a URL or a unique title prefix (H-19); `url` prints `/d/<id>`, which opens the doc itself, not an empty workspace (H-10). [L§1.8; L§4.10]

**Push.** `POST /api/docs/:id/push {newText, baseHash, baseText?, suggest?}`:
1. Take a PrincipalDO rate token.
2. `DocDO.push` looks up the base (409 `base-missing` if absent) and runs glyphdown's pure three-way `computeMergedTarget`.
3. Refuse degenerate pushes (empty, or deleting more than 60% of the doc) whether or not the doc drifted, unless `--force`. A whole-doc wipe never lands through a fast path. [L§4.6 D-F3]
4. Land through the identity-preserving reconcile in one `serverWrite`. Untouched blocks keep their Yjs identity, and changed text nodes are diffed character by character.
5. Check the size cap on the simulated result (§5.1) and return failed hunks.

CRLF becomes LF at the boundary. [P:Tech; S-prior §8.2–8.3]

**Sync** follows glyphdown's tracked-file classification.
- An untracked `.md` becomes a new doc titled from its file stem, and the local file is renamed to the filename projection.
- Server filename changes rename local files.
- Deletes never propagate. [R9]

**Daemon.** `moss-multi watch [dir]` runs the same loop on debounced filesystem events and a 60 s idle tick. It respects `retry-after`, uses REST only, and holds no sockets. [R9; S-gd §7.5]

**Attribution.** Pushes carry the agent principal as their origin, and the DocDO adds Bot-badged presence. [P:Agents]

## 18. Security defaults

- **Secrets.** Fail closed on a weak or missing secret. Test hooks are refused on non-loopback origins. `.dev.vars` never ships, and secrets are set with `wrangler secret put`. [L§4.9; L§4.17]
- **OAuth.** Providers are registered and rendered only when configured; none are. [P:People]
- **Trust boundary.** Client `x-moss-*` and `x-partykit-*` headers are stripped by prefix. Only the `doc-d-o` party is reachable. Internal DO calls are RPC. [S-gd §1.3; S-prior §7.6]
- **Cross-origin cookies.** The browser attaches the session cookie to every request for the host, and a same-site page (another port on 127.0.0.1, a sibling subdomain) gets past SameSite=Lax. One gate (`worker/origin-gate.ts`): when the principal came from a cookie, a socket upgrade (`/parties`, `/api/workspace/ws`) or an unsafe `/api/*` method must carry Origin equal to `BETTER_AUTH_URL`'s, else REST gets 403 and the socket closes 4401 after the upgrade, before any doc lookup. Bearer tokens, agent keys and a share token alone are never ambient and pass; reads are not gated. better-auth checks `/api/auth/*` itself. [T0.12]
- **Disclosure.** The 404 for missing, inaccessible, trashed, revoked or forged docs is byte-identical, and member emails go to owners only. [L§1.6; S-gd §5.3]
- **Share tokens** are threaded through every doc, asset, list, metadata and socket path. The link role is a ceiling, and anonymous access is capped at viewer. [L§4.10]
- **Revocation** goes through one kick path, persisted in the DocDO before the request returns. Sign-out severs every socket of the session. [§8; L§4.9]
- **Refusals are loud:** a unicast reason, then a close code, and the client resyncs. The ingress gate is role-aware. [P:Tech]
- **Limits:** 2 MB of markdown per doc through one state-size metric (§5.1), 50 connections per doc, 300 writes per 5 s per connection (overflow closes 4420 and discards nothing), 8 KB of awareness, 60 pushes per minute per identity, invites 20 per hour per inviter, and better-auth's sign-in and sign-up limits (§7). [P:Tech; S-gd §5.3]
- **Awareness identity** is stamped and validated by the server, so the Bot badge and chips cannot be spoofed. [S-gd §2.10.8]
- **SSRF** (unfurl, remote images): manual redirects re-checked on every hop (at most 5), A/AAAA vetting through DoH, private, loopback, link-local, CGNAT, ULA and obfuscated IPv4 addresses rejected, HTTPS only, fail closed, 429 throttle. [L§4.17]
- **User HTML** runs only in opaque-origin sandboxed iframes, never with `allow-same-origin` on `srcdoc` or `data:`. SVG is served with a sandbox CSP and HTML assets don't exist. [L§4.17; S-gd §6.6]
- **Agent keys** are stored as sha256 hashes. Revoking a key closes its sockets. [L§1.6 D-G7]
- **Sign-out** posts a JSON `{}` body, and polling and subscriptions stop synchronously. [L§4.9; L§4.6]
- **Transient backend failures** degrade in place and never bounce a signed-in user to `/login`. [R10]
- **Test data** uses `@example.invalid` principals only; the owner's account is never touched. [R8; L§4.20]

## 19. DOM contract and test hooks

**The DOM contract.** These attributes ship in production builds, because the deployed build strips automation globals. Names and value unions live in one module, `packages/protocol/src/dom-contract.ts`, imported by the product, by `e2e/lib` and by the QA prelude. A rename breaks typecheck instead of a run. [L§4.19; L§4.20; S-test §3.4]

| Attribute | On | Values and rule |
|---|---|---|
| `meta[name=moss-build]`, `html[data-client-build]` | head, html | `commit:hash`; must equal `/api/version` on every navigation |
| `data-app-state` | html | `booting`, `ready`, `degraded` (ruling 10) |
| `data-editor-pane` + `data-doc-id` | each pane root | the doc id |
| `data-doc-state` | pane | `binding`, `retrying` (first-sync deadline passed), `live`, `offline`, `terminal`. `live` only after first sync **and** an editable root, set in one effect |
| `data-title-binding`, `data-body-binding` | title field, body root | `unbound`, `live`, `readonly`, `terminal`. While not `live`, the element is non-focusable |
| `data-editor-generation` | body root | +1 on every Lexical editor creation (remount detector) |
| `data-sync-unacked` | pane | `0` or `1` (§10.6) |
| `data-notice-band` | reserved band below each pane’s top bar | connection and input-refusal notices |
| `data-connection-banner` | connection notice | `offline`, `retrying`, `halted`, or the terminal reason |
| `data-connection` | connection indicator | `online`, `reconnecting`, `offline` |
| `data-terminal-reason` | pane | `deleted`, `revoked`, `session-ended`, `unavailable`, `conn-limit` (S-test's `suggest-policy` is not terminal; it is a 4409 resync) |
| `data-role` | pane | the effective role |
| `data-presence-pile` > `data-presence-chip[data-client-id][data-principal-id][data-presence-color][data-self]` | top bar | zero chips when no other client is present |
| `data-remote-caret`, `data-remote-selection`, `data-remote-label` (each with `data-principal-id`) | cursor overlay | one color getter for chips and carets |
| `data-collab-chrome` | every web-added control | must sit inside `[data-top-bar]` or the notes-panel header |
| `data-editor-canvas` | scrollable editor region | target of the floating-chrome detector |
| `data-overlay-surface` | DS menu, dialog, popover and sheet primitives (vendor seam), and the phone notes overlay | the detector's allowlist |
| `data-input-refusal` | the single refusal announcer, a visible live region in the reserved notice band | the refusal text |
| `data-sidebar-row` + `data-doc-id` + `data-active` | notes-list rows | |

**Test hooks.** Two hooks exist, and only when all four conditions hold: `MOSS_TEST_HOOKS=1`, a loopback request origin, a loopback `BETTER_AUTH_URL`, and an `x-moss-test-hook` header equal to the per-run secret. Otherwise they return the unknown-route 404.
- `GET /__test/docs/:id/instance` calls `probeInstance`.
- `POST /__test/docs/:id/reset` calls `ctx.abort()`.

Content is never seeded through hooks. [S-test §3.7; R7] Hooks never exist on staging, so the owner-only `GET /api/docs/:id/instance` returns the same probe in every environment; wake can then be proven on real Cloudflare (SP14). It reads nothing from the doc.

## 20. Verification architecture

S-test is the detailed design of record, but where it disagrees with this file or BUILDPLAN, they win. Known corrections: the frame scan's forbidden keys are §10.9's list (S-test §3.8's `__result`, `__stale` and `__name` would fail a correct build), and `__result` and `__name` are positive controls; `data-terminal-reason` values are §19's, held in `dom-contract.ts`; journey milestones follow BUILDPLAN.

- **CI, on ubuntu.**
  - `plan` decides the lanes.
  - `checks`: typecheck, lint (including the `HISTORIC_TAG` ban), unit tests, converter L1–L4, schema DDL, vendor drift and re-extraction, the dependency rule, Tailwind coverage, and `trace.mjs` (every BUILDPLAN trace row has a tagged leg by its milestone). A checks-only dispatch lane takes about 5 min.
  - `build`: one vite build with provenance.
  - `e2e[chromium, webkit]`: run under `wrangler dev --local` on those exact bytes, sharded by journey group with one stack per shard. `@slow` legs (60 s holds, soaks, idles) run at milestone gates and nightly.
  - `oracle` and `parity`, then `ci-ok`.
  - Separately: a `red-proof` dispatch, which overlays `packages/protocol/src/dom-contract.ts` with `e2e/` so tests naming new readiness attributes compile on the base, plus a nightly soak and calibration. [S-test §2; R6]
- **Budget.** Task iterations dispatch Chromium-only grep runs; checkers reuse the implementer's green run for the same head SHA and dispatch only WebKit and changed timing legs; the full suite in both engines runs at milestone gates. BUILDPLAN Spending holds the per-task numbers.
- **One living Playwright suite** (`e2e/journeys/jNN-*.spec.ts`).
  - It checks 9 global invariants on every actor of every test, and selftest fixtures prove each detector can fail.
  - Every journey uses at least 2 distinct per-run principals, and user actions go through the UI only.
  - Real severs use `routeWebSocket` and SIGSTOP. Hibernation is induced and then proven by an instance-id change. [S-test §3; L§7.1 #11–13]
- **Local work.** `scripts/stack.mjs` is the same launcher CI uses. It allows at most 5 stacks machine-wide (`MOSS_MAX_STACKS` overrides), reaps orphans, refuses translated Node, and records host state (a bb dev stack or Nightly running, load) with each run so local deaths are classed as infrastructure. `scripts/qa.mjs` drives bb Browser Automation (local headless Chrome for Testing) with per-principal contexts and 2× PNGs. The checker's pass is a change's one browser QA pass. No tests ever run locally. [S-test §4; owner rule; L§5.1]
- **Parity.**
  - The Ladle oracle is built in CI from moss@pin, with the `main.tsx` Prism and font preamble added. The shell stories are `app--default` and `app--empty-notes`; with no deploy key (OA1) it is built from `moss-vendor.mjs pristine` (§22). Capturing it on CI's ubuntu Chromium changes L§1.1's owner-gated capture baseline, so it is put to the owner at the M0 hand-off.
  - A target passes with a pixel diff of at most 0.05%, a largest blob of at most 16 px², and the diff image read.
  - Targets grow with each milestone to every moss surface a seam changes and a story covers: the shell (M0), the top bar with peers present and the new note (M1), the trash view (M2), Settings (M3), the comment gutter and popover (M4). Only the web chrome's own rects are masked, never the whole slot, so displaced moss chrome still fails.
  - Node families use computed-style parity against an oracle-only Ladle story that renders the family corpus in pristine moss's MarkdownEditor, built in CI. No moss desktop is launched. [S-test §5; L§4.19]
- **Surfaces moss lacks** (login, share dialog, presence, connection pill and banner, bell, vault switcher, history, suggestions) are judged against glyphdown@faf98d0 rendered with moss styling. T0.11 captures 2× light and dark reference shots once; each such task's checker reads a glyphdown | ours | neighbouring-moss triptych, and the critic gets the reference index. [L§1.1 visual bar; L§1.11 gameable gates; L§5.2]

## 21. Deploy (canary from M1, full suite at M8)

- **Target.** Staging only, on the owner's personal Cloudflare account; run `wrangler whoami` first. A canary deploy runs at M1 exit and every milestone after, because only staging surfaced era 2's unstyled build, OAuth 500 and stale chunks. [R15; L§5.4; L§3 era 2]
- **Permanent names**, never renamed, because DO storage is bound to the Worker name: Worker `moss-multi-staging`, D1 `moss-multi-staging`, R2 `moss-multi-staging-assets`. DO migration `v1 new_sqlite_classes: [DocDO, PrincipalDO, SearchDO]`.
- **Build.** `env.staging` in `wrangler.jsonc`; build with `CLOUDFLARE_ENV=staging`, because a bare build bakes in the wrong bindings. [L§4.18]
- **Workflow.** `deploy-staging` deploys the exact `dist` the suite tested, then asserts that staging `/api/version.bundleHash` matches. Test hooks must return 404 on staging. Production stays undecided.
- **Test data.** A fixed pool of `@example.invalid` principals and docs is reused across runs, with a request budget per run, because soft-deleted DOs never reclaim storage. [L§4.7; L§8 Q12] [S-test §2.11]

## 22. Spikes and open items

| Id | Question | Task | Default if it fails |
|---|---|---|---|
| SP1 | Do React 19.3.0, Start 1.168.32, Vite 8.1.5, plugin-react 6.0.2 and Tailwind 3 build the vendored renderer, with moss aliases resolving in the client environment? | T0.3, T0.5a | Use `enforce:'pre'` resolve transforms. If Start rejects 19.3, pin React 19.2.8 after a moss typecheck, and record that in METHOD.md. |
| SP2 | Does the extracted converter load and run in workerd? Measure Worker upload size, cold start, peak heap (a 128 MB isolate holds the live doc, the mirror and a headless tree) and CPU at 2 MB, and the worst state-to-markdown ratio `r` that sets `STATE_CAP` (§5.1). | T0.6 | Fix the import graph, never twin nodes. If CPU or heap exceeds budget, move export off the request path (cached per state) and release the mirror after each `serverWrite`. |
| SP3 | Does the V1 binding round-trip through a real DocDO over a real WebSocket: seed, sync, edit, restart, reopen? | T0.7, T0.8 | Diagnose with instrumentation. The fresh-doc-per-mount rule stays. |
| SP4 | What is workerd's idle-eviction time? Do sockets survive `ctx.abort()`? | T1.7 | `IDLE_MS = max(95 s, 1.2 × measured)`. Fail loudly above 150 s. |
| SP5 | At 0.48, does two-tab concurrent typing cascade (#343 or markdown-shortcut follow-ups)? Does a pane rerender reconnect? (StrictMode double effects don't run in production builds; unstable provider-effect dependencies do.) | T0.8, T1.6 | Add a tagged-update latch in the vendored plugin only if proven; pin the effect dependencies in seam (c). |
| SP6 | What does per-frame awareness validation cost in the DocDO? | T1.5 | Validate only identity changes; cache the per-client verdict. |
| SP7 | Can an update be classified by the root types it touches without applying it (comment and suggestion map write protection)? | T4.0 | Apply to the mirror doc and read `changedParentTypes`. |
| SP8 | Registers for decorator payloads: a stable `__regId`, the host view wrapper, the undo scope, converter getters, and later the CLI merge and vetting. | T1.9, T3.3 | No pre-booked loss. If a payload cannot take a register, ask the owner with the data loss stated plainly. |
| SP9 | Can video upload through the Worker under the body limit, with R2 Range reads? | T3.1 | Presigned R2 upload with a server-side finalize. |
| SP10 | Comment paint: the CSS Custom Highlight API in WebKit, and geometry for moss's gutter and popover. | T4.0 | A pointer-transparent overlay with stable per-comment elements. |
| SP11 | Suggester vetting on a mirror for tree deltas, with structural ops (checkbox, table row, list indent) as suggestion parts. **Answered (T5.0): vetting decodes frames by item identity, clipped to what Yjs integrates, with a mirror only for splits and identity carry; the client runs the same vetter in afterTransaction; every structural op has a part (docs/design/suggestions.md §3–§5).** | T5.0 | Ask the owner with options before refusing any structural op in suggest mode. |
| SP12 | Port the identity-preserving reconcile to 0.48: restore, then push. | T6.1 | Block-level landing with verify-or-refuse (409), never a silent rebuild. |
| SP13 | Does a `data:` iframe inherit the page CSP in Chromium and WebKit, blocking moss-html scripts? **Yes in Chromium (T0.5a), so the default applies: `/frame/html`.** | T0.5a | Serve HTML blocks from a dedicated route whose response carries `content-security-policy: sandbox allow-scripts`, still opaque-origin. |
| SP14 | How does hibernation behave on real Cloudflare (about 10 s idle with hibernatable sockets, wakes re-sending step 1, per-wake state rebuild)? | T1.10 | Treat every staging difference from workerd as a product defect in the wake path; keep j04's staging legs in the canary. |
| SP15 | Does Linux WebKit navigate history on a bare Backspace, so the j02 leg can fail on the CI engine? | T0.9a | Run that leg on a macOS runner at milestone gates. |
| OA1 | **Owner action.** A read-only deploy key on brsbl/moss, so CI can build the Ladle oracle. | T0.5a | Build the oracle from vendored pristine files plus moss's stories and `.ladle` (moss-vendor `pristine`), with a non-frozen install recorded. |
| OA2 | **Owner action, before T0.1.** An Actions budget for this private repo of about 3,000 billable minutes a month (BUILDPLAN Spending). | T0.1 | None. Without it, work pauses and is reported; gates are never silently degraded. |
| OA3 | **Owner action, before T1.10.** A Cloudflare API token for Actions; R2 enabled once in the dashboard (error 10042); one "Allow" click for `wrangler login`. Expect an 8-minute first TLS certificate. | T1.10 | The canary waits; local legs continue. [L§5.4] |

## 23. Deviations at start (registry: docs/DEVIATIONS.md)

| # | Deviation from moss@pin | Authority |
|---|---|---|
| 1 | "+ Note" focuses the title after bind; the pin focuses the body | R2 |
| 2 | The title is a CRDT name projected to the filename. The H1 is body content; import never lifts it, and `.md` has no title line | R3; P:Notes |
| 3 | Hidden native-only affordances (§9 registry) | P:Agents |
| 4 | ⌘N and ⌘T chips and `/emoji` hidden; browsers reserve the shortcuts and there is no emoji API | P:Agents ("cannot work → hidden") |
| 5 | Image alt text is edited from a web image context menu instead of the native Edit menu | P:Notes "web-adapted equivalents" |
| 6 | Per-viewer layout lives in localStorage; tab-width resize is no longer undoable | R11; owner confirmation at M0 hand-off |
| 7 | New Window opens a tab; PDF uses browser print; the in-app browser is a sandboxed iframe whose back, forward and find are hidden (§9) | R4 |
| 8 | Converter line-loss fix (rejected image and table lines no longer vanish) | P:Tech "never silently discarded"; owner confirmation at M0 hand-off |
| 9 | Formula recompute and wiki-link resolution are per-viewer overlays, not synced writes | P:Collab; S-conv §4.3; owner confirmation at M0 hand-off |
| 10 | The floating toolbar hides while the editor is unfocused (T1.6); the sidebar Trash button accepts a dropped note (T2.3) | L§1.3 (owner, 07-29) |
| 11 | Below 640 px the notes panel overlays the canvas and the chrome row yields in order | P:Viewports Tier A; L§1.9 |
| 12 | Split navigation never shows one doc in both panes (moss's own rule, made total) | P:Collab one binding per doc; §10.1; owner confirmation at M0 hand-off |

A new deviation needs an owner ruling; rows marked "owner confirmation" were made under delegation and go to the owner in one batched list at the M0 hand-off. [L§1.3 ruling 13]

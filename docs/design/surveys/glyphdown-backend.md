# Survey: glyphdown's backend, as the architecture moss-multi follows "as-is"

Source: glyphdown at `faf98d0` (`/Users/brsbl/Code/moss-multi/.refs/glyphdown`). Unless a path says otherwise, every path below is relative to that checkout. Upstream library behavior was read from the published bytes of `y-partyserver@2.2.0` (`dist/server/index.js`, `dist/provider/index.js`) and `partyserver@0.5.6` (`dist/index.js`) on unpkg, because glyphdown ships no `node_modules`. Surveyed 2026-10-02 for the moss-multi architecture.

## 0. Summary

**What to take as-is.** Most of glyphdown carries over nearly verbatim:

- The single Worker: TanStack Start, then `/api/*`, then `/parties/*`, then SSR.
- better-auth per request on D1/drizzle, plus the device flow, the bearer plugin, and hashed agent keys.
- The D1 schema shape: folders, vaults, docs, members, share links, invites, notifications, assets with content-addressed versions.
- The role resolver.
- The DocDO persistence model: one Yjs update per SQLite row, compaction by replay into chunked state, replay in `onLoad`.
- Lifecycle close codes and the admin fan-out endpoints.
- The base cache and push rate limiter.
- SearchDO (FTS5 plus wiki-link index).
- The CLI sync engine and its exit codes.
- The CI and deploy workflow shape.

**What must change because the record is a Lexical tree.** Glyphdown's doc is one `Y.Text('content')`, and every server-side operation reads `ytext.toString()` or edits it through text diffs. Moss-multi's doc is `doc.get('root', Y.XmlText)` (the `@lexical/yjs` tree) plus `Y.Text('title')`, `Y.Text('frontmatter')`, and the comment and suggestion maps. Each of these has to be replaced:

- every `toString()` read becomes a call to the one shared Lexical markdown exporter, run headless in the DO;
- the push merge becomes a structural tree merge;
- suggester vetting moves from `Y.Text` deltas to `XmlText`/`Y.Map` events;
- anchors become tree-aware;
- restore becomes identity-preserving on the tree;
- the binary `isReadOnly` gate becomes a type-aware ingress gate.

**What glyphdown does not do that PRODUCT.md requires.** Following glyphdown "as-is" does not cover these:

- email and password sign-in;
- demotion, sign-out, and agent-key revocation reaching live sockets;
- the 50-connection cap and the 2 MB cap on live edits;
- trash listing and folder-subtree trash;
- video assets with Range serving;
- editor-level creation inside a shared vault;
- the title as a CRDT;
- comments and suggestions stored as CRDT data;
- a staging environment and `/api/version`;
- an e2e suite.

Each gap is listed under its area below and collected in §11.

| Area | Port nearly verbatim | Must change (Lexical tree or PRODUCT) |
|---|---|---|
| 1. Worker and app | `server.ts` routing order, `createServerEntry`, per-request auth, `cloudflare:workers` env, vite plugin set, client-only editor import | Moss SPA mounted client-only; Tailwind 3 instead of 4; `/api/version`; party allowlist and header stripping; staging env; no `/login` bounce on transient errors |
| 2. DocDO | Update log, chunked compaction, `onLoad` replay, base cache, push limiter, admin endpoints, JSON events | Tree types and seed; headless converter in the DO; type-aware write gate with loud refusal; tree suggester vetting; size and connection caps; revocation paths; awareness identity stamping; title and `updated_at` projections to D1; tree push merge; tree-native versions and restore |
| 3. Auth | `createAuth(env)`, drizzle adapter, device flow, bearer, sha256 agent keys, principal resolution | Email and password enabled; social providers only when configured; fail-closed secret; session-to-socket kill on sign-out; renamed client id and key prefix |
| 4. D1 | Nearly every table and index; drizzle-kit plus `wrangler d1 migrations apply` | Fresh squashed init; title and filename as DO-written projections; `folders.deleted_at`; trash indexes; video assets; no legacy doc-scoped assets; migrations applied in tests |
| 5. Sharing | Roles, grant inheritance, share links, invites with copy-link degradation, notifications polling, vault model and switcher | Demotion, link, and key kicks; editors creating inside shared vaults; folder delete moves the subtree to trash; trash list; no emails leaked to link viewers |
| 6. Content services | Anchor math (thresholds), SearchDO, asset storage and versioning model | Comments and suggestions in the CRDT; tree anchors; exporter-fed search; video and Range; SVG sandboxing; no HtmlDocDO |
| 7. CLI | Commands, base tracking, three-way sync classification, exit codes, device login | Structural merge server-side; raw `cat`; renamed binary and dirs; title-to-filename mapping; folder-watch daemon |
| 8. CI and deploy | ci, deploy, and release workflow shape | Staging-only env names; Playwright journeys against real workerd in CI; build provenance |
| 9. Tests | vitest 4, fast-check, better-sqlite3 router tests, pure DO helpers | Real migrations in tests; DO harness; real-workerd legs; no local test runs |

---

## 1. Web app framework and Worker entry

### 1.1 What glyphdown does

- **Framework.** TanStack Start (`@tanstack/react-start` specifier `~1.168.0`, resolved 1.168.24) with React 19.2.7, file-based TanStack Router (`apps/web/src/routes/*`, generated `apps/web/src/routeTree.gen.ts`), and TanStack Query 5.101 for client data. `apps/web/src/router.tsx` builds the router with `scrollRestoration: true`, `defaultPreload: 'intent'`, and `defaultPreloadStaleTime: 0`.
- **Vite config** (`apps/web/vite.config.ts`):
  - The plugins, in order: `devtools()`, `kyselyMigrationExportsFix()` (a local transform that rewrites better-auth 1.6.14's kysely-adapter import of `DEFAULT_MIGRATION_*` from `kysely/migration`, needed because kysely 0.29 moved those exports), `cloudflare({ viteEnvironment: { name: 'ssr' } })`, `tailwindcss()` (Tailwind 4), `tanstackStart()`, and `viteReact()`.
  - `resolve.tsconfigPaths: true`.
  - The SSR `optimizeDeps.exclude` list is `better-auth`, `better-auth/adapters/drizzle`, `better-auth/tanstack-start`, and `yjs`. Excluding `yjs` prevents the "Yjs was already imported" duplicate. `y-partyserver` must stay optimized, because its CJS dependency `lodash.debounce` cannot load unbundled in workerd.
- **Worker entry** (`apps/web/src/server.ts`; `wrangler.jsonc` has `"main": "src/server.ts"`):
  - It exports `createServerEntry({ fetch })` from `@tanstack/react-start/server-entry`, with `createStartHandler(defaultStreamHandler)` for streaming SSR.
  - It re-exports the DO classes: `export { DocDO, HtmlDocDO, SearchDO } from '@glyphdown/sync'` (line 17).
  - Routing order, in `fetch`:
    1. `/api/auth/*` goes to `createAuth(asAppEnv(env)).handler(request)` (lines 29–31). The instance is built per request because D1 bindings are per invocation.
    2. `/api/*` goes to `handleApi(request)` (`apps/web/src/api/router.ts:106`). It returns `null` for paths it does not own, so those fall through to Start.
    3. `/parties/*` (lines 43–50) runs `authenticate(request, docId = pathname.split('/')[3])`. It returns 401 when that fails. Otherwise it forwards `new Request(request, { headers: trustedHeaders(auth, request.headers) })` to `routePartykitRequest(forwarded, env)`. That copies every client header, including `Upgrade` and `Sec-WebSocket-*`, and then overwrites `x-glyphdown-principal` and `x-glyphdown-role`.
    4. Everything else goes to `startFetch(request)`, which handles SSR and server functions.
  - A `try/catch` reports Worker errors to PostHog through `waitUntil` and rethrows.
- **Bindings.** Code reads them through `import { env, waitUntil } from 'cloudflare:workers'` and never threads them as parameters. `AppEnv` (`apps/web/src/env.ts`) declares:
  - the bindings `DB` (D1), `ASSETS` (R2), `DocDO`, `HtmlDocDO`, and `SearchDO`;
  - the optional secrets `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_*`, `GOOGLE_*`, `RESEND_API_KEY`, `EMAIL_FROM`, `POSTHOG_KEY`, and `POSTHOG_HOST`.
- **WebSockets.** The URL convention is `/parties/doc-d-o/<docId>?_pk=<connectionId>&share=<token>`. partyserver kebab-cases the binding name `DocDO` into `doc-d-o` (`camelCaseToKebabCase` in partyserver). The client calls `new YProvider(window.location.origin, docId, ydoc, { party: 'doc-d-o', params: { share } })` (`apps/web/src/components/editor/DocEditorPage.tsx:367`). SearchDO and HtmlDocDO are unreachable through `/parties` only by accident: `authenticate()` treats the room as a doc id, finds no doc, and returns 401. No explicit allowlist exists.
- **SSR and auth gate** (`apps/web/src/routes/__root.tsx`):
  - The root route uses `shellComponent: RootDocument`: html/head/body, an inline theme-init script, `<HeadContent/>`, `<Scripts/>`, a `QueryClientProvider` (staleTime 5 s, retry 1), `AppErrorBoundary`, and the chunk-reload handler (`apps/web/src/lib/chunkReload.ts` reloads on `vite:preloadError`).
  - `beforeLoad` calls the only server function in the app, `getServerSession` (`apps/web/src/lib/session.ts`: `createServerFn({ method: 'GET' })`, with dynamic imports so worker-only modules stay out of the client graph). Signed-out visitors redirect to `/login?next=…`. The exceptions are `/login`, any `?share=` URL (which skips the session lookup entirely), `/`, and `/invite/*`.
  - A thrown session lookup (a D1 error) goes to the error boundary. It is never retried.
- **Editor is client-only.** `apps/web/src/routes/d.$docId.index.tsx` dynamic-imports `DocEditorPage` in an effect and SSR renders `EditorShellSkeleton`. It is deliberately not keyed by `docId`.
- **Routes:** `/`, `/login`, `/device`, `/settings` (agents and API keys), `/admin`, `/about`, `/d/$docId`, `/d/$docId/history`, `/f/$folderId` (folder or vault share landing), `/f/$folderId_/file/$filename` (standalone HTML viewer), and `/invite/$token`.
- **Data access.** All app data is REST under `/api/*`, through `apps/web/src/lib/api.ts`. That wrapper sends the share token as the `x-glyphdown-share` header. The only TanStack server function is the session read.
- **Static assets.** `public/` plus the vite client build. Glyphdown's `wrangler.jsonc` has no `assets` block; the Cloudflare vite plugin emits the assets configuration into the build output (`dist/server/wrangler.json`), and `wrangler deploy` follows the generated redirect config. Verify on the first moss-multi build.

### 1.2 Port nearly verbatim

- `server.ts` structure and ordering, `createServerEntry`, the per-request `createAuth`, the `cloudflare:workers` env pattern, and the DO re-exports.
- The vite plugin set, minus Tailwind 4 and devtools; keep the SSR `optimizeDeps.exclude` list and `resolve.dedupe`.
- The `shellComponent` root, the `createServerFn` session read, the client-only dynamic import of the editor, the chunk-reload handler, and TanStack Query.
- The REST wrapper pattern in `lib/api.ts`, with the share token as both header and query parameter.

### 1.3 Must change

- **Add `GET /api/version`** (`{commit, bundleHash, buildTime, env}`, `no-store`) as the first route, per LEARNINGS §7.1 #19.
- **Allowlist the party namespace and strip client headers.** Accept only `doc-d-o` at `/parties/*` and 404 every other namespace explicitly.
  - Strip every client-supplied `x-moss-*` and `x-partykit-*` header before setting the trusted ones. Glyphdown copies all client headers.
  - partyserver forwards a client `x-partykit-props` header into `onStart(props)` (partyserver `fetch`: `if (props) this.#_props = JSON.parse(props)`). It is harmless today and should still be stripped.
- **The UI is moss, not glyphdown.** Moss's renderer is a client SPA (jotai 2.20, @base-ui/react 1.6.0, Tailwind 3.4.19, React 19.3 at pin `762abb777`, `.refs/moss/packages/desktop/package.json`).
  - Keep Start for the HTML shell, the auth and landing routes, and the share landing. Mount the ported moss App client-only, the way glyphdown mounts its editor.
  - Use Tailwind 3 through PostCSS, not `@tailwindcss/vite` 4. Mixing majors breaks moss's class set, and the content globs must cover every ported file (LEARNINGS §4.18).
  - Glyphdown's `FileTreeShell`, `Header`, `QuickSwitcher`, `FileTree`, and `ui.tsx` are design references only, for the surfaces moss lacks.
- **Degrade transient failures in place** (restart ruling 10). The root `beforeLoad` must tell "no session" (redirect) apart from "lookup failed" (retrying in place, never `/login`).
- **Remove what PRODUCT does not need:** PostHog (`analytics*.ts`, ratified no-op RP-5), the admin and feedback routes, and the landing and about pages.
- **Add a staging environment** and build it with `CLOUDFLARE_ENV=staging` (§8).

---

## 2. DocDO (`packages/sync`)

### 2.1 Class and storage

`packages/sync/src/do.ts` defines `class DocDO extends YServer<SyncEnv>` with `static override options = { hibernate: true }`. It is SQLite-backed through the wrangler migration `v1 new_sqlite_classes: ["DocDO"]`. Its tables, created in `ensureTables()` at `do.ts:185`:

| Table | Columns | Purpose |
|---|---|---|
| `yupdates` | `seq INTEGER PK AUTOINCREMENT, data BLOB` | One row per Yjs update, the crash buffer since the last compaction |
| `ystate` | `idx INTEGER PK, data BLOB` | Compacted `encodeStateAsUpdate`, chunked at 1.5 MB (`STATE_CHUNK_BYTES`), under the 2 MB DO-SQLite row cap |
| `bases` | `hash PK, text, created_at` | Pulled-base cache for CLI pushes; 14-day TTL (`BASE_TTL_MS`) |
| `pushes` | `identity, ts` (indexed) | Sliding-window push rate limit |
| `comments` | `id PK, data JSON, created_at` | Comment threads (sidecar, not CRDT) |
| `suggestions` | `id PK, data JSON, status, created_at` | Suggestion records (sidecar) |
| `versions` | `id PK, name, kind, text, state_vector BLOB, author_ids JSON, created_at` | Snapshots: full markdown text plus state vector |

### 2.2 Persistence, hibernation, and compaction

The sequence is verified against the code and the y-partyserver and partyserver bytes:

1. partyserver runs `onStart()` inside `ctx.blockConcurrencyWhile` before it delivers any `fetch`, `webSocketMessage`, or `webSocketClose` (partyserver `#ensureInitialized`). A DO woken by a frame therefore finishes replay before it processes that frame.
2. `YServer.onStart` awaits `onLoad()`. It then registers (a) a doc `update` handler that broadcasts to every connection, (b) the awareness `update` handler, and (c) a debounced `onSave` (`debounceWait` 2000 ms, `maxWait` 10000 ms). Finally it sends `SyncStep1` to every surviving connection, which is the post-wake resync.
3. `DocDO.onLoad` (`do.ts:151`):
   - It applies the concatenated `ystate` chunks, then every `yupdates` row in `seq` order, all with origin `'persistence'`.
   - It registers `document.on('update')`: `INSERT INTO yupdates` (skipping origin `'persistence'`), then `maybeCompact()`. That function runs `COUNT(*)`/`SUM(LENGTH)` on every update and compacts above 500 rows or 1 MB.
   - It registers `ytext.observe(enforceSuggesterPolicy)`.
4. `onSave` (debounced) calls `compact()` and `feedSearchIndex()`. Compaction therefore happens within about 2–10 s of activity, and `yupdates` is a short crash buffer rather than a history.
5. `compact()` (`do.ts:209`) runs `encodeStateAsUpdate(this.document)` and then, in one `transactionSync`, deletes `ystate`, inserts the chunks, and deletes `yupdates`. y-partyserver's `WSSharedDoc` hardcodes `gc: true`, so deleted content is purged, but item IDs survive, so RelativePositions stay valid. Compaction never rebuilds from text.
6. Never wired: the R2 spill that SPEC §3.3 mentions, and any "markdown plus state vector cache".

### 2.3 Connections, roles, and per-frame checks

- **`onConnect`** (`do.ts:225`) parses the trusted headers `x-glyphdown-principal` (JSON `Principal`) and `x-glyphdown-role`. It closes with **4401** when no principal is present, then calls `connection.setState({ principal, role })`. partyserver persists connection state as the WebSocket attachment (`serializeAttachment`), so the role survives hibernation. y-partyserver merges its own `__ypsAwarenessIds` into the same state object.
- **`isReadOnly(conn)`** is `role < suggester` (`do.ts:236`). y-partyserver's `readSyncMessage` then silently ignores `SyncStep2` and `Update` from viewers and commenters, answers `SyncStep1`, sends no reply, and never closes. The client keeps its optimistic local state.
- **No per-frame authorization against D1.** The role is captured once at upgrade. The only per-frame logic is `isReadOnly` plus the suggester guard. Revocation is push-based, through two owner-gated internal endpoints the Worker calls:
  - `POST /admin/recheck {principalIds}` closes matching connections with **4403** `access-revoked` (`do.ts:473`).
  - `POST /admin/doc-deleted` broadcasts `{t:'doc-deleted'}` and closes every connection with **4410** (`do.ts:458`).
  - **Who calls them** (`apps/web/src/api/router.ts`):
    - member DELETE on a doc or folder;
    - share-link revoke, which kicks **only `'anonymous'`**;
    - doc and folder moves (old ancestor-chain grantees plus anonymous);
    - folder delete, vault delete, and doc delete.
  - **Who never calls them:**
    - role changes through `POST /members` (an upsert) or invites, so a demotion never bites a live socket;
    - agent-key revoke (`DELETE /api/agents/:id`);
    - sign-out or session revocation;
    - signed-in users riding a revoked link.
  - All calls are best-effort through `docAdminCall`, which logs and swallows failures.
- **Close codes used:** 4401, 4403 (`access-revoked`, `suggestion-policy-violation`), and 4410. There is no 4402 (session ended), 4408 (heartbeat), or 4429 (connection cap). The client (`DocEditorPage.tsx:527`) handles only the `doc-deleted` event. A 4403 just makes `YProvider` reconnect with backoff.

### 2.4 Suggester vetting (`checkSuggesterDelta`)

- `onMessage` (`do.ts:256`): for a suggester's binary sync frame (first byte 0), glyphdown snapshots `suggesterGuard = { connection, preText: ytext.toString(), ownRanges: ownOpenInsertRanges(ytext, openSuggestions, principalId) }` around `super.onMessage`. y-partyserver applies the update synchronously with `transactionOrigin = connection`.
- `enforceSuggesterPolicy` (`do.ts:283`), on the Y.Text observer, when `txn.origin === guard.connection`, runs `checkSuggesterDelta(event.delta, ownRanges)` (`packages/sync/src/enforce.ts`):
  - any `attributes` fails with `formatting-not-allowed`;
  - a non-string insert fails with `non-text-insert`;
  - a delete not wholly inside the merged own-insert ranges fails with `delete-outside-own-insert`;
  - text inserts are always allowed, because a new suggested insert is registered by the `suggestion-upsert` message that follows on the same socket.
- **On violation:**
  1. `invertDelta(delta, preText)` is applied in a `'server-enforce'` transaction. Yjs queues it after the current transaction.
  2. `revalidateAfterRewrite`.
  3. `close(4403, 'suggestion-policy-violation')`.
- **The violation lands and is broadcast before the revert.** The violating update is persisted to `yupdates` and broadcast to peers, then reverted by a second update. That fails PRODUCT's "a violating edit never lands". The client keeps its optimistic violating state and re-sends it on reconnect, which is the DEF-1 loop in LEARNINGS §4.12.
- **`suggestion-upsert`** (`onCustomMessage`, `do.ts:318`) requires:
  - role ≥ suggester;
  - `authorId === principal.id`;
  - status `open|withdrawn`;
  - any existing record must be the caller's own and still open.

  The DO persists the record and broadcasts `{t:'suggestion'}` to everyone but the sender. Part anchors are not validated.

### 2.5 Presence and awareness

All of this is y-partyserver behavior:

- **No server-side peer timeout.** `WSSharedDoc` calls `clearInterval(awareness._checkInterval)`.
- **Awareness frames** are applied with `origin = connection` and then rebroadcast **raw to every connection, including the sender**, with no size or content check. A connection's awareness client IDs are tracked in its state (`__ypsAwarenessIds`) and removed in `onClose` through `removeAwarenessStates`.
- **After a hibernation wake**, `this.document` is a new `WSSharedDoc` with an empty awareness map, even though the sockets are alive. Nobody re-announces until their local state changes, because `YProvider` broadcasts on awareness `change`, not `update`. LEARNINGS §4.5 documents the "newcomer sees nobody after ~80 s idle" defect this causes.
- **`onConnect`** sends the newcomer the current awareness states.
- **The glyphdown client**:
  - sets `awareness.user = {name, color, colorLight, isAgent}`, with a color hashed from the principal id into an 8-color palette (`apps/web/src/lib/presence.ts`, `DocEditorPage.tsx:373`);
  - nulls its state on `visibilitychange` (hidden) and `beforeunload`.

  The server never validates the `user` fields, so a client can spoof `name` or `isAgent`.

### 2.6 Limits

| Limit | Glyphdown | PRODUCT |
|---|---|---|
| Doc size | `MAX_DOC_BYTES = 2 MiB`, checked only as `newText.length` (UTF-16 units) on `/push`, returning 413 `too-large`. Live WS updates are unbounded. | 2 MB per doc on every path (frames and push) |
| Connections | None; SPEC says ≤ 50 but it is not implemented | 50 per doc |
| Push rate | 60 per minute per identity, sliding window (`ratelimit.ts`, `decidePushWindow`; denied attempts are recorded too). Stored in each DocDO's own `pushes` table, so it is effectively **per doc per identity**. Returns 429 with `retry-after`. | 60 pushes per minute per identity |
| Invites | 20 per hour per inviter (`invites.ts`) | n/a |
| Assets | 10 MB (`MAX_ASSET_BYTES`) | n/a (video needs more) |
| Platform | 2 MB per DO-SQLite row; 32,768 hibernatable sockets per DO; about 1k messages/s per object (`docs/research.md`, sync area) | |

### 2.7 Internal REST surface

The Worker calls the DO with `stub.fetch('https://do/<path>')` and trusted headers (`do.ts:349`; mirrored in `packages/protocol/src/index.ts`):

| Route | Role | Notes |
|---|---|---|
| `GET /content?view=working\|clean` | any | `text/markdown`. `x-glyphdown-base-hash` is the sha256 of the text; working text is remembered in `bases`. `x-glyphdown-version` is the latest version id. |
| `POST /push` | ≥ suggester | `{newText, baseHash, baseText?, suggest?, note?, force?}`. Returns 409 `base-missing`, 409 `degenerate`, 413, or 429. |
| `GET/POST /comments`, `POST /comments/:id/{replies,resolve,reactions,reattach}` | read any; write ≥ commenter | Replies return the root author in `x-glyphdown-comment-author` so the Worker can notify |
| `GET /suggestions`, `POST /suggestions/:id/accept` | accept ≥ editor | Accept runs the drift guard (quote similarity ≥ 0.8) and reports `outdatedParts` |
| `POST /suggestions/:id/reject` | ≥ editor, or the author ≥ suggester (withdraw) | |
| `GET/POST /versions`, `GET /versions/:id`, `POST /versions/:id/restore` | write ≥ editor | |
| `POST /admin/doc-deleted`, `POST /admin/recheck` | owner header | Lifecycle |

### 2.8 Snapshots and search feed

- `createVersion` stores the full text, `encodeStateVector`, and the author ids. Every version is broadcast (`{t:'version'}`) and re-indexed.
- **When snapshots are taken:**
  - an `auto` snapshot when the last connection closes and the text changed (`onClose`, `do.ts:306`);
  - `ensureAutoVersion` on every push;
  - a `restore-point` before a restore and an `auto` after it.

  SPEC §7's "≥ 500 updates or 10 min" trigger, the spill to R2, and pruning are not implemented.
- `feedSearchIndex()` (`do.ts:709`) runs fire-and-forget after `onSave` and after every version. It sends `POST SearchDO /index {docId: this.name, title: null, body: ytext.toString()}` through `getServerByName(env.SearchDO, 'global')`.

### 2.9 Port nearly verbatim

- The persistence design: per-update rows; compaction by replay into a chunked state blob inside `transactionSync`; `onLoad` replay under a `'persistence'` origin that the logger skips; and `onSave` triggering compaction. Moss-collab kept this design (`.refs/moss-collab/packages/sync/src/persistence.ts`).
- The table DDL pattern and the `ensureTables()` idempotency.
- The trusted-header identity model and the 4401 on a missing principal.
- `connection.setState({principal, role})` as the hibernation-safe connection identity.
- The internal REST routing table, `json()`/`readJson()`, and `isSyncMessage()`.
- The `/admin/doc-deleted` and `/admin/recheck` endpoints and the 4403 and 4410 codes.
- JSON events via `broadcastCustomMessage`; y-partyserver adds the `__YPS:` envelope automatically.
- The base cache (`rememberBase`, `lookupBase`, 14-day TTL) and the push flow shape (`base-missing`, then the client resends `baseText` with its hash verified).
- `decidePushWindow`, a pure helper (re-scoped per §2.10 item 6).
- The last-disconnect auto-snapshot, `ensureAutoVersion` on push, and the restore-point bracketing.
- The `suggestion-upsert` ownership and status validation, applied to CRDT records (§6).

### 2.10 Must change (Lexical tree and PRODUCT)

1. **Shared types and seed.**
   - The record is `doc.get('root', Y.XmlText)`, the `@lexical/yjs` root. Next to it sit `Y.Text('title')`, `Y.Text('frontmatter')`, and the comment and suggestion maps (§6). Every `this.ytext` in `do.ts` must be re-pointed.
   - Glyphdown never seeds an empty `Y.Text`. Moss-multi's DO must seed one empty paragraph on first load (origin `server-seed`) and seed the title once from D1. That lets clients run `CollaborationPlugin` with `shouldBootstrap: false` and render only after the first sync (LEARNINGS §4.3, restart rulings 2 and 12).
2. **One converter inside the DO.** Every `ytext.toString()` call site becomes a markdown export of the tree through headless Lexical. The call sites are `handleGetContent`, `handlePush`, `createVersion`, `snapshotIfChanged`, `latestVersion` comparisons, `feedSearchIndex`, `cleanText`, and `rememberBase`.
   - The export must use moss's node classes, split from their React decorators, and moss's exact transformer list.
   - Cache the export per doc state (a dirty flag cleared on export) so a disconnect storm doesn't re-export the whole doc.
   - Measured cost (LEARNINGS §4.2 spike): about 246 KB gzipped and 70–84 ms of cold start; about 80 ms to export 1.9 MiB.
   - The export must be idempotent, `export(import(export(T))) === export(T)`. Otherwise a CLI pull followed by a push of the same text is not a no-op, and base hashes churn.
3. **Write gating.** `isReadOnly` is all-or-nothing and silent. Replace it with an ingress gate per role:
   - **Viewer and commenter:** no CRDT writes. Comments go through REST in the recommended design (§6.1).
   - **Suggester:** vetting (item 4).
   - **Editor and up:** all writes.
   - **Refusals are loud.** Send a unicast `__YPS:{t:'write-refused', reason}` and then close 4403. The client must hard-resync and discard its optimistic state. Restricting a role to certain shared types means telling which top-level type an update touches; apply it to a mirror doc and observe `afterTransaction` changed types (`Y.Transaction.changedParentTypes` / `changed`) before applying it to the live doc.
4. **Rebuild suggester vetting for the tree.** `checkSuggesterDelta` assumes one `Y.Text` delta stream. On the `@lexical/yjs` tree, the shapes are different:
   - each element is an `XmlText` embedded in its parent's `XmlText`;
   - each text node is a `Y.Map` embed (holding `__type`, `__format`, `__style` and so on) followed by its characters in the parent `XmlText`;
   - decorators are `XmlElement` embeds;
   - element properties are `XmlText` attributes.

   Glyphdown's rules would therefore reject every Enter key and every new text node as a `non-text-insert`, and every formatting toggle as a `Y.Map` change. The tree rules must be designed fresh, and LEARNINGS §4.12 says to define the structural-operation semantics up front. They should say:
   - inserting text, text-node maps, and paragraph `XmlText` embeds is allowed when attributed to the author's own open suggestion;
   - deleting original content is never allowed;
   - property and attribute changes are allowed only on nodes created inside the author's own suggestion.

   Vet on a **mirror doc before applying** (`.refs/moss-collab/packages/sync/src/suggester-gate.ts`), using the actual Yjs event deltas, never a flat-text re-diff, because that produced false 4403s on colliding prefixes. The alternative, apply then invert, cannot satisfy "never lands". A `Y.UndoManager` scoped to the connection origin could invert arbitrary tree changes, but the violation would still land first.
5. **Size and connection caps.**
   - **Doc size.** Apply 2 MB to each incoming frame against the mirror and again after every push or restore. Glyphdown checks push text only, and in UTF-16 units. LEARNINGS §4.7 notes a push can otherwise bypass the cap.
   - **Connections.** Refuse the 51st connection in `onConnect` with 4429.
   - **Rate.** Add a per-connection message limit that runs before the expensive size check.
   - **Awareness.** Cap the payload size.
6. **Push rate scope.** PRODUCT says 60 pushes per minute per identity. Glyphdown counts per doc, so either accept that as "as-is" or move the counter into a per-identity location (D1 or a small DO). This is an architecture decision.
7. **Revocation must bite live sockets.**
   - **Sign-out:** a session-ended path (4402) backed by a session-to-socket registry (`.refs/moss-collab/packages/sync/src/session-registry.ts`, `session-gate.ts`).
   - **Demotion:** recheck on every role write, including the `POST /members` upsert and invites.
   - **Link revocation:** close signed-in sockets that rode the link. Record the presented token in connection state and close by token (`.refs/moss-collab/packages/sync/src/grant-gate.ts`).
   - **Agent-key revocation:** close by agent principal id.
   - **After a wake:** treat an empty revocation cache as unknown and hold frames until the authority answers, failing closed (LEARNINGS §4.7).
   - Route every one of these through a single kick path.
8. **Awareness identity.** Stamp or validate the `user` identity (principal id, name, `isAgent`) from trusted connection state, so the Bot badge and the face pile cannot be spoofed. The client-side heartbeat republish (every 4 s), sweep (12 s), claimed colors, and `pagehide` cleanup come from LEARNINGS §4.5, not from glyphdown.
9. **Title and metadata projections.**
   - The DO observes `Y.Text('title')` and writes D1 `docs.title` and the `filename` projection (`<slug>.md`, unique per folder, suffixed on collision). Throttle to about 750 ms with a trailing flush, serialize the writes, and never clear the column.
   - The DO also touches `docs.updated_at`, throttled. Glyphdown never updates it on content edits, so moss's modified times would freeze.
   - Glyphdown's DO deliberately never touches D1 (`SyncEnv.DB` is "unused by the DO itself"). This projection is a required divergence.
   - The DO also feeds the SearchDO title from the CRDT, where glyphdown's Worker fed it on rename.
10. **Push.** Replace `mergePush`/`materializeSuggestion` over `Y.Text` with a structural tree merge (§7.3).
11. **Versions and restore.**
    - **Storage.** Store the exported markdown (for display, diff, and search) plus a lossless form: Lexical JSON or a Yjs update blob, chunked, and spilled to R2 above about 1.5 MB. Glyphdown stores text only.
    - **Restore must preserve identity.** Glyphdown's `restoreText` is a minimal text diff onto `Y.Text`. Moss-multi must restore through the same structural merge primitive as push, so untouched blocks and comment anchors survive.
    - **`unstable_replaceDocument` is a candidate but unsafe as-is.** y-partyserver 2.2.0 ships `unstable_replaceDocument(snapshotUpdate, getMetadata)`, which reverts all changes since a stored state through UndoManager key remapping and supports `XmlText`, `XmlElement`, and `XmlFragment` roots. As written it reverts **every** root key, which would delete newer comments and suggestions, and it is marked unstable. Use a scoped variant over `root`, `title`, and `frontmatter` only, or not at all.
12. **Doc deletion.** Persist a deleted flag in DO storage so a racing reconnect on a stale grant cannot write. Glyphdown relies solely on the Worker returning 404 for new upgrades. Owner reads of a trashed doc need one consistent path (LEARNINGS §4.10).
13. **Anchor revalidation** after push, restore, and accept/reject must use the tree-aware anchor module (§6.1).
14. **Wire exclusions.** Per-viewer fields (`__activeIndex`, `__colWidths`, formula `__result`, and the others) must never ride the wire. That is a client binding concern, but the DO's headless editor must register the same node set so it neither crashes nor strips them (LEARNINGS §4.3).

---

## 3. Auth

### 3.1 What glyphdown does

- **Library.** better-auth (specifier `^1.6.14`, resolved 1.6.14) with `drizzleAdapter(db, { provider: 'sqlite', schema: { user, session, account, verification, deviceCode } })`, in `apps/web/src/auth.ts`.
- **One instance per request.** `createAuth(env)` is never a module singleton, because D1 bindings are per invocation and a singleton caused 30 s hangs under contention (`docs/research.md`, webapp area). `cookieCache` stays off (better-auth #4203). `secret` is `BETTER_AUTH_SECRET` and `baseURL` is `BETTER_AUTH_URL`.
- **Sign-in methods.** Only GitHub and Google OAuth (`socialProviders`, `auth.ts:53`). Both are registered even when their credentials are empty (`clientId: env.GITHUB_CLIENT_ID ?? ''`). LEARNINGS §4.9 records that this makes `/sign-in/social` return 500. The login page (`apps/web/src/routes/login.tsx`) shows only the two OAuth buttons. There is **no email and password**, no verification, and no password reset.
- **Plugins**, in order:
  - `deviceAuthorization({ expiresIn: '15m', interval: '5s', verificationUri: '/device', validateClient: id === 'glyphdown-cli' || 'ink-cli', schema: {} })`. The `schema: {}` works around a 1.6.14 zod quirk.
  - `bearer()`, so `Authorization: Bearer <session token>` (the device-flow access token) authenticates `getSession`.
  - `tanstackStartCookies()`, which must stay last.
- **Signup hook.** `databaseHooks.user.create.after` calls `ensureDefaultVault(db, user.id)` (best-effort), creating the `Home` vault.
- **Principal resolution** (`apps/web/src/api/auth.ts`):
  1. `Bearer gd_sk_…` (or legacy `ink_sk_…`) is matched by sha256 hex against `agents.key_hash` where `revoked_at IS NULL`. It yields `{type: 'agent', id, name, ownerUserId}`.
  2. Any other bearer value, or a cookie, goes through `auth.api.getSession({ headers })`.
  3. Otherwise the caller is anonymous, viable only with a view-role share link, as the synthetic `{id: 'anonymous'}`.

  `trustedHeaders(auth, init)` writes `x-glyphdown-principal` (JSON) and `x-glyphdown-role`.
- **Agent keys.** `POST /api/agents {name}` returns `gd_sk_<64 hex>` exactly once and stores only the hash. `DELETE` sets `revoked_at` but closes no live sockets. Only users can manage keys. An agent acts with its owner's access (`effectiveUserId`).
- **CLI device flow** (`packages/cli/src/config.ts:192`): `POST /api/auth/device/code {client_id}`, print the URL and code and open the browser, then poll `POST /api/auth/device/token` (handling `slow_down` +5 s, `authorization_pending`, `expired_token`, `access_denied`). The session token is stored in `~/.config/glyphdown/config.json` (mode 600). The `/device` page (`apps/web/src/routes/device.tsx`) claims the code on GET (`authClient.device`), then approves or denies.
- **Client.** `apps/web/src/lib/auth-client.ts` is `createAuthClient({ plugins: [deviceAuthorizationClient()] })`, same-origin.

### 3.2 Port nearly verbatim

`createAuth(env)` per request, the drizzle adapter and schema mapping, the device-flow plugin and CLI loop, `bearer()`, `tanstackStartCookies()` last, the sha256 agent keys, principal resolution order, the anonymous principal for view links, `ensureDefaultVault` on signup, and the `kyselyMigrationExportsFix` vite transform (while it is still needed on the pinned better-auth).

### 3.3 Must change

- **Email and password.** Enable `emailAndPassword: { enabled: true, minPasswordLength: 12 in prod and 8 in dev, requireEmailVerification: false }` and always render the form (PRODUCT, People & access).
- **Social providers.** Register each one only when both its id and secret exist. None are enabled for the reference, so the machinery stays dormant and no button renders.
- **Fail closed (SEC-4).** Refuse to boot when `BETTER_AUTH_SECRET` is missing, is the placeholder, or is under 32 characters.
- **Sign-out.** Sign-out must sever every socket of that session (4402) and stop polling synchronously, and its body must be JSON `{}` (LEARNINGS §4.9).
- **Rename identifiers.** Change the device `client_id` (for example `moss-multi-cli`), the key prefix (for example `mm_sk_`), and the trusted header names (`x-moss-*`). Drop all ink and inkroom legacy fallbacks.
- **Agent revocation.** Revoking a key must close that agent's sockets.
- **Dev affordances.** There is no DEV_AUTH playground (restart ruling 7), so drop `apps/web/src/api/auth.ts`-level dev paths. If any dev-auth affordance is added, gate it with the four-way loopback guard (LEARNINGS §4.9).
- **Transient errors.** A transient D1 failure must not redirect a signed-in user to `/login` (ruling 10).

---

## 4. D1 schema (drizzle) and migrations

### 4.1 Tables

The tables live in `apps/web/src/db/schema.ts`. better-auth tables use `timestamp_ms` integers; app tables use plain epoch-ms integers.

| Table | Key columns | Notes |
|---|---|---|
| `user` | `id, name, email UNIQUE, email_verified, image, created_at, updated_at` | better-auth |
| `session` | `id, expires_at, token UNIQUE, ip_address, user_agent, user_id → user (cascade)` | better-auth; the token is stored in plaintext |
| `account` | `id, account_id, provider_id, user_id → user, access/refresh/id tokens, scope, password` | better-auth (`password` holds the email+password hash) |
| `verification` | `id, identifier, value, expires_at` | better-auth |
| `device_code` | `id, device_code, user_code, user_id, expires_at, status, last_polled_at, polling_interval, client_id, scope` | device flow |
| `agents` | `id, owner_user_id → user, name, key_hash UNIQUE, scope DEFAULT 'inherit', created_at, revoked_at` | |
| `folders` | `id, owner_user_id → user, name, kind 'folder'\|'vault' DEFAULT 'folder', parent_id → folders (no action), created_at` | Partial unique index `(owner_user_id, lower(name)) WHERE kind='vault'`. The invariant `parent_id IS NULL ⟺ kind='vault'` is enforced by the API. |
| `docs` | `id, title (legacy), filename DEFAULT '', folder_id → folders (set null), owner_user_id → user, created_at, updated_at, deleted_at` | Partial unique indexes `(folder_id, filename) WHERE folder_id IS NOT NULL AND deleted_at IS NULL` and `(owner_user_id, filename) WHERE folder_id IS NULL AND deleted_at IS NULL` |
| `doc_members` | PK `(doc_id, principal_id)`, `principal_type`, `role` (viewer..editor), `added_by`, `created_at` | Owner is never stored |
| `folder_members` | PK `(folder_id, principal_id)`, `principal_type`, `role`, `created_at` | |
| `share_links` | `token PK, target_type 'doc'\|'folder'\|'asset', target_id, role, created_by, created_at, revoked_at` | |
| `assets` | `id, folder_id → folders (cascade) \| doc_id → docs (cascade), filename, r2_key, content_type, size, etag, current_version_id → asset_versions (set null), created_by, created_at` | Unique `(folder_id, filename)` and `(doc_id, filename)` |
| `content_objects` | `hash PK (sha256), size, refcount` | Blobs in R2 at `asset-blobs/sha256/<hash>` |
| `asset_versions` | `id, asset_id → assets (cascade), content_hash → content_objects, size, etag, created_by, created_at, message` | |
| `invites` | `token PK, email, target_type, target_id, role, invited_by, created_at, accepted_at, accepted_by, revoked_at` | Indexes on email, target, and `(invited_by, created_at)` |
| `user_prefs` | `user_id PK → user, email_notifications DEFAULT 1, default_vault_id → folders` | |
| `notifications` | `id, user_id → user, type, payload_json, created_at, read_at` | Index `(user_id, read_at)` |
| `feedback` | `id, principal_id, user_id, type, body, page, created_at` | Admin-only feature |

### 4.2 Migrations and tooling

- **Generation.** `drizzle-kit generate` (`apps/web/drizzle.config.ts`: `dialect: 'sqlite'`, `schema: ./src/db/schema.ts`, `out: ./drizzle`) writes SQL into `apps/web/drizzle/0000…0008` plus `meta/_journal.json` and snapshots.
- **Application.** `wrangler d1 migrations apply inkwell --local|--remote` (`db:migrate:local` / `db:migrate:remote`), tracked by wrangler in `d1_migrations`. `wrangler.jsonc` sets `migrations_dir: "drizzle"`.
- **History:**

  | Migration | Change |
  |---|---|
  | 0000 | Initial core and better-auth tables |
  | 0001 | `device_code` |
  | 0002 | `assets` |
  | 0003 | `folders.parent_id` |
  | 0004 | `docs.filename` plus a recursive-CTE slug backfill and three dedupe passes |
  | 0005 | `invites` and `user_prefs` |
  | 0006 | `feedback` |
  | 0007 | `folders.kind`, the vault-name index, and `user_prefs.default_vault_id` |
  | 0008 | `content_objects`, `asset_versions`, and `assets.current_version_id` |

  `apps/web/scripts/backfill-vaults.ts` is a one-off data migration.
- **D1 constraints.** D1 enforces foreign keys and has **no interactive transactions**. Drizzle's `db.transaction()` BEGIN is rejected, so multi-statement writes use `db.batch([...])` or sequential writes (`apps/web/src/api/assets.ts`, `inAssetTransaction`).
- **Client.** `createDb(env.DB)` (`apps/web/src/db/client.ts`) is built per request and never cached.

### 4.3 Port nearly verbatim

Every table except `feedback`, the partial unique indexes, the vault-name index, the `asset_versions`/`content_objects` refcount model, the better-auth column mapping, the per-request `createDb`, and the generate-then-`wrangler d1 migrations apply` workflow.

### 4.4 Must change

- **Start from one squashed `0000_init.sql`.** There is no legacy data, so the 0004 backfill, the 0007 vault backfill, and the `docs.title` legacy semantics are unnecessary. The vault invariant can hold from day one; consider `docs.folder_id NOT NULL`.
- **`docs.title` becomes the real D1 projection of `Y.Text('title')`**, written only by the DocDO (restart ruling 3). `docs.filename` stays the unique `<slug>.md` projection; the DO suffixes collisions and never returns 409.
- **Trash:**
  - add `folders.deleted_at` and a trash-batch id on docs and folders, so a folder subtree trashes and restores as a unit (PRODUCT: folder delete moves the subtree to trash);
  - add an index on `docs (owner_user_id, deleted_at)` for the trash list;
  - put the 30-day copy in one shared protocol constant (LEARNINGS §4.8).
- **Session and socket registry** for sign-out kills: a D1 table (moss-collab's `live_collab_sockets`) or DO-side state keyed by session id.
- **Note metadata.** If moss metadata fields that moss desktop keeps in sidecars need server records, they belong in a `doc_meta`-style table (PRODUCT, Notes & workspace). Per-viewer layout stays in localStorage (ruling 11).
- **Assets:**
  - make the scope folder-only (drop the `doc_id` scope and all legacy fallback code);
  - allow `video/mp4`, `video/webm`, and `video/quicktime`;
  - drop the `text/html` asset kind (§6.6) and the `'asset'` share-link target, unless asset links are wanted.
- **Drop** `feedback` and `user_prefs.email_notifications`. Email is unconfigured; keep `default_vault_id`.
- **Tests apply the real migration files.** Glyphdown's `apps/web/src/api/router.test.ts:100+` hand-writes DDL, which is the drift class behind LEARNINGS §4.8's asset-delete 500. Moss-multi tests apply `drizzle/*.sql` and assert that every drizzle `onDelete` appears in the DDL.

---

## 5. Sharing, roles, share links, notifications, vaults, folders, trash

### 5.1 Roles (`apps/web/src/api/roles.ts`, `packages/protocol/src/index.ts`)

- **Order.** `ROLES = ['viewer', 'commenter', 'suggester', 'editor', 'owner']`, compared with `roleAtLeast`.
- **`computeDocRole`** (pure and unit-tested) is the maximum of:
  - owner, when the effective user owns the doc;
  - `doc_members`;
  - `folder_members` on the doc's folder **or any ancestor**;
  - the share-link role: a doc link, or a folder link targeting any ancestor.

  Anonymous callers get `viewer` only, and only through a viewer link. Agents act with their owner's access, and grants to the human also match the human's agents.
- **`resolveDocAccess`** loads the doc, walks the ancestor chain (`fetchAncestorChain`, one D1 query per level, capped at `MAX_FOLDER_DEPTH = 11`), loads the matching member rows, then calls `computeDocRole`. `resolveFolderRole`, `folderShareLinkRole`, and `assetShareLinkRole` (capped at commenter) mirror it for folders and assets.
- **`accessibleDocs(db, principal)`** is the one closure behind `GET /api/docs`, `/api/search`, and backlinks: owned docs, plus doc grants, plus folder grants propagated through their subtrees (`propagateFolderRoles` in `apps/web/src/api/folder-tree.ts`).
- **Non-disclosure.** An unauthenticated caller with no token gets 401 so the CLI can prompt. Everyone else gets **404** for missing, inaccessible, or trashed docs (`router.ts:294`).
- **Capabilities** (SPEC §4 and the code):
  - comment, reply, react, resolve, and reattach: ≥ commenter;
  - push and suggest: ≥ suggester;
  - accept, reject, named versions, restore, and asset upload or delete: ≥ editor;
  - doc rename, move, and delete; share links; members; invites: **owner only** (`patchDoc` at `router.ts:390` requires owner).

### 5.2 Share links

- **Token.** 24 random bytes as hex (`randomToken`).
- **Roles.** viewer, commenter, suggester, or editor (`ROLE_ALIASES` also accepts view/comment/suggest/edit). Targets are a doc, a folder (covering the whole subtree), or an asset (viewer or commenter only).
- **CRUD.** `GET/POST /api/{docs,folders}/:id/share-links` and `DELETE …/:token`, owner only. Revoking sets `revoked_at` and kicks only `'anonymous'` sockets.
- **Presentation.** The token rides `?share=` (the WebSocket and landing URLs) or the `x-glyphdown-share` header (REST). Landing URLs are `/d/<docId>?share=` and `/f/<folderId>?share=`. `/f/:id/listing` is the one folder read that accepts a token.
- **Signed-in visitors.** The root route skips the session lookup when `?share=` is present. A signed-in visitor regains the chrome when `/api/me` resolves (`useShellSignedIn`, `apps/web/src/lib/sessionGate.ts`).

### 5.3 Members and invites

- **Members** (`handleMembers`, `router.ts:596`):
  - `GET` lists members to **any reader, including anonymous link viewers, with their emails**. That is a privacy leak to fix.
  - `POST {email | agentId, role}` (owner only) works for existing users only. It upserts the role, so it can demote without a kick, and writes a `doc-shared` or `folder-shared` notification.
  - `DELETE /members/:principalId` triggers a recheck.
- **Invites** (`apps/web/src/api/invites.ts`):
  - `POST /invites {email, role}` (owner only, 20 per hour). For an existing account it grants immediately, writes a pre-accepted audit row, and sends an email. For an unknown email it writes a pending row and sends an `/invite/<token>` email.
  - The response carries `emailSent` and the URL, so the UI offers **copy link** when email is not configured.
  - `GET /api/invites/:token` is public. `POST …/accept` needs a session; possessing the token is the authority, and the role merges with keep-max. `DELETE` revokes (owner).
  - Accepting writes an `invite-accepted` notification to the inviter.
- **Email** (`apps/web/src/email.ts`, Resend). Graceful degradation is a hard contract: without `RESEND_API_KEY` the email is logged and returns `{sent: false, reason: 'email-not-configured'}`, and every flow still succeeds. This matches PRODUCT's copy-link-only invites.

### 5.4 Notifications

- **Storage.** D1 rows written by the **Worker proxy**, because the DO has no D1 access. Types:
  - `mention`: `@[userId]` parsed from comment and reply bodies;
  - `comment-reply`: to the root author, read from the DO's `x-glyphdown-comment-author` header;
  - `doc-shared` and `folder-shared`;
  - `invite-accepted`;
  - `suggestion`: only for pushes that landed as suggestions.
- **Known gap** (`router.ts:364`): live suggest-mode suggestions, which stream over the socket, create no notification.
- **API.** `GET /api/notifications` returns the last 100. `POST /api/notifications/read {ids?}` marks them read.
- **Client.** `NotificationsBell` polls every 30 s and on focus (`apps/web/src/components/NotificationsBell.tsx:48`). There is no push channel; SPEC §9 rejected SSE from DOs.

### 5.5 Vaults and folders

- **Vaults.** A vault is a root `folders` row (`kind='vault'`).
  - `ensureDefaultVault` (`apps/web/src/api/vaults.ts`) returns a valid preference, else the oldest vault (preferring `Home`), else creates `Home`. It is idempotent and heals stale preferences.
  - `GET /api/vaults` returns owned vaults plus vaults with a **direct** grant on the root.
  - `POST` returns 409 `name-taken` on a case-insensitive collision. `PATCH` is rename only (`vault-immovable`).
  - `DELETE` soft-deletes every doc in the subtree, hard-deletes the subtree's folder rows and grants (deepest first, because of the self-FK), and sends `doc-deleted` to each DO. It is guarded by `last-vault` and `default-vault`.
  - The UI is `apps/web/src/components/VaultSwitcher.tsx`, with an inline "New vault" row. That is the design PRODUCT says to port into moss's DS.
- **Folders.**
  - `POST /api/folders {name, parentId}` requires a parent that the caller **owns** and whose chain ends at a vault, under the depth cap.
  - `PATCH` renames or moves (owner only; `validateMove` checks cycles and depth); a move fans out a recheck over the old chain.
  - `DELETE` **promotes** child folders and docs to the parent, suffixing filename collisions, and does not trash them. Vaults cannot be deleted through this route.
- **Doc creation.** `POST /api/docs` also requires `folder.ownerUserId === effectiveUser` (`router.ts:221`). Collaborators with editor on a shared vault therefore **cannot create docs or folders in it**.

### 5.6 Trash

- `DELETE /api/docs/:id` (owner) sets `deleted_at`, sends the DO `doc-deleted` (4410), and removes the doc from search.
- `POST /api/docs/:id/restore` (owner) restores into the original folder, or the default vault if that folder is gone, and suffixes the filename.
- **There is no trash list API, no trash UI, and no purge.** A trashed doc 404s for everyone except the restore route.

### 5.7 Port nearly verbatim

- `computeDocRole` and the rest of `roles.ts`, `folder-tree.ts` (pure tree helpers), and `filenames.ts` (`availableFilename` and friends).
- The `accessibleDocs` closure shared by the list, search, and backlinks.
- Share-link CRUD and token presentation, the anonymous viewer cap, and the non-disclosing 404s.
- The invite flow with copy-link degradation, notification rows and polling, `ensureDefaultVault`, and the vault routes and invariants.

### 5.8 Must change

- **One kick path for every revocation:** member removal, role change (including demotion through the upsert and through invites), link revocation (signed-in riders included), agent-key revocation, and sign-out (LEARNINGS §4.10, PRODUCT "demotion or revocation bites the live connection immediately").
- **Rename by editors.** Editors can rename, because the title is CRDT text that any editor types into, so the REST rename for editor+ is a request for a CRDT write. Duplicate is editor+; trash and restore stay owner (LEARNINGS §1.3 role gating). Use one roles module shared by client and server for both affordances and enforcement.
- **Collaborators can create.** Editors on a shared vault or folder must be able to create docs and folders in it. The row's `owner_user_id` stays the vault owner, with a `created_by` column. Never fall back to an unowned vault, and give synthetic "Shared" groups no mutation affordances (LEARNINGS §4.10, FOLDER-CREATE-WEB).
- **Folder delete moves the subtree to trash** (soft-delete folders and docs with a batch id), sends 4410 to every doc in it, drops it from search, and restores as a unit.
- **Trash:** add `GET /api/trash` (the owner's trashed docs and folders), owner preview reads of trashed docs, and one module for retention copy.
- **Member lists:** strip emails from `GET /members` for non-owners and anonymous callers.
- **Share UI roles:** expose viewer, commenter, editor, and owner only until suggestions ship (PRODUCT, People & access). Suggester stays in the schema.

---

## 6. Comments, suggestions, history, search, assets, HTML docs

### 6.1 Comments

- **Model** (`packages/protocol/src/index.ts`, `Comment`): `{id, anchor: Anchor|null (null = doc-level), anchorKind?, textAnchor?, nodeAnchor?, versionId?, authorId, authorName, body (markdown; mentions as @[userId]), createdAt, resolved, reactions: Record<emoji, principalId[]>, replies[]}`.
- **Storage.** DO SQLite sidecar rows, despite SPEC §6.2 saying "Y.Map". Mutations go through REST (Worker to DO) and are broadcast as `{t:'comment'}`.
  - Glyphdown's stated reason (SPEC §3.1): "role enforcement stays trivial (commenters never write the CRDT), and doc compaction can't corrupt them."
  - `CommentStore` (`packages/sync/src/sidecar.ts`) provides create, reply, resolve (a toggle, by any commenter), react (toggle per principal, emoji ≤ 32 characters), reattach, and revalidate.
  - **There is no edit or delete.**
- **Anchors** (`packages/core/src/anchor.ts`, `quote.ts`): `{start, end}` are base64 `Y.RelativePosition` values with assoc right and left. The quote is `{exact, prefix, suffix}` with 32 characters of context, plus a `hint` offset and an `anchored|orphaned` status.
  - Resolution uses `followUndoneDeletions = false` (yjs#638).
  - Validation keeps an anchor at similarity ≥ 0.5 (`REANCHOR_THRESHOLD`). Otherwise it searches the quote, with exact candidates scored by context and hint, then fuzzy bitap accepted at ≥ 0.8 (`FUZZY_ACCEPT_THRESHOLD`). Any re-anchor re-mints positions and refreshes the quote. If nothing matches, the anchor is orphaned.
  - `MIN_ANCHOR_CHARS = 8`.
- **Client.** `CommentsSidebar`, `CommentThreadList`, and `MentionTextarea`, with highlights from CodeMirror decorations recomputed by `resolveAnchor` on every event. These are design references only; moss supplies the comments UI.

**Port:** the thresholds and constants, the quote-capture and fuzzy re-anchor algorithm, orphan semantics, reactions and resolve semantics, the mention syntax and the Worker-side notification hook, and the reply-author header trick.

**Must change:**

- **Storage moves into the CRDT** (PRODUCT: "Comment and suggestion threads/anchors are first-class CRDT data in the shared doc"). **Recommended shape:** the threads live in a `Y.Map('comments')` in the doc, but **only the DO writes it.** Clients call REST, the DO validates role and authorship and writes under a server origin, and peers receive the change through normal Yjs sync. This keeps glyphdown's two properties: commenters never get CRDT write access, and Worker-proxy notifications keep working. It also meets PRODUCT. Server-origin writes stay out of every client's UndoManager. The alternative, clients writing the map directly, needs per-entry authorship vetting in the ingress gate and moves notification writing into the DO.
- **Tree anchors.** `createRelativePositionFromTypeIndex` must target the specific paragraph `XmlText`. A range can span paragraphs. The `XmlText` index space counts embeds: each text node's `Y.Map` and each child element is one position. Map between flat (exported, mark-transparent) text offsets and `(XmlText, index)` in both directions, for minting, quotes, re-anchoring, and painting. Reference: `.refs/moss-collab/packages/core/src/tree-anchor.ts`.
- **Painting.** Paint highlights as derived, zero-mutation view state. Never put MarkNodes into the synced tree (LEARNINGS §4.3, §4.11).
- **Moss features** that need new routes: comment edit and delete (author only), plus moss's gutter, popover, and Cmd+Shift+A flows.

### 6.2 Suggestions

- **Model** (`packages/core/src/suggestions.ts`): `{id, authorId, createdAt, status open|accepted|rejected|withdrawn, note?, parts: {kind: 'insert'|'delete', anchor}[]}`. Inserted text is physically present; deleted text stays present and is marked.
  - Accepting an insert closes the record; rejecting it deletes the range.
  - Accepting a delete deletes the range, guarded by quote similarity ≥ 0.8 (`outdatedParts`); rejecting it closes the record.
  - Each transform is one `Y.Text` transaction.
  - The `clean` export strips pending inserts.
  - `materializeSuggestion` turns a push diff into a suggestion.
- **Live suggest mode.** `packages/core/src/suggest-session.ts` (`COALESCE_WINDOW_MS = 30000`, at most one paragraph gap) plus `packages/editor/src/suggest-mode.ts`. The client streams records with `suggestion-upsert`, and the DO enforces them (§2.4). Orphaned suggestions are auto-rejected with `ORPHAN_REJECT_NOTE`.

**Port:** the record shape and status machine, the accept drift guard, auto-reject on orphan, the withdraw rule, `--suggest` pushes, and the upsert ownership checks.

**Must change:**

- Everything that touches text becomes tree operations: physical inserts and marked deletes on the Lexical tree, accept and reject as tree transactions, and a `clean` export through the converter.
- Records move into a `Y.Map('suggestions')` written by the DO on validated upsert.
- Paint marks as a zero-mutation overlay (LEARNINGS §4.12).
- Define structural operations (checkbox toggle, table row insert) and the vetting rules (§2.10 item 4).
- Take a baseline only after first sync.
- Notify on live suggestions, not only pushed ones.

### 6.3 History and versions

- **Server:** the DO `versions` table (§2.1). Kinds are `auto`, `named`, and `restore-point`.
  - `GET /versions` returns metadata newest first, with `LENGTH(text)` as the size.
  - `GET /versions/:id` returns `{text}`.
  - `POST /versions {name}` (editor+) creates a named version.
  - `POST /versions/:id/restore` (editor+) takes a restore-point, runs `restoreText` (a minimal text diff), revalidates, and takes an auto snapshot.
- **Client:** `apps/web/src/routes/d.$docId.history.tsx` (version list, read-only view, side-by-side diff, restore confirm) and `apps/web/src/lib/diff.ts` (line-level Myers with word refinement, `MAX_D = 2000`). CLI: `snapshot -m`, `history`, and `cat --version`.

**Port:** the version kinds, the restore-point bracketing, the dedupe against the latest version, the REST surface, and the diff library (useful for the moss modal).

**Must change:**

- Store lossless tree state and restore by identity-preserving structural reconcile (§2.10 item 11).
- Show honest errors when the versions fetch fails.
- Port moss's `TimelinePopoutModal` and empty state, and allow a first named checkpoint from the empty state.
- Add the activity-based auto-snapshot (SPEC §7 says about 500 updates or 10 minutes; glyphdown implements only last-disconnect and push).
- Spill large versions to R2, and rate-limit named versions.

### 6.4 Search (SearchDO, FTS5)

- **Shape.** One global DO, named `'global'` (`packages/sync/src/search-do.ts`), with `hibernate: true` and a SQLite migration `v2`.
- **Tables.** `entries(doc_id PK, title, body, updated_at)`, `entries_fts USING fts5(doc_id UNINDEXED, title, body)`, and `links(src_doc_id, target_title_norm)` with indexes. If FTS5 creation throws, it falls back to a LIKE engine (`scoreEntry`).
- **Internal routes** (POST only):
  - `/index {docId, title?, body?}` upserts title and body independently and re-extracts wiki links on a body write.
  - `/remove {docId}`.
  - `/search {query, allowedDocIds, limit}`: bm25 with weights (0, 5, 1), 400 candidate rows, then a permission filter. The default limit is 20 and the maximum 50.
  - `/backlinks {titleNorm, allowedDocIds}`.
- **Helpers** (`packages/sync/src/search-core.ts`):
  - `buildFtsMatch` quotes every token and adds a prefix `*`;
  - `makeSnippet` returns ±60 characters with the hit wrapped in «»;
  - `WIKI_LINK_RE = /\[\[([^\]|#]+)/g`;
  - `normalizeWikiTarget` is slug normalization.
- **Worker side** (`apps/web/src/api/search.ts`):
  - `GET /api/search?q=&vault=` computes `allowedDocIds = accessibleDocs` (optionally narrowed to the vault) and maps titles from D1.
  - When the index reports `coldIndex`, it backfills up to 200 docs from DocDO `/content` through `waitUntil`.
  - `GET /api/docs/:id/backlinks` is filtered to the same vault and returns `[]` for anonymous callers.
  - It feeds titles on create and rename and removes docs on delete.

**Port nearly verbatim:** all of SearchDO, `search-core.ts`, and the Worker permission filter, vault scoping, and cold backfill.

**Must change:**

- Body feeds must be the converter's markdown export, never `XmlText.toString()`. That produced "[object Object]" snippets and erased backlinks (LEARNINGS §4.14).
- The DO feeds the title from `Y.Text('title')`.
- Re-feed once on DO wake, and feed even when a push is byte-identical.
- `[[wiki links]]` resolve against the title and the filename stem (ruling 3), so index both normalizations.

### 6.5 Assets (R2)

- **Storage** (`apps/web/src/api/assets.ts`):
  - Bytes are content-addressed at `asset-blobs/sha256/<hash>`, with refcounts in `content_objects` and a GC once the refcount reaches 0.
  - The row metadata is in `assets`, with history in `asset_versions` (restore, name, list, `?version=`).
  - The namespace is the doc's folder (`assetScopeFor`), with a legacy doc-scope fallback.
  - Legacy keys `folder/<id>/<name>` and `doc/<id>/<name>` are still read through `r2_key`.
- **Upload.**
  - Routes: `POST /api/docs/:id/assets?filename=&overwrite=`, `POST /api/folders/:id/assets?…`, and the scopeless `POST /api/assets`, which targets the default vault.
  - The body is raw. The limit is 10 MB (declared and actual), and an empty body is rejected.
  - Allowed types are `image/*` and `text/html` only; anything else gets 415.
  - Uploads need editor+.
  - On a name collision without `overwrite`, the name is suffixed `-2`; with `overwrite`, a new version is appended.
- **Rename** keeps the asset id.
- **Serving:**
  - the current version is served with `cache-control: private, no-cache` plus an ETag (304 on match);
  - a specific version is served `private, max-age=31536000, immutable`;
  - HTML gets `content-security-policy: sandbox allow-scripts`;
  - SVG gets no CSP;
  - there is **no Range support**.
- **Client.** Paste and drop upload for editors (`apps/web/src/components/editor/imageUpload.ts`), with relative `src` values resolved to `/api/docs/:id/assets/<name>?share=`.

**Port:** content addressing, refcounts, the versions model, folder-scoped namespaces, normalized filenames (`normalizeAssetFilename`), editor+ uploads, ETag/304, the scopeless upload, and token threading on reads.

**Must change:**

- **Media set.** Exactly moss's: png, jpg, jpeg, gif, webp, and svg images, plus mp4, webm, and mov video. Remove HTML assets.
- **Range requests** (206) for video playback. Safari requires them.
- **A larger cap for video** (decide a value). Keep in mind the Worker request-body limit.
- **Sandbox SVG** (`content-security-policy: sandbox`, `x-content-type-options: nosniff`).
- **Caching.** Serve with stale-while-revalidate instead of `no-cache` (LEARNINGS §4.15 flash).
- **URL seam.** Moss `moss-asset://` URLs map to the scoped asset URLs through a seam aware of doc, folder, and vault.
- **Copies carry media:** a copied note keeps its media.
- **File tree.** Assets appear as first-class entries.
- **Drop the legacy doc-scoped fallback** entirely.

### 6.6 HTML docs

Glyphdown treats standalone `.html` files as R2 assets:

- The viewer route is `apps/web/src/routes/f.$folderId_.file.$filename.tsx`, a sandboxed iframe that polls comments every 5 s.
- `GET …/commenting-view` injects a nonce'd comments runtime and a `<base href>` (`apps/web/src/runtime/html-comments.ts`).
- Node-anchored comments live in a per-asset `HtmlDocDO` (`packages/sync/src/html-doc-do.ts`; migration `v3`) using `packages/core/src/node-anchor.ts` (parse5).

**For moss-multi:** HTML is content, not an asset (PRODUCT). `moss-html` blocks live in the markdown and render in a sandboxed iframe (`srcdoc` with `sandbox="allow-scripts"` and **no** `allow-same-origin`). Drop HtmlDocDO, the commenting-view, node anchors, and the file viewer route, and do not declare the `HtmlDocDO` binding or migration. Port only the sandbox and CSP pattern, and consider serving any user HTML from an isolated origin (LEARNINGS §4.17).

---

## 7. CLI (`packages/cli`) and core merge (`packages/core`)

### 7.1 Commands and auth

`packages/cli/src/program.ts` uses commander 14:

- **Account:** `login` (device flow, or `--key`), `logout` (revokes the session server-side), `install-skill`, `guide`.
- **Docs:** `list|ls`, `vaults`, `cat` (`--clean`, `--version`), `new <name> [--folder | --vault]`, `add`, `url`, `mv`, `rm|delete [--force]`.
- **Sync:** `clone [dir] [--vault]`, `pull <doc> [path] | --folder`, `push [path] [--all] [--suggest] [--force] [-m]`, `sync [--force] [--json]`.
- **Collaboration:** `history`, `comments`, `comment (--line | --reply | --resolve)`, `suggestions`, `share (create | list | revoke)`, `snapshot -m`.
- **Auth resolution.** `GLYPHDOWN_API_KEY` attributes actions to the agent. Then `GLYPHDOWN_SERVER`. Then `~/.config/glyphdown/config.json` (mode 600). The API client sends either credential as `Authorization: Bearer` (`packages/cli/src/api.ts:197`), and the server tells keys from session tokens by prefix.
- **Distribution.** An npm bundle (`scripts/build-npm.mjs`, esbuild) and bun `--compile` binaries for darwin and linux, on arm64 and x64.

### 7.2 Base tracking and sync

- **Pull** writes `<filename>.md` plus `.glyphdown/<docId>/meta.json` (`{docId, serverUrl, baseHash, pulledAt, file, versionId?}`) and `.glyphdown/<docId>/base.md`. The hash is computed over EOL-normalized text (`packages/cli/src/workspace.ts`).
- **Workspace markers.** `.glyphdown/workspace.json` marks a full-account clone, and each folder directory has `.glyphdown/folder.json` (`{folderId, folderName, serverUrl}`). There are also tombstones and a `.glyphdown/trash/docs/` archive for `rm`.
- **`reconcileTracked`** (`packages/cli/src/sync.ts:471`) makes one GET per doc, which yields liveness, `x-glyphdown-base-hash`, and the body. It then classifies:

  | Local vs base | Remote vs base | Action |
  |---|---|---|
  | unchanged | unchanged | `up-to-date` |
  | unchanged | changed | `pulled`: overwrite the local file and record the base |
  | changed | equal to local | `up-to-date`: advance the base |
  | changed | unchanged | push; `pushed`, advance the base |
  | changed | changed | push (server-side three-way merge), re-GET the merged text, write the file and base; `merged` |

  Other outcomes: a remote 404 gives `remote-gone` (warn and leave the file); a missing local file gives `repulled` (deletes never propagate); a push refused as degenerate gives `skipped-degenerate`.
- **Mirror sync** (`packages/cli/src/mirror.ts`):
  - untracked `.md` files become new docs, named after the file and slugified, and the local file is renamed;
  - new local directories become folders, and new server docs and folders are materialized;
  - server folder renames are only noted;
  - server filename changes rename the local file (`convergeFilename`);
  - a likely local rename gets a warning (`warnLikelyLocalRename`);
  - syncable assets (images and HTML up to 10 MB) are transferred.
- **Exit codes** (`syncExitCode`): 0 clean, 2 failed hunks, 3 degenerate, 1 anything else.
- **`pushWithBase`** (`api.ts:634`) resends `base.md` on `base-missing`.

### 7.3 Core merge (`packages/core/src/merge.ts`)

`computeMergedTarget(current, base, next)` works as follows:

1. If base equals next, there is nothing to do.
2. It computes `diffs = cleanupSemantic(makeDiff(base, next))` and `deletedRatio = deleted / base.length`.
3. If the doc has not drifted, the target is `next`. Otherwise it runs `applyPatches(makePatches(diffs), current)` (fuzzy) and returns the failed hunks as strings.

`mergePush` refuses when the doc drifted, `force` is not set, and `deletedRatio > 0.6`. It then lands `diff(current, target)` as `Y.Text` insert and delete operations in one transaction under the pusher's origin (`applyDiffsToYText`). The diff library is `@sanity/diff-match-patch` 3.2.0, and `normalizeEol` runs at every boundary. Property tests use fast-check 4 (`packages/core/test/merge.test.ts`).

### 7.4 Port nearly verbatim

- The whole command surface and UX, base tracking (`meta.json`, `base.md`, hashes), `reconcileTracked` classification, mirror sync rules, exit codes, `pushWithBase`, the device login loop, config resolution and mode 600, tombstones and the trash archive, and the npm and bun build scripts.
- Core's pure half: `computeMergedTarget` (with the 0.6 degenerate guard and failed hunks as `.rej`), `normalizeEol`, and the base cache contract (LEARNINGS §4.16: "Glyphdown's pure half … carries over as-is").

### 7.5 Must change

- **Landing the merge is structural.** Glyphdown computes the merged markdown target and then applies a text diff. Moss-multi must parse the merged markdown into a tree with the shared transformers, diff it against the live Lexical tree block by block, keeping untouched subtrees and their Yjs items, diff character by character inside changed text nodes, and apply the minimal operations in one DO transaction.
  - Duplicate blocks need positional identity.
  - The block splitter must respect ``` and `:::` fences.
  - Refuse any wipe through a fast path.
  - Re-check the 2 MB cap after the merge.

  Reference: `.refs/moss-collab/packages/core/src/merge.ts` (779 lines). PRODUCT: "never rebuild the tree from markdown".
- **`--suggest` and suggester pushes** materialize as tree suggestions, not `Y.Text` parts.
- **`cat` writes raw bytes.** Glyphdown routes `cat` through the `out()` line sink (`program.ts:55-72`, `out(content.text)`), which appends a newline (LEARNINGS §4.16 bug). Write raw bytes to stdout and test byte-exact round trips, including a 2 MB push and pull.
- **Names.** Rename the binary (not `moss`, which `~/.local/bin/moss` already claims for desktop), the config directory, the env vars, the workspace directory (`.glyphdown/` becomes something like `.moss-multi/`), and the device client id. Drop the ink, inkroom, and inkwell fallbacks.
- **Title and filename.** Glyphdown's filename is the name and `mv` PATCHes the filename. In moss-multi, `Y.Text('title')` is the name (ruling 3):
  - the local file name is the filename projection;
  - `mv` becomes a title write followed by re-reading the projected filename;
  - a new local `My Notes.md` creates a doc titled from the file stem.

  The architecture must still specify whether the title or frontmatter appear in the pulled `.md`. Frontmatter stays in the file; the H1 is ordinary body content.
- **Assets.** Only moss media types sync.
- **Daemon** (ruling 9). Add a folder-watch daemon that runs the same `syncWorkspace` loop: debounced fs events, the push rate limit respected, deletes not propagated, untracked files becoming docs. Glyphdown has no watch mode. The daemon is REST-only and needs no YProvider. If any CLI ever holds a socket, it must use YProvider or reproduce its awareness-interval fix to keep the DO hibernating.
- **Agent presence.** CLI pushes are attributed through the origin `{principal}`, and agent presence is PRODUCT's "Bot-badged". The DO can broadcast a transient presence event for agent pushes, because REST pushes have no awareness.

---

## 8. CI and deploy

- **`.github/workflows/ci.yml`.** Runs on PRs, pushes to main, and `workflow_call`, on ubuntu-latest with a 15-minute timeout: checkout v6, `pnpm/action-setup@v6` (version from `packageManager`, `pnpm@10.30.1`), `setup-node@v6` with Node 22 and the pnpm cache, then `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test`, and `pnpm --filter web build`. There are no e2e tests and no lint step.
- **`.github/workflows/deploy.yml`.** Runs on pushes to main and `workflow_dispatch`.
  - The `test` job reuses `ci.yml`. The `deploy` job (guarded with `if: github.repository == 'SawyerHood/glyphdown'`) runs under `concurrency: deploy-production` with `cancel-in-progress: false`.
  - Its env is `CLOUDFLARE_API_TOKEN` (a secret, required; the job fails fast without it) and `CLOUDFLARE_ACCOUNT_ID` (pinned in the file).
  - Steps: install; build web, with `VITE_POSTHOG_KEY` as build-time env; `pnpm --filter web run db:migrate:remote`; `wrangler deploy`.
  - The token needs the "Edit Cloudflare Workers" template plus D1 Edit.
- **`.github/workflows/release-cli.yml`.** Runs on `cli-v*` tags or dispatch. The CI gate runs first, then the version is checked against `packages/cli/package.json`, then the package publishes to npm through OIDC trusted publishing (with an `NPM_TOKEN` fallback), bun cross-compiles, and a GitHub Release is created.
- **`apps/web/wrangler.jsonc`:**
  - `name: "inkwell"`, with the "DO NOT RENAME" note: DO storage is bound to the worker name. A custom domain route sits on `glyphdown.com`, with `workers_dev: true`.
  - `compatibility_date: "2025-09-02"`, `compatibility_flags: ["nodejs_compat"]`, `observability.enabled`, and `upload_source_maps`.
  - DO bindings `DocDO`, `HtmlDocDO`, and `SearchDO`, with migrations `v1`, `v2`, and `v3` as `new_sqlite_classes`.
  - D1 `DB` with `database_name: "inkwell"` and `migrations_dir: "drizzle"`. R2 `ASSETS` with `bucket_name: "inkwell-assets"`.
  - **No `env` sections and no `vars`.** Secrets go through `wrangler secret put` (`apps/web/.dev.vars.example`).
- **Secrets and env names:** `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`/`SECRET`, `GOOGLE_CLIENT_ID`/`SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `POSTHOG_KEY`, `POSTHOG_HOST`, and the build-time `VITE_POSTHOG_KEY`/`HOST`.

**Port:** the CI gate shape (frozen install, typecheck, test, build), deploy reusing CI through `workflow_call`, a queued deploy concurrency group, migrations before deploy, a fail-fast secret check, and the CLI release workflow (if a CLI release is wanted).

**Must change:**

- **Staging only** (ruling 15). Add `env.staging` in `wrangler.jsonc`, with permanent new worker, D1, and R2 names fixed **before** the first deploy, because renaming loses DO storage. Bind only `DocDO` and `SearchDO`. Build with `CLOUDFLARE_ENV=staging pnpm --filter web build`, because the vite plugin bakes the env at build (LEARNINGS §4.18). Migrate with `wrangler d1 migrations apply <db> --remote --env staging`.
- **Deploy trigger.** Production is undecided (PRODUCT "Undecided" #1), so the trigger is a staging deploy only.
- **Add to CI** (ruling 6):
  - lint;
  - a job that builds the Worker, starts `wrangler dev` on the vite build (real workerd, local D1 and R2, migrations applied), and runs the Playwright journey suite with per-run principals in Chromium and WebKit;
  - a provenance check (the `/api/version` commit matches `GITHUB_SHA`);
  - the schema-against-migration DDL test.
- **Node.** Use ≥ 22.7 (`@cloudflare/vite-plugin` needs it).
- **Packaging.** Confirm `dist/server/.dev.vars` is never uploaded (LEARNINGS §4.17).

---

## 9. Dev setup and how tests run

**Dev:**

- `pnpm install`, then `cp apps/web/.dev.vars.example apps/web/.dev.vars`, then `pnpm --filter web db:migrate:local` (into `.wrangler/state`), then `pnpm --filter web dev` (`vite dev --port 3000`). The Cloudflare vite plugin runs the Worker, DOs, local D1, and on-disk R2 inside workerd during dev.
- Build with `vite build`. `pnpm preview` builds and runs `vite preview`, which serves the built Worker in workerd.
- Run the CLI from source with `pnpm --filter glyphdown dev -- <cmd>` (tsx; Node type-stripping cannot run it, because of parameter properties).

**Tests** (all vitest 4.1.x, Node environment unless noted):

| Package | Files / cases (approx.) | Technique |
|---|---|---|
| `apps/web` | 30 / ~390 | `vitest.config.ts` aliases `cloudflare:workers` to `test/stubs/cloudflare-workers.ts` (a mutable `env`, a detached `waitUntil`, a `DurableObject` base). `server.deps.inline: ['partyserver', 'y-partyserver']`. Router, roles, invites, and asset tests use **better-sqlite3 plus `drizzle-orm/better-sqlite3`** with **hand-written DDL** and mock `partyserver.getServerByName` to record DO calls (`apps/web/src/api/router.test.ts`). Components run under jsdom with Testing Library. |
| `packages/core` | 6 / ~33 (many are fast-check properties) | Pure tests on in-memory `Y.Doc`s: merge, anchors, suggestions, suggest session, snapshot, node anchors |
| `packages/sync` | 5 / ~71 | Pure helpers (`enforce`, `ratelimit`, `sidecar`, `search-core`); `HtmlDocDO` against a hand-written `FakeSql` with `vi.mock('partyserver')`. **The `DocDO` class itself (`do.ts`) has no tests.** |
| `packages/editor` | 20 / ~440 | jsdom CodeMirror tests, run serially (`fileParallelism: false`) |
| `packages/cli` | 10 / ~200 | A fake server (`test/fake-server.ts`) and temporary workspaces |

There is **no `@cloudflare/vitest-pool-workers`, no miniflare, no wrangler in tests, and no e2e or Playwright.** Hibernation, eviction, the WebSocket upgrade path, real D1 constraints, and real R2 are never tested.

**For moss-multi:**

- Under the owner's global rule and restart ruling 6, all tests, typechecks, and lint run **only in remote GitHub Actions**. Local work is limited to `vite build`, then `wrangler dev` on the build, driven through bb Browser Automation for targeted interaction and screenshots.
- Keep glyphdown's fast unit style for pure modules: roles, folder tree, filenames, anchor math, merge, search core, rate limits.
- Add a Node DO harness for the real `DocDO` class (a `node:sqlite`-backed `SqlStorage` shim, in-memory R2, a stubbed `cloudflare:workers`; reference `.refs/moss-collab/packages/sync/test/support`). Apply the real `drizzle/*.sql` files in router tests.
- Hibernation, eviction, WebSocket upgrade, close codes, and "restore after hibernation shows content" need **real-workerd legs** in CI: `wrangler dev` on the build, with a Playwright journey or a WebSocket client. `@cloudflare/vitest-pool-workers` is an option for DO-in-workerd unit legs, but it does not replace the journey suite.
- Every journey uses two or more distinct per-run principals (ruling 7). A two-tab test in one browser profile does not prove server sync, because YProvider's BroadcastChannel is on by default (Appendix A).

---

## 10. Dependency versions

Glyphdown's resolved versions come from `pnpm-lock.yaml`. The moss pin is from `.refs/moss` (`packages/desktop/package.json`, `pnpm-lock.yaml`).

| Package | Glyphdown spec → resolved | Moss at 762abb777 | Recommendation for moss-multi |
|---|---|---|---|
| pnpm | `pnpm@10.30.1` | n/a | 10.30.x |
| Node | CI 22; CLI engines ≥ 20 | n/a | ≥ 22.7, arm64 |
| typescript | `^6.0.2` → 6.0.3 | 5.9.3 | 5.9.3, to match moss's code and minimize porting friction (or 6.0 if moss files typecheck) |
| react / react-dom | `^19.2.0` → 19.2.7 | `^19.3.0` → 19.3.0 | 19.3.x (moss's) |
| @tanstack/react-start | `~1.168.0` → 1.168.24 | n/a | ~1.168.x (proven; LEARNINGS lists 1.168.32) |
| @tanstack/react-router / router-plugin | `^1.132.0` → 1.170.15 / 1.168.18 | n/a | Same line |
| @tanstack/react-query | `^5.101.0` → 5.101.0 | n/a | 5.101.x |
| @tanstack/react-router-ssr-query | → 1.167.1 | n/a | Optional |
| vite | `^8.0.0` → 8.0.16 | `^5.4.21` (desktop) | 8.x (needs `enforce:'pre'` seams; LEARNINGS §4.18) |
| @vitejs/plugin-react | `^6.0.1` → 6.0.2 | `^4.3.1` (web) | 6.x |
| @cloudflare/vite-plugin | `^1.26.0` → 1.40.0 | n/a | Pin exactly |
| wrangler | `^4.98.0` → 4.98.0 | n/a | Pin exactly |
| workerd | → 1.20260603.1 | n/a | Follows wrangler |
| @cloudflare/workers-types | `^4.20260606.1` | n/a | ≥ 4.20260424.1 (needed for `ctx.id.name` addressing) |
| better-auth | `^1.6.14` → 1.6.14 | n/a | 1.6.x pinned (LEARNINGS lists 1.6.23); recheck the kysely fix |
| kysely (transitive) | → 0.29.2 | n/a | Watch the `DEFAULT_MIGRATION_*` export move |
| drizzle-orm / drizzle-kit | `^0.45.2` → 0.45.2 / `^0.31.10` → 0.31.10 | n/a | Same |
| partyserver | `^0.5.6` → 0.5.6 | n/a | 0.5.x pinned (pre-1.0; churn) |
| y-partyserver | `^2.2.0` → 2.2.0 | n/a | 2.2.0 pinned plus the `pagehide` patch (`.refs/moss-collab/patches/y-partyserver@2.2.0.patch`) |
| yjs | `^13.6.31` (override) → 13.6.31 | 13.6.27 (transitive) | **13.6.31, one version** through overrides, including `@lexical/yjs>yjs` |
| y-protocols / lib0 | `^1.0.7` / `^0.2.117` | n/a | Same |
| lexical, @lexical/* | n/a (CodeMirror) | `^0.48.0` → 0.48.0, including `@lexical/yjs@0.48.0` | **0.48.0 exactly** for every `@lexical/*` (ruling 1) |
| @codemirror/*, y-codemirror.next | 6.x / 0.3.5 | n/a | **Not used** (moss is Lexical) |
| tailwindcss | `^4.1.18` → 4.3.0 (with `@tailwindcss/vite`) | 3.4.19 | **3.4.19** (moss's) |
| jotai / @base-ui/react | n/a | 2.20.2 / 1.6.0 | Moss's |
| @sanity/diff-match-patch | `^3.2.0` → 3.2.0 | n/a | 3.2.0 (core three-way and char diffs) |
| parse5 | `^8.0.1` → 8.0.1 | n/a | Drop (node anchors only) |
| commander / picocolors | `^14.0.2` → 14.0.3 / `^1.1.1` | n/a | Same |
| vitest / fast-check | `^4.1.5`–`^4.1.8` → 4.1.8 / `^4.8.0` → 4.8.0 | jest 30 (moss) | vitest 4 and fast-check 4 for new code; moss's jest tests are not ported |
| better-sqlite3 / jsdom | `^12.10.0` / `^28.1.0` | jsdom 28 | Same (tests only) |
| esbuild / tsx | 0.28.0 / 4.22.4 | n/a | Same |
| lucide-react | `^0.545.0` | `^0.577.0` (web) | Moss's icons |
| posthog-js | `^1.382.0` | n/a | Drop |

The workspace overrides in the root `package.json` are `yjs ^13.6.31`, `@codemirror/state ^6.6.0`, and `@codemirror/view ^6.43.0`. `onlyBuiltDependencies` is `better-sqlite3`, `esbuild`, `lightningcss`, `sharp`, and `workerd`. Moss-multi overrides: `yjs`, `lexical`, every `@lexical/*`, and `@lexical/yjs>yjs`. Patches go under `patches/` through `patchedDependencies`.

---

## 11. Consolidated list: glyphdown-as-is gaps against PRODUCT.md

These are required by PRODUCT or the restart rulings, missing or contrary in glyphdown, and must be designed explicitly:

1. **The doc model.** The Lexical tree replaces `Y.Text`. The title and frontmatter are `Y.Text` siblings, and the title is the single name writer, with filename and D1 title as DO projections (§2.10 items 1 and 9; ruling 3).
2. **One converter in the DO**, used by every server read and write path (§2.10 item 2).
3. **Structural tree push merge and identity-preserving restore** (§7.5, §2.10 item 11).
4. **Comments and suggestions as CRDT data,** with tree anchors (§6.1, §6.2).
5. **A violating write never lands and is refused loudly**, with the client discarding its state. Glyphdown's write drops are silent and its suggester enforcement is apply-then-revert (§2.3, §2.4).
6. **Limits:** 2 MB on every path, 50 connections per doc, and 60 pushes per minute per identity, where glyphdown's limiter is per doc (§2.6).
7. **Revocation reaches live sockets** for demotion, link, agent-key, and sign-out cases, including after a wake (§2.10 item 7, §5.8).
8. **Email and password auth,** with only configured OAuth providers (§3.3).
9. **Trash:** a list, folder-subtree trash and restore, and a terminal 4410 across every editable surface (§5.6, §5.8).
10. **Editors create notes and folders inside shared vaults** (§5.5).
11. **Moss's media set:** video, Range support, and SVG sandboxing; no HTML assets (§6.5, §6.6).
12. **Presence:** server-stamped identity, a republish heartbeat, a sweep, claimed colors, and cursors (§2.5, §2.10 item 8).
13. **Connection truth:** heartbeat, close-code vocabulary 4402/4403/4408/4410/4429, and terminal states (LEARNINGS §4.6). None of these exist in glyphdown.
14. **`/api/version` provenance, a staging env, and an e2e journey suite in CI** (§1.3, §8, §9).
15. **No emails disclosed to share-link viewers** (§5.3).
16. **`docs.updated_at` advances on content edits** (§2.10 item 9).

## 12. Decisions this survey hands to the architecture

1. **Comment write path.** Option (a), recommended: comments and suggestions are CRDT maps written only by the DO through REST and socket messages; this keeps glyphdown's enforcement and notification hooks. Option (b): clients write the maps and an ingress gate vets per entry.
2. **Suggester vetting mechanics.** Mirror-doc pre-vetting (recommended; meets "never lands") versus an apply-then-UndoManager revert (glyphdown's spirit, generalized to the tree).
3. **Restore mechanism.** A structural reconcile from stored Lexical JSON (recommended; same primitive as push) versus a scoped variant of y-partyserver's `unstable_replaceDocument`.
4. **DO writes to D1.** The DO writes the title, filename, and `updated_at` projections directly (needed), versus calling back to the Worker.
5. **Push rate-limit scope.** Per doc (glyphdown as-is) versus per identity globally (PRODUCT's wording).
6. **Video size cap and upload path.** Through the Worker, or presigned R2.
7. **YProvider options:** `disableBc: true` (recommended, so the server is the only sync path and enforcement applies), `connect: false` plus one explicit `connect()`, `params` as an async function so share tokens refresh on reconnect, and `resyncInterval` as the heartbeat.

---

## Appendix A. Upstream library behavior verified from published bytes

From `y-partyserver@2.2.0/dist/server/index.js`:

- `WSSharedDoc` is `new Doc({ gc: true })`. Its awareness local state is `null`, and `clearInterval(awareness._checkInterval)` means no server-side awareness timeout.
- `readSyncMessage(…, readOnly)` answers `SyncStep1` and **silently skips** `SyncStep2` and `Update` when the connection is read-only.
- Updates are applied with `transactionOrigin = connection`.
- Awareness frames are applied with origin `connection` and **rebroadcast raw to all connections, including the sender**.
- Each connection's awareness ids are stored in `connection.state.__ypsAwarenessIds`, which is persisted in the WebSocket attachment and survives hibernation. They are removed in `onClose`.
- `onStart`: `await onLoad()`; register the update broadcast, the awareness handler, and the debounced `onSave` (2000 ms / 10000 ms); then send `SyncStep1` to all connections.
- `onConnect` sends `SyncStep1` plus the current awareness states.
- Custom messages: string frames prefixed `__YPS:` go to `onCustomMessage`. Unprefixed strings are ignored with a warning. `sendCustomMessage` and `broadcastCustomMessage` add the prefix.
- `unstable_replaceDocument(snapshotUpdate, getMetadata)` reverts to a snapshot through UndoManager key remapping, supports `Text`, `Map`, `Array`, `XmlText`, `XmlElement`, and `XmlFragment` roots, and covers **all** root keys of the snapshot.

From `y-partyserver@2.2.0/dist/provider/index.js`:

- `YProvider(host, room, doc, {party, prefix, params, connect = true, connectionId, resyncInterval = -1, maxBackoffTime = 2500, disableBc})`. The host scheme is stripped, and `ws` is used for localhost and private IPs.
- `params` may be an async function, re-resolved before every reconnect. `_pk` carries the connection id.
- **BroadcastChannel cross-tab sync is enabled in browsers by default** (`DEFAULT_DISABLE_BC = typeof window === 'undefined'`).
- It clears the awareness `_checkInterval`, broadcasts awareness on `change` (not `update`), and registers `window` `unload` (moss-collab patched this to `pagehide`).
- There is no message-timeout or heartbeat check. `wsLastMessageReceived` is tracked but never enforced.
- Reconnect backoff is `min(2^n × 100, maxBackoffTime)`.

From `partyserver@0.5.6/dist/index.js`:

- `routePartykitRequest` maps env bindings with `idFromName` to kebab-case namespaces and matches `/<prefix=parties>/<namespace>/<name>`. An unknown namespace gets 400. It clones the request and sets `x-partykit-namespace`. It supports `onBeforeConnect`, `onBeforeRequest`, and `props`.
- `getServerByName(ns, name)` calls `setName` over RPC, awaiting `onStart`, before returning the stub.
- `Server.fetch` and `webSocketMessage`/`webSocketClose`/`webSocketError` all `await #ensureInitialized()`. That runs `onStart` inside `blockConcurrencyWhile`, so hibernation-wake replay always completes before the first frame is handled.
- `static options = { hibernate }` selects `HibernatingConnectionManager` (`ctx.acceptWebSocket`).
- `connection.setState` persists through `serializeAttachment`.
- A missing name throws, so DOs must be addressed with `idFromName`.

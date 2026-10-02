# Method: gotchas every agent reads

Read this with PRODUCT.md, your BUILDPLAN entry and the A§ it cites, before writing code. Each line is a trap that already cost a run; the bracket says where it was learned (`L§` is docs/history/LEARNINGS.md). Add a line when you hit a new one; keep it to one or two sentences.

## Anti-stall preamble (every brief carries it)

- **No local tests.** Vitest, Playwright, tsc and ESLint run only in GitHub Actions. Iterate by pushing, then `gh run list --branch <b>`, `gh run watch <id> --exit-status` (Bash timeout 600000, repeat), `gh run view <id> --log-failed`. Dispatch with `gh workflow run ci.yml --ref <b> -f lane=checks` (checks only, about 5 min) or `-f grep=<journey> -f browsers=chromium`.
- **Bound every command.** Timeouts on installs, builds and waits; no watch modes (`vitest run`, never bare `vitest`); never wait more than about 25 minutes on one thing without diagnosing. [L§4.19]
- **Leave nothing running.** Kill every stack, browser and vite you start before returning. At most one browser session per task and 2 local stacks per machine. [L§5.3]
- **Infrastructure is never a verdict.** A runner outage, network or quota death, billing refusal, Cloudflare error page, D1 7429 or Worker 1101 is BLOCKED and requeued. [L§4.19]
- **Git.** Only your task branch. Push every green step. Stage explicit paths; never `git add -A`, never stash, never force-push `m*` or `main`. [L§7.1 #1]
- **Runtime.** arm64 Node 24 only (`node -p process.arch` prints arm64): `~/.local/node-v24.18.1-darwin-arm64/bin`, pnpm through corepack. Rosetta loads the wrong workerd, esbuild and lightningcss. [L§4.18; L§5.1]
- **People.** Test principals are per-run `@example.invalid`; never the owner's accounts. `.refs/` is read-only; never read or write `~/Code/moss`. [L§4.20; L§6]

## CI

- `scripts/ci/plan.mjs` picks the lanes; `ci-ok` is the one required status and fails when any planned job did not succeed.
- A push to any branch runs checks and build. A docs-only change (`docs/**`, `*.md` except `BUILDPLAN.md` and `e2e/`) runs nothing. Draft PR: checks. Ready PR: checks, build, e2e in both engines (`vars.CI_DEGRADED=true` keeps Chromium only unless the PR has label `e2e-full`).
- Dispatch inputs: `lane` (auto, checks, e2e, full; auto means e2e when `grep` is set, else full), `grep`, `browsers` (both, chromium, webkit), `repeat_each` (1-10).
- A newer push cancels the branch's running push run. Let a red run you need as evidence finish before pushing the fix.
- Tag every leg `@p:<id>` with the BUILDPLAN trace rows it proves. Branches of milestone k gate the rows due by M(k-1); the ready `m<k>` → `main` PR gates Mk. A tag naming no row always fails.
- `lexical`, every `@lexical/*` and `yjs` must each resolve to one version equal to its pnpm override. Overrides have no wildcard, so a new `@lexical/*` package needs its own override line. [L§4.2]
- Repo lint rules: no raw colors in `packages/ui`; no `.first()`/`.last()`/`.nth()` on a `contenteditable` locator in `e2e`; no `HISTORIC_TAG` or `'historic'` in apps, packages or vendor (inline disables are ignored under `vendor/`).
- `node scripts/ci/minutes.mjs` prints the month's billable minutes against the 3,000-minute budget (OA2).

## Build and Worker

- `@cloudflare/vite-plugin` bakes bindings at build time: staging builds need `CLOUDFLARE_ENV=staging`. [L§4.18]
- Vite 8 (rolldown) ignores `resolveId` hooks and aliases in the client environment; seams are `enforce:'pre'` transforms. `resolve.dedupe` covers react, react-dom, jotai, jotai-family, lexical, `@lexical/*`, yjs, prismjs. In vitest, alias `cloudflare:workers` to a stub and inline partyserver and y-partyserver. [L§4.18]
- TanStack Start: the root route uses `shellComponent`; the Worker exports `createServerEntry({fetch})`; parents need `<Outlet/>`. [L§4.18]
- Global CSS is imported in `__root`; a lazy import ships an unstyled production build while dev stays green. Tailwind globs cover every file that writes a `className`. [L§4.1]
- Prism is installed first in the client entry and in workerd; a chunk-order shift crashed the deployed app. [L§4.1]
- `new Request(request, {headers})` drops the WebSocket upgrade headers; clone without init, then set headers. [L§4.7]
- One launcher kills by process group; a "vite dev" pattern never matched "vite.js dev" and three rounds tested stale code. Check `/api/version` before any gate. [L§4.18]
- `wrangler dev` needs `--inspector-port P+1000` (9229 collides across stacks); `vite preview` binds only `[::1]`. [L§5.3; L§4.18]
- SP1 (T0.3): React 19.3.0, Start 1.168.32, Vite 8.1.5, plugin-react 6.0.2 and Tailwind 3.4.19 through PostCSS build and serve the Worker, so no React 19.2.8 fallback is needed; moss alias resolution is proven in T0.5a.
- Local stack: `node scripts/stack.mjs start` builds the tree into `.local-stack/builds/<key>`, boots `wrangler dev` on those bytes and prints `http://127.0.0.1:<port>` (never `localhost`); `stop --run-id <id>` when done. Ready means `/api/version` equals the build, `/` carries `meta[name=moss-build]`, and every linked stylesheet and module script is 200 with its type. Starting a third stack fails; every start reaps orphans first. [L§5.3]
- Provenance comes from `apps/web/vite-provenance.ts`: the Worker gets `__MOSS_BUILD__` in full, the client only `commit` and `clientHash`; `scripts/provenance.mjs read <dist>` prints it for `$GITHUB_OUTPUT` and fails unless there is exactly one record.

## Porting moss

- One pin (762abb777) and a `ported-from` header on every vendored file; changes are marked seams. Vendor the DS wholesale; never port class by class. [L§4.1]
- `scripts/moss-vendor.mjs drift` (the checks step "Vendor drift") fails on any vendored byte that is not upstream plus a recorded patch. An edit to a vendored file ships with `vendor/patches/<root>/<path>.patch` against the pristine bytes (`makePatch`) and `mode: patched` in PORTED.json. `pristine <dir>` rebuilds the upstream tree, `.ladle` and stories included, for the Ladle oracle.
- The title is its own contenteditable (`div.text-h1`, the first `[role=textbox]`, placeholder "What if…") and a new note's title holds the literal text "Untitled". The body is `[data-lexical-editor="true"]`. [L§4.1]
- `hasElectronBridge` is true on the web, so native-only items render enabled unless the hide registry hides them. [L§4.1]
- Never remount or re-key a bound editor because of a REST response; moss's `updatedAt`-keyed refetch caused the 30 s flash and dropped keystrokes. [L§4.1]
- Side panels `shrink-0`, the editor `flex-1 min-w-0`; a dropdown inside a dialog at the same z-index paints behind it. [L§4.1]

## Lexical and the binding

- `HISTORIC_TAG` updates never replicate: exclude writes from undo by origin, never by tag. [L§4.3]
- Never mutate the synced tree locally; a paint-only mark split text nodes and every later keystroke in that tab was dropped. Paint is derived. [L§4.3]
- Derived-origin transactions must not fold back through the binding ("Insert row" added two rows). [L§4.3]
- Per-viewer fields stay off the wire through a type-aware `excludedProperties` (`getType()` lookup); prove it by scanning real frames with a positive control. Never reuse a built-in field name such as `__format`. [L§4.2; L§4.3]
- Node keys differ between clients; anchors are Yjs RelativePositions. Lexical error #38: never cache or restore a zero-child state. [L§4.2]
- One doc id spans several Y.Docs over its life; track boundness per instance. [L§4.3]
- y-partyserver 2.2.0: patch `unload` to `pagehide`; `connect:false` plus one explicit connect; heartbeat with close 4408 after 12 s silence; awareness on `update`; close with 1000; wrap server messages in `__YPS:`. [L§4.3]
- Undo: `captureTimeout` 1000 ms, `trackedOrigins` = the local binding, `readOnly` from the role, not mount-time editability. [L§4.3]

## Title, presence, connection

- The title has one writer, `Y.Text('title')`, with minimal character-diff writes. Never seed "Untitled" as text; nothing is focusable before bind (R2). WebKit navigates history on a bare Backspace with no editable focus. [L§4.4]
- On teardown and `pagehide`, `setLocalState(null)` and `removeAwarenessStates`. After hibernation the DO's awareness map is empty: republish every 4 s, sweep at 2 s and 12 s. [L§4.5]
- Presence is keyed by awareness client id (A§10.7), but journeys still need distinct per-run principals: two contexts sharing a browser profile are one identity. [L§4.5]
- `navigator.onLine`, `context.setOffline` and CDP offline never sever an open WebSocket; use `routeWebSocket` or SIGSTOP. [L§4.6; L§4.20]
- 4410 is terminal for the whole doc through one store every editable subscribes to; `setEditable` waits for first sync on every bind. [L§4.6]
- One module owns navigation; `location.assign`, `replace` and `reload` cannot be wrapped. Sign-out stops polls and sockets synchronously from one auth-state writer. A transient failure degrades in place (R10). [L§4.6]

## Data, auth, access

- A DO replays its update log before serving sync; compacted state is chunked at 1.5 MB (rows cap at 2 MB). After a wake, an empty revocation cache means "unknown": hold frames until the authority answers. [L§4.7]
- Soft delete never frees DO storage, and DO storage is bound to the Worker name: reuse persistent test docs and budget requests. [L§4.7]
- Every drizzle `onDelete` must appear in the migration DDL. D1 enforces foreign keys (`PRAGMA defer_foreign_keys=ON` for cleanup). Moss expects seconds, not milliseconds. [L§4.8]
- better-auth: a request with no `Origin` gets 403 (stamp a same-origin `Origin`); sign-out needs a JSON body `{}`; register a social provider only when its id and secret both exist. With our config (auto sign-in, no verification) signing up an existing email is a 422. [L§4.9]
- better-auth 1.6.23 checks `Origin` only on requests carrying a cookie or fetch metadata, skips the check entirely under `NODE_ENV=test`, and rate-limits only under `NODE_ENV=production`. So `auth/route.ts` refuses an unsafe auth request without `Origin` (the device flow excepted) and `createAuth` sets the checks and limits explicitly. [T0.4]
- Unit tests that touch D1 use a real local D1 through Miniflare (`apps/web/src/test/d1.ts`) with the committed `apps/web/drizzle/*.sql` applied. After editing `schema.ts`, run `pnpm --filter web db:generate`; checks fails on a stale `apps/web/drizzle`. [T0.4]
- The share token rides `?share=` on the WebSocket and every read path; a link role is a ceiling. One roles module, one kick path. [L§4.10]

## Testing and browsers

- Unit tests are never product evidence. Prove every gate red on pre-fix bytes or with a negative control. [L§4.19]
- Wait on published readiness attributes, never sleeps; start clocks after input dispatch returns and assert input order. [L§4.19]
- Vary state: warm and cold, 80 s+ idle, 0, 1 and 2+ peers, 390 and 1440 wide, both engines. An "expected 4xx, got 200" needs a state-changing retry. [L§4.19]
- Headless Chrome cannot be hidden; `page.screenshot` brings the tab to the front; WebKit's `clipboard.readText` fails; `isVisible` ignores occlusion (use `elementFromPoint`); extra headers don't ride WebSocket upgrades. [L§4.20]
- Pixel parity: inject the product fonts into Ladle, pad rather than resize, deselect first, and read the diff image. [L§4.19]
- Agent results are null-guarded and schema-typed, with severities P0, P1, P2. [L§4.19]

## Environment

- The primary machine (host_37m3sgpq59) is shared and often loaded: one graded browser run at a time. Never build on a host running a bb dev stack or Nightly. [L§5.1]
- Never record credential values. Probe Codex quota with `codex exec "reply OK"`. Commit a brief before passing its path; inline prompts near 5 KB get cancelled. [L§5.5; L§5.6]

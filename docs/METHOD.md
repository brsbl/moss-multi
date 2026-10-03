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
- A push to any branch runs checks and build. A docs-only change (`docs/**`, `*.md` except `BUILDPLAN.md` and `e2e/`) runs nothing. Draft PR: checks. Ready PR: checks, build, e2e in both engines (`vars.CI_DEGRADED=true` keeps Chromium only unless the PR has label `e2e-full`). Nightly on main: only the `@slow` legs, in both engines, skipped when main's head already has a green nightly or no leg is `@slow`.
- Dispatch inputs: `lane` (auto, checks, e2e, full; auto means e2e when `grep` is set, else full), `grep`, `browsers` (both, chromium, webkit), `repeat_each` (1-10), `slow` (also run the `@slow` legs), `macos` (also run the `@macos` legs in macOS WebKit, billed at 10x; a ready `m<k>` → `main` PR always does).
- e2e runs one shard per engine and journey group, each on its own stack: `GROUPS` in `scripts/ci/journeys.mjs` maps journey ids to groups, and `E2E_GROUP` narrows the journey projects to one group's files. A new journey goes into a group in the same commit: the plan fails on a journey in no group, and a group shard that plans no journey fails. A grep dispatch runs one `all` shard per engine. A shard's job timeout is its budget: 13 minutes, 25 with `repeat_each` > 1 or `@slow` legs.
- Tag 60 s holds, soaks and idles `@slow` in the test title. They run at a milestone gate (ready `m<k>` → `main`), nightly and on `-f slow=true`; every other run passes `--grep-invert @slow`, so a grep for a `@slow` leg needs `-f slow=true`.
- A newer push cancels the branch's running push run. Let a red run you need as evidence finish before pushing the fix.
- Tag every leg `@p:<id>` with the BUILDPLAN trace rows it proves. Branches of milestone k gate the rows due by M(k-1); the ready `m<k>` → `main` PR gates Mk. A tag naming no row always fails.
- `lexical`, every `@lexical/*` and `yjs` must each resolve to one version equal to its pnpm override. Overrides have no wildcard, so a new `@lexical/*` package needs its own override line. [L§4.2]
- Repo lint rules: no raw colors in `packages/ui`; no `.first()`/`.last()`/`.nth()` on a `contenteditable` locator in `e2e`; no `HISTORIC_TAG` or `'historic'` in apps, packages or vendor (inline disables are ignored under `vendor/`).
- `node scripts/ci/minutes.mjs` prints the month's billable minutes against the 3,000-minute budget (OA2).
- The e2e job runs in the `mcr.microsoft.com/playwright` image whose tag equals `@playwright/test` in `e2e/package.json` (bump both together): `playwright install --with-deps webkit` once spent 19 min on a throttled apt mirror. Each shard boots the stack on the build job's bytes and runs `--project=selftest-<engine> --project=<engine>`.
- SP15 (T0.9a): Linux WebKit never navigates history on a bare Backspace (WebKit's Unix editing behavior), so the j02 Backspace leg cannot fail on the e2e engines. Tag such legs `@macos`; the `macos` job runs them in macOS WebKit.
- Read e2e results remotely: `d=$(mktemp -d); gh run download <id> -n e2e-<engine>-<group>-<attempt> -D "$d"` holds `e2e/test-results/summary.md`, `results.json`, failure traces and screenshots, and the stack's `wrangler.log`; delete `$d` after.
- Playwright never applies `--grep` to dependency projects, and a top-level project with no matching tests drops its dependencies. So the selftests always run before journeys, and a grep matching nothing fails with "No tests found".

## Build and Worker

- `@cloudflare/vite-plugin` bakes bindings at build time: staging builds need `CLOUDFLARE_ENV=staging`. [L§4.18]
- Vite 8 (rolldown) ignores `resolveId` hooks and aliases in the client environment; seams are `enforce:'pre'` transforms. `resolve.dedupe` covers react, react-dom, jotai, jotai-family, lexical, `@lexical/*`, yjs, prismjs. In vitest, alias `cloudflare:workers` to a stub and inline partyserver and y-partyserver. [L§4.18]
- TanStack Start: the root route uses `shellComponent`; the Worker exports `createServerEntry({fetch})`; parents need `<Outlet/>`. [L§4.18]
- Global CSS is imported in `__root`; a lazy import ships an unstyled production build while dev stays green. Tailwind globs cover every file that writes a `className`. [L§4.1]
- Prism is installed first in the client entry and in workerd; a chunk-order shift crashed the deployed app. [L§4.1]
- `new Request(request, {headers})` drops the WebSocket upgrade headers; clone without init, then set headers. [L§4.7]
- One launcher kills by process group; a "vite dev" pattern never matched "vite.js dev" and three rounds tested stale code. Check `/api/version` before any gate. [L§4.18]
- `wrangler dev` needs `--inspector-port P+1000` (9229 collides across stacks); `vite preview` binds only `[::1]`. [L§5.3; L§4.18]
- SP1 (T0.3): React 19.3.0, Start 1.168.32, Vite 8.1.5, plugin-react 6.0.2 and Tailwind 3.4.19 through PostCSS build and serve the Worker, so no React 19.2.8 fallback is needed. T0.5a: moss's aliases resolve in the client build and in CSS `@import` through `resolve.alias` in `apps/web/vite.config.ts`; no resolve transforms are needed.
- Host code imports moss through `@moss-desktop/*`, declared in `apps/web/src/host/moss-modules.d.ts`, so apps/web's tsc stops at the vendor boundary; `tailwind.config.ts` stays out of tsconfig because moss's config imports its theme state. The moss chunk sits behind `import.meta.env.SSR` in `MossAppHost`, so the Worker bundle never carries it.
- SP13 (T0.5a): a `data:` iframe inherits the page CSP in Chromium, so a moss-html block's inline script is refused under the nonce policy. Blocks load `/frame/html` (its own policy is only `sandbox allow-scripts`); never inject a scripted `data:` iframe in a journey, since Chromium logs the refusal as a console error.
- `html[data-app-state]` is `booting` in the SSR document and `ready` once moss's `[data-moss-app-shell]` renders; the shell's editor canvas is moss's `CanvasArea` scroll container (`data-editor-canvas`, a seam in the shared primitive).
- Local stack: `node scripts/stack.mjs start` builds the tree into `.local-stack/builds/<key>`, boots `wrangler dev` on those bytes and prints `http://127.0.0.1:<port>` (never `localhost`); `stop --run-id <id>` when done. Ready means `/api/version` equals the build, `/` carries `meta[name=moss-build]`, and every linked stylesheet and module script is 200 with its type. Starting a third stack fails; every start reaps orphans first. [L§5.3]
- Provenance comes from `apps/web/vite-provenance.ts`: the Worker gets `__MOSS_BUILD__` in full, the client only `commit` and `clientHash`; `scripts/provenance.mjs read <dist>` prints it for `$GITHUB_OUTPUT` and fails unless there is exactly one record.

## Porting moss

- One pin (762abb777) and a `ported-from` header on every vendored file; changes are marked seams. Vendor the DS wholesale; never port class by class. [L§4.1]
- `scripts/moss-vendor.mjs drift` (the checks step "Vendor drift") fails on any vendored byte that is not upstream plus a recorded patch. An edit to a vendored file ships with `vendor/patches/<root>/<path>.patch` against the pristine bytes (`makePatch`) and `mode: patched` in PORTED.json. `pristine <dir>` rebuilds the upstream tree, `.ladle` and stories included, for the Ladle oracle.
- The title is its own contenteditable (`div.text-h1`, the first `[role=textbox]`, placeholder "What if…") and a new note's title holds the literal text "Untitled". The body is `[data-lexical-editor="true"]`. [L§4.1]
- Vendored files resolve bare imports from the root `node_modules`, so the vendored tree's runtime dependencies are declared in the root `package.json` at moss's lockfile versions.
- The converter split (`editor/commands.ts`, `markdown/*`, `nodes/X.ts`, `nodes/X.view.tsx`, the rerouted utils) is generated by `moss-vendor.mjs extract` from `vendor/extract/moss.json`. Edit a generated file, then run `extract`: it records the edit as `<path>.seam.patch`; drift fails on any unrecorded edit.
- A decorator class's `decorate()` calls `renderNodeView`; its view registers in `X.view.tsx`, loaded by `nodes/register-views.tsx` from `MarkdownEditor.tsx`. Import node classes from `nodes/X`, views only from client code.
- Converter (server) code imports `@lexical/code-core`, never `@lexical/code`; `scripts/ci/deps.mjs` (checks step "Bundle boundary") fails on views, CSS, the `@moss/shared` barrel, react-dom, jotai, `@lexical/code` or `api/electron` reachable from the Worker or the converter.
- On import Lexical clears a line before an element transformer's `replace()`, so returning `false` alone still loses it; as a typing shortcut it clears nothing and `children` is the text after the caret. Reject a line with `$rejectLine(children, match, isImport)` from `markdown/fixes.ts`.
- Converter goldens live in `packages/sync/src/converter/fixtures/goldens`; a missing one fails CI and is uploaded as the `converter-goldens` artifact for review. L2 runs in workerd and L3 against pristine moss in jsdom, both from `.cache/moss-pristine`.
- SP2 (T0.6, T0.6b; checks step "Converter in workerd"): a whole-document import runs with no selection. While a RangeSelection exists, every Lexical `remove()` and `insertAfter()` pays `getIndexWithinParent()`, and moss's TABLE and raw-URL transformers `selectEnd()` during import, so import was quadratic in blocks. `$importNoteBody` drops the selection and a seam skips those calls (`markdown/fixes.ts`); never add a caret move to an import path. The step fails any scale-note import up to 2 MB over 5 s of workerd CPU. The scale note is the family corpus repeated (27,140 blocks at 2 MB):

  | Workerd CPU (median of 3; T0.6 ran 1 and 2 MB once, the bound import runs once) | T0.6 | T0.6b |
  | --- | --- | --- |
  | 256 KB import | 1.5 s | 0.4 s |
  | 1 MB import | 16.4 s | 1.1 s |
  | 2 MB import | 56.2 s | 2.1 s |
  | 2 MB import into a bound Y.Doc (21 MB of state), the serverWrite path | 62.4 s | 5.7 s |
  | 2 MB export | 0.6 s | 0.3 s |

  Still open for T0.7: a 2 MB import grows RSS by about 140 MB, and about 150 MB with the bound Y.Doc, against a 128 MB isolate; the worst state-to-markdown ratio is a canvas (about 47: its 7,200-cell grid is one attribute; the scale note is about 10.5), so `STATE_CAP` from the per-family worst needs a ruling. State bytes vary by a few percent between runs of the same code (each Y.Doc's random client id is varint-encoded).
- An escaped one-line `&lt;blockquote…&gt;` swallows every line up to the next standalone `</blockquote>` (moss at the pin; `fixtures/escaped-blockquote.md`). A note built by repeating fixtures leaves it out (`fixtures/scale.json`) and checks its block count, or it measures one giant HTML block.
- `hasElectronBridge` is true on the web, so native-only items render enabled unless the hide registry hides them. [L§4.1]
- Seams reach host code as `@moss-multi/host/<module>`, aliased in `apps/web/vite.config.ts`, `vitest.config.mjs` and `packages/sync/tsconfig.converter.json` (which typechecks the vendored closure). Slots that later tasks fill live in `apps/web/src/host/slots.tsx`. [T0.5b]
- The hide registry (`apps/web/src/host/affordances.ts`) names each withheld affordance's vendored sites and a probe in pristine moss's DOM: j00-shell asserts the probes match nothing, and the parity job hides the same probes in the oracle. Unstaging an entry deletes it and its `hidden('<id>')` reads together. [T0.5b]
- `bridge/inventory.ts` lists every ElectronAPI method at the pin. A `staged` inventory entry or registry entry fails the unit tests once CI's `TRACE_MILESTONE` (the last closed milestone) reaches its milestone. [T0.5b]
- Base UI renders every portal as `div[data-base-ui-portal]` with modal internal backdrops inside it, so `data-overlay-surface` sits on the DS Portal wrappers; an inline Popover's backdrop is not covered. [T0.5b]
- Never remount or re-key a bound editor because of a REST response; moss's `updatedAt`-keyed refetch caused the 30 s flash and dropped keystrokes. [L§4.1]
- Every note the web opens binds through `useMossMultiPane` (`host/collab/pane.tsx`), CanvasAreaContent's one seam: moss's REST hydration, autosave, disk and agent paths return early, and the editor mounts behind the skeleton until first sync. [T0.8]
- A hand seam in a generated residual file (`MarkdownEditor.tsx`) cannot go through `extract`, whose drift precheck reverse-applies the residual patch first and fails. Record it as `extract` settles one (the `.seam.patch` generated to final, the residual patch upstream to final, `seam` in PORTED.json); `extract` must then leave the tree unchanged. [T0.8]
- TanStack Router wraps `window.history.replaceState`, so an address change from the bridge became a route change that remounted moss's whole App (a second doc socket, the pending focus lost); the bridge writes through `History.prototype.replaceState`. [T0.8]
- Moss's split rule is total through an `atoms.ts` seam, installed ahead of T1.6 because a split back to the left pane's note crashed the M0 app: split back or forward to the left pane's note, and any left-pane move to the split's note, closes the split. The session registry refuses a second session for a doc without throwing; the refused pane mounts no plugin and binds once the holder lets go. [T0.8]
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
- `@lexical/react`'s ContentEditable gives a non-editable root `tabindex=-1`, so the gate removes it while the body is closed (R2). The pane goes live in the same render as the root turns editable (React state; a store snapshot renders on its own, first), so moss's pending focus finds an editable root. [T0.8]
- `data-sync-unacked` turns `1` in the tick of a local write and `0` on the DocDO ack that covers it; a journey waits for `0` before a reload. moss's bottom toolbar carries `data-floating-selection-toolbar` (a MarkdownEditor seam), so invariant 5 allows it as it does the selection bar. [T0.8]

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
- The DocDO harness (`packages/sync/test/harness`) runs the real class in Node over `node:sqlite` with fake hibernatable sockets; a wake is a fresh instance over the same backing. Every DocDO RPC starts with `ready()` (partyserver's `__unsafe_ensureInitialized`) except `probeInstance`, which must never start the DO it measures. [T0.7]
- An update larger than one 1.5 MB state chunk is never logged as a row: it compacts instead, since a row caps at 2 MB. Server content writes (seed, import) go through `serverWrite` in `packages/sync/src/server-doc.ts`, which diffs a headless mirror onto the live doc and releases the mirror first. [T0.7]
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
- The Ladle oracle (T0.5a, no deploy key): the `oracle` job runs `e2e/parity/oracle/build.mjs`, which writes moss@pin with `moss-vendor.mjs pristine`, adds main.tsx's font imports and builds Ladle from its own lockfile (`node-linker=hoisted`, as moss). moss's `manualChunks` form a cycle under Ladle's Vite 6 and the built oracle throws before rendering, so `vite.oracle.mjs` drops them. Story ids are `app--default` and `app--empty-notes`. Dispatch `-f lane=parity` for the oracle and parity alone; the `parity-<attempt>` artifact holds each target's triptych, diff and metrics. Locally: `node e2e/parity/serve-static.ts <oracle dir>`.
- `actions/upload-artifact` skips hidden paths such as `.oracle` unless `include-hidden-files: true`.
- Local QA, the change's one browser pass: `node scripts/stack.mjs start`, then `node scripts/qa.mjs open --run-id <id>` (one local headless session on this host). `qa.mjs shot --run-id <id> [--as ada] [--path /]` mints the principal if needed and writes a 2880×2000 PNG to `.local-stack/runs/<id>/shots/`; `qa.mjs run --run-id <id> FILE.js` runs a script after the prelude (`STACK`, `P`, `DOM`, `NAMES`, the detectors as `D`, and `e2e/qa/prelude.js`: `actor(label)` in its own context, `visit`, `waitAttr`, `typeBody`, `bodyText`, `shot`, `detect`, `sockets`, `freeze`). Scripts cannot import and cap at 120 s; `qa.mjs close` before stopping the stack.
- Latency budgets (T0.9b): assert one only after its latency has a row below from a `-f lane=e2e -f repeat_each=5` dispatch in both engines, and write its headroom (budget ÷ p95) beside it. Each shard's summary prints the latency and duration percentiles (nearest rank, so with n ≤ 20 the p95 is the slowest sample); add a row when a new timed leg lands. At M0 no PRODUCT budget applies yet; peer text 2 s, cursor tracking ~1 s and the title ~5 s get rows with j01 and j02. A ready-PR shard took 2.3 min in Chromium and 3.8 min in WebKit (run 37069879777) against its 13. Run 37070433672, j00-shell:

  | Latency or test | Chromium n, p50, p95 | WebKit n, p50, p95 | Budget |
  | --- | --- | --- | --- |
  | reload to `data-app-state=ready` | 10, 483 ms, 527 ms | 14, 676 ms, 802 ms | none yet |
  | theme switch (click to `data-theme`) | 10, 9 ms, 13 ms | 12, 11 ms, 26 ms | none yet |
  | the slowest j00-shell test's duration | 5, 5.3 s, 5.4 s | 7, 10.9 s, 125.5 s | 120 s test timeout |

- WebKit on CI's Linux runner has a heavy tail that Chromium lacks: the same j00-shell legs take 15–66 s now and then (T0.5a's run 37041229592 already showed 16 s), and under `repeat_each=5` one fresh context waited 124 s on three module scripts (wrangler's log has no slow response), while a second attempt's wrangler slowed to 10 s sign-ups and exited with an empty `[ERROR]` after about 60 WebKit tests. Before calling a WebKit timeout a product failure, read its trace's network timings and the shard's `wrangler.log`.
- Agent results are null-guarded and schema-typed, with severities P0, P1, P2. [L§4.19]
- Journeys import `test`, `expect` and `ui` from `e2e/lib/test.ts` only; its auto fixture checks the 9 invariants on every actor after every test. Declare intended exceptions on the actor (`expectHttp`, `expectReconnects`, `declareRemount`, `actors.solo(reason)`), never by loosening a detector. Typed strings must be distinctive (never a substring of other text in the field), since invariant 7 counts exact occurrences.
- A new detector or invariant ships with a fault fixture in `e2e/selftest/fixtures/faults/` that only it flags.

## Environment

- The primary machine (host_37m3sgpq59) is shared and often loaded: one graded browser run at a time. Never build on a host running a bb dev stack or Nightly. [L§5.1]
- Never record credential values. Probe Codex quota with `codex exec "reply OK"`. Commit a brief before passing its path; inline prompts near 5 KB get cancelled. [L§5.5; L§5.6]

# moss-multi build plan

The plan of record for M0–M8. It follows LEARNINGS §7.2, adapted to the surveys, the restart rulings and the three architecture critiques of 2026-10-02.

- **Inputs:** [PRODUCT.md](PRODUCT.md) is the contract; it is re-read before every brief. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), cited here as `A§n`, says how it is built. Where the test-infra survey (S-test) disagrees with either, they win (A§20).
- **Progress:** [PROGRESS.md](PROGRESS.md) carries one overall % (finished task-days over planned task-days, M0–M8) plus an inline milestone/program visual and the month's CI minutes, updated in the same commit as every dispatch and verdict. [L§1.10]

**Before T0.1** the owner settles OA2 (an Actions budget of about 3,000 billable minutes a month, see Spending) and receives the OA3 list for T1.10 (A§22).

**Conventions**

- **Tasks.** `Tm.n` is one implementer agent's work, at most one working day including CI round trips. `[A·codex]` means lane A with a cross-vendor checker; `fresh` means a same-vendor independent checker.
  - Different lanes touch disjoint files. The DocDO is split into modules with one owning lane per milestone (A§5.1). Up to about 6 tasks may run at once across milestones (owner asked to up the pace, 2026-10-04), and at most 5 local stacks exist (`scripts/stack.mjs` enforces this; `MOSS_MAX_STACKS` overrides).
- **Tests first.** The named tests are written and pushed first. A CI dispatch must show them red on the named product assertion; infrastructure failures don't count.
- **Done.** The evidence the checker re-derives. "Shots" are 2× PNGs from `scripts/qa.mjs` on a clean tree, decisive ones only. A surface moss lacks is done only with a glyphdown | ours | neighbouring-moss triptych the checker has read, using the T0.11 reference shots.
- **Journeys.** One living Playwright suite under `e2e/journeys`, UI-only, with ≥ 2 distinct per-run `@example.invalid` principals, run in Chromium and WebKit in CI.
  - The 9 global invariants (A§20) apply to every journey from the milestone they go live.
  - A missing affordance is a FAIL, never BLOCKED. A control whose backend lands later is `staged:<M>` in the bridge inventory: minimally real or hidden until then, and CI fails once milestone M closes with it still staged (A§9).
  - Grants made through the members API are declared setup for journeys whose promise is not sharing. j01's setup leg and every sharing journey go through the UI.
  - Every leg carries the `@p:<id>` tags of the trace rows it proves.
- **Tier A.** Any task touching the reading view, top bar, login card, denial page or share landing runs its legs `@tierA` and attaches a 390×844 / 1440×1000 pair.

**Changes from LEARNINGS §7.2**

- **R7 removed the playground,** so a minimal login card ships in M0 and person-sharing in M1.
- **Vault switching and shared-doc discovery are in M1,** so a person can find what was shared with them; vault creation stays in M3.
- **Folders and trash move to M2,** next to the access work that shares their fan-out paths. Their entry points are staged (hidden) until then.
- **The "a server-created doc renders identically" gate starts in M1** through the import endpoint, not in M7. [L§7.1 #7]
- **Decorator registers land in M1,** because code blocks are co-editable from M1. [L§4.3]
- **A staging canary runs from M1 exit onward,** not only at M8. [L§0; L§7.1 #3]
- **Settings → Agents lands in M3,** before the CLI needs keys.

## Trace

Each PRODUCT line and restart ruling has owning legs. A row with no tagged leg by its milestone blocks that milestone; `scripts/ci/trace.mjs` enforces this in `checks`. R5, R6 and R12–R14 are process rulings owned by The loop and A§.

| Id | PRODUCT line | Owning legs | M |
|---|---|---|---|
| col-1 | Two clients co-edit live (two people, or one person in two windows); no lost work; identical convergence | j01 typing, same-principal, split-pane and code-block legs | 1 |
| col-2 | Face pile and per-client cursors in one color, label while typing, ~1 s tracking, prompt clear, distinct and stable colors | j01 presence legs, including 3 peers | 1 |
| col-3 | Cmd+Z undoes only your own edits; programmatic writes add no step | j01 undo legs; j18 push leg | 1, 7 |
| col-4 | A brief disconnection buffers losslessly behind a truthful indicator | j03 | 1 |
| col-5 | The title is shared state: ≤ 5 s everywhere, merges, never clobbered | j02 | 1 |
| col-6 | An existing doc reopens with content; a new note has an editable title and one paragraph | j00-persist; j04 | 0, 1 |
| note-1 | Docs are files; the H1 is content; wiki links resolve by stem | j02 filename legs; j12 | 1, 3 |
| note-2 | Every node family styled; Electron-only surfaces web-adapted | j14; j11 HTML, embed and browser legs; T3.7 | 3 |
| note-3 | Content extensions stay in the markdown; exports are clean | j15 export; j18 pull; T3.7 download | 3, 4, 7 |
| note-4 | Folders and vaults are created, switched and trashed in the web UI | j01 discovery legs; j06; j13 | 1–3 |
| note-5 | Delete is 30-day trash; a fresh load 404s; open peers go terminal (notes and folder subtrees) | j05; j06 peer-lock leg | 2 |
| note-6 | No title field discards typed input; WebKit Backspace never navigates | j02 bind and "+ Note" legs; invariant 9 | 0, 1 |
| note-7 | Search and backlinks across everything you can access | j12 | 3 |
| note-8 | Moss's media set, shareable; YouTube; HTML is content; upload needs editor | j11, including an anonymous-link leg | 3 |
| ppl-1 | Email+password auth; OAuth only when configured; open sign-up; copy-link invites | j07; T2.8 legs | 0, 2 |
| ppl-2 | Share vault, folder or doc with a person or agent at a role, or by link; anonymous view; sign in to do more; demotion bites live | j01 setup; j08; j09; j18 agent-grant leg | 1, 2, 7 |
| ppl-3 | The bell notifies on mention, share-invite, suggestion and reply | T2.8 legs; j15; j16 | 2, 4, 5 |
| mean-1 | Moss's full comment experience plus reactions; typing after commenting | j15 | 4 |
| mean-2 | Suggestions: accept or reject; a violation never lands and is never silent | j16; j18 `--suggest` | 5, 7 |
| mean-3 | History: auto and named versions, read-only view, diff, anchor-safe restore | j17 | 6 |
| agt-1 | CLI agents pull, push and sync; pushes merge with live typing; Bot presence | j18 | 7 |
| agt-2 | Folder-watch daemon | T7.4 legs | 7 |
| agt-3 | Agent panel present and inert; unworkable affordances hidden through one registry | j00-shell registry legs | 0 |
| tech-1 | The Lexical tree in a Y.Doc via @lexical/yjs | j00-roundtrip; L1–L4 | 0 |
| tech-2 | Title and frontmatter live in the shared doc | j02; T1.4 Properties leg | 1 |
| tech-3 | Comments and suggestions are CRDT data with derived paint | j15; j16 | 4, 5 |
| tech-4 | One converter | L3; G1 | 0, 1 |
| tech-5 | CLI push is a structural merge | j18 | 7 |
| tech-6 | One DO per doc; restore after hibernation is a permanent gate | j04; the staging canary | 1 |
| tech-7 | A content write merges or is refused loudly | T0.5b bridge control; j16; j18 | 0, 5, 7 |
| tech-8 | 2 MB/doc, 50 connections, 60 pushes/min | T1.3 4429 leg; j18 cap and 429 legs | 1, 7 |
| tech-9 | Tier A works at 390 and 1440; Tier B never traps an affordance | j07 card pair; j10; T2.7 trap sweep | 0, 2 |
| R1 | Pin 762abb777 with `ported-from` headers | vendor drift check | 0 |
| R2 | No field accepts focus before bind | invariant 9; j02 | 0, 1 |
| R3 | The title is the one name; filename and D1 are projections | j02 filename legs; j12 | 1, 3 |
| R4 | Electron-only surfaces as PRODUCT says | T3.7; j11 browser leg | 3 |
| R7 | No playground | j00 unknown-route and hook-404 leg | 0 |
| R8 | Demo content in a test account, built through the UI | j14; T8.5 | 3, 8 |
| R9 | The daemon follows glyphdown's sync model | T7.4 | 7 |
| R10 | Transient failures degrade in place | j07 degraded leg; j03 retrying leg | 0, 1 |
| R11 | Per-viewer layout stays local | T1.6 layout legs | 1 |
| R15 | Staging only, personal account, permanent names | T1.10; T8.2 | 1, 8 |
| R16 | Rejecting or withdrawing a suggestion keeps other people's words | T5.0 reject and withdraw legs; T5.3 | 5 |
| R17 | A pending suggestion lives beside the body until an editor accepts it | T5.0 spike legs; j16 | 5 |
| R18 | A comment never jumps to other text; retyping the same text does not reattach it | T4.0 never-jump and undo scenes; T4.2 | 4 |

---

## M0 Foundation

**A person can newly** open the real moss shell, light and dark, from the built Worker on a local stack; sign up, sign in and sign out on a moss-styled login card; click "+ Note", type, reload, restart the stack, and still see the text. CI proves it with provenance on every PR.

- **T0.1 Repo, toolchain, CI skeleton: the loop pilot** `[A·fresh]`
  - **Scope:** pnpm workspace with A§3 pins and overrides; lint, including a no-raw-color rule for `packages/ui` and bans on `[contenteditable=true].first()` in `e2e` and on `HISTORIC_TAG` in host and vendor code; `ci.yml` with plan, checks, build and ci-ok, plus a checks-only dispatch lane (about 5 min); `scripts/ci/{plan,minutes,trace}.mjs`; `.node-version`; seed `docs/METHOD.md` with the L§4–5 gotchas and the anti-stall preamble, and `docs/DEVIATIONS.md` with A§23.
  - **Pilot:** this task runs the whole loop alone (brief, red dispatch, green, a checker on a fake run that validates the verdict schema) before any lane opens. [L§6 pilot; L§4.19 hygiene]
  - **Tests first:** `plan.mjs` unit tests; a single-version check that `lexical`, every `@lexical/*` and `yjs` resolve to one version each, red on a fixture lockfile; `trace.mjs`, red on a row with no tagged leg.
  - **Done:** ci-ok is green on a draft PR; a deliberate lint violation and a `HISTORIC_TAG` import each turn checks red; `minutes.mjs` prints the month's use.
- **T0.2 Vendor moss and the collab plugin** `[B·fresh]`
  - **Scope:** `scripts/moss-vendor.mjs` with vendor, repin, pristine and drift modes; moss@762abb777 vendored verbatim with `ported-from` headers; @lexical/react 0.48.0's collab plugin files vendored (A§2.1).
  - **Tests first:** the drift test fails on a one-byte change to a verbatim file and on a missing header.
  - **Done:** the drift check is green in CI, and `PORTED.json` lists every file with 0 patched.
- **T0.3 Worker skeleton, provenance, stack launcher** `[C·fresh]`
  - **Scope:** the Start app; `server.ts` in A§4.1 order with stubbed handlers; `/api/version`; the provenance plugin with SSR meta and client stamp; `wrangler.jsonc` with local bindings and all three DO classes; `scripts/stack.mjs` (start, stop, restart, pause, resume, verify, reap, principals), which records host state (a bb dev stack or Nightly running, 1-minute load) with every run so local deaths are classed as infrastructure [L§5.1]; `scripts/provenance.mjs`. SP1 is settled here.
  - **Tests first:** router units: POST `/api/version` gets 405; an unknown party gets 404; client `x-moss-*` headers are stripped; upgrade headers survive the clone. A CI smoke step: build, start the stack, check `/api/version` equals the commit, and check the CSS asset returns 200 `text/css`.
  - **Done:** the build and smoke jobs are green, and a local `stack.mjs start` prints a clickable `http://127.0.0.1:<port>`.
- **T0.4 D1 schema and auth core** `[C·codex]`, after T0.3
  - **Scope:** the A§6 schema as a drizzle-kit `0000_init`; `createAuth` per request with email and password, explicit rate limits, the fail-closed checks and the Home-vault hook (A§7); principal resolution; `/api/me`; minted principals.
  - **Tests first:** DDL parity, red when one `onDelete` is removed from the SQL; fail-closed cases (missing, placeholder or short secret; hooks on a non-loopback URL); sign-up without `Origin` gets 403 and with it gets a session; the Home vault is created exactly once; with production limits, repeated sign-ins from one `cf-connecting-ip` get 429.
  - **Done:** CI is green, and two principals can be minted on a local stack.
- **T0.5a Moss shell host and shell parity** `[A·fresh]`, after T0.2 and T0.4
  - **Scope:** the client entry order (A§4.3); root CSS, fonts and theme script; the per-request CSP nonce (SP13); `MossAppHost`; `/d/$docId`; Tailwind config plus a coverage test; `ChunkReloadBoundary`; the parity job with shell targets.
  - **Tests first:** journey **j00-shell**: two principals each boot with zero console errors, page errors and `securitypolicyviolation` events; provenance meta matches on navigation; a stylesheet is linked; light↔dark works through the real Settings toggle; the floating detector passes its live negative control; a script inside an injected `data:` iframe runs under the page CSP; `/__test/*` and a playground path return the unknown-route 404.
  - **Done:** j00-shell is green in both engines; `shell-default` and `shell-empty` triptychs in light and dark meet ≤ 0.05% with a largest blob ≤ 16 px², diff images read (oracle from OA1 or the A§22 pristine fallback).
- **T0.5b Bridge, inventory, hide registry, DOM-contract seams** `[A·fresh]`, after T0.5a
  - **Scope:** a bridge with every namespace (A§9), where `GET /api/workspace` and `POST /api/docs` are real and the rest follow the table, `staged` entries included; the inventory; the hide registry; every A§2.2 seam on the shared DS primitives and the notes list, installed once.
  - **Tests first:** the inventory and affordance drift tests, red on an unlisted method and on an expired `staged` entry; a bridge unit test: `notes.update({content:''})` rejects loudly and sends no request; j00-shell legs: no hidden or staged affordance is in the DOM, and every opened DS menu or dialog carries `data-overlay-surface`.
  - **Done:** j00-shell is green in both engines.
- **T0.6 One converter: extraction and workerd smoke** `[B·codex]`, after T0.2
  - **Scope:** `moss-vendor.mjs extract` and its AST symbol manifest, generating the S-conv §2.3 split (`markdown/*`, `commands.ts`, 8 class/view splits, node views with per-view error boundaries) from pristine upstream as `mode: extracted` (A§2.1, A§12); deterministic formula ids; the line-loss fix; the headless converter host in `packages/sync`; the dependency rule (A§4.4).
  - **Tests first:** re-extraction from pristine reproduces the committed bytes; L1 fixtures for every family in S-conv §5.4 (goldens and a fixpoint); an L2 workerd import smoke, red on the unsplit tree with its TDZ error; L3 parity with the pristine pipeline; negative controls: remove `IMAGE_TRANSFORMER`, move `EMBED_PILL` after `LINK`, move moss-html after `CODE`, and import a view into the converter closure.
  - **Done:** L1–L3 are green, and the PR records Worker upload size, cold start, peak heap, 2 MB import/export CPU and the state-to-markdown size ratio over the family corpus (SP2).
- **T0.6b Whole-document import within the DocDO CPU budget** `[B·codex]`, after T0.6
  - **Scope:** SP2 measured a 2 MB import at 54 s of workerd CPU, over the 30 s limit. Moss's TABLE and raw-URL transformers call `selectEnd()` during import, and while a RangeSelection exists every `remove()` pays `getIndexWithinParent()`, so import is quadratic in blocks. A marked seam makes `$importNoteBody` run with no selection; typing and moss's paste conversion keep the caret move. PRODUCT's 2 MB/doc stands.
  - **Tests first:** the SP2 step fails any scale-note import up to 2 MB over 5 s of workerd CPU (red at 54 s); L1: a whole-document import leaves no selection (tables, a raw URL with a trimmed suffix, a selection held before), while moss's own conversion still gives a table the caret.
  - **Done:** L1–L3 are green with every family's goldens and fixpoints unchanged, and the new SP2 table, including the 2 MB import into a bound Y.Doc, is in METHOD.md.
- **T0.7 DocDO persistence, seed, socket route** `[B·codex]`, after T0.4 and T0.6
  - **Scope:** the A§5.1 DocDO core in modules (persistence, admission and gates, projections, awareness): load, persist, compact, seed, `serverWrite`, export cache, acks, `onConnect` order, the write classifier with loud refusal, limits, the `ready()` RPC guard, `probeInstance`. Also the `/parties/doc-d-o` route that never refuses before the upgrade (A§4.1), `POST /api/docs` calling `DocDO.create`, the test hooks and the owner-only instance route (A§19), and a Node DO harness.
  - **Tests first:** harness: replay order; 1.5 MB chunking; compaction keeps RelativePositions valid; seeding is idempotent and writes no title text; a viewer's connect and post-wake step 2 frames are accepted silently, while a viewer frame that would change the doc gets write-refused and 4403; a missing or denied doc's socket opens and closes 4404, never 1006. Journey **j00-roundtrip**, protocol-level with YProvider and a headless V1 binding: seed, edit, `stack.restart()`, reconnect and see the text, with the instance id changed.
  - **Done:** the harness and j00-roundtrip are green in CI (the server half of SP3).
- **T0.8 The bound moss editor in a browser** `[A·codex]`, after T0.5b and T0.7
  - **Scope:** the MarkdownEditor `collaboration` seam and the full `useMossMultiPane` call-site set (A§2.2 rows 1–2, installed once); the four vendored plugin seams (A§10.2); the doc session and hardened provider (A§10.1); the first-sync mount gate and readiness attributes (A§10.3, A§19); type-aware exclusions; `data-editor-generation`.
  - **Tests first:** journey **j00-persist**: "+ Note"; the body is not focusable before `data-body-binding=live`; type text with spaces, punctuation and "é"; reload; the bytes are exact. Exactly one `/parties/doc-d-o/<id>` socket for 60 s, no generation bump across a metadata refresh, and no reconnect across a pane rerender. A unit test for the exclusion map's type fallback.
  - **Done:** j00-persist is green in both engines, with a shot of the note after reload (SP3 complete).
- **T0.9a Journey library, invariants, selftests** `[D·fresh]`, after T0.3; time-boxed to one day
  - **Scope:** `e2e/lib` (actors, telemetry, invariants 1–9, sever, hibernate, UI verbs, measure, reporter, InfraBlocked), built against fixture pages only; principals plug in after T0.4. Selftest fixtures (S-test §3.8), plus one proving the WebKit bare-Backspace leg fails on the CI engine with the guard removed (SP15).
  - **Tests first:** each selftest fixture violates exactly one invariant and must be flagged; the clean fixture yields no findings.
  - **Done:** every detector is proven red, and the selftest projects are green.
- **T0.9b Journey CI jobs and `qa.mjs`** `[D·fresh]`, after T0.9a and T0.5a
  - **Scope:** the e2e job sharded by journey group with one stack per shard; `@slow` legs (60 s holds, soaks, idles) run at milestone gates and nightly; the `scripts/qa.mjs` bb Browser Automation prelude (S-test §4.4); a p95 headroom table from `repeat_each=5` before any latency budget is asserted. `red-proof.yml` lands with the first defect-fix brief and overlays `packages/protocol/src/dom-contract.ts` with `e2e/` (A§20).
  - **Done:** each ready-PR shard finishes in ≤ 13 min; `qa.mjs` writes a 2880×2000 PNG of the local stack; the p95 table is in METHOD.md.
- **T0.9d Shard capacity and WebKit editing flakes** `[D·fresh]`, coordinator 2026-10-05, on m1: split journey groups so every shard's p95 is ≤ 9 of its 13 min in both engines, enforced by `plan.mjs budget` over recorded minutes (`durations.mjs`); fix the root causes of the WebKit editing-shard flakes with repeat_each probes; done at two consecutive green full lanes with no reruns and the duration table in METHOD.md.
- **T0.10 Login card** `[C·codex]`, after T0.4 and T0.5a
  - **Scope:** a `/login` LoginCard with glyphdown's layout, composed from vendored moss `input`, `label`, `button` and `card` (new variants only where moss lacks them, each with a story); sign in, sign up, and sign-out with a JSON body; a single auth-state writer; the `beforeLoad` degraded state (R10).
  - **Tests first:** journey **j07-auth**: sign-up lands in the Home vault shell; sign-out goes to login; sign-in returns to the same doc through `next`; a wrong password shows a message; no OAuth button renders; a session lookup failed with `page.route` shows `data-app-state=degraded` and retries in place with no redirect.
  - **Done:** j07 is green in both engines, with card shots at 1440×1000 and 390×844 (Tier A).
- **T0.11 Glyphdown reference shots** `[D·fresh]`
  - **Scope:** build glyphdown@faf98d0 from a temp copy of `.refs/glyphdown` on one local stack (L§5.2) and capture 2× light and dark shots of the login card, share dialog, presence and cursors, connection pill and offline banner, bell and inbox, vault switcher, history page, suggest mode and SuggestionsPanel. Attach them to the M0 milestone PR with `gh pr edit --attach` and index the URLs by state in `docs/design/glyphdown-reference.md`. Delete the temp copy.
  - **Done:** every surface named in PRODUCT's intro has a light and a dark reference in the index.
- **T0.12 One Origin gate for cookie credentials** `[C·codex]`, after T0.7 and T0.10
  - **Scope:** a push security review found that `/parties/doc-d-o` admitted a cookie session from any Origin, so a same-site page (another port on 127.0.0.1, a sibling subdomain) could open a signed-in doc socket; cookie-authenticated `/api/*` mutations had the same gap. One gate, `worker/origin-gate.ts` (A§18): a principal that came from a cookie needs the app's Origin on a socket upgrade or an unsafe method, else REST answers 403 and the socket closes 4401 after the upgrade. Bearer tokens, agent keys and a share token alone pass; a request with a bearer is judged by it and never falls back to its cookie. better-auth keeps `/api/auth/*`.
  - **Tests first:** party and `/api` router units: a cookie with a foreign or missing Origin is refused on upgrades and mutations, a cookie with the app's Origin is admitted, a session bearer and an agent key pass without Origin, a cookie beside a failed bearer is not used, and a share token alone gets the same verdict from any origin. A j00-roundtrip leg: a page on another port opens the doc socket with the signed-in principal's cookie and closes 4401 without receiving doc state.
  - **Done:** the units and the leg are green in CI, each red on the pre-gate bytes.

- **T0.13 Read-only viewer entry, first slice** `[B·fresh]`, after T0.8. Requested by the owner for the bb Moss viewer plugin (thr_imhynzt3h5, relayed by thr_7za4t3fuac); it must not delay the rest of M0.
  - **Scope:** `packages/viewer`: a versioned browser bundle (ESM entry, CSS and moss's fonts) exposing `mountMossViewer(el, { markdown | state, frontmatter, layout, theme, services })` in an unbound read-only mode. It reuses the exact extracted converter, nodes and views from T0.6/T0.8; there is no second renderer. No login, Y.Doc, WebSocket, Cloudflare dependency or file writes. `services` is injectable per viewer: asset URLs (including Range video), note lookup (ids, titles, headings), navigation and unfurl. Tabs stay switchable. A `viewer.json` manifest records the moss pin, repo commit and bundle hash.
  - **Moss-file compatibility:** a leading `# Title` H1 becomes the title through the A§12 moss-interchange path; legacy `[[Title|note-id]]` links resolve through the injected note lookup; the `layout.json` sidecar applies; `%%m:` comment markers never render.
  - **Tests first:** a read-only acceptance fixture modeled on a real moss note with tabs, tables and tweet embeds (synthetic content, never the owner's own notes); assertions that the mounted viewer opens no socket, sends no write, accepts no input, renders the title once, hides markers, and resolves assets and links only through the injected services. A CI job builds the bundle and screenshots the fixture in Chromium and WebKit.
  - **Done:** the bundle and manifest are CI artifacts, the fixture shots are read, and the consumer thread has the entry API.
- **T0.13b Viewer HTML previews from moss's cached screenshots** `[B·fresh]`, after T0.13, owner-approved via thr_6fabbskqcf: until T3.8, `packages/viewer` 0.2.0 shows a HTML block's screenshot from moss's cache (`assets/.moss-cache/html-preview/html-preview-<moss hash>.png`, then the legacy `assets/html-preview-<hash>.png`) through `services.assetUrl`, else the unavailable state; nothing runs the HTML, API v1 unchanged; tests first: hash parity with moss at the pin for every cacheVersion branch, and the fixture's cached, legacy and missing blocks in the Chromium and WebKit shots.

**Order:** T0.1 alone (the pilot), then T0.2, then T0.3; lanes open once the pilot's verdicts converge. Then T0.4 ∥ T0.6 ∥ T0.9a, then T0.5a ∥ T0.7 ∥ T0.11, then T0.5b ∥ T0.10 ∥ T0.9b, then T0.8, then T0.13, then the polish task. T0.12 (Origin gate) runs alongside.

**Journeys added:** j00-shell, j00-roundtrip, j00-persist, j07-auth.

**Exit criteria** [L§7.3]: invariants 1–5, 8 and 9 are live and selftested; served bytes equal `/api/version` on every navigation; converter L1–L3 are green for every family; a note reopens with its content after a stack restart; one socket is held for ≥ 60 s with no remount; the shell meets the parity floor in light and dark; the login card works at both widths; the reference index is complete; the critic, starting from `/login`, recognizes moss and finds no dead or native-only affordance among unstaged surfaces.

**M0 hand-off asks** (one plain-language list with a recommendation each): R5's cross-vendor scope and R7 against PRODUCT's dev-flag playground line; deviations 6, 8, 9 and 12 and hidden-tab presence (A§10.7, A§23); and capturing the Ladle oracle on CI's ubuntu Chromium, which changes the owner-gated capture baseline (L§1.1). Until R5 is confirmed, every task in an R5 risk class stays cross-vendor.

## M1 Two people, one note

**A person can newly** share a note with another person, who finds it in their own sidebar without a URL and can switch vaults and back; edit it live together, or in two windows of their own, each window seeing every other one as a chip with a cursor in the same color; rename it from either side; type through a network blip behind a truthful indicator; undo only their own edits; co-edit a code block without losing either side; duplicate a note; and reopen it after the doc hibernates, locally and on staging.

**Lanes:** A for access and discovery (T1.1 → T1.2 → T1.8 → T1.10). B for connection and persistence (T1.3 → T1.7). C for collaborative editing (T1.4 → T1.5 → T1.6 → T1.9). Lanes B and C start alongside T1.1 with declared-setup grants. DocDO modules: admission and recheck belong to A, persistence and gates to B, projections, awareness and registers to C.

- **T1.1 Access resolver and sharing with a person** `[A·codex]`
  - **Scope:** `protocol/roles.ts`; `api/access.ts` (A§8) and the `/parties` admission rules (A§4.1); the members API (owner only, emails hidden from others); ShareDialog v1 with person rows by email at viewer, commenter or editor; the Share button in the top-bar collab slot; the denial surface (A§4.2).
  - **Tests first:** property tests for the MAX fold and the link ceiling; a byte-identical 404 for missing versus inaccessible docs (SHA compare); j01 setup: A shares with B through the dialog; a signed-in stranger opening the doc URL sees the denial page, and its socket closes 4404 without a reconnect.
  - **Done:** the j01 setup is green, and the checker's raw attacks fail (a non-owner share, a viewer write over REST, a viewer write frame).
- **T1.1s Member identity privacy** `[A·codex]`: authorize member reads through ownership and grants only (A§8; P:People; ppl-2); prove signed-in link-only readers get non-disclosing 404s for doc and folder links, preserve grantee names and owner emails, and audit other identity-bearing endpoints.
- **T1.2 Discovery and vault switching** `[A·codex]`
  - **Scope:** glyphdown's discovery model (A§11): directly shared docs and folders surface at the root of the active vault; the vault switcher in the notes-panel header (switch, owned vaults, then shared vaults with role badges, persisted choice), with "Share vault…" staged to M2 and "New vault" to M3.
  - **Tests first:** j01 legs: B finds A's note in their own sidebar without typing a URL, opens it, and the sidebar stays on B's Home; B, holding a vault grant, switches to A's vault and back; no shared row offers move or folder actions.
  - **Done:** the legs are green, with a shot of B's sidebar.
- **T1.3 Connection truth** `[B·codex]`
  - **Scope:** the heartbeat (1 s check, 4408 after 12 s silence, detach without waiting for `close`); the connection-truth reducer; the persistent indicator in the top-bar slot and the DS Banner in the reserved band; close-code dispatch (A§10.5), including bounded handshake failures and the 4420 rate close; the first-sync deadline and `retrying` state; the terminal store; the per-tab socket registry; 4429.
  - **Tests first:** journey **j03-connection**: `routeWebSocket` black-holes B, and the banner shows within 14 s while A is unaffected; B types offline, and after restore both converge to exact bytes. A SIGSTOP leg: the banner shows on every actor within 14 s, no close frame arrives before 4408, and resume is lossless. A negative control: 20 s idle with no banner and no reconnect. A first sync delayed 10 s shows `retrying` and recovers with no remount. A 51st connection goes terminal `conn-limit` with a retry action (protocol-level).
  - **Done:** j03 is green in both engines, with banner shots.
- **T1.4 Title and frontmatter as shared state** `[C·codex]`
  - **Scope:** the A§10.4 title and frontmatter bindings, unstaging Properties (`note-properties`) and Rename (`rename-note`); the DocDO title, filename and `updated_at` projections (an empty title never projects); the new-note-focuses-title step (R2; the "+ Note" opening guard landed in T0.P and now disarms when the title takes focus); the WebKit Backspace guard; the refusal announcer in the reserved band (T0.P's notice over the top bar moves there).
  - **Tests first:** `doc-fields` units: minimal diff, budget fallback, delta caret remap including "aa"→"aaa". Journey **j02-title**: A renames, and within 5 s B's title, sidebar row and breadcrumb update with zero keystrokes in B; A→B→C converges monotonically with no stale flash; concurrent renames merge, and B's mid-edit title is never clobbered; renames cause no remount; emptying a title and retyping it keeps the filename; a bare WebKit Backspace with no focus keeps the URL; the title is unfocusable before `data-title-binding=live` and focused after; on a warm stack, "+ Note" then "hello world" typed at once creates exactly one note, and every key shows a visible refusal. A Properties leg: two people edit different properties at once, both survive, and the header renders after reload.
  - **Done:** j02 is green in both engines, with A/B shots of title, sidebar and breadcrumb.
- **T1.5 Presence, colors, cursors** `[C·codex]`
  - **Scope:** the A§10.7 per-client presence lifecycle and color claiming; FacePile and AvatarChip with stories; the top-bar slot; the cursor overlay with labels while typing; DocDO awareness validation and its cap (SP6).
  - **Tests first:** fast-check color-claim properties (distinct among present clients, stable through joins and leaves). j01 legs: 0 chips alone, 1 each after B joins, 2 each with a third principal, all colors distinct; the caret and selection color equals the chip color; a caret move reaches the peer within 1 s; the label shows while B types; A's chip clears promptly when B closes, and within 8–20 s after a hard drop; a spoofed awareness name is dropped. One principal in two windows (a declared `solo` opt-out): each window shows one chip for the other, and Cmd+Z in one never removes the other's text.
  - **Done:** the legs are green, plus a signature shot: remote caret with label beside the face pile.
- **T1.6 Undo, origins, background writers, layout, split view** `[C·codex]`
  - **Scope:** plugin seams (a) and (b); the title `UndoManager`; background-writer guards (A§10.10; the `--link-selection` highlight landed in T0.P); the local layout plugin, applied after first sync (R11); the floating toolbar hides while the editor is unfocused (deviation 10); the split-view seam (A§10.1); the SP5 stress run.
  - **Tests first:** j01 legs: concurrent typing in one paragraph; Cmd+Z in A never removes B's text, and derived writes add no undo step; "Insert row" adds exactly one row on both sides; a markdown paste in A while B types keeps both; a frame scan finds no excluded key and does find `__type`, `__result` and `__name` (positive controls); table widths, tab widths and collapsed headings persist locally across reload without syncing, and still apply after a peer inserts a table above; the toolbar is absent while the editor is unfocused; two docs in split panes hold one socket each with no #38, and no path shows one doc in both panes; a 60 s two-tab concurrent-typing soak (`@slow`) raises no Lexical #343.
  - **Done:** the legs are green in both engines.
- **T1.7 Reopen after hibernation, and eviction calibration** `[B·codex]`
  - **Scope:** the wake path; every in-memory DocDO value rebuildable from storage; presence re-announcing after idle; `e2e/calibration` and `calibrated.json` (SP4); j04's shared `@hibernate` idle window.
  - **Tests first:** the induction proof fails when the instance id does not change. Journey **j04-hibernation**: reopen after a restart is non-empty; reopen after a calibrated idle shows content; a peer joining after idle sees presence both ways; a warm creator with a cold peer. Every leg asserts the instance id changed.
  - **Done:** j04 is green with the instance-id evidence; `IDLE_MS` is committed and the nightly job is wired.
- **T1.8 Duplicate and server import (G1)** `[A·fresh]`
  - **Scope:** a server-side duplicate endpoint (App seam); `POST /api/docs {markdown}` importing through the converter; the G1 comparator; WebKit authoring through a synthetic `paste` event carrying a DataTransfer.
  - **Tests first:** j00 G1 leg: for every family fixture, a server-imported doc and the same markdown pasted in the UI render the same normalized DOM and decorator counts. A j01 leg: Duplicate from the note menu yields a copy both peers see in their sidebars.
  - **Done:** G1 is green for every family in both engines.
- **T1.9 Decorator registers** `[C·codex]`, after T1.6
  - **Scope:** SP8: the register mechanism (A§10.10) with `Y.Text` registers for `code-block.__code`, `html-block.__rawHtml` and `formula.__formula`, written through the title binding's minimal-diff and caret-remap code; register fields join the exclusions; the converter reads them through node getters; the DocDO mirror and the undo scope include them.
  - **Tests first:** L4 replication for each register; a j01 leg: A and B type into one code block at once and both keep every character; Cmd+Z in a code block undoes only your own typing; export is byte-identical with and without registers.
  - **Done:** the legs are green in both engines. A field that cannot take a register goes to the owner with the data loss stated plainly.
- **T1.9s Register refresh cost** `[C·claude]`: refresh only registers whose `Y.Text` changed or whose nodes an update touched, never a whole-map walk per update or frame, and assign import ids with per-prefix counters (A§10.10; col-1, tech-8); prove a burst of small edits on a 2 MB note of code blocks reads only the edited register, the DocDO mirror stays one pass per write, and 30,000 identical blocks get ids in linear time.
- **T1.R Decorator payload lifecycle** `[C·codex]`, design review: [docs/design/registers.md](docs/design/registers.md) gives each payload its own Y.Doc keyed by the block id, which only the minter seeds and which the DocDO withholds (stored privately, never served) while no element names it and reveals with its original ids when one does, keeping one element per id; proven by `packages/sync/src/register-lifecycle.spike.test.ts`, and briefs T1.F2 (payload docs, gate, undo) and T1.F4 (views, drafting, joining).
- **T1.F2 security requirements** (commit security review of t/T1.F2 3355b7b, 2026-10-04; the T1.F2 checker verifies each with a test):
  - **No reveal by naming.** A withheld (deleted) payload's text may reach only clients that could already read it. A payload id must be unguessable everywhere: 128-bit random, including ids assigned on import, migration or legacy repair (no `prefix:ordinal` ids). Acks, step 1 answers and errors never list a withheld id or its vectors to anyone. A new element naming an id the note never minted stays empty; it does not reveal stored text. Test: a later joiner, a demoted reader and a second editor each name a deleted block's id and receive nothing.
  - **No cap bypass or eviction.** A payload frame for an id the note does not name is accepted only for a bounded number of ids the same connection is minting. Withheld bytes are capped per identity, so one identity's frames can never evict another's withheld payloads (their undo would then lose code). Named and withheld payloads together stay under the doc's state cap.
  - **Bounded work.** Per-frame and per-ack work scales with the payloads the frame touched, never with every payload in the note: acks carry vectors only for touched ids. Payload docs held in memory are bounded (unload the least recently used). Test: many tiny payload frames over thousands of ids stay within a stated CPU and memory budget in workerd.
- **T1.10 Staging canary** `[A·codex]`, after OA3
  - **Scope:** the A§21 names on the personal account (`wrangler whoami` first), D1, R2, secrets, `env.staging`, a fixed pool of test principals, and `deploy-staging.yml` deploying the exact `dist` the suite tested. Before staging carries real docs, the DocDO refuses bundles that predate payload docs (docs/design/registers.md rule 10; a T1.F2 checker P2).
  - **Tests first:** the workflow asserts staging `/api/version.bundleHash` equals the tested bytes and the test hooks return 404; j00-shell, the j01 setup and j04's staging legs (≥ 15 s idle, wake proven through the owner-only instance route, SP14) run against staging.
  - **Done:** the canary is green on staging.
- **T1.F2 Payload docs, the DocDO gate, one undo stack** `[C·codex]`: per [docs/design/registers.md](docs/design/registers.md), each code, HTML and formula payload is its own Y.Doc keyed by `__regId`, synced on the doc socket (message 7), withheld by the DocDO while no element names it and revealed with its original items when one does, one element per id, one Cmd+Z stack across the body and its payloads; proven by `packages/sync/test/harness/payloads.test.ts` (every spike case on the real nodes and DocDO, frame scan, restart, wake resync, acks, cost, and frames needing clocks the server lacks refused), the payload-frame budget through the real DocDO in workerd (`scripts/measure-converter.mjs`) and the j01 register legs.
- **T1.F1 Peer-safe undo** `[C·claude]` (M1 review P0): Cmd+Z never removes a peer's characters typed into a paragraph or text node this client created (A§10.8; col-3); j01-undo covers interleaved typing, a peer inside a word, split and merge, undo after a reconnect, undoing a delete of the peer's words or of the whole line holding them (restored copies keep their author and properties), and a delete in the step that created the line, of the peer's words or of the whole text node or paragraph holding them, and a redo after the peer typed into the line the undo restored, in both engines.
- **T1.F3 M1 review fixes: drafts, unload, large paste** `[C·fresh]`: a peer's Properties change, including changing, retyping, clearing or deleting the edited property, keeps an open field or Add field row (A§10.4; j02 draft leg); reload or close asks while edits are unacked (A§10.5; j03 unload leg); text-diff builds coalesced ops without spreading, so a 1 MB paste over a code-block selection writes its register (unit at n=500,000; j01 paste leg).
- **T1.F3s Bounded server diffs and REST write rate** `[C·claude]`: server title writes (create, REST rename) and the DocDO mirror's register writes diff caller text with a small cell budget over interned tokens, falling back to replacing the changed middle, and each identity's PrincipalDO grants REST writes from a sliding window kept in its SQLite so a wake does not reset it, 429 past it (A§5.1, A§5.2; col-5, tech-8); prove worst-case 200 KB and alternating pairs rename exactly within 20 ms of workerd CPU per request (`scripts/measure-converter.mjs`) a rename past the rate never reaches the DocDO, and an exhausted identity stays refused after its PrincipalDO is evicted.
- **T1.F4 Field views: drafting, joining, moves** `[C·claude]`: per [docs/design/registers.md](docs/design/registers.md), a code, HTML or formula field resolves its payload by id on every write and writes only the user's edit, a caret-hinted minimal diff against the payload as it is now (no whole-value setter from view state on a bound note); it stays open through a peer's move, closes with a notice when a peer removes its block, and is read-only until its payload arrives; Cmd+Z replays each step's own stack items; proven by j01-registers (a joiner mid-draft, warm and cold, opening or typing; moves; removal; payload in flight) in both engines and the BodyUndo unit test.
- **T1.S1 Listings past D1's parameter limit** `[A·claude]` (M1 review P1): the workspace and member listings bind a fixed number of D1 parameters however many notes, folders or members there are (A§8); proven by a principal with 150 shared notes and 150 owned and granted folders, and a note with 300 members, listing completely at their roles with a constant parameter count.
- **T1.S3 A peer's formula edit keeps an unfinished draft** `[C·claude]` (M1 review P1): a peer's change to a formula payload merges into the open popover's unwritten text with register-input's minimal-diff, caret-preserving path (A§10.10; col-1); proven by j01-registers (Ada's unfinished formula keeps her characters and caret while Ben edits it, and both converge after her commit and a reload; a draft Ben's edit makes valid is written when Ada accepts it with Enter or Apply) in both engines.
- **T1.S2 Payload resync** `[C·claude]` (M1 review P1): the heartbeat and visibility resync also send a payload step 1 for every held payload, so a code, HTML or formula block whose frames were lost catches up on the same socket (A§10.5, A§10.10); proven by j01-registers sever legs for each kind, where Ben's socket black-holes while Ada types and, without a reload, Ben's text matches, Ada's later edits arrive and his field takes typing, in both engines.

**Journeys added:** j01-coedit, j02-title, j03-connection, j04-hibernation, j01-registers.

**Exit criteria** [L§7.3 M1]: peer text appears within 2 s; B finds a shared note without a URL and switches back; a rename reaches the title, sidebar and breadcrumb within 5 s, and A→B→C converges monotonically; 0 chips alone, 1 each with two clients, 2 each with three, with the caret color equal to the chip color; one principal in two windows behaves as two users; a hard drop clears in 8–20 s; a sever or SIGSTOP shows the banner within 14 s and resume is lossless; a stalled first sync shows `retrying`; a forced hibernation reopens non-empty locally and on staging; Cmd+Z never removes B's text; concurrent code-block typing keeps both sides; one socket held ≥ 60 s with no remount; nothing is editable before bind; bytes are exact on both peers and after reload; the signature shot is posted inline.

## M2 Workspace and access

**A person can newly** create, rename, move and trash folders; trash and restore notes, with open peers locked in place; see peers' creates and renames appear live in the sidebar; share a vault from the switcher, a folder from its context menu, or a doc, with a person or a revocable link at a role; as a stranger, read a shared link on a phone, sign up and land on the same doc; receive invites in a bell; and watch demotion, revocation and sign-out take effect in open windows immediately.

**Lanes:** A for workspace (T2.1 → T2.2 → T2.3). B for access (T2.4 → T2.5 → T2.6). C for surfaces (T2.7 after T2.4, T2.8 after T2.1).

- **T2.1 Workspace channel** `[A·codex]`
  - **Scope:** PrincipalDO with its channel and `publish`, `fanout.publishMeta` (A§5.2, A§11), metadata-only `onDiskChange`, live `updated_at` sorting.
  - **Tests first:** while B has another doc open, A's new doc, rename and trash reach B's sidebar within 5 s; a bound id never appears as a content change (the remount detector stays clean); the channel stops synchronously on sign-out.
  - **Done:** the legs are green.
- **T2.2 Folders from the web UI** `[A·codex]`
  - **Scope:** the folders API (create, rename, move; editors can create in shared vaults, recorded with `created_by`); the refreshed id↔path map; deleting a folder sends its subtree to trash as a batch; the folder entry points are unstaged.
  - **Tests first:** journey **j06-folders**, from an empty workspace as a naive principal: create a folder, rename it, move a note in, delete the subtree to trash; a peer with a note open inside that subtree goes terminal in place; an editor on a shared vault creates a folder; no "Unknown parent folder" and no bare "Failed".
  - **Done:** j06 is green.
- **T2.2s Moving is the owner's** `[A·security]`: access inherits through the folder chain, so moving a note or folder needs `manage` (the vault owner) on ownership alone, never an editor grant or a share link; editors keep create and rename, and only the owner is offered a drag; tests first: an editor by grant and an editor-link holder are refused a doc and a folder move, and the owner succeeds.
- **T2.3 Trash lifecycle and terminal state** `[A·codex]`
  - **Scope:** trash and restore (owner only), the trash list, and the owner's read-only trash view on the one owner read path for trashed docs (A§8); terminal 4410 on every surface and a 404 on fresh load; one module for retention copy; the sidebar Trash button accepts a drop; the client closes the doc to writes and waits for unacked = 0, at most 5 s, before the DELETE; the Trash items are unstaged.
  - **Tests first:** journey **j05-trash**: A trashes while B types, and an attribute sweep finds every editable surface in B inert, `data-terminal-reason=deleted`, and no reconnect; B black-holed during the trash and then restored goes terminal, accepts no keystroke and makes at most 3 handshakes; a fresh load gets the byte-identical 404; the trash view shows the content read-only with "30 days" copy; restore converges on both; telemetry shows no 4xx noise after the trash. A build test enumerates every retention-copy surface from `deleted_at` writers and delete-route callers, proven able to fail; a 2-day-old doc never reads "Just now".
  - **Done:** j05 is green, with a parity target for the trash view.
- **T2.3s Trash follows the move rule** `[A·security]` (push security review of T2.3): trash, restore, the trashed read and the Trash view need `manage` resolved without a link (the vault owner or a co-owner by an owner grant on the note or a folder above it; never an editor grant, a link or an agent key), a restore that relocates the note is a move (edit on the destination) and only narrows who can read it, non-managers meet the one 404 on a trashed note, and a revocation landing mid-trash or mid-restore wins; tests first in `apps/web/src/api/trash-security.test.ts`.
- **T2.4 Full sharing** `[B·codex]`
  - **Scope:** Sharing by email must not be an account-enumeration oracle (security review of T1.1): an unknown email becomes a pending invite (T2.8) with the same response shape as a known one, the member list shows a pending row by email until it is redeemed, and share-by-email is rate limited per owner. Anonymous share-link holders get no member list. ShareDialog v2: vault, folder and doc targets; viewer, commenter, editor and owner roles; the member list; create, revoke and copy share links. The folder context menu's "Share…" and the switcher's "Share vault…" are unstaged. The link role acts as a ceiling, anonymous visitors get viewer, and "Sign in to do more" returns to the same doc. The token is threaded through every path, including the socket. The `/f/$folderId` landing.
  - **Tests first:** journey **j08-share**: a folder shared from its context menu and a vault shared from the switcher reach B; a viewer link opened signed out reads at viewer and offers sign-in; an editor link gives viewer when signed out, editor when signed in without a grant, and the max when there is a grant; revoked, forged and inaccessible links get byte-identical 404s; non-owners see no emails.
  - **Done:** j08 is green.
- **T2.4s Sharing stays the owner's** `[B·security]` (commit security review of T2.4): a share by email runs the same statements and answers alike for a known and an unknown email, and the owner's member list after either is identical; a co-owner cannot lower, remove or replace the vault owner, and owner access never comes from a share link (even a row that says owner) or an agent key (agents act at most as editors); concurrent shares of one person settle on the highest role in one invite and one grant; tests first in `apps/web/src/api/sharing-security.test.ts` and `roles.test.ts`.
- **T2.5 One kick path** `[B·codex]`
  - **Scope:** `fanout.ts` covering every revocation kind and its recipient DOs (A§8); durable DocDO revocations and `recheck`; the PrincipalDO session registry, its memory of ended sessions, and `endSession`; the client re-asks on 4403 and rebinds read-only with a message.
  - **Tests first:** journey **j09-revoke-live**: demotion closes B's socket with 4403 within 1 s and makes the UI read-only with a message; removing a member is terminal `revoked`; revoking a link closes signed-in riders; sign-out in window A ends window B (`session-ended`); a socket that registers after its session ended closes 4402. Cold rows in j04's idle window: a revoked doc link's first frame after wake never lands, and neither does one on a subfolder doc after its folder link is revoked.
  - **Tests first (from T2.3s's checker):** with real DocDO and PrincipalDO, a revocation landing mid-trash leaves the note live and an editor that had it open recovers to editable without a reload, and an editor left terminal on a live note is moved off it through the kick path.
  - **Done:** j09 and the cold rows are green, and a codex adversarial pass over raw requests and sockets finds nothing.
- **T2.6 Role-gated affordances** `[B·codex]`
  - **Scope:** one capability helper for every moss menu and control. This includes media decorator headers (hover Delete and other mutating controls) in every read-only view, including the T0.13 viewer. Viewer and commenter are truly read-only, decorator controls included (checkbox, slash, tab add).
  - **Tests first:** j08 legs: menus grow with rank; a viewer's checkbox and slash commands send no frame; an unknown role gets no actions.
  - **Tests first (T0.13b checker):** hovering an HTML block in the T0.13 viewer shows no Edit, Fullscreen or Delete button (they appear today and do nothing).
  - **Done:** the legs are green.
- **T2.7 A stranger on a phone (Tier A)** `[C·fresh]`, after T2.4
  - **Scope:** below 640 px the notes panel overlays the canvas, the chrome yields in a set order, Share becomes icon-only with an overflow menu, and the login card, denial page and share landing work at 390 px.
  - **Tests first:** journey **j10-stranger-phone**, `@tierA`, at 390×844 and 1440×1000 with 0, 1 and 2+ collaborators: open the link, read, sign up through the card, land back on the same doc; a revoked and a forged link show the denial page; every control's centre passes an `elementFromPoint` hit test. A Tier B sweep: the share dialog, settings and every menu opened at 390 px keep every control reachable.
  - **Done:** j10 is green, with shot pairs at both widths.
- **T2.8 Invites and the bell** `[C·fresh]`, after T2.1
  - **Ruling 19 (2026-10-05, account squatting):** email is a label, never an authority. Remove T2.4's immediate grant to an existing account found by email: every share by email is a personal invite link, granted only on redemption by a signed-in account, then bound to it. Tests: a squatter who registered the invitee's email gets nothing until they hold the link; the owner's view is identical for known and unknown emails; j08 shows the grantee getting access by opening the invite link.
  - **Owner direction (2026-10-05, after choosing invite links): follow glyphdown.** Port glyphdown's invite flow as the model: `.refs/glyphdown/apps/web/src/api/invites.ts` (collection POST/GET, token landing GET, accept, revoke), `routes/invite.$token.tsx` (landing page), `email.ts` (Resend sending with graceful degradation: when `RESEND_API_KEY` is unset it sends nothing and the UI offers the copy-link), the invite and added email templates, and the bell notifications. Holding the token is the authority, and the accepting account's email is shown to the inviter for transparency. One deliberate difference from glyphdown, under ruling 19: glyphdown grants an existing account immediately. Here every share by email waits for the link to be redeemed, which closes the squatting hole.
  - **Scope:** copy-link-only invites, including pending invites for unknown emails (`/invite/$token`); the notifications API, re-checked against the live grant when read; DS InboxItem and the bell in the top-bar collab slot, pushed through PrincipalDO; mark-read with `keepalive`; the navigation module (A§9).
  - **Tests first:** inviting B makes B's bell show it without a reload, and clicking it opens the doc; clicking a notice mid-sentence drops no keystroke; an invite to an unknown email gives a copyable link that redeems after sign-up; a notice whose grant was revoked is omitted.
  - **Done:** the legs are green, with a triptych against the glyphdown bell.
- **T2.S1 A lost grant kills its invites** `[B·security]` (Slop Cop P1, PR #4): the member remove batch and role-change write end with `reapDeadInvites`, so a co-owner demoted or removed loses their open invites for good and regaining manage never revives them (A§8); tests first in `apps/web/src/api/invites.test.ts`.
- **T2.S2 Folder-link listing at a fixed cost** `[B·claude]` (M2 review P1): a folder link's workspace listing runs a fixed number of queries with a fixed number of D1 parameters however large the subtree, keeping the link's ceiling, scope, trash filtering and role folding; proven by a folder link over 150 subfolders and 600 notes listing completely at the right roles for an anonymous and a signed-in holder, with a constant statement and parameter count.

**Journeys added:** j05-trash, j06-folders, j07 (sign-out severs another window), j08-share, j09-revoke-live, j10-stranger-phone.

**Exit criteria** [L§7.3]: trash closes peers with 4410, every surface is disabled, a fresh load gets 404, an offline peer goes terminal on reconnect, and restore converges; a trashed folder subtree locks open peers; an anonymous link opens at viewer with "Sign in to do more" and works at 390×844; revoked, forged and inaccessible docs get byte-identical 404s and a rendered denial page; demotion closes the socket with 4403 within 1 s and the UI goes read-only; sign-out in A severs B; a viewer's checkbox and slash are inert; a revoked link's first frame after wake never lands.

## M3 Rich workspace

**A person can newly** upload images and video, which render after reload and inside copies, and edit image alt text; see HTML blocks, web embeds and the in-app browser render live and sandboxed; use every moss node family, styled; search with text snippets and follow backlinks; create, rename and trash vaults; mint and revoke agent keys in Settings and share with an agent; and open a note in a new tab and print it to PDF.

**Lanes:** A (T3.1 → T3.2). B (T3.3 ∥ T3.4, then T3.8). C (T3.5, then T3.6 → T3.7).

- **T3.1 Assets** `[A·codex]`
  - **Scope:** upload, serving, Range, the SVG sandbox and SWR caching (A§16); the asset-url substitution; the `images.*` bridge; copies carry media (SP9); "Edit Alt Text…" in a moss-DS image context menu (A§9).
  - **Tests first:** journey **j11-media**: drop, paste and "/media → From computer" for png, jpg, gif, webp, svg, mp4, webm and mov, then reload; a copied note keeps its media; an anonymous link reader sees the media; alt text edited from the image menu reaches the peer and the export; a viewer gets no upload control and a raw upload gets 403; a PDF upload gets 415; WebKit plays video through 206 responses.
  - **Done:** j11 is green, with shots of an image and a video poster.
- **T3.1s Upload bounds** `[A·codex]`, security follow-up to T3.1: uploads need a Content-Length within the cap (411, 400, 413) and are read into one buffer of that length, stopping where the stream outruns it, a per-identity upload window (60/min, persisted in PrincipalDO, link holders also counted by link and IP) gives 429, and a per-vault media quota, held in the asset insert against concurrent uploads, gives 413 (bytes are stored only once their rows commit, and a folder move keeps trashed descendants within the depth bound the quota counts); a test confirms `?share=` rides only the same-origin asset route.
- **T3.2 HTML, embeds, in-app browser** `[A·codex]`
  - **Scope:** the HtmlBlockquoteNode live-iframe seam (until then an HTML block reads "Preview unavailable", since a browser never loads its moss-asset:// screenshot); `/api/unfurl` with `ssrf.ts`; the RemoteWebSurface substitute; remote-image `persistUrl`.
  - **Tests first:** an SSRF unit matrix covering redirect chains, DoH answers with private addresses, obfuscated IPv4, 169.254, CGNAT and ULA. j11 legs: moss-html runs scripts in a sandbox without same-origin, under the page CSP, and cannot reach the parent's cookie; a web embed card renders; a YouTube embed plays; the in-app browser opens a sandboxed iframe with a working "open in new tab", and its back, forward and find controls are absent.
  - **Done:** green, plus a codex adversarial SSRF pass.
- **T3.2s Media admission and the SSRF matrix** `[A·codex]`, security follow-up to T3.1s and T3.2: upload, from-url, cross-note copy and a duplicate carrying media pass one admission (the 60/min upload window, 429, and the vault quota, 413), and the SSRF validator refuses a non-443 port, single-label names, Teredo, `::ffff:0:a.b.c.d`, IDN or fullwidth forms of blocked hosts and DNS answers that are not addresses, on every redirect hop.
- **T3.3 Every node family, live** `[B·codex]`
  - **Scope:** the formula overlay and draft-chip decoration; per-viewer file-link resolution; chart and sketch registers on the T1.9 mechanism; per-decorator error boundaries; computed-style parity against a pristine-moss Ladle oracle story (A§20).
  - **Tests first:** L4 replication and A8 concurrency for every decorator, with no loss; journey **j14-demo-note** builds every family through paste and slash commands in a test account (R8); computed-style parity per node selector.
  - **Done:** j14 is green, with full-window shots of the demo note in light and dark.
- **T3.4 Search and backlinks** `[B·fresh]`
  - **Scope:** the SearchDO port and its DO feeds; `/api/search`; backlinks; wiki resolution by title and stem; headings (A§15).
  - **Tests first:** journey **j12-search**: B finds A's shared doc by body text and gets a text snippet, never "[object Object]"; backlinks survive an edit; an unresolved link shows its unresolved state; inaccessible docs never appear.
  - **Done:** j12 is green.
- **T3.5 Vault lifecycle** `[C·fresh]`
  - **Scope:** the switcher's inline "New vault" row, rename, and an owner-only trash with ConfirmationDialog (A§11), unstaged.
  - **Tests first:** journey **j13-vaults**: create a vault inline, switch, create a note; B, with a root grant, sees it with a role badge; a member sees no vault actions.
  - **Done:** j13 is green, with a triptych against the glyphdown switcher.
- **T3.6 Settings → Agents, agent sharing, the device page** `[C·codex]`
  - **Scope:** an Agents section in SettingsModal (mint once, list with a copyable agent id, revoke through the kick path); the ShareDialog accepts an agent id and tags agent rows (A§8); `/device` styled with moss tokens.
  - **Tests first:** a minted key is shown once; revoking it 401s a raw bearer request and closes the agent's live socket; an agent added by id appears as an "agent" row at its role; per PRODUCT ruling 20, sharing with an agent the caller does not own (another person's agent, or one owned by a co-owner) is refused with the same 404 as an unknown id, in the same guarded write, and a test proves it for a doc and a folder; unit tests for device-flow claim, approve, deny and replay. **Done:** green, with a parity target for Settings.
- **T3.7 Tab and print** `[C·fresh]`
  - **Scope:** Open in New Window becomes a browser tab; Save as PDF prints through `/pdf-export`; Save as Markdown downloads the export.
  - **Tests first:** a new page opens at `/d/<id>`; the print route reaches `data-pdf-export-status=ready` and calls `window.print` (spied); the downloaded bytes equal the export and contain no markers. **Done:** green.

- **T3.8 Read-only viewer, full capability** `[B·fresh]`, after T3.1–T3.4 and T0.13
  - **Scope:** the T0.13 viewer gains everything M3 adds: every node family styled, media and Range video through injected asset services, sandboxed HTML and embeds through injected unfurl, wiki links and headings through injected note lookup, and per-viewer layout. A versioned release artifact for the bb Moss viewer plugin, with pinned provenance: `packages/viewer` gets a real semver (1.0.0) and stops being private, and CI on the integrated head packs it (`pnpm pack`) into the `moss-viewer` artifact together with `viewer.json`, a SHA-256 of the tarball and the source commit. The task does not publish anything itself: after integration the coordinator publishes it as a GitHub Release `viewer-v<version>` on brsbl/moss-multi (installable by URL), because npm has no @moss-multi scope.
  - **Consumer-reported gaps (bb Moss viewer plugin, brsbl/bb-plugins#241):** media decorators must not show the hover Delete (or any mutating control) in read-only mode; X post embeds must follow the viewer theme (moss at the pin hardcodes `theme=light`) and re-render on `setTheme`.
  - **Tests first:** the T0.13 fixture plus j14's demo-note markdown render through the viewer with computed-style parity against the editor's read-only view; injected services are the only network path; video plays through 206 responses in WebKit.
  - **Red first (T3.1 checker P2):** in WebKit, assert that the video player's own reads of the clip are Range requests answered 206 (j11 checks this in Chromium only).
  - **Done:** green in both engines, with shots of the fixture and the demo note, and a release note listing whether moss-html and both consumer-reported gaps are fixed. After publishing, the coordinator tells thr_6fabbskqcf (bb-plugins coordinator; PR #241 is blocked on this release) the version, the release URL and that list.
- **T3.9 Embeddable editor, file-backed (`mountMossEditor`)** `[B·fresh]`, after T3.8. Requested by the owner for the bb Moss plugin, relayed by thr_6fabbskqcf on 2026-10-04. bb ships no Moss renderer or editor of its own, so this package is the only path.
  - Contract (DRAFT, review findings still open): packages/editor/src/contract.ts and docs/design/editor-embed.md (reviewed by Codex, 2026-10-04); the bb host thread thr_w89wd6n29c codes against it.
  - **Scope:**
    - A sibling of `packages/viewer` that mounts moss's own editor, editable, with moss's keyboard shortcuts, slash menu, formatting, every M3 node family and moss's desktop comment UI. Comments are stored as moss desktop stores them, as `%%m:` markers plus the comments sidecar, so files stay byte-compatible with the Moss Mac app.
    - The host implements a small file bridge, the subset of moss desktop's ElectronAPI that file editing needs (the T0.5b bridge already maps the full surface):
      - `read(noteId) -> {markdown, layout, comments, version}`;
      - `write(noteId, files, baseVersion) -> {version} | {conflict}`, whole-file writes debounced as moss saves them;
      - `assets.put(blob, name) -> relativePath` and `assets.url(relativePath)`;
      - `onExternalChange(noteId)`.
    - Events: dirty, saved, conflict and error, for the host's UI.
    - No socket and no server: it never touches moss-multi's sync.
  - **Conflicts with the Mac app:**
    - Every write carries the `baseVersion` it read, and the host refuses a stale write, so the embed never overwrites the Mac app's save.
    - On an external change, a clean editor reloads in place, keeping selection and scroll.
    - A dirty editor shows "Changed in Moss" and offers to reload or keep editing. A write that is still refused stays unsaved, loudly. Nothing is silently clobbered.
    - Merging both sides automatically arrives with M7's three-way merge (T7.x). Live co-editing with the Mac app needs both on moss-multi sync, which is out of scope here.
  - **Tests first:**
    - a fixture host with an in-memory file system;
    - each node family round-trips byte-identically against T0.6's goldens;
    - Cmd+Shift+A adds a comment that lands as a marker plus a sidecar entry the Mac app's converter reads;
    - a stale write is refused, and an external change reloads a clean editor;
    - assets go only through the host;
    - CI builds a versioned `moss-editor` artifact with provenance, as the viewer does.
  - **Done:** green in both engines, with shots, and the coordinator publishes `editor-v<version>` and notifies thr_6fabbskqcf.
- **T3.9a Editor host helpers (`moss-editor-host.js`)** `[B·fresh]`, ahead of T3.9, requested by thr_w89wd6n29c: the contract's pure host helpers as one self-contained ES2022 module with no imports in `packages/editor/src/host/`, held by golden parity tests to Moss desktop's own code at the pin over a table of tricky names, plus a `moss-editor-host` CI artifact (`moss-editor-host.js`, `contract.d.ts`, `editor-host.json` at 0.0.1, API 1, LICENSE); no frame editor.
- **T3.R Restack m3 on m2** `[B·fresh]`, coordinator, 2026-10-05: merge `origin/m2` into m3 keeping both sides' intent: m3's `doc_media` migration becomes 0003, chart and sketch payloads move onto T1.F2's payload docs with T3.3's concurrent-edit guarantees and tests, vendor patches regenerated; done when the full lane is green in both engines.
- **T3.R2 Restack m3 on main** `[B·fresh]`, coordinator, 2026-10-05: merge `origin/main` (M1 and M2, merged after slimming) into m3, keeping M3's behavior and the slim cuts; done when the full lane is green in both engines, the viewer and editor artifacts build, and the diff from main to m3 shows only M3's own work.
- **T3.10 Selection and Share with Agent for the viewer and editor** `[B·fresh]`, requested by the bb-plugins Moss viewer plugin (thr_56zui6aqdc), coordinator-approved 2026-10-06: both handles gain `selection()` (`selection-1`: text, markdown, file lines from moss's save export, heading path, blocks) and an optional `services.shareWithAgent` shows moss's Share with Agent button (`share-with-agent-1`), additive within API 1 as viewer 1.1.0 and editor 0.2.0; tests first in both fixtures and engines, lines golden-compared against the exported file.

**Journeys added:** j11-media, j12-search, j13-vaults, j14-demo-note.

**Exit criteria** [L§7.3 M3]: images and video render after reload, inside a copied note and through an anonymous link; the HTML preview runs in a sandboxed iframe; snippets show text and backlinks survive a save; the demo note shows every family styled, in light and dark, and concurrent decorator edits lose nothing; revoking a key kills its socket.

## M4 Comments

**A person can newly** comment on text and blocks with moss's gutter, highlights and popovers; reply, react, @mention, resolve, and edit or delete their own comments; get mention and reply notifications; and keep typing right after commenting without losing anything.

- **T4.0 Design review** `[—·codex]`
  - **Scope:** `docs/design/comments.md` per the 2026-10-04 design panel: invariants I1-I8, the supported-liveness list, pinned Yjs facts F1-F5, the reserved-writer guard, the frame-scoped anchor engine (gap re-mint, survivor shrink, lost place, exact reattach, lift), the client frame discipline, and the P2 limitation register. The spike proves only the load-bearing properties: guard, pending, F1-F4, bound-editor scenes, never-jump scenes, counted cost. A fresh architect and a codex critic review under the panel's checker rule. The owner gets a one-page summary.
  - **Done:** merged, with red and green CI run ids, and every finding from the six-round history and the panel review dispositioned to an invariant, the P2 register, or a named T4.1-T4.4 test.
- **T4.1 Comment data plane and write isolation** `[A·codex]`
  - **Scope:**
    - `Y.Map('comments')` with `c:<id>` and `a:<id>` records (JSON only);
    - `writeComments` under the persisted reserved client id R (regenerated on collision; the DO's clientID is never R);
    - gate 2b checks (a)-(d) on every sync frame, inert or not, before apply, with no attacker-driven walk;
    - post-apply pending purge plus 4409;
    - compaction moved out of the `update` handler and run only after the purge;
    - the REST comment RPC (create with server-computed quote and 409 anchor-pending / anchor-gone / too-many-overlapping; quote-only create runs one search with the A§13 thresholds and the round-1 similarity fix, needs a unique best match, never runs per frame);
    - marker import writing records through writeComments in the import's turn;
    - clean export;
    - caps: 2,000 records per doc, 60 comment ops per principal per minute, quote at most 10,000 characters, 32 comments covering any one character.
  - **Security requirements carried from the review history:**
    - no client frame lands a write in `comments`: the tail splice, fully held structs, a missing rightOrigin, cycles and unknown roots are each a raw-frame regression;
    - no struct or delete integrates after its frame, and nothing parked is persisted; a frame Yjs throws on mid-apply is purged and refused like a parked one (the spike host does this; the DocDO must too);
    - the guard costs O(frame·log) with no reference walks;
    - anchor and record changes persist in the frame's turn, and indexes are rebuilt at onStart (A§5.1).
    - From m4's T4.1 security reviews (2026-10-04): "cap comments per doc and comment creation per identity" and "run the quote search for a position-less anchor once, at creation or import" are kept above; "reuse `touchedTypes`" is moot by construction (I1 needs no classifier: the guard checks each struct against R).
  - **Tests first:**
    - the T4.0 guard suite against the real DocDO in workerd, plus an inert step 2 carrying an R struct, refused 4409;
    - fast-check: every item in the comments subtree has client R;
    - park, then compact, then restart: no pending state survives;
    - mixed-pending-frame-compacts-only-after-purge: one frame that integrates a valid edit, parks a struct and a delete, and crosses COMPACT_MAX_ROWS, followed at once by a restart; and the same with an integrated update larger than STATE_CHUNK_BYTES (the oversized path). The integrated edit survives; nothing parked persists or is released by a later frame (T4.0 check, 2026-10-04);
    - restart between a deletion and its undo: the comment still reattaches;
    - the onboarding note plus sidecar imports as 4 anchored threads;
    - export contains zero `%%m:` or `{%c:`.
  - **Done:** green.
- **T4.2 Anchor engine and client frame discipline** `[A·codex]`
  - **Scope:**
    - `anchor-frame.ts` wired into the DocDO's pre-GC afterTransaction hook for client and serverWrite origins, flushed through writeComments in the same turn;
    - EP, MI and AI indexes rebuilt at onStart;
    - gap map (including the wrap rule of comments.md §5.2), survivor shrink, lost place with per-list segments over full member subtrees (inside a block, members extend over the frame's adjacent deletions, comments.md §5.3), exact full-mode reattach triggered by an origin or rightOrigin in MI (or, for a re-homed place in an empty restored block, a frame-new list item with neither under that block; or a frame-new item whose enclosing block's rightOrigin is in MI, an undo copy of a member block, comments.md §5.4), lift at depth ≤ 3;
    - orphans with an identical segment set share one walk (decision §4.4): MI is keyed by segment-set group, so a recheck costs one walk and one signature compare per group, and I7's fan-out bound is restated per group;
    - decorator fingerprints, with attribute history reads inside the walk budget;
    - `groupPending` in acks.ts plus the patched provider: replay before step 2, paced at most 40 frames/s; a deleting update is never merged with another update's inserts.
  - **Integrity requirements carried from the review history:**
    - no positioned anchor is ever searched or similarity-scored;
    - no reattach based on undo-copy identity or rightOrigin chains (the fe3c2f8 bypass must stay impossible);
    - a late concurrent insert, a forged far-placed copy, forged edge copies around new text, and a decorator swap each leave the comment orphaned;
    - delete and undo in one frame, DURDU, a batched in-range edit plus deletion then undo, and block and cross-block undo all reattach.
    - m4's T4.1 restore-integrity requirement (security review of t/T4.0 fe3c2f8) is kept as I5 and the forged-edge-copy test; its "check each copy's right origin against the original span" rule is moot by construction, because reattach never reads right origins, only what reads in the lost place.
  - **Per-frame cost (security review, 2026-10-04):**
    - no whole-doc projection, LCS, store scan, container scan or findQuote per frame;
    - work only for comments whose endpoint the frame deletes, whose lost member or re-homed bound a new item's origin or rightOrigin names, or whose empty re-homed block gets a new item with neither;
    - walks within the 4,096-struct budget, failing safe to orphaned;
    - writes only on a re-mint or a status change.
    - m4's T4.1 per-frame cost bound is kept here and in the workerd test below; its "restore index from the frame's own new structs" and "bounded quote compare" bullets are moot by construction (I7: no restore index over the store, no quote compare on positioned anchors).
  - **Tests first:**
    - every supported-liveness scene and every never-jump scene from T4.0, against the real DocDO;
    - an offline journey: type inside a comment, delete it, reconnect, undo → reattached; delete then retype offline → stays detached;
    - fast-check: random concurrent edits never leave an anchored comment on text outside its lineage;
    - workerd budget: a large note with 2,000 comments (hundreds long and orphaned) plus a burst of single-key frames, a frame deleting a char shared by 32 comments, and forged 1-item frames naming lost members, each within a stated per-frame CPU budget recorded in METHOD.md; it also measures the lift and loss writes of a frame that orphans many comments under one deleted block (output-proportional, bounded by the 2,000-record cap);
    - anchor-cost: 500 disjoint comments orphaned by one deleted run, and 500 by one deleted paragraph; a forged one-item frame naming the shared member does one segment walk and work independent of orphan count (T4.0 check, 2026-10-04);
    - anchor-attribute-history-obeys-walk-budget: grow a decorator's historical deleted attributes while keeping the deleting frame fixed; fingerprint work stays bounded and counted (T4.0 check);
    - anchor-index-maintenance-is-frame-bounded: hold the edit and the affected anchor constant while adding unrelated later spans of the same client; index-maintenance work (SpanIndex updates after the flush) is counted with the tree visits and stays constant (T4.0 check).
  - **Done:** green, with the cost section of comments.md updated to the measurements.
- **T4.3 Paint and moss's comment UI** `[B·codex]`
  - **Scope:**
    - highlight paint (SP10) from server `a:` records, plus the read-only overlay of the engine's gap map (comments.md §5.2) on every applied transaction so a bold never blinks;
    - the adapter for moss's 8 call sites;
    - the `CREATE_COMMENT_COMMAND` seam, unstaging `comments`;
    - gutter, popover, threads, replies, resolve;
    - detached threads listed with their quote;
    - Cmd+Shift+A;
    - the reply composer autofocuses;
    - composer minting with anchor-pending retry.
  - **Tests first:** journey **j15-comments**:
    - A comments, then both type anywhere in both directions;
    - two comments in one paragraph;
    - the peer sees the highlight;
    - bold across the commented text keeps the highlight with no blink frame;
    - delete then Cmd+Z restores the highlight;
    - a commenter can comment but not edit;
    - no `%m:` in the DOM.
  - **Done:** j15 green, with shots and parity targets for the gutter, the popover and the detached thread.
- **T4.4 Reactions, mentions, edit and delete, notifications** `[B·fresh]`
  - **Scope:**
    - reactions per principal;
    - @mentions;
    - edit and delete restricted to the author;
    - root delete promotes the oldest reply in one writeComments call, taking the anchor and resolution;
    - notification rows only for user principals re-checked against the live grant (a mentioned agent gets no row).
  - **Tests first:** j15 legs:
    - reactions toggle per principal;
    - an @mention reaches B's bell;
    - a reply reaches the root author's bell;
    - mentioning an agent writes no notification row;
    - deleting a root with replies keeps the thread anchored under the promoted reply;
    - a non-author sees no Edit or Delete, and a raw delete gets 403.
  - **Done:** green, with a reactions triptych.
- **T4.R m4 on the restacked m3** `[B·fresh]`, coordinator, 2026-10-05: merge `origin/m3` into m4; a frame with a missing dependency closes 4420 (transient), and 4409 stays for guard violations (comments.md §3); the doc-session ordering test delivers the server's step 1 first (§6); j11's /media leg fixed at its cause; done when the full lane is green in both engines.
- **T4.S3 Anchor token budget before expansion** `[A·codex]`, Slop Cop P1 on PR #6, 2026-10-06: every token emission is admitted against its walk's allowance before an item is read, a gap that runs out of tokens is cached for the frame (a start-dependent struct walk that runs out fails only its own comment), and a restore walk stops at the place's length (I7); done when anchor-cost's long-item tests (single long run, sibling comments, long restore candidate, fragmented gap past WALK_BUDGET in both orders) are green.
- **T4.S1 Comment writes re-authorize their actor** `[A·codex]`, from M4's Slop Cop review (PR #6, P1): every comment RPC carries the Worker's actor (principal, session or key, share token), and the DocDO re-resolves it in the same serialized write, with or without a socket: a live credential, a live doc and at least commenter, or nothing lands; done when `comment-revalidation.harness` is green.
- **T4.S2 Comment room counts stored payloads** `[A·codex]`, Slop Cop P1 on PR #6, 2026-10-06: comment create, reply, edit, reaction and sidecar import are admitted against the note plus every stored payload (served or withheld), as #overCap counts, keeping the typing reserve; done when `comment-room` is green.
- **T4.S4 The file-backed editor keeps moss's comment path** `[A·codex]`, Slop Cop P1 on PR #6, 2026-10-06: each comment seam branches on whether a pane binds the editor (for the pane's life, not its painter's: a bound editor with its plugin down refuses writes), so an unbound editor runs moss's own MarkNode discovery, local writes, authorship and gutter, with comments.json and the editor API unchanged; done when the editor fixture replies to, edits, deletes and resolves a sidecar thread and reads it back after a reload in both engines with no REST or socket traffic, `shared-mode.test.ts` is green, and j15 stays green.

**Exit criteria:** typing anywhere after a comment replicates exactly; there are no markers in the DOM or any export; the author identity comes from the server principal; a comment never lands on text other than its own.

## M5 Suggestions

**A person can newly** switch to Suggest in the floating toolbar, or be shared as a suggester and locked to it; propose inserts and deletes that others see painted; and have an editor accept or reject them. A violating edit is refused visibly and never lands.

- **T5.0 Design review** `[—·codex]`
  - **Scope:** `docs/design/suggestions.md`, built on the records model:
    - suggesters never write the body;
    - a suggestion is a record of the exact Yjs ops from the author's fork, plus id-precise delete parts;
    - accept is an editor action gated by G0–G8 and bound to a projection-diff hash;
    - reject and withdraw change only the record.
    - A spike proves the role gate, accept equivalence, reject leaving the body byte-identical, the gates, the outdated rule, projectionDiff and O(frame) ingest cost.
  - **Done:** merged, with every review-history and panel finding dispositioned, and the ARCHITECTURE A§5.1/A§13, DEVIATIONS and PRODUCT ruling 17 diffs included.
- **T5.P Suggestions on payload docs** `[B·fresh]`, coordinator ruling, 2026-10-05, a design amendment (docs/design/suggestions.md §14): record ops carry `{doc: 'body' | payloadId, update}`, leases cover the author's payload forks, G4 becomes `payload-alias`, edits to an existing payload are proposals applied only at accept with payload diffs in the hash-bound preview, and reject and withdraw still write nothing; every spike test ported, with payload cases in the forged-frame census.
- **T5.R Restack m5 on m4; T5.2 on payload docs** `[B·fresh]`, coordinator, 2026-10-06: merge `origin/m4` into m5; T5.2's ingest places every struct through `packages/core/src/suggest`'s channel table (no separate register-era checks), takes per-doc ops under per-(lease, doc) clocks, places payload ops against the DocDO's served payloads, drops a closed record's placements, and accept's G8 counts the note plus every stored payload, withheld ones included (A§10); every T5.2 test ported to payload docs; done when the full lane is green in both engines with no suggestions test skipped.
- **T5.1 Suggest-mode client: fork, modes, routing, paint** `[A·codex]`
  - **Scope:**
    - the toolbar toggle and the role-locked "Suggesting" chip;
    - suggester in the share role menu;
    - the fork shim: F = B plus the author's valid open records, with clientID set to the active lease. It forwards every transaction whose origin is not `shim-body-apply` or `shim-record-apply`, so REGISTER_INIT, REGISTER_LOCAL_ORIGIN and the UndoManager are included;
    - the baseline taken after first sync;
    - the composite C and Review mode;
    - Edit-mode wedge, gutter, strike, attribute-dot and hover-preview paint;
    - explicit deletes over body items (Backspace, Delete, word or line delete, Cut, typing over a selection) recorded as id-precise delete parts, with the caret moving past struck text;
    - grouping (30 s idle or one paragraph away), `suggest-merge`, and offline continuation of the active record;
    - dropping UndoManager items when a record closes;
    - mode switches waiting for `data-sync-unacked=0`, with caret restore;
    - the refusal copy-back: close input in the same tick, export the unacked blocks, rebuild F, show "Copy what wasn't saved" until dismissed;
    - title and Properties read-only;
    - background writers off.
  - **Tests first:**
    - journey **j16-suggest**:
      - a solo owner with nothing selected toggles Suggest in the docked toolbar;
      - a principal shared as suggester through the dialog opens locked to the chip;
      - on a cold load, a suggester's first delete leaves the text in the server export and paints a strike;
    - zero ops emitted when F binds, before the first input;
    - every census operation through the real UI with zero refusals: colliding prefixes, Enter before a link, line break or inline formula, Enter in an indented paragraph or quote, lists, tables, checkbox, new code, HTML, formula, chart and sketch blocks, an edit of an original register, undo of a split, join;
    - a record that fails the bind check is marked broken and excluded from C, and Review falls back to B if binding C throws;
    - a record-closed race offers back every unacked block, and typing after the remount lands.
  - **Done:** green.
- **T5.2 Server: role floor, record ingest, leases, loud refusal** `[B·codex]`
  - **Scope:**
    - A§5.1 step 2 floor raised to editor, so a doc-changing frame from role suggester gets write-refused('role') and 4403 before apply;
    - editor and owner body frames naming a leased client id refused `protected-type`;
    - the `suggest_leases` table, and the `suggest-lease`, `suggest-ops`, `suggest-delete`, `suggest-merge` and `suggest-withdraw` handlers;
    - continuation records for frames aimed at an accepted record, and `record-closed` for rejected or withdrawn ones;
    - caps: ops ≤ 256 KB per record, at most 20 open records per principal, all open ops ≤ 25% of STATE_CAP, the projected stateBytes cap, and 300 writes per 5 s;
    - a registry-name check on `__type` values at ingest;
    - a refusal rate limit of 3 per principal per minute, then a 60 s 4429 cooldown;
    - acks driving `data-sync-unacked`.
  - **Security brief** (commit reviews of the old T5.0 spike `vet.ts`, 2026-10-04, carried in full). Seven reviews found authorization bypasses: forged tombstones and GC, same-value writes, embed maps restyling neighbours, recursive container deletes, and decorator `__regId` and register ownership. They also found a per-frame vetting DoS and a parser differential. Required:
    - **Authorization never decodes a frame.** Suggester body writes are refused by role, and `parseUpdateMeta` is bookkeeping only.
    - **Every forged-frame case from the T5.0 review tables is refused.** Each is sent as a suggester body frame, refused by role, and the body bytes are asserted unchanged.
    - **Per-frame DO cost is O(frame bytes) for body frames, `suggest-ops` and `suggest-delete`.** Test a maximum-size forged frame, and show the cost is independent of doc size (small doc against 1.69 MB).
    - **Nothing a suggester sends can be applied to the body except through T5.3's accept.**
    - **Carried from the previous brief (2026-10-04), each now closed by construction or owned here:** "judge exactly what Yjs applies, never a separate decode" is moot for frames by I1 (a suggester's body frame is refused by role before apply; authorization never decodes) and holds at accept, where G1–G5 judge the applied mirror transaction (T5.3); "one invariant: the original projection is unchanged" is moot by I1 and I3 (nothing a suggester sends reaches the body except through the hash-bound accept); "a new decorator names only its own register; an original register entry is never replaced, deleted or re-pointed" is G4 (T5.3); "bound vetting cost per frame" is I5 (no per-frame vetting; O(frame) ingest, tested here); "every forged-frame case, plus a randomized struct-level fuzz" is the role-refusal table here and the T5.4 fuzz.
  - **Tests first:**
    - colliding-prefix typing ("the " before "the …", a duplicated word, a sentence pasted before itself) and an insert outside any existing suggestion are never refused;
    - a forged raw frame from a suggester deleting original text never lands, and the refusal is visible in the band;
    - leases are exclusive and never in the body state vector;
    - a delete-only frame after accept opens a continuation record;
    - `first_insert_after_accept_opens_continuation`: the suggester's first `suggest-ops` insert after an editor accepts their record opens a continuation record and lands. It is never refused, and nothing typed is lost (T5.0 final check, P1 routed here).
    - `all_roles_cannot_write_suggestions_via_sync`: step 2, update, and nested writes and deletes under `suggestions` from suggester, editor and owner are all refused with the map unchanged; editor and owner body writes land as positive controls (I2; T4.1 SP7 is not yet on m4);
    - `accepted_record_continuation_preserves_occupied_id`: with two principals, another principal's open record holds the continuation id; a delete-only frame and an ops frame aimed at the accepted record both leave that record's author, status, ops and parts unchanged, and long ids that share a 48-character prefix never collide;
    - `accepted_suggestion_text_is_valid_body_delete_target`: after an editor accepts Alice's insert, another principal's suggest-delete over those characters is accepted as a part, while targets still under a pending lease stay refused `target`;
    - `fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth`: one fixed `suggest-ops` frame costs the same with 5 and with thousands of closed records, and at continuation depth 1 and at the maximum.
    - **Lease and record authorization** (push security review of `packages/sync/src/doc/suggest.ts` on t/T5.0, 2026-10-04):
      - `leases_are_bounded_and_bound`: a principal holds at most a small fixed number of live leases (the request cannot raise it), each lease is bound to the connection that asked for it and expires when that connection closes or idles, and another connection of the same principal cannot write with it;
      - `record_ids_are_server_minted`: the server mints record ids, and a client-chosen id can neither create a record nor squat a peer's future id;
      - `live_role_on_every_suggest_frame`: demoting a suggester to viewer refuses their next `suggest-ops`, `suggest-delete`, `suggest-merge` and `suggest-lease` at once, with no stale role taken from connection state;
      - `overlapping_clocks_refused`: a `suggest-ops` update whose structs start below the lease's acknowledged clock is refused, so a record can never hold two versions of one id.
  - **Done:** green.
- **T5.3 Review, accept, reject, withdraw, notify** `[B·codex]`
  - **Scope:**
    - glyphdown's SuggestionsPanel rebuilt in the moss DS inside moss chrome, with accept and reject reachable from painted suggestions (moss's ActionsPanel stays the inert agent panel);
    - `packages/core/suggest/apply.ts`, shared by client and server: projectionDiff serializes each top-level block recursively, keyed by Y item id, plus full register contents; the hunk list and previewHash;
    - accept through `serverWrite` in one synchronous DO turn, with these gates (any failure answers 409 and applies nothing):
      - G0: the record is open and its ops are the ones previewed;
      - G1: no pending structs or deletes;
      - G2: advanced clients ⊆ the record's leases;
      - G3: changed types only under `root` and `registers`;
      - G4: register aliasing (a fresh decorator names only a key this record created; an existing registers entry is never replaced or re-pointed, and deleted only with every decorator naming it);
      - G5: outdated (removed body items live, no foreign item inside a removed run, every inserted struct integrates live);
      - G6: the previewHash matches;
      - G7: the headless bind succeeds;
      - G8: the state cap holds;
    - accept marks the record's leases spent in the same turn, so accepted text is ordinary body text (design §4.3);
    - reject and withdraw as status-only transactions that never write the body (PRODUCT ruling 16);
    - outdated and broken badges with "Copy suggested text", and auto-reject when the preview is empty;
    - accept rate-limited per principal;
    - the default export is the clean body, with `?view=working` for the composite;
    - notifications for live suggestions.
  - **Tests first:**
    - an editor's accept and reject converge on both sides;
    - withdraw removes the inserted text from every view while the body stays byte-identical;
    - the peer's review UI lists the suggestion;
    - accept-equivalence: for every census operation, accept equals an editor's direct edit (markdown and registers);
    - each gate refused with nothing applied;
    - outdated cases: an editor types inside a bolded run, deletes a delete target, or deletes the parent paragraph and it is GC'd; and two conflicting records;
    - a text-only, an attribute-only and a register-only record each produce a hunk;
    - a stale hash gets 409;
    - `preview_hash_covers_root_attributes`: a root-only record (`__format`, `__direction` on `root`) and a mixed text-plus-root record each change the previewHash from the empty-diff value, and a stale hash over them gets 409;
    - `g7_refuses_candidate_repaired_during_hydration`: a fresh decorator in legacy shape (a code block with `__code` and no `__regId`) gets 409 `broken` with the body unchanged, because G7's baseline is taken before hydration repairs anything;
    - `g5_split_parts_around_foreign_insert_keep_foreign_text_and_preview_shows_it`: two single-character delete parts on adjacent a and b, then an editor inserts X between them; accept removes only a and b, X stays, and the preview shows exactly that (G5(b) is per step, design §4.2).
  - **Done:** green, with a triptych against the glyphdown panel.
  - **Before accept is wired** (M4 Slop Cop P2s on the spike, coordinator 2026-10-06; full text in the M4 review): G3 and the preview must cover Yjs follow-on cleanup transactions. Type the mirror roots before hydration and collect every deleteSet the apply produces through cleanup, so a suggestion either lands exactly the previewed hash or is refused. Make the deletion coverage check interval-based, not characters × spans. Write a red-first regression for each.
- **T5.3s Forged names and preview cost** `[B·codex]`, coordinator, 2026-10-06 (push security reviews of t/T5.3): every lookup keyed by a record-controlled name in `suggest/` (and the ingest's per-doc clocks) is a Map or an own-property check, so fields, node types, map keys and payload ids named `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf` or `prototype` each get a row and are hashed; the preview and the card are linear in the record at the cap (doubling the record roughly doubles the time); red-first census and cost tests.
- **T5.S2 Metered working export** `[B·fresh]`, M5 Slop Cop P1, 2026-10-06: `?view=working` spends the preview budget before the DocDO (per user or agent; per share link and IPv6 /64 for anonymous readers), the DocDO bounds computations per doc and caches the composite until the next note, record or payload update, and each open record's gates run once (no replay on a failing record); read access unchanged.
- **T5.4 Adversarial suite and composite robustness** `[B·codex]`
  - **Scope:**
    - a randomized struct-level fuzz over records built from real peer frames: retarget origins, swap content kinds, add deletes, re-point `__regId`, write non-body roots, use non-leased clients, open gaps, GC parents. It asserts that accept either refuses with nothing applied, or lands exactly the hashed preview, touching only `root` and `registers` and only leased clients;
    - the same fuzz applied to clients' F and C builds, asserting no throw escapes and broken records are excluded;
    - a generative honest-edit fuzz through real moss editors in suggest mode (random typing, Enter, soft breaks, formatting, undo, lists, tables, decorators next to links, line breaks and inline formulas), asserting zero ingest refusals, zero broken records and accept-equivalence;
    - re-prove spike tests 2-8 red on behavior assertions, not on not-implemented stubs (T5.0 final check, P2);
    - cost regression tests for ingest and the body-frame lease check at the frame cap, including `fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth` at fuzz scale.
  - **Done:** green in CI.
- **T5.S1 Strike then join keeps the strike** `[B·fresh]`, coordinator, 2026-10-06 (M5 Slop Cop P1): the strike is F's data, never a prediction of Lexical: when any native rewrite (a join, an unwrap, a retyped block, a split, the undo or redo of one) re-creates a struck item under a new id, the fork finds the copy from the data (an undo's `redone` restore, or where the editor carried the struck character through Lexical's own split, merge, splice and replace operations, apps/web suggest/trace.ts) and removes it at once in its own forwarded transaction, and a struck original the binding kept standing for equal new text is replaced there by a fresh character, so the record inserts and deletes the copy and the delete part keeps the original id (G5 unchanged); undo of the strike re-creates a removed target as the author's own after the nearest standing character, and redo removes it and proposes the part again; red-first census in routing tests and in the real app in both engines (j16-census-*): every block kind on each side of a boundary x Backspace at the start, Delete at the end and Delete after a line break x strike start, end, span, whole and apart, with undo and redo, checking F, the card, the Edit-mode paint, the working export and accept.

**Exit criteria:** colliding-prefix typing is never refused; a suggester's first delete never removes text on the server; a suggester's body frame never lands and the client shows the refusal; reject and withdraw never change the body; accept lands exactly the previewed diff or nothing; the demo note shows live pending suggestions (Review mode inline, Edit mode markers).

## M6 History

**A person can newly** open History from the top bar, see automatic and named versions, view one read-only, diff it against now, and restore it while a peer keeps typing, without losing the peer's words or comment anchors.

- **T6.1 Identity-preserving reconcile** `[A·codex]`
  - **Scope:** SP12: port the two-tier reconcile to 0.48 in `packages/core`, with verify-or-refuse.
  - **Tests first:** properties: the result exports the target; untouched subtrees keep their Yjs item ids; a concurrent insert in an untouched block survives; anchors survive. **Done:** green.
- **T6.2 Version storage and triggers** `[A·codex]`
  - **Scope:** A§14 storage, R2 spill, triggers, REST, and a rate limit on named versions.
  - **Tests first:** harness: an auto version on last disconnect; the activity trigger; dedupe; a spill above 1.5 MB; a failed restore verification gets 409.
  - **Required red-first test (T6.1 checker P2):** force reconcileBody's export-mismatch comparison (not an unknown node type, which fails earlier in stateToMarkdown) and assert the restore is refused before any body, payload or note write.
  - **Done:** green.
- **T6.3 History view** `[B·fresh]`
  - **Scope:** glyphdown's history page rebuilt in the moss DS inside the editor pane (A§14): the version list with badges, View and Diff vs current, Restore with ConfirmationDialog, `VersionHistoryEmptyState`, a first named checkpoint from the empty state, honest errors.
  - **Tests first:** journey **j17-history**: an auto version appears after the last disconnect; a selected version is read-only; Diff vs current shows the peer's change; a named version is saved from the empty state and from a non-empty list; restore while the peer types keeps the peer's insert and a comment anchor; a versions fetch failed with `page.route` renders an error, never "No checkpoints".
  - **Required red-first test (T6.2 checker P2):** a version whose title exceeds 200 characters shows its full title in View and Diff (read content.title, not the list's truncated VersionMeta title).
  - **Required red-first test (T6.2 checker P2):** j17's last-disconnect leg closes every actor page (page.close()) or moves it off the doc before expecting the auto version, and asserts the version appears within a few seconds of the last socket closing.
  - **Done:** j17 is green, with a triptych against the glyphdown history page.
- **T6.S1 Three-way restore** (Slop Cop P1, PR #8): restore reconciles from the base the restorer opened Restore on and keeps every insert made after it (A§14); a stale or missing base is refused 409. **Tests:** a peer's word typed across the restore in the body, a code block and a formula; an agent write after the base; a stale base; no concurrent edit equals the version; a peer's first text in an empty block; a block the version drops after a peer typed in it (409); a base missing a named payload (409); j17 with Ben typing across the confirm click. **Done:** green.
- **T6.S2 Named versions count per person, not per key** (Slop Cop P1): the per-person named cap and the save rate count the acting user (an agent as its owner) in the serialized insert; `createdBy` stays the key. **Done:** green harness and route tests.
- **T6.S3 A restored payload keeps its unchanged middle** (Slop Cop P1): the mirror's payload writes (restore, push) use the bounded sparse diff, so a code, HTML or formula payload changed at both ends past the table keeps its middle's items and a peer's insert there. **Done:** green reconcile test.
- **T6.S4 A large restore never waits on R2** (Slop Cop P1): a restore point too large for its row is staged in chunked DocDO SQLite in the restore's turn and moved to R2 afterwards (retried, swept), so a restore on a large note succeeds while a peer types. **Tests:** every R2 put carries a peer keystroke and the restore succeeds with its exact point and his words; the point reads the same staged and moved; a crash between staging and the move recovers on wake with no orphan. **Done:** green harness.

**Exit criteria:** a restore during peer typing keeps the peer's insert and the anchors; view is read-only and diff shows the peer's change; a failed fetch shows an error.
- **M6 coordinator notes** (2026-10-07, since T1.F2, M4 and M5 landed after this plan was written):
  - A version captures the note body, every payload doc (code, HTML, formula, chart and sketch text) and the comments map.
  - Restore reconciles the body and each payload doc with the identity-preserving reconcile. Comment anchors stay attached through the anchor engine (I7).
  - Open suggestion records whose base changes go stale and must re-preview before accept (I3).
  - Restore and named versions re-validate the actor inside the serialized write (the T2.5 rule).
  - Version storage is bounded per note by pruning, never by charging a person or a vault (A§14 Bounds): auto versions and old restore points are pruned past fixed counts and bytes in the same write; named versions are capped per note and per person, refused 409, never pruned. Nothing about versions refuses an edit or lets one person block another's history.

## M7 Agents and local sync

**A person can newly** let an agent with an API key pull, push and sync `.md` files while humans type; see the agent as a Bot-badged collaborator; give another person's agent a role on a doc; push suggestions with `--suggest`; and run a folder-watch daemon that keeps a local folder in sync.

- **T7.1 CLI core** `[A·fresh]`
  - **Scope:** the A§17 command surface, device login, key auth, doc references by id, URL or title prefix, raw `cat`, `rm` copy and JSON, exit codes.
  - **Tests first:** unit tests against a fake server; the CI e2e job runs the built CLI against the stack: `cat` is byte-exact with no trailing LF; a 2 MB pull returns every byte; a title-prefix reference resolves; a `url` output opens the doc in the web app. **Done:** green.
- **T7.1s CLI security** (push security review of T7.1): device sign-in opens only http(s) pages on the server's own origin; server text is escaped before it reaches a terminal (`cat` stays raw); no request follows a redirect; every local file passes one confinement helper (real paths, no links out, moss filename rules); the key never appears in output. **Done:** red-first unit tests, then green.
- **T7.2 Structural push merge** `[B·codex]`
  - **Scope:** the A§17 push path through the T6.1 reconcile; the PrincipalDO rate limit; the base cache; the degenerate guard; the size-cap check on the simulated result.
  - **Tests first:** merge properties: untouched blocks keep identity, duplicates keep their positions, `:::tabs` splits correctly. Journey **j18-agents**: a CLI push while a human types in the same paragraph keeps both; the 61st push in a minute gets 429 with `retry-after`; a 2 MB push lands and the doc stays typeable, and a push past the cap is refused loudly; a push deleting most of the doc is refused without `--force`. **Done:** green.
  - **Required red-first test (T7.1 checker P2):** on a case-insensitive volume, `pull A note.md` then `pull B NOTE.md --force` leaves exactly one owner for the file (B), and `push note.md` targets B, never A; compare tracked paths case-insensitively where the filesystem is (workspace.ts recordBase, metaForFile).
  - **Required red-first test (T7.1s checker P2):** on a case-insensitive volume, `pull B .MOSS-MULTI/A/meta.json --force` and `add .MOSS-MULTI/...` are refused like `.moss-multi/...`; compare the state-directory component case-insensitively (workspace.ts confined()).
- **T7.3 Agent presence, agent grants, `--suggest`, key revocation** `[B·codex]`
  - **Tests first:** a push shows a Bot-badged chip for about 15 s and adds no undo step; `--suggest` lands as a pending suggestion; another user's agent granted commenter can pull, has its push refused loudly, has its comment land, and is disconnected when the grant is revoked; revoking the key closes the agent's socket and 401s the CLI. **Done:** green.
  - **Required red-first test (T7.1 checker P2):** the A§17 read commands `comments <doc>` and `suggestions <doc>` exist and list a note's comment threads and open suggestions; today both fail as unknown commands with exit 1.
- **T7.4 Folder-watch daemon and sync** `[A·codex]`
  - **Tests first:** in the CI e2e job: a local edit appears on the web; a web edit updates the local file; an untracked file becomes a doc titled from its stem and the file is renamed; a local delete doesn't propagate; a CLI-created doc renders in the web editor; a moss-format note with its `# Title` line and comments sidecar imports through the moss interchange path with one title and anchored comments. **Done:** green.
  - **Required red-first test (T7.1 checker P2):** `add tomato.md --title 'Tomato log'` on a file starting with `# Tomato log` yields a note whose web view shows the title once, with no duplicate H1.
- **T7.L ReDoS lint** (coordinator, from push security reviews): eslint-plugin-regexp's `no-super-linear-backtracking`, `no-super-linear-move`, `no-misleading-capturing-group` and `optimal-quantifier-concatenation` are errors over our code, every reported regex is rewritten golden-equal and linear (docs/METHOD.md), including T7.4's `TITLE_LINE` and `MARKER` (quadratic on a first line of spaces), now one scan in `@moss-multi/protocol/title-line`; and moss's table-separator, fenced-code and image regexes in `classifyNoteContentType` (quadratic on `---|` rows, backtick runs and `![` runs) are scans. **Done:** the lint step red on the old head, then green.

**Exit criteria** [L§7.3 M7]: a CLI push during typing preserves both sides; `cat` is byte-exact; a 2 MB push and pull work; a CLI-created doc renders; an agent grant is enforced; revoking a key closes its socket; the daemon round-trips a local edit.
- **M7 coordinator notes** (2026-10-07, since M1-M6 and later rulings landed after this plan was written):
  - **PRODUCT ruling 20 supersedes "give another person's agent a role":** a person grants access only to agents they own, and any other agent id answers like an unknown one. To involve someone else's agent, share with that person, who then adds their own agent (when they manage the note). T7.3's test grants an agent by its owner, then checks pull, a refused push, a comment that lands, and a disconnect on revoke.
  - **Payload docs:** pull and push cover code, HTML, formula, chart and sketch text through the one converter and reconcile (T6.1), so payload ids are preserved.
  - **Comments:** pull and push round-trip moss's comments.json sidecar and `%%m:` markers through the M4 engine, so anchors survive.
  - **`--suggest`:** the server turns the agent's change into a suggestion record under a lease, through the same channel table and gates as the web client (M5, I3).
  - **History:** pushes count as activity for M6 versions.
  - **Rate limits:** charged to the acting user (an agent counts against its owner). No bucket may be one that someone else can fill (T3.S3b).
  - **Authorization:** every write re-validates the actor inside the serialized write (T2.5), and a revoked key closes live sockets and 401s REST.
  - **Daemon:** follows PRODUCT ruling 9 (server-side three-way merge, untracked files become docs, deletes do not propagate).
  - **No shell or filesystem trust:** paths come from the user's folder, are confined to it, and pass moss's filename rules; the daemon never follows symlinks out of the folder.

## M8 Ship

**A person can newly** use the whole product at a permanent staging URL, with demo content that shows every feature.

- **T8.1 Staging hygiene** `[A·codex]`
  - **Scope:** the fixed principal pool reused across runs, a request budget per run, a check that `.dev.vars` is never uploaded, and a review of DO storage growth. **Done:** green.
- **T8.2 The full suite on staging** `[A·codex]`
  - **Scope:** run every journey except `@local-only` legs against the deployed bytes, with wake proven through the owner-only instance route. **Done:** green.
- **T8.3 Security sweep** `[B·codex]`
  - **Scope:** an adversarial pass on staging: header stripping, existence leaks, CSP, SSRF, limits including auth 429s, token threading, sign-out. Only P0 and P1 findings are fixed here. **Done:** green.
- **T8.4 MIGRATION.md** `[C·fresh]`
  - **Scope:** how each part maps back onto moss desktop: seams, bridge namespaces, the converter extraction, the collab layer, registers, the server model. **Done:** green.
- **T8.5 Demo content and signature shot** `[C·fresh]`
  - **Scope:** demo notes built through the UI in a test account on staging (R8), with live comments and pending suggestions; a share link to the demo vault posted with the staging URL so the owner can open it signed in as themselves; the signature shot: a peer's cursor and a suggestion in a long sentence beside rich nodes. **Done:** green.

**Exit criteria:** every journey passes on the deployed build; staging `/api/version` equals the tested bytes; the critic passes on staging; the signature shot and demo link are posted inline.

---

## The loop

### Per task

1. **Brief.** The coordinator commits `docs/briefs/Tm.n.md` to the milestone branch `m<k>`, at most 40 lines: scope, files, the trace ids and A§ sections touched, the reference shots (glyphdown and moss) for any surface moss lacks or a seam changes, the tests-first list, the done evidence, the risk class, the CI-minute budget, the anti-stall preamble, and the provider, model, effort and fallback tuple. A defect fix on a ported or moss-absent surface also carries the three-way record (glyphdown's interaction, moss at the pin, ours) before any fix [L§7.1 #9]. The task branch `m<k>/Tm.n` opens in a BB-managed worktree; the owner-visible checkout stays on `main`. [L§5.6]
2. **Tests first.** The implementer is Claude Code Opus with a fresh context, spawned with provider, model and effort passed explicitly and checked in its first output [L§6]. It reads PRODUCT, the cited A§, METHOD.md and the brief, writes the failing tests, pushes, and dispatches a Chromium-only grep run (`gh workflow run ci.yml --ref <branch> -f grep=… -f browsers=chromium`). The run must be red on the named assertions.
3. **Implement.** Make the smallest change that meets the brief. The inner loop is a local `vite build` and stack launch (compile and boot only; no tests run locally), then Chromium grep dispatches or the checks-only lane. Push every green step. The head SHA ends green.
4. **Independent checker.** A fresh agent with its own driver, Codex through `codex exec` for the risk classes below after a `codex exec "reply OK"` probe:
   - it reads the diff against the brief and the cited A§ sections;
   - it reuses the implementer's green run for the same head SHA and dispatches once more: WebKit for the touched journeys, plus `repeat_each=3` on changed timing legs;
   - it runs the change's one browser QA pass on its own stack, and reads the triptych for any surface moss lacks;
   - for a defect fix, it dispatches `red-proof` against the merge base.

   It returns schema-checked, null-guarded output: `{verdict: PASS|FAIL|BLOCKED, findings: [{severity: P0|P1|P2, …}], evidence}`. When Codex is out of quota, a fresh same-vendor checker runs flagged `degraded`, and the cross-vendor check is owed before the milestone exits. [L§4.19; L§5.6]
5. **Integrate.** On PASS, the coordinator merges into `m<k>`, re-runs the touched journeys in both engines on `m<k>`, and pushes. Checker findings visible on a shipped surface are fixed within the milestone; only code-review P2s are parked, as PROGRESS.md follow-ups.

### Per milestone

6. **Milestone journeys in CI.** The `m<k> → main` PR is opened as a draft at milestone start and carries the `BB-Thread-ID` line. When it goes ready, the full suite runs in both engines, plus parity for the milestone's targets (A§20) and the trace check. `CI_DEGRADED` never waives the exit's WebKit run.
7. **Polish.** One bounded task clears every visible-UI follow-up before the critic. [L§6 avoid: the POLISH-FIXES backlog never ran]
8. **Naive critic.** A fresh agent with PRODUCT.md, a local stack URL, the Ladle oracle URL and the glyphdown reference index, and no code, uses the milestone's promise as a new user and reports gaps with shots. Each finding is fixed now or ruled out of scope with a PRODUCT citation. [L§6 critic]
9. **Staging canary** (from M1). Deploy the milestone head and run its canary legs on staging.
10. **Upstream drift.** `moss-vendor.mjs drift` reports moss `origin/main` changes since the pin that touch vendored files. It is a report; pin changes stay owner-gated. [L§4.1]
11. **Owner hand-off.**
    - The coordinator reads the decisive shots at full resolution and posts inline one 2× before/after pair per promise clause (before from `main`, after from the `m<k>` head, attached with `gh pr edit --attach`), the triptychs, the Tier A pairs, and the progress visual.
    - The PR gets one code review, and only P0 and P1 findings are fixed.
    - The owner approves the transition and the PR merges.
    - Briefs are pruned, workers and worktrees are archived, and the coordinator hands off to a fresh thread if its context is large. [L§1.10; L§6]

### Coordinator rules

- **Owner-flagged defects preempt the queue,** whatever their rating. [L§7.1 #10]
- **An owner correction to a running fix's design stops or re-briefs it at once.** [L§6 avoid]
- **Invariants outrank brief bounds.** A worker does the minimum invariant-satisfying work and says which bound it set aside. [L§6 CASE-LAW]
- **Spec conflicts** between PRODUCT, A§ and the surveys go to a standing adjudicator thread that cites each text verbatim and logs any softening loudly. [L§6]
- **Visible orchestration.** Checkers, critics and the adjudicator run as bb threads, and every status report says what is running now and what comes next, checked fresh. [L§1.10; L§2.1]

### Proportional verification

| Change class | Checker | Required adversarial legs |
|---|---|---|
| Auth, sharing and access, revocation | Cross-vendor, `codex exec`, framed as authorized QA | Raw requests as the wrong principal, forged and revoked tokens, a cold DO |
| Concurrency, CRDT and binding, presence | Cross-vendor | Two-actor races, severs, forged frames, frame scans |
| Persistence, DO storage, data loss | Cross-vendor | Restart and eviction, a doc at the size cap, red-proof on the pre-fix bytes |
| UI chrome, styling, copy, tooling | Same-vendor, fresh | One QA pass plus CI; screenshots and triptychs read |

Infrastructure verdicts are never product verdicts: a Cloudflare page, D1 7429, Worker 1101, a quota death, a runner failure or a host death recorded by `stack.mjs` counts as BLOCKED. Evidence-only cycles stop once the behavior is confirmed. [L§6 proportional; L§4.19 escalation]

### Failure budgets

- **Attempts.** At most 4 implement attempts per task, and at most 2 checker cycles per attempt. [L§6 deterministic orchestration]
- **Oracle first, then one fix.** The brief's three-way record comes before the first fix. After one failed fix, instrument (the Lexical error number, the component stack, `wrangler tail`, a frame census) and ask whether the structure is wrong before another attempt. [L§7.1 #9; L§6 diagnose first]
- **Park and report.** After 4 attempts, at 2× the task's CI-minute budget, or after 2 coordinator interventions without a change in state, the task is parked and reported in plain language with options and a recommendation.
- **Requeue infra deaths** without consuming an attempt, at most twice, then report BLOCKED.

### Repo hygiene

- **No evidence in git.**
  - Evidence lives in CI artifacts (at most 10 PNGs per engine) and in task-scoped `.local-stack/runs/*/shots`, deleted after use.
  - Decisive shots and the glyphdown references are PR attachments (`gh pr edit --attach`); the repo holds only their index. [L§7.1 #22]
- **Docs stay lean:** PRODUCT, ARCHITECTURE, BUILDPLAN, PROGRESS, METHOD (gotchas), DEVIATIONS, and the design reviews. There is no rubric, ledger, case law or versioned test copy. [L§6 avoid]
- **Code comments are short and factual,** with no ticket archaeology. Vendor seams carry `moss-multi seam:` markers.
- **Git practice.** Push every green step. Never stash, and never `git add -A` in a shared worktree. Archive finished workers and worktrees as you go. [L§7.1 #1]
- **Liveness.** A scheduled bb automation checks workflow and CI state every 30 minutes and alerts only on a state change. [L§7.1 #18]

### Spending

- **CI minutes** (S-test §2.9, re-modeled per task): about 60 billable minutes per task (red 11, two or three Chromium iterations, one checker dispatch), about 150 per milestone gate, and about 6,500 for M0–M8, roughly 3,000 a month at the planned pace (OA2).
  - Each task's budget and use are tracked in PROGRESS.md.
  - `CI_DEGRADED` moves WebKit and parity off ready PRs only; task gates are Chromium-only by design, and no milestone exits without a green WebKit run on its head.
  - When the month's budget is spent, work pauses and is reported; gates are never silently degraded. [L§7.1 #20]
- **Cloudflare** is touched from T1.10 on: one staging Worker, a fixed principal pool, a request budget per canary run, and soft-deleted DOs counted as they never reclaim storage. [L§4.7]
- **Codex quota** is probed before every cross-vendor dispatch. [L§5.6]

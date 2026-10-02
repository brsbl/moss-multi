# Survey: verification infrastructure for moss-multi

Status: design input for the architecture (test-infra survey, 2026-10-02). Nothing here is built yet.

Scope: (1) the GitHub Actions pipeline, (2) the Playwright journey suite, (3) the local dev-stack launcher and the bb Browser Automation helper, (4) visual parity against moss Ladle. Sources: `/Users/brsbl/Code/moss-multi/PRODUCT.md`, `/Users/brsbl/Code/moss-multi/docs/history/LEARNINGS.md` (§4.19, §4.20, §5.2–5.3, §6, §7.1–7.3), the CI configs and drivers under `/Users/brsbl/Code/moss-multi/.refs/{glyphdown,moss-collab,moss}`, and a live probe of the bb Browser Automation plugin on this machine (§4.4).

## 0. Summary

1. **One pipeline, five jobs.** `plan` decides the lanes. `checks` runs typecheck, lint, and unit tests. `build` makes one vite build with provenance baked in. `e2e` is a matrix of Chromium and WebKit; each leg boots `wrangler dev --local` on the exact built bytes and runs the whole journey suite. `parity` compares the candidate's pixels with moss Ladle. A `ci-ok` aggregator is the single required status. Everything runs on `ubuntu-latest`; there are no macOS runners, which bill at 10×.
2. **Same bytes everywhere.** One `vite build` per run. Every e2e and parity leg downloads that build and refuses to start unless `/api/version` reports the build job's `commit` and `bundleHash`. Every page load also checks the SSR `<meta name="moss-build">` and the client's own build stamp against `/api/version`.
3. **The CI stack is the local stack.** CI and agents both use `scripts/stack.mjs` (start, restart, pause, resume, stop, principals, reap). There is one code path, so "works locally, fails in CI" cannot be blamed on a different launcher.
4. **One living suite** under `e2e/`. Journeys are named by promise, not by version, and there are no `-v2` copies. Drivers wait on readiness attributes the product publishes; there are no sleeps. Every journey uses at least two distinct per-run principals in separate browser contexts. An auto fixture checks nine global invariants on every actor of every test (§3.5).
5. **Real severs.** Per-client severs use Playwright `routeWebSocket` as a black-hole or close proxy, installed only on actors marked severable. Whole-server half-open severs use `SIGSTOP` on the wrangler process group. Neither `context.setOffline` nor CDP offline emulation is ever used to sever: neither closes an established WebSocket (LEARNINGS §4.20).
6. **Hibernation is forced and then proven.** There are three levers: restart the stack (same bytes, storage, and secret), reset one DO through `ctx.abort()` behind a loopback-only test hook, or a calibrated natural idle (≥95 s with every client quiesced). A test is valid only if the DO's instance id changed. If it did not, the test fails as "not induced" and never passes vacuously.
7. **Every gate is proven able to fail, on every run.** A `selftest` project runs each detector against static fixtures that contain exactly one violation each. Journeys carry inline controls: a no-sever leg must show no banner, a solo leg must show zero chips, and frame scans need a positive-control key. A `red-proof` dispatch runs a new regression test against the pre-fix product bytes and passes only if the test goes red.
8. **Local QA never runs tests.** `scripts/stack.mjs` builds and boots the real stack. `scripts/qa.mjs` wraps `bb browser-automation` (local headless Chrome for Testing on `host_37m3sgpq59`) with a prelude that gives scripts per-principal browser contexts, cookie sign-in, 2× PNG capture, and the same DOM detectors CI uses. The probe confirmed contexts, 2× DPR, CDP sessions, absolute-path PNG writes, and re-attaching to a page across runs.
9. **Parity is lean.** CI checks out `brsbl/moss@762abb777` (a read-only deploy key is recommended; §2.10). It prepends the real app's own Prism and font imports from `main.tsx` to Ladle's `components.tsx`, runs `ladle build` (moss's own CI recipe), caches the result by pin, and serves it statically. Candidate and oracle are captured in the same Chromium at 1440×1000 @2×, cropped to `[data-moss-app-shell]`, and compared with pixelmatch plus a structural-blob check, which yields a triptych. Node families that Ladle cannot render become a milestone-time desktop-oracle task (§5.6).
10. **The minutes budget is explicit** (§2.9). A ready-PR run costs about 35–41 billable minutes and a draft push about 7. Pushes made only for durability go to branches without a PR and trigger nothing. A `main` push skips e2e when the identical tree already passed. A `CI_DEGRADED` repo variable drops WebKit to nightly when month-to-date use runs hot. The owner's GitHub plan is unknown (§7).

## 1. What the references did, and what we keep

| Source | What exists | Keep | Drop |
|---|---|---|---|
| glyphdown `faf98d0` `.github/workflows/ci.yml` | One job: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm --filter web build`; 15-min timeout; `workflow_call` so deploy reuses it. `deploy.yml` uses `concurrency: deploy-production, cancel-in-progress: false`. | The shape (pnpm cache through setup-node, frozen lockfile, the deploy gate reusing CI, deploy concurrency that never cancels). Its vitest config (`cloudflare:workers` alias to a stub, inline `partyserver`/`y-partyserver`). | Nothing. Glyphdown simply has **no** e2e, no workerd tests, and no hibernation tests (see `glyphdown-backend.md` §9). |
| moss `762abb777` `.github/workflows/ci.yml` | ubuntu-latest, a `setup-ci` composite that strips `supportedArchitectures` before install, `pnpm run ladle:build` on Linux, and a generic `build-and-test` aggregator over `needs`. Concurrency keyed per PR with `cancel-in-progress: true`. | The aggregator pattern. Proof that **moss's Ladle builds on ubuntu CI**, which means our oracle can use moss's own recipe. The `supportedArchitectures` strip. | — |
| moss-collab `9104ceb` `.github/workflows/converter-parity.yml` | Two jobs on `macos-14` (10× minutes) for a converter-oracle check. | Converter round-trip gates as unit tests. | macOS runners. |
| moss-collab `scripts/` (4,842 lines) | `local-stack-control.mjs` (start, stop, verify, status; vite build, then `wrangler dev <index.js> --no-bundle --local --ip 127.0.0.1 --port P --inspector-port P+1000 --persist-to …`, `--var` secrets, provenance wait), `local-stack-preflight.mjs` (846 lines: admission lock, registry, reaper), `seed-local-principals.mjs` (API sign-up with an `Origin` header, teardown by D1 delete), and a smoke test. | Exact wrangler flags, `--inspector-port P+1000`, the per-run fresh `BETTER_AUTH_SECRET`, empty OAuth/email/analytics vars, `/api/version` readiness, process-group kill with a command-line check before signalling, `@example.invalid` principals, and a 0600 credentials file. | The admission lock, host load gate, lane registry, and 3-stack machinery (LEARNINGS §5.3: "keep only the reaper and serial runs"). It shrinks to about 300 lines. |
| moss-collab `e2e/` (2,791 files) | `b0-suite.mjs` through `-v11`, `b1-suite` through `-v9`, about 60 one-off probes, and evidence committed in the repo. Useful mechanics: `page.on('websocket')` census, a console/pageerror census, `SIGSTOP` of the stack group for a half-open sever, `poll()`-based convergence, and peer-chip versus caret color comparison. | The mechanics, moved into fixtures. | Versioned copies, committed evidence, fixed-coordinate clicks (`page.mouse.click(650, 78)`), and the "scoped capture gate" apparatus. |

## 2. CI pipeline (GitHub Actions, ubuntu-latest)

### 2.1 Lanes

`scripts/ci/plan.mjs` computes the lanes. It is a pure function of the event, draft state, labels, changed paths, dispatch inputs, `vars.CI_DEGRADED`, and prior-pass artifacts, and it is unit-tested in `checks`.

| Trigger | Lanes |
|---|---|
| PR, draft | `checks` only. The label `e2e` adds `build` and Chromium `e2e`. |
| PR, ready for review (opened, synchronize, ready_for_review, labeled) | `checks`, `build`, `e2e` on [chromium, webkit] (Chromium only when `CI_DEGRADED=true`, unless the label `e2e-full` is present), and `parity` if UI paths changed. |
| PR, docs-only change (`docs/**`, `*.md` outside `e2e/`) | none; `ci-ok` passes by design |
| push to `main` | `checks` and `build`. For each browser, `e2e` runs **unless** an artifact `e2e-pass-<tree>-<browser>` already exists for this exact `HEAD^{tree}`. `parity` runs under the same rule with `parity-pass-<tree>`. Branch protection's "require branches to be up to date" makes the PR's merge-commit tree equal main's tree after a squash merge, so the skip is exact. |
| `schedule` nightly (07:23 UTC) | Only when main's tree differs from the last nightly pass: `soak` (10-min hibernation and presence idle), the `calibration` project, and full `parity`. |
| `workflow_dispatch` | Inputs: `grep`, `browsers` (both, chromium, webkit), `repeat_each` (1–10; the "repeat the run 5×" flake hunt), `parity`, `soak`. This is how agents run a targeted journey remotely: `gh workflow run ci.yml --ref <branch> -f grep='J03' -f browsers=webkit -f repeat_each=5`. |
| `red-proof.yml` (dispatch) | Inputs `base_sha`, `tests_sha`, and `grep`. It checks out the product at `base_sha`, overlays `e2e/` from `tests_sha`, builds, and runs the grep. **The job succeeds only if the selected tests fail on product assertions, not infra.** |

UI paths (these trigger parity): `apps/web/src/**/*.{tsx,ts,css}`, `packages/ui/**`, `**/tailwind.config.*`, `**/tokens*.css`, font packages in `package.json`, `e2e/parity/**`.

Durability versus CI: agents push work-in-progress to non-PR branches, which triggers nothing, so "push every green step" (LEARNINGS §7.1 #1) costs no minutes. CI minutes are spent only when a PR is opened or updated, when someone dispatches, or on main.

### 2.2 Job graph and per-job budget

```
plan (1m) ──► checks (≤8m; typecheck, lint, unit, plan.mjs tests)
         ├──► build (≤4m; vite build + provenance → web-dist.tgz)
         │      ├──► e2e[chromium] (≤13m) ──┐
         │      ├──► e2e[webkit]   (≤13m) ──┤
         │      └──► parity        (≤6m)  ──┤  needs: oracle
         └──► oracle (cache hit 0.3m; miss ≤8m) ┘
ci-ok (aggregator, if: always()) ◄── all of the above
```

Wall-clock target for a ready PR: about 16 min (build at 3–4 min, then e2e at 12–13 min in parallel). `checks` runs in parallel and does not gate e2e, so a red typecheck does not hide the e2e result.

### 2.3 `ci.yml` (illustrative; action majors pinned, Dependabot keeps them current)

```yaml
name: CI
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review, labeled]
  push:
    branches: [main]
  schedule:
    - cron: '23 7 * * *'
  workflow_dispatch:
    inputs:
      grep: { description: 'Playwright --grep', required: false, default: '' }
      browsers: { type: choice, options: [both, chromium, webkit], default: both }
      repeat_each: { type: number, default: 1 }
      parity: { type: boolean, default: false }
      soak: { type: boolean, default: false }

permissions:
  contents: read
  actions: read        # plan.mjs lists e2e-pass-<tree> artifacts

concurrency:
  # PRs: newest push wins. main: one group per SHA (never cancelled). Nightly/dispatch: per ref.
  group: ci-${{ github.event_name }}-${{ github.event.pull_request.number || (github.ref == 'refs/heads/main' && github.sha) || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  CI: 'true'
  WRANGLER_SEND_METRICS: 'false'
  NO_COLOR: '1'

jobs:
  plan:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    outputs:
      checks: ${{ steps.p.outputs.checks }}
      build: ${{ steps.p.outputs.build }}
      browsers: ${{ steps.p.outputs.browsers }}   # JSON array, may be []
      parity: ${{ steps.p.outputs.parity }}
      soak: ${{ steps.p.outputs.soak }}
      grep: ${{ steps.p.outputs.grep }}
      repeat: ${{ steps.p.outputs.repeat }}
      tree: ${{ steps.p.outputs.tree }}
    steps:
      - uses: actions/checkout@v6
        with: { fetch-depth: 0 }
      - id: p
        run: node scripts/ci/plan.mjs >> "$GITHUB_OUTPUT"
        env:
          GH_TOKEN: ${{ github.token }}
          EVENT_NAME: ${{ github.event_name }}
          EVENT_JSON: ${{ toJSON(github.event) }}
          CI_DEGRADED: ${{ vars.CI_DEGRADED }}

  checks:
    needs: plan
    if: needs.plan.outputs.checks == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6            # version from package.json "packageManager"
      - uses: actions/setup-node@v6
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck                # includes e2e/ (tsc -p e2e)
      - run: pnpm lint
      - run: pnpm -r test                     # vitest run — never watch mode

  build:
    needs: plan
    if: needs.plan.outputs.build == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    outputs:
      commit: ${{ steps.prov.outputs.commit }}
      bundleHash: ${{ steps.prov.outputs.bundleHash }}
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: vite build (provenance baked into server and client)
        run: pnpm --filter web build
        env:
          MOSS_BUILD_ENV: ci
          CLOUDFLARE_ENV: ''                   # top-level (local) bindings; staging builds set this (§2.11)
          MOSS_PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
      - id: prov
        run: node scripts/provenance.mjs read apps/web/dist >> "$GITHUB_OUTPUT"   # commit=…, bundleHash=…
      - run: tar -czf web-dist.tgz -C apps/web dist
      - uses: actions/upload-artifact@v4
        with: { name: web-dist, path: web-dist.tgz, retention-days: 3 }

  e2e:
    needs: [plan, build]
    if: needs.plan.outputs.browsers != '[]' && needs.plan.outputs.browsers != ''
    runs-on: ubuntu-latest
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        browser: ${{ fromJSON(needs.plan.outputs.browsers) }}
    env:
      RUN_ID: ci-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.browser }}
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { name: web-dist }
      - run: mkdir -p .local-stack/prebuilt && tar -xzf web-dist.tgz -C .local-stack/prebuilt
      - id: pw
        run: echo "v=$(node -p "require('@playwright/test/package.json').version")" >> "$GITHUB_OUTPUT"
      - id: pwc
        uses: actions/cache@v4
        with: { path: ~/.cache/ms-playwright, key: 'pw-${{ runner.os }}-${{ steps.pw.outputs.v }}-${{ matrix.browser }}' }
      - if: steps.pwc.outputs.cache-hit != 'true'
        run: pnpm exec playwright install --with-deps ${{ matrix.browser }}
      - if: steps.pwc.outputs.cache-hit == 'true'
        run: pnpm exec playwright install-deps ${{ matrix.browser }}
      - name: Boot the real Worker stack on the built bytes
        run: >
          node scripts/stack.mjs start --run-id "$RUN_ID" --prebuilt .local-stack/prebuilt/dist
          --port 8850 --hooks --expect-commit ${{ needs.build.outputs.commit }}
          --expect-bundle ${{ needs.build.outputs.bundleHash }} --json | tee stack.json
      - run: echo "STACK_STATE=$(node -p "require('./stack.json').statePath")" >> "$GITHUB_ENV"
      - id: run
        name: Journeys (selftest project runs first as a dependency)
        continue-on-error: true
        run: >
          pnpm exec playwright test --project=${{ matrix.browser }}
          ${{ needs.plan.outputs.grep }} --repeat-each=${{ needs.plan.outputs.repeat }}
      - id: rerun
        name: Re-run infra-BLOCKED tests once (never product failures)
        if: steps.run.outcome == 'failure' && hashFiles('test-results/blocked.json') != ''
        continue-on-error: true
        run: |
          node scripts/stack.mjs restart --run-id "$RUN_ID"
          pnpm exec playwright test --project=${{ matrix.browser }} --last-failed
      - name: Verdict
        run: node e2e/lib/verdict.mjs "${{ steps.run.outcome }}" "${{ steps.rerun.outcome }}"   # writes $GITHUB_STEP_SUMMARY, exits non-zero on FAILED/BLOCKED
      - name: Stop stack
        if: always()
        run: node scripts/stack.mjs stop --run-id "$RUN_ID" || true
      - name: Mark tree as passed
        if: success()
        run: echo "${{ needs.build.outputs.bundleHash }}" > pass.txt
      - if: success()
        uses: actions/upload-artifact@v4
        with: { name: 'e2e-pass-${{ needs.plan.outputs.tree }}-${{ matrix.browser }}', path: pass.txt, retention-days: 30 }
      - name: Evidence (always small): results.json + decisive @evidence PNGs
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-${{ matrix.browser }}-${{ github.run_attempt }}
          path: |
            test-results/results.json
            test-results/evidence/
            .local-stack/runs/*/state.json
          retention-days: 7
      - name: Diagnostics (failure only): traces, failure screenshots, HTML report, wrangler.log
        if: failure() || steps.run.outcome == 'failure'
        uses: actions/upload-artifact@v4
        with:
          name: e2e-${{ matrix.browser }}-${{ github.run_attempt }}-diag
          path: |
            playwright-report/
            test-results/
            .local-stack/runs/*/wrangler.log
          retention-days: 7

  oracle:
    needs: plan
    if: needs.plan.outputs.parity == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env: { MOSS_PIN: 762abb7770714a49d912f6081384aabb958a7ea6 }
    outputs: { key: '${{ steps.k.outputs.key }}' }
    steps:
      - uses: actions/checkout@v6
      - id: k
        run: echo "key=ladle-oracle-${MOSS_PIN:0:9}-$(sha256sum e2e/parity/oracle-preamble.mjs | cut -c1-12)" >> "$GITHUB_OUTPUT"
      - id: hit
        uses: actions/cache/restore@v4
        with: { path: .oracle/ladle, key: '${{ steps.k.outputs.key }}', lookup-only: true }
      - if: steps.hit.outputs.cache-hit != 'true'
        uses: actions/checkout@v6
        with:
          repository: brsbl/moss
          ref: ${{ env.MOSS_PIN }}
          path: .oracle/moss
          ssh-key: ${{ secrets.MOSS_ORACLE_DEPLOY_KEY }}
          persist-credentials: false
      - if: steps.hit.outputs.cache-hit != 'true'
        uses: actions/setup-node@v6
        with: { node-version: 20 }               # moss's own CI node
      - if: steps.hit.outputs.cache-hit != 'true'
        name: Prepend main.tsx's Prism + font imports to Ladle; strip supportedArchitectures (moss setup-ci)
        run: node e2e/parity/oracle-preamble.mjs .oracle/moss
      - if: steps.hit.outputs.cache-hit != 'true'
        working-directory: .oracle/moss
        env: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
        run: |
          npx -y pnpm@9.10.0 install --frozen-lockfile --prefer-offline
          npx -y pnpm@9.10.0 run ladle:build
          mv .ladle-build ../ladle
      - if: steps.hit.outputs.cache-hit != 'true'
        uses: actions/cache/save@v4
        with: { path: .oracle/ladle, key: '${{ steps.k.outputs.key }}' }
      - if: steps.hit.outputs.cache-hit != 'true' && github.ref == 'refs/heads/main'
        uses: actions/upload-artifact@v4          # lets agents download the oracle locally (§5.1)
        with: { name: '${{ steps.k.outputs.key }}', path: .oracle/ladle, retention-days: 90 }

  parity:
    needs: [plan, build, oracle]
    if: needs.plan.outputs.parity == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with: { node-version-file: .node-version, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with: { name: web-dist }
      - run: mkdir -p .local-stack/prebuilt && tar -xzf web-dist.tgz -C .local-stack/prebuilt
      - uses: actions/cache/restore@v4
        with: { path: .oracle/ladle, key: '${{ needs.oracle.outputs.key }}', fail-on-cache-miss: true }
      - run: pnpm exec playwright install --with-deps chromium
      - run: node e2e/parity/serve-static.mjs .oracle/ladle 61007 & 
      - run: >
          node scripts/stack.mjs start --run-id "ci-${{ github.run_id }}-parity" --prebuilt .local-stack/prebuilt/dist
          --port 8850 --hooks --expect-bundle ${{ needs.build.outputs.bundleHash }} --json | tee stack.json
      - run: echo "STACK_STATE=$(node -p "require('./stack.json').statePath")" >> "$GITHUB_ENV"
      - run: pnpm exec playwright test --project=parity
        env: { LADLE_URL: 'http://127.0.0.1:61007' }
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: 'parity-${{ github.run_attempt }}', path: test-results/parity/, retention-days: 14 }

  soak:
    needs: [plan, build]
    if: needs.plan.outputs.soak == 'true'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      # same setup and boot as e2e[chromium], then:
      - run: pnpm exec playwright test --project=soak --project=calibration

  ci-ok:
    if: always()
    needs: [plan, checks, build, e2e, oracle, parity, soak]
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - env: { NEEDS_JSON: '${{ toJSON(needs) }}', PLAN_JSON: '${{ toJSON(needs.plan.outputs) }}' }
        run: node -e '…'   # fail on any "failure"/"cancelled"; "skipped" is OK only when plan said so (moss's generic aggregator)
```

`ci-ok` is the only status branch protection requires on `main`. Branch protection also turns on "require branches to be up to date", which makes the main-push dedupe exact.

### 2.4 Build provenance

The vite plugin is ported from moss-collab `apps/web/vite.config.ts` and extended in four ways:

- `/api/version` (GET, `cache-control: no-store`; POST returns 405 with `Allow: GET`) returns `{commit, headSha, dirty, diffHash, bundleHash, clientHash, buildTime, env}`.
  - `bundleHash` is a SHA-256 over the Worker chunks with placeholder canonicalization, so builds are deterministic across runners.
  - `clientHash` is the same hash over `dist/client/**`.
  - `dirty` and `diffHash` are filled locally from `git status --porcelain` and `git diff HEAD | sha256`; in CI they are always false and empty.
  - `commit` comes from `git rev-parse HEAD`, which is the PR merge commit in CI; `headSha` comes from `MOSS_PR_HEAD_SHA`.
- The SSR shell emits `<meta name="moss-build" content="<commit>:<bundleHash>">`.
- The client entry sets `document.documentElement.dataset.clientBuild = "<commit>:<clientHash>"` before React mounts. This is provenance, not an automation hook, so it ships in production builds too.
- `scripts/provenance.mjs read <dist>` prints `commit=` and `bundleHash=` for `$GITHUB_OUTPUT`, and fails if a provenance slot count is not exactly 1 (the moss-collab check).

The launcher (§4.1) and the global setup (§3.3) both assert:

1. `/api/version` equals the expected `commit` and `bundleHash`;
2. `GET /` returns 200 HTML with the meta tag;
3. every `<link rel=stylesheet>` returns 200 `text/css` and every module script returns 200 JavaScript (this catches the unstyled-prod-build class, LEARNINGS §4.1);
4. on every navigation, `meta(moss-build).commit == html[data-client-build].commit == /api/version.commit` (this catches stale chunks and mixed builds).

### 2.5 The stack in CI

`node scripts/stack.mjs start --prebuilt <dist> --port 8850 --hooks` does five things:

1. Applies D1 migrations (`wrangler d1 migrations apply DB --local --persist-to <run>/state --config apps/web/wrangler.jsonc`).
2. Spawns `wrangler dev --config <dist>/server/wrangler.json --local --ip 127.0.0.1 --port 8850 --inspector-port 9850 --persist-to <run>/state --show-interactive-dev-session=false --log-level info` in its own process group, with these vars:
   - per-run random `BETTER_AUTH_SECRET` and `MOSS_TEST_HOOKS_SECRET`;
   - `BETTER_AUTH_URL=http://127.0.0.1:8850` and `MOSS_TEST_HOOKS=1`;
   - every OAuth, email, and analytics var set to empty.
3. Waits until provenance matches.
4. Writes `<run>/state.json` with the pgid, port, baseUrl, provenance, persistDir, logPath, and the path of the secret file. The Playwright fixtures read this file through `STACK_STATE`.
5. Leaves storage, D1, and the DOs on the runner's disk, so they die with the runner. No teardown is needed in CI.

Sign-up is open on the CI stack because it binds to loopback only and sign-up is open on staging too. There is no playground (restart ruling 7): principals are real accounts.

### 2.6 Artifacts, summaries, and how agents read them

- **Always uploaded:** `results.json`, `test-results/evidence/` (2× PNGs from steps tagged `@evidence`; at most about 10 per engine), and `state.json`. These are small, which keeps a private repo inside its artifact storage quota (500 MB on Free, 1 GB on Pro).
- **On failure only:** the Playwright HTML report, traces (`trace: 'retain-on-failure'`), failure screenshots, and `wrangler.log`.
- **Parity:** the oracle, candidate, and diff PNGs, the triptych, and `metrics.json` per target.
- **`$GITHUB_STEP_SUMMARY`**, written by the custom reporter in `e2e/lib/reporter.ts`:
  - a provenance line (commit, bundleHash, browser and version, runner OS);
  - one row per journey with status, duration, and measured latencies (for example "peer text p95 0.41 s / budget 2 s");
  - invariant counts;
  - BLOCKED versus FAILED;
  - the parity table (target, theme, diff %, largest blob, verdict).
- **Agents read results remotely:**
  ```sh
  gh run watch <id>
  gh run view <id> --log-failed
  d=$(mktemp -d); gh run download <id> -n e2e-webkit-1-diag -D "$d"
  # Read the PNGs and trace screenshots in $d, then: rm -rf "$d"
  ```
  The trace viewer works offline with `pnpm exec playwright show-trace <zip>`. Opening it is diagnosis, not a local test run.

### 2.7 Concurrency and cancellation

| Event | Group | Cancel in progress | Why |
|---|---|---|---|
| pull_request | `ci-pull_request-<pr#>` | yes | A newer push supersedes. |
| push main | `ci-push-<sha>` | no | Every main commit gets a verdict, and runs never queue behind each other. |
| schedule | `ci-schedule-refs/heads/main` | no | |
| workflow_dispatch | `ci-workflow_dispatch-<ref>` | no | Agents may dispatch several targeted runs at once. |
| deploy-staging (M8) | `deploy-staging` | no | Never cancel a migration or deploy mid-flight (glyphdown). |

Matrix legs use `fail-fast: false`, so an engine-specific failure never hides the other engine's result.

### 2.8 Infra versus product classification, flakes, retries

- `retries: 0`. A product assertion that fails is FAILED, period.
- The fixtures throw `InfraBlocked` for:
  - a dead stack pid;
  - an unreachable or mismatched `/api/version`;
  - a workerd crash signature in `wrangler.log`;
  - a browser launch failure;
  - a port in use;
  - apt or Playwright install failure;
  - Cloudflare-branded error pages, D1 7429, and Worker 1101 (LEARNINGS §4.19).
- The reporter writes `test-results/blocked.json`. CI restarts the stack and re-runs `--last-failed` exactly once. A second BLOCKED fails the job with the summary headline "BLOCKED (infra), not a product verdict". Product failures are never re-run.
- **Console allowlist** (`e2e/lib/allowlist.ts`): each entry has `{pattern, reason, ruling, scope: journey ids, expires}`. Page errors are never allowlisted. A new signature always fails (LEARNINGS §1.10 flake dispositions). An expired entry fails the selftest project.
- **Flake hunting is a remote dispatch:** `repeat_each=5` on the suspected journey, in both engines.

### 2.9 Time and minutes budget

GitHub bills Linux minutes per job, rounded up. Private repos get 2-vCPU, 7 GB ubuntu runners. The plan's included minutes are unknown, because `gh` lacks the `user` scope to read billing. The design assumes GitHub Free (2,000 Linux min/month); Pro includes 3,000.

| Run type | Jobs (billable min) | Total |
|---|---|---|
| Draft PR push | plan 1 + checks 6 | **7** |
| Ready PR push, no UI change | plan 1 + checks 6 + build 3 + e2e 12 ×2 + ci-ok 1 | **35** |
| Ready PR push, UI change | + oracle 1 (cache hit) + parity 5 | **41** |
| main push, tree already passed | plan 1 + checks 6 + build 3 + ci-ok 1 | **11** |
| Nightly (only if main changed) | build 3 + soak 15 + parity 6 + oracle 1 | **25** |
| Targeted dispatch (one engine, grep) | build 3 + e2e ~8 | **~11** |

Expected monthly use at 15 PRs, about 2 ready pushes and 3 draft pushes each, 15 main pushes, 15 nightlies with changes, and 15 dispatches: 30×38 + 45×7 + 15×11 + 15×25 + 15×11 ≈ **2,160 min**. That is slightly over Free and about 70% of Pro.

Controls, in order of use:

1. Durability pushes go to non-PR branches.
2. Drafts get `checks` only.
3. Superseded PR runs are cancelled.
4. The main-push e2e dedupe by tree.
5. Path filters.
6. Nightly skips an unchanged tree.
7. `vars.CI_DEGRADED=true` moves WebKit and parity off ready PRs. They keep running on main and nightly, and every summary carries a banner saying so.

The coordinator's scheduled bb liveness automation runs `node scripts/ci/minutes.mjs`. It makes read-only `gh api` calls that sum each job's `completed_at - started_at`, rounded up, for this month's runs. When month-to-date use exceeds 80% of the prorated budget, it sets `gh variable set CI_DEGRADED --body true`, and resets the variable on the 1st.

Suite time budget, enforced in config:

| Limit | Value |
|---|---|
| `timeout` per test | 120 s (240 s for `@hibernate`) |
| `globalTimeout` | 18 min per job |
| Journeys per engine, M1 target | ≤ 8 min |
| Journeys per engine, M8 target | ≤ 12 min |

The reporter flags any test over 90 s. When an engine's suite passes 12 min, switch to `workers: 2` (§3.2) before adding shards, because every shard pays about 3 min of setup.

### 2.10 Secrets

| Secret | Where | Why |
|---|---|---|
| `MOSS_ORACLE_DEPLOY_KEY` | moss-multi Actions secret; the matching **read-only deploy key** sits on `brsbl/moss` | The oracle job checks out the private moss repo at the pin. A deploy key is single-repo and read-only, and can be created entirely with `gh` (`gh repo deploy-key add --repo brsbl/moss`, then `gh secret set MOSS_ORACLE_DEPLOY_KEY --repo brsbl/moss-multi`). It is still a settings change on the owner's moss repo, so the coordinator confirms it first (§7). Alternative: an owner-created fine-grained PAT with Contents: read on brsbl/moss. |
| none | e2e | Every credential is minted per run. The deploy-key job runs only for same-repo events (the repo is private, so there are no fork PRs). |
| `CLOUDFLARE_API_TOKEN` and the account id | deploy workflow, M8 | The personal account only (LEARNINGS §5.4). Never used in PR CI. |

### 2.11 The staging deploy and the deployed-bytes check (M8, sketch)

`deploy-staging.yml` runs on dispatch or on main after `ci-ok` succeeds:

1. Build once with `CLOUDFLARE_ENV=staging MOSS_BUILD_ENV=staging`.
2. Run the full journey suite on **those** bytes under `wrangler dev --local`.
3. Run `wrangler d1 migrations apply --remote`.
4. Deploy that same `dist` with `wrangler deploy --config dist/server/wrangler.json`.
5. Wait about 20 s for propagation.
6. Check that staging `/api/version.bundleHash` equals the bytes tested in step 2.
7. Run the suite once more against the deployed URL with `--grep-invert @local-only` (pause, restart, and hooks are local-only). Hooks must 404 on staging; that is a negative-control smoke check.

## 3. The Playwright journey suite

### 3.1 Layout (one living suite)

```
e2e/
  playwright.config.ts
  tsconfig.json                      # typechecked in `checks`
  lib/
    test.ts                          # extended `test` with fixtures below; the only import journeys use
    stack.ts                         # Stack: provenance, pause/resume/restart, test hooks, d1()
    principals.ts                    # per-run principals: API sign-up (setup boundary), per-context sign-in
    actors.ts                        # Actor = principal × BrowserContext × Page × Telemetry (+ optional sever)
    telemetry.ts                     # console/pageerror/http/websocket census, installed before first navigation
    invariants.ts                    # the 9 global invariants (§3.5), run by the auto fixture after every test
    detectors.js                     # plain browser-side functions shared with the bb prelude (§4.4)
    sever.ts                         # routeWebSocket controller + stack pause
    hibernate.ts                     # eviction levers + instance-id proof (§3.7)
    ui.ts                            # UI verbs (createNote, openNote, typeBody, rename, share, trash, …) — roles/labels/DOM contract only
    text.ts                          # exact-bytes extraction and comparison
    measure.ts                       # phase clocks: dispatch-returned → observed
    allowlist.ts                     # console allowlist with reasons/expiry
    reporter.ts, verdict.mjs         # summary, blocked.json, verdict
  selftest/                          # negative controls for every detector (§3.8)
    fixtures/*.html
    detectors.spec.ts
  journeys/                          # J00…Jnn, one file per promise, cumulative
  parity/                            # §5
    targets.ts, parity.spec.ts, compare.ts, oracle-preamble.mjs, serve-static.mjs
  calibration/                       # workerd eviction-time bucketing (§3.7)
  qa/                                # example local bb scripts (§4.4) — not run in CI
```

Rules:

- One file per journey promise, edited in place. History lives in git, never in copies.
- A journey's steps are `test.step()` blocks named in user language. The step names are the spec, so there is no separate markdown spec to drift.
- Every user action goes through `lib/ui.ts`, which locates by role, label, or DOM-contract attribute. Fixed coordinates are banned, and so is `[contenteditable=true].first()`, which types into the title (LEARNINGS §4.1).
- Non-UI work is allowed only as setup or adversary: booting, contexts, principal sign-up and sign-in for non-auth journeys, severs, eviction, D1 pokes. Anything a user does goes through the UI. A missing affordance is a FAIL, never BLOCKED.

### 3.2 `playwright.config.ts`

```ts
import { defineConfig } from '@playwright/test';
const state = JSON.parse(require('node:fs').readFileSync(process.env.STACK_STATE!, 'utf8'));

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  globalTimeout: 18 * 60_000,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,                // 2-vCPU runner: workerd + 2–3 contexts. Raise to 2 only after 5× repeat stays green; @exclusive then runs in a second invocation.
  fullyParallel: false,
  reporter: [['list'], ['github'], ['html', { open: 'never' }],
             ['json', { outputFile: 'test-results/results.json' }], ['./e2e/lib/reporter.ts']],
  globalSetup: './e2e/lib/global-setup.ts',      // provenance + CSS/JS asset checks; InfraBlocked on mismatch
  use: {
    baseURL: state.baseUrl,
    viewport: { width: 1440, height: 1000 },     // pinned oracle size
    deviceScaleFactor: 2,                        // owner rule: evidence at ≥2×
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light',
    trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'off',
    actionTimeout: 10_000,
  },
  projects: [
    { name: 'selftest-chromium', testDir: './e2e/selftest', use: { browserName: 'chromium' } },
    { name: 'selftest-webkit',   testDir: './e2e/selftest', use: { browserName: 'webkit' } },
    { name: 'chromium', testDir: './e2e/journeys', grepInvert: /@soak/, dependencies: ['selftest-chromium'], use: { browserName: 'chromium' } },
    { name: 'webkit',   testDir: './e2e/journeys', grepInvert: /@soak/, dependencies: ['selftest-webkit'],   use: { browserName: 'webkit' } },
    { name: 'parity',      testDir: './e2e/parity',      use: { browserName: 'chromium' } },
    { name: 'soak',        testDir: './e2e/journeys', grep: /@soak/, use: { browserName: 'chromium' } },
    { name: 'calibration', testDir: './e2e/calibration', use: { browserName: 'chromium' } },
  ],
});
```

Tier A (PRODUCT viewports) is covered inside the journey: tests tagged `@tierA` loop over `[{1440×1000}, {390×844, hasTouch, isMobile}]` for their actors. This is not a separate project, so the phone pass shares principals and setup. `isMobile` is unsupported only in Firefox, which we do not run.

### 3.3 Fixtures

```ts
// e2e/lib/test.ts — journeys import { test, expect } from '../lib/test'
export const test = base.extend<{ actors: Actors; stack: Stack }, { runToken: string; stackW: Stack }>({
  runToken: [async ({}, use, w) => use(`${process.env.RUN_ID ?? 'local'}-w${w.workerIndex}`), { scope: 'worker' }],
  stackW:   [async ({}, use) => { const s = Stack.fromState(process.env.STACK_STATE!); await s.assertProvenance(); await use(s); }, { scope: 'worker' }],
  stack:    async ({ stackW }, use) => use(stackW),
  actors:   [async ({ browser, stackW, runToken }, use, testInfo) => {
    const a = new Actors(browser, stackW, runToken, testInfo);
    await use(a);
    await a.assertInvariants();   // §3.5 — every actor, every test; violations attach 2× PNG + census JSON
    await a.dispose();
  }, { auto: true }],
});
```

**Principals** (`lib/principals.ts`):

- `principal(label)` signs up through Node `fetch` POST `/api/auth/sign-up/email` with `Origin: baseURL`. Without that header, better-auth returns 403 `MISSING_OR_NULL_ORIGIN` (LEARNINGS §4.9).
- Email is `mm-<runToken>-<label>-<n>@example.invalid`.
- Display name is `"<Label> <runToken-suffix>"`, using distinct first letters (Ada, Ben, Cy, Dee) so chip initials and colors read clearly in screenshots.
- The password is 24 random characters, kept in memory only. Signing up through Node fetch keeps it out of Playwright traces.
- **The fixture refuses any email not ending in `@example.invalid`.** The owner's account is unreachable by construction.

**Sessions:** `Actors.open(principal, opts)` creates a **new BrowserContext**. It signs in through Node fetch, which yields one fresh session per context; tokens are single-issue (LEARNINGS §4.20). It copies the real `Set-Cookie` value into `context.addCookies`, with no fabricated signatures (LEARNINGS §5.5). Then it installs telemetry, adds the sever route if `opts.severable`, navigates, and waits for `html[data-app-state=ready]`.

- `Actors.sameAs(actor)` opens a second context and session for the same principal. This is the legitimate case of one person in two windows.
- `Actors.anonymous()` opens a context with no session, for share-link strangers.
- The J07 auth journey signs up and signs in through the real login UI instead.

**Distinct-principal guard:** `actors.requireDistinct(n)` asserts that `/api/me` returns n distinct principal ids. Presence journeys call it, because two contexts on one account count as one collaborator (LEARNINGS §4.5).

**Telemetry**, installed before the first `goto` on every actor:

- `console` errors and warnings;
- `pageerror`;
- every response ≥ 400 with method and path;
- `requestfailed`;
- `page.on('websocket')`, recording url, docId (from `/parties/doc-d-o/<docId>`), open and close times, `socketerror`, and optionally frame payloads (`ws.on('framesent' | 'framereceived')`) when a journey enables frame scanning.

**Stack** (`lib/stack.ts`):

| Method | What it does |
|---|---|
| `assertProvenance()` | Checks provenance (§2.4). |
| `pause()`, `resume()` | `node scripts/stack.mjs pause|resume`, i.e. SIGSTOP and SIGCONT on the group. |
| `restart()` | Same bytes, storage, secret, and port; waits for provenance. |
| `docInstance(docId)` | Test hook. |
| `resetDoc(docId)` | Test hook. |
| `d1(sql)` | `wrangler d1 execute DB --local --persist-to <state> --command …`. Adversary only, for example "revoke in D1 with no fan-out" (moss-collab B1-T4). |
| `alive()` | Liveness check. |

**UI verbs** (`lib/ui.ts`) follow the reliable path: title, then Enter, then body (LEARNINGS §4.20). `createNote(actor)` clicks moss's "+ Note", waits for `[data-title-binding=live]` and for focus on the title (restart ruling 2), types, and presses Enter. Modifier shortcuts use `ControlOrMeta`: CI runners are Linux, where the web build behaves as non-mac and uses Ctrl.

**Measurement** (`lib/measure.ts`): a clock starts **after** `keyboard.type()` returns (LEARNINGS §4.19 C-04), for example `await m.until('peer-text', () => peer.has(text))`. Latencies go into `results.json` and are asserted against PRODUCT budgets:

| What | Budget |
|---|---|
| Peer text | 2 s |
| Title, sidebar, and breadcrumb | 5 s |
| Half-open banner | about 13 s (assert ≤ 16 s) |
| Hard-drop chip clear | 8–20 s |
| Demotion close | ≤ 1 s |

### 3.4 DOM contract the product must publish

These attributes are production DOM, not dev hooks, because the deployed build strips automation globals (LEARNINGS §4.20). Their names and value unions live in **one module** (proposed `packages/protocol/src/dom-contract.ts`), imported by the product components, by `e2e/lib`, and serialized into the bb prelude. Renaming one breaks typecheck, not a run.

| Attribute | On | Values | Publish rule |
|---|---|---|---|
| `<meta name="moss-build">`, `html[data-client-build]` | head, html | `commit:hash` | §2.4 |
| `data-app-state` | `html` | `booting`, `ready`, `degraded` | `ready` once the shell has hydrated and the workspace list has loaded. `degraded` on a transient backend failure, never a `/login` bounce (ruling 10). |
| `data-editor-pane` + `data-doc-id` | each editor pane root (split view gives two) | doc id | |
| `data-doc-state` | pane root | `binding`, `live`, `offline`, `terminal` | `live` only after the first sync has landed **and** the root is editable, published in one effect after both are true. React runs child effects first (LEARNINGS §4.19). |
| `data-title-binding`, `data-body-binding` | title field, body root | `unbound`, `live`, `readonly`, `terminal` | While not `live`, the element is not focusable (no tabindex, `contenteditable=false`) (ruling 2). |
| `data-editor-generation` | body root | integer | +1 on every Lexical editor creation in that pane. Used for remount detection. |
| `data-sync-unacked` | pane root | `0`, `1` | `1` while local updates are not acknowledged by the server (the durability-honesty registry, LEARNINGS §4.6). Tests wait for `0` before reload or close instead of sleeping. |
| `data-connection` | connection indicator (`[data-collab-chrome]`) | `online`, `reconnecting`, `offline` | Derived from heartbeat and socket truth, never from `navigator.onLine`. |
| `data-terminal-reason` | pane root | `deleted`, `revoked`, `session-ended`, `suggest-policy` | Set by the doc-level terminal store (4410, 4403, 4402). Every editable surface in the pane must also be inert. |
| `data-role` | pane root | `viewer` … `owner` | The effective role. |
| `data-presence-pile` > `[data-presence-chip][data-principal-id][data-presence-color][data-self]` | top bar | | Zero chips when alone. |
| `[data-remote-caret][data-principal-id]`, `[data-remote-selection]`, `[data-remote-label]` | cursor overlay (pointer-transparent) | | The caret color and the chip color come from one getter. |
| `data-collab-chrome` | every web-added collab control (share, face pile, history, bell, banner, connection indicator) | | Must sit inside `[data-top-bar]`. |
| `data-editor-canvas` | the scrollable editor region below the top bar | | The floating detector's target. |
| `data-overlay-surface` | only DS menu, dialog, popover, sheet, and phone notes-panel primitives, applied in the primitives themselves | | The floating detector's allowlist. Ambient notices never carry it. |
| `data-floating-selection-toolbar` | moss's toolbar (existing) | | |
| `data-input-refusal` | the single refusal announcer (live region) | text | Any refused keystroke, paste, drop, or IME input in an unbound field shows here. |
| `data-sidebar-row` + `data-doc-id` + `data-active` | rail rows | | |

### 3.5 Global invariants (checked on every actor of every journey)

`actors.assertInvariants()` runs after the test. `checkpoint(name)` runs the cheap DOM invariants (5, 6, 9) mid-test and, for tests tagged `@evidence`, captures a 2× PNG.

| # | Invariant | How it is measured | Proven able to fail by |
|---|---|---|---|
| 1 | **Zero page errors, zero console errors** except allowlisted signatures; no 5xx; no 4xx unless declared with `actor.expectHttp(status, path)` | telemetry | `selftest/console-error.html`, `pageerror.html` |
| 2 | **Same build** | `meta(moss-build)` == `html[data-client-build]` == `/api/version` on every navigation and reload | `selftest/stale-build.html` |
| 3 | **One doc socket per open doc** | Per docId: at most 1 concurrently open socket on `/parties/doc-d-o/<docId>`; opens ≤ 1 + `actor.expectReconnects(n)`. J01 also holds one socket for ≥ 60 s. Only the doc-party path is counted; the C-20 lesson is to count the right socket. | `selftest/two-sockets.html` (opens two sockets to a local `ws` echo server) |
| 4 | **No editor remount** | `data-editor-generation` is unchanged from the start of `actor.observeEditor()` to the end, **and** a test-owned marker attribute set on the root element at start is still present (a React remount creates a new element without it). Declared remounts, such as a note switch, are excluded. | `selftest/remount.html` |
| 5 | **Nothing floats over the canvas** | `detectors.floatingOverCanvas`: (a) a 9×9 `elementFromPoint` grid over `[data-editor-canvas]`; every hit must be inside the canvas subtree, inside `[data-overlay-surface]`, the toolbar, or the remote-cursor overlay. (b) No `[data-collab-chrome]` rect may intersect the canvas rect. Uses `elementFromPoint` because `isVisible` ignores occlusion (LEARNINGS §4.20). | `selftest/floating.html`, plus an inline control in J00 that injects a fixed div over the live canvas and expects the detector to fire, then removes it |
| 6 | **No comment or suggestion markers leak** | `/%%?m:[^%\s]{1,64}:(start\|end)%%?/` absent from `document.body.innerText`, from the title, and from every `[data-sidebar-row]`. Export and pull checks are added in J15. | `selftest/marker-leak.html` |
| 7 | **Exact typed bytes on every peer** | Every `ui.typeBody` or `ui.typeTitle` registers `{docId, text, author, field}`. At the end, for every actor with that doc open, the pane's `[data-lexical-editor]` (or title) `textContent` contains `text` **exactly once and contiguously**. Several strings from one author into one block keep their order ('hello', not 'lolhe'). Tests ending in `actors.reloadAll()` re-check after reload on every actor. Test strings include spaces, punctuation, and one non-ASCII character. | `selftest/dropped-keystroke.html` (drops every third character), `reordered.html`, `duplicated.html` ("WORDWORD") |
| 8 | **Principals** | At least 2 distinct principal ids per journey (a `solo` opt-out needs a reason string). Every email is `@example.invalid`. | Unit test of the guard |
| 9 | **No editable before bind** | Every element under a `[data-title-binding]` or `[data-body-binding]` that is not `live` must be non-focusable and non-editable, and `document.activeElement` is never inside one. | `selftest/editable-unbound.html` |

A violation fails the test with a census JSON and a 2× PNG of the offending actor attached.

### 3.6 Severing a WebSocket for real in CI

Network emulation does not sever an established socket in Chromium: `context.setOffline(true)` and CDP `Network.emulateNetworkConditions` only flip `navigator.onLine`. `setBlockedURLs` does not block WebSocket handshakes (LEARNINGS §4.20). Two real methods remain:

**A. Per-client sever: `routeWebSocket` proxy** (Playwright ≥ 1.48; works in Chromium and WebKit). It is installed at context creation only for actors opened with `{severable: true}`.

```ts
// e2e/lib/sever.ts
export async function makeSeverable(ctx: BrowserContext) {
  const ctl = { mode: 'up' as 'up' | 'blackhole', conns: [] as Conn[], dropped: { out: 0, in: 0 } };
  await ctx.routeWebSocket(/\/parties\/doc-d-o\//, (page) => {
    const conn: Conn = { page, server: null, openedAt: Date.now() };
    ctl.conns.push(conn);
    if (ctl.mode === 'blackhole') return;            // reconnect attempts hang in CONNECTING until restore()
    attach(conn, ctl);
  });
  return {
    blackhole() { ctl.mode = 'blackhole'; },          // half-open: both ends stay OPEN, no frames, no close frame
    reset(code = 1012) {                              // abrupt drop, both ends; 1012 is in the product's transient-retry set
      ctl.mode = 'blackhole';
      for (const c of ctl.conns) { c.page.close({ code, reason: 'qa-sever' }); c.server?.close({ code }); }
    },
    restore() {
      ctl.mode = 'up';
      for (const c of ctl.conns.filter((c) => !c.server)) attach(c, ctl);   // let hung reconnects through
    },
    census: () => ({ connections: ctl.conns.length, dropped: { ...ctl.dropped } }),
  };
}
function attach(conn: Conn, ctl: Ctl) {
  const server = conn.page.connectToServer();
  conn.server = server;
  conn.page.onMessage((m) => (ctl.mode === 'up' ? server.send(m) : ctl.dropped.out++));
  server.onMessage((m) => (ctl.mode === 'up' ? conn.page.send(m) : ctl.dropped.in++));
  conn.page.onClose((code, reason) => server.close({ code, reason }));
  server.onClose((code, reason) => conn.page.close({ code, reason }));
}
```

- **What it proves:** one client's edits are buffered while its channel delivers nothing; its own heartbeat notices within about 13 s and the banner shows; its offline edits and the peer's concurrent edits converge losslessly once restored, while the other actor is unaffected throughout.
- **Proof that the sever is real:** while in black-hole mode, `dropped.out` grows as the client types, and the peer receives none of that text until `restore()`. Without the second check, a passing test could be a test that severed nothing.
- **Caveat:** the routed socket is Playwright's in-page shim. Severable actors use the route's own connection count as their census; invariant 3 uses `page.on('websocket')` only for non-severable actors.

**B. Whole-server half-open: SIGSTOP on the stack process group** (`stack.pause()`, `stack.resume()`). The kernel keeps the TCP connections established while workerd processes nothing, so every client sees an OPEN socket that delivers nothing. This is the true network half-open of LEARNINGS §4.6.

- Assert the banner shows on **all** actors within 16 s.
- Assert no WebSocket `close` event arrives before the client's own 4408 heartbeat close. This leg, from moss-collab's driver, is called "half-open sever carries no close frame".
- Assert both actors' offline edits converge after `resume()`.
- **Proof that the pause took effect:** `fetch('/api/version')` times out during the pause.

Both methods sit beside a **negative control in the same journey**: an identical idle window with no sever must show no banner and no reconnect for ≥ 20 s. That catches a banner that flaps.

### 3.7 Forcing DO hibernation and eviction in local wrangler

Behavior established from moss-collab evidence, to be re-verified in calibration:

- workerd evicts an idle DocDO after roughly 80–90 s with no incoming messages, while hibernatable sockets survive.
- An open app tab never lets the DO go idle, because the 4 s resync heartbeat wakes it.
- After a wake, the DO's awareness map and revocation cache are empty.

partyserver runs `onStart` (the storage replay) on the first `fetch` or WebSocket event after a wake, inside `blockConcurrencyWhile`. **RPC methods do not.**

**Test hooks** (restart ruling 7 forbids a playground; these are not one). They exist only when **all** of these hold:

- `MOSS_TEST_HOOKS=1`;
- the request arrives on a loopback origin;
- `BETTER_AUTH_URL` is loopback;
- the header `x-moss-test-hook` equals the per-run `MOSS_TEST_HOOKS_SECRET`, so page scripts cannot call the hooks.

Otherwise the hook routes return a 404 identical to an unknown route. The Worker refuses to serve if `MOSS_TEST_HOOKS=1` while `BETTER_AUTH_URL` is not loopback; this is the SEC-4 analogue. Only two hooks exist:

| Route | DO side | Use |
|---|---|---|
| `GET /__test/docs/:id/instance` | An RPC method returning `{instanceId, constructedAt}`, set in the constructor. It does **not** call `onStart` and does not touch the doc. | Proves that a wake happened. |
| `POST /__test/docs/:id/reset` | `this.ctx.abort('qa-reset')` | Resets one DO. |

Calibration must record whether sockets survive `abort()` in local workerd. If they close, the reset lever behaves like a restart for a single doc.

Seeding never goes through hooks. Content is created through the UI, or through public APIs as declared setup.

**The levers:**

| Lever | How | Simulates | Sockets |
|---|---|---|---|
| L1 restart | `stack.restart()`: SIGTERM the group, then the same `wrangler dev` args (bytes, `--persist-to`, `BETTER_AUTH_SECRET`, port) | Process-wide eviction and redeploy. Restore from storage; the permanent "reopen shows content" gate. | All drop (1006); clients reconnect |
| L2 reset one DO | `stack.resetDoc(id)` | DO crash or reset for one doc only | Recorded by calibration |
| L3 natural hibernation | Quiesce every client of the doc, idle `IDLE_MS`, then act | Real hibernation with surviving sockets: empty awareness map, empty revocation cache, the post-wake first frame | Survive |

Ways to quiesce a client for L3:

- (a) close its tab, for reopen journeys;
- (b) simulate a background tab: override `document.visibilityState` and dispatch `visibilitychange`, which the product uses to pause heartbeats. This works in both engines and is flagged "simulated" in the report, because headless browsers cannot be truly hidden (LEARNINGS §4.20);
- (c) Chromium only: CDP `Page.setWebLifecycleState({state:'frozen'})`, which really stops timers. The probe confirmed it works in the plugin's Chrome for Testing 151, and Playwright's Chromium exposes it through `context.newCDPSession(page)`.

Pending DO alarms also prevent eviction, and the proof below catches that.

**Proof-of-induction protocol** (`lib/hibernate.ts`). Never probe between the idle period and the decisive action, because the probe itself wakes the DO.

```ts
const base = await stack.docInstance(docId);          // 1. baseline (wakes it now; idle clock starts after)
await quiesce(actorsOn(docId));                       // 2. close / background / freeze
await sleep(IDLE_MS);                                 // 3. calibrated, ≥ 95 s
const t = Date.now(); await decisiveAction();         // 4. reopen / peer joins / surviving socket sends first frame
const after = await stack.docInstance(docId);         // 5. the instance that served step 4
expect(after.instanceId, 'hibernation not induced').not.toBe(base.instanceId);
expect(after.constructedAt).toBeGreaterThan(base.constructedAt);
expect(after.constructedAt).toBeLessThanOrEqual(t + 2000);
```

**Calibration** (`e2e/calibration/eviction.spec.ts`). It runs nightly and at M0. It creates four docs, quiesces them, probes doc *k* only at *k* × 30 s, and so buckets the eviction time in one 120 s pass. `IDLE_MS = max(95 s, 1.2 × measured)` lives in `e2e/lib/calibrated.json`. If calibration measures eviction above 150 s, it fails loudly instead of silently stretching journeys.

**Cost control:** journeys that need L3 share **one** idle window. All L3 legs live in one `@hibernate` block in `j04`. It prepares every scenario on its own doc (reopen-after-hibernation and a peer joining after idle from M1; a revoked link's first frame after wake, from M2), idles once, then checks each. That costs about 100 s of wall time per engine per run. The 10-min soak (the legacy C-09 bar) is nightly only.

### 3.8 Proving that each gate can fail

1. **Detector selftests on every run** (`selftest-chromium` and `selftest-webkit`; about 15 s each; journeys depend on them). Each fixture violates exactly one invariant, and one clean fixture must yield zero findings. Fixtures: `console-error`, `pageerror`, `stale-build`, `two-sockets`, `remount`, `floating`, `marker-leak`, `dropped-keystroke`, `reordered`, `duplicated`, `editable-unbound`, and `clean`. They also cover the extraction helpers (`text.ts`) and the allowlist expiry. A detector that stops detecting turns CI red even when the product is fine.
2. **Inline live controls in journeys:**

   | Journey | Negative leg | Positive leg |
   |---|---|---|
   | J00 | Inject an over-canvas div; the detector must fire | Remove it; the detector must be clean |
   | J01 | 0 peer chips when alone | Exactly 1 peer chip once B joins |
   | J01 frame scan | Forbidden per-viewer keys (`__colWidths`, `__activeIndex`, `__result`, `__stale`, `__name`, `__nodeFormat` misuse) must be absent from frames | A key that must replicate (`__type` after a structural edit) must be present (LEARNINGS §4.3) |
   | J03 | No sever means no banner | Sever means banner |
   | J04 | The instance id must change (§3.7) | |
   | J09 | Warm row: a frame lands | Cold row, revoked in D1: the frame never lands (the one-variable warm-versus-cold differential) |
   | J08 | — | Revoked, forged, and nonexistent docs get **byte-identical** 404 bodies (SHA compared). An "expected 4xx, got 200" result is graded only after a mutating retry confirms it (LEARNINGS §4.17). |

3. **RED on pre-fix bytes** (`red-proof.yml`). Every defect-fix PR names its regression test. The checker dispatches `red-proof` with `base_sha` set to the PR's merge base and `tests_sha` set to the PR head. The job passes only if those tests fail on product assertions. A failure caused by a missing readiness attribute does not count; the job prints the failing assertion messages, and the checker reads them. This is the "regression ratchet" (LEARNINGS §6).
4. **Clock and oracle sanity:** parity's "honest floor" captures the oracle twice and requires a diff of 0 (§5.4), and calibration re-measures eviction nightly.

### 3.9 Journey catalog (cumulative; maps to LEARNINGS §7.2–7.3)

| File | M | Promise (test title) | Key legs and state variation |
|---|---|---|---|
| `j00-shell.spec.ts` | M0 | The real moss shell boots, styled, with zero errors | Provenance; CSS/JS assets; light and dark through the real Settings toggle; the hidden-affordance registry (no native-only items visible); floating-detector control; a CLI-pushed doc renders the same as one authored in the UI (once the CLI exists) |
| `j01-coedit.spec.ts` | M1 | Two people edit one note live | Create (title non-focusable until bound, then focused); B opens through the sidebar; concurrent typing with exact bytes; chips (0, then 1); caret and selection color equal to the chip; one socket held 60 s; Cmd+Z undoes only your own edits; frame scan; B closes and A's chip clears; reload both and re-check bytes |
| `j02-title.spec.ts` | M1 | A rename reaches the other person everywhere | ≤ 5 s to title, sidebar, and breadcrumb with zero keystrokes in B; A→B→C monotonic; concurrent renames merge; a mid-edit title is not clobbered; no remount on title change; typing into an unbound title shows a refusal |
| `j03-connection.spec.ts` | M1 | A brief disconnection loses nothing, and the indicator tells the truth | Severable B: black-hole, type, restore; reset leg; SIGSTOP leg; negative control |
| `j04-hibernation.spec.ts` | M1 | A doc always reopens with its content | L1 restart reopen; L3 idle reopen; a peer joining after idle sees presence; warm creator with a cold peer (`@hibernate`) |
| `j05-trash.spec.ts` | M1 | Delete is restorable trash, and nobody zombie-edits | Peer gets 4410; every editable surface is inert (swept by attribute); a fresh load returns 404; restore converges |
| `j06-folders.spec.ts` | M1 | Folders work from the web UI | Create, rename, and delete a subtree to trash, starting from an empty workspace as a naive principal |
| `j07-auth.spec.ts` | M2 | Sign up, in, and out | Real login UI; sign-out in window A ends window B's session (`data-terminal-reason=session-ended`) |
| `j08-share.spec.ts` | M2 | Share with a person or a link at a role | Role menus grow with rank; a viewer's checkbox and slash controls are inert; link role works as a ceiling; non-disclosing 404s |
| `j09-revoke-live.spec.ts` | M2 | Demotion and revocation bite the open connection | ≤ 1 s with a read-only message; the warm row of the wake differential (the cold row runs in j04's shared idle window) |
| `j10-stranger-phone.spec.ts` | M2 | A stranger with a link can read and sign in to the same doc (`@tierA`) | 390×844 and 1440×1000, with 0, 1, and 2+ live collaborators |
| `j11`–`j14` | M3 | Media, search and backlinks, vaults, the demo note built through the UI (ruling 8, in a test account; staging-only project `demo`) | |
| `j15-comments` | M4 | Comment, then type anywhere; the peer matches | Two comments in one paragraph; bidirectional typing; `.md` export has no markers |
| `j16-suggest` | M5 | Suggest, then accept or reject | Colliding-prefix typing gets no 4403; a suggester's first delete on a cold load never deletes |
| `j17-history` | M6 | Restore keeps peers' work | Restore during peer typing; a failed versions fetch shows an error |
| `j18-agents` | M7 | A CLI push merges while a human types | CLI run from the e2e job against the same stack; `cat` is byte-exact; 2 MB push |

"Vary state" (LEARNINGS §4.19, §7.1 #13) is expressed through fixtures, not copies:

- `actors.warm(principal)` creates 20 notes, opens 5, and edits 3 before the leg (a warm workspace, warm stack, and warm creator);
- a fresh principal is the cold peer;
- `@hibernate` legs cover the idle state;
- `@tierA` loops the viewports;
- both engines run every journey.

### 3.10 Engine notes

- **Clipboard.** Chromium contexts get `clipboard-read`/`clipboard-write` permissions, so `ui.pasteMarkdown` performs a real `ControlOrMeta+V`, which triggers moss's markdown import (LEARNINGS §4.19). WebKit cannot read the clipboard, so share links are read from the rendered dialog and WebKit authoring falls back to typed markdown shortcuts.
- **IME.** IME-composition legs are Chromium-only, using CDP `Input.imeSetComposition`. Paste and drop into unbound fields must either land or show the `data-input-refusal` announcer.
- **Backspace.** WebKit's bare-Backspace history navigation is asserted in `j02`: the URL is unchanged after Backspace with no editable focus.
- **Architecture.** CI is native Linux x64. The report records the browser name and version, `process.arch`, and the runner image. On the Mac, the launcher refuses translated Node (§4.1).

## 4. Local dev stack and the bb Browser Automation helper

Local work only builds and launches the real stack and drives it through bb Browser Automation. No vitest, tsc, lint, or Playwright runs locally.

### 4.1 `scripts/stack.mjs` (about 300 lines; the same file CI uses)

```
node scripts/stack.mjs start      [--run-id ID] [--port P] [--prebuilt DIR] [--hooks] [--expect-commit SHA] [--expect-bundle HASH] [--json]
node scripts/stack.mjs restart    --run-id ID          # same bytes, persist dir, secrets, port
node scripts/stack.mjs pause|resume --run-id ID        # SIGSTOP / SIGCONT the process group
node scripts/stack.mjs status|verify --run-id ID       # verify = provenance re-check
node scripts/stack.mjs principals --run-id ID --count N [--labels ada,ben,cy]
node scripts/stack.mjs stop       --run-id ID [--purge] # --purge deletes state/ and build refs, never shots/
node scripts/stack.mjs reap       [--ttl 4h] [--dry-run]
```

`start` runs these steps in order:

1. **Preflight.**
   - On darwin, require `process.arch === 'arm64'` and `sysctl -n sysctl.proc_translated` ≠ 1. On Linux, record the arch.
   - Require Node ≥ 22.7, pinned by `.node-version` (24 LTS).
   - Run `reap`.
   - Allow at most **2** live stacks machine-wide (the machine constraint) through the registry `~/.cache/moss-multi/stacks/<port>.json` (`{repo, runId, pgid, port, startedAt}`), shared by every worktree.
   - Require ports `P` and `P+1000` to be free.
   - Default ports: the first free port in 8850–8869.
   - Print `os.loadavg()` for the record. It is not a gate; the admission gate was archived.
2. **Build, unless `--prebuilt`.**
   - Cache key: `sha256(HEAD + git diff HEAD --binary + untracked paths and contents under apps/ packages/)`.
   - Reuse `.local-stack/builds/<key>/` if it exists; keep the 3 most recent.
   - Otherwise run `vite build --outDir .local-stack/builds/<key>` with `MOSS_BUILD_ENV=local`, `CLOUDFLARE_ENV=` (empty), and the dirty fields filled in. A bare build must never pick up staging or production bindings (LEARNINGS §4.18).
3. **Migrate:** `wrangler d1 migrations apply DB --local --persist-to <run>/state --config apps/web/wrangler.jsonc`.
4. **Spawn** `node <wrangler.js> dev --config <build>/server/wrangler.json --local --ip 127.0.0.1 --port P --inspector-port P+1000 --persist-to <run>/state --show-interactive-dev-session=false --log-level info` with the `--var` set from §2.5, `detached: true` (so pgid = pid), and stdout and stderr appended to `<run>/wrangler.log`.
   - Secrets are per-run random values stored in `<run>/secrets.json` (0600) and reused by `restart`. A fresh secret on restart would 401 every live session.
   - `--var` values are visible in `ps` to the same user only, and contain no real credentials.
5. **Ready** when `/api/version` matches the build's provenance (and the `--expect-*` values if given), `GET /` carries the meta tag, and the CSS asset returns 200. The timeout is 60 s, after which the group is killed and the log tail printed.
6. **Record** `<run>/state.json` (0600) and the registry entry. Print JSON with `baseUrl: "http://127.0.0.1:P"`, the URL to click. Do not substitute `localhost`: better-auth's origin and cookies are tied to `127.0.0.1`.

**Stop and signals:** before any signal, read `ps -o command= -p <pgid>` and require that it names `--persist-to <this run's state dir>`. Then send SIGTERM to `-pgid`, wait 5 s, and SIGKILL.

**`principals`:** API sign-up exactly as in §3.3. Writes `<run>/principals.json` (0600: label, name, email, password, id). Prints labels and emails only, never passwords.

**Run directory** (`.local-stack/` is already gitignored):

```
.local-stack/runs/<runId>/{state.json, secrets.json, principals.json, wrangler.log, state/, shots/, qa.json}
.local-stack/builds/<key>/{server/, client/}
~/.cache/moss-multi/stacks/<port>.json
```

### 4.2 Orphan reaper (`stack.mjs reap`, also run by `start`)

1. List `ps axo pid,pgid,etime,command` (works on both macOS and Linux).
2. **Attribute:** a process is ours only if its command line contains `/.local-stack/runs/<id>/state` (wrangler, its node parent, and the workerd child all carry `--persist-to` or the config path). Unattributable processes are never touched. That includes the bb plugin's Chrome, which bb's own session expiry manages, and anything belonging to another project.
3. **Reap** a group when any of these holds:
   - its run's `state.json` is missing, or its status is `stopped` or `failed`;
   - its registry entry's pid is dead (a leaderless group whose workerd outlived its wrangler);
   - it is older than `--ttl` (default 4 h).
4. Kill with SIGTERM to `-pgid`, then SIGKILL after 5 s.
5. Remove stale registry entries.
6. Prune run directories older than 24 h, but keep `shots/` unless `--purge-shots`. That is task evidence, which the owner rules say must be moved or uploaded first.
7. Print `{reaped: [...], kept: [...]}`. Use `--dry-run` to preview.

This replaces moss-collab's 846-line preflight (LEARNINGS §5.3, "keep only the reaper and serial runs").

### 4.3 Principals for local QA

`stack.mjs principals --count 2 --labels ada,ben` produces two real accounts on the local stack. The QA helper signs them in by one of two routes:

- (a) the real login UI (`signInUI`), the default for anything touching auth;
- (b) a fetch sign-in inside the DevBrowser script followed by `page.setCookie` with the real `Set-Cookie` value, which is fast for everything else.

Credentials are inlined into a 0600 temp script inside the run directory and deleted after the run. `stop --purge` deletes the D1 state, which deletes the principals with it. Principals never leave loopback.

### 4.4 `scripts/qa.mjs`: the bb Browser Automation helper

**Facts verified by a probe on 2026-10-02** (`bb browser-automation open --backend local --headless --machine host_37m3sgpq59`):

- The browser is Chrome for Testing **151.0.7922.71**, the native **arm64** build at `~/.cache/chrome-for-testing/chrome-mac-arm64/`, launched `--headless=new` at a default window size of 1280×720.
- Scripts get real Puppeteer objects. `page.browser().createBrowserContext()` works and gives an isolated cookie jar per principal.
- `page.setViewport({width:1440,height:1000,deviceScaleFactor:2})` produces `devicePixelRatio === 2`.
- `page.screenshot({path:'/abs/…png', type:'png'})` wrote a **2880×2000 PNG** to an absolute path. That is the 2× evidence path.
- A page in a non-default context can be re-attached in a **later run** with `browser.getPage(<targetId>)` (from `page.target()._targetId`, a private but working field), so actors persist across runs.
- `page.createCDPSession()` works, and `Page.setWebLifecycleState({state:'frozen'})` succeeds.
- `saveFile` and `readFile` persist small state between runs, jailed to names only.

**Limits that shape the helper:**

- A run is capped at 120 s, so flows longer than that are split into several runs.
- A run returns at most 4 JPEG previews (500 KB in total), downscaled to a 1568 px maximum edge. **Evidence therefore goes to PNG files, not to returned images.**
- Sessions expire after 30 min idle.
- One session per task, closed at the end (owner rule).
- Listeners do not outlive a script, so socket and console census happen inside a single run.

**CLI:**

```
node scripts/qa.mjs open   --run-id ID          # bb browser-automation open --backend local --headless --machine host_37m3sgpq59 --json → <run>/qa.json
node scripts/qa.mjs run    --run-id ID FILE.js [--timeout 120s]
                                                 # prepends the prelude, writes <run>/qa-<n>.js (0600), runs
                                                 # bb browser-automation run <sid> --script-file … --script-host host_37m3sgpq59 --timeout … --json,
                                                 # deletes the temp script, prints {result, shots:[abs paths]}
node scripts/qa.mjs close  --run-id ID          # closes non-default contexts, then the session
```

**The prelude** is a generated string, because DevBrowser scripts cannot `import`. It defines:

```js
const STACK = { baseUrl, runId, commit, bundleHash, shotsDir };   // from state.json
const P = { ada: {email, password, name}, ben: {...} };           // from principals.json
const DOM = { /* serialized dom-contract.ts */ };
const D = { /* e2e/lib/detectors.js functions, serialized with Function#toString */ };
const MOD = 'Meta';                                                // macOS host: moss shortcuts use Cmd

async function actor(name, principal, { width = 1440, height = 1000 } = {}) {
  // re-attach by targetId saved in qa-actors-<runId>.json, else: own BrowserContext + page,
  // setViewport(dpr 2), CDP Emulation.setFocusEmulationEnabled({enabled:true}) so typing in one actor
  // does not blur another (Puppeteer does not emulate focus by default; Playwright does),
  // sign in (cookie route), goto baseUrl, wait html[data-app-state=ready], assert build meta == STACK.
}
async function signInUI(page, principal) { /* real login form */ }
async function waitAttr(page, sel, attr, value, ms = 10000) { /* waitForFunction */ }
async function typeBody(page, text) { /* focus body via click on [data-body-binding=live], keyboard.type(text,{delay:15}) */ }
async function bodyText(page, docId) { /* textContent of the pane's [data-lexical-editor] */ }
async function shot(page, name) { const p = `${STACK.shotsDir}/${Date.now()}-${name}.png`;
  await page.screenshot({ path: p, type: 'png' }); return p; }               // 2× PNG
async function detect(page, which) { return page.evaluate(D[which]); }        // floatingOverCanvas, markerLeak, editableBeforeBind, buildMeta …
async function sockets(page, ms) { /* CDP Network.enable; count webSocketCreated/Closed for /parties/doc-d-o/ during ms */ }
async function freeze(page, on) { /* CDP Page.setWebLifecycleState frozen|active */ }
```

**Example local QA session** (one deliberate pass, then close):

```sh
node scripts/stack.mjs start --port 8851 --hooks --json        # → baseUrl http://127.0.0.1:8851, dirty:false, commit …
node scripts/stack.mjs principals --run-id <id> --count 2 --labels ada,ben
node scripts/qa.mjs open --run-id <id>
node scripts/qa.mjs run  --run-id <id> e2e/qa/two-window-typing.js
node scripts/qa.mjs close --run-id <id>
node scripts/stack.mjs stop --run-id <id> --purge
```

```js
// e2e/qa/two-window-typing.js  (body only; the prelude supplies the rest)
const a = await actor('ada', P.ada);
const b = await actor('ben', P.ben);
await a.click('button[aria-label="Create new note"]');   // moss's "+ Note" control (label per moss-collab drivers)
await waitAttr(a, '[data-title-binding]', 'data-title-binding', 'live');
await a.keyboard.type('QA two-window ' + STACK.runId); await a.keyboard.press('Enter');
const token = 'qa-' + Date.now().toString(36) + ' é!';
await typeBody(a, token);
// … b opens the note from the rail (role/label), then:
await b.waitForFunction((t) => document.querySelector('[data-lexical-editor]')?.textContent.includes(t), { timeout: 5000 }, token);
({ token,
   shots: [await shot(a, 'ada-typed'), await shot(b, 'ben-sees')],
   floating: await detect(a, 'floatingOverCanvas'),
   markers: await detect(b, 'markerLeak') });
```

**Evidence rules.**

- PR before and after screenshots come from this helper, run against the PR's merge base and its head. Each capture records `dirty:false` and the commit from `/api/version` beside it.
- Evidence captured on a dirty tree is labeled as such and is never used as PR evidence.
- Screenshots are viewed with the Read tool and posted inline, then uploaded with `gh pr edit --attach`.
- Shots live under `<run>/shots/` (task-scoped and gitignored) and are deleted after upload.

## 5. Visual parity against moss Ladle (lean)

### 5.1 The oracle: build and serve

- **CI** (the `oracle` job, §2.3):
  1. Check out `brsbl/moss@762abb7770714a49d912f6081384aabb958a7ea6` into `.oracle/moss` with the read-only deploy key.
  2. `e2e/parity/oracle-preamble.mjs` makes the only edits:
     - it **derives** the preamble from the pin itself: the `import` lines at the top of `packages/desktop/src/renderer/main.tsx` (the Prism setup, then `@fontsource-variable/inter/wght.css`, `wght-italic.css`, `@fontsource-variable/jetbrains-mono/wght.css`, `@fontsource/jetbrains-mono/latin-400.css`, `latin-500.css`, and `charter-webfont/charter.css`), rewritten to be relative to `.ladle/`, and prepends them to `.ladle/components.tsx`, so Ladle loads exactly what the real app loads (LEARNINGS §5.2: Ladle has no webfonts and needs Prism);
     - it removes `pnpm.supportedArchitectures`, as moss's own `setup-ci` does.
  3. Run `pnpm@9.10.0 install --frozen-lockfile` with `ELECTRON_SKIP_BINARY_DOWNLOAD=1`, then `pnpm run ladle:build`. This is moss's own CI recipe on ubuntu.
  4. Cache `.oracle/ladle` under `ladle-oracle-762abb777-<preamble hash>`. Nightly runs keep it warm. On main it is also uploaded as an artifact.
  5. Serve it with `e2e/parity/serve-static.mjs` (a 30-line static server with `.js` and `.css` MIME types) on `127.0.0.1:61007`.
- **Locally:** never build Ladle inside `/Users/brsbl/Code/moss-multi/.refs/moss` (read-only) and never touch `~/Code/moss`. Download the CI-built oracle instead:
  ```sh
  gh run download -n ladle-oracle-762abb777-<hash> -D .local-stack/oracle
  node e2e/parity/serve-static.mjs .local-stack/oracle 61007
  ```
  Then open `http://127.0.0.1:61007/?story=desktop-app--default&mode=preview` beside the candidate in the same bb session for a by-eye check. The binding pixel gate runs only in CI. If a local rebuild is ever required, `rsync` `.refs/moss` to a `mktemp -d` copy and apply the same preamble there.

### 5.2 Targets and the oracle audit

`e2e/parity/targets.ts` declares each target once:

```ts
{ id: 'shell-default', story: 'desktop-app--default', themes: ['light','dark'],
  seed: 'mockNotes',                       // candidate principal gets the same notes (Checklist, Daily Journal in "Notes") via UI paste / public API setup
  crop: '[data-moss-app-shell]', floor: 0.05,
  masks: ['[data-collab-chrome]', '[data-note-updated-at]'],   // sanctioned web chrome + timestamps; masked area capped at 3% of the crop
  audited: '2026-10-xx: full 1440×1000, 13 font descriptors load, no Ladle chrome, data-theme flips both' }
```

Initial set, all from `Desktop/App` and `Panels/*` at the pin, story ids resolved from `/meta.json`:

| Target | Ladle story | Candidate state |
|---|---|---|
| `shell-default` | `desktop-app--default` | the seeded `mockNotes` workspace |
| `shell-empty` | `desktop-app--empty-notes` | a fresh principal. **Audit first:** LEARNINGS records an empty story rendering in a stubbed 320 px frame. |
| `canvas-new-note` | `panels-canvas-area--new-note` | a fresh "Untitled" note after it binds |
| `notes-list-*` | `panels-notes-list--with-folders` | a seeded folder tree |

Every target runs in light and dark. The oracle uses `&theme=dark`; the harness asserts `html[data-theme=dark]` on both sides after load.

The audit runs as code on every capture:

- `document.fonts.check()` passes for all 13 descriptors: Inter 300–700 normal and italic, JetBrains Mono 400 and 500, Charter 400 and 700 normal and italic;
- the crop's rect is at least 1400 px wide;
- the expected seed titles are visible on both sides;
- the theme attribute is correct.

A target whose audit fails is BLOCKED (oracle), not FAILED (LEARNINGS §4.19: "the oracle must be audited first").

### 5.3 Capture

Both sides are captured in the same Playwright Chromium on the same runner, which is why 0.00% is honest here. Viewport 1440×1000, DSF 2, and `page.clock.install({ time: '2025-01-09T12:00:00Z' })`, which is Ladle's `STORY_NOW_ISO`. Before capture:

1. Await `document.fonts.ready` and two `requestAnimationFrame`s.
2. Press Escape.
3. Blur the active element and clear the selection.
4. Park the mouse at (1438, 998).
5. Hide carets (`caret: 'hide'`) and disable animations.

Capture with `locator(crop).screenshot()`, which returns device pixels at DSF 2 with no fractional cropping. Take the oracle **twice**; the honest floor between the two oracle captures must be 0.

### 5.4 Compare

`e2e/parity/compare.ts` uses `pngjs` and `pixelmatch`:

1. Pad both images to a common canvas from the top-left; never resize. Any size difference is itself a FAIL, reported as Δw×Δh.
2. Paint the same mask rects on both images.
3. Run `pixelmatch` with `threshold 0.1` and `includeAA: false` to get `diffPct`.
4. Label 8-connected components of the diff mask to get `maxBlob`, the largest area in device px.

A target passes only if all of these hold:

- `diffPct ≤ floor` (default 0.05%, the G-13 precedent);
- `maxBlob ≤ 16 px²`, so only anti-aliasing-scale specks are allowed and any glyph-, border-, or element-scale difference fails;
- the size delta is zero;
- the masked area is ≤ 3%.

A pass above 80% of the floor gets a "near threshold, explain" annotation; LEARNINGS §4.19 rejected 0.2407% against 0.25% as green. A masked region never hides placement errors, because invariants 5 and 9 and the top-bar containment check run on the same candidate page.

Outputs go to `test-results/parity/<target>-<theme>/`: `oracle.png`, `candidate.png`, `diff.png` (red marks the differing pixels), `triptych.png` (oracle | candidate | diff), and `metrics.json`.

### 5.5 Reading the diff image

The numbers decide pass or fail mechanically. A human-equivalent read is still required in two cases:

- **a new target or a changed floor or mask:** the checker downloads `parity-<attempt>`, Reads `triptych.png` and `diff.png` at full resolution, states in the PR what the red regions are, and posts the triptych inline;
- **any failing target:** the agent Reads the diff before diagnosing. The location and shape of the red pixels (whole glyph runs mean a font or weight problem; edges mean spacing; blocks mean missing chrome) is the diagnosis, and the percentage alone is not (LEARNINGS §4.19: "read the diff image, not the number").

### 5.6 What Ladle cannot cover

At the pin, Ladle's App stories render notes with empty content (`story-data.tsx` returns `content: ''`), and no story renders the node families. Node-family fidelity (tables, callouts, tabs, charts, sketch, HTML, code, pills) therefore needs the **real moss desktop app** as the oracle (LEARNINGS §1.1, ruling 6). That makes it a milestone-time, owner-gated baseline task, not CI:

1. Capture the desktop app locally from a temp copy at the pin (LEARNINGS §5.2 recipe), with fixture notes authored by pasting the same markdown.
2. Compare it in CI by **computed-style parity**, which is OS-independent: for each node selector, compare `getComputedStyle` over a fixed property list (font family, size, weight, line height, color, background, padding, margin, border, radius) between values recorded from the desktop oracle into `e2e/parity/desktop-styles@762abb777.json` and the candidate. LEARNINGS §4.1 records this catching a `mb-1` rule overriding a moss rule.
3. Do the pixel comparison locally, in the same Mac session, read by the checker.

Pixel diffs between macOS oracles and Linux candidates are not used, because font rasterization differs by OS.

## 6. What this infrastructure requires of the product (input to the architecture)

1. Provenance: `/api/version` with the shape in §2.4, the SSR meta tag, and the client build stamp. The build must be deterministic up to the placeholders.
2. The DOM contract in §3.4, held in one shared module and present in production builds.
3. A loopback-only test-hook gate with exactly two routes (instance probe and reset). The Worker refuses to serve when hooks are enabled on a non-loopback auth URL.
4. A DocDO constructor that sets `instanceId` and `constructedAt`, plus an RPC probe that does not run `onStart`.
5. Client heartbeats pause while `document.hidden`, so natural hibernation is reachable. Every heartbeat and awareness timer must also stop on `pagehide`.
6. A close-code vocabulary that marks 1001, 1006, 1011, and 1012 as transient-retry and 4402, 4403, 4410, and 4429 as terminal, so test severs exercise the retry path.
7. An `@example.invalid`-friendly open sign-up on loopback and staging, better-auth honoring `Origin`, and a session cookie that `addCookies` can copy.
8. `wrangler.jsonc` with the D1 `migrations_dir` committed. A built `dist/server/wrangler.json` must run under `wrangler dev --local --config` unchanged.
9. A CLI that can run inside the e2e job against `STACK_BASE_URL` (M7).

## 7. Open items for the coordinator or owner

1. **GitHub plan and minutes.** The plan could not be read (no `user` scope). The design fits Pro (3,000 min) comfortably and Free (2,000) only with `CI_DEGRADED` doing work. Confirm the plan, or set a spending limit.
2. **Oracle access.** Adding a read-only deploy key on `brsbl/moss` is a settings change on the owner's product repo. An owner-made fine-grained PAT is the alternative. Without either, parity cannot run in CI.
3. **Branch protection on `main`:** require `ci-ok`, and require branches to be up to date. This is needed for the dedupe.
4. **Staging test principals** accumulate (soft-delete never reclaims DO storage; LEARNINGS §8 Q12). Decide on purge or a fixed pool before M8.
5. **Verify at M0 with the calibration and selftest projects; do not assume:**
   - workerd's idle-eviction time and whether sockets survive `ctx.abort()`;
   - whether Playwright still fires `page.on('websocket')` for routed sockets (the design does not depend on it);
   - that Ladle's `&theme=dark` sets `html[data-theme]`;
   - that `desktop-app--empty-notes` is full-size.

## 8. Lesson-to-design traceability (short)

| Lesson (LEARNINGS) | Where it is handled |
|---|---|
| Proxy green; unit tests are not evidence (§3, §4.19) | Journeys on the built Worker in real engines; unit tests only gate `checks` |
| Served bytes ≠ tested bytes; zombie servers (§4.18) | §2.4 provenance on every navigation; launcher cmdline-verified kill; reaper |
| Every gate must be able to fail (§4.19) | §3.8 selftest project, inline controls, `red-proof` |
| Offline emulation doesn't sever WS (§4.6, §4.20) | §3.6 routeWebSocket proxy and SIGSTOP, each with proof legs |
| Hibernation bugs appear only warm or idle (§4.5, §4.7) | §3.7 levers, instance-id proof, calibration, shared idle window |
| Presence dedupes by account (§4.5) | `requireDistinct(n)`, a context per principal |
| Never the owner's account (§4.20) | `@example.invalid` enforced in the fixture |
| Versioned driver copies, 9 versions, never green (§6) | One living suite, in-place edits, UI verbs in one module |
| Clock boundaries (§4.19) | `measure.ts` starts after dispatch returns |
| Infra deaths booked as verdicts (§3, §4.19) | `InfraBlocked`, `blocked.json`, a single re-run, a distinct summary |
| Verification overhead ate the budget (§0, §6) | Minutes budget, dedupe, drafts get checks only, evidence kept small |
| Oracle font artifacts and stubbed stories (§4.19) | The oracle preamble derived from `main.tsx`; audit as code; honest floor |
| Machine overload (§5.1) | At most 2 local stacks, enforced; no local test batteries; CI does the heavy lifting |

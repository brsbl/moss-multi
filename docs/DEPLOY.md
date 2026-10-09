# Deploying staging

`deploy-staging.yml` ships the exact bytes a green CI full lane tested to the staging Worker, then runs the staging canary there (A§21). It runs only when dispatched by hand. Until the secrets below exist, its first job fails at once and names each missing secret.

## One-time setup (owner)

1. **Cloudflare account.** Use the personal account on Workers Paid. In the dashboard, enable R2 once: the API refuses until then (error 10042). Under Workers & Pages, note the account's `workers.dev` subdomain.
2. **API token.** Under My Profile → API Tokens → Create Custom Token, scoped to that one account:

   | Scope | Permission | Used for |
   |---|---|---|
   | Account · Workers Scripts | Edit | deploy the Worker, its DO migration, its secret and its `workers.dev` route |
   | Account · D1 | Edit | create `moss-multi-staging` once, apply migrations |
   | Account · Workers R2 Storage | Edit | create `moss-multi-staging-assets` once |
   | Account · Account Settings | Read | `wrangler whoami` |
   | User · User Details | Read | `wrangler whoami` |
   | User · Memberships | Read | `wrangler whoami` |

   No zone permission is needed: staging is served on `workers.dev` only.
3. **Repository secrets.** Set each with `gh secret set <NAME> --repo brsbl/moss-multi`, which reads the value from the prompt, so it never lands in shell history:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | the account id (dashboard sidebar) |
   | `STAGING_URL` | `https://moss-multi-staging.<subdomain>.workers.dev` |
   | `STAGING_BETTER_AUTH_SECRET` | a fresh `openssl rand -hex 32` |
   | `CANARY_POOL_SECRET` | a fresh `openssl rand -hex 32`. Keep it: the canary's fixed principals sign in with passwords derived from it, so changing it locks the pool out. |

Nothing else is configured by hand. The first run creates the D1 database and R2 bucket when they are missing, and looks the D1 id up by name on every run, so no account resource id is committed.

## Deploying

1. Run the full CI lane on the branch to deploy, and wait for it to pass:
   `gh workflow run ci.yml --ref m8 -f lane=full`
2. Dispatch the deploy with that run's id. The run must be green, a push or dispatch run of this repository (never a pull request or a fork), its head still on its branch, and less than 3 days old, because `web-dist` artifacts expire after 3 days:
   `gh workflow run deploy-staging.yml --ref m8 -f ci_run_id=<run id>`
   The optional inputs are `request_budget` (default 2000 Worker requests for the canary), `idle_seconds` (default 20, at least 15), `suite` (`canary`, the default, or `full`) and `suite_request_budget` (default 5000 Worker requests for each full-suite shard).
   To run the full suite on staging, add `-f suite=full`.
3. Watch it with `gh run watch <id> --interval 60 --exit-status`. The first deploy waits for the new `workers.dev` certificate, which took about 8 minutes before.

## What a run does

1. **preflight:** first gates the CI run with this workflow's own `scripts/deploy/run-gate.mjs`, before any of the run's code is checked out or a secret is in reach: a completed, successful `ci.yml` run of this repository from a push or dispatch, whose branch exists and whose head is that branch's head or an ancestor of it. Only then does it emit the commit the later jobs check out. It then checks every secret is set, and that `STAGING_URL` is https and not loopback.
2. **deploy:**
   - **Checks the run.** The CI run must be a green full lane: `checks`, `build`, `editor-host`, `oracle`, `parity`, `viewer`, `editor`, `canary` and `ci-ok` all succeeded, and an e2e shard for every journey group in both engines. A grep run is refused.
   - **Gets the bytes.** It downloads that run's `web-dist` artifact, the bytes e2e ran on. Nothing is rebuilt. It checks the provenance commit equals the run's head.
   - **Guards the upload.** No `.dev.vars*`, `.env*`, key or secrets file may be in the dist, and `dist/client/.assetsignore` must exclude `.dev.vars*` and `.env*` (from `apps/web/public/.assetsignore`). Every CI build checks the same.
   - **Confirms the account.** It runs `wrangler whoami`.
   - **Ensures the storage.** It creates the D1 database and R2 bucket if missing.
   - **Writes the config.** `scripts/deploy/staging-config.mjs` lays `env.staging` from `apps/web/wrangler.jsonc` over the tested `dist/server/wrangler.json`. The config then holds the same keys a `CLOUDFLARE_ENV=staging` build writes, while the code bytes stay the tested ones.
   - **Migrates before deploying.** It applies the D1 migrations in order, then deploys with `BETTER_AUTH_SECRET` from a temporary secrets file.
   - **Asserts the deploy.** Staging's `/api/version` and `/` must match the tested commit, `bundleHash` and `clientHash`, and every test-hook path must answer as an unknown route, a 404.
3. **canary:** runs the `canary` Playwright project on staging:
   - **Legs:** j00-shell, the j01 setup legs, and j04's `@staging` leg. That leg idles for `idle_seconds`, then proves the wake through the owner-only `GET /api/docs/:id/instance`.
   - **Principals:** the fixed pool `canary-<label>@example.invalid`. Each signs up on the pool's first run and signs in once per run.
   - **Budget:** the run fails past `request_budget` Worker requests.
   - **Artifacts and log:** off loopback, Playwright records no trace or automatic screenshot or video, since they would carry the pool's session cookies. The run log prints only each test's title, status and duration (`scripts/deploy/canary-reporter.mjs`): a failed request's error lists its cookie header, and the log is public. The public artifact holds only `requests.json` and `summary.json` (each test's title, status and duration).

4. **suite** (only with `suite=full`, after a green canary): runs every journey on staging except the `@local-only` legs, in Chromium and WebKit, six shards per engine (`staging-chromium` and `staging-webkit` in `e2e/playwright.config.ts`).
   - **Left out:** a leg tagged `@local-only` needs a local stack: it reads or resets a DO through a test hook, or pauses or restarts the stack. A `// local-only: <reason>` line above each says why, and `scripts/deploy/local-only.mjs` (run by the unit tests) fails on an untagged leg that uses a hook or lever.
   - **The wake:** j04's `@staging` leg, as in the canary, proven through the owner-only instance route.
   - **Principals:** per-run `mm-<run>-<label>-<n>@example.invalid` accounts, because the journeys assume fresh accounts. A sign-up's session serves the first sign-in, and a 429 from the auth limit (10 a minute per address) waits out the window. The pool secret is not in reach.
   - **Budget, artifacts and log:** each shard fails past `suite_request_budget` Worker requests, and the canary's rules for recording, the log and the artifact hold unchanged.

CI rehearses the same canary on every full lane, against a production-mode local stack: the `canary` job in `ci.yml`. A `ci.yml` dispatch with `-f staging_suite=true` rehearses the full suite the same way: each journey shard on a stack with no test hooks, per-run principals and the `staging-<engine>` projects, with traces kept because the stack is loopback. Its jobs are named `rehearsal`, so `deploy-staging` never takes such a run as a tested full lane.

## Demo content

`scripts/demo.mjs` builds the demo folder in two test accounts through the real UI, then captures the signature shot. It drives one bb Browser Automation session through `scripts/qa.mjs`, so run it on a machine with bb.

- **What it builds.** A folder named "Multiplayer beta", owned by `demo-ada@example.invalid`, holding two notes:
  - "Launch plan": comment threads with replies and reactions, a pending suggestion from `demo-ben@example.invalid` (who has suggest access to the folder), a suggestion pushed by Ada's agent through the CLI, and the named versions "First outline" and "Ready for review".
  - "Every node family": every node family moss has, including a run-on-click HTML block, plus an uploaded image and video.

  It also makes a view link to the folder.
- **Re-runs.** Each step first reads what already exists, so a re-run adds only what is missing and never duplicates. Note bodies it finds are kept as they are.
- **Accounts.** Both accounts are `@example.invalid` test principals. Their passwords derive from `MOSS_DEMO_SECRET`, so any machine that has the same secret signs in to the same accounts. `--prefix` names a separate set.

Build the demo on staging after a deploy:

```sh
export MOSS_DEMO_SECRET=...   # the same value every run; keep it with the other staging secrets
node scripts/demo.mjs --url https://moss-multi-staging.<subdomain>.workers.dev
```

It prints the folder link, the note URLs and the paths of the 2x PNGs. The PNGs are in `.local-stack/runs/demo-<host>/shots/`, and the signature shot is `*-signature.png`. Post the folder link with the staging URL, and the owner opens it signed in as themselves.

Against a local stack, `node scripts/demo.mjs --run-id <run>` takes the URL from `scripts/stack.mjs`. A loopback URL needs no secret, because a local one is kept in `.local-stack/demo-secret`. The CLI step sets `MOSS_MULTI_NO_OPEN=1`, and `--skip-agent` leaves the agent step out.

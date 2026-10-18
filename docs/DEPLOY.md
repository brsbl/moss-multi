# Deploying staging and the pilot

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
   The optional inputs are `request_budget` (default 2000 Worker requests for the canary), `idle_seconds` (default 20, at least 15), `suite` (`canary`, the default, or `full`) and `suite_request_budget` (default 5000 Worker requests for each full-suite shard) and `suite_parallel` (default 4: how many shards run against staging at once). Four keeps the shared Worker and D1 under a fraction of the load sixteen put on them; the large-import memory resets (`DocDO.create exceededMemory`) happen at either setting, so it is not their cause.
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
   - **Writes the config.** `scripts/deploy/staging-config.mjs` lays `env.staging` from `apps/web/wrangler.jsonc` over the tested `dist/server/wrangler.json`. The config then holds the same keys a `CLOUDFLARE_ENV=staging` build writes, while the code bytes stay the tested ones. `env.staging` places the Worker in `aws:us-west-1`, beside the staging D1 (WNAM): every access check is a sequential D1 round trip, and a DO is created beside the Worker invocation that first reaches it, so callers far from D1 (the CI runners reach Cloudflare through Newark, Miami and Nashville) would otherwise pay a cross-country round trip per query, inside the DocDO's serialized turns too.
   - **Migrates before deploying.** It applies the D1 migrations in order, then deploys with `BETTER_AUTH_SECRET` from a temporary secrets file.
   - **Asserts the deploy.** Staging's `/api/version` and `/` must match the tested commit, `bundleHash` and `clientHash`, and every test-hook path must answer as an unknown route, a 404.
3. **canary:** runs the `canary` Playwright project on staging:
   - **Legs:** j00-shell, the j01 setup legs, and j04's `@staging` leg. That leg idles for `idle_seconds`, then proves the wake through the owner-only `GET /api/docs/:id/instance`.
   - **Principals:** the fixed pool `canary-<label>@example.invalid`. Each signs up on the pool's first run and signs in once per run.
   - **Budget:** the run fails past `request_budget` Worker requests. Every request to the Worker counts: the browsers' requests and sockets, Node's own fetches (sign-ups and sign-ins with their retries, probes, a leg's pushes) and `ws` sockets (protocol-level doc clients, agent sockets), Playwright API requests, and the CLI's requests through a preload (`e2e/lib/budget.ts`).
   - **Artifacts and log:** off loopback, Playwright records no trace, screenshot or video, since they would carry the pool's session cookies; the suite's own `@evidence` and failure screenshots are skipped too (`recordsScreens` in `e2e/lib/actors.ts`). The run log prints only each test's title, status and duration, and for a failure the suite source lines on its stack, a fixed label for the kind of error, an assertion's expected and received values when both are plain numbers, and each invariant it broke with the actor and, where they apply, the HTTP status, method and route (ids become `:id`), the counts, or a field still unbound, a failed wake proof's millisecond gaps, a refused sign-in's status, and a failed API request's method and route (`scripts/deploy/canary-reporter.mjs`): never the error's text or a text value, since a failed request's error lists its cookie header and the log is public. The public artifact holds only `requests.json` and `summary.json` (each test's title, status and duration).

4. **suite** (only with `suite=full`, after a green canary): runs every journey on staging except the `@local-only` legs, in Chromium and WebKit, eight shards per engine (`staging-chromium` and `staging-webkit` in `e2e/playwright.config.ts`). A leg may take 240 s there, twice the local limit, since every step waits on real round trips.
   - **Left out:** a leg tagged `@local-only` needs a local stack: it resets a DO through a test hook, pauses or restarts the stack, or serves a page on another port of the stack's host. A `// local-only: <reason>` line above each says why, and `scripts/deploy/local-only.mjs` (run by the unit tests) fails on an untagged leg that uses a hook or lever directly, and on a tagged leg that uses no lever. Reading a DO's instance is not local: `idleWake` in `e2e/lib/hibernate.ts` reads it through the owner-only route and idles `idle_seconds` on staging.
   - **The wakes:** j04's `@staging` leg as in the canary, j04's warm creator with a cold peer (presence both ways across the wake) and j09's cold revocations, each proven through the owner-only instance route.
   - **Principals:** per-run `@example.invalid` accounts, because the journeys assume fresh accounts (an empty workspace, a first sign-in). Staging allows 30 sign-ups a day per client address (`SIGN_UP_ADDRESS_DAILY`, apps/web/src/auth/auth.ts) and a suite needs far more, so before the deploy the deploy job seeds this run's accounts into D1 as a sign-up writes them: a user row and a credential account, 300 per shard, `mm-s<run>-<attempt>-<slots>-<k>@example.invalid` (`scripts/deploy/seed.mjs`). Their one password per run is an HMAC of `CANARY_POOL_SECRET`; only its hash is in the SQL, which stays on the runner. Each shard's `Suite password` step derives it, masks it, and hands only it to the journeys; the pool secret never reaches them. A leg's `actors.principal()` claims the shard's next slot, signs in, sets the leg's display name and opens the workspace, which makes the home vault. The legs that sign up through the login card still sign up, a handful a run. Re-run every job of a failed run, never only the failed shards: the shards check that the seed is their attempt's. Setup paces sign-ins under the sign-in limit (10 a minute per address) with counts kept beside the stack state, so a worker Playwright restarts after a failure keeps them; a 429 that still comes waits out the window, and the leg's timeout grows by the wait.
   - **Prune:** before a `suite=full` deploy, after the D1 migrations, the deploy job deletes the per-run principals earlier suites seeded or signed up (`scripts/deploy/prune.mjs`). It selects accounts older than 2 hours by a staging run's provenance in the email, never by a bare prefix: a staging run's token, `mm-staging-<run id>-...@example.invalid` (the canary's and the suite shards' `RUN_ID`), or a seed token, `mm-s<run>-<attempt>-<slots>-<k>@example.invalid`. The canary pool (`canary-*`), the demo accounts (`demo-ada`, `demo-ben`) and any other `mm-` account never match, and `scripts/demo.mjs` refuses an `mm` or `canary` prefix. It prints the dry-run count (principals and the docs they own) first, then deletes at most 6,000 a run: their doc and folder grants, share links, invites and user rows. The user row's docs, folders, sessions, accounts and agents cascade. It refuses the whole run if any selected row is not a per-run principal. A pruned doc's Durable Object storage stays; only D1 shrinks.
   - **Growth cap:** after the prune, the deploy job counts staging's docs and users and reads the D1 size, and `scripts/deploy/growth.mjs` refuses the run if one more full suite would pass 12,000 docs, 18,000 users or 200 MB of D1. One full suite adds about 4,900 accounts (4,800 seeded, the rest signed up through the card), under the prune's per-run cap, so a staging that runs only suites stays under the cap. These are D1 counts only. Durable Object storage is neither counted nor bounded: a pruned note's DocDO keeps its storage, so each full suite leaves about 1,000 DocDOs' storage behind, which only fresh staging names reclaim. Past the cap anyway, the owner decides: raise the prune cap for one run, or move to fresh staging names. See the growth review in `docs/METHOD.md`.
   - **Retries:** a product assertion, an invariant or a timeout is never retried. A leg runs once more, on fresh principals, only when every error of its failed attempt has a first line naming an infrastructure class in `scripts/deploy/retry-gate.mjs`: an `InfraBlocked` from a fixture (a Cloudflare error page, D1 7429, Worker 1101), a connection reset, refused or closed, or a network change. The invariants are checked after the body, so a broken invariant beside a connection reset still refuses the retry. After any other failure the retry fails at once, so the run fails. The run log prints each failed attempt's verdict (`retry: ... (<class>)` or `no retry: not infrastructure`) and a closing count of retries, and the summary names a leg that passed on its retry `flaky` with its class. The canary and every local run never retry.
   - **Network drops:** off loopback, invariant 3 allows one network drop per doc socket per page document: a heard close of 1006 (abnormal; Cloudflare may reset a Durable Object at any time), and only when a later socket of that document received the server's sync step 2. A replacement still connecting when the leg ends gets up to 15 s to reach sync before the invariants judge it. An unrecovered drop, a second drop, a refusal or two sockets open at once fail. A 1013 (the server's try-again, such as an access check that missed its D1 deadline) fails unless the leg declares it with `expectTryAgain`. A severable actor's sockets run through a Playwright proxy, which reports each server leg's close code and the sync step 2 it relays, so the same rules hold for them. Invariant 1 ignores only the browser's failure line for the recovered drop's own socket, matched by its URL and logged while it lived or within 2 s of its close. Against a local stack nothing changes.
   - **Tail:** beside the suite, the `tail` job runs one unfiltered `wrangler tail` on the staging Worker until every shard has finished, and reduces each failure (an outcome other than `ok`, a 5xx or a thrown exception) to counts under fixed names (`scripts/deploy/tail-summary.mjs`): error outcomes by Durable Object class and RPC method, or by HTTP method and route family for the Worker; exception classes matched by fixed patterns (memory limit, CPU limit, object reset, overloaded, storage timeout, network lost, internal error, unclassed); and the UTC minutes in which an isolate passed its memory or CPU limit. Such a reset drops every Durable Object the isolate held, so a leg failing in the same minute may be its collateral. The tail's own output, which holds URLs, headers and log lines, is never printed; the log and the `staging-tail` artifact hold only `tail-summary.json`. Under heavy traffic the tail samples, the summary counts the sampling notices under `overload`, and the job warns. wrangler's tail ended on its own about two hours into a five-hour suite (run 39145040057), so a tail that ends is restarted (up to 50 times; `tailRestarts`); the job fails when it still ends before every shard has finished, and runs as long as the shards do (up to 350 minutes).
   - **SP9 telemetry:** before the suite and the tail, the `sp9` job runs j11-media's SP9 near-cap probe alone (the suite skips it), under a tail filtered on the `x-sp9-probe` header its uploads carry, and records each upload's outcome, response status, CPU time and wall time (`sp9-probe.json` in the `staging-sp9` artifact, beside the leg's summary). Cloudflare reports no per-request memory figure; its memory telemetry is the outcome, `exceededMemory` when the isolate passed its 128 MB limit. The job fails when the near-cap upload has no such event, or one that is not `ok`, 201, within the memory limit and timed, or when the truncated upload (the probe's red control) has none. It runs alone because Cloudflare's tails interfere: unfiltered, the tail sampled the near-cap upload away (run 39145040057), and beside a filtered tail an unfiltered one saw only the filtered one's events (runs 39116654098 and 39130102453). The Cloudflare token reaches only the tail process; the probe signs in to slot c6's last principals, which shard c6 does not reach.
   - **Budget, artifacts and log:** each shard fails past `suite_request_budget` Worker requests, and the canary's rules for recording, the log and the artifact hold unchanged.

CI rehearses the same canary on every full lane, against a production-mode local stack: the `canary` job in `ci.yml`. A `ci.yml` dispatch with `-f staging_suite=true` rehearses the full suite the same way: each journey shard on a stack with no test hooks, per-run principals and the `staging-<engine>` projects, with traces kept because the stack is loopback. Its jobs are named `rehearsal`, so `deploy-staging` never takes such a run as a tested full lane. Add `-f latency_ms=<n>` to delay every loopback packet by n ms (tc netem), so staging-only timing failures reproduce where traces are allowed.

## The pilot deployment

The pilot holds the owner's real notes for the Moss pilot (T8.P1), apart from staging, because staging is shared with automated suites, canary runs and test principals. `deploy-pilot.yml` deploys the same tested bytes through the same gate and checks as `deploy-staging.yml`. It runs no canary, suite, sweep or demo, and creates no account. `scripts/deploy/canary-state.mjs`, `scripts/security/sweep.mjs` and `scripts/demo.mjs` refuse the pilot's URL.

### What is different from staging

- **Names.** Worker `moss-multi-pilot`, D1 `moss-multi-pilot`, R2 `moss-multi-pilot-assets` (`env.pilot` in `apps/web/wrangler.jsonc`). They are permanent: Durable Object storage is bound to the Worker name, so renaming the Worker loses every note.
- **Sign-up.** Only the emails in the `PILOT_ALLOWED_EMAILS` secret can create an account. `env.pilot` sets `MOSS_SIGN_UP=allowlist`, and the deploy sends the list as the Worker secret `MOSS_ALLOWED_EMAILS`. Anyone else is refused 403 `SIGN_UP_NOT_ALLOWED`, and the login card tells them sign-up is invite-only. An empty or missing list admits no one. Signing in, the CLI's device login and agent keys work as usual for accounts that exist.
- **No test hooks.** `MOSS_TEST_HOOKS` is `"0"`, and the smoke proves every hook path is the unknown-route 404.

### One-time setup

1. **Token.** The staging token works if its D1 and R2 permissions cover the whole account (the table in [One-time setup](#one-time-setup-owner)). Nothing else in Cloudflare is set up by hand: the first run creates `moss-multi-pilot` and `moss-multi-pilot-assets`, and every run looks the D1 id up by name.
2. **Repository secrets** (`gh secret set <NAME> --repo brsbl/moss-multi`; the coordinator sets them, and no agent reads or prints them):

   | Secret | Value |
   |---|---|
   | `PILOT_URL` | `https://moss-multi-pilot.<subdomain>.workers.dev` |
   | `PILOT_BETTER_AUTH_SECRET` | a fresh `openssl rand -hex 32`, never the staging one. Changing it signs everyone out. |
   | `PILOT_ALLOWED_EMAILS` | the emails that may sign up, separated by commas or spaces |

   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are shared with staging. To add someone later, update `PILOT_ALLOWED_EMAILS` and deploy again.
3. **Register the workflow.** GitHub runs a dispatch-only workflow only when it is on the default branch, so `deploy-pilot.yml` must be on `main` before the first dispatch, as `deploy-staging.yml` was.

### Deploying

1. Run the full lane on the branch to deploy and wait for it to pass: `gh workflow run ci.yml --ref m8 -f lane=full`.
2. Dispatch the deploy with that run's id. The gate is the same as staging's: a green full lane in both engines, a push or dispatch run of this repository, its head still on its branch, under 3 days old.
   `gh workflow run deploy-pilot.yml --ref m8 -f ci_run_id=<run id>`
3. Watch it with `gh run watch <id> --interval 60 --exit-status`. A run then:
   - gates the run;
   - checks the secrets, including that `PILOT_URL` is not the staging Worker and the allowlist holds only email addresses;
   - downloads and guards the tested bytes;
   - lays `env.pilot` over them (`staging-config.mjs write --target pilot`);
   - applies the D1 migrations;
   - deploys with `BETTER_AUTH_SECRET` and `MOSS_ALLOWED_EMAILS` from a temporary secrets file.
4. It ends with the read-only smoke (`assert-deployed.mjs --pilot`):
   - `/` and `/api/version` serve the tested commit, `bundleHash` and `clientHash`;
   - every test hook is a 404;
   - `GET /api/me` with no session is 401;
   - a sign-up for a random `@example.invalid` address with a one-character password is refused `SIGN_UP_NOT_ALLOWED`. Even an open sign-up would refuse that password, so the smoke can never create an account.

CI checks the pilot config on every build: the `Pilot deploy dry run` step lays `env.pilot` over the built bytes and runs `wrangler deploy --dry-run` on the result.

### Rolling back

A deploy changes only the Worker code. The notes stay in place. To go back to the previous version:

- **Fastest:** in the Cloudflare dashboard, open Workers & Pages → `moss-multi-pilot` → Deployments, pick the previous version, and choose Rollback. With the token, `wrangler rollback --name moss-multi-pilot` does the same, and `wrangler deployments list --name moss-multi-pilot` lists the versions.
- **Through the pipeline:** dispatch `deploy-pilot.yml` with the previous deploy's CI run id while its `web-dist` is under 3 days old. After that, push the previous commit to a branch, run the full lane there, and deploy that run.

D1 migrations are not rolled back. So far every migration only adds tables, columns or indexes, so older code runs on the newer schema. Before rolling back across a migration that changes or drops something, export the D1 database first.

### Where the data lives

| Data | Where |
|---|---|
| Accounts, sessions, agent keys, vaults, folders, the note index and sharing grants | D1 `moss-multi-pilot` |
| Each note's body, title, frontmatter, comments, suggestions and versions | That note's DocDO, Durable Object storage under the Worker `moss-multi-pilot` |
| Uploaded images, video and other media | R2 `moss-multi-pilot-assets` |

All three are on the owner's Cloudflare account. Deleting the Worker deletes every DocDO, and with them the notes: never delete or rename `moss-multi-pilot`.

### Backing up the notes

The CLI writes every note the account can open as markdown, with its media, into a local folder. Run it from any machine, with `MOSS_MULTI_NO_OPEN=1` on a headless host:

```sh
moss-multi login --server "$PILOT_URL"     # or MOSS_MULTI_SERVER=$PILOT_URL MOSS_MULTI_API_KEY=mm_sk_...
moss-multi init ~/moss-pilot-backup
cd ~/moss-pilot-backup
moss-multi list --json | jq -r '.[].id' | while read -r id; do
  moss-multi pull "$id" || moss-multi pull "$id" "$id.md"   # a second note with the same title gets its id as a name
  moss-multi comments "$id" --json > "$id.comments.json"
done
```

Each note lands as `<title>.md`, and its media next to it. After that, `moss-multi sync ~/moss-pilot-backup` refreshes every pulled note. Run the loop again to pick up notes created since. Syncing also pushes any edit made to a backup file, so leave the backup unedited. `moss-multi history <doc>` lists a note's versions. For the account data, `wrangler d1 export moss-multi-pilot --remote --output pilot.sql` dumps the D1 database (it needs the token).

## Demo content

`scripts/demo.mjs` builds the demo folder in two test accounts through the real UI, then captures the signature shot. It drives one bb Browser Automation session through `scripts/qa.mjs`, so run it on a machine with bb.

- **What it builds.** A folder named "Multiplayer beta", owned by `demo-ada@example.invalid`, holding two notes:
  - "Launch plan": comment threads with replies and reactions, a pending suggestion from `demo-ben@example.invalid` (who has suggest access to the folder), a suggestion pushed by Ada's agent through the CLI, and the named versions "First outline" and "Ready for review".
  - "Every node family": every node family moss has, including a run-on-click HTML block, plus an uploaded image and video.

  It also makes a view link to the folder.
- **Re-runs.** Each step first reads what already exists, so a re-run adds only what is missing and never duplicates. A note an interrupted run left is finished: a missing or partial paste is pasted whole, then each missing media file is added. A finished note is kept as it is. The run ends by checking that the demo holds exactly one of each thing it makes, and prints what it added under `changes`.
- **One run at a time.** A run holds `.local-stack/runs/demo-<host>.lock` from start to cleanup, so a second run against the same stack fails at once, whatever its `--prefix`. A lock left by a process that is gone is taken over.
- **Accounts.** Both accounts are `@example.invalid` test principals. Their passwords derive from `MOSS_DEMO_SECRET`, so any machine that has the same secret signs in to the same accounts. `--prefix` names a separate set.

Build the demo on staging after a deploy:

```sh
export MOSS_DEMO_SECRET=...   # the same value every run; keep it with the other staging secrets
node scripts/demo.mjs --url https://moss-multi-staging.<subdomain>.workers.dev
```

It prints the folder link, the note URLs and the paths of the 2x PNGs. The PNGs are in `.local-stack/runs/demo-<host>/shots/`, and the signature shot is `*-signature.png`. Post the folder link with the staging URL, and the owner opens it signed in as themselves.

Against a local stack, `node scripts/demo.mjs --run-id <run>` takes the URL from `scripts/stack.mjs`. A loopback URL needs no secret, because a local one is kept in `.local-stack/demo-secret`. The CLI step sets `MOSS_MULTI_NO_OPEN=1`, and `--skip-agent` leaves the agent step out.

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
   The optional inputs are `request_budget` (default 2000 Worker requests for the canary) and `idle_seconds` (default 20, at least 15).
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

CI rehearses the same canary on every full lane, against a production-mode local stack: the `canary` job in `ci.yml`.

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
3. **No workflow to register.** GitHub dispatches a workflow only when its file is on the default branch, and then runs the dispatched ref's copy. `deploy-staging.yml` is on `main`, so its `target=pilot` input reaches the pilot from `m8` without a merge to `main`.

### Deploying

1. Run the full lane on the branch to deploy and wait for it to pass: `gh workflow run ci.yml --ref m8 -f lane=full`.
2. Dispatch the deploy with that run's id. The gate is the same as staging's: a green full lane in both engines, a push or dispatch run of this repository, its head still on its branch, under 3 days old.
   `gh workflow run deploy-staging.yml --ref m8 -f ci_run_id=<run id> -f target=pilot`
   With `target=pilot`, `deploy-staging.yml` runs only its gate, then calls `deploy-pilot.yml`, passing it only the three `PILOT_*` secrets and the two Cloudflare ones. Its staging deploy and canary are skipped, no staging or canary secret is in reach, and it never queues behind a staging run. Once `deploy-pilot.yml` is on `main`, `gh workflow run deploy-pilot.yml --ref m8 -f ci_run_id=<run id>` does the same.
3. Watch it with `gh run watch <id> --interval 60 --exit-status`. The run is named "Deploy staging" either way; its `pilot` job does the work. It:
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
- **Through the pipeline:** dispatch the deploy with `target=pilot` and the previous deploy's CI run id while its `web-dist` is under 3 days old. After that, push the previous commit to a branch, run the full lane there, and deploy that run.

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

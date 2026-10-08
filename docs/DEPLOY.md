# Deploying staging

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

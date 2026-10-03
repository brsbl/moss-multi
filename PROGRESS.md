# moss-multi progress

**Overall: 24% done** (17 of 70 planned tasks verified)

| Milestone | What a person can newly do | Tasks verified | Status |
|---|---|---|---|
| M0 Foundation | Open the real moss shell from the built Worker; sign up and in; a note survives a restart | 17 / 17 | in progress |
| M1 Two people, one note | Share a note and co-edit live with presence, cursors, shared titles | 0 / 11 | |
| M2 Workspace and access | Folders, trash, full sharing, live revocation, stranger on a phone | 0 / 9 | |
| M3 Rich workspace | Media, HTML/embeds, every node family, search, vaults, agent keys, read-only viewer | 0 / 9 | |
| M4 Comments | Moss's full comment experience as CRDT data | 0 / 5 | |
| M5 Suggestions | Suggest mode, vetting, accept/reject | 0 / 5 | |
| M6 History | Versions, view, diff, identity-preserving restore | 0 / 4 | |
| M7 Agents and local sync | CLI pull/push/sync, Bot presence, folder-watch daemon | 0 / 5 | |
| M8 Ship | Everything on a permanent staging URL with demo content | 0 / 5 | |

A task counts only after an independent checker passes it on green CI. Each milestone also ends with the cumulative journey suite green in Chromium and WebKit and a naive-user critic pass.

## Log

- 2026-10-02 — Restart begun. History distilled into docs/history/LEARNINGS.md; PRODUCT.md carried over with restart rulings; ARCHITECTURE.md and BUILDPLAN.md drafted, critiqued by three lenses and revised.
- 2026-10-02 — T0.1 verified: the repo installs as a pnpm workspace, and every push runs CI (plan, checks, build, ci-ok) with lint, single-version, trace and unit checks; a checks-only lane can be dispatched and `minutes.mjs` prints the month's Actions use.
- 2026-10-02 — T0.2 verified: moss@762abb777 (387 files) and @lexical/react 0.48.0's collab plugin (2 files) are vendored verbatim with `ported-from` headers, and every CI run's drift check fails on any byte change or missing header.
- 2026-10-02 — T0.3 verified: the apps/web Worker builds and routes in A§4.1 order with its version stamped into `/api/version` and the page, and `scripts/stack.mjs start` launches a local stack at a clickable `http://127.0.0.1:<port>`; CI smokes the built Worker on every push.
- 2026-10-02 — T0.11 verified: `docs/design/glyphdown-reference.md` indexes 2× light and dark glyphdown@faf98d0 shots of every surface PRODUCT's intro names, plus the vault switcher and suggestions, attached to the M0 PR as the design reference for later triptychs.
- 2026-10-02 — T0.4 verified: the Worker has the D1 schema and email-and-password auth that fails closed on bad secrets, rejects sign-up without `Origin`, rate-limits repeated sign-ins with 429, creates one Home vault per user and serves `/api/me`; two principals can be minted on a local stack.
- 2026-10-02 — T0.9a verified: `e2e/lib` gives journeys actors, principals on a real local stack, telemetry and detectors for invariants 1–9, each proven red by its own selftest fixture, and every e2e run boots the built Worker in the Playwright image for Chromium and WebKit, with a macOS WebKit lane for the `@macos` Backspace legs.
- 2026-10-02 — T0.6 verified: one markdown converter, extracted from pristine moss by `moss-vendor.mjs extract`, runs headless in workerd from `packages/sync`, round-tripping every node family against goldens and the pristine pipeline with deterministic formula ids, no lost lines, and views kept out of its bundle.
- 2026-10-02 — T0.5a verified: the built Worker serves the real moss shell at `/` and `/d/$docId` under a per-request CSP nonce, with moss's root CSS, fonts, theme script and Tailwind config; j00-shell boots two principals cleanly in Chromium and WebKit, light↔dark works through moss Settings, and the parity job compares `shell-default` and `shell-empty` in light and dark against the Ladle oracle.
- 2026-10-02 — T0.6b verified: whole-document markdown import runs with no selection, so a 2 MB note imports in linear time within the DocDO CPU budget (SP2 now fails any import up to 2 MB over 5 s of workerd CPU), while typing and moss paste conversion still move the caret; the new SP2 table is in METHOD.md.
- 2026-10-02 — T0.5b verified: moss's shell talks to the Worker through a bridge covering every ElectronAPI method, with the workspace list, note creation and feedback real and a content write refused loudly without a request; withheld affordances are absent from the DOM through one hide registry, and every opened DS menu or dialog carries `data-overlay-surface`.
- 2026-10-02 — T0.9b verified: CI runs e2e as one shard per journey group, each with its own stack (a ready-PR shard takes under 4 min), with `@slow` legs at milestone gates and nightly; `scripts/qa.mjs` drives a local stack through bb Browser Automation and writes 2880×2000 shots; METHOD.md holds the p95 headroom table that any latency budget must cite.
- 2026-10-02 — T0.10 verified: a person can sign up, sign in and sign out on a `/login` card built from vendored moss parts with no OAuth button; sign-in returns to the doc `next` names and never leaves the site, a wrong password shows a message, and a failed session lookup shows a degraded state that retries in place; j07-auth is green in Chromium and WebKit.
- 2026-10-02 — T0.12 verified: a page on another origin can no longer open a signed-in doc socket or make a cookie-authenticated `/api` change; one Origin gate refuses those with 4401 or 403, while session bearers, agent keys and share tokens pass from anywhere and a bearer never falls back to its cookie.
- 2026-10-02 — Plan now 70 tasks: T0.13 (read-only viewer entry for the bb Moss viewer plugin) and T3.8 (full viewer) added. The repo is now public under MIT (brsbl/moss-multi); the private original is kept as brsbl/moss-multi-private, and the history notes were republished with personal details removed. CI is free for public repos.
- 2026-10-02 — T0.8 verified: a person can click "+ Note" and type in the real moss editor bound to the note's Y.Doc in the browser; the body unlocks only once it is live, the exact text (spaces, punctuation, "é") survives a reload over a single doc socket, and Copy markdown and Note stats read the current body; j00-persist is green in Chromium and WebKit.
- 2026-10-03 — T0.13 verified: `packages/viewer` builds a browser bundle whose `mountMossViewer` shows a note in moss's own editor, read-only and unbound: the title renders once, `%%m:` markers stay hidden, the `layout.json` sidecar applies and tabs switch but never change, with no socket, write or input and assets and links only through injected services; CI builds the `moss-viewer` artifact with its `viewer.json` manifest and screenshots the fixture in Chromium and WebKit.
- 2026-10-03 — T0.P verified: M0 polish. Keys typed right after "+ Note" are held with a visible "Opening note…" notice instead of vanishing or making a second note; edits typed offline survive switching notes and land on reconnect, even when an ack was lost with the dropped socket; the link popover highlights without writing to the note; a pasted or dropped image or video is refused visibly; a refused password can be fixed straight from the keyboard; and Rename, which could not work yet, is hidden.

## Follow-ups (P2)

Parked from the M0 checker and critic passes, each with the task that owns it.

- The sign-up "too short" error does not say how long a password must be → T0.10
- Switching to "Create an account" leaves focus on the toggle link → T0.10
- A wrong password logs a browser console error → T0.10 (only if the zero-console-error invariant should cover the auth error path)
- Sidebar times do not update when a note is edited → T1.4 (DocDO `updated_at` projection)
- Sidebar search matches titles only, so body text is never found → the M3 search task (SearchDO), together with T1.4 titles
- A missing or bad doc URL silently opens a different note → T1.1 (DenialPage)
- During a stack restart the editor stays editable with no sign it is disconnected → T1.3 (connection truth indicator and banner)
- Settings shows Note Intelligence, and its description mentions a hidden section → T1.4 (Properties unstaging), or a hide-registry entry if it cannot work on the web
- Sign-out leaves the session's other live doc sockets reading and writing → T2.5
- Close codes are never dispatched: a refused or unauthorized socket reconnects forever behind an editable pane → T1.3 (a session lingering with unacked edits behind a refused socket also holds its doc until then; a terminal code should end it)
- A lost ack leaves `data-sync-unacked=1` after reconnect → T1.3 (T0.P: the DocDO now acks an editor's inert step 2, so a reconnect ends in an ack; T1.3 confirms it in j03)
- Ack coverage by state vector is unsound for deletions → T1.3
- Acks and the write-rate window are keyed by the client's reused `_pk` connection id, so a stale socket breaks the new one's acks → T1.3 (T0.P: each socket now gets a fresh id on the client; T1.3 checks the server side)
- ChunkReloadBoundary hard-reloads when a lazy chunk fails because the network or stack is down, discarding buffered edits → T1.3
- The wrangler ProxyWorker patch replays non-idempotent requests after an ambiguous failure → T0.9b follow-up (stack infra)
- `qa.mjs close` forgets the session even when closing it failed → tooling follow-up
- `stack.mjs` puts `BETTER_AUTH_SECRET` and the test-hook secret on wrangler's command line → tooling follow-up
- Signing out does not wait for unsynced edits, and no task owns that safeguard → extend T2.3's unacked-wait step to sign-out, or add it to the T2.x sign-out legs
- Creating a note writes the D1 title and filename from the Worker, not the DocDO → T1.4 (title and filename projections): move slug and `availableFilename` to `packages/core` and let create go through the DO projection
- Table and tab widths and collapsed headings reset on every reload in M0 → T1.6
- Page-attribute names, the socket path name and the roles list are each defined in more than one place → the T1.x lane that next touches each module
- Several docs disagree with each other: deviation 13, the M0 progress count and the viewer's copied title → the coordinator at the M0 hand-off; the viewer follow-up goes with T3.8
- `trace.mjs` gates each row only at its first milestone and counts a tag anywhere in a file, so later-milestone owning legs are never enforced → T0.1 follow-up: per-milestone tags (e.g. `@p:col-6@1`) or an owning-journey-file check per milestone
- The slash-menu probes for /emoji and /media can never match, and no journey opens the slash menu (T0.P corrected the probes and added the j00-shell slash-menu leg)
- Several negative assertions cannot fail
- The persistence legs check flattened text, and the M0 "restart and still see it" promise has no UI leg
- Two j07 claims are proven more weakly than their titles say
- Enter or Space right after "+ Note" creates duplicate empty notes that cannot be deleted in M0 → T1.4 ("+ Note" seam and opening guard); M2 trash makes the junk removable (T0.P's opening guard now blurs the trigger, so the keys no longer press it)
- The title field looks editable but is permanently dead, so every note is "Untitled" → T1.4 (title binding); until then, stage or visibly disable it so it does not invite typing
- At 390×844, signing in lands on an unreadable doc: the editor is squeezed to one character per line → T2.7 (deviation 11: below 640 px the notes panel overlays the canvas)
- At M0 a link's "Open in Split View" opens an in-app browser that loads forever, and an HTML block's "Preview unavailable" Retry cannot succeed → T3.2 (RemoteWebSurface and the live iframe), or stage both now if the M0 critic counts them as dead

### T1.3 implementation in progress

Reused tests-first head f22b105 and its red j03 run https://github.com/brsbl/moss-multi/actions/runs/37119822769 (missing indicator/banner); red checks https://github.com/brsbl/moss-multi/actions/runs/37119819996 (delete coverage, stale socket ack and rate collisions). Reviewed and reused the saved implementation, completed pane wiring, refusal rebind and chunk recovery. Both-engine j03 and remote checks dispatched on the implementation head; verdict pending. Budget: about 60 CI minutes.

T1.3 validation update: the first implementation push built successfully; checks found a nullable listener type error in the salvaged socket wrapper, now corrected. Added focused close-code/heartbeat tests. Local build and stack boot succeeded on arm64 Node 24; Browser Automation is blocked (`unknown command browser-automation`, plugin discovery HTTP 401). Stopped the stack without substituting a driver.

T1.3 remote evidence: both-engine j03 green at be193a2 (https://github.com/brsbl/moss-multi/actions/runs/37129674970); complete push CI green at 4f80045 (https://github.com/brsbl/moss-multi/actions/runs/37129924046). Inspected the 2× offline and connection-limit screenshots. Final dispatch adds refusal-rebind/deletion coverage and a preload-error regression inside the blackout. Local Browser Automation remains blocked by missing authenticated BB context.

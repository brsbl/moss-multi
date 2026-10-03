# moss-multi progress

**Overall: 21% done** (15 of 70 planned tasks verified)

| Milestone | What a person can newly do | Tasks verified | Status |
|---|---|---|---|
| M0 Foundation | Open the real moss shell from the built Worker; sign up and in; a note survives a restart | 14 / 17 | in progress |
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

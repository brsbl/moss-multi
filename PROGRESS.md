# moss-multi progress

**Overall: 9% done** (6 of 66 planned tasks verified)

| Milestone | What a person can newly do | Tasks verified | Status |
|---|---|---|---|
| M0 Foundation | Open the real moss shell from the built Worker; sign up and in; a note survives a restart | 6 / 14 | in progress |
| M1 Two people, one note | Share a note and co-edit live with presence, cursors, shared titles | 0 / 11 | |
| M2 Workspace and access | Folders, trash, full sharing, live revocation, stranger on a phone | 0 / 9 | |
| M3 Rich workspace | Media, HTML/embeds, every node family, search, vaults, agent keys | 0 / 8 | |
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

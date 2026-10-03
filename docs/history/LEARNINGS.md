# moss-collab history: learnings for the moss-multi restart

Synthesized on 2026-10-02 from 14 research reports covering every moss-collab thread, document, and code snapshot from May to September 2026. This is the authoritative record for the from-scratch restart in `/Users/brsbl/Code/moss-multi`.

How conflicts were resolved: the latest dated owner ruling wins. A superseded decision appears only where its reversal teaches something (§1.11). Each claim cites its source in compact form, using the key below.

## 0. Summary

- **The track record.** Six build eras over roughly three months, run by about a dozen coordinator threads, produced no shipped product. The best state anyone reached was B0 and B1 (live co-editing, accounts, sharing) on a local stack, self-rated at 44%. It was never deployed. B2 through B7 (assets, comments, suggestions, history, CLI, deploy) were never built. [PROGRESS; e2na]
- **The common cause.** Every era failed the same way: the agents pursued only the intent that had been turned into a checkable artifact, and graded themselves against proxies they controlled [POSTMORTEM 07-29]. Later eras added a second failure mode: verification overhead consumed the budget. One title-input bug took five fix trains, and the trash-401 bug took eight checker cycles, six of them (cycles 3–8) spent on evidence and tooling integrity after the product fix was already confirmed in cycle 2. [e2na; bmrs s5616–6250]
- **Where intent lives.** Product intent is in `PRODUCT.md` and `BUILDPLAN.md` at brsbl/moss-collab@9104ceb. Section 1 below supersedes both wherever later owner rulings exist.
- **The rules that mattered most.** Push to a remote at every step. Use real moss UI in a real browser against a real Worker stack. Keep the Y.Doc as the single writer for doc state. Ask "what would glyphdown do?" before the first fix. Test through the UI only, as a naive user. Never make the owner act as referee.

### Source key

| Key | Source | Dates | Role |
|---|---|---|---|
| `pukn` | thr_pukn8a28j6 | May 22–Jun 15 | Shared Notes spec (publish, web collab, history), stored as a Moss note |
| `4biv` | thr_4bivjj7tqz | Jun 25–Jul 3 | Era 1: 40-question interview and headless build |
| `n2ii` | thr_n2iijkfs7a | Jul 3–11 | Era 2: byte-copy rebuild and staging deploy |
| `62jf` | thr_62jfx7858u | Jul 7–9 | Era 2 pixel-parity gate worker |
| `d44s` | thr_d44sg8wntr | Jul 11–20 | Era 3: 284-row rubric, harness, codex sweeps |
| `6mff` | thr_6mffvmw7k2 | Jul 18–21 | Fable advisor for rubric conflicts |
| `yzzh` | thr_yzzhsj26v6 | Jul 20–21 | Era 4: destruction and recovery |
| `r5cv` | thr_r5cvccid42 | Jul 21–22 | Era 5: re-spec (SPEC Q1–Q4), P0–P2, C-01 pilot |
| `axb3` | thr_axb3rhbxjk | Jul 22–29 | Era 5: M1 journal ending in SYSTEM RESET |
| `kqtn` / `x4g2` | thr_kqtnc82jht / thr_x4g2p5datf | Jul 28 | Journey lane / DEV_AUTH playground |
| `bmrs` | thr_bmrsgx4xkv | Aug 5–14 (died) | Era 6: B0 and B1 coordinator on the Intel host |
| `e2na` | thr_e2na3zdvxr | Aug 13–Sep 2 | Era 6: successor coordinator, title arc |
| `2yq6` | thr_2yq6av37sc | Sep 2 | Last checker; died, never resumed |
| `qb6q` | thr_qb6qrcu3m4 | Jul 10–17 | Figma design-system loop postmortem (canonical loop doctrine) |
| `PRODUCT`, `BUILDPLAN`, `SPEC`, `POSTMORTEM`, `deviations`, `PROGRESS`, `CASE-LAW`, `HANDOVER-0814` | brsbl/moss-collab@9104ceb | to Sep 2 | Final intent and operations docs |
| `bundle` | `~/.bb/handoffs/moss-collab-acceptance-recovery-2026-07-20` | Jul 20 | Control plane: interview answers, REBUILD-SPEC, 284 rubric rows verbatim, postmortems |
| `code:` | path in brsbl/moss-collab@9104ceb | | Final code |

Citations use `sNNNN` for a thread sequence number. `interview HH:MM` refers to `bundle/lineage/thr_4bivjj7tqz/interview-answers.json` on 2026-06-25.

### Artifact inventory as of 2026-10-02

- **brsbl/moss-collab** (private, `main`, HEAD 9104ceb from 2026-09-02). The latest B0/B1 build: PRODUCT.md, BUILDPLAN.md, docs/{SPEC, POSTMORTEM, deviations, CASE-LAW, PROGRESS, HANDOVER-*, BASELINE, BUILD-PROVENANCE, LOCAL-STACK, UPSTREAM-IMPACT, SECURITY-ROTATION}.md, spikes/lexical-in-do.md, patches/, `.bb/skills/wwgd`. A shallow clone exists at `/tmp/mc-peek/moss-collab`; it is ephemeral.
- **brsbl/moss-collab-legacy** (private). The era-2/3 build restored from transcripts (branch `recovery`). Some docs call it "moss-collab-restored" (@955696b8). It served as the "answer key".
- **brsbl/moss-multiplayer** (private). Era 1, commit fecb47f only. `docs/02-decisions.md` holds interview decisions D1–D34 and G1–G8.
- **The control-plane `bundle`** is still on disk. It contains the interview answers, REBUILD-SPEC.md, RUBRIC-RECOVERED-ROWS.md (747 KB, all 284 rows), POSTMORTEM-RECOVERY-THREAD.md, the first-attempt git bundle, and 81 workflow scripts (SHA-locked; they embed paths that no longer exist).
- **`~/Code/glyphdown-ref` @ faf98d07** has no git remote and is the only copy. Back it up before relying on it. [HANDOVER-0814; bmrs]
- **`~/Code/moss`** is the owner's live checkout, at HEAD 4fa391258 (2026-07-30). Read it only via `git -C ~/Code/moss show <pin>:<path>`. Never switch branches in it, build it, or write to it. [LESSONS; owner report 07-29]
- **Gone:** `~/Code/moss-multiplayer`, `~/Code/moss-collab`, `~/Code/moss-collab-restored`, `~/Code/moss-v0.11.0`, and the contents of env_pmgnprh2j6 (only `docs/acceptance/rubric-runs/{D-12,G-09,G-15,G-22}` remains).
- **SPEC.md and NEXT-STEP.md** (July rebuild workspace) are at `~/.bb/personal-workspaces/env_kuvhbd6un5/moss-collab-rebuild/`.

---

## 1. What the product is (current, non-superseded)

### 1.1 Purpose and sources of truth

- **What it is.** A working reference implementation for migrating real moss to multiplayer hosting: local↔cloud sync, version history, suggested edits, and so on. The owner: "i am going to rewrite moss after this is done with this repo as reference". It never ships as a product. Branding and domain do not matter, but "the exit criteria has not changed": being a reference does not lower the acceptance bar. Because the code will be ported back into moss ("doesn't matter this is a new codebase and won't ship as is, i will later use as a reference to migrate the current moss codebase"), fidelity to moss's code structure matters as well as its pixels. [SPEC §1; d44s s4827; 4biv s3328; PRODUCT; interview 06-26 00:49]
- **Scope.** "all -- i want all of glyphdown's features but moss' frontend". It is a standalone web app plus a CLI. There is no new desktop app; moss desktop serves only as a reference oracle. [interview 21:55; n2ii s27585/27689]
- **Backend.** Glyphdown's architecture as-is for everything not explicitly decided otherwise ("why the f*** would you recommend architecture that is not glyphdown originally. glyphdown model as-is"). Sanctioned divergences: moss's UI, the Lexical tree as the CRDT of record, and the RW and divergence rows below. [interview 22:48; SPEC §2]
- **UI.** Moss supplies 100% of the UI, including the shell, sidebar and notes list, top bar, the (inert) agent panel, and the editor. Port moss; never reimplement it. No glyphdown UI. [PRODUCT; interview 22:16; 4biv s2447]
- **Surfaces moss lacks** (login, share dialog, history panel, notifications inbox, connection banner, presence and cursors, suggestion marks). Use glyphdown's rendered UI as the interaction reference and build from moss's design system. Add missing DS primitives (face pile, banner/toast, member row, inbox item) to the shared DS layer with a story first, in the milestone that needs them. [PRODUCT; BUILDPLAN DS audit; n2ii s45983]
- **Oracle precedence (09-02).** An explicit PRODUCT decision wins. Next, glyphdown-ref governs the interaction contract where moss is silent or its own code carries a race or TODO. Moss at the pin governs shape and chrome. Where moss has an intentional component (the floating format toolbar), moss parity wins over glyphdown (owner ruling 07-13). [e2na s8235; CASE-LAW; d44s s20391–20688]
- **Visual bar.** Pixel-perfect (not byte-identical) against rendered moss, in both light and dark themes. Judge from rendered screenshots, never from code. Moss-absent features are judged against glyphdown's rendered UI with moss styling applied. Cite a Ladle story as a reference only after proving it covers the surface (ruling 6), with the real desktop app as fallback; keep the three-way method minimal. [n2ii s6476, s45213–45230, s45376; DEFINITION-OF-DONE; RUBRIC-RECOVERED ruling 6]
- **Frontend strategy (Q2, owner-approved 07-21).** An adapted port at a fresh moss pin: copy real moss files and modify them in place where multiplayer requires it, enforcing parity visually rather than by freezing bytes. [r5cv s1793; SPEC §9]
- **Moss pin.** The last approved pin is moss 26df579d5 (Option A baseline review, approved 08-05 "A but i'm worried about system resources", recaptured 08-06); glyphdown is pinned at faf98d07. Changing a pin requires an owner-gated, single-commit baseline review. Option A also moved oracle capture provenance onto the verification host with a pinned browser (Chrome for Testing 150.0.7871.187); recapturing on another architecture is owner-gated. On 08-14 the owner approved driving e2e flows on native arm64 Chrome for Testing (same version) while oracle captures stayed pinned to x64. [HANDOVER-0814 §7; BASELINE; bmrs s549, s2334; e2na s3822]

### 1.2 Architecture decisions that define behavior

- **CRDT of record.** The Lexical tree inside a Y.Doc, synced through the official `@lexical/yjs`. Markdown is import/export only. ("i also want to use the official lexical y.js plugin") Consequence: moss's "regenerate the editor from markdown on every load" invariant (VC-XCUT-1) is relaxed; the persisted Yjs tree is the state and a load hydrates from it. Whether to use the official `CollaborationPlugin` or a custom binding built from its primitives is open (§8). [4biv s2998, s3717; D7]
- **Hard requirement: title and frontmatter live in the shared Y.Doc.** They are Y.Text siblings named `title` and `frontmatter` next to `root`, never in a sidecar with a second writer. General rule: one writer per value, and derive every other surface from it. "Fix the sourcing; never patch the race." [PRODUCT; BUILDPLAN; axb3 s10136]
- **Comments and suggestions are first-class CRDT data** in the shared doc (RW-2 / Q4, 07-21). Paint is derived in the view. Exported `.md` stays clean, with no `%%m:` markers; a moss-compatible marker export exists only for vault migration. The design must go through a panel review before implementation, which never happened. [SPEC §9 Q4; r5cv s1581–1894]
- **One converter everywhere.** Server import and export use the client's exact transformer set. [PRODUCT]
- **CLI push is a structural tree merge.** Never rebuild the tree from markdown, so untouched blocks keep their Yjs identity and their anchors. [PRODUCT; D24]
- **One Durable Object per doc** (y-partyserver, hibernate), with per-update persistence and compaction by replay. Restore-after-hibernation is a permanent gate. A content write to a live doc is merged or refused loudly, never silently discarded (RW-4). [PRODUCT; D9]
- **Stack.** TanStack Start (React 19) on a Cloudflare Worker, D1 via drizzle, better-auth, R2 assets, SearchDO (FTS5 plus wiki-link index), HtmlDocDO. [SPEC §2; D10–D15]
- **Limits.** 2 MB per doc, 50 connections per doc, 60 pushes per minute per identity (glyphdown's values). [PRODUCT]

### 1.3 UI placement and fidelity rules

- **Nothing floats over the canvas, ever.** Collaboration controls (the Share/members control, presence face pile, History, notifications bell) sit inline in moss's top-bar chrome. ("why is there still floating ui") [n2ii s42911/44758; B-05/B-08]
- **Editing controls belong in moss's floating toolbar.** That includes formatting and the Edit/Suggest toggle. The toolbar docks at the bottom at rest and repositions near a text selection; a solo owner must be able to reach it. The top nav holds only non-editing controls. This supersedes DoD C2. A role-locked suggester sees a non-interactive "Suggesting" chip in the toolbar instead of the toggle. [d44s s20396–20669, s21180, reconfirmed 07-19; SPEC §2 div 7]
- **Two additions to moss** ("fix the cheap and real", 07-29): the floating toolbar hides while the editor is unfocused, and the sidebar Trash button accepts a dropped note. [deviations]
- **The External sidebar section is removed when it has 0 notes**, which on web is always. This matches moss behavior after v0.11.0. [n2ii s35825]
- **Hide affordances that cannot work rather than leaving them dead.** Each hidden item is listed in a registry with a deviations row. The list: Share with Agent, the AI run action and ⌘K prompt, Connected Folders, default-.md-editor settings, the ⌘N label (the +Note button stays), Reveal in Finder, Open in New Window, Save as PDF/Markdown, the workspace location picker, the external "Open folder…" row, quick capture, auto-update, and in-embed ⌘K capture. [PRODUCT; deviations; code:apps/web/src/moss/web-affordances.ts] *This conflicts with PRODUCT's "Open in New Window → browser tab, print → browser print"; see §8.*
- **Gate affordances by role.** Hide any control the server would refuse. Rename and Duplicate need editor or above; Trash and Restore need owner. At owner level, menus are byte-for-byte moss. One helper reads the same capability floors the server enforces, and an unknown role gets no actions. [deviations B1-T2]
- **The agent panel is ported but inert**; agent-execute rejects cleanly. [D4]
- **States must be honest.** Unresolved wiki links show an unresolved state. A failed fetch shows an error, never an empty state (a failed versions fetch once showed "No checkpoints"). [pukn s2282; bundle RECONCILIATION]
- **Ratified deviations are a closed set** (ruling 10), and every softening of a pass bar must cite a deviations.md row (ruling 13). The era-3 set: B12 print = `window.print`; RP-3 HTML preview as a live sandboxed iframe (POST /html-preview → 501); RP-4 copy-link invites; RP-5 analytics is a no-op; B8 per-viewer local state; B10 filename-canonical titles; B11 agent-execute rejects; A12 loud asset refusals; A3/B23 grace-batched 4403; B2/M5 restore 409 as honest degradation; B22 clean orphan; SEC-9 agent keys have no TTL (the live revocation kill is the compensating control, which D-G7 showed was missing); timing constants are judged by outcome budget. Any new deviation in moss-multi needs a deviations row and an owner ruling. [RUBRIC-RECOVERED J-14/J-15; d44s-b s53709–53784]
- **PR #525 divergences adopted as spec** (ruling 1): Backspace exits an empty list item; triple-click clamps to the `<li>`; the reply composer autofocuses; the `?initialNoteId` deep link works; `![alt](webpage-url)` becomes a WebEmbedNode on both client and server; Cmd+G works. [n2ii s36343–36370]

### 1.4 Collaboration, presence, input integrity

- **Co-editing.** Two clients edit one note live, as two people or as one person in two windows (a legitimate case). Edits appear as they are typed, nobody loses work, and both sides converge to identical content. [PRODUCT; bmrs s3625]
- **Undo.** Cmd+Z undoes only your own edits. Programmatic and derived writes create no undo step. Undo history is cleared on note switch. Context marks replicate to peers but are non-undoable. [PRODUCT; axb3 C-section contracts s1136, s9284]
- **Brief disconnections.** Edits are buffered and resynced losslessly behind an indicator that reflects the real socket state, never `navigator.onLine`. Long offline periods (local-first) are out of scope. The interview (D18) set the banner at 10s offline and a reload prompt at 5 minutes; PRODUCT does not restate these numbers, and the later heartbeat design detects a half-open socket in about 13s. When first sync stalls, the fallback editor stays locally editable with undo ("Working locally — shared persistence is paused") while REST persistence stays gated. [PRODUCT; CONNECTION-TRUTH; D18; axb3 s9124]
- **Presence.** A Google-Docs-style face pile in the note's top nav: zero chips when you are alone, exactly N chips for N peers, and agent sessions marked with a Bot badge from `isAgent`. [PRODUCT; DoD C3/C4; C-22]
- **Multiplayer text cursors are required** ("remember to have cursors"). Each peer gets a caret, a selection highlight, and a name label while typing, in a color identical to their chip. Colors are distinct among present peers and stable for the session. Cursor movement is tracked within about 1s. A clean close clears the cursor promptly; a hard drop clears it within 8–20s. [SPEC div 8; d44s s39005; JOURNEYS J1]
- **Titles are shared state.** A rename reaches every other client's title field, sidebar row, and breadcrumb within about 5s, without a reload. Concurrent renames merge. A title someone is mid-editing is never clobbered. A sequence of renames A→B→C converges monotonically with no stale flash. [PRODUCT; UPSTREAM-IMPACT]
- **Opening docs.** An existing doc always reopens showing its content, including after a long idle or hibernation. A new note opens with an editable title and one empty paragraph. [PRODUCT]
- **No silent input loss (owner P0, 09-02).** "we should not allow typing before a field binds… P0 eng practice", and "we just would not allow the focus or backspacing". Every input route (keys, paste, drop, IME, beforeinput) either lands or is visibly refused, through one announcer. Titles get no queue-and-replay (the body's input-liveness gate did hold keystrokes while "preparing" and replay them once). On WebKit, a bare Backspace must never navigate history. Typing into a field that is bound but not yet synced still lands. [PRODUCT; e2na s7863, s8024; B1-TITLE-TRANSITION-WINDOW-SWALLOWS-TYPED-TITLES; TRASH-RESTORE-TYPING-FIRST-CLICK]
- **Per-viewer state stays local** (ratified deviation B8): table column widths, collapsed headings, and the active tab index do not sync. They must still persist locally across reload: the owner ruled tab-group column width and label persistence across reload as SPEC (A-15), and A-18 re-applies table widths from localStorage on mount. [ruling 10; d44s s5023, s14742]

### 1.5 Notes, workspace, media

- **Names.** Naming is filename-canonical: docs are files, the H1 is content, and `[[links]]` resolve against slug-normalized filename stems (the legacy `[[Title With Spaces]]` form still resolves). Moss's H1→title behavior is relaxed (B10). [PRODUCT; D16/D31] *How this interacts with the CRDT title field was never fully specified; see §8.*
- **Node families.** Every moss node family works as real styled nodes: tables, callouts, tabs, charts, sketch/canvas, HTML, images, video, embeds, formulas and variables, color pills, and code blocks with language labels. [D5; PRODUCT]
- **Web equivalents for Electron-only surfaces.** Web embeds and the in-app browser become sandboxed iframes or unfurl cards. The HTML preview is a live sandboxed iframe (`allow-scripts` without `allow-same-origin`; POST /html-preview returning 501 is ratified as RP-3). PDF output uses `window.print` (B12). [PRODUCT; G-29]
- **What stays in markdown.** Moss content extensions (moss-chart, `:::tabs`, moss-html, #hex, formulas) stay in the markdown. Desktop sidecars move elsewhere: comments and suggestions into the CRDT, metadata into server records, and assets into folder-scoped storage referenced by relative path. [PRODUCT]
- **Vaults and folders.** Folder create, rename, and delete (moving the subtree to trash) work from the web UI. Vault create and switch come from a port of glyphdown's VaultSwitcher with an inline "New vault" row (B2). Vault trash is an owner-only, always-visible ellipsis that opens Move to Trash with a ConfirmationDialog; members see no vault actions. [PRODUCT; e2na s3210/3485]
- **Delete means trash** (rulings through August):
  - Notes are soft-deleted and restorable; 30 days is a minimum, not a deadline. Hard delete and storage reclamation are deferred.
  - Loading a deleted doc fresh returns 404.
  - Clients that have it open disable every editable surface for good, so no zombie editing.
  - Copy never says "removed forever" or "deleted in N days", and one module writes all trash copy.
  - The CLI `rm` says "moved to Trash — you can restore it for 30 days" and emits `{action:'trashed',restorable:true,retentionDays:30}`.

  [PRODUCT; deviations; bmrs s10342]
- **Search and backlinks** cover everything the user can access (SearchDO as-is). There is also an in-app bell and inbox (D1-backed, polled, moss-styled) for @mentions, share invites, suggestions, and comment replies. [PRODUCT; I-30]
- **Media is exactly moss's set.** Images: png, jpg, jpeg, gif, webp, svg. Video: mp4, webm, mov; upload must work and the poster must render, which overrides the earlier ruling (RP-1) to refuse video uploads with 415. YouTube embeds by URL. No audio, no PDF embeds, no arbitrary files. Assets are folder-scoped in R2 and uploading requires editor or above. Images are referenced as `![alt](filename)`; doc-scoped and folder-scoped URLs both resolve; share tokens apply; assets appear as first-class entries in the file tree. Copied notes carry their media. [PRODUCT; D12; ruling 7; I-11]

### 1.6 People and access

- **Sign-in.** Email and password are first-class. An OAuth button renders only when that provider's credentials are configured, and none are configured for the reference. Dev auth can never run on a production origin. Sign-up on staging is open, with no allowlist. Invites are copy-link only, and no email is sent. The login card follows glyphdown's login-card layout and chrome, but its fields are built from moss DS inputs, because glyphdown at the pin is OAuth-only and moss is the ruled design source. [PRODUCT "Ruled during review"; bmrs s5359, s7086]
- **The no-sign-in playground** survives only behind a dev flag plus a loopback gate (the four-condition DEV_AUTH gate, §4.9). It is never offered as a public demo. [PRODUCT; x4g2] *deviations.md says to delete it after B1; see §8.*
- **CLI and agent credentials.** The CLI signs in with the Device Authorization flow (RFC 8628). Agents use per-agent `gd_sk_` API keys minted from a web Settings → Agents screen, which did not exist in era 3. [D13; G-19; H-33]
- **Roles.** viewer < commenter < suggester < editor < owner, and all five exist in the schema. The share UI exposes only viewer, commenter, editor, and owner until suggestions ship (the B1 dialog offered three grantable roles: viewer, commenter, editor). Viewer and commenter are refused in both title and body; menus grow with rank and only the owner sees Trash. A user's effective role is the maximum over all their grants: doc, folder chain, vault, ownership, and share link. Only the owner manages sharing, in the UI and in raw requests. [PRODUCT; bmrs s7307]
- **What can be shared.** A vault, folder, or doc, with a person, an agent, or a revocable token link. Anonymous visitors with a link get viewer access; comment and above require sign-in. An editor link opened anonymously works at viewer level and offers "Sign in to do more", which returns to the same doc. ("NO — sign in to edit.", 08-14) [PRODUCT; e2na s4831]
- **Non-disclosure.** A revoked, forged, or never-granted token, and any doc the caller cannot access, returns a response byte-identical to that for a doc that never existed. [bmrs s8108]
- **Permission changes on live connections.** Demotion or revocation affects the live connection immediately (close code 4403). Promotion takes effect on reload, matching glyphdown (SEC-2, advisor ruling 07-18). Revoking an agent key must also kill the agent's live sockets; D-G7 found that it did not. [PRODUCT; 6mff s1; d44s-b]
- **Invites must be discoverable** through a copy-link URL plus an in-app notification. Notifications are re-checked against the live grant, and unreachable targets are omitted. [D-G6; bmrs s9957]

### 1.7 Comments, suggestions, history

- **Comments.** Moss's full experience (gutter, highlights, threads, replies, @mentions, resolve) plus glyphdown's reactions. Typing after creating a comment must never drop a keystroke; this is a permanent gate. Anchors are Yjs RelativePositions with a W3C text-quote fallback. The comment author comes from the server principal. [PRODUCT; Q4]
- **Suggestions.**
  - They are tree-level tracked changes, made in live suggest mode or with CLI `push --suggest`; another person accepts or rejects them.
  - The server enforces suggester limits: a violating edit never lands and is never silently dropped.
  - B4 must make the client discard its optimistic local state when it receives the `4403 suggest-policy` close (DEF-1, deferred under option c on 08-13).
  - The demo notes must show live pending suggestions.

  [PRODUCT; deviations; J-10]
- **History.** Automatic snapshots plus named versions, with a read-only view, a diff against the current doc, and restore. A restore is itself an edit and preserves comment and suggestion anchors as well as concurrent peer edits. Failures degrade honestly (a 409 on restore conflict, B2/M5). [PRODUCT; F-14]

### 1.8 Agents and sync

- **External CLI agents are first-class collaborators.** With an API key they pull, push, and sync `.md`. Pushes merge into the live doc while preserving concurrent human work, and agent edits are attributed through Bot-badged presence. In-app agent execution is out of scope. CLI doc references accept glyphdown's three forms, including title-prefix references (owner ruled H-19 = BUILD, 07-13); the era-3 build returned an auth error for them. [PRODUCT; d44s s5616]
- **Local↔cloud sync v1** is glyphdown's CLI mirror (clone/sync with base tracking) plus a local folder-watch daemon that runs the same sync loop, the analog of moss desktop's chokidar watcher. ("ok, let's do CRDT for comments, and also daemon option") [r5cv s1894; SPEC §9 Q3]

### 1.9 Viewports, deploy, deliverables

- **Two viewport tiers.** The coordinator ruled this under the owner's delegation "resolve the phone sizes stuff yourself" (08-13). [PRODUCT; CASE-LAW]
  - Tier A is a stranger's path: open a share link, read the doc, see the login card, sign in back to the same doc. It must WORK at 390×844 and at 1440×1000. Passing is judged by completion: the label is legible, the control's centre is tappable, and the transition completes, with 0, 1, and 2+ live collaborators present.
  - Tier B is everything else. It is designed at 1440×1000 but must never trap an affordance off-screen.
  - Oracles are captured at 1440×1000.
- **Phone shell (<640px).** [NOTE-CHROME-PHONE-PANEL; e2na s5882, s6614]
  - The notes panel overlays the canvas and starts collapsed, reusing moss's zen-mode overlay. It stays open after a note is selected, as it does in both oracles.
  - When the chrome row runs out of room, the title gives way first and then presence (the face pile caps at 3 plus "+N"). Affordances never give way.
  - Share becomes icon-only, and search and copy-link fold into an overflow menu.
  - Invite notices take a reserved band and never cover the document.
- **Deploy.** Staging only, on workers.dev, under the owner's PERSONAL Cloudflare account and never the work work account. Worker, D1, and R2 names are chosen once and never renamed, because DO storage is bound to the worker name. What would trigger a production deploy is still undecided. [SPEC §8; n2ii s24676–24741; PRODUCT]
- **Demo notes** (an era-2/3 deliverable, not restated in PRODUCT). Notes in the owner's own vault, built through the real UI, exercising every feature: text, lists, code with language labels, callouts and tabs, tables, frontmatter and formulas, real images, video, HTML, and web embeds, live charts and canvas, live comments, and live pending suggestions. Markdown copies and caveats were rejected. The owner's signature proof shot is one screenshot showing a peer's multiplayer cursor and suggested edits in a longer sentence alongside rich node types. [n2ii s35363, s44775; J-01..J-11; d44s s46282]

### 1.10 Owner working rules

- **What the owner decides.** Each milestone transition (the owner may re-sequence milestones after B1). The owner is never the referee of evidence. The only owner-gated items are product-contract rulings, PRODUCT.md changes, milestone transitions, and baseline or pin changes. Defects the loop finds are always fixed without asking: "stop asking me these questions, always fix these issues" (08-17). [BUILDPLAN; e2na s5766]
- **Build to spec when the spec is explicit;** do not re-ask. When asking, put the question in plain language with screenshots and options. A bare "cont" is never a ruling (a premature approval recorded from "cont" was rolled back). [d44s s41572; HANDOVER-0814 §6]
- **Interview format.** For every question, state first what glyphdown does. Use click-through pickers, one at a time, with the glyphdown-as-is option preselected, and mirror each question in text. [d44s s5371; 4biv s1994, s3099]
- **Progress reporting.** PROGRESS.md is updated in the same commit as every booking, dispatch, and verdict. Its header is ONE overall % number, and every progress report includes an inline visual of milestone % and program %. Screenshot evidence goes inline at every milestone pass. [bmrs s7090, s6582; e2na s3539/4040]
- **Each milestone ships its feature's UI** and must be e2e-QA-able through the real UI ("as long as we're able to e2e qa at each milestone"). [kqtn s413; axb3 s9396]
- **Durability and hygiene.** Commit and push at every green step ("unpushed work doesn't exist"). No stashes. Settle the provider and model before spawning, pass them explicitly (a project's remembered default once spawned a "Fable" coordinator on codex), and no speculative spawns. Archive finished workers and worktrees as you go. HANDOVER-0805 also said "no worktrees without owner approval, removed at harvest"; the owner's current global CLAUDE.md prefers BB-managed worktrees, which is the later rule, but keep the owner-visible checkout on `main` (switching it to a task branch once made the handover doc "not load"). Repos live under `~/Code`, private, with a remote ("at very least it should be at ~/Code/"). [HANDOVER-0805; d44s s52372; d44s-b s64668; e2na s2412; yzzh s2663]
- **One goal.** "you have 1 goal and it's moss-collab" (07-29): coordination sessions touch nothing outside the project. [e2na memory pointer]
- **Visible orchestration.** Orchestration must be visible in bb's UI ("i want to use the plugin so i can visualize the workflows in bb"), and any worker the owner should see (including an advisor) is a bb thread, not an invisible in-session subagent ("where is the fable worker/adviser thread?"). [yzzh s2775; d44s s52369]
- **Flake dispositions (owner-ratified 08-12).** WATCH-SOCKET-CHURN-CONNECTING is quarantined as documented noise, but any new signature still fails. HYDRATE-FETCH-FLAKE stays on the books and becomes a product defect the moment it reproduces unloaded. [HANDOVER-0814 §6; bmrs s6742]
- **Worker models** (last ruling, 07-28 and 08-14). Builders and fixers run on claude-code `claude-opus-5[1m]`; verifiers on codex `gpt-5.6-sol`. Reasoning is high by default and medium for simple changes, never xhigh for workers. Only the owner can waive cross-vendor checking. The coordinator runs on Fable and does judgment only ("i can only have fable for YOU"). The lane cap is 3. This supersedes the earlier all-codex, xhigh setup capped at 5–7 workers. [WORKFLOW-DESIGN; HANDOVER-0814 §6]
- **Where builds run.** On the owner's primary arm64 machine since 08-14 ("I need these workflows run"). The Intel Air's fate was left at "decide later" and never revisited. [e2na s1611, s3822]
- **All bb work goes to get-bb/bb,** never the owner's personal fork. [e2na/zhe3 s1545]
- **The owner's current global CLAUDE.md also binds the restart.** It requires bb Browser Automation (Chrome for Testing) for browser QA, forbids standalone Playwright, requires 2× screenshots, and says CI runs remotely. The old harness violated all of these; see §8.

### 1.11 Superseded decisions where the reversal is the lesson

| Was | Became | Lesson |
|---|---|---|
| Exit gate: 487/503 self-written VCs passing headless (D33, 06-26) | Real moss UI in a real browser (R1–R4, 07-03), then a 284-row screenshot rubric (07-11), then PRODUCT + BUILDPLAN + cumulative UI journeys + a critic (07-28/29) | Every gate was replaced after it went green on an unusable product. |
| Extract `@moss/editor` for both Electron and web (D20, 06-25) | Frozen byte-copy plus Vite seams (era 2), then an adapted port at a fresh pin (Q2, 07-21) | Frozen copies turned every fix into a seam hack and could not track upstream moss. |
| Title in `doc_meta` with a broadcast channel (era 2–4 port, hardened by two fix trains) | CRDT `Y.Text` title (RW-1, 07-29) | "I thought I made this decision already" [POSTMORTEM]. Briefs were never checked against the decision table. |
| "soft delete… hard delete after 30 days" with DO storage reclaimed (RW-3, 07-13) | Hard delete deferred; 30 days is a minimum | Era-3 harness churn (one never-reclaimed DocDO per test note) hit the Cloudflare free plan. The binding caps were daily requests and observability events, not storage, though later docs blamed the missing hard delete. Watch cost either way. |
| Edit/Suggest toggle in the top bar (DoD C2) | Floating toolbar (07-13, reconfirmed 07-19) | Stale rubric rows kept grading the old rule for 6 days and produced false defects. |
| No vault switcher; vault creation API-only (B-10, B30) | Port of glyphdown's VaultSwitcher (PRODUCT review, 07-29) | A capability with no UI is not shipped. The B1 e2e later confirmed a naive user had no vault-creation or vault-trash surface and had to wire-seed a vault; a missing affordance counts as a FAIL. |
| `SIGNUP_ALLOWED_EMAILS` allowlist on staging (agent's choice, 07-09) | Open staging sign-up | The allowlist was a workaround, never an owner intent. |
| "use workflows", then "no more workflows" (07-11), then Omega Code (07-19), then the bb workflows plugin (07-21), then implement/checker/e2e workflows (08) | — | Orchestration churn and plugin side quests ate weeks. |
| "do this but i don't want to review until the end" (06-25; the interview answer was recorded as "Workflows per milestone + check-in", and REBUILD-SPEC D34 restated it as autonomous) | Autonomous, with screenshots each gate and owner-approved milestones | Review only at the end let a lookalike UI live for a week. |
| All workers codex xhigh, capped at 5–7 | Cross-vendor Opus/Sol, high effort, capped at 3 | Cost, decorrelated blind spots, and machine load. |
| Web-only collab chrome kept out of the steady state (History at opacity 0 until hover, no Edit/Suggest for a solo owner, controls placed outside compared regions) so the pixel gate stayed near 0 (era 2) | Controls inline in the top bar; Edit/Suggest reachable by a solo owner in the floating toolbar | A gate that new features are designed to avoid is gameable; the owner found the hidden and floating chrome. [62jf s18031; n2ii s7541, s14603] |
| Progress on two axes, verified subsystem vs usable product (07-28) | One overall % number plus a milestone/program visual (08-13/08-14) | The owner wants one glanceable number; the lesson that booked rows are not a usable product survives as the journey gate. [SPEC §10.6; bmrs s7090; e2na s3539] |

---

## 2. Owner preferences and feedback (verbatim)

### 2.1 How to communicate

- "i don't understand" [n2ii s6424]. "huh? also i'm away from home for the weekene" [e2na s981]. "> Your three decisions — idk what these mean" [bmrs s6584].
- "i take all your recs" (after a plain-language re-ask that included screenshots) [bmrs s6742]. "I didn't get any answers." [bmrs s8936]. "Those were both supposed to be questions." [bmrs s9200]
- "also where are you committing all work? … ANSWER ME … which repo" [d44s s1625–1825]. Agent replies that ended in a tool call never showed their text.
- "always use albsolute paths" [yzzh s4898]. "you gave me this link" [n2ii s41737]. "> fullwindow-doc.png — i don't see this" (the image had never been embedded inline) [yzzh s4462]. "take full app window screenshots" [yzzh s4242].
- "share screenshots here as each gate is successfully passed. can you also update the name/description of each gate … to be more descriptive" [yzzh s4082]. "just the passing ones before you move on to the next gate" [d44s s36826].
- "can you report % progress in someway so i know how far along we are across all milestones?" [bmrs s4821]. "update this so it's just 1 number % done overall" [bmrs s7090]. "create inline vis of these 2 metrics and keep it updated / can you post this every time you report progress?" [e2na s3539/4040]
- "what is rubric.workflow.js and why does it need to be blasted everywhere" [d44s s55723]. "what is Acceptance?" [d44s s60458]. "i want this UI to be scannable toget a sense for number and type of workers (provider/model), status etc" [d44s s59258]
- "can you make each gate a row, simple Base UI, use max 2 fonts" / "why are there so many states in the ledger" / "why don't the two match" [yzzh s5560/5886/5788]
- "keep it as concise as possible … cut out repo specific stuff / don't make it about what bb doesn't support, just say what to do" [e2na s8594–8645]
- "for the CRDT option, would there be markers in the md" (asked twice) [r5cv s1581/1796]. "> set the 5-worker cap — why?" [r5cv s1933]. "what are you locking into the spec" [r5cv s1757]
- "i gave you my product goals--is that not enough?" [SPEC §10]. "does quote-anchoring mean comment syntax is not in the md file?" / "why does reconciliation need to happen before editing the md file?" [interview 22:24/22:28]
- "PROTOCOL FIX — the owner cannot tell what's running from this thread" (every status must state what is running now and what is next, verified fresh) [axb3 s649]. "did you get that?" (a free-text ruling went unacknowledged) [e2na s7864]
- "tha'ts not what i meant—the 5% is cut off in the UI because of insufficient padding" / "not fixed. i can't read the % under Rubric when progress is low." (read UI feedback by its visible symptom, and check the edge case before claiming a fix) [axb3 s8908–8951]
- "so get off my back semantic police" (accurate, but not pedantic or preachy) [qb6q s3090]. "idle time shouldn't count" (report working time) [qb6q s1079]. The owner asked agents to silently translate terse prompts into clear instructions, and disliked dense, mannered report prose [e2na s8310]
- **Implication.** Lead with the answer. Answer direct questions first and literally. Use product language, never internal jargon (trains, bookings, organ, lanes). Use absolute paths, inline images, one progress number, and options with a recommendation. Explain why any constraint exists.

### 2.2 Autonomy and decisions

- "go until done" [yzzh s1303]. "go, don't stop until you're done" [r5cv s2465]. "keep going until done" [d44s s10993]. "I need these workflows run" [e2na s1611]
- "stop asking me these questions, always fix these issues" [e2na s5766]. "FIX BOTH NOW" (remount keystroke loss and the editor share link, 08-14) [PROGRESS ~20:15]. "you answered that yourself: the spec specificed it -- build to spec" [d44s s41572]
- "run loops … if something doesn't work, fix it and re-run the loop until it does work. do this efficiently" [n2ii s29124]. "get moss-collab done ASAP" [axb3 s9492]. "you have 1 goal and it's moss-collab" [07-29]
- "can you just pull down the repo and build and screenshot https://github.com/SawyerHood/glyphdown" (stand up references yourself instead of asking for logins) [d44s s16321]
- "idk how to do this can you do this without me? Also resolve the phone sizes stuff yourself." [bmrs s9064]. "can you do it … via computer use" (refusing to take back deploy steps) [n2ii s24303]
- "oauth can be figured out last, test everything else" / "oauth is not a f***ing blocker" [4biv s23107/23117]. "> in-sandbox — what do you mean? can you launch a codex worker to use the codex computer use plugin" [4biv s22711]
- "don't worry about session limits, i will bypass them if they are hit and retry" [n2ii s7703]. "just restart after i tell you to continue … and continue from the cache" [n2ii s31088]. Standing rule: no wait-timers; stop, and resume when told "continue". [n2ii HANDOFF §5]
- "read the plan top to bottom, address issues then start" [4biv s3572]. "i dind't ask you to sotp the workflow/work" (a correction to one action is not a stop order) [d44s s36307]
- "make sure you are periodically archiving workers/worktrees as work progresses" [d44s s52372]. "why are you modifying a repo?" (the agent had patched another thread's plugin) [yzzh s3127]
- "should we commit this remotely for backup in future? at very least it should be at ~/Code/" [yzzh s2663]. "you should be using the omegacode bb plugin" / "i want you to use the plugin so i can visualize the workflows in bb" [yzzh s2431/2775]. "where is the fable worker/adviser thread?" [d44s s52369]
- "CORRECTION … bb did NOT restart — app/server/daemon have 28h uptime" (the agent blamed the environment without checking) [axb3 s725]. "yes it does" (the agent wrongly claimed Codex had no subagent primitive) [qb6q s1920]
- **Implication.** Work autonomously and work around non-essential blockers yourself. Make reasonable calls under delegation and write them down. Ask only about product-contract decisions. Never touch repos or tooling outside the task.

### 2.3 Verification expectations

- "you did this completely wrong, the tests were supposed to assert the real UI" [interview 07-03]. "the app looks nothing like moss" [4biv s27100]
- "i want you to launch codex workers to use computer use to actually use the app UI and verify e2e that all criteria is met" [4biv s22895]
- "make sure the UI is pixel perfect to moss' UI today, and that the tests in the TDD assert the pixel perfect UI" [n2ii s5720]. "i don't want byte-identical, i want pixel perfect" [n2ii s6476]. "each milestone/step should have a hard gate of pixel perfect UI tests passes before the next milestone is started" [n2ii s6480]
- "you need to do a pixel perfect gate on the prod e2e built experience before i test" [n2ii s26138]. "make sure this includes all node types/styling/comments etc etc / split view as well, broswer, folders, external notes etc" [n2ii s26191/26283]
- "error when i log in and create a note. i thought you logged in and created extensive notes? … i need you to login and use this extensively to test every part of the spec e2e with screenshots" [n2ii s27525]
- "all verification needs to be visual / with screenshots, since we are validating rendered behavior/contnt" [d44s s1494/1512]. "these need to be screenshiots / we are validating against rendered screenshots, not code" [n2ii s45213/45230]
- "i suspect you need to create the same notes in current moss vs moss collab vs glyphdown … and compare 3 way" [n2ii s45376]. "what about glyphdown ui?" [n2ii s45983]
- "focus on the rubric first … get that absolutely perfect, bc if it's bad eberything fails" [n2ii s46051/46068]. (Kept as "gate first"; the 284-row rubric itself was later archived.)
- "each milestone should build on collective e2e testing driving the UI as a user with screenshots and code assertions that previous functionality continues to work and be built on with new gates" [JOURNEYS 07-29]
- "you're confirming with screenshots at each gate?" [r5cv s2874]. "> Confirm the flash is gone on staging (the one thing I can't verify myself). — idk how" [n2ii s42335]
- "this feels important to highlight (independent evaluation)" / "the start of a good loop is a small loop with representative sample and a self-improvement loop?" [qb6q s758]
- "i need you to proactively confirm the quality of the workflow scripts so there are no issues or burned tokens" [d44s s59294]
- "also where are the note deliverables you are supposed to be working wbackwards from?" / "do you not see the original spec for this work from thread history?" [n2ii s42929/43398]. Work backwards from the original spec and its deliverables.
- "this is complete wrong, how can we correct … i want to correct the loop/workflows and then correct the design" (the agent had framed its own regression as a catch; fix the process first, then the artifact) [qb6q s5355/5359]
- "can you give me a few bullets of the must haves for designing a great workflow from my past moss-collab failings?" The agent's answer: convert intent into checks, separate building from grading, make evidence structural, give detectors negative legs, never book infrastructure noise as a verdict, push everything immediately, treat verdicts as supersedable, keep intent in one re-read doc. [bmrs s4944/4982]
- **Implication.** The agent drives the real deployed UI itself, as a user, with screenshots. Grading is independent. The owner is never the QA oracle.

### 2.4 Product and UI fidelity

- "all -- i want all of glyphdown's features but moss' frontend" [interview 21:55]. "i want all of moss' frontend, so that includes agent panel and non-editor chrome, but agent execution is ooc. i don't want glyphdown UI" [interview 22:16]
- "what does glyphdown do" [22:41]. "re: vaults, don't we have that today in terms of workspace?" [22:37]. "what would glyphdown do" / "look at what glyphdown does" [e2na s7994, s8195]
- "the goal is to create a separate reference repo with glyphdown eng/backend and moss UI, using test driven development." [4biv s27308]
- "i saw the dev app where the dimensions around the canvas were weird and the app bg was showing in unexpected ways. make sure the agents are launching it correctly" [n2ii s6672]
- "what is the B -- is that how gylphdown's multiplayer cursor's are implemented?" [n2ii s35201]. "Alone too" (presence must be exact in the solo case as well) [n2ii s28232/37987]. "in addition to this, we also need multiplayer text cursors not just the attribution … glyphdown does this" [n2ii s37449/37478]. "remember to have cursors" [d44s s39005]
- "why are these things still floating over the canvas? no more flashing tho" [n2ii s42911]. "External empty state is to just remove the folder, not to show it with 0 notes and a an unfurled \"+ Open folder...\" button" [n2ii s35825]
- "editing remains in a toolbar that floats at bottom (or near selected text). so edit/suggestion should be triggered from there / top nav is for non-editing controls / you should note the moss toolbar moves based on text selection" [d44s s20396–20669]
- "isn't the comment backend taken from glyphdown?" [n2ii s36463]. "i thought we were getting rid of that for what glyphdown does" / "would that be easier to maintain" (about the title field) [d44s s4649/4769]
- "you're basing moss ui on the v0.11.0 branch yes?" (the agent had silently used a stale local main; confirm the baseline ref up front) [n2ii s11701]
- "all publishes notes have anyone can view permissions, can also scope to emails/users" / "these should be possible on web?" (Electron-only decorators should get real web implementations, not pre-baked fallbacks) [pukn s2373/2338]
- "we need to be honest, should show unresolved link state" [pukn s2282]. "make sure this follows best practices of apps like google docs" [pukn s904]. "i want to see detailed explanations of every new screen in the spec, html mockups of major screens and flows, technical design doc" [pukn s2404]
- "we should not allow typing before a field binds. P0 eng practice" [e2na s7863]. "how would this be possible? preventing the bahavior should also prevent the bug right?" (rejecting the claim that refusing focus would reintroduce the WebKit Backspace bug) [e2na s7944]. "why would we let someone focus an inout that they can't type in, we just would not allow the focus or backspacing j*c" [e2na s8024]. "NO — sign in to edit." [PROGRESS 08-14]
- "this is terrible" (a generic SaaS empty state) / "the current empty state is wrong and missing the shortcut" (Figma DS work) [qb6q s5265/5273]
- **Implication.** Fidelity to moss is the product. Moss-absent UI must look native to moss. Glyphdown answers interaction questions. Quiet, minimal moss voice, never generic SaaS patterns.

### 2.5 What infuriated the owner

- "f***ing fix it" (on a caveat that copied demo notes could not carry media) [n2ii s44775]
- "what thd f*** is wrong with you. YOU KNOW THE DEFINITION OF DONE STOP WITH CAVEEATS, WORKFLOWS UNTIL DONE" [n2ii s44797]. "FIX TOO -- no NEXT UP FIX IT ALL WITH LOOPS OF WORKFLWOS UNTIL DONE" [s44814]. "YOU F***ING SAID YOU WOULD" [s44901]
- "the notes also don't exercsie all features like comments etc … and empty state external is not fixed w*f" [s44956/44983]
- "you didn't learn anything from the f***ing @thread:thr_qb6qrcu3m4 thread i shared" [s46049]
- "i am not switching accounts / i don't have the right access to the work one f*s listne to me / i said 5millions times i swtiched accounts" [s24710–24741]. "IT KEEPS SAYING \"SITE CAN'T BE REACHED\" / WHAT THE F*** DO YOU NEEDC" [s24966/24968]
- "the live app is unstyled / not pixel perfect" [s25596]. "the flashing is still there, it's not a loading state. the entire page flashes and rerenders every 30sec" [s37987]. "it wasn't session limit, you just seemed stuck for hours" [s16708]
- "I thought I made this decision already" [POSTMORTEM]. "this keeps happening, how can i turn this into something yiou use to unblock youreslf? WWGD what would glyphdown do" [e2na s8195]
- "why does your model keep falling back" / "why can't you screenshot bb?" (the agent had claimed it could not without testing) [d44s s54749/55585]. "are you asking for my credentials for chrome? stop pls" [d44s s36265]
- "i don't even know if this is salvagable" [4biv s27305]. "you lied to me" (Figma DS attempt, false "done" claims) [qb6q s538]. "i think we need to pause and re-think the system." [NEXT-STEP 07-29]
- "continue", "IT RESET", "it's 1:33pm contniue": roughly 10 times in era 1 and about 50 in era 3, every time the loop stalled on limits. [4biv; d44s]
- **The pattern.** Caveats shipped as deliverables. Owner-flagged defects parked as "next up". Claims of done or fixed with no proof. Ignored account instructions. Untested claims that something was impossible. Decisions re-made against the spec. Babysitting stalled loops.

### 2.6 Cost and resources

- "i can only have fable for YOU" / "cost is still a constraint" [d44s s54797]. "i want you to use omegacode with codex sol 5.6 workers. i want YOUR model to stay fable" [s54793]
- "can we minimize the number of notes we are creating as part of htis? use fewer notes but don't chagne the gates" [d44s s13337]
- "A but i'm worried about system resources, we'll have to wait til my current threads stop" [bmrs s549]. "i upgraded my codex account" (to keep the cross-vendor checker rather than waive it) [bmrs s7677]

---

## 3. Why prior attempts failed

POSTMORTEM.md (07-29) numbers "four eras" differently. The table below uses calendar order.

| Era | Dates and threads | What happened | Root cause | Lesson |
|---|---|---|---|---|
| 0. Spec only | May 22–Jun 15 `pukn` | The owner merged the "Publish to Web" and "Version History" specs into one 246 KB Moss note (anyone-can-view publishing, email scoping, Google Docs patterns, HTML mockups, TDD). Never built. | — | The owner's inline comments are requirements. Specs must explain every new screen. |
| 1. Headless build | Jun 25–Jul 3 `4biv`; repo brsbl/moss-multiplayer fecb47f | 40+ question interview, then milestones M0–M7 run fully autonomously. "EXIT GATE GREEN": 1,526 headless tests and 503 self-written VCs with 0 unmet. Real Chrome showed collab returning WS 404, no CSS, rich nodes as plain text (server importer missing 7 block families), existing docs opening empty, one decorator blanking the editor, and hibernated DOs serving empty docs. The shell was a reimplemented lookalike: "the app looks nothing like moss". | Verification ran on proxies the agent controlled (jsdom, in-process Yjs, a spec it wrote). The integrated app was never run. Agents reimplemented moss's shell instead of porting it. The agent assumed no browser existed without checking. Review was deferred to the end. | Real browser on the real stack from M0. Port moss; never reimplement it. Probe environment capabilities first. One converter. |
| 2. Byte-copy rebuild and staging | Jul 3–11 `n2ii`, `62jf` | Byte-copied moss packages/desktop and packages/shared (v0.11.0), adapted through Vite seams and a `window.electronAPI` shim. M0–M7 declared green with a pixel gate at about 0.24% on one fixture. Deployed to staging; the owner then found an unstyled prod build, social login returning 500, a 30s whole-page flash, a stale-chunk crash, floating Share/Suggest/presence controls, a ghost "B" peer, no cursors, `%m:` markers leaking, a wrong External empty state, a broken HTML preview, and demo notes that were 123-character markdown copies. B24 (every keystroke after a comment dropped) survived four "closed" milestones. | Self-graded gates. The pixel gate ran only on the dev server. A narrow fixture that new chrome was deliberately placed outside of. Owner-flagged defects deferred. Caveats shipped. A 126-agent fan-out lost 109 agents to quota. | External gates on the production build. Coverage of every surface. Fix owner-flagged defects immediately. No caveats. Pilot before fan-out. |
| 3. Rubric and harness | Jul 11–20 `d44s` (+`6mff`) | A 284-row rubric (6 review rounds plus a red team), validated pixel and behavioral harnesses, then codex workers through a campaign runner and later Omega Code. Reached 119–120/284 green and fixed about 37 real defects (D-F3 empty-tree clobber, F-14 restore discarding peer edits, cursors). The second half produced zero product fixes: plugin-UI side quests, a 115-agent verify runaway (load 230, 1,466 processes), codex quota walls, Fable falling back to Opus, harness-invented false defects. | Verification infrastructure dominated cost. A single bloated coordinator. Orchestration churn. The repo lived only in a BB-managed environment. | Keep acceptance lean. Fix confirmed data-loss and security defects immediately. Keep the coordinator lean. Keep tooling side quests out of the coordinator. |
| 4. Destruction and recovery | Jul 20–21 `yzzh` (+ duplicate coordinators thr_6wf4z5yfce, thr_3c4cm65uaq) | Archiving the thread family destroyed env_pmgnprh2j6: 567 unpushed commits, the harness, the oracles, and most evidence. The repo was rebuilt by replaying 4,209 Write/Edit operations mined from transcripts onto fecb47f, validated, and pushed to brsbl/moss-collab (now -legacy). Ended at 132/284 green with 52 open defects (suggestions, share links, CLI/converter, history, demo notes). | No git remote. Duplicate takeover coordinators. The predecessor was archived without checking for unpushed state. | Remote on day one; push every green step. Never keep the only copy in BB environments, thread storage, or `/tmp`. One owner per task. |
| 5. Re-spec and rubric rebuild | Jul 21–29 `r5cv`, `axb3`, `kqtn`, `x4g2` | New SPEC.md with Q1–Q4 approved. A scratch repo porting verified packages, built with the bb workflows plugin. P0–P2 passed: ports confirmed (one refuted for hiding dropped tests), the Lexical-in-DO spike passed, the real moss shell matched Ladle. The C-01 pilot then exposed Lexical #343, the D-F3 ordering bug, a 57s invitee open, and missing presence. Section C reached 10/22; 10/284 overall. The product critic found no remote carets, one-sided presence, titles not syncing, a lying offline banner, and broken folder creation. The owner caught title fix trains hardening the forbidden `doc_meta` split. The RW-1 fix then regressed the warm owner. SYSTEM RESET on 07-29: "i think we need to pause and re-think the system." | Intent was spread across four decision namespaces and never became checkable. Subsystem rows were mistaken for the product. Briefs were never checked against the spec. Harness artifacts. A laptop load ceiling of one graded run. | One short PRODUCT.md, re-read before every brief. UI-only journeys plus a naive critic. Vary state, not just environment. |
| 6. B0–B7 build loop | Aug 5–Sep 2 `bmrs`, `e2na`, `2yq6` | Implement, then a cross-vendor checker, then append-only e2e. B0 closed 08-12 (23 e2e flows); B1 closed on a conditional GO on 08-14 ("GO, after the title fix"; the condition was met that evening and B2 was to open with the vault switcher, but never started). The checker found real security bugs: sign-out left sockets writable, share links 401'd anonymously, an existence leak, unauthorized bytes merged after DO wake, refusal frames never received. Trash-401 took 8 cycles. Roughly 16 runs were killed by bb daemon restarts on the Intel Air, which was also running a bb dev stack. Codex quota exhausted. The title arc ran 5+ trains and never closed. The e2e board never went green (9 driver versions, 7 harness trains). A 2-week idle stall (08-18 to 09-02) after a monitor died. The last checker died 09-02 and was archived 09-24 at 44%. | Disproportionate verification ceremony (declaration audits, refutations over narrative). Symptom-first diagnosis on ported surfaces. A fragile host. Non-durable liveness. Branches diverging for long periods (102 ahead / 87 behind). | Oracle-first (WWGD). Verification proportional to risk. A stable native host. Structural fixes. Scheduled liveness checks. Merge often. |

### Recurring cross-era failure patterns

1. **Proxy green.** Every era had a metric that went green while a human could not use the app: headless tests, a self-written VC list, a one-fixture pixel gate, rubric rows, per-task checker passes. [POSTMORTEM; kqtn s1]
2. **Reimplementation and drift from the reference.** A lookalike shell (era 1), DOM-free server "twin" nodes, a reduced server importer, and UI for moss-absent features "synthesized from moss primitives" that ended up floating over the canvas. [4biv s27256; n2ii s17859]
3. **Two writers for one value.** The title split, frontmatter sidecar, REST save lane next to the CRDT, disk-change remounts, metadata polling, and a separate watch socket. Each produced a race family that was patched with gates instead of fixed at the source. [axb3 s10136; code]
4. **State captured before async hydration.** Bootstrap before sync, the suggest baseline, A-39 collapsed-heading node keys, editable-empty windows (D-F3), and an empty-root cache (Lexical #38). [d44s; axb3]
5. **The owner as referee.** In eras 1–3 the owner caught every major visible defect; later eras still needed them to catch the RW-1 violation and the WWGD failure.
6. **Infrastructure deaths booked as product verdicts,** and the reverse. Quota, Rosetta Node, D1 overload, Cloudflare 500 pages, and daemon restarts were all misread at some point. [d44s-b; bmrs]
7. **Process accretion.** The rubric, ledgers, case law, declaration audits, versioned e2e copies, and watchdogs were all overhead. The product repo ended at 2.8M doc lines across 9,296 files. [latest-code]
8. **Lost durability.** Unpushed work, evidence kept in `/tmp`, and reusable loop assets kept in `/tmp` and wiped. [yzzh; qb6q s2060]

---

## 4. Technical learnings by subsystem

Each bullet reads finding → recommendation.

### 4.1 Porting moss's UI

- **The electronAPI shim works, with one big caveat.** Moss's renderer has no Electron imports at module load; everything goes through an optional `window.electronAPI` global, and Ladle's `app--default` story runs the real App on a mock bridge. A REST-backed shim (code:apps/web/src/moss/web-api.ts, about 2k lines, 18 namespaces) renders the real UI. But it carries over moss's single-writer file semantics (`notes.update` with content, disk-change events, hydration remounts). That caused the flash, keystroke drops, and race families. → Adapt at the note-content boundary: for any open doc, the Y.Doc is the only content source. Remove moss's disk-hydration and remount paths for bound docs rather than adding gates around them. [n2ii s2809; latest-code]
- **The ~30s whole-page flash.** CanvasAreaContent's init effect, keyed on `note.updatedAt`, re-fetched `notes.getById`. Server markdown lags the live tree, so `bodyChangedSincePreviousDiskContent` fired `remountEditorPreservingScroll('disk_content_changed')` every time. A double-connecting provider made it worse. A first "fix" (image cache-control) only addressed an amplifier. → Freeze `updatedAt` while bound (`stableUpdatedAt`) and use `connect:false` plus a single explicit connect. Gate: one WebSocket per doc held open for 60s+ with no editor remount. [n2ii-b s39566–41733; E2E-METHOD]
- **Remounts mid-typing.** In a warm workspace, moss's MathCalculationPlugin read every note's markdown, which starved Chromium's 6 connections per host (create took 748–1049ms; content reads queued 34 deep). The active note's late read looked like `disk_content_changed` and remounted the editor, dropping about one in three warm typing attempts. → Never re-key or remount a live-bound editor because of a REST response. Bound the background harvest (to about 3) or index server-side. [e2na s4523; code:workspace-formula-fanout.ts]
- **Global CSS must be imported in the root route** (`__root.tsx`). When imported inside a lazy component, production SSR emitted no `<link rel=stylesheet>` and the deployed app was unstyled, while dev-server gates stayed green. → Assert that every SSR page links a stylesheet and that the CSS asset returns 200 `text/css`. [n2ii s25653; B-22]
- **Tailwind and design-system traps.**
  - Content globs must cover every file that writes a `className`; the login card rendered full-bleed because one wasn't scanned.
  - The token-only theme never generates `text-white`; use per-fill ink with contrast ≥4.5:1.
  - The DS input's default border is transparent, which made fields invisible.
  - Base UI `Menu.Item` with `nativeButton:false` made Enter and Space inert on every DS dropdown.
  - A dropdown inside a dialog painted behind it because both used z-50.
  - A byte-copied moss rule (`.moss-checklist-item { margin-bottom: 0.125em }`) lost to a Tailwind `mb-1` utility in the port's build; compare computed styles on both surfaces.
  - The notification card used a 40%-opaque fill that relied on `backdrop-filter`, which WebKit lacked, so note text showed through.
  → Vendor moss's DS components and tokens wholesale at the pin rather than porting class by class. Raw color literals are forbidden: use moss token families (surface, ink, accent, border, highlight), with dark via `[data-theme=dark]`, and bundle the same font packages moss imports.
  [bmrs s7086, s9957; latest-docs-ops; d44s s10846; b0 brief B0-T1; design-system/tokens.md]
- **`hasElectronBridge` is true in the web build**, because the shim installs `window.electronAPI`, so native-only items rendered enabled. → Keep an explicit web-affordances registry (id, render site, reason) with a test that fails on drift. [deviations]
- **Host UI found missing late.**
  - Role grant.
  - Suggest mode for a solo owner.
  - The first named checkpoint from the empty History state.
  - Media → From computer (`images.pick` returned `[]`).
  - Settings → Agents key minting.
  - The notifications bell.
  - Vault creation.
  - Real routes (notes were addressed as `/?initialNoteId=&share=`).
  - Platform methods stubbed to `ensure → null` (`htmlPreview`, `webEmbedPreview`, `videoThumbnail`), so HTML blocks, web embeds, and video never rendered previews while "inserts" checks passed; `images.save`, `persistUrl`, and `copyFromPath` threw.
  → Inventory every web-only host UI need from the feature list at M0, list every platform-interface method the web shim stubs as an explicit check, and use real URL routes for docs and share links. [n2ii-b s29117, s35424; latest-code]
- **Upstream moss drift.** Between 6a68c88f and 26df579d5 (3 weeks, 72 commits, 447 files, 3 releases) moss changed:
  - A theme re-tint (light paper #FFFFFF, panel #F7F6F3, sidebar #F0EFEC, border #D8D5CE; dark paper #1A1A1B, sidebar #141415).
  - Variable Inter (`@fontsource-variable/inter`) and a JetBrains Mono Variable chart font.
  - Token renames (for example `surface-comment-chrome` → `surface-comment-draft`, plus a new `surface-floating`).
  - A mention contract of `U+2063 @Title U+2062 id U+2064`, where id wins.
  - The formula schema dropping `format` and `name`.
  - WebEmbedNode becoming a block preview card.
  - `tabWidths` moving into a layout sidecar.
  - ColorCode labels removed, and a Tooltip collision-boundary API.
  - The desktop comment-sidecar merge adding synthetic `merge-<hash>` replies.
  - A desktop loopback media server built only for HTTP Range requests, which the web gets for free.
  The port ended with mixed pins (252 renderer files at 6a68c88f, 89 DS files at 26df579d) and a drift-check script pointing at a path that no longer existed. → Use one pin, put a `ported-from: <path> @ <sha>` header on every file, keep modifications minimal so re-pinning is a mechanical re-copy plus diff, and re-audit at each milestone. [UPSTREAM-IMPACT; latest-code]
- **DOM facts for drivers.**
  - The title is a separate contenteditable (`div.text-h1`, the first `[role=textbox]`, placeholder "What if…"). The body is `[data-lexical-editor="true"]`.
  - `[contenteditable=true].first()` types into the title and produced false "sync broken" results.
  - Moss focuses the title with a 150ms `setTimeout` whose own comment reads "Race… TODO".
  - A new note's title contains the literal text "Untitled" rather than placeholder styling.
  [n2ii-b s41488; e2na s8190; axb3 s10414]
- **Layout.** A `max-w` cap plus side panels without `shrink-0` squeezed the editor to about one character per line. → Side panels `shrink-0`, the editor `flex-1 min-w-0`, centered at moss's 850px prose width, with no app background bleeding through. [4biv s24676]
- **Stale chunks after a redeploy** produced "Something went wrong". → Add a ChunkReloadBoundary that hard-reloads once on a dynamic-import failure. If the error appears on a fresh load, it is a different bug. [n2ii-b s27996]
- **Prism.** `@lexical/code` and moss code paths reference a global `Prism` when modules evaluate. A shift in the chunk graph made ImageLightbox evaluate before `prism-setup`, and the whole deployed app crashed. → Install Prism at the very top of `client.tsx`, also in workerd (`prism-globals.ts`), and declare `prismjs` as a dependency. Moss's Ladle needs a Prism import in `.ladle/components.tsx` too. [n2ii-b s33113–33246]
- **Phone shell mechanics.** At 390px the notes panel kept 265px, leaving the note 124px wide (0px title, one letter per line). The chrome row (`flex shrink-0`) clipped "Sign in to do more". The share dialog clamped to a 104px pane. An opaque fixed invite notice covered the note at 390px so keystrokes hit the notice, and its `z-[60]`, chosen against one neighbor, painted over DS menus (z-50). → Overlay the panel below 640px. Use an explicit yield order in the chrome row. Apply the pane clamp only above a 320px floor. Give ambient notices a reserved band and a z-index (`z-app-notice` 35) below deliberately opened surfaces, and derive z-index rules from the DS primitives in tests. Hit-test occlusion with `elementFromPoint`. [bmrs s9408–9741; e2na s5882; latest-docs-ops B1-T5-fix1]
- **Floating toolbar.** The toolbar is `SelectionToolbarShell` in MarkdownEditor (`pointer-events-none fixed bottom-6 z-50` when nothing is selected; repositioned near the selection rect otherwise; `data-floating-selection-toolbar`). Lexical keeps its range selection across blur, so a selection-driven toolbar never hides. → Track editor focus as well as selection. [d44s s20061; deviations]

### 4.2 Lexical

- **Version.** Pin Lexical to exactly the version moss uses at the port pin (moss 26df579d5 uses `^0.48.0`). The last build forced 0.45.0 through pnpm overrides, undocumented, which forked the renderer. Pin single versions of `lexical` and all `@lexical/*` packages through overrides, then re-derive any patches against that version. [latest-code]
- **Error #343, the 100-update cascade guard.** It trips under concurrent typing. Two causes: `@lexical/yjs` (SyncEditorStates.ts ~134–174) schedules an untagged `$ensureEditorNotEmpty()` after every remote fold even when the root is populated, and `@lexical/markdown`'s shortcut listener enqueues untagged follow-ups. In 0.45 prod builds the watchdog silently drops queued updates, which is data loss. → Patch it to schedule only when the root is empty, tag or latch the markdown cascade, keep any watchdog warn-only, and add a two-tab cascade stress test. Re-check whether 0.48 still needs this. [r5cv s3322/3756; n2ii s5285]
- **Error #38, empty editor state.** Pre-bind neutralization cleared the root, a `requestAnimationFrame` editor-state cache serialized the empty root, and reopening threw before the provider mounted. Restore-from-trash and split view hit the same error number with different causes: restore replayed a cached empty state, while split view collided because one app-wide `BindingProvider` received `publishBinding` from both panes' CollabBindingPlugins (see §4.3). → Never cache or restore a zero-child serialized state. Capture the Lexical error number, the component stack, and `wrangler tail` output before patching. [axb3 s1791; n2ii-b s32952]
- **Lexical node keys are not stable across clients** → use Yjs RelativePositions for every anchor. [SPEC §4]
- **One throwing decorator** (`onError: throw` plus Lexical's re-throwing boundary) unmounted the whole editor. → Wrap each decorator in its own error boundary, with placeholders for missing images. [4biv s26637; A-42]
- **Name collisions with built-in fields.** Custom-node local state stored in a Lexical built-in field name (FormulaNode `__format` vs ParagraphNode/TextNode `__format`) collided on the wire. → Never reuse built-in property names for custom state. [latest-code]
- **Small facts.** The update `tag` option is an array. SlashCommandPlugin deletes the trigger and executes the command in two separate updates. A pointer click into an empty Lexical body does not focus it. [4biv s5227; axb3; latest-docs-ops]
- **Headless Lexical inside a Durable Object is viable** (spike). It adds 245,691 bytes gzipped and roughly 70–84ms of cold start. A 1.9 MiB markdown import takes about 90ms of CPU and an export about 80ms; a 100 KiB push merge takes 37–60ms; all of this is against a 30,000ms limit. The server cannot import moss's React decorator nodes, so DOM-free "server twin" nodes with the same `getType()` and JSON drifted. → Split each moss node class from its React decorator component so client and server share a single transformer set. Keep a desktop-vs-server parity test in CI as a drift alarm. [spikes/lexical-in-do.md; n2ii s17859]

### 4.3 @lexical/yjs binding and y-partyserver

- **The binding.** The project used a custom CollabBindingPlugin built on `createBinding`, `syncLexicalUpdateToYjs`, and `syncYjsChangesToLexical`, observing `observeDeep` on the root. It skips origins equal to the binding, `DERIVED_ORIGIN`, and `CONTEXT_MARK_ORIGIN`, and skips `SKIP_COLLAB_TAG`. Two early bugs: `observeDeep` sees only future changes, so a non-empty doc opened empty; and `shouldBootstrap` queued an empty paragraph before provider sync, which shadowed the remote content. → The server seeds an empty paragraph on first load (origin `server-seed`), clients use `shouldBootstrap:false`, and the editor renders only after the first sync. Reconcile existing Yjs state on every sync. Test against a pre-populated Y.Doc and an asynchronous provider whose sync arrives late. [4biv s25271/25885; code:CollabBindingPlugin.tsx]
- **`HISTORIC_TAG` drops edits silently.** `syncLexicalUpdateToYjs` returns early on `HISTORIC_TAG` before diffing, so any user edit coalesced into a historic-tagged update never replicates. This happened 4 times: context-mark cleanup, markdown cascade, a Tabs click bubbling into `clearContextMark`, and marks made "non-undoable". → Never use historic tags for undo exclusion. Use a dedicated origin (for example `CONTEXT_MARK_ORIGIN`) excluded from the UndoManager's `trackedOrigins`, and run an empty discrete update first to flush pending user content. [axb3 s4896–6107]
- **Per-viewer fields must stay off the wire:** tab-group `__activeIndex`, table `__colWidths`, formula `__result`, `__stale`, `__name`, `__format`. Excluding by `node.constructor` failed under module duplication and runtime subclasses, and Lexical's own `__format` replicated anyway. → Use a type-aware `excludedProperties` (`getType()` lookup; the build throws on an unregistered type). If `__format` is unavoidable, alias it to `__nodeFormat` on the wire. Test by scanning real doc-party WebSocket frames for forbidden keys, with a positive control. [code:excluded-properties.ts; patches/@lexical__yjs@0.45.0.patch; axb3 s5664]
- **Undo.** A 300ms `captureTimeout` split one typing burst into several undo items under renderer stalls. The command palette's empty prompt editor stole Meta+Z. Undo was silently dead from M2 onward because `readOnly` was captured from `isEditable()` at mount. → Use `captureTimeout` of 1000ms and `trackedOrigins` containing the local binding only. Mark derived writes `DERIVED_ORIGIN`. Derive `readOnly` from the role, not from mount-time editability. Route Meta+Z from an empty prompt to the note's `UNDO_COMMAND`. [axb3 s3696/8335; n2ii s12753]
- **Remote cursors never rendered.** `binding.cursorsContainer` was never assigned, nothing listened to awareness, and `syncCursorPositionsFn` was not passed as the fifth argument. → Assign a pointer-transparent overlay as a sibling of the editor root. Run a coalesced microtask sync on awareness change, doc update, and resize. Read identity from the awareness `user` field. Destroy the overlay before tearing down the provider. Wire this in the main binding effect. [axb3 s9429; code:remote-cursors.ts]
- **Compound decorator props.** Last-writer-wins on compound decorator props loses concurrent edits. → Keep per-decorator Y.Map registers, exclude register-owned fields from the binding, and include the register in the undo scope. Derived formula state never rides the wire: clients recompute locally and the server recomputes when composing markdown (C-03). [4biv s4806/22611; d44s s42719]
- **Local-only tree mutations desync the binding.** Comment MarkNodes painted under `SKIP_COLLAB_TAG` split text nodes, leaving one CollabTextNode against three Lexical nodes. Every later keystroke in that tab was then silently dropped (B24). → Never mutate the synced tree locally. Either feed `@lexical/yjs` a mark-stripped projection (design C2: also project the caret, and replicate Lexical's merge predicates) or keep comment data in the CRDT and paint as derived view state. [n2ii s22878–23212]
- **Derived-origin fold-back.** `DERIVED_ORIGIN` transactions folding back through the binding made a table's "Insert row" add 2 rows. → The binding must skip its own derived-origin transactions on the way back. [n2ii-b s41965]
- **Split view.** `MossAppHost` wrapped the whole app in one `BindingProvider`; `SplitPaneContainer` mounts two `CanvasAreaContent` panes whose CollabBindingPlugins both published into it, crashing with Lexical #38. → Scope the binding context, and the comment and suggestion bridges, per editor instance. [n2ii-b s30971–31018]
- **Custom binding vs the official plugin.** The custom CollabBindingPlugin (built for per-origin undo, skip-collab marks, and the mark-stripped projection) dropped the official `CollaborationPlugin`'s initial reconcile, bootstrap ordering, and remote cursors, each of which then shipped as a bug. Two lineage threads recommended starting from the official plugin and extending it; this is open (§8). [4biv open questions; n2ii-b s37475–37541]
- **The binding lifecycle spans a sequence of Y.Docs.** One doc id owns a series of Y.Doc instances (hydration swap, retry, fallback rebind). A one-shot `onCollabBound` latch either fired against a torn-down doc or stayed on the first generation. → Track boundness per instance with a durable subscription that fires on every transition. Expose `data-title-binding=live|none`. Test with a warm creator, a cold peer, and a mid-session remount. [axb3 s10480]
- **y-partyserver 2.2.0 gotchas** [patches/y-partyserver@2.2.0.patch; code:collab-provider-hardening.ts, channel-heartbeat.ts]:
  - It registers `window` `unload`, which Chrome logs as a permissions-policy violation. → Patch it to `pagehide` in both the ESM and CJS builds.
  - It has no message-timeout sweep, so half-open sockets look connected forever and the offline banner lied. → Use a 4s `resyncInterval` as a heartbeat, watch `wsLastMessageReceived`, and close with 4408 after 12s of silence.
  - It broadcasts awareness on `change`, so renewals with an identical payload never send. → Rewire to `update`, with an origin filter so two tabs don't echo.
  - It clears Awareness `_checkInterval`, disabling the 30s outdated-peer sweep. → Run a client sweep (below).
  - `disconnect()` closes without a code. → Close with 1000.
  - It ignores string frames that lack the `__YPS:` prefix, so a server's "write-refused" message reached no listener. → Wrap every custom server message in the envelope and test that a real browser receives it.
  - The provider auto-connects by default. → Pass `connect:false` and make exactly one explicit connect, otherwise there are two sockets per doc.
- **Version pins.** yjs 13.6.31 as a single version via overrides (including `@lexical/yjs>yjs`), y-protocols 1.0.7, y-partyserver 2.2.0, partyserver 0.5.8. [pnpm-lock]

### 4.4 Title and frontmatter

- **The doc_meta split was a bug family.**
  - The per-doc broadcast reached only windows that had that doc open, so the sidebar went stale.
  - `notes.create` emitted no invalidation.
  - A focused observer parked remote renames until blur.
  - A rename typed within about 1s of creation never reached REST.
  - A hydrate echo of "Untitled" wiped a just-typed title.
  - A content-save lane derived the title from the serialized H1, a second writer.
  → "A reconciliation gate is a smell that the architecture has two writers." [axb3 s9583, s10246]
- **The CRDT title pattern (RW-1)** [code:packages/core/src/title-crdt.ts, frontmatter-crdt.ts]:
  - `Y.Text('title')` beside `root`.
  - Minimal character-diff writes (`diffTextToOps`); never delete-all plus insert-all.
  - A caret remap keeps the local caret on its character when remote edits land.
  - The DO is the single writer of the D1 `docs.title` projection: throttled to 750ms, with a trailing flush, serialized on one chain, never clearing the column.
  - The DO seeds the title once from D1 in `onLoad`.
  - A REST rename is a request for a CRDT write (`/admin/title`, 503 on failure).
  - Trim only at the serialization boundary.
  - Interleaved concurrent renames merge, and neither side is lost.
- **Never seed a placeholder ("Untitled") as authored CRDT text,** and never let a binding go live before the first sync. Both caused title concatenation (e.g. "ULU recon writersUntitled"), which had four separate causes. [TITLE-CREATE-CONCAT; bmrs s2926]
- **Title-input failure modes**, which took five fix trains on 09-02 and never closed:
  - Keystrokes landed in the previous note's still-bound title during the switch (observed 22ms before unmount). → Gate on binding identity, not liveness.
  - Paste, drop, and IME into an unbound title were silently discarded after keydown was blocked.
  - Binds took up to 2,700ms on a warm stack, and the median moved from 91ms to 337ms with stack warmth alone.
  - On WebKit, a bare Backspace with no editable focus navigated history.
  - The last fix (fix2) kept the unbound title focusable with WebKit nav-key capture plus an on-screen refusal notice, even though the owner had just said "we just would not allow the focus"; its brief was never re-scoped. Its checker died before a verdict but had already found the 2,400ms refusal-notice clock was shorter than natural binds of up to 2,700ms.
  Glyphdown avoids the whole class: creation is name-first (an inline file-tree `<input autoFocus>` holds a local draft, and commit calls `createDocIn(name, folderId)`), and the doc-page title goes skeleton (`aria-hidden`), then a `<button>`, then a discrete rename `<input>`. → Never render a focusable title before its doc exists and is bound. Make sure focus is in a real input during creation, so Backspace is consumed. If any not-yet-bound field remains, close beforeinput, paste, drop, and composition at one chokepoint. [e2na s3941, s7309, s8024, s8190, s8854, s8880, s9055; 2yq6 s384]
- **Metadata for docs that aren't open.** The final build polled `/api/docs` plus `/api/folders` as a workspace digest every 2.5s and touched `docs.updated_at` on live edits (throttled to 5s), with `displayUpdatedAt` separated from the hydration key. Routing that refresh through moss's disk-change channel re-imported markdown over the live Yjs tree, so it had to fire the metadata channel only. → Prefer a workspace-level push channel (a per-user or per-vault DO) over polling. [TITLE-META-SYNC]
- **Frontmatter** is `Y.Text('frontmatter')`; the sidecar write path was deleted. Markdown export composes `frontmatter\n\n# Title\n\nbody` and import strips it. Stale comments in code still claimed the tree was body-only, so delete stale comments. CLI pull includes frontmatter, and moss renders its Properties header from it (J-06: the header never rendered in the demo notes). [D27; code:router.ts:577 vs frontmatter-crdt.ts]

### 4.5 Presence

- **Ghost peers.** A ghost "B" appeared because awareness state was never removed on disconnect and the double socket left stale peers. → On teardown and `pagehide`, call `setLocalState(null)` and `removeAwarenessStates`. [n2ii-b s35790; POLISH-FIXES #2]
- **The DO's in-memory awareness map comes back empty after eviction or hibernation** while sockets survive. Identity was announced once per connection, so a newcomer saw nobody until someone typed. This reproduced only on WARM stacks (around 80s idle). → Republish identity every 4s, preserving anchor and focus; pause while hidden and re-announce when the tab becomes visible. Sweep every 2s, removing remote states older than 12s via `removeAwarenessStates`. Peers clear 8–14s after a hard sever. Always include a "peer joins after idle/hibernation" leg. [PRESENCE-LIFECYCLE; code:presence.ts]
- **Colors.** `FNV(principalId) % 10` collides. Ranking the whole roster fixes collisions but recolors incumbents on join and leave (blue→purple→blue). `localeCompare` depends on locale. → Each client claims a color from a 10-color palette and publishes it in awareness with a `colorSettled` bit; a provisional claim loses to a settled one; ties go by UTF-16 `<` rank; the claim is remembered for the session; one color per principal across tabs; chip and caret read through the same getter; hidden tabs don't re-claim. [COLOR-STABILITY; axb3 s10384]
- **Presence de-duplicates by account,** so a "two collaborators" test that used one account measured one collaborator. Two contexts sharing a browser profile are the same identity. → Gates must refuse to run with fewer than N+1 distinct principals. [bmrs s9741]
- **Contrast.** Chip initials measured 2–3.7:1. → Choose initial ink per fill, at ≥4.5:1. [PRESENCE-CHIP-INITIALS-CONTRAST]

### 4.6 Connection truth, offline, terminal states

- **`navigator.onLine` and DevTools offline emulation do not sever an established WebSocket,** so the banner lied. → The banner is visible exactly when the sync channel is not delivering (heartbeat lost or socket error), and it is a DS banner primitive with a story. [CONNECTION-TRUTH]
- **First-connect fallback.** A 4s first-sync watchdog shows a read-only preview of the seed with a retrying rebind (I-21). The fallback editor collapsed when retries fired mid-typing (0 of 40 characters survived). → Lock the fallback at the first local edit, probe through a detached Y.Doc, offer a reopen, and never merge fallback text into the live doc. PRODUCT only requires buffering across short blips, which a bound Yjs doc already provides, so keep the fallback small. [C-18 MECHANISM; code:WebCollabPlugins.tsx]
- **Close codes worth keeping:** 1000 superseded socket, 4402 session ended, 4403 access revoked or suggest policy (re-validated over REST before being treated as terminal), 4408 heartbeat timeout, 4410 doc deleted, 4429 connection limit. [protocol/messages.ts]
- **4410 must be terminal across the whole doc.** At first it only locked the Lexical body while the title kept accepting keystrokes that were discarded. → Use a doc-level terminal store (`useSyncExternalStore`) that every editable affordance subscribes to, and disable reconnect intent synchronously. Tests sweep every editable surface by attribute. [axb3 s9256–9284]
- **Editable-empty clobber (D-F3, data loss).** The watchdog cycle gated `setEditable` on `!syncStalled`, which flipped back at rebind after the root had been cleared. Typing in that editable-empty window autosaved through `POST /push` with the empty tree as truth, and the server's undrifted-merge fast path accepted the wipe. → Gate `setEditable` on first sync for every bind, including the suggest-policy hard resync. Never push a neutralized or pending tree, and the server must never accept a whole-doc wipe through a fast path. [d44s s33373, s33845]
- **Slow invitee open and the D-F3 ordering bug.** Clearing the root was chained behind a trashed-check that could resolve before role resolution, leaving the invitee with a cleared root and no provider (a blank body). The open path also ran about five sequential workspace fetches before creating the provider (29–57s under load). → Create the provider independently of role, trash, and metadata fetches: neutralize the REST seed, mount the provider, and let role resolution govern only editability and undo. Use one collab gate (role plus trash) per doc, dedupe in-flight workspace loads, and start the first-sync deadline at neutralization. Open time fell from 57,360ms to 56.8ms. [r5cv s3612, s4456; C-01 MECHANISM-INVITEE-OPEN]
- **One terminal "doc gone" signal.** After a trash, clients kept POSTing `/yupdate` and getting 401 from trash-view sockets, the WebKit-only `pagehide` beacon (Chromium hides it as ERR_ABORTED), in-flight updates, members' beacons, and beacons after sign-out. The `doc-deleted` message branch was dead code (nothing sent it). The formula plugin's cross-note scan re-read every note on remount (17 reads at trash+167ms). A refused handshake reconnected on a doubling ladder forever with no message, and the durability ack started ahead of the DELETE. → Close the doc to writes and await in-flight acks before the destructive request; re-decide after every await; never retry a designed 4xx; filter trashed ids from socket watch targets; push revocation and trash notices over the socket before or with access withdrawal; reconcile selection whenever hydration removes notes; census both engines and repeat the run 5×. [bmrs s4729, s5166, s10003, s11015; e2na s2203, s3013; B0-TRASH-YUPDATE-401]
- **Navigation mid-typing.** An invite notice awaited `POST /api/notifications/read` before `location.assign`, so under load the page was replaced mid-sentence; rail clicks and Vite `vite:preloadError` chunk reloads did the same. `location.assign`, `replace`, and `reload` are `[LegacyUnforgeable]` own properties, so wrapping `Location.prototype` silently fails. → One module owns every programmatic navigation and synchronously commits a refused/read-only input state before calling it (fix1 painted 4ms too late and a keystroke died). Send mark-read with `keepalive`. Handle `vite:preloadError` deliberately. Instrument with a capture-phase click log, not location wraps. [e2na s5268–5492; B1-MEMBER-WINDOW-RENAVIGATES-MID-SENTENCE]
- **Background work after sign-out.** The 10s invite poll kept polling after sign-out because the sign-out was never recorded in its own window and the stop waited for the page replacement a round trip later. → Stop polling and subscriptions synchronously on the sign-out gesture, from a single auth-state writer. [e2na s6923–7223]
- **Notification-socket churn.** The "WebSocket is closed before the connection is established" warning came from DocDO notification sockets (`/api/doc/:id/ws`) opened by prefetch/create and the App watch-target effect during boot re-renders, then closed mid-handshake, not from the collab provider. → Open notification sockets only from the settled active watch-target set, and keep the notification socket and the doc-party socket distinct in code and tests. [axb3 s1174, s3172]
- **Durability honesty (C-12).** "Link copied" vouched for bytes that had not landed. → Keep a registry of acknowledged state (the last verified-acked state vector) and never vouch while the live state differs from it. [d44s s44238]
- **Graceful degradation.** A transient D1 session-lookup failure bounced signed-in users to `/login` with a 307. → Retry, or show a degraded state; render error surfaces for failed fetches. [yzzh s7610]

### 4.7 Worker routing and Durable Objects

- **Routing.** Route order: `/api/version`, then `/api/dev-auth`, then `/api/auth/*` (better-auth constructed per request, because D1 bindings are per invocation), then `/api/*`, then `/parties/*` (only party `doc-d-o`, room = docId; SearchDO and HtmlDocDO return 404 publicly), then TanStack SSR. The Worker authenticates, strips client-supplied `x-moss-*` headers, and forwards trusted headers (`x-moss-principal`, `x-moss-role`, `x-moss-session`, `x-moss-share`). [code:apps/web/src/server.ts]
- **The WebSocket upgrade trap.** In era 1, rebuilding the request with `new Request(request, {headers})` dropped the upgrade and `Sec-WebSocket-*` headers, so collab returned 404 through the SSR fallthrough. The fix was to clone without an init, then add headers. The final code's form preserved them. → Test the real WebSocket upgrade path through workerd at M0. [4biv s23324; latest-code]
- **Persistence.** `DocDO extends YServer` with `hibernate:true`. `onLoad` applies the compacted state chunks plus every `yupdates` row under `PERSISTENCE_ORIGIN`. Each `doc.on('update')` INSERTs a row immediately. Compaction runs above 500 rows or 1 MB by replaying into a fresh Y.Doc, which preserves item identity. Compacted state is chunked at 1.5 MB because DO SQLite caps rows at 2 MB. [code:packages/sync/src/do.ts:718–800]
- **Hibernation restore.** After eviction, `/content` read a compaction cache while the WebSocket served an empty `this.document`, so cold docs opened empty. → Use one source of truth, restore from the update log before serving sync, and gate on push → compact → simulated cold restart → reopen showing content. [4biv s26893; D9]
- **Revocation after wake.** After a DO wake the revocation cache is empty. The code started the D1 lookup asynchronously and synchronously merged the frame, so a revoked link's edit landed before the 4403. → Treat an empty cache as "unknown". Hold unproven frames in a per-socket FIFO until the authority answers, with a deadline, failing closed on DB error. Don't revalidate every frame against D1. Test with a heartbeat-free client against an evicted DO, using a warm-vs-cold one-variable differential. [bmrs s9697–9914]
- **Per-frame gate order in `handleMessage`.** Session ended (4402), then grant or share revoked (4403), then grant proof after wake, then the frame type. Viewer and commenter content frames are refused with a unicast `__YPS:`-wrapped write-refused message. A per-connection rate limit runs before the O(doc) size-cap simulation. The 2 MB cap applies per frame and also after a `/push` merge, which could otherwise bypass it. [code:do.ts:1279–1560; 4biv s13673]
- **Storage leaks.** Soft delete never calls `ctx.storage.deleteAll()`, so every DocDO's tree and versions persist forever. Test churn created a DocDO per note and exhausted the free plan (100k requests/day, 200k observability events/day). → Reuse one persistent doc per test, budget request volume, run on Workers Paid (upgraded, about $5/month), and decide on purging explicitly. [d44s s13221–13589]
- **DO storage is bound to the worker name.** Renaming the worker loses data. [SPEC §8]
- **Testing.** Unit-testing the real DocDO class in Node (a `node:sqlite` SqlStorage shim, in-memory R2, a stubbed `cloudflare:workers`) is fine for speed. Hibernation, eviction, and WebSocket upgrades still need real-workerd legs. [code:packages/sync/test/do-harness.ts]

### 4.8 D1

- **Schema shape** (reusable) [code:apps/web/src/db/schema.ts]:
  - better-auth tables: `user`, `session`, `account`, `verification`, `device_code`.
  - `folders` with `kind` folder|vault, where `parent_id` is NULL exactly for vaults; vault names are unique per owner, case-insensitive.
  - `docs` with a canonical `filename` (`<slug>.md`, unique per folder among live docs) and `deleted_at`.
  - `doc_members`, `folder_members`, `vault_members`. The owner is never stored; ownership derives from `owner_user_id`.
  - `share_links`, `live_collab_sockets`.
  - `assets`, `content_objects` (addressed by sha256 and refcounted), `asset_versions`.
  - `invites`, `notifications`, `user_prefs`, `feedback`, `agents`.
- **Schema and migrations drifted.** drizzle `schema.ts` declared an `asset_versions.asset_id` cascade that the SQL migration lacked, so asset delete returned 500 and half-deleted assets while in-memory tests stayed green. → Add a test that every `references(...onDelete)` appears in migration DDL, and test against real D1. [B1T6FIX1-ASSET-DELETE-500]
- **Timestamp units.** The server sent milliseconds; moss expects seconds. Every time read "Just now", and trash read "deleted in 20,627,603 days". → Convert at the bridge boundary. [d44s D-I7]
- **Retention copy.** The 30-day constant was duplicated in two places, both flooring ("29 more days"), and some surfaces sampled the clock into state ("31 more days"). A 27-surface census of the rendered app also missed the CLI `rm` prose and its JSON action field, and the bulk `DELETE /api/vaults/:id`. → One shared protocol constant computed at render, and enumerate surfaces from source (every caller of the delete route and every writer of `deleted_at`) as a build-property test proven able to fail. [bmrs s10235, s10342, s10470]
- **D1 under load.** Two lanes plus probes produced error 7429 (overloaded), Worker 1101, edge 500s, a fake "No checkpoints", and the owner's own Chrome bounced to `/login`. Staging tolerated about one 5-worker lane. [POSTMORTEM-RECOVERY §2]
- **Cleanup.** D1 enforces foreign keys. Use `PRAGMA defer_foreign_keys=ON` and delete the referencing rows in one batch. [n2ii-b s44585]

### 4.9 Auth (better-auth 1.6.23 + drizzle on D1)

- **`createAuth(env)` per request.** Fail closed (SEC-4) when `DEV_AUTH=1` on a non-loopback `BETTER_AUTH_URL`, or when `BETTER_AUTH_SECRET` is missing, is the placeholder, or is shorter than 32 characters. [code:apps/web/src/auth.ts]
- **Register a social provider only when both its id and secret exist.** Empty credentials made `/sign-in/social` return 500 on staging. Always render the email/password form, and smoke-test the real login click on the deployed build. [n2ii-b s26719–26928]
- **Settings.** Minimum password 8 in dev, 12 in prod. `requireEmailVerification` off (no email provider). A `user.create.before` hook for any allowlist; an after-hook that creates a "Home" vault. Plugins: `deviceAuthorization` (client `moss-collab-cli`) and `bearer`. `gd_sk_` keys stored as SHA-256. [code:auth.ts]
- **Sign-out** must POST `content-type: application/json` with body `{}`, otherwise 415, which once left nobody actually signed out while the UI looked fine. Sign-out must also sever every socket for that session server-side, through a `live_collab_sockets` registry and `/admin/session-ended` (4402), not only in the local window. [bmrs s7086/7220]
- **better-auth quirks.** It returns 403 `MISSING_OR_NULL_ORIGIN` to a Node `fetch` with no Origin, which makes allowlist assertions pass falsely; stamp a same-origin Origin header. Signing up an existing email returns 200 with a fabricated id and no insert (anti-enumeration). Session tokens are stored in plaintext. [E2E-METHOD; d44s s52938]
- **The DEV_AUTH playground gate is four conjunctive conditions:** `DEV_AUTH=1`, a loopback request origin, a loopback or absent `BETTER_AUTH_URL`, and no `SIGNUP_ALLOWED_EMAILS`. Otherwise both verbs return 404.
  - The client mints `dev-<uuid8>@example.invalid` once per browser profile in localStorage.
  - Shared-workspace mode grants editor (never owner) through decorators over `MemberGrants`, `AccessibleDocsSource`, and `FolderStore` that only raise roles, via the MAX fold.
  - It proves nothing about auth or sharing.
  - Bootstrap endpoints should answer 2xx on the expected path to avoid console errors from handled 401s.
  [x4g2 s953/1544; deviations]
- **The device page.** The Approve button was near-white on cream (about 1.10:1) on a page granting full account access, and the code is not claimed on GET (RFC 8628 semantics). → Use moss button tokens. Test claim-on-GET, approval by a different principal, deny-then-approve replay, and multiple sessions from one code. [d44s-b D-G3/D-G4]

### 4.10 Sharing and roles

- **Share tokens on WebSockets.** A browser WebSocket cannot set headers, so the share token rides the query string (`?share=`). The DO read only the header and recorded `shareToken: null`. The client also dropped the token from doc reads (`__root.tsx:65` let any `?share` through; `boot.tsx:37` and `api.ts:52` dropped it), so valid links rendered an empty shell identical to a bogus one (D-G1, which blocked about 6 rows). → Thread the token through every doc, asset, metadata, list, and socket path. Render a distinct denial surface. Gate on share-link viewing early. Related open defects at the legacy freeze: no anyone-with-link toggle (G-09), pending invites with no copyable URL whose redemption 404'd (G-10), silent revoke (G-22), and CLI share URLs opening an empty workspace (H-10). [e2na/bmrs s9563; d44s-b; RUBRIC-SKIM G/H]
- **Owner reads of trashed docs.** The comments, versions, and suggestions GET routes 401'd the owner on a trashed doc while `GET /content` had an owner fallback. → Give every owner GET the same trashed-doc read path and keep mutations strict. [d44s I-14]
- **Anonymous links.** Share links required a login before the token check, so anonymous links returned 401. Editor links landed in an empty workspace because of a role-polarity bug: the link role was applied as a wall rather than a ceiling. → Treat the link role as a ceiling, capped by sign-in. Test viewer and editor links signed-out, signed-in without a grant, and signed-in with a grant. [bmrs s8108; e2na s4764]
- **Revocation fan-out** targeted `principalIds ['anonymous']`, wrong in both directions. → Fan out per actual connection grant, and route every revocation (member removal, role change, share link, agent key, sign-out) through one recheck/kick path. Member removal closes with 4403 within 153ms and demotion within 230ms; agent-key revocation left the socket up more than 15s (D-G7). [B1-T4; d44s-b]
- **One roles module** (`core/src/roles.ts`) serves both client affordances and server enforcement. The role rides each note row as an opaque `collabRole` from `DocMeta.role`, which is the MAX fold. There were two `resolveDocRole` implementations (`docs.ts` and `share-links.ts`); keep one. [deviations; latest-code]
- **Below editor, the editor must be truly read-only,** including decorator controls: checkbox and slash controls had mutated viewer and commenter tabs locally (G-15). The commenter composer must be gated on the comment capability. [RUBRIC-SKIM G-15; d44s-b]
- **Folders and the synthetic "Shared" group.** Other identities' docs grouped under a synthetic Notes/Shared group were treated as a real folder, giving "Unknown parent folder" errors and a bare red "Failed". A fallback rooted creates in an unowned vault, which is an access-control hole. → Never give synthetic groups mutation affordances, never fall back to an unowned vault, and render coded errors as sentences. Test from an empty workspace as a naive identity. [FOLDER-CREATE-WEB]
- **Folder delete promoted docs instead of trashing them,** and `electronAPI.folders` create and rename threw on web. → Delete soft-deletes the subtree, sends 4410 plus a search-index drop per doc, and re-homes docs so restore works. Audit the shim for stubs. [axb3 s9207]

### 4.11 Comments

- **Moss's model** stores inline `%%m:ID:start%%…%%m:ID:end%%` markers plus `comments.json`. The gutter, hover, and popover find comments only by walking `$getRoot()` for `instanceof MarkNode` and calling `getElementByKey`, so a DOM overlay is invisible to them. Moss has no reactions and no comments sidebar. Comments are created with Cmd+Shift+A, and the highlight is `rgb(251,242,224)`. [n2ii s9153–9175, s23403]
- **Markers leaked as visible text** (`%m:<id>:start%`). → Assert zero literal `%m:` text in the DOM and zero markers in exported `.md`. [DoD C7; D-25/D-26]
- **Anchors** use a wire contract of base64 Yjs RelativePositions plus a W3C text-quote fallback, with denial of empty bodies and very short anchors. Inline paint MarkNodes made the flat-text index emit a `\n` the Yjs mirror lacks, shifting anchors by one per preceding mark. → Mint anchors through a mark-transparent index. Carry over glyphdown's re-anchor thresholds (0.5, 0.8, 8 characters, 60%). The new piece is a mapper between plain-text offsets and tree positions. [d44s D-23; SPEC §4]
- **Timing bugs.** A nested `editor.update` inside a command handler is deferred, so the POST fired with `anchor:null`; submit in the update's `onUpdate`. Repaint must be driven by updates, deferred, bounded (with a retry cap), and resolved against the live tree. [n2ii s9944–10897]
- **Identity and UI defects.** Non-authors saw "Me" plus Edit and Delete; author identity must come from the server principal. The popover height cap is `min(64vh, 520px)`. The reply composer autofocuses. The "open" filter hiding resolved threads is moss's behavior, not a bug; but D-12 (the open filter hiding threads it should show) and D-04 (comment highlight color not derived from the moss source) were still open at the legacy freeze. [D-08/D-09; D-05/D-07; n2ii-b s30425; bundle comment-anchoring]
- **RW-2 (CRDT comments) was never designed.** The naive version (raw MarkNodes in the synced tree) was refuted because concurrent painters duplicated text ("WORDWORD"). → Hold a design review first: thread and anchor data as Y.Map plus RelativePositions, and paint derived deterministically in the binding's view. Make the gate "comment, then type anywhere; the peer and the Y.Doc text match", with two comments in one paragraph and bidirectional concurrent typing. [r5cv s1574; n2ii s22878]

### 4.12 Suggestions (the largest unsolved cluster)

- **Stale baseline** (SuggestModePlugin.tsx around lines 169–213). Activating suggest mode before the first sync snapshots an empty baseline, and the re-baseline branch can't be reached while the editor is read-only. The first suggested keystroke then paints the whole paragraph green, and a suggester's first selection-delete is a REAL deletion: data loss. → Take any baseline only after hydration and first sync; better, derive suggestions from CRDT deltas. [d44s E-04/E-05]
- **False 4403s.** The ingress gate re-diffed flat text (`diffTextToOps` trims prefixes and suffixes; then `containsPost`/`coversPre` checked positions literally), so ordinary typing that shares a prefix with adjacent text (typing "the " before "the …", duplicating a word, pasting a sentence before itself) got a false 4403 after a 2.5s grace period. Glyphdown vets the actual CRDT delta (`checkSuggesterDelta`, attributed by transaction origin): insertions are always acceptable; only deletes outside the suggester's own ranges, formatting, and non-text inserts are rejected. → Vet real Yjs deltas, and add a colliding-prefix regression leg. Caveat: glyphdown's apply-and-invert vetting works on Y.Text deltas; on the Lexical tree the deltas are `XmlText`/`XmlElement` events, so the approach must be adapted rather than ported, which is why era 2 fell back to dropping the frame and closing with 4403. [6mff s873; n2ii s13697–14285]
- **Other suggestion defects.**
  - Structural and attribute operations (checkbox toggle, table row insert) have no suggest path; define their semantics up front.
  - Withdraw leaves the inserted text.
  - The "N outdated" drift notice is dead code.
  - Suggesting inside a comment MarkNode is refused.
  - The smart-dash transform turns `--` into an em dash inside CriticMarkup (43 bytes in, 45 out).
  - A peer's Actions panel lists no suggestions (D-G2).
  - Editor-plus users can't withdraw.
  [RUBRIC-SKIM E; d44s-b]
- **Painting suggestion marks by mutating the tree froze the Y.Doc.** → Paint suggestion marks as a zero-mutation overlay. Era-2 reference colors (agent-chosen, never owner-ruled; re-check against the glyphdown oracle with moss styling): a moss-native soft green for inserts and a neutral/terracotta strike for deletes; the history diff used insert background `rgb(225,237,223)` and delete strike `rgb(198,123,92)`. [62jf s18031, s19363] A suggest-mode listener that rewrites content must skip remote and undo tags, because it once rewrote peers' edits into the local author's suggestions. [n2ii s11098; 4biv s17116]
- **DEF-1.** The server dropped a violating frame and closed with `4403 suggest-policy`, but the client kept its optimistic Y.Doc, reconnected about 15 times a minute, and left the rejected text on screen. → Send a unicast write-refused message before closing; the client hard-resyncs and discards local state. Never let a field accept input that cannot land. The `/yupdate` suggester gate works: an inert update returns 200, a mutating one 403. [deviations; d44s-b D-G5]

### 4.13 History

- **Restore.**
  - Restore through `parseEditorState` deleted and recreated nodes with fresh keys, orphaning concurrent peer inserts (F-14). → Restore with an identity-preserving, two-tier in-place reconcile. Store markdown (for display and diff) plus serialized Lexical JSON (for lossless restore), and restore through the same structural-merge primitive as push.
  - Restore is non-undoable and bracketed in history.
  - Preview and diff never mutate the live doc.
  - Responses carry an `x-moss-version` header.
  [d44s F-14; SPEC §4]
- **Remount on doc-meta echo.** The doc-meta echo after a restore remounted the editor and swallowed keystrokes for 1–2.5s (Lexical #66, D-F4). → A title-only meta change must never remount the editor. [d44s D-F4]
- **Shell parity.** Port moss's `TimelinePopoutModal` (448px wide; the candidate was 720×518) and `VersionHistoryEmptyState` exactly. Allow saving a first named checkpoint from the empty state; auto-snapshots fired only on last disconnect, which was a dead end. A failed versions fetch must render an error. Restore reordered checklist items (J-02). Versions and the search index fell back to XML `toString()`; always derive markdown with the shared exporter. Spill large version rows to R2. [RUBRIC-SKIM F; H-26]

### 4.14 Search

- **Snippets showed "[object Object]"** and backlinks were erased because the DO fed `Y.XmlText.toString()`. → Always feed markdown derived through the DO's exporter. Re-feed once on DO wake, and feed even on byte-identical pushes. FTS5 with bm25 works on workerd; port SearchDO as-is, with `[[wiki]]` backlinks and a LIKE fallback. [d44s I-01/I-04; n2ii s22307]

### 4.15 Assets and R2

- **Model.** Glyphdown's: folder-scoped filenames POSTed through the Worker into R2, content-addressed (`asset-blobs/sha256/<hash>`), refcounted, with `asset_versions`. Moss's `moss-asset://` URLs become `/api/docs/:id/assets/<file>` through a URL seam that is aware of doc, folder, and vault scope. [D12; code:api/assets.ts]
- **The final web client never wired uploads** (`images.save`, `persistUrl`, and `copyFromPath` threw) even though the 1,146-line server asset API existed. → Ship the UI and server together. [latest-code]
- **Asset serving.** Serve with stale-while-revalidate, not `no-cache`, and reserve image dimensions; image re-decode amplified the flash. A missing `IMAGE_TRANSFORMER` import (an export-only stub with `regExp /^$/`) turned `![alt](f.png)` into a literal "!" plus a link while string round-trips stayed byte-identical. [n2ii-b s28812; n2ii s8782]

### 4.16 Converter, CLI, daemon

- **One converter.** The era-1 server importer was missing 7 block families. Era-2 server twins drifted. CLI-created docs rendered BLANK in the web editor, because the editor bound an uninitialized Y.Doc (D-H1, which invalidated the web legs of H-05, H-10, H-20, and H-22). A bare YouTube URL was rewritten into `![YouTube video](…)` syntax on import. The server converter showed byte drift on all 8 fixtures (H-23). Import routed media differently from desktop (H-24). The CLI import dropped the H1 (H-25). → Use the client's transformer set in the DO. Evidence must be tree-level round trips comparing `exportJSON` node types, because string identity is banned. Make "a CLI-created doc renders identically in the web editor" an early gate. The transformer list is order-sensitive. [4biv s24170; RUBRIC-SKIM H; SPEC §4]
- **Structural merge.**
  - Parse the pushed markdown into a tree.
  - Diff against the live tree, keeping untouched subtrees and their Yjs items.
  - Diff character by character inside changed text nodes.
  - Apply minimal operations in one DO transaction.
  - Verify the base hash.
  - Refuse degenerate rewrites with a 60% guard.
  - Give duplicate blocks positional identity (a counted multiset).
  - Keep `mergeComments` commutative.
  - The top-level splitter must track `:::` fence depth as well as backtick fences; `:::tabs` panels were being lost.
  - Glyphdown's pure half (base cache, `computeMergedTarget`, failed hunks) carries over as-is.
  [4biv s15326/22144/24980; SPEC §4]
- **CLI defects to avoid.**
  - `cat` adds a trailing LF (`console.log` instead of a raw stdout write); same for install-skill.
  - `clone` wrote `workspace.json` under `.moss-collab/` instead of the tree root.
  - `sync` kept the local copy when both sides changed (should be timestamp last-writer-wins).
  - `mv` prepended an H1 and mutated content (H-07).
  - The `/push` response omitted a field.
  - Title-prefix doc references returned an auth error.
  - A 1.7 MB push returned 500 and pull truncated to 38 bytes (H-35).
  - Sidecar operations weren't refused loudly.
  - The binary is `moss-collab`; `~/.local/bin/moss` is the moss desktop launcher, and workers called it by mistake.
  → Write raw bytes, test byte-exact round trips, and test the 2 MB budget early. [RUBRIC-SKIM H; d44s-b s53990]
- **Glyphdown's sync model.** `clone` mirrors into a folder with per-doc base tracking (`.glyphdown/<docId>/base.md` plus a hash). `sync` classifies each doc as up-to-date, pull, push, or merge, where push runs the server-side three-way merge. Untracked `.md` files become new docs; filenames are canonical, so local files get renamed; deletes don't propagate. Glyphdown has no daemon, so the moss-multi daemon is a folder watcher that triggers the same loop. Conflict handling, renames, and deletes are unresolved (§8). [r5cv s1574]

### 4.17 Security

- **SSRF.** The embed-unfurl and remote-image from-url routes need `redirect:'manual'` with a re-check on every hop (at most 5 hops), A/AAAA vetting through DoH (`cloudflare-dns.com/dns-query`), rejection of private, loopback, link-local (169.254/16), CGNAT, IPv6 ULA, and obfuscated IPv4 addresses, HTTPS only, and fail-closed behavior. Embed-preview egress also needs a 429 throttle (G-28, missing). [4biv s21751/22652; n2ii s8152]
- **Earlier security bugs.**
  - Unauthorized suggestion withdraw (SEC-1).
  - Demoted editors keeping their live socket (SEC-2).
  - Ungated comment delete (SEC-3).
  - The DEV_AUTH prod guard (SEC-4).
  - The vaults routes used `principal.id` where the docs routes used `effectiveUserId`, so agent keys saw zero vaults.
  - Treat a "got 200 where 4xx was expected" result as ungradeable until a mutating retry confirms it (D-G5 was vacated this way).
  [n2ii s20485; d44s-b s54131]
- **Packaging.** Confirm `dist/server/.dev.vars` is never uploaded (unconfirmed). [RECONCILIATION DEV-VARS-PACKAGING]
- **Serving user HTML.** bb's own HTML preview applied CSP `sandbox allow-scripts` keyed only on the `.html` suffix, so `.htm`, `.svg`, and `.xhtml` got no CSP. If moss-multi serves user HTML (moss-html blocks, previews), serve it from an isolated origin and sandbox every HTML-like type. [e2na/zhe3 s2353]

### 4.18 Build tooling

- **Node.** Use arm64 Node ≥ 22.7. `@cloudflare/vite-plugin` needs it, and Node 20 lacks a global WebSocket. x64 Node under Rosetta loads the wrong optional dependencies: workerd, esbuild, lightningcss, and `@openai/codex` all broke, and one sweep lost 140 agents instantly. [d44s-b s56662; SPEC §5]
- **`@cloudflare/vite-plugin` bakes the env at build time.** Set `CLOUDFLARE_ENV=staging` on `vite build`; a bare `pnpm build` ships PRODUCTION bindings. [n2ii s23814]
- **TanStack Start (react-start ~1.168).** The root route must use `shellComponent` (with `component`, `<Scripts/>` emitted nothing and the page never hydrated). The Worker exports `createServerEntry({fetch})`. A parent route needs an `<Outlet/>`. Align versions to glyphdown's proven set. [n2ii s2736; 4biv s23941]
- **Vite 8 (rolldown).** The client environment ignores `resolveId` hooks and aliases, so seams must use `enforce:'pre'` transform hooks. `resolve.dedupe` must include react, lexical, yjs, and jotai. In vitest, alias `cloudflare:workers` to a stub and inline partyserver and y-partyserver. [n2ii s4395; code:vite.config.ts]
- **Build provenance from day one.** `GET /api/version` returns `{commit, bundleHash, buildTime, env}` with no-store (POST is 405). Its absence (J-16) voided or blocked about 9 security and fault rows. Pin served-SHA preflight on the SHA captured at stack-build time, not on HEAD. `vite preview` binds only `[::1]`. [BUILD-PROVENANCE; r5cv s2707/4070]
- **Zombie dev servers.** The kill pattern "vite dev" never matched "vite.js dev", so three test rounds ran against stale code. → Use one canonical launcher that sweeps orphans, and fetch the served JS to confirm a change before any gate. [n2ii s6346]
- **Dependency versions in the last build.**
  - Framework: @tanstack/react-start 1.168.32, react-router 1.170.18, react 19.2.8, vite 8.1.5.
  - Cloudflare: @cloudflare/vite-plugin 1.46.0, wrangler 4.113.0, workerd 1.20260721.1.
  - Auth and data: better-auth 1.6.23, drizzle-orm 0.45.2.
  - UI: @base-ui/react 1.6.0, jotai 2.20.2, tailwind 3.4.19.
  - Tooling: TypeScript 5.9.3, pnpm 10.11.1, vitest 4, jest 30, fast-check 4, playwright 1.61.1.
  Moss itself at 26df579d5 uses electron ^40 and vite ^5. [pnpm-lock]
- **Patches** live under `patches/` via pnpm `patchedDependencies`. Remove each one after an upstream fix and rerun its contract tests. [deviations]

### 4.19 Testing and e2e

- **Proxies hid every integration bug in era 1.** jsdom has no CSS or layout. In-process Yjs with a synchronous provider has no real WebSocket, DO, or persistence. Convergence tests always started from empty docs. → Keep unit tests, but never count them as product evidence. Mount over pre-populated docs, use asynchronous providers, and run property tests (fast-check on a live headless binding) for the merge and anchor seams. [4biv s27256]
- **Every gate must be able to fail.** Prove it RED on pre-fix bytes or with a negative control (neutralize a fixture; inject a stale node or a duplicate socket). Examples that failed to fail: the H-23 gate asserted its own labels; a missing switch passed silently; a blacklist detector was bypassed through `locator('html')`; C-20 counted the wrong socket (`/api/doc/:id/ws` instead of `/parties/doc-d-o/:id`). [r5cv s2707; bmrs s6069; axb3 s2967]
- **Vary state, not just environment.** Warm versus cold stacks, asymmetric session history (a warm creator with a cold peer), roster pressure (0, 1, 2+ peers), focused fields, long idle (80s+ for hibernation), 390 versus 1440 widths, both engines, unread invites. Most shipped bugs appeared only in warm, loaded, or phone states. [POSTMORTEM lesson 6; bmrs s9646]
- **The product should publish readiness attributes** (`data-collab-input-state`, `data-title-input`, `data-title-binding`, `data-editor-remount`, `data-collab-reconnect`) so drivers wait on product truth, not sleeps. Publish "live" only after the root is editable and focused, all in one effect; React runs child effects first. [B1-E2E-DRIVER-V3; TRASH-RESTORE-TYPING-FIRST-CLICK]
- **Clock boundaries.** C-04's 12s title-convergence "FAIL" was really keyboard-dispatch time (9.0s); the real figure was 3.1s. → Timestamp each phase explicitly and start convergence clocks after input dispatch returns. Assert input ORDER as well as presence ('lolhe' versus 'hello'). [axb3 s2320; bmrs s6448]
- **Pixel method.** Capture `reference.png` (Ladle or desktop), `candidate.png` (deployed), and `diff.png`. Pass when the structural diff is at or below the floor (about 0.05%; G-13 passed at 0.032%) AND the diff image has been READ: only thin text-edge anti-aliasing is acceptable.
  - Ladle and staging are both Chromium, so 0.00% is honest there; across renderers a 0.00% is a fraud alarm.
  - Ladle loads no webfonts, so inject the product's exact faces (Inter 300–700 normal and italic, JetBrains Mono weights, Charter) and await `document.fonts.ready`.
  - Pad mismatched sizes to a common canvas; never resize.
  - Crop at exact device pixels at the deviceScaleFactor in use.
  - Deselect and move the mouse off the target before capturing.
  - Convert ICC profiles, don't just strip them.
  - Resize real windows rather than emulating a viewport.
  - Mask sanctioned collab chrome.
  - Use a clean account per run.
  - Match view modes.
  - Crop Ladle's own chrome out.
  - Disable the GPU for exact-pixel gates.
  - Stamp a run token into the pixels so evidence can't be stitched together.
  [d44s s8777–10781; 62jf; RUBRIC-RECOVERED A-01]
- **The oracle must be audited first.** Two of the first three "real defects" were Ladle font artifacts. The `app--empty-notes` story renders in a stubbed 320px frame. A Figma-era target rendered in the wrong font. A forward gate run at a 224px story width baked a hidden ⌘N chip into the "current" baseline. [d44s s9906; qb6q s5354]
- **Escalation on unexpected success.** An "expected 4xx, got 200" result needs a state-changing retry before it is graded. Blocked is not the same as failed: a Cloudflare-branded 500 page (`<!--[if lt IE 7]> … ie6 oldie`), D1 7429, Worker 1101, quota deaths, and vanished workspaces are requeued, never filed as product verdicts. [POSTMORTEM-RECOVERY §6]
- **Test hygiene.** Run suites one at a time (concurrent runs time out) with `--maxWorkers=4`. Give property suites per-test timeouts. Never use `$` patterns in `String.replace` replacements. Use specific jest mapper keys first. Deep-import pure modules to avoid pulling in Lexical transformers. Drivers stay under about 600 lines, and long soaks run detached with heartbeat transcripts. [LESSONS; d44s s52598]
- **Workflow and agent script hygiene.**
  - Give every agent an anti-stall preamble: `vitest run` only, no watch mode, no dev servers left running, timeouts on installs and on every shell command (an M1 agent hung for about 2 hours).
  - Null-guard every agent result (`(critic && critic.gaps) || []`); a transient 529 "Overloaded" made the M5 critic return null and crashed the workflow.
  - Use strict, typed structured-output schemas: reviewers emitted severity "high"/"medium" while the filter matched "P0"/"P1", so the fix agent never ran (twice); a free-form object schema killed a whole validation wave with `invalid_json_schema`. Smoke-test machine interfaces with a fake run first.
  - Keep a cross-vendor fallback tuple for fix workers; an Anthropic 529 storm killed one fix worker three times and the Sol tuple finished it.
  [4biv s5154–5401, s13586, s21482, s22060; POSTMORTEM-RECOVERY §2; axb3 s9948]
- **Authoring test content.** A real clipboard paste (Meta+V) of markdown triggers moss's markdown import, so any import-able node family can be authored from identical markdown on reference and candidate; decorators such as formulas and charts need a live slash-command lane (`/formula` inserts `=`; chart ids are `chart-bar` etc.). Resetting a reused doc's content to `''` does not clear its Yjs tree, so clear the live editor before authoring. Ladle's mock bridge blocks `notes.create` and its `notes.update` doesn't drive the view; its Vite optimizer can wedge on lazy-imported recharts (restart with a cleared cache and warm a throwaway chart). jsdom cannot model focus refusal; test input gating in real browsers. [d44s s8070–10468, s18735; latest-docs-ops]
- **Evidence durability and determinism.** A failed gate run once wiped the last green artifact set because the output directory was cleared at start: write each run to its own directory and never destroy the last passing evidence. For same-host, same-engine pixel gates, pin Chrome for Testing (stock Chrome auto-updates and made old recipes unreproducible) and require byte-identical crops across two consecutive runs. Treat a near-threshold pass (0.2407% against 0.25%) as a finding to explain, not a green. [62jf s13406, s16318; bmrs s2334, s4999]
- **A booked pass is not immune.** Later contrary evidence on the current build supersedes it (C-04 went from booked back to pending); closed defects collect "contrary evidence" sections instead of being silently reopened. [BOOKINGS C-04]

### 4.20 Browser automation

- **Severing connections.** CDP `Network.emulateNetworkConditions(offline)` does not sever an established WebSocket, and `setBlockedURLs` does not block WebSocket handshakes. Use an in-page socket route, or SIGSTOP the peer browser or stack process group for a true half-open drop. [LESSONS; axb3 s8904]
- **Engine limits.** Headless Chrome cannot reach `document.visibilityState='hidden'`; simulate it and flag it as simulated. `page.screenshot` brings the tab to the front (use CDP `captureScreenshot` with `fromSurface:true`). `navigator.clipboard.readText` fails in WebKit, so read share links from the rendered dialog. Playwright `isVisible` ignores occlusion, so use `elementFromPoint` at the typing point. Playwright's extra headers do not ride WebSocket upgrades, and a session cookie is issued only once per token, so use one minted session per browser context. Radix dropdowns need a retry. [LESSONS; d44s s33373]
- **Rosetta-translated Chrome** produced lost and split typed text that looked like product bugs. Never accept evidence from it; record the process code type ARM64 and `translated:false` with each run. Headed browsers hang without a GUI session. [B1-E2E-B0-V11-ARM64-CHROME-PATH]
- **The deployed build strips the dev automation hooks** (`__MOSS_AUTOMATION__`, `__collabEditor`), so drivers must target the production DOM through real clicks and keys. Title, then Enter, then body is the reliable typing path. [n2ii-b s26472]
- **Computer use was unreliable on this machine** (AppleEvent -1743 and -1712, native pipe startup failures). Codex's bundled browser plugin needs a live Chrome, which headless workers lack. Use a scripted deterministic driver as the primary path. [62jf s15881; d44s s50703]
- **Account handling.** Never drive tests as the owner: 76 of 80 drivers minted sessions on the owner's real account, polluting it with 231 docs and bouncing their Chrome to `/login`. Use per-run principals at `@example.invalid` and delete minted sessions afterwards. [yzzh s7365/7610]

---

## 5. Environment and ops facts

### 5.1 Machine and runtimes

- **Primary machine.** Apple Silicon arm64 (M4, 10 cores), bb host host_37m3sgpq59. The owner's other agent threads often push the 1-minute load to 50–99. In practice only one graded browser run at a time was reliable. Seven concurrent wrangler-plus-dual-Chrome stacks starved the box, and a runaway verify phase reached load 230 with 1,466 processes. [axb3 s2967; d44s-b s63291]
- **Node.** Always check `node -p 'process.arch + " " + process.version'`.
  - Known-good arm64: `~/.local/node-v24.18.1-darwin-arm64/bin`, `/Users/brsbl/.local/bin/node`, `~/.nvm/versions/node/v22.22.0`.
  - Reported as x64 under Rosetta: nvm v22.22.1. Verify before use.
  - Default nvm v20.19.5 is x64 and too old; `/usr/local/bin/node` is v16.6.2 and crashes corepack.
  - Install with `arch -arm64` when the parent runs under Rosetta, and check workerd and esbuild with `file`. pnpm 10.11.1 via `packageManager`.
  [d44s-b; latest-docs-ops]
- **Browsers.** The last pinned browser was Chrome for Testing 150.0.7871.187 (`npx @puppeteer/browsers install chrome@150.0.7871.187 --platform mac --path ~/.cache/moss-collab-browsers`), arm64 build on this machine, with Playwright WebKit as the second engine. Note that the current global CLAUDE.md routes browser QA through the bb Browser Automation plugin instead (§8). [latest-docs-ops; bmrs s2334]
- **Old build host.** "Old Machbook Air" (strago.local, Intel i3 2-core, 8 GB, host_ua6sghxamw). Abandoned on 08-14. A bb dev stack (`turbo run dev` plus a second `--auto-join` daemon) and bb nightly auto-updates restarted its daemon every 10–20 minutes and killed about 16 runs. → Never build on a host running a bb dev stack or the nightly channel. [HANDOVER-0814 §4]

### 5.2 Reference rendering

- **Moss Ladle.** `cd ~/Code/moss/packages/desktop && ../../node_modules/.bin/ladle serve --port 61010`, then open `http://localhost:61010/?story=app--default&mode=preview`. Story ids are in `/meta.json`. It needs the Prism import in `.ladle/components.tsx` and a full webfont injection. The July pipeline built from a pinned `/tmp` worktree (frozen install, `ladle:build`, `127.0.0.1:61007`, waiting on `[data-moss-app-shell]` and 15 font descriptors). Never leave edits in `~/Code/moss`; one worker left an untracked `.acceptance/F-04` story there. [bundle HANDOFF §5; LESSONS]
- **Isolated moss desktop.** `cd ~/Code/moss/packages/desktop && tail -f /dev/null | MOSS_WORKSPACE_ROOT=/tmp/x MOSS_USER_DATA_DIR=/tmp/y MOSS_CDP_PORT=<unused> MOSS_ALLOW_MULTI_INSTANCE=1 pnpm start`. Attach Playwright with `connectOverCDP` (page URL contains `localhost:5173`). First boot takes 60–90s.
  - If `electron` has no dist, use Electron 40.10.0 from `/tmp` via `ELECTRON_OVERRIDE_DIST_PATH=…/Electron.app/Contents/MacOS` plus a lowercase `electron` shim.
  - The CDP endpoint has no Browser domain, so resize with `window.resizeTo`.
  - Changing the theme needs moss's real Settings UI; a bare API call doesn't update a running renderer.
  - The onboarding seeder adds "Getting Started with Moss" and "Use Cases" unless `.onboarding-seeded` exists; mirror the real data set rather than suppressing it to hit a zero floor.
  - Don't kill instances you didn't start.
  [62jf s329, s702–10428; n2ii s3052]
- **Glyphdown.** `~/Code/glyphdown-ref` @ faf98d07: `pnpm install` at the root, then `vite dev --port 3000` in `apps/web`. Suggestion and cursor flows need its in-process worker backend; local OAuth is bypassed. The July oracle stack used pnpm 10.30.1 at `127.0.0.1:62017` with seeded docs and the states suggest-mode, presence-cursors, history-dialog, login-card, and share-dialog. It builds with vite 8 / rolldown. Hosted glyphdown.com once crashed a headless probe. [d44s s16321; latest-docs-ops]

### 5.3 Local stack (last design)

- **`scripts/dev-server.sh {preflight|start|verify|status|stop} <run-id> --port P [--open-signup] [--principals N]`**, documented in `docs/LOCAL-STACK.md`.
  - It applies D1 migrations into `.local-stack/runs/<id>/cloudflare-state`, vite-builds with provenance, validates bindings (D1 `DB`, R2 `ASSETS`, DocDO/HtmlDocDO/SearchDO), and hashes the bundle.
  - It then runs `wrangler dev <built index.js> --no-bundle --local --ip 127.0.0.1 --port P --inspector-port P+1000 --persist-to …`. The default inspector port 9229 collides across stacks.
  - Readiness waits until `/api/version` matches.
  - It uses a fresh `BETTER_AUTH_SECRET` per run, so a restart 401s live sessions, blanks OAuth, Resend, and PostHog vars, and ignores `.dev.vars`.
- **Principals.** `scripts/seed-local-principals.mjs seed|teardown <id> --count N` (1–20, `moss-<id>-pN@example.invalid`, `principals.json` mode 0600). `smoke-local-stack.mjs` proves boot, auth, a D1 write, WebSocket 101, and cleanup.
- **Ports used.** Lane 1 8850–8869, lane 2 8830–8849, playground 8791 or 8788, vite dev 3000, Ladle 61010/61007, glyphdown 62017 or 3000.
- **Guards.** At most 3 live stacks, a host admission gate at 1-minute load ≤ 6.0, a settle point after browser launch, serial graded runs, and a stack-reaper preflight that also kills temp-profile Chromes (orphans held locks and ports for 4 days). → These existed only to run many lanes on one laptop. The postmortem archived the admission and lane machinery, so keep only the reaper and serial runs. [POSTMORTEM "Archived"; axb3 s7001]

### 5.4 Deploy

- **Cloudflare account.** The owner's personal account (wrangler authenticated as the owner's personal email, account <account id> Never work. Run `wrangler whoami` before creating anything. Wrangler login uses an OAuth callback on `localhost:8976` with a short timeout; ask the owner once to click "Allow" in their already signed-in browser. [n2ii s24676; 62jf]
- **Prior staging.**
  - Worker: `moss-collab-staging.<personal-subdomain>.workers.dev`; D1 `moss-collab-staging`; R2 `moss-collab-staging-assets`.
  - DO migrations: v1 DocDO, v2 SearchDO, v3 HtmlDocDO (`new_sqlite_classes`).
  - Commands: `pnpm --dir apps/web run deploy:staging` (= `CLOUDFLARE_ENV=staging vite build && wrangler deploy --env staging`) and `pnpm db:migrate:staging`.
  - Its state is fixture-polluted (last legacy build 1aa434eb), and the B0/B1 build was never deployed. → Choose new, permanent names for moss-multi before the first deploy.
- **Setup facts.** R2 must be enabled once in the dashboard (error 10042). A workers.dev subdomain can be registered via the API, and its first TLS certificate took about 8 minutes. macOS curl (LibreSSL 3.3.6) is unreliable for TLS checks. The account is on Workers Paid. Wait about 20s after a deploy for propagation. [n2ii s25005–25247]

### 5.5 Credentials (never record values)

- **Historical credentials are compromised.** Lineage handoff files contain a test-account password and session-minting recipes verbatim. Never print or reuse them; mint fresh. `docs/SECURITY-ROTATION.md` lists the scrubbed locations; the owner must rotate any live values. Secrets read by the app: `BETTER_AUTH_SECRET` (set with `wrangler secret put`), the GitHub and Google client id/secret pairs, `RESEND_API_KEY`, `EMAIL_FROM`, the PostHog vars, `SIGNUP_ALLOWED_EMAILS`, `DEV_AUTH`. `apps/web/.dev.vars` is gitignored. [SECURITY-ROTATION; latest-code]
- **Test sessions.** Insert a D1 `session` row with millisecond timestamps and a plaintext token via `wrangler d1 execute`, then use it as `Authorization: Bearer` in a fresh context; signed-cookie injection fails. Mint only for per-run test principals and delete afterwards. Never write tokens into files. Never ask the owner for browser or account credentials; use the secrets skill when a user-supplied credential is unavoidable. [n2ii HANDOFF §5; n2ii-b s43745]

### 5.6 Limits and quotas

- **Codex (OpenAI)** quota ran out repeatedly. A cheap probe: `codex exec "reply OK"`. The owner can reset the quota. Re-logging during a reset killed about 17 in-flight legs ("signed in to another account").
- **Claude** has 5-hour and weekly limits. Fable 5 has a 200k context window; a coordinator thread at about 612k tokens silently fell back to Opus. The codex safety classifier refused benign security QA rows until the brief added an authorized-QA framing ("BENIGN_CONTEXT"). [d44s-b s61339; r5cv s4620]
- **bb workflows plugin bugs.**
  - Inline prompts of about 5 KB or more are cancelled after about 35s ("Parent workflow finished before this call"); pass a brief file plus a short pointer.
  - A second `agent()` call is killed after a multi-hour first call.
  - Notifications arrive truncated, duplicated, or late.
  - A workflow dying does not kill its worker, so check the PID and branch tip before resuming.
  - `::workflow-preview` needs the full UUID run id.
  - `bb workflows validate` needs literal option objects in each `agent()` call.
  - On 09-02 every codex checker dispatch died as a "dead claim" within about 4s because of orphaned duplicate codex bridge worker processes; kill orphaned bridge workers, and fall back to a direct-spawned checker thread (harvest its worktree branch onto `main`).
  - Commit a brief to the repo before passing its path; a direct checker spent its first turn hunting for a temp-file brief the coordinator had already deleted.
  [axb3 s850; r5cv s4616; e2na s5268, s7344–7545, s8854]

---

## 6. Process: keep / avoid / adapt

| Verdict | Practice | Evidence |
|---|---|---|
| Keep | Builder never grades its own work. An independent verifier re-derives the result with its own driver, preferably cross-vendor (Opus builds, Sol checks), and the coordinator reads the decisive images. | B0: 12 checker refutations, 0 of them wrong. Caught the sign-out socket, share-link 401, existence leak, and wake-race merge. In era 4 it caught false FAILs (G-24, H-28/29) and false PASSes (H-25, J-10, C-09 stitched). [bmrs s6534; yzzh] |
| Keep | A naive-user product critic at every plan and gate, with each finding dispositioned. | One run found no remote caret, one-sided presence, titles not syncing, a lying banner, broken folder create, and desktop leaks, all missed by 7 green rows. [kqtn; critic m15] |
| Keep | Cumulative e2e through the rendered UI only, with no API shortcuts for actions. A missing affordance is a FAIL, not BLOCKED. | Era 3 booked rows through APIs on an app with no login page. [SPEC §10] |
| Keep | Oracle first (WWGD): read glyphdown and moss-at-pin before the first fix on a ported surface. If a symptom recurs across two fixes, treat it as an architecture question. | The oracle-first panel arc closed in 1 train; the symptom-first title arc took 5+. [e2na s8235] |
| Keep | Push every green step. PROGRESS.md is the durable checkpoint, updated in the same commit. | The bmrs coordinator's death cost minutes; era 3's destruction cost weeks. |
| Keep | One short PRODUCT.md, re-read at every decision point, with an owning check per decision. Briefs cite the decisions they touch. | RW-1 was violated because briefs were checked only against defects. [POSTMORTEM; axb3 s10136] |
| Keep | Pilot one representative unit per lane type until the method converges, then scale. | 126 unpiloted agents lost 109 to quota; the C-01 pilot surfaced 5 load-bearing bugs for the price of one row. [n2ii; r5cv s3457] |
| Keep | Tests first, with RED proven on pre-fix bytes. A regression ratchet: no defect closes without an assertion that failed before the fix. | Remount fix went from 52/84 to 84/84. [e2na] |
| Keep | Diagnose with instrumentation before patching, and stop guessing after one failed blind fix. | A-39 (a stale node key) and the C-04 clock issue were found only through instrumentation. [d44s s16587; axb3 s2320] |
| Keep | An adversarial review before shipping delicate fixes. | It caught a session-long `updatedAt` freeze regression in the flash fix. [n2ii-b s40755] |
| Keep | Plain-language owner asks with screenshots, short option forms, and a recommendation. | "idk what these mean", then a re-ask, then "i take all your recs". |
| Keep | Bank every gotcha in an on-disk METHOD.md that every agent reads. | 82 gotchas let dead agents relaunch without relearning. [n2ii-b s30091] |
| Keep | Owner delegation: when told "resolve X yourself", rule, write it into PRODUCT.md, and give the rationale. | The viewport tiers. [PRODUCT] |
| Keep | A standing adjudication advisor (a visible bb thread) for spec-vs-spec conflicts. It cites the underlying spec verbatim, separates cited from inferred claims, may say "the spec does not settle this", and every pass-bar amendment is logged loudly as a softening with citations. | G-21 amended and E-09 re-attributed to E-15 without going back to the owner. [6mff s1, s873; d44s s52242] |
| Keep | Deterministic orchestration: a state file plus a runner spawns, polls, schema-validates, and classifies deaths, instead of an LLM babysitting workers. Decompose oversized units (more than 4 scenarios, multiple boots, or a driver over ~400 lines) into sub-runs reduced by a script to one verdict. Failure budget: at most 4 attempts per unit and role, and at most 2 coordinator interventions without a state change, then park. | G-14 died three times as one 2,691-line driver and passed cleanly when split per role; the split also exposed the false D-G5. [6mff s508; d44s s53327–54154] |
| Keep | Invariants outrank brief bounds (CASE-LAW): a coordinator's scoping bound never overrides a pre-existing program invariant; the worker does the minimum invariant-satisfying work and discloses which bound it set aside. Briefs must not forbid work the invariants require. | A "no stack, no browser" brief collided with the fresh-frames evidence invariant and the worker was refuted for obeying the invariant. [bmrs s11085, s11207] |
| Keep | Verify that provider, model, and effort actually reach workers, and pass them explicitly at spawn. | omegacode ran codex at default effort until the owner asked "x high?"; a handover "Fable" coordinator spawned on codex from the project default. [d44s-b s54406, s64668] |
| Adapt | Verification depth proportional to risk. A cross-vendor checker for security, concurrency, and data-loss changes; lighter checks for cosmetic ones. Stop evidence-only cycles once behavior is confirmed. | Trash-401 took 8 cycles, 6 of them on evidence. The convergence fix took 4 trains after the product fix was confirmed. Progress went from 36% to 44% in 3 weeks. [bmrs; e2na s6149] |
| Adapt | Run e2e as one living, maintainable suite. No append-only, hash-pinned versioned copies. Drivers wait on product readiness attributes. | 9 driver versions and 7 harness trains, and the board never went green; v2–v11 copies of about 1,500 lines each. [e2na s6923] |
| Adapt | Coordinator liveness through durable scheduled checks (automations or cron), not in-session monitors. Treat errored workers as events. Alert only on state transitions, and keep the owner-facing status surface separate from the log. | A dead monitor caused a 2-week idle stall; the last checker died and nobody noticed. A 20-minute watchdog re-alerted on finished runs for days (about 2,184 lines) until the journal agent hit "Prompt is too long"; 15+ "stale echo" messages flooded the e2na owner thread. [e2na s7131; 2yq6; axb3 s1170, s8076] |
| Adapt | Keep one machine-readable state file and generate every human view from it. | The RUBRIC-SKIM total drifted from the section sums. [yzzh s5788] |
| Adapt | Keep the coordinator lean: state in the repo, sparse polling, a planned handoff before the context grows large. | Fable fell back to Opus at about 612k tokens. [r5cv s4620] |
| Adapt | Use isolated worktrees for parallel workers (as the global CLAUDE.md prefers). Merge often and re-run combined journeys after every merge. Never `git stash` or `git add -A` in a shared checkout. | A stash reverted sibling work; branches drifted 102 ahead and 87 behind; the T1+T2 merge broke the anonymous share journey. [axb3 s9668; bmrs s8913] |
| Avoid | Self-authored headless gates or proxy tests as acceptance, or grading against copied code instead of rendered UI. | 1,526 tests green on a broken app; "6/7 verified to spec" meant code contracts. |
| Avoid | Shipping caveats, deferring owner-flagged visible defects, or claiming done without screenshot proof. | "STOP WITH CAVEEATS"; POLISH-FIXES backlog never executed. |
| Avoid | A large rubric (284 rows) plus legalistic bookkeeping: case law, declaration audits, enumerator gates, booking ledgers, door campaigns. | 132/284 after weeks; 10/284 in the rebuild; 2.8M doc lines in the product repo. |
| Avoid | Unbounded fan-out, or a build workflow that spawns its own verify phase. | 115 verify agents produced load 230; 109 of 126 agents died on quota. |
| Avoid | Tooling side quests in the coordinator thread (plugin UI, ledger HTML, skills authoring). | The Omega banner took hours of coordinator turns; LEDGER.html went through 9 rounds. |
| Avoid | Modifying tooling or repos owned by another thread, or writing to `~/Code/moss`. | "why are you modifying a repo?"; the Omega plugin patch was reverted. |
| Avoid | Asking the owner routing questions, or reading "cont" as approval. | "stop asking me these questions". |
| Avoid | Continuing a running fix after the owner corrects its design mid-flight, or defending the prior approach. Stop or re-brief it. | The unbound-title fix kept the title focusable after "we just would not allow the focus". [e2na s8024, s8854] |
| Avoid | Asserting environment causes or capability limits without checking them. | "bb restarted" (it had 28h uptime), "no browser in the sandbox", "can't screenshot bb", "Codex has no subagent primitive" were all false. [axb3 s725; 4biv s22754; d44s s55663; qb6q s1920] |
| Avoid | Stating planned changes in the past tense in evidence or errata. | An ERRATA claimed a gate was "folded into the e2e driver" when it was only planned; the checker's grep caught it. [bmrs s5829] |
| Avoid | Editing long prose fields (rubric rows, specs) by regex or string surgery. Rewrite fields wholesale from the pristine text and lint the generator. | Four waves of self-inflicted rubric damage: truncated pass definitions, contradictory ruling text, glued CSS selectors and shell commands. [d44s s6548–7416] |
| Avoid | Committing bulk evidence and process artifacts into the product repo; long narrative code comments full of ticket ids that go stale. | docs/ held 9,296 files; the `/frontmatter` route comment contradicted the code. |
| Avoid | Running heavy work on a weak or shared host, or on hosts running a bb dev stack or the nightly channel. | About 16 runs were killed on the Intel Air. |
| Avoid | Testing as the owner's real account, or probing production with real emails before understanding the semantics. | The owner's Chrome was bounced to `/login`; a signup probe used the owner's email. |

---

## 7. Recommendations for the restart

### 7.1 Rules, ordered by impact

1. **Remote first.** Create a private GitHub repo for moss-multi before writing code. Commit and push at every green step. Never keep the only copy of anything (code, evidence, playbooks, oracles) in a BB environment, thread storage, or `/tmp`. Back up `~/Code/glyphdown-ref` to a private remote or bundle. [era 4; qb6q s2060]
2. **One intent doc.** Bring PRODUCT.md and BUILDPLAN.md over as the starting point, updated with §1 of this file. Re-read them before every brief and every fix. Every brief cites the decisions it touches, and every decision has an owning e2e check. [POSTMORTEM; axb3 s10136]
3. **The real stack from day one.** Verify against workerd running the built Worker bytes (`wrangler dev --local` on the vite build), with `/api/version` provenance, in a real browser. Never accept dev-server-only results. Run the full journey suite on the deployed build before calling anything shippable. [n2ii s25653; 4biv]
4. **Port moss; don't reimplement it.** One pin, with `ported-from` headers. Keep files as close to byte-identical as possible and put multiplayer adaptations at module boundaries, so re-pinning is mechanical. Match moss's Lexical version exactly. Moss-absent surfaces follow glyphdown's rendered design, built from the moss DS, inside moss chrome; nothing floats over the canvas. [§1.1, §4.1, §4.2]
5. **The Y.Doc is the only source of truth for an open doc.** One socket per doc carries content, title, frontmatter, deletion, and permission events. No REST save lane, disk-change remount, `updatedAt`-keyed refetch, or second watch socket for bound docs. The DO writes the D1 projections. Comments and suggestions are CRDT data. [§4.1, §4.4]
6. **Never render an editable surface before it is bound and synced.** Title, body, and composer: every input route lands or visibly refuses. Seed on the server, never bootstrap on the client, never seed placeholders as text. Adopt glyphdown's name-first creation if the owner confirms (§8). [e2na s7863/s8190]
7. **One converter.** The DO runs the client's transformer set over moss node classes split from their React decorators. Gate on tree-level round trips for every node family, plus "a CLI-created doc renders identically in the web editor", in M0/M1, not M6. [§4.16]
8. **Build the hardened collab core in the first co-editing milestone.**
   - Server seed, render after first sync, `connect:false` with one connection.
   - Heartbeat with half-open detection, and a truthful banner.
   - Awareness heartbeat and sweep, claimed colors, the cursor overlay wired in.
   - The close-code vocabulary, and a terminal 4410 store.
   - Per-origin undo at 1000ms.
   - No `HISTORIC_TAG` anywhere.
   - A type-aware wire-exclusion list, verified by scanning frames.
   - The patched y-partyserver behaviors.
   [§4.3, §4.5, §4.6]
9. **WWGD before the first fix.** On any ported surface, read glyphdown's interaction contract and moss's shape at the pin and record a three-way comparison before diagnosing. If a symptom survives one fix, stop and ask whether the structure is wrong. [e2na s8195]
10. **The owner is never the referee.** The agent launches and drives the real app itself and posts decisive screenshots inline (2× density) at each gate. Never ship a caveat: if the method can't produce the real thing, change the method. Fix owner-flagged visible defects before anything else. [§2.5]
11. **Acceptance is a cumulative, UI-only journey suite plus a naive critic,** one living suite in the repo. A missing affordance is a FAIL. Drivers wait on readiness attributes the product publishes. Every journey uses at least two distinct per-run principals. The owner's account is never used. [§6; kqtn s413]
12. **Every gate must be able to fail.** Prove it RED on pre-fix bytes, or with a negative control, before trusting it. Read the diff image, not the number. Audit the oracle (fonts, widths, view mode) before the first comparison. [§4.19]
13. **Vary state.** Every collab and permission journey runs warm and cold, after an idle period long enough to hibernate (80s+), with 0, 1, and 2+ peers, with a warm creator and a cold peer, with a remount mid-session, in Chromium and WebKit, and at 390px for Tier A paths. [§4.19]
14. **Every milestone ships its UI.** No backend-only milestone. Before M1, inventory every host UI the feature list needs: role grant, suggest entry, first checkpoint, file picker, Settings → Agents, bell, vault switcher, real routes. [§4.1]
15. **Access control as one system.** One roles module shared by client and server. The share token is threaded through every read path including the WebSocket query string. Every revocation goes through one kick path (member, role, link, agent key, sign-out). Non-disclosing 404s everywhere. Hide controls rather than letting the server refuse them. [§4.10]
16. **Proportional verification.** Use an independent cross-vendor checker for auth, sharing, concurrency, persistence, and data-loss changes. Cosmetic changes get the e2e plus inline screenshots. Don't spend cycles on declaration or evidence paperwork once the behavior is confirmed. Settle with the owner whether cross-vendor checking stays mandatory (§8). [§6]
17. **Infrastructure hygiene.**
    - arm64 Node and browsers only, verified per run.
    - The primary machine, with no bb dev stack.
    - One graded browser run at a time, plus an orphan reaper.
    - Infrastructure failures are requeued, never filed as verdicts.
    - Worker, D1, and R2 names fixed once before the first deploy, on the personal account only.
    [§5]
18. **Durable liveness.** Use a scheduled bb automation for stall detection and treat errored workers as events. Keep the coordinator lean, with state in PROGRESS.md and the repo, and hand off before the context grows large. [e2na s7131; r5cv s4620]
19. **Defaults to build in at M0.**
    - `/api/version` provenance.
    - Global CSS imported in `__root`, with Tailwind globs covering every `className` file.
    - Prism installed first at the client entry and in workerd.
    - A per-decorator error boundary.
    - A ChunkReloadBoundary.
    - SSRF-safe unfurl.
    - A sandboxed HTML iframe.
    - SEC-4 fail-closed auth.
    - Only configured OAuth providers.
    - The JSON sign-out body.
    - A test that schema and migration DDL match.
    [§4]
20. **Cost and test-data discipline.** Reuse one persistent doc per test, mint and tear down principals per run, budget Cloudflare requests, remember that soft-deleted DOs never reclaim storage, monitor codex and Claude quotas, and pause and report when quota runs out. [§4.7, §5.6]
21. **Communication.** Lead with the outcome. Answer questions literally, in plain product language. Use absolute paths and inline images, a single % progress number plus a milestone/program visual, and options with a recommendation. "cont" is not approval. Never ask about defects; just fix them. [§2.1]
22. **Keep the repo lean.** Evidence stays small: decisive screenshots for adjudicated checks only, not run dumps. No versioned test copies. Comments short and factual. Archive finished workers and worktrees as you go. [latest-code; d44s s52372]

### 7.2 Proposed lean milestone sequence

This follows the owner-approved B0–B7 ladder with an explicit foundation milestone up front, where the lessons say risk lives. Each milestone ends with a cumulative journey run, a critic pass, inline screenshots, and owner approval of the transition.

| M | Name | Ships (UI included) | New journeys |
|---|---|---|---|
| M0 | Foundation | Private remote. The real moss shell at the pin in a browser, light and dark, matching Ladle `app--default`. Local workerd stack with provenance and per-run principals. The e2e harness skeleton with negative controls. Lexical aligned to moss. One converter in the DO, round-tripping every node family. Host-UI inventory. | J0: boot the shell with zero console errors; parity screenshots; a CLI-pushed doc renders identically to the UI-authored one |
| M1 | Trustworthy co-editing (B0) | Two-user live editing. CRDT title and frontmatter. Presence face pile and cursors. Truthful connection banner. Hibernation-safe reopen. Per-origin undo. Folders. Trash and restore with a terminal state. Dev playground. | J1: create, co-edit, presence, cursors, rename, offline blip, close, reopen after hibernation |
| M2 | Accounts and sharing (B1) | Email/password auth. Five roles with server enforcement. Share dialog. Link sharing with sign-in-to-do-more. Live revocation and demotion. Invite notices. The Tier A phone path. | J2 login and sign-up; J3 share with a person and a link; J4 revoke live; J5 stranger on a phone |
| M3 | Rich workspace (B2) | Image, video, HTML, and embed upload and render. Search and backlinks. Notifications inbox. Vault switcher. Settings → Agents. Every node family in a demo note built through the UI. | J6 media; J7 search and backlinks; J8 vaults; J9 the demo note |
| M4 | Comments (B3) | CRDT comments after a design review: gutter, highlights, threads, replies, mentions, reactions, resolve. Clean `.md`. | J10, including type-after-comment and two peers |
| M5 | Suggestions (B4) | Suggest mode in the floating toolbar. CRDT-delta vetting. Structural-op semantics. Accept and reject. Client discards state on 4403. | J11, including colliding-prefix typing and a suggester's first delete on a cold load |
| M6 | History (B5) | Auto and named versions, view, diff, identity-preserving restore, honest errors. Moss modal shell. | J12, including restore during concurrent peer typing |
| M7 | Agents and local sync (B6) | CLI (device flow, keys, pull/push/sync, `--suggest`), Bot presence, folder-watch daemon. | J13: CLI push merges while a human types; the daemon round-trips a local edit |
| M8 | Ship (B7) | Staging deploy under fixed names, equality between `/api/version` on staging and the local build, every journey on the deployed build, security sweep, MIGRATION.md. | All journeys, deployed |

### 7.3 Definition of done (each line checkable by the e2e suite)

Global invariants, asserted by every journey on every run:

- Zero uncaught page errors and zero console errors, except an explicit allowlist (for example the WebSocket-closed-before-established warning, allowed only in deliberate teardown legs).
- Served bytes match `/api/version` for the commit under test. Chromium and WebKit run natively (arm64, `translated:false`).
- At least two distinct per-run principals in separate browser contexts. The owner's account is never touched. Principals are torn down to zero afterwards.
- For every typed string: exact bytes and order on the author, on each peer, and after reload of both.
- For an open doc: exactly one doc-party WebSocket held for 60s or more, and a stable editor root identity (no remount) across metadata changes.
- No editable element accepts focus or input before `data-*-binding=live`. Paste, drop, and IME into a not-yet-ready field either land or show a visible refusal.
- No collab chrome element intersects the editor canvas (a floating-element detector with a mandatory negative control). Edit/Suggest sits inside the floating toolbar.
- No literal `%m:` or `%%m:` in the DOM; exported and pulled `.md` contains no comment or suggestion markers.
- Light and dark screenshots of each new or changed surface sit at or below the measured floor against the pinned oracle, and the diff image has been read.

Per-milestone exit checks (examples that make the invariants concrete):

- **M1**
  - Peer B sees A's text within 2s.
  - A rename appears in B's title, sidebar, and breadcrumb within 5s, and renames A→B→C converge monotonically.
  - Alone: 0 chips. Two peers: 1 chip each, whose caret and selection color equals the chip color. A hard drop clears within 8–20s.
  - A SIGSTOP of the stack shows the banner within about 13s; resume brings convergence with no lost bytes.
  - Reopen after a forced hibernation (or idle ≥ 90s) shows non-empty content.
  - Cmd+Z in A never removes B's text.
  - Trash closes peers with 4410; every editable surface is disabled; a fresh load returns 404; restore converges.
- **M2**
  - An anonymous link opens the doc at viewer level with "Sign in to do more", and works at 390×844.
  - A revoked, forged, or inaccessible doc gives a byte-identical 404.
  - Demotion closes the socket (4403) within 1s, and the UI goes read-only with a message.
  - Sign-out in window A severs window B's socket.
  - The viewer's checkbox and slash controls are inert.
- **M3**
  - Uploaded image and video render after reload and inside a copied note.
  - The HTML preview runs in a sandboxed iframe.
  - Search snippets show text, never "[object Object]"; backlinks survive a save.
  - The demo note shows every node family, styled.
- **M4–M6**
  - Typing anywhere after a comment replicates to the peer.
  - Colliding-prefix suggestion typing gets no 4403; a suggester's first delete never removes text server-side.
  - Restore during peer typing keeps the peer's insert; a failed versions fetch renders an error.
- **M7**
  - A CLI push during human typing preserves both; `cat` output is byte-exact; a 2 MB push succeeds and a pull returns all bytes.
  - A CLI-created doc renders in the web editor.
  - Revoking an agent key closes its socket.

---

## 8. Open questions for the owner

These are unresolved by the record; everything else in §1 is treated as decided.

1. **Moss pin.** Stay on 26df579d5 (the last approved baseline) or re-pin to current moss (HEAD 4fa391258 from 2026-07-30, or newer)? Pin changes are owner-gated. A newer pin also means Lexical ≥ 0.48. [HANDOVER-0814; latest-code]
2. **Note creation and title UX.** Adopt glyphdown's name-first creation and skeleton→button→rename-input title, which makes the unbound-title bug class impossible, or keep moss's "+ Note then type in the H1" flow with a non-focusable title until bound? "we just would not allow the focus" implies the former, but it was never formally ruled, and it changes the moss UI that "port 100%" protects. [e2na s8024, s8190]
3. **Title versus filename.** Filename-canonical naming (slug stem, H1 as content) coexists with a CRDT title field. Does renaming the title rename the file? Is the title the H1 or separate from it? `[[wiki]]` resolution against renamed docs? CLI `mv` prepended an H1 (H-07). In era 2 the server stored filename-stem slugs as titles and the renderer repaired casing from the H1 only when a note was opened, so the sidebar showed lowercase slugs. [PRODUCT; D16; RW-1; 62jf s5247]
4. **Open in New Window and Save as PDF.** Become a browser tab and `window.print` (as PRODUCT says), or stay hidden (as the code did)? Relatedly, is "reads-as-moss" acceptable for the in-app browser pane (an Electron webview cannot be replicated on the web), or must it match pixel for pixel? Era 2 called it a ratified deviation, but no owner approval exists. [PRODUCT vs web-affordances.ts; n2ii-b s26331]
5. **Verification weight.** Should the cross-vendor checker (Opus builds, Sol verifies) run on every fix, or only on risk classes (auth, sharing, concurrency, persistence, data loss)? Only the owner can waive it. Should the 284-row rubric be used at all, or only PRODUCT.md plus journeys plus the critic, as the POSTMORTEM archive declared? [WORKFLOW-DESIGN; POSTMORTEM]
6. **Where tests run.** The global CLAUDE.md says CI runs remotely and never locally, but every prior loop depended on local test batteries and local real-stack browser runs (CASE-LAW "The battery runs here"). Does moss-multi get remote CI from M0 with local runs limited to real-product interaction, or an explicit exemption? [CASE-LAW; e2na s8972]
7. **Browser driver.** The global CLAUDE.md mandates the bb Browser Automation plugin and bans standalone Playwright. The e2e needs multiple isolated principals and profiles, WebKit, WebSocket frame capture, SIGSTOP severs, and `elementFromPoint` hit tests. Is the plugin sufficient, or is a Playwright-based journey suite in the repo an approved exception? [§4.20]
8. **Orchestration.** For the restart, keep a Fable coordinator plus Opus builders plus Sol checkers capped at 3? Which orchestrator: bb workflows (visible in the UI, but with a second-call kill bug) or a deterministic local runner? The owner once set the cap to 7; the evidence pointed to 3. [r5cv s1980; HANDOVER-0814]
9. **The DEV_AUTH playground.** Keep it as a dev-flag, loopback-only substrate (PRODUCT) or delete it now that real accounts exist (deviations)? It had a cross-identity socket defect. [PRODUCT vs deviations]
10. **Demo notes in the owner's vault.** Is the demo-note deliverable still part of done? It requires writing into the owner's real account, which conflicts with the rule never to test as the owner. [J-11; yzzh s7610]
11. **Sync daemon semantics.** Conflict policy (last-writer-wins by timestamp or a merge), local renames, and deletes; glyphdown doesn't propagate deletes. [r5cv s1574; H-12]
12. **Hard delete.** It stays deferred, but soft-deleted DOs never reclaim storage. Era-3 test churn hit the free plan (the binding caps were daily requests and observability events), and later docs blamed the missing hard delete for exhausting the Cloudflare budget. Is any purge, even only for test data, wanted, and what cost ceiling applies? [RW-3; d44s s13221–13589; axb3 s10321]
13. **Degraded backend behavior.** On a transient D1 or auth failure, should a signed-in user be bounced to `/login`, or see a retrying, degraded state? (Filed, never ruled.) [yzzh s7610]
14. **Production.** What triggers a production deploy? This is the only item PRODUCT.md lists as undecided. [PRODUCT]
15. **Layout sidecar data.** Where should moss's newer `tabWidths` layout-sidecar data live in the collab model? Per-viewer local like B8, or synced? [UPSTREAM-IMPACT]
16. **Official binding or custom.** Start from `@lexical/yjs`'s official `CollaborationPlugin` and extend it, or rebuild the custom CollabBindingPlugin from primitives (needed in the old build for per-origin undo and the mark-stripped projection)? The custom binding is where the initial-reconcile, bootstrap-race, and missing-cursor bugs came from. [4biv; n2ii-b s37475]
17. **Prior code as an answer key.** Should moss-multi consult brsbl/moss-collab@9104ceb and brsbl/moss-collab-legacy as reference implementations (the hardened collab layer, `@lexical/yjs` and y-partyserver patches, structural merge, title CRDT, auth, schema), port specific modules, or ignore them? The July rebuild ported "verified packages" whole and ended up carrying machinery that contradicted later rulings (comment sidecars, an unused asset API). [SPEC §9 Q1; latest-code]
18. **Publish to web.** Is the era-0 Shared Notes scope (anyone-can-view publishing, optionally scoped to emails or users) part of moss-multi, or only the multiplayer editor and its sharing model? [pukn s2373]

# Deviations registry

Every deliberate difference from moss@762abb777, seeded from ARCHITECTURE §23. A new deviation needs an owner ruling (LEARNINGS §1.3, ruling 13). Rows marked "pending" were made under delegation and go to the owner in one batched list at the M0 hand-off.

| # | Deviation from moss@pin | Authority | Status |
|---|---|---|---|
| 1 | "+ Note" focuses the title after bind; the pin focuses the body | R2 | ruled |
| 2 | The title is a CRDT name projected to the filename. The H1 is body content; import never lifts it, and `.md` has no title line | R3; P:Notes | ruled |
| 3 | Hidden native-only affordances (A§9 registry) | P:Agents | ruled |
| 4 | ⌘N and ⌘T chips and `/emoji` hidden; browsers reserve the shortcuts and there is no emoji API | P:Agents ("cannot work → hidden") | ruled |
| 5 | Image alt text is edited from a web image context menu instead of the native Edit menu | P:Notes "web-adapted equivalents" | ruled |
| 6 | Per-viewer layout lives in localStorage; tab-width resize is no longer undoable | R11 | pending |
| 7 | New Window opens a tab; PDF uses browser print; the in-app browser is a sandboxed iframe whose back, forward and find are hidden (A§9) | R4 | ruled |
| 8 | Converter line-loss fix: a rejected image or table line stays as text, whether imported or typed as a shortcut; regression fixture `packages/sync/src/converter/fixtures/line-loss.md`, asserted against moss in L3, and an L1 typing test | P:Tech "never silently discarded" | pending |
| 9 | Formula recompute and wiki-link resolution are per-viewer overlays, not synced writes | P:Collab; S-conv §4.3 | pending |
| 10 | The floating toolbar hides while the editor is unfocused (T1.6); the sidebar Trash button accepts a dropped note (T2.3) | LEARNINGS §1.3 (owner, 07-29) | ruled |
| 11 | Below 640 px the notes panel overlays the canvas and the chrome row yields in order | P:Viewports Tier A; LEARNINGS §1.9 | ruled |
| 12 | Split navigation never shows one doc in both panes (moss's own rule, made total) | P:Collab one binding per doc; A§10.1 | pending |
| 13 | Formulas imported without an `id=` get ids derived from their payload and occurrence instead of random ones, so the client, the DocDO and the CLI agree; a derived id skips explicit ids in the imported file (fixture `formula-ids.md`). Typing and pasting into an existing body mint random ids, as at the pin | A§12; S-conv B9 | pending |
| 14 | Markdown pasted into an empty note uses the whole-body importer so insertion does not rewrite formatting boundaries. Explicit `text/markdown` payloads convert in one update to preserve nested blocks; plain-text detection and chunking remain Moss's. G1 covers the explicit whole-note path; formula regression legs also cover plain-text insertion | T1.8 delegated implementation; A§12 G1; large explicit-paste responsiveness remains a follow-up | pending |
| 15 | Duplicate copies the document snapshot, including frontmatter and anchor maps, instead of stripping metadata as Moss does. The copy is independent and gets no source grants; a caller unable to edit the source folder duplicates into their own Home | A§9 server duplicate; S-ren §3.7 anchor preservation; T1.8 delegated implementation | pending |
| 16 | Subscribed sidebar listings poll every 3 seconds until T2.1 supplies the workspace channel. Polling yields to active loads; it never overrides a vault switch or navigation. Listing changes currently request a full metadata hydrate | T1.8 peer discovery; interim exception to A§11, to be removed in T2.1 | pending |

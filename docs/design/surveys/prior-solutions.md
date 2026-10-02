# Prior solutions: what moss-collab@9104ceb solved, and how to reuse it

Survey of `/Users/brsbl/Code/moss-multi/.refs/moss-collab` (brsbl/moss-collab@9104ceb, 2026-09-02) used as an answer key for moss-multi. Every verdict is judged against `docs/history/LEARNINGS.md` and the PRODUCT.md restart rulings. Paths below are relative to `.refs/moss-collab/` unless prefixed. Line numbers are at 9104ceb. Upstream facts about Lexical 0.48 and y-partyserver come from the published package sources (unpkg, fetched 2026-10-02), not from memory.

## 0. Bottom line

- **The old code is pinned to a different world.** It ran Lexical **0.45.0** (forced by pnpm overrides; moss itself was on ^0.48) and moss renderer files from **6a68c88f** mixed with DS files from **26df579d**. The restart pins moss **762abb777** and Lexical **0.48.0**. Anything that touches Lexical internals must be re-derived, not copied.
- **The best reusable assets are small, pure, and already proven on the real stack:** the y-partyserver patch, provider hardening, the channel heartbeat, the presence heartbeat/sweep, color claiming, the remote-cursor adapter, the type-aware exclusion map, the CRDT title/frontmatter primitives, `diffTextToOps`, the identity-preserving tree reconcile, `roles.ts`, `auth.ts`, the D1 schema, the provenance plugin, and the server seed.
- **The big orchestration modules are the failure record, not the template.** `WebCollabPlugins.tsx` (724 lines), `web-api.ts` (2,061), `do.ts` (3,511 vs glyphdown's 859), and the e2e drivers (32k lines across about 70 files) carry every patched race. Re-implement them small, from glyphdown's shape plus the specific fixes listed here.
- **Two patches become one.** At Lexical 0.48 the `@lexical/yjs` patch is obsolete (§2.2). The y-partyserver patch is still required: 2.2.0 is still the latest release and still has every quirk (§2.1).
- **The official `CollaborationPlugin` (0.48) now covers most of what the custom binding hand-built.** Ruling 12 is feasible. Two requirements still force a thin extension: per-origin undo with derived-write exclusion, and color-claim-driven awareness (§3).

### Reuse matrix

| Item | Verdict | Where |
|---|---|---|
| y-partyserver@2.2.0 patch (`unload`→`pagehide`) | **Copy as-is** | `patches/y-partyserver@2.2.0.patch` (44 lines) |
| @lexical/yjs@0.45.0 patch (`__nodeFormat` alias, empty-root guard) | **Avoid**: obsolete at 0.48 | `patches/@lexical__yjs@0.45.0.patch` |
| `CollabBindingPlugin` | **Re-implement using as reference**, on top of the official 0.48 plugin/primitives | `apps/web/src/moss/collab/CollabBindingPlugin.tsx` |
| `WebCollabPlugins` | **Avoid as a unit**; harvest the terminal store, close-code handling and refusal adoption | `apps/web/src/moss/collab/WebCollabPlugins.tsx` |
| Provider factory | **Copy with modifications** | `apps/web/src/moss/collab/collab-provider.ts:53-69`, `collab-session.ts:32-77` |
| `collab-provider-hardening.ts` | **Copy as-is** | 59 lines |
| `channel-heartbeat.ts` | **Copy as-is** | 99 lines |
| `connection-truth.ts` | **Copy with modifications** (drop fallback-lane states) | 188 lines |
| `presence.ts` heartbeat + stale sweep | **Copy as-is** | `presence.ts:49-121, 577-658` |
| Color claiming | **Copy with modifications** | `presence.ts:124-545` |
| `remote-cursors.ts` | **Copy with modifications** (adapt to the official plugin's container/awareness path) | 389 lines |
| `excluded-properties.ts` | **Copy with modifications** (field list for 762abb777) | 49 lines |
| `title-crdt.ts`, `frontmatter-crdt.ts`, `text-diff.ts` | **Copy with modifications** (one module; delta-based caret remap) | `packages/core/src/` |
| Client `title-binding.ts` | **Re-implement using as reference** | 190 lines |
| DocDO persistence + compaction | **Re-implement from glyphdown `do.ts`**, keep `persistence.ts` pure helpers | `packages/sync/src/persistence.ts`, `do.ts:718-800, 1246-1276` |
| Server seed (empty paragraph) | **Copy with modifications** | `packages/sync/src/normalize.ts:93-133` |
| Title→D1 projection | **Copy with modifications** (also project filename) | `do.ts:932-1015` |
| Per-frame gate order | **Re-implement using as reference** | `do.ts:1411-1540` |
| Revocation-after-wake frame hold | **Avoid**; make revocation state durable instead | `do.ts:1788-1910`, `grant-gate.ts` |
| Per-frame size-cap simulation | **Avoid** (O(doc) per keystroke) | `limits.ts:160-178` |
| Sign-out socket severance | **Copy with modifications** | `apps/web/src/api/auth-route.ts`, `session-collab.ts`, `sync/src/session-registry.ts` |
| CLI push structural merge | **Re-implement**: keep block 3-way merge and contract, land through the recursive reconcile | `packages/core/src/merge.ts`, `sync/src/push.ts` |
| Identity-preserving restore reconcile | **Copy with modifications** | `packages/core/src/tree-markdown.ts:128-472` |
| Server "twin" nodes and transformers | **Avoid** | `packages/core/src/moss-server-*.ts` (3,856 lines) |
| Converter parity harness | **Copy with modifications** | `scripts/generate-desktop-transformer-oracle.mjs`, `packages/core/test/converter-*` |
| `roles.ts` | **Copy as-is** | `packages/core/src/roles.ts` |
| Role resolution (`resolveDocRole`, grants, anonymous ceiling) | **Re-implement using as reference**, one resolver | `apps/web/src/api/share-links.ts`, `docs.ts:322` |
| `auth.ts` (better-auth, SEC-4) | **Copy with modifications** | `apps/web/src/auth.ts` |
| `server.ts` | **Copy with modifications** | `apps/web/src/server.ts` |
| D1 schema | **Copy with modifications**; regenerate migrations | `apps/web/src/db/schema.ts`, `apps/web/drizzle/` |
| `web-api.ts` (electronAPI shim) | **Re-implement using as reference**, starting from moss's own story bridge | `apps/web/src/moss/web-api.ts` |
| `web-affordances.ts` | **Copy with modifications** (ruling 4 un-hides two items) | 151 lines |
| Port conventions | **Copy** the header and divergence marker; fix the mixed pins | §15 |
| `dev-server.sh` + `local-stack-*.mjs` | **Re-implement** the core recipe in about 150 lines | `scripts/local-stack-control.mjs:85-265` |
| `seed-local-principals.mjs` | **Copy with modifications** | 256 lines |
| e2e drivers | **Avoid as files**; harvest helpers and the journey specs | §17 |
| CI workflow | **Re-implement**; the old one only ran converter parity | `.github/workflows/converter-parity.yml` |

---

## 1. Ground rules for using this answer key

1. **Re-derive anything that touches Lexical internals against 0.48.0.** The old build forced `lexical`/`@lexical/*` to 0.45.0 through pnpm overrides (`package.json` "pnpm.overrides"). Moss at 762abb777 resolves every `@lexical/*` to **0.48.0** (`.refs/moss/pnpm-lock.yaml`), including packages that did not exist at 0.45: `@lexical/code-core`, `@lexical/code-prism`, `@lexical/extension`, `@lexical/internal`, `@lexical/dragon`, `@lexical/hashtag`, `@lexical/overflow`, `@lexical/plain-text`, `@lexical/text`, `@lexical/devtools-core`.
2. **Moss node shapes changed.** At 762abb777, `FormulaNode` fields are `__formula, __result, __formulaId, __name, __stale, __commentIds` (no `__format`; `.refs/moss/packages/desktop/src/renderer/editor/nodes/FormulaNode.tsx:127-132`). `TabGroupNode` has `__activeIndex` and `__tabWidths` (`TabGroupNode.tsx:31-34`). Most decorator nodes now carry `__commentIds` (moss's own comment association).
3. **Strip the ticket archaeology.** Old files carry long narrative comments naming defects (B1-T4-fix1, TITLE-CREATE-CONCAT…). LEARNINGS §6 rates that as an anti-pattern. When copying, keep the behavior and a one-line why, and drop the history.
4. **Delete migration paths.** The old DO carries one-time migrations from earlier eras (`normalizeM0TreeOnce`, title/frontmatter seeding from `doc_meta`, the search re-feed version flag; `do.ts:754-790, 802-930`). moss-multi has no legacy data, so none of that is needed.

---

## 2. Patches

### 2.1 `patches/y-partyserver@2.2.0.patch`: copy as-is

- **What it does.** It swaps `window.addEventListener("unload", …)` for `"pagehide"` (and the matching remove) in both `dist/provider/index.cjs` and `dist/provider/index.js`. That is 4 hunks in 44 lines.
- **Still needed.** y-partyserver **2.2.0 is still the latest npm release**, and its provider still registers `unload` (`dist/provider/index.js:301`). Chrome reports the `unload` handler as a permissions-policy violation, which breaks the zero-console-error invariant (LEARNINGS §7.3).
- **Wire it the same way:** `pnpm.patchedDependencies["y-partyserver@2.2.0"]`.
- **The rest of the 2.2.0 quirks are still present** at the same lines, so the runtime hardening in §4 remains necessary:
  - awareness is broadcast on `change`, not `update` (`:304`);
  - `awareness._checkInterval` is cleared (`:305`);
  - there is no message-timeout sweep;
  - `disconnect()` calls `ws.close()` without a code (`:390`);
  - only `__YPS:`-prefixed string frames reach `custom-message` (`:102`);
  - the constructor auto-connects unless `connect:false` (`:253`).

### 2.2 `patches/@lexical__yjs@0.45.0.patch`: avoid (drop at 0.48)

The patch is 218 lines because it edits every `dist` flavor plus `src/`. It makes two changes:

| Change | Why it existed | Status at 0.48.0 |
|---|---|---|
| `$ensureEditorNotEmpty()` scheduled after every remote fold → only when `root.getChildrenSize() === 0` (`src/SyncEditorStates.ts` hunk, patch lines 139-157) | Lexical #343 cascade under concurrent typing (LEARNINGS §4.2) | **Fixed upstream.** 0.48 `SyncEditorStates.ts:228-233` already guards with `if (binding.root.isEmpty())`. |
| `__format` serialized on the wire as `__nodeFormat` (`src/Utils.ts` hunk, patch lines 158-218) | A frame scanner treated `__format` as forbidden because FormulaNode's local `__format` was excluded, so a type-specific exclusion could not stop Paragraph/Text `__format` from appearing (`docs/acceptance/rubric-runs/diagnosis/m1-format-leak-20260723/MECHANISM.md`) | **Obsolete.** FormulaNode has no `__format` at 762abb777. Paragraph and Text `__format` is *legitimate shared state* (alignment, marks). The alias also made the wire format non-standard, which hurts portability back to moss. |

Two LEARNINGS facts still hold at 0.48 and must stay as rules:

- `syncLexicalUpdateToYjs` still returns early for `HISTORIC_TAG` and `COLLABORATION_TAG` (0.48 `SyncEditorStates.ts:378`). **Never use `HISTORIC_TAG` to exclude a local write from undo.**
- `@lexical/markdown` 0.48 still enqueues an untagged follow-up `editor.update` from its shortcut listener (`MarkdownShortcuts.ts:596`). It does skip `COLLABORATION_TAG`/`HISTORIC_TAG` updates and requires `dirtyLeaves.has(anchorKey)` (`:542, :579`), so the old cascade is probably gone. The old workaround, `CollabMarkdownShortcutPlugin.tsx` (100 lines), monkey-patches `editor.update`/`registerUpdateListener`. **Do not port it.** Prove the need first with a two-tab concurrent-typing stress run on 0.48.

---

## 3. The binding: `CollabBindingPlugin` and `WebCollabPlugins`

### 3.1 What the old custom binding did (`CollabBindingPlugin.tsx`, 266 lines)

| Lines | Behavior | Keep? |
|---|---|---|
| 79-93 | One `Y.Doc` + docMap + provider + `createBinding(editor, provider, docId, doc, docMap, excludedProperties)` per `(editor, docId)` | yes (official does this) |
| 99 | `attachRemoteCursors(editor, binding, provider)` in the **main** effect, never in the role-gated one, so viewers see carets | yes |
| 103-123 | Yjs→Lexical: `observeDeep` on root; skip origins `binding`, `DERIVED_ORIGIN`, `CONTEXT_MARK_ORIGIN`; pass the cursor-sync fn | official skips only `binding`; derived/context origins are the extension |
| 127-145 | Lexical→Yjs: skip `SKIP_COLLAB_TAG`; wrap `syncLexicalUpdateToYjs` in `transactCollabUpdate` (outer `doc.transact` with a derived/context origin) | the extension |
| 147-178 | Bootstrap only after the first `sync` and only if both editor and shared root are empty | replace with server seed + `shouldBootstrap:false` |
| 182 | The single explicit `provider.connect()` (factory built with `connect:false`) | official does this |
| 184-199 | Teardown order: cursors → listeners → clear awareness → `disconnect` → `doc.destroy()` | yes |
| 205-254 | Awareness identity: focus tracking, color claim, 4s identity heartbeat, 2s stale sweep | yes (§4) |
| 258-263 | `createPerOriginUndo` admitted only when the role allows editing, without recreating the provider | yes |

### 3.2 What the official 0.48 `CollaborationPlugin` now gives you

Verified in `@lexical/react@0.48.0/src/LexicalCollaborationPlugin.tsx` and `src/shared/useYjsCollaboration.tsx`:

- **Props.**
  - `excludedProperties`, `cursorsContainerRef`, and `syncCursorPositionsFn`.
  - `awarenessData`, `username`/`cursorColor` (through `useCollaborationContext`), `selectionHighlight` (CSS Highlights), and `rootName`.
  - Binding comes from `createYjsBinding({doc, docMap, editor, excludedProperties, id, rootName})`.
- **Lifecycle.**
  - It calls `provider.connect()` exactly once per effect and disconnects on cleanup, with a StrictMode workaround.
  - It **clears awareness on `beforeunload` and `pagehide`** (the upstream ghost-cursor fix, facebook/lexical#8061).
  - Bootstrap happens only on the first `sync` when root and XmlText are empty.
- **Undo.** `useYjsHistory` always builds `createUndoManager(binding, root)`, which uses `trackedOrigins: new Set([binding, null])` and Yjs's **default captureTimeout (500ms)**. Neither is configurable. It publishes the manager under `Symbol.for('@lexical/yjs/UndoManager')`.
- **Cursors.** Awareness `update` calls the **library** `syncCursorPositions(binding, provider, {selectionHighlight})` directly (`useAwareness`), *not* your `syncCursorPositionsFn`. That prop is used only on the Yjs-change path.
- **Context requirement.** The plugin must sit inside a `LexicalCollaboration` provider; its `yjsDocMap` lives in context.
- **V2.** `CollaborationPluginV2__EXPERIMENTAL` uses an `XmlElement` root (`'root-v2'`) and is not wire-compatible with V1. Stay on V1, which is what every old test and the server headless binding use.

### 3.3 Gap analysis against PRODUCT and LEARNINGS

| Requirement | Official 0.48 | Needed extension |
|---|---|---|
| Cmd+Z undoes only your own edits; programmatic writes create no undo step (PRODUCT); `captureTimeout` 1000ms (LEARNINGS §4.3) | Undo tracks `binding` **and `null`**; 500ms; derived writes ride the `binding` origin | Own the undo manager. Either compose from `@lexical/yjs` exports (`createYjsBinding`, `syncLexicalUpdateToYjs`, `syncYjsChangesToLexical`, `syncCursorPositions`), as the old plugin did, or run the official plugin and replace its `UNDO_COMMAND`/`REDO_COMMAND` handlers at higher priority with a per-origin manager. The old approach: `per-origin-undo.ts:40-52` maps `HISTORY_MERGE_TAG` writes to `DERIVED_ORIGIN` and context marks to `CONTEXT_MARK_ORIGIN` by wrapping the sync in an outer `doc.transact(run, ORIGIN)`. A nested transact inherits the outer origin, which is the trick that lets one listener retag. `trackedOrigins = {binding}`, captureTimeout 1000ms, undo applied under `[HISTORIC_TAG, SKIP_COLLAB_TAG]` (`:58-107`). Note that you cannot wrap the official plugin's listener, so retagging derived writes forces the compose-from-primitives route. |
| Colors claimed per client and stable (PRODUCT) | `cursorColor` and `username` are effect deps of `useProvider`. Changing them **disconnects and reconnects the socket** and re-runs `initLocalState`, which overwrites local awareness. | Pass fixed initial values, and drive later color changes by writing awareness directly (the old `republishLocalAwarenessIdentity`). Publish top-level `name`/`color`/`focusing` authoritatively, because the official awareness path reads top-level fields. |
| Name label shown while typing, Bot badge for agents | The library renders a static name span | Post-sync decoration (`remote-cursors.ts:208-232`) plus CSS; see §4.4 |
| Split view: two panes must not share one binding context (LEARNINGS §4.3) | `yjsDocMap` lives in `LexicalCollaboration` context | Wrap **each editor pane** in its own `LexicalCollaboration`. Never wrap the whole app (old `MossAppHost` mistake). |
| Render only after first sync; no client bootstrap (LEARNINGS §4.3, ruling 2) | Supported (`shouldBootstrap:false`) | Initial config `editorState: null` in collab mode. In moss 762abb777 this is the `editorState` key in `MarkdownEditor.tsx:7664-7724`, which today imports markdown or a cached serialized state. Bypass `readMarkdownEditorStateCache` for bound docs (the Lexical #38 lesson). |

**Recommendation.** Write a ~200-line `MossCollaborationPlugin` composed from the public `@lexical/yjs` 0.48 primitives, mirroring `useYjsCollaboration.tsx` line for line, with three deliberate deltas:

1. Per-origin undo with derived-origin retagging and a 1000ms capture timeout.
2. Origin skipping for `DERIVED_ORIGIN` and `CONTEXT_MARK_ORIGIN` on the Yjs→Lexical path, so the binding does not fold its own derived writes back (the table "Insert row adds 2 rows" bug, LEARNINGS §4.3).
3. Awareness through the presence layer (§4).

Use the official file as the diff base, so ruling 12's "extended only where a requirement forces it" stays auditable.

**Seam in moss 762abb777.** `MarkdownEditor.tsx:8076` renders `<HistoryPlugin />`. The old port replaced exactly that line with `{COLLAB_ENABLED ? <WebCollabPlugins …/> : <HistoryPlugin />}` (`apps/web/src/renderer/editor/MarkdownEditor.tsx:7955`). Note that moss keys the composer on `${noteId}-${readOnly ? 'locked' : 'edit'}` (`:8053`), so a role change remounts the binding.

### 3.4 `WebCollabPlugins.tsx` (724 lines): avoid as a unit

It is the accretion point of every race family: a REST seed hydrated and then neutralized (`:490-510`), a 4s first-sync watchdog (`:535-555`), a fallback local lane with lock and detached probe (`:564-640`), a binding remounted per generation (`:642-654`), terminal handling (`:270-424`), and connection-truth wiring (`:217-235`).

PRODUCT now needs only brief-blip buffering, which a bound Y.Doc already gives, plus "no field focusable before bind" (ruling 2). So drop:

- REST seed and neutralize: render nothing editable until first sync.
- The fallback lane, the probe provider, and `bindingGeneration` remounts.
- The REST durability lane: `flushCollabDoc`, `/state-vector`, `/yupdate`, and the `pagehide` beacon (`collab-session.ts:215-347`). This lane caused the B0-TRASH-YUPDATE-401 family; the socket plus per-update DO persistence is the single write path.
- `stableUpdatedAt` freezing (`collab-session.ts:125-136`). It is unnecessary once no REST response can re-key a bound editor.

Harvest these:

- **Doc-level terminal store.** `collab-terminal.ts` (86 lines) uses `useSyncExternalStore` keyed by docId with reasons `doc-deleted | session-ended | access-revoked`, and every editable surface subscribes to it (LEARNINGS §4.6). Copy with modifications.
- **Close-code dispatch.**
  - 4410 and 4402 are terminal immediately. Flip `provider.shouldConnect=false` **synchronously** inside `connection-close` before y-partyserver schedules a reconnect (`:381-394`).
  - 4403 is a *prompt* to re-ask the server over REST: a lower role means demotion, none means revocation (`:270-299`).
  - A refused handshake (closed before ever opening) is re-asked once, never retried forever (`:300-379`, `access-revocation.ts` 93 lines).
- **Unicast write refusal adoption.** `parseWriteRefusal` → adopt the server's role (`:262-269`, `write-refusal.ts`).
- **Input phase.** `selectCollabInputPhase` (`pending-input-gate.ts`) publishes `data-collab-input-state=live|preparing|refused` on the root. Keep the attribute; drop the hold-and-replay machinery (`CollabInputGatePlugin.tsx`, 597 lines). Under ruling 2 the surface is simply non-focusable until live.
- **Presence chips portalled into a per-doc top-bar slot.** `top-bar-presence-slot.ts` (98 lines) lets chips live in moss's top chrome, never over the canvas, while the provider lives inside the composer.

---

## 4. Provider hardening, heartbeat, presence, cursors, colors

### 4.1 Provider factory: copy with modifications

- **`collab-provider.ts:53-69`.** `createYPartyProviderFactory({YProvider, host, party, connect, resyncInterval, params})` returns the exact `(id, docMap) => Provider` shape `@lexical/yjs` wants. `params` is a **function re-read on every reconnect**, so a revoked share token is refused at the next upgrade.
- **`collab-session.ts:32-51`** builds the base factory:
  - `party: 'doc-d-o'`, `connect:false`;
  - `resyncInterval: 4000` (the heartbeat ping);
  - `params: () => share ? {share} : {}`.
- **`:57-77`** wraps it with `hardenCollabProvider` and `trackCollabSocket`, a registry of live sockets so sign-out can sever them in-window (`live-sockets.ts`).
- **Modifications.** Drop `registerCollabDoc` and the beacon; drop the probe factory (`:84-94`).

### 4.2 `collab-provider-hardening.ts` (59 lines): copy as-is

- **`rewireAwarenessHeartbeat` (`:26-45`).** It moves the provider's broadcast handler from awareness `change` to `update`, so same-payload renewals still go out. It filters `args[1] === provider` so two tabs do not echo forever, and unhooks on `destroy`.
- **`installNormalClosureTeardown` (`:48-54`).** `disconnect()` closes with **1000 'binding superseded'**.
- Both depend on y-partyserver internals (`_awarenessUpdateHandler`, `ws`, `shouldConnect`, `disconnectBc`). Pin y-partyserver to exactly 2.2.0.

### 4.3 `channel-heartbeat.ts` (99 lines): copy as-is

- Reads `provider.wsLastMessageReceived` every 4s. When more than 12s pass with no inbound frame on an OPEN socket, it reports `lost` and closes the socket with **4408 `channel-heartbeat-timeout`**, so y-partyserver reconnects.
- Reports only on change.
- This is the measured "about 13s half-open detection" (LEARNINGS §4.6). It depends on `resyncInterval` sending sync step 1, which the server always answers.
- **Pair it with** `connection-truth.ts` (188 lines): a reducer whose inputs are provider status plus heartbeat verdicts, with `navigator.onLine` recorded but never consulted (`:21-115`).
- **Modification.** Drop the fallback-lane fields from `selectConnectionBanner` (`:124-188`).

### 4.4 `presence.ts` (658 lines)

**Lifecycle half: copy as-is.**

| Piece | Lines | Contract |
|---|---|---|
| `PRESENCE_HEARTBEAT_MS = 4000`, `PRESENCE_SWEEP_MS = 2000`, `PRESENCE_STALE_MS = 12000` | 49-59 | Peers clear 8–14s after a hard sever |
| `findStaleAwarenessClientIds` / `startAwarenessStaleSweep` | 69-121 | Restores y-protocols' expiry that y-partyserver disables; uses `removeAwarenessStates(…, 'presence-stale-sweep')` |
| `republishLocalAwarenessIdentity` | 577-602 | Bumps the awareness clock **preserving** `anchorPos`/`focusPos`/`focusing`; never resurrects a cleared (null) state |
| `startAwarenessIdentityHeartbeat` | 604-644 | 4s re-announce. **Paused while hidden**, immediate re-announce on `visibilitychange` → visible. Fixes the "DO awareness map empty after hibernation" one-sided presence, which reproduced only on warm stacks after about 80s idle. |
| `clearLocalAwarenessIdentity` | 656-658 | `setLocalState(null)` before socket teardown |

**Color claiming (`:124-545`): copy with modifications.**

- 10-color palette (`:4-15`).
- The FNV-1a preferred slot is used only as a *seed* (`:142-150`).
- A claim is published in awareness with `colorSettled:false` for **500ms** (`PRESENCE_CLAIM_SETTLE_MS`, `:136`), then hardened.
- `claimBeats` (`:198-201`): settled beats provisional; ties go by UTF-16 `<` (never `localeCompare`).
- `claimPresenceColor` (`:234-295`): one color per principal across tabs → keep what is held unless a stronger rival wants the slot → first free slot (session memory, then identity color, then FNV walk) → overflow reuse.
- `presenceColorsFromAwarenessStates` (`:379-393`) is the **single color getter** for both chips and carets.
- `startPresenceColorClaim` (`:458-545`) republishes only when the claim moves and never while hidden.
- **Modifications.**
  - The palette hexes are raw Tailwind literals. LEARNINGS §4.1 forbids raw color literals, so move them into moss DS tokens, with per-fill initial ink at 4.5:1 or better.
  - Make the claim write top-level `color` as the authority, because the official cursor path reads top-level fields (§3.3).
  - `buildAwarenessUser` (`:395-405`) shape `{id, name, color, colorSettled, type}` is fine; `type:'agent'` drives the Bot badge.

### 4.5 `remote-cursors.ts` (389 lines): copy with modifications

- **What it solved.** The old binding never set `binding.cursorsContainer` and never re-synced on awareness, so no caret DOM ever existed.
- **`attachRemoteCursors` (`:284-389`).**
  - Mounts a pointer-transparent overlay as a **sibling of the editor root**, making the parent `position:relative` if static. That parent is the `offsetParent` `updateCursor` measures against, so carets scroll with the content.
  - Subscribes awareness `change`, doc `update`, window `resize`, and a `ResizeObserver`.
  - Coalesces everything into one microtask `syncCursorPositions(binding, provider, {getAwarenessStates})`.
  - On destroy, clears `binding.cursors`.
- **`withCursorIdentity` / `cursorAwarenessStates` (`:106-150`)** lift the typed `user` field into top-level `name`/`color`. They set `focusing = identity && geometry`, which also clears a departed peer's caret on the same event as its chip.
- **`reconcileCursorIdentities` (`:154-170`)** drops cursors created before identity arrived, because the library caches name/color at creation.
- **`decorateAgentCursors` (`:208-232`)** adds the Bot glyph and an "(agent)" title.
- **`ensureCollaborationTheme` (`:235-245`)** sets `theme.collaboration` classes. Styles live in `remote-cursor-styles.ts` (102 lines, moss tokens).
- **Modifications for the official plugin.**
  - Use `cursorsContainerRef` pointing at the sibling overlay instead of assigning `binding.cursorsContainer` by hand.
  - Accept that the official awareness path renders from top-level fields, so publish those authoritatively; keep the coalesced pass for decoration.
  - 0.48 `syncCursorPositions` still accepts `{getAwarenessStates, selectionHighlight}` (`SyncCursors.ts:861-891`).
  - Add the "label visible while typing" behavior the old code did not implement. PRODUCT wants the label to show from the cursor while the peer types.

---

## 5. `excluded-properties.ts`: copy with modifications

- **The mechanism is right (`:17-28`).** `TypeAwareExcludedProperties extends Map<Klass, Set<string>>` falls back from `node.constructor` to `klass.getType()`. Lexical 0.48 still looks up by `node.constructor` (`Utils.ts:146-148`), so module duplication or node replacement would otherwise leak per-viewer fields.
- **`buildExcludedProperties` (`:30-49`)** throws if a listed type is not registered, which catches drift on the first write.
- **Field list for 762abb777.** Re-verify by scanning live frames with a positive control (`wire-exclusion.test.ts` shows the test shape):
  - `tab-group`: `__activeIndex`, `__tabWidths` (ruling 11)
  - `table`: `__colWidths`
  - `formula`: `__result`, `__stale`, and probably `__name` (derived; old list `:8`)
  - Collapsed headings are stored outside the node at the pin; confirm and keep them local.
- **Drop** `formula.__format`, which no longer exists, and the `__nodeFormat` alias.

---

## 6. Title and frontmatter CRDT

### 6.1 Server/shared primitives: copy with modifications

- **`packages/core/src/title-crdt.ts` (160 lines) and `frontmatter-crdt.ts` (140 lines)** are near-identical.
  - `Y.Text` under the reserved root keys `'title'` and `'frontmatter'`, siblings of `'root'`.
  - `write*` (`title-crdt.ts:68-77`) applies the **minimal LCS edit script** via `diffTextToOps`, in one transaction with an origin, and is a no-op when unchanged (so observers and projections never fire on echoes).
  - `observe*` passes the transaction origin so the caller can skip its own echo.
- **`text-diff.ts` (225 lines): copy as-is.**
  - Prefix/suffix trim, then exact char LCS under a **4M-cell budget**, falling back to line-level LCS and finally to coarse replace.
  - The budget fixed a workerd OOM on 100KB pushes (`:16-28`).
- **Modifications.**
  - Merge the two modules into one `doc-fields.ts` (`readField/writeField/observeField(key)`).
  - Replace `remapCaretForTitle` (`title-crdt.ts:119-141`), which re-diffs strings and is ambiguous for repeated characters ("aa" → "aaa"), with a caret remap driven by the `YTextEvent.delta` the observer already receives, or by `Y.RelativePosition`.

### 6.2 DO-side title rules (`do.ts:845-1015`)

**Copy with modifications:**

- Never seed the placeholder "Untitled" as CRDT text (`:850-856`).
- Projection to D1 is **throttled to 750ms with a trailing flush, serialized on one promise chain, re-reads the type inside the chain, never clears the column on an empty title, and releases its claim on failure** (`:932-1015`).
- Skip projection for server-internal origins via `originPrincipalId(origin) === null` (`:932-934`).
- A list-surface rename is a request for a CRDT write: `POST /admin/title` → `writeDocTitle(doc, next, {principal})`, then an awaited projection (`:1964-1975`).

**Required modification (ruling 3).** The old projection updated only `docs.title`. moss-multi must also project `filename` (`<slug>.md`, unique per folder) in the same chained write, with the unique-index collision handling glyphdown uses.

**Open conflict to settle in the architecture.** The old markdown boundary composes `frontmatter\n\n# Title\n\nbody` and strips a leading H1 on import (`sync/src/normalize.ts:238-280`, `composeContent`/`stripDocPrefix`), which matches moss desktop's "H1 is the title" model (`MarkdownEditor.tsx` strips the leading H1 into the title field). Ruling 3 says the H1 in the body is ordinary content and the title projects to the filename. Decide which shape export, pull, and push use before porting these two functions.

### 6.3 Client `title-binding.ts` (190 lines): re-implement using as reference

- **Keep.** A binding is closed to writes until `adopt()` has read the type once and belongs to one `Y.Doc` instance (`bindDocTitle`/`isLive`, `:113-148`). That is the TITLE-BINDING-WARM-OWNER invariant.
- **Keep the local origin constant** `TITLE_LOCAL_ORIGIN` (`:61`) for echo skipping.
- **Drop `adopt(fallback)` seeding the type from field text.** Under ruling 2 the field cannot hold text before bind.
- **Field rendering** (`renderTitleIntoField`, `:154-163`) writes `textContent` and remaps the caret. Keep the approach with the delta-based remap.
- **The title input gate** (`title-input-gate.ts`, 361 lines) is superseded by ruling 2: the title is non-focusable until bound and synced. Keep only its WebKit bare-Backspace capture.

---

## 7. The DocDO (`packages/sync/src/do.ts`, 3,511 lines)

**Start the restart DO from glyphdown's `.refs/glyphdown/packages/sync/src/do.ts` (859 lines) and add the specific pieces below.** The old DO grew comment, suggestion, and version sidecars, migrations, notification triggers, R2 spill, and a frame-hold queue in one class.

### 7.1 Persistence and compaction: re-implement, reusing the pure helpers

| Concern | Old implementation | Verdict |
|---|---|---|
| Load | `onLoad` applies `ystate` chunks ordered by `idx`, then every `yupdates` row ordered by `seq`, under `PERSISTENCE_ORIGIN` (`do.ts:718-733`; glyphdown `:151-166`) | copy |
| Per-update persistence | `document.on('update')` INSERTs each update immediately unless origin is persistence, then `maybeCompact` (`:739-745`) | copy |
| Compaction trigger | more than 500 rows or 1MB (`persistence.ts:27-28, 57-59`; `do.ts:1246-1254`) | copy |
| Compaction | old: replay the persisted log into a **fresh** Y.Doc and re-encode (`persistence.ts:131-146`); glyphdown: `encodeStateAsUpdate(this.document)` (`glyphdown do.ts:209-222`). Both preserve item identity; both swap chunks atomically in `ctx.storage.transactionSync` | use glyphdown's (cheaper, no double memory) |
| Chunking | 1.5MB chunks under the 2MB DO SQLite row cap (`persistence.ts:31, 76-82`) | copy |
| `onSave` (y-partyserver debounced) | compact + feed search (`do.ts:1062-1067`) | copy |
| Derived body cache | `Y.XmlText.toString()` (`persistence.ts:100-111`) | **avoid**. This is the "[object Object]" source; always derive markdown through the shared exporter. |

**Restore-after-hibernation gate.** Load runs before any `onConnect` (YServer awaits `onLoad`), so a woken DO serves the persisted tree. Keep LEARNINGS' permanent gate: push → compact → simulated cold restart → reopen shows content.

### 7.2 Server seed: copy with modifications

- `seedEmptyParagraph` (`normalize.ts:108-133`):
  1. hydrate a **mirror** doc bound to a headless editor;
  2. append one paragraph if the root is empty;
  3. diff from the hydration state vector;
  4. apply to the live doc under origin `'server-seed'`.
- It is idempotent by the empty-tree guard and called at the end of `onLoad` before any connection (`do.ts:1036-1040`).
- Clients then always use `shouldBootstrap:false`.
- This **mirror-hydrate → mutate headless → diff → apply-under-origin** pattern is the canonical way for the server to write the Lexical tree (also used by merge, restore, and suggestions). Make it one helper.

### 7.3 Connection admission and per-frame gates: re-implement using as reference

- **Order on `onConnect` (`:1279-1332`):**
  1. parse the trusted `x-moss-principal`/`x-moss-role`/`x-moss-session`/`x-moss-share` headers;
  2. close 4401 if there is no principal;
  3. close 4402 for an ended session;
  4. close 4403 for a revoked share token;
  5. enforce the 50-connection cap (4429, counting *others*);
  6. `connection.setState(...)`;
  7. record the live socket;
  8. call `super.onConnect`.
- **Note:** the old code **awaits a D1 write** (`rememberLiveSocket`, `:1330-1356`) inside the upgrade. Fire it in the background (`waitUntil`) instead.
- **Order in `handleMessage` (`:1411-1517`):**
  1. session ended → close 4402;
  2. grant revoked → close 4403;
  3. (grant proof hold, see §7.4);
  4. string frames → super;
  5. peek the varint: non-sync or syncStep1 → super;
  6. content frame below the write floor → **unicast refusal** (`refuseContentWrite`, `:1542-1556`, wrapped `__YPS:{…}` so the provider surfaces it as `custom-message`);
  7. per-connection rate limit (300 frames / 5s, silently dropped as flood control, `limits.ts:59-60`);
  8. size cap;
  9. suggester vetting;
  10. super.
- **Keep:** the layer order, the `__YPS:` envelope, the "refused loudly" contract, and the role helpers in `role-gate.ts` (`CONTENT_WRITE_FLOOR='editor'`, `contentFrameDisposition`, `:32-118`).
- **Attribution by origin.** y-partyserver applies remote updates with `transaction.origin === connection` (glyphdown `enforce.ts:6-12` verifies this). The old `originPrincipalId` (`do.ts:3033`) maps origins to principals for projection, auto-snapshot authorship, and `touchDocModifiedAt` (throttled 5s, `:3000-3031`). Copy that idea.

### 7.4 Revocation after wake: avoid the mechanism, keep the test

The defect: after eviction the in-memory revoked-token set was empty, and the first frame from a socket on a revoked link merged before the D1 sweep answered.

The old fix holds unproven frames per socket in arrival order, with a deadline, a cap, and fail-closed backoff: `do.ts:1788-1910` plus `grant-gate.ts` (274 lines) and `session-gate.ts` (110 lines). It is correct but intricate.

**Simpler shape for the restart:**

1. Persist revoked tokens and ended sessions in **DO SQLite** (they are cheap; tokens are never reissued), so wake does not forget them.
2. Make revoke, sign-out, and demote fan-outs **awaited RPC calls** to the DocDO before the REST call returns success. Retry, or fail the revoke loudly, if a DO does not acknowledge.
3. Keep a periodic D1 sweep only as a backstop.
4. Persist connection state through partyserver's `connection.setState` (hibernation-safe), which glyphdown already does (`glyphdown do.ts:225-234`).

Keep the regression test: a heartbeat-free client against an evicted DO, comparing warm and cold.

### 7.5 Limits

- Connection cap 50 (`limits.ts:23`), doc cap 2MB (`:26`), push rate 60/min/identity (`push.ts:46-48`), named-version caps (`limits.ts:40-49`): **copy**.
- **Avoid** `updateExceedsDocCap` (`limits.ts:160-178`). It runs `encodeStateAsUpdate(this.document)`, applies it plus the frame into a scratch doc, and re-encodes **for every content frame**, which is O(doc) per keystroke. Keep a cached encoded-size estimate updated on each persisted update, and simulate only when `cached + update.byteLength` crosses the cap.

### 7.6 Internal admin calls

The Worker calls `POST /admin/session-ended|doc-deleted|title|recheck` on the DO stub with trusted headers carrying role `owner` (`do.ts:1927-2019`). Public `/parties/doc-d-o/<id>/...` paths cannot match `pathname === '/admin/...'`, so this is safe today, but only by URL coincidence. **Use Durable Object RPC methods** for internal calls instead of HTTP plus trusted headers.

---

## 8. Structural merge for CLI push, and restore

### 8.1 What exists

- **`packages/core/src/merge.ts` (779 lines).** `mergePush(liveDoc, base, pushed)`:
  - **fast path** when the live tree equals the base;
  - **block-level 3-way merge** otherwise (`threeWayMergeBlocks`, `:323-450`), using LCS on whole-subtree signatures;
  - a divergent replacement keeps the live block and returns the pushed block verbatim in `failedHunks` (CLI exit 2);
  - the **degenerate guard** refuses when a drifted push deletes more than 60% of base characters (`deletedCharRatio`, `:45-69`).
- **`splitTopLevelMarkdown` (`:233-261`)** tracks backtick fences *and* `:::` container depth. This fixed the lost-tabs bug.
- **`sync/src/push.ts` (409 lines).** The glyphdown §8.3 contract:
  - content-addressed base cache, durable in DO SQLite with a 14-day TTL (`base-store.ts`, 223 lines);
  - 60/min/identity limiter;
  - 2MB body guard;
  - typed results `degenerate` (exit 3), `base-missing` (re-send), `rate-limited`, `too-large`, `forbidden`, `unsupported-node` (409);
  - CRLF→LF at the boundary.

### 8.2 The weakness

`landMerged` (`merge.ts:514-595`) aligns **top-level blocks only** and **removes and re-inserts any changed block wholesale**. It does not diff characters inside changed text, despite LEARNINGS §4.16 describing that. Consequences:

- An agent editing one word in a paragraph, list, or table replaces the whole block.
- RelativePosition anchors in that block are lost.
- A human typing in that block concurrently loses the in-flight keystrokes, because inserts into a deleted Yjs item vanish.

This violates "pushes merge into the live doc preserving concurrent human work".

### 8.3 The better primitive already exists: copy with modifications

The **history restore** path has an identity-preserving recursive reconcile (`packages/core/src/tree-markdown.ts`):

- **`$reconcileElementChildren` (`:285-372`).**
  - Tier 1: children whose whole-subtree signature matches stay untouched (`alignBySig` with prefix/suffix trim and an LCS budget, `:230-283`).
  - Tier 2: inside each gap, pair children by *identity signature* and update them in place (`node.updateFromJSON`). For text nodes, `@lexical/yjs` then diffs characters inside the same `Y.XmlText`.
  - It recurses into element children and only then removes or inserts what is left.
- **`restoreDocToTreeState` (`:419-472`).**
  1. Mirror-hydrate.
  2. Reconcile.
  3. **Verify** that the reconciled tree exports exactly the target markdown, otherwise fall back to a coarse `setEditorState` rebuild.
  4. Diff from the hydration state vector and apply under the origin in one transaction.

**Recommendation.** Keep `mergePush`'s 3-way block decision, base cache, guard, and failed-hunk contract, but **land the merged target through `$reconcileRootFromSerialized`**, not through `landMerged`. Then push, restore, and suggestion accept/reject all share one landing primitive (PRODUCT: "restore through the same structural-merge primitive as push"). Add the two LEARNINGS tests: a push during human typing in the same paragraph preserves both, and duplicate blocks keep positional identity.

---

## 9. Converter parity

### 9.1 Avoid: the server "twins"

`packages/core/src/moss-server-nodes.ts` (863), `moss-server-nodes-2.ts` (874), and `moss-server-transformers.ts` (2,119) are DOM-free reimplementations of moss nodes and transformers, registered in `headless-editor.ts:59-80` (`SERVER_NODES`). They are the drift source PRODUCT's "ONE converter everywhere" forbids.

The real fix is architectural: split moss's `MARKDOWN_EDITOR_NODES` (`.refs/moss/.../MarkdownEditor.tsx:4161-4190`) and `MARKDOWN_EDITOR_TRANSFORMERS` (`:4108`) out of the 8,000-line `MarkdownEditor.tsx` into a module that both the renderer and the DO import. Record that as one ported-file divergence.

### 9.2 Reusable: the drift-alarm harness, with modifications

- **`scripts/generate-desktop-transformer-oracle.mjs` (239 lines).** esbuild-bundles the **real** moss `MarkdownEditor.tsx` exports (`MARKDOWN_EDITOR_NODES`, `MARKDOWN_EDITOR_TRANSFORMERS`, `$postImportNormalize`, `normalizeMarkdownForImport`, `escape/unescapeHtmlEntities`) from a moss checkout at the pin.
  - Resolves moss's aliases with a small plugin (`@/`, `@moss/shared`, `@renderer`, `:73-111`).
  - Leaves `lexical`/`@lexical/*` external.
  - Uses the `.css: 'empty'` loader and dataurl loaders for images and fonts (`:113-146`).
  - Emits a committed, sha-stamped bundle plus an input manifest of every source file's sha256 (`desktop-transformer-oracle.input-manifest.json`, 7,662 lines).
  - It proved that **moss's real node and transformer set loads headless**, under jsdom in vitest.
- **`scripts/verify-desktop-transformer-oracle.mjs` (107 lines)** checks oracle integrity without a moss checkout.
- **`packages/core/test/converter-harness.ts` (101 lines).** Runs desktop and server conversions in headless editors and compares the **editor-state JSON** of import and round trip (minted ids scrubbed), never strings.
- **`converter-parity-corpus.ts` (225 lines).** 36 fixtures spanning every moss family.
- **`converter-roundtrip-fixtures.test.ts` plus `test/fixtures/h-23/*.md`.** Callout, canvas, chart, gfm-table, hr, html, tabs.
- **Modifications.**
  - With one converter, the comparison becomes "pinned moss at 762abb777" versus "our extracted shared module". That is a port-drift alarm, not a twin-drift alarm.
  - The generator requires `MOSS_ROOT` with `node_modules` at the pin. `.refs/moss` has no `node_modules` and `~/Code/moss` must not be built or switched, so generate in CI from a `git archive` of 762abb777, or bundle from our own ported copy.
  - Do not commit a 4.5MB generated bundle (`desktop-transformer-oracle.generated.mjs`); generate it in CI.
- **Add the gate LEARNINGS asks for:** a CLI-pushed doc renders identically to a UI-authored one, compared by `exportJSON` node types.

---

## 10. `roles.ts` and role resolution

- **`packages/core/src/roles.ts` (138 lines): copy as-is.**
  - `effectiveRole(grants)` is the MAX over `doc`, `containingFolder`, `containingVault`, and `shareLink`, with `isOwner` short-circuiting to owner.
  - `CAPABILITY_FLOORS` = `{view: viewer, comment: commenter, suggest: suggester, edit: editor, manage: owner}`; plus `can`/`authorize`.
  - `ROLES`, `roleAtLeast`, and `maxRole` live in `packages/protocol/src/identity.ts:49-60`.
  - Owner is never stored in membership tables.
- **Anonymous ceiling (`apps/web/src/api/share-links.ts:64-87`, `anonymousCeiling` at `:80`, applied at `:263`).** A cookie-less holder of any live link reads at **viewer**; sign-in lifts them to the link role. The link role is a ceiling, not a wall (LEARNINGS §4.10). Copy it.
- **Agents inherit their owner** (`effectiveUserId`, `principalIds`, `share-links.ts:49-72`). Copy.
- **Folder-chain grants** (`drizzleGrants` at `apps/web/src/api/roles-resolve.ts:60-140`, depth cap 32; `foldChainGrants` at `roles-resolve.ts:141`; `fetchAncestorChain` at `share-links.ts:89`; `resolveFolderRole` at `share-links.ts:278`). Reference.
- **Avoid the duplicate.** `resolveDocRole` exists twice: D1-backed in `share-links.ts:121` (used by `api/auth.ts` for REST and the WS upgrade, plus `resolveDocRoleFor` at `:180` and the trashed-owner read at `:150`), and as an injectable-grant fold in `api/docs.ts:322` (LEARNINGS: "two implementations; keep one"). Write one resolver, used by REST, the WS upgrade, and the client affordance helper (`collab-affordances.ts`, 124 lines, which hides controls below each capability floor).

---

## 11. `auth.ts` (better-auth on D1): copy with modifications

`apps/web/src/auth.ts` (254 lines):

- **`createAuth(env)` per request** (`:183-252`; D1 bindings are per invocation), drizzle adapter `provider:'sqlite'`.
- **SEC-4 fail-closed (`assertAuthFailsClosed`, `:152-173`).** On a non-loopback `BETTER_AUTH_URL` (`isProductionAuthUrl`, `:123-134`), it throws if `DEV_AUTH=1`, or if the secret is missing, the placeholder prefix, or shorter than 32 characters.
- **Only configured OAuth providers** (`availableSocialProviders`/`configuredSocialProviders`, `:92-114`). One helper feeds both server registration and the login page's buttons.
- **`emailAndPassword`** is always enabled, `requireEmailVerification:false` (no email provider), 12-character production floor (`:50-62`).
- **Plugins:** `deviceAuthorization({validateClient: id === 'moss-collab-cli'})` and `bearer()` (`:217-225`).
- **`user.create.after` → `ensureDefaultVault`** creates a "Home" vault (`:245-247`).
- **Agent keys** are `gd_sk_` + SHA-256 in `agents.key_hash` (`api/agent-keys.ts`, 168 lines).
- **Modifications.**
  - Drop the `SIGNUP_ALLOWED_EMAILS` allowlist hook (`:33-75, 234-241`); sign-up is open on staging.
  - Drop the `DEV_AUTH` affordances (ruling 7: no playground; use real per-run principals). Keep the SEC-4 guard for the secret.
  - Rename the CLI client id.
- **Keep the quirks.**
  - Sign-out must POST JSON `{}`.
  - Server-side `fetch` needs a same-origin `Origin` header or better-auth returns 403 `MISSING_OR_NULL_ORIGIN`. `seed-local-principals.mjs` stamps it.
  - Signing up an existing email returns 200 with a fake id.

---

## 12. `server.ts` routing: copy with modifications

`apps/web/src/server.ts` (125 lines) is glyphdown's `server.ts` (82 lines) plus four additions. Order:

1. **`/api/version`** → `buildProvenanceResponse` (`build-provenance.ts`: GET only, 405 otherwise, `no-store`).
2. `/api/dev-auth` (drop: ruling 7).
3. **`/api/auth/*`** → `handleAuthRoute`. This wraps better-auth so a successful **sign-out severs every live socket of that session before responding**:
   - `api/auth-route.ts:41-53` resolves the session *before* better-auth deletes it;
   - `api/session-collab.ts:49-82` does the fan-out through the `live_collab_sockets` registry and posts session-ended to each DocDO (4402).
4. **`/api/*`** → `handleApi` (`api/router.ts`, 1,229 lines).
5. **`/parties/*`.** Only party `doc-d-o` is client-reachable: `partyAuthPlan` (`protocol/src/routes.ts:145-151`) rejects SearchDO and HtmlDocDO publicly with 404. Then `authenticate(request, docId)` (`api/auth.ts:134-161`; share token from `?share=` because browser WebSockets cannot set headers). Then forward `new Request(request, {headers: trustedHeaders(auth, request.headers, shareToken)})`.
   - `trustedHeaders` (`api/auth.ts:203-226`) **copies all inbound headers** (so `Upgrade`/`Sec-WebSocket-*` survive) and deletes and re-sets `x-moss-principal|role|session|share`.
   - Then `routePartykitRequest`.
6. TanStack Start SSR (`createStartHandler(defaultStreamHandler)` inside `createServerEntry`).

Plus error capture through `waitUntil`, rethrowing.

**Modifications.**

- Strip **every** `x-moss-*` header by prefix, not by an explicit list.
- Add a real WebSocket-upgrade smoke test through workerd at M0 (the era-1 trap).
- Add real routes for docs and share links. The old app had only `/` and `/login`, and addressed notes as `/?initialNoteId=` (`routeTree.gen.ts`; `web-api.ts:499`), although `docShareUrl` minted `/d/<docId>?share=` (`routes.ts:154`).

---

## 13. D1 schema and migrations: copy schema with modifications, regenerate migrations

- **`apps/web/src/db/schema.ts` (388 lines)** is glyphdown's schema (`.refs/glyphdown/apps/web/src/db/schema.ts`, 425 lines; same table set, and the folders, docs, member and share_links definitions match column for column) plus two tables:
  - **`vault_members`** (`:220-247`). A vault grant, kept separate from `folder_members` so the containing-vault role is its own source.
  - **`live_collab_sockets`** (`:249-262`): `(session_id, doc_id, connection_id)` PK, `doc_id` index, **deliberately no FK to `session`**, because better-auth deletes the session row before the fan-out reads it.
- **Tables:**
  - better-auth: `user`, `session`, `account`, `verification`, `device_code`;
  - `agents`;
  - `folders`: `kind` folder|vault; `parent_id` NULL ⟺ vault; vault names unique per owner, case-insensitive (partial index);
  - `docs`: `filename` canonical with partial unique indexes per folder and per owner-root among live docs; `deleted_at`;
  - `doc_members`, `folder_members`; `share_links` (target doc|folder|asset, revocable);
  - `assets`, `content_objects` (sha256, refcount), `asset_versions`;
  - `invites`, `user_prefs`, `feedback`, `notifications`.
- **Timestamps** are epoch milliseconds. Moss's bridge expects **seconds**; convert at the shim (`web-api.ts:2011` `msToSeconds`).
- **Migrations** (`apps/web/drizzle/0000_init.sql` 269 lines, `0001_vault_members.sql`, `0002_live_collab_sockets.sql`) were **hand-authored**, with no `drizzle/meta` journal. They drifted from `schema.ts`: `asset_versions.asset_id` has no FK cascade in SQL (`0000_init.sql:182-196`) although the schema declared one. That made asset delete return 500 (LEARNINGS §4.8).
- **Restart:**
  - Generate migrations with `drizzle-kit generate` from the schema.
  - Add the LEARNINGS test that every `references(...onDelete)` appears in migration DDL.
  - Use `PRAGMA defer_foreign_keys=ON` in test cleanup batches.
  - Decide whether `docs.title` stays (ruling 3 makes it a DO-maintained projection next to `filename`).
- **Folder delete.** The old code soft-deleted the docs subtree and re-homed docs (`api/folders.ts:578-602`) while hard-deleting folder rows. Glyphdown promotes children. PRODUCT requires delete-to-trash of a subtree, so keep the moss-collab semantics.

---

## 14. `web-api.ts` (the electronAPI shim) and the affordance registry

### 14.1 `apps/web/src/moss/web-api.ts` (2,061 lines): re-implement using as reference

- **Lineage.** Header `ported-from: packages/desktop/stories/utils/story-data.tsx`. Moss's own Ladle mock bridge proves the renderer needs only a `window.electronAPI` object. At 762abb777 that file is `.refs/moss/packages/desktop/stories/utils/story-data.tsx` (497 lines), and the type surface is `packages/desktop/src/types/electron-api.d.ts` (430 lines).
- **Shape.** A `class WebAPI implements ElectronAPI` (`:218`), about 18 namespaces (`:320-680`): `notes`, `folders`, `agent` (rejects), `files`, `images` (`pick→[]`, `save` throws), `htmlPreview`/`webEmbedPreview` (`ensure → null`), `system`, `filesystem`, `grantedDirs`, `settings`, `appConfig`, and others.
- **What to avoid:**
  - `notes.update(id, {content})` pushing markdown for bound docs (`:682-776`, `pushContent`);
  - per-doc **watch sockets** `/api/doc/:id/ws` beside the collab socket (`:1536-1650`); this was the "WebSocket is closed before the connection is established" churn source;
  - the **2.5s workspace metadata poll** (`WORKSPACE_META_POLL_MS`, `:79`; `:1395-1420`);
  - `onDiskChange` emissions that remount the editor;
  - read holds and withdrawn sets layered on top (`:254-303, :1766-1800`).
- **Restart shape.**
  - For any bound doc the Y.Doc is the only content source. `notes.update` with content for a bound doc is a no-op, or a refused write with an announcement.
  - Content reads for open docs never come from REST.
  - Workspace metadata (titles, filenames, folders, trash) comes over a **push channel** (a per-user or per-vault DO), not a poll.
  - Every stubbed platform method is listed in one checked inventory (LEARNINGS §4.1: `images.pick→[]`, `ensure→null` stubs shipped silently).
- **Small pieces worth keeping:** `msToSeconds` (`:2011`); `withShareHeader` / `shareTokenFromLocation` threading the share token into every doc, asset, and list read (`share-token.ts`); theme read/apply in localStorage `moss_theme` (`:2032-2045`); `buildFolderPaths` (`:1961-1993`).

### 14.2 `apps/web/src/moss/web-affordances.ts` (151 lines): copy with modifications

- **Shape.** One frozen registry `HIDDEN_WEB_AFFORDANCES` of `{id, surface, why, source}` (`:76-135`), split into the PRODUCT-ruled IDs (`:39-45`) and native-only IDs (`:54-59`), with `hiddenAffordance(id)` lookup and a drift test (`web-affordances.test.ts`).
- **Render sites** read it (for example `renderer/web-shell-affordances.ts`, 40 lines).
- **Modifications (ruling 4).**
  - Remove `native-open-in-new-window`: it becomes a browser tab.
  - Split `native-file-export` so **Save as PDF → `window.print`** works and Save as Markdown stays hidden.
  - Keep share-with-agent, the AI run action, connected folders, default `.md` editor, the ⌘N label, reveal-in-Finder, the workspace location picker, and external folder open.
  - The three items it deliberately leaves unlisted because nothing renders them (quick capture, auto-update, in-embed ⌘K; `:21-31`) stay unlisted only if that is still true at 762abb777. Re-check.
- **Why it matters:** the shim installs `window.electronAPI`, so moss's `hasElectronBridge` is **true** on web and native-only items render enabled.

---

## 15. How moss files were ported

- **Path map.**

  | moss | moss-collab | Files |
  |---|---|---|
  | `packages/desktop/src/renderer/**` | `apps/web/src/renderer/**` | 218 |
  | `packages/desktop/src/common/**` | `apps/web/src/common/**` | 31 |
  | `packages/desktop/src/types/electron-api.d.ts` | `apps/web/src/types/` | 1 |
  | `packages/shared/**` | `packages/shared/**` (package name `@moss/shared`) | about 75 |
  | `renderer/main.tsx` | `apps/web/src/client.tsx`, `routes/index.tsx`, `moss/MossAppHost.tsx` | 3 |
  | `renderer/index.html` | `routes/__root.tsx` | 1 |

  Root `tailwind.config.js`, `apps/web/tailwind.config.ts`, and test setup were ported as well. Web-only code lives in `apps/web/src/moss/**` (collab, auth, share, vaults, notifications, shell).
- **Header.** The first line of every ported file is `// ported-from: <moss path> @ <full sha>`. CSS uses `/* … */`; `package.json` uses a `"$comment"` key.
- **Divergence marker.** Inline `// WEB DIVERGENCE (<ticket>): <why>` at each modification.
- **Mixed pins (the defect).** 416 headers at 6a68c88f and 101 at 26df579d, so a mechanical re-pin was impossible. **Use one pin (762abb777) for every file.**
- **Web-only files in ported trees without headers** (`renderer/web-shell-affordances.ts`, `editor/workspace-formula-fanout.ts`, `editor/components/DecoratorErrorBoundary.tsx`, `editor/plugins/ContextMarkHistoryPlugin.tsx`, `editor/slash-commands/execute-slash-command.ts`). Keep web-only code out of mirrored directories.
- **Where the modifications concentrated.** Diff lines against moss at the file's own pin, measured here:

  | File | Changed lines |
  |---|---|
  | `panels/CanvasAreaContent.tsx` | 1,183 |
  | `App.tsx` | 276 |
  | `panels/NotesListPanelContent.tsx` | 213 |
  | `editor/MarkdownEditor.tsx` | 204 |
  | `prompt/PromptInput.tsx` | 50 |
  | `panels/SystemFolderSection.tsx` | 47 |
  | `panels/TrashedNotesPanelContent.tsx` | 45 |
  | `panels/FolderGroup.tsx` | 36 |
  | each decorator node | about 15–19 |
  | everything else | under 30 |

  CanvasAreaContent carried the title binding, title input gate, frontmatter binding, remount gate, save-failure toasts, share button, terminal state, phone shell, and timings, with readiness attributes `data-title-input`, `data-title-binding`, `data-moss-note-editor-root`, and `data-collab-terminal`. **Plan the note-view seam deliberately:** move the collab title, frontmatter, and terminal wiring into one web-owned hook that CanvasAreaContent calls, so the moss file stays near byte-identical.
- **Bootstrap pieces worth copying.**
  - `client.tsx`: Prism global install, then `prism-setup`, **before** `StartClient`.
  - `routes/__root.tsx`: all global CSS and fonts imported in the root route; `shellComponent`; inline theme-init script reading `moss_theme`.
  - `MossAppHost.tsx` (33 lines): `ClientOnly` + `ChunkReloadBoundary` + `lazy(boot)`, keeping `#root` sizing.
  - `packages/core/src/prism-global-install.ts` + `prism-globals.ts`: `globalThis.Prism` before grammar imports, also for workerd. Re-check against 0.48's `@lexical/code-core`/`code-prism` split.
- **Alias resolution.** Moss maps `^@/(.*)` → `packages/shared/src/$1` and `@moss/shared` → shared src in `vite.renderer.config.mts:36-40`. The old web `vite.config.ts` declares **no** aliases and relied on tsconfig `paths` (`apps/web/tsconfig.json:13-26`), while LEARNINGS §4.18 says Vite 8's client environment ignored aliases. Prove `@/` resolution in the first build.
- **Dedupe.** `resolve.dedupe` covers react, react-dom, jotai, jotai-family, lexical, prismjs, every `@lexical/*`, and yjs (`vite.config.ts:44-64`). Copy it.
- **Moss-absent surfaces built from the moss DS.** These are the reference for the DS-extension rule:
  - DS additions with stories in `packages/shared`: `components/ui/avatar.tsx` (437 lines: `AvatarChip`, `FacePile`, Bot badge), `banner.tsx` (118), `member-row.tsx` (87).
  - Web surfaces: `moss/auth/LoginCard.tsx` (229), `moss/share/ShareDialog.tsx` (479), `moss/vaults/VaultActionsMenu.tsx` (192), and `moss/notifications/ShareInviteNotice.tsx`.
  - Re-implement them against the 762abb777 DS, using these as interaction references.

---

## 16. Local stack scripts

### 16.1 `scripts/dev-server.sh` + `local-stack-*.mjs`: re-implement the core recipe

`dev-server.sh` (13 lines) only `exec`s `local-stack-control.mjs` (503 lines). That pulls in `local-stack-lib.mjs` (217), `local-stack-preflight.mjs` (846: admission locks, load gates, port registry, orphan reaper), and `host-admission-gate.mjs` (74). The working core is `start()` at `local-stack-control.mjs:85-265`:

1. `wrangler d1 migrations apply DB --local --persist-to <run>/cloudflare-state --config apps/web/wrangler.jsonc`.
2. `vite build --outDir <run>/vite-dist`. The Cloudflare plugin emits `vite-dist/server/index.js` plus `vite-dist/server/wrangler.json`. Then validate the bindings (`DB`, `ASSETS`, DocDO/SearchDO/HtmlDocDO) and hash the bundle.
3. Run wrangler dev with a fresh `BETTER_AUTH_SECRET` (`randomBytes(32)`) per run:

   ```
   wrangler dev <run>/vite-dist/server/index.js --no-bundle --local --ip 127.0.0.1 --port P \
     --inspector-port P+1000 --persist-to <run>/cloudflare-state \
     --config <run>/vite-dist/server/wrangler.json --cwd <run>/vite-dist/server \
     --show-interactive-dev-session=false \
     --var BETTER_AUTH_SECRET:<fresh 32-byte hex> --var BETTER_AUTH_URL:http://127.0.0.1:P \
     --var GITHUB_CLIENT_ID: … (blank OAuth/Resend/PostHog vars)
   ```

   Spawn it detached into its own process group, with logs to a file.
4. Wait until `GET /api/version` returns the commit captured at build time.
5. Record `{pid, gitSha, bundleSha256, node.arch}` in `<run>/server.json` (mode 0600).
6. Stop by killing the process group.

**Keep:** `--inspector-port P+1000` (the default 9229 collides across stacks), provenance-verified readiness, per-run persist dirs, and the process-group kill. **Drop:** the admission machinery, lane registries, `DEV_AUTH:1`, and `SIGNUP_ALLOWED_EMAILS`.

### 16.2 `scripts/seed-local-principals.mjs` (256 lines): copy with modifications

- `seed <runId> --count N` (1–20). Fixtures come from `principalFixtures` (`local-stack-lib.mjs:117-131`):
  - email `moss-<runId>-p<N>@example.invalid`;
  - name `Local <runId> principal <N>`;
  - password `Local!` plus a sha256-derived 24-hex string.
- It signs up via `POST /api/auth/sign-up/email`, then signs in, always with a same-origin `Origin` header, and writes `principals.json` (mode 0600) with cookies.
- `teardown` requires the stack to be stopped and runs `wrangler d1 execute --local "PRAGMA foreign_keys=ON; DELETE FROM user WHERE email IN (…)"` (`:34-70`).
- `smoke-local-stack.mjs` (201 lines) proves boot, auth, a D1 write, WebSocket 101, and cleanup.
- **Modifications.** Ruling 8 and ruling 5 require journeys to build content through the UI, so seeding should mint principals only. Keep deterministic passwords strictly local.

---

## 17. The e2e harness

### 17.1 What exists

`e2e/` holds about 70 `.mjs` drivers (32,434 lines): the append-only `b0-suite.mjs` → `v11` and `b1-suite.mjs` → `v9`, plus more than 40 single-defect probes. There is `e2e/evidence/` (run dumps) and `e2e/specs/` (15 journey specs, 154 lines total). All of it is standalone Playwright with a pinned Chrome for Testing 150.0.7871.187 binary path and WebKit.

### 17.2 Best final versions

There is no single good driver. Harvest from two.

**`e2e/b1-suite-v9.mjs` (1,512 lines): readiness-gated interaction helpers. Copy with modifications.**

- `poll` (`:121-138`).
- `measureEditorPoint` (`:145-156`): click inside the editor's own box, never an offset from another element.
- `readTitleGate` / `setTitle` / `editTitle` (`:161-195`): read `[aria-label="Note title"]` and `data-title-input`.
- `isBodyLive` / `bodyReady` / `readBodyGate` (`:232-316`): the four product-published facts `data-collab-input-state=live`, `contenteditable=true`, empty `data-collab-input-held`, and no `aria-busy`. Identity is witnessed by the rendered title, and a root-generation counter is kept on the driver's own window key.
- `typeBodyThroughGate` (`:318-375`): wait first, type once, never retry. If the root generation rose or fell mid-sentence, fail with the named defect.
- `signIn` with per-journey `DESTINATIONS` (`:377-476`).
- `waitForStableBox` (`:492-511`).
- `pileCentreHitTest` (`:782-806`): occlusion by `elementFromPoint`, never `isVisible`.
- `shareLinkReadback` (`:847-873`): read links from the rendered dialog in WebKit, where `clipboard.readText` fails.
- `clearLeftoverModalState` (`:898-921`).

**`e2e/b0-suite-v11.mjs` (1,519 lines): wire telemetry and fault injection. Copy with modifications.**

- `wire()` (`:267-318`): console errors, page errors, `/yupdate` request/response/failed census, DELETE/restore windows, and WebSocket create/close/error per actor.
- `cleanTelemetry` (`:320-326`).
- `sever()` (`:451-455`): **SIGSTOP/SIGCONT of the stack process group** for a true half-open drop.
- `verifyStack` (`:457-466`): `/api/version` commit equals the built commit.
- `cursorFacts` (`:424-440`).
- `waitForPeers` (`:442-449`): presence by the `Collaborators` list role.
- `flowJ1` (`:496-556`): the canonical two-person journey. Concurrent markers, caret and color equality, sever banner, no close frame during the sever, lossless recovery, prompt clear on close.

**`e2e/specs/*.md`: copy as journey definitions.** Concise rendered-UI contracts, for example `J1-two-person-co-editing.md`, `b1-live-revocation.md`, `b1-visitor-tier-a.md`, `presence-cursor.md`, `trash-lifecycle.md`. They already say "no request issued directly by the driver; network observation is evidence only."

### 17.3 What made drivers flaky

Design these out:

1. **Fixed-coordinate clicks at a pinned viewport.** v11 `createNote` clicks `(80,75)` then `(650,78)` at 1512×945 (`b0-suite-v11.mjs:357-379`).
2. **Fixed sleeps** (`waitForTimeout(1200)`) instead of waiting on product readiness attributes.
3. **Append-only hash-pinned copies.** A browser-path fix needed a `NODE_OPTIONS --import` shim that monkey-patched `chromium.launch` (`b0-arm64-chrome-shim.mjs`, 209 lines; `b0-suite-v11-arm64-native-chrome.mjs`). Nine b0 and nine b1 versions accumulated, and the board never went green.
4. **Rosetta-translated x64 Chrome.** v11 hard-coded `chrome-mac-x64` (`:43`), which split and dropped typed text that looked like product bugs.
5. **Product remounts mid-typing** (`updatedAt`-keyed refetch, warm-workspace formula fan-out). This is a product defect, but it presented as driver flake until the root-generation witness existed.
6. **Wrong targets:**
   - `[contenteditable=true].first()` types into the title;
   - counting `/api/doc/:id/ws` instead of `/parties/doc-d-o/:id`;
   - Playwright `isVisible` ignores occlusion;
   - extra headers do not ride WebSocket upgrades.
7. **One account standing in for two collaborators.** Presence de-duplicates by principal.
8. **One wrangler stack per flow** (`runFlow`, `:470-494`) and concurrent lanes on a loaded host. D1 7429 errors, daemon restarts, and quota deaths were misread as verdicts.
9. **Watch-socket churn** console noise needed allowlists (`:1066-1090`).
10. **Evidence directories wiped at run start.**

### 17.4 Restart fit

- **Remote CI (ruling 6)** can run one Playwright journey suite against `wrangler dev` on the vite build, Chromium plus WebKit, with drivers built from the helpers above.
- **Locally**, the same DOM-reading helpers (`readBodyGate`, `cursorFacts`, `pileCentreHitTest`) are plain `page.evaluate` bodies and port directly to bb Browser Automation DevBrowser scripts.
- `sever()` needs the stack PID, so expose it from the dev-stack script.

---

## 18. The CI workflow

- **`.github/workflows/converter-parity.yml` was the only CI.** Two jobs on `macos-14`, `actions/checkout@v6`, `actions/setup-node@v6` with `node-version: 22.23.1, architecture: arm64`, `pnpm/action-setup@v6`, `pnpm install --frozen-lockfile`:
  1. `oracle-integrity`: `node scripts/verify-desktop-transformer-oracle.mjs`.
  2. `converter-parity`: arm64 and Node ≥22.7 assertion; `@moss-collab/core` type-check; `vitest run` on the two converter test files.
- **No CI ran** web, sync, or cli unit suites, web type-check, the editor jest suite, or any e2e.
- **Restart: re-implement as a full pipeline.**
  - typecheck all workspaces;
  - unit tests per package, run serially;
  - converter drift alarm, with the oracle generated from a moss@762abb777 archive in CI;
  - schema/migration DDL parity;
  - Playwright journeys against the built Worker under `wrangler dev`, Chromium and WebKit.
- `ubuntu-latest` (x64, native) is cheaper than macOS and runs workerd and Chrome for Testing natively. The arm64-only rule was about avoiding Rosetta locally. Upload journey screenshots and telemetry as artifacts.

---

## 19. Dependency versions proven together

From `pnpm-lock.yaml` at 9104ceb. This set built, ran on `wrangler dev`, and passed real-browser journeys. Glyphdown@faf98d0 and moss@762abb777 are shown for comparison.

| Package | moss-collab (proven) | glyphdown | moss@762abb777 |
|---|---|---|---|
| @tanstack/react-start | 1.168.32 (spec `~1.168.0`) | 1.168.24 | – |
| @tanstack/react-router | 1.170.18 | 1.170.15 | – |
| @tanstack/router-plugin | 1.168.23 | – | – |
| @tanstack/start-plugin-core / start-server-core / start-client-core | 1.171.24 / 1.169.17 / 1.170.14 | – | – |
| @tanstack/react-start-server / -client | 1.167.22 / 1.168.16 | – | – |
| vite | 8.1.5 (rolldown 1.1.5); Ladle pulled vite 6.4.3 | 8.0.16 | 5.4.21 (desktop) |
| @vitejs/plugin-react | 4.7.0 | 6.0.2 | ^4.3.1 |
| @cloudflare/vite-plugin | 1.46.0 | 1.40.0 | – |
| wrangler | 4.113.0 | 4.98.0 | – |
| workerd | 1.20260721.1 (`@cloudflare/workerd-darwin-arm64`) | 1.20260603.1 | – |
| miniflare | 4.20260721.0 | – | – |
| @cloudflare/workers-types | 4.20260702.1 | – | – |
| better-auth | 1.6.23 (all `@better-auth/*` 1.6.23; better-call 1.3.7; kysely 0.29.4; jose 6.2.4) | 1.6.14 | – |
| drizzle-orm / drizzle-kit | 0.45.2 / 0.31.10 | 0.45.2 / ^0.31.10 | – |
| yjs | 13.6.31 (override) | 13.6.31 (override `^13.6.31`) | 13.6.27 (transitive) |
| y-protocols / lib0 | 1.0.7 / 0.2.117 | 1.0.7 | – |
| y-partyserver | 2.2.0 (patched) | 2.2.0 | – |
| partyserver | 0.5.8 | 0.5.6 | – |
| lexical + @lexical/* | **0.45.0** (override; moss was ^0.48) | – | **0.48.0** |
| react / react-dom | 19.2.8 | 19.2.7 | **19.3.0** |
| @base-ui/react | 1.6.0 | – | 1.6.0 |
| jotai / jotai-family | 2.20.2 / ^1.0.1 | – | 2.20.2 / ^1.1.0 |
| tailwindcss | 3.4.19 | 4.x | 3.4.19 |
| recharts | 3.10.0 | – | ^3.10.1 |
| lucide-react | 0.577.0 | 0.545.0 | ^0.577.0 |
| @floating-ui/react | 0.27.20 | – | ^0.27.20 |
| @fontsource-variable/inter / charter-webfont | 5.3.0 / 4.1.0 | – | ^5.2.8 / 4.1.0 |
| prismjs | 1.30.0 | – | ^1.30.0 |
| zod | 3.25.76 (protocol) plus 4.4.3 (better-auth) | – | – |
| typescript | 5.9.3 | 6.0.3 | 5.9.3 |
| vitest / jest / fast-check / playwright | 4.1.10 / 30.4.2 / 4.9.0 / 1.61.1 | 4.1.8 / – / – / – | – |
| pnpm / Node | pnpm 10.11.1 (`packageManager`), `engines.node >=22.7`, `.nvmrc` v22.22.0, CI Node 22.23.1 arm64 | pnpm 10.30.1 | pnpm 9.10.0 |

**Old pnpm config** (`package.json` "pnpm"):

```json
"overrides": {
  "yjs": "13.6.31",
  "lexical": "0.45.0",
  "@lexical/clipboard": "0.45.0", "@lexical/code": "0.45.0", "@lexical/headless": "0.45.0",
  "@lexical/history": "0.45.0", "@lexical/html": "0.45.0", "@lexical/link": "0.45.0",
  "@lexical/list": "0.45.0", "@lexical/mark": "0.45.0", "@lexical/markdown": "0.45.0",
  "@lexical/react": "0.45.0", "@lexical/rich-text": "0.45.0", "@lexical/selection": "0.45.0",
  "@lexical/table": "0.45.0", "@lexical/utils": "0.45.0", "@lexical/yjs": "0.45.0",
  "@lexical/yjs>yjs": "13.6.31"
},
"patchedDependencies": {
  "@lexical/yjs@0.45.0": "patches/@lexical__yjs@0.45.0.patch",
  "y-partyserver@2.2.0": "patches/y-partyserver@2.2.0.patch"
}
```

Glyphdown's overrides are `yjs ^13.6.31` and `@codemirror/*`, with `onlyBuiltDependencies: [better-sqlite3, esbuild, lightningcss, sharp, workerd]`.

**Deltas for the restart:**

- Override **every** `lexical`/`@lexical/*` package moss@762abb777 resolves to exactly **0.48.0**, including the new 0.48 packages listed in §1, and add `@lexical/yjs: 0.48.0` and `@lexical/headless: 0.48.0` directly.
- Keep `yjs` as one exact version, including `@lexical/yjs>yjs`. 13.6.31 is proven; the latest is 13.6.33.
- Keep only the y-partyserver patch.
- **Unproven combinations to check in the first build:**
  - React **19.3.0** (moss) with TanStack Start 1.168.x, which was proven only on 19.2.8;
  - `@vitejs/plugin-react` 4.x with Vite 8;
  - Lexical 0.48's `@lexical/code-core`/`code-prism` split versus the Prism-global install.
- Latest on npm at survey time, for reference only (not proven together): `@tanstack/react-start` 1.168.60, vite 8.3.2, `@cloudflare/vite-plugin` 1.62.4, wrangler 4.147.0, better-auth 1.7.7, drizzle-orm 0.45.3, partyserver 0.5.10, lexical 0.52.0.
- **wrangler config:** `compatibility_date: 2025-09-02`, `nodejs_compat`. DO bindings `DocDO`/`HtmlDocDO`/`SearchDO` with migrations v1/v2/v3 `new_sqlite_classes`. `CLOUDFLARE_ENV=staging` must be set at `vite build` time (`apps/web/wrangler.jsonc`; `deploy:staging` script).

---

## 20. Other small modules worth copying

| Module | Lines | Why |
|---|---|---|
| `apps/web/vite.config.ts:67-119` (`buildProvenancePlugin`) + `build-provenance.ts` | 53 + 30 | Injects `{commit, bundleHash (sha256 over sorted worker chunks), buildTime, env}`, refuses a build without a 40-character SHA, serves `GET /api/version` with no-store |
| `apps/web/src/moss/ChunkReloadBoundary.tsx` | 97 | Hard-reloads once on dynamic-import failure after a redeploy |
| `apps/web/src/api/ssrf.ts` | 288 | Manual redirects re-checked per hop (at most 5); DoH A/AAAA vetting; private, loopback, link-local, CGNAT, ULA, and obfuscated IPv4 rejected; HTTPS only; fail closed |
| `apps/web/src/common/embed-iframe-policy.ts` | 93 | Sandboxed iframe policy (`allow-scripts` without `allow-same-origin`) |
| `apps/web/src/moss/tailwind-content-coverage.test.ts`, `client-entry-order.test.ts`, `console-hygiene.test.ts` | – | Guards for the unstyled-build, Prism-order, and console-noise classes |
| `packages/sync/test/support/do-harness.ts` | 327 | The real DocDO class in Node: a `node:sqlite` `SqlStorage` shim, fake R2, stubbed `cloudflare:workers` (vitest alias plus `deps.inline: ['partyserver','y-partyserver']`). In CI, consider `@cloudflare/vitest-pool-workers` for real hibernation and upgrade legs. |
| `packages/core/src/tree-anchor.ts` | 422 | Comment and suggestion anchors as Yjs RelativePositions inside one element's `Y.XmlText`, from a Lexical `{key, offset}` point (validated in spike S2); text-quote fallback in `quote.ts` |
| `packages/protocol/src/messages.ts:109-175` | – | `__YPS:` prefix; close codes 4401, 4402, 4403, 4410 (plus 4408 heartbeat in the client and 4429 conn-limit in the DO); write-refusal reasons `role`/`doc-cap`/`suggest-policy`. These are duplicated in `do.ts:158-165`; define them once. |
| `.bb/skills/wwgd/SKILL.md` | – | The oracle-first procedure. Update the pin to 762abb777 and the glyphdown path to `.refs/glyphdown`. |

---

## 21. Avoid list (one place)

- Lexical overrides to any version other than moss's; the `@lexical/yjs` patch; the `__nodeFormat` wire alias.
- `CollabMarkdownShortcutPlugin`'s monkey-patching of `editor.update`, unless a 0.48 stress run proves the cascade.
- REST content lanes for bound docs: `notes.update` pushes, `/yupdate`, the state-vector flush, the `pagehide` beacon, the REST seed with neutralize, the fallback lane with reachability probe, binding-generation remounts, the `stableUpdatedAt` freeze.
- Per-doc watch sockets beside the collab socket; the 2.5s workspace poll.
- Frame-hold queues for revocation after wake; an O(doc) size simulation per frame; awaited D1 writes in the WS upgrade.
- Server node twins; comments and suggestions as DO SQLite sidecars (`sync/src/sidecar.ts`, `suggestion-sidecar.ts`). PRODUCT requires them as CRDT data in the doc.
- Top-level-only block replacement for push landing (`landMerged`).
- Hand-authored migrations without a DDL parity test; a committed 4.5MB generated oracle bundle.
- Append-only versioned e2e drivers; fixed-coordinate clicks; sleeps; hard-coded browser binary paths; one stack per flow.
- Narrative ticket-history comments.

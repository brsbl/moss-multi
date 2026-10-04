# Comments as CRDT data: design review (T4.0)

This resolves A§13's comments sketch for M4 (BUILDPLAN T4.1–T4.3). It was written against `origin/m4` at `a8b621c` (equal to `m3` plus a PROGRESS line), moss at the pin `762abb777`, and glyphdown `faf98d0` as the interaction reference. Three spikes back its risky claims; they run in CI from this branch (§11). The owner summary is the last section.

## 0. Decisions at a glance

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Where threads live | `Y.Map('comments')`: comment id → one plain JSON record (§1). Replies are records with `parentId`; roots carry the anchor. | PRODUCT: "threads/anchors are first-class CRDT data". One writer (D2), so a whole-record write per change is exact and smaller than nested maps. |
| D2 | Who writes it | Only the DocDO, under origin `server-comments`. Clients call REST. | A§13; glyphdown's property that a commenter never gets CRDT write access (S-gd §6.1, §12 option a). |
| D3 | How a forged client write is stopped | SP7: every client sync frame is classified by the root types it touches before it is applied. Clients may write only `root`, `title`, `frontmatter`, `frontmatterOrder` and `registers`; anything else, a frame that depends on an item the server lacks or skips clocks, or a malformed frame (a parent cycle, or a partly held struct whose encoding disagrees with the held item) gets `write-refused('protected-type')` and 4409. | A§5.1 gate order; an allowlist also blocks `suggestions` (M5) and junk roots. The "missing dependency", gap and partly-held rules close parking and tail-splicing attacks (§2.3). |
| D4 | Anchor shape | Two base64 `Y.RelativePosition`s into the V1 `XmlText` that holds the text, a quote over one text projection, a hint and a status (glyphdown's `Anchor`, re-targeted at the tree). A block comment anchors the decorator's one-character embed. | S-conv §3.2; LEARNINGS §4.11. The projection is computed from Y types alone, so the DocDO resolves and re-anchors without a Lexical mirror. |
| D5 | Who mints anchors, when | The client, from its own binding, at the moment the composer opens (not at submit). The DocDO re-derives the quote from its own projection and refuses a mismatch. | The selection is exact only on the client; minting at open keeps the target fixed while peers type during composition (§3.2). |
| D6 | Keeping anchors on their text | Relative positions only; a comment never jumps. A frame that splits text nodes but leaves a block's text unchanged (a format split) keeps the anchor at the same offsets in that block. When its text or block is deleted the comment is orphaned with its positions kept, and only an undo or restore that re-inserts that same text reattaches it. The quote is searched only for anchors that never had positions (import, paste, quote-only REST). The DocDO refreshes every anchor in the same synchronous step as each applied `root` frame, so changes persist with that frame. | Spike: bolding any word earlier in the same text node deletes and reinserts the text under the anchor, which collapses the positions (§3.4). Owner ruling 2026-10-04 (PRODUCT restart ruling 16). |
| D7 | Paint | CSS Custom Highlights rebuilt from anchors after every update; decorator comments get a class on their wrapper element. No MarkNode or `__commentIds` ever enters the synced tree, and `__commentIds` joins the wire exclusions. | SP10: Chromium and WebKit paint background, overlap and underline with zero DOM mutations (§4). Moss itself already paints the composer's pending selection this way (`MarkdownEditor.tsx:2831`). |
| D8 | Moss's UI | Ported unchanged except for seams that route its tree queries through one adapter with eight functions (§5). | Invariant 3 (port, don't reimplement). |
| D9 | Names and privacy | The doc stores principal ids, never names or emails. Names come from `GET /api/docs/:id/people`, answered only to the owner and grant holders (the presence rule, T1.5). | Keeps the T1.1s/T1.5 boundary: everyone who can read a doc receives its whole Y.Doc. |
| D10 | Import and export | Moss interchange import maps `%%m:` markers plus the sidecar to anchors in one server write. Every export is clean by construction, and the server export also strips any forged MarkNode. | PRODUCT: "every exported/pulled `.md` is clean". |

## 1. Data model

`Y.Map('comments')` holds one JSON value per comment, keyed by its id:

```ts
interface CommentRecord {
  v: 1;
  id: string;                 // a v4 UUID the client proposes (it keys the pending overlay, §5); the DO refuses a duplicate
  parentId?: string;          // replies point at their root; a reply has no anchor (moss: "replies have NO marker")
  author: string;             // the server principal id (user or agent); never a name or email
  source: 'user' | 'agent' | 'external';  // moss's color source: user 0, agent 3, external (imported) 4
  text: string;               // moss's mention encoding (§6.3), at most 10,000 UTF-16 units
  imageUrls?: string[];       // folder-scoped asset paths (M3 assets)
  createdAt: number;          // unix seconds, as moss expects (L§4.8)
  updatedAt: number;
  resolvedAt?: number;        // on the root; moss resolves a subtree together (setCommentSubtreeResolvedState)
  resolvedBy?: string;        // principal id
  reactions?: Record<string, string[]>;   // emoji → principal ids, glyphdown's shape
  anchor?: TreeAnchor;        // roots only; §3
}

interface TreeAnchor {
  kind: 'text' | 'block';      // T4.1 adds this to the spiked type in packages/core/src/tree-anchor.ts
  start: string;              // base64 RelativePosition, assoc 0 (sticks to the first commented character)
  end: string;                // base64 RelativePosition, assoc -1 (sticks to the last one)
  quote: { exact: string; prefix: string; suffix: string };   // 32 characters of context each side
  hint: number;               // last known start offset in the projection
  status: 'anchored' | 'orphaned';
  orphanedAt?: string;        // base64 state vector just before the frame that orphaned it; only a later restore reattaches it
  block?: { client: number; clock: number; offset: number };  // the deleted block's item id, when the block went
}
```

- **Plain values, not nested maps.** Only the DocDO writes, one operation at a time, so replacing a record never loses a concurrent change. A reaction toggle rewrites one small record; the old value is garbage-collected. The SP7 classifier still handles nested types, because a forged frame may contain them.
- **Deletes remove the key.** Moss's sidecar keeps no tombstones either. A thread delete removes the root and every record whose `parentId` chain reaches it (`collectCommentSubtreeIds`, `note-atoms.ts:177`).
- **Deleting a root message alone (`scope=comment`) promotes the oldest reply**, as moss does (`note-atoms.ts:226–283`). In one DO write, the promoted reply takes the root's `anchor`, `resolvedAt` and `resolvedBy`, loses its `parentId`, and the other replies are re-parented to it. Its author stays its own; authority over "Delete thread" passes to that author. With no replies the root is simply removed. T4.3 tests that a reply survives with the anchor.
- **Orphaned roots stay** with `status: 'orphaned'` and their positions unchanged. They stay in the thread list, marked as detached from text, with no highlight or gutter icon. They come back in place only when an undo or a peer's restore re-inserts the deleted text or block (§3.4), never because the same words appear elsewhere or are typed again. Moss prunes orphans on save but keeps them in the atom "so undo can resurrect them" (`CanvasAreaContent.tsx:2057`); this is the same behavior made durable.
- **Bytes count.** Every map write goes through the state-cap check (`STATE_CAP_BYTES`, simulated only near the cap, as `#overCap` does today).

## 2. Write path and permissions

### 2.1 One writer

The DocDO module `packages/sync/src/doc/comments.ts` (T4.1) owns the map:

- `comment(principal, role, op)` is the one RPC. `op` is `create | reply | edit | delete | resolve | react`. It checks the capability floor through `can(role, 'comment')` (`protocol/roles.ts`), checks authorship where §6.1 requires it, validates the payload, and writes inside `this.document.transact(fn, COMMENT_ORIGIN)`.
- It returns the written record plus what the Worker needs for notifications: the root's author, and the principal ids mentioned in the text.
- A direct `transact` is enough. `serverWrite`'s mirror exists to run Lexical-tree mutations through the converter, and the map holds no Lexical nodes. This differs from A§13's sketch ("writes through `serverWrite`") for that reason; the marker import (§7.1) is the exception, because it writes tree and map in one diff.
- Server-origin updates are never acked and never enter a client UndoManager, since clients track only their binding and register origins (A§10.2 seam (a)). PRODUCT: "programmatic writes create no undo step".
- Persistence, broadcast and hibernation need nothing new. `#persist` already records every update; y-partyserver broadcasts it to every socket, including read-only ones.

### 2.2 REST surface (Worker → DocDO)

All routes sit under `/api/docs/:id/comments`. The Worker resolves the caller and role through `api/access.ts` (one resolver), answers no access with the shared 404, and calls the RPC. Reads need no route, because comments arrive with the doc.

| Method and path | Body | Who | Errors |
|---|---|---|---|
| `POST /comments` | `{id, text, imageUrls?, anchor}` | commenter+ | 400 bad anchor or body; 409 `anchor-pending`, `anchor-mismatch`, `duplicate-id`; 413 over the state cap |
| `POST /comments/:cid/replies` | `{id, text, imageUrls?}` | commenter+ | 404 unknown root |
| `PATCH /comments/:cid` | `{text, imageUrls?}` | the author | 403 for anyone else |
| `DELETE /comments/:cid?scope=comment\|thread` | — | the author (thread: the root's author) | 403 |
| `POST /comments/:cid/resolve` | `{resolved}` | commenter+ | — |
| `POST /comments/:cid/reactions` | `{emoji}` (one grapheme, at most 32 UTF-16 units; at most 20 distinct per comment) | commenter+ | 400 |
| `GET /api/docs/:id/people` | — | owner and grant holders get names; everyone else gets `[]` | — |

- **Anonymous callers** get 401 with "Sign in to comment", as PRODUCT's "sign-in to comment or more" requires.
- **Rate limit.** At most 60 comment operations per principal per doc per minute, counted in the DocDO's memory (a wake resets it, as with the frame rate in A§5.1); the overflow gets 429 with `retry-after`.
- **Socket messages are not used.** REST gives status codes that a raw-request test can assert (T4.3's "a raw delete gets 403"), keeps notification writes in the Worker, and §3.3's wait makes it safe for anchors.

### 2.3 Ingress: SP7

`touchedTypes(doc, update)` (`packages/sync/src/doc/touched-types.ts`, spiked here) decodes a frame once and reports the root names it would insert into or delete from, without applying it:

- an item whose encoding names its parent lands in that root (a root name) or in the root its parent item's type belongs to;
- an item whose encoding omits the parent shares the parent of its left or right origin;
- a delete counts for the root of each live item it removes;
- structs and deletes the doc already holds are inert, so the usual step 2 classifies as touching nothing;
- an item hanging off a garbage-collected type lands nowhere, exactly as Yjs would treat it;
- the frame is `unresolved` unless every new struct would integrate now. The classifier replays Yjs's order: a client's next struct integrates once its clock follows that client's state without a gap and every id it names (origin, right origin, parent id; `Item.getMissing` checks each one separately) is held or was integrated earlier in the replay. A missing id anywhere, a gap, or a reference loop leaves a struct behind, and Yjs would park it;
- a struct the doc partly holds is `malformed` unless its encoding names the same parent and key as the held item `(client, state − 1)`, and it also counts for that item's root;
- a parent or origin cycle among the frame's own structs is `malformed`; the walk tracks the items it visits, so it always ends.

T4.1 folds it into `classifySync` so a frame is decoded once. Gate order (A§5.1 `onMessage`), with the new step 2b:

1. Revocation; string frames; awareness; step 1.
2. A write from a role below suggester → `write-refused('role')`, close 4403 (unchanged).
   - **2b.** A write touching any root outside `CLIENT_ROOTS = {root, title, frontmatter, frontmatterOrder, registers}`, or an `unresolved` or `malformed` frame → `write-refused('protected-type')`, close 4409. The client discards its Y.Doc and rebinds (A§10.5).
3. The write rate, the cap and suggester vetting, unchanged.

**Why "unresolved" is refused, not parked.** A frame can carry an item whose parent is a server item that does not exist yet. Yjs would hold it pending and integrate it the moment the server writes that id. The server's client id is visible in every update, and its clock is predictable, so a client could plant a write into a future comment. The same holds for a right origin: an item whose left origin is a held `root` or `frontmatter` item but whose right origin is the server's next id still parks, so every referenced id is checked, not just the first one the classifier follows to a root. Because nothing is ever left pending, a frame integrates entirely against the state it was classified on; no struct can integrate later, after the server writes. The spike builds these frames (a missing parent, a missing right origin beside a held left origin, two items whose right origins name each other) and checks that each is refused and that applying it would really park (§11). An honest client never depends on an item the server lacks: everything it holds came from the server or from itself over the same ordered socket. For the same reason a struct past a gap in its client's clocks is refused: Yjs parks it until the gap fills, and for the server's client id the gap fills with the server's own next writes.

**Why a partly held struct is checked against the held item.** Yjs integrates the tail of a struct whose head it already holds immediately right of the held item `(client, state − 1)`, and ignores the encoding's origin for placement. The server's latest write is usually a comment record, and its id is public. A forged struct at that id with a `root` origin or a `frontmatter` parent would therefore splice its tail into the comments map while classifying as an allowed root. The spike reproduces this (the forged tail replaces `comments.c2`) and refuses it. An honest partly held struct, such as a merged run the server half holds, names the held item's own parent and still classifies normally.

**Why the walk is bounded.** Parent and origin links among a frame's own structs are attacker-chosen. A self-parented item or a two-item loop would otherwise spin the DocDO before the rate and cap gates. The walk keeps a visited set per chain, so each struct is visited at most once per walk and a cycle is refused.

## 3. Anchors

### 3.1 The projection

`packages/core/src/tree-anchor.ts` (spiked here) defines one projection of the V1 tree, computed from Y types only:

- text as written;
- a decorator embed (`XmlElement`) as `U+FFFC`;
- a linebreak map as `\n`;
- one `\n` between blocks, emitted only before content, so empty blocks add nothing;
- text-node property maps contribute nothing.

Quotes, hints and re-anchoring all use this projection. The client, the DocDO and the CLI compute the same string from the same state, without a Lexical editor; the spike checks this against real bound editors.

### 3.2 Minting on the client

When the composer opens (`MarkdownEditor.tsx:2869` `openCommentInput`, from the toolbar and Cmd+Shift+A; block buttons arrive through `OPEN_BLOCK_COMMENT_COMMAND` at `:2972`), the seam mints the anchor from the live selection through the pane's binding:

- **Text.** For each end point, `collabNodeMap.get(key)` gives a `CollabTextNode`. The index is `getOffset() + 1 + offset` in `_parent._xmlText`, the same arithmetic as `@lexical/yjs`'s unexported `createRelativePosition` (`SyncCursors.ts`). The start uses assoc 0 and the end assoc -1. The spike shows these bytes equal the projection-minted ones.
- **Block.** The decorator's `CollabDecoratorNode` gives its embed index `i` in its parent `XmlText`; the anchor is `[i, i+1)`, `kind: 'block'`.
- **Quote** comes from the projection.

Moss saves the selection as Lexical keys and offsets (`savedSelectionRef`, `MarkdownEditor.tsx:2823`) and restores it at submit (`handleCommentCreate`, `:2998`). With peers typing, those keys go stale while the composer is open: a peer's bold splits the node, and an insert above shifts the offsets. Minting at open pins the target to Yjs items instead. Moss's `comment-selection` highlight is then repainted from the minted anchor on every update (§4), rather than kept as a live Range that collapses.

### 3.3 Validation on the server

`create` decodes both positions (at most 64 bytes each) and resolves them with `followUndoneDeletions = false`. It then requires:

- Both positions resolve into `XmlText`s under `root`, never `title` or a register, and the range is not inverted.
- If either position names an item the doc does not hold yet, the answer is 409 `anchor-pending`. To avoid that, the client posts only after an ack whose state vector covers both position items. It already tracks acks (`host/collab/acks.ts`), and the wait cannot starve while the user keeps typing, because it waits for specific items rather than for `data-sync-unacked=0`. It retries at most three times, then shows a refusal.
- The DocDO recomputes `quote` and `hint` from its own projection. If `similarity(server.exact, client.exact) < 0.8`, the answer is 409 `anchor-mismatch`. The stored quote is always the server's.
- A text range must be non-empty after trimming, as moss requires (`CommentPlugin.tsx:244`). There is no minimum length: moss comments on a single word. Short anchors only change how re-anchoring works (§3.4).

### 3.4 Keeping the anchor on its text

A comment never jumps to another occurrence of its text (owner ruling, PRODUCT restart ruling 16). Positions are the anchor's identity; the quote is a display copy and a check, not a search key. `validateAnchor(doc, anchor)` is pure and returns the anchor, its range and whether it changed:

1. **Never positioned.** An anchor with no positions (an import, a paste, a quote-only REST comment) is the only one whose quote is searched. Candidates are scored by prefix and suffix similarity, with distance to `hint` breaking ties. A quote of at least 8 characters (`MIN_ANCHOR_CHARS`) accepts the best exact candidate; a shorter one only if its prefix and suffix each match at 0.8 or better. The match is minted into positions; no match leaves it orphaned.
2. **Resolve** both positions. If the resolved text's similarity to `quote.exact` is at least 0.5 (glyphdown's `REANCHOR_THRESHOLD`), keep it, refresh `hint`, and **refresh the quote and its context** to what the range now covers; `changed` reports a quote or status change. Similarity is `2·equal / (|a| + |b|)`, where `equal` counts every character of `a` the edit script keeps, including the common prefix and suffix the script leaves implicit, so one typed character inside a 9-character quote scores about 0.95.
3. **Otherwise orphan it, positions kept.** Collapsed positions, positions into deleted content and positions that no longer resolve all orphan. Nothing is searched, so the stored positions stay exactly as minted.
4. **Restore.** An orphan the DocDO wrote carries `orphanedAt`, the doc's state vector just before the frame that orphaned it. A side whose character was deleted follows the character's restored copy: Yjs's undo re-inserts a deleted item as a copy whose right origin is that deleted item (`UndoManager` `redoItem`), and that link is in the update every replica receives. A peer that had seen the deletion never names a deleted right origin, because an insert steps over deleted items to its right, so text retyped after the deletion is never a candidate. A peer that typed in front of the text before it saw the deletion does name it (the fence records when the server applied the deletion, not what the peer had seen), so the link alone is not enough: the copy's character on each side must be the quote's first or last character, and the restored range must read exactly as the quote unless both sides landed on copies one client made (an undo). That exception covers offline text typed inside the range and deleted with it in one frame: the server orphaned the comment with the quote from before that frame, and the undo restores the typed characters too. The first copy whose edge character matches is taken on each side without backtracking, so a peer's insert in front of the text that starts with the quote's first character can make a real undo fail its check; the comment then stays orphaned, which never moves it. Only items inserted after `orphanedAt` count. When the block itself was deleted, its children are garbage-collected, so the orphan also records `block` (the deleted block's item id and the range's offset in it); a restored copy of that block brings the comment back at that offset if the text there is exactly its quote. A restored anchor is re-minted on the copy. What stays indistinguishable on the wire is a peer typing, before it saw the deletion, exactly the deleted text at exactly that place (or text with the quote's first and last characters at the same offsets); the comment then lands on identical text in the identical place, which is not a jump.

The DocDO adds what a pure check cannot know, the frame. `anchorsBefore(doc)` reads every anchored range just before a client frame applies; `refreshAnchors(doc, origin, before)` runs right after:

- **A frame that splits or merges text nodes without changing a block's text keeps the anchor's offsets in it.** `@lexical/yjs` V1 rewrites a split text node as delete-and-reinsert, so bolding any word earlier in the same text node collapses the positions. When the projected text of that block is the same before and after the frame and its text-node property maps changed (a node was split or merged), the anchor is re-minted at the same offsets in the same block. This is a position map through one frame, not a search: deleting text changes the block's text, and deleting and retyping the same text in one frame (two edits buffered offline) leaves the text nodes as they were, so the comment orphans. The exception: if that same frame also splits or merges a text node elsewhere in the block, the comment is re-minted on the retyped text at the same offsets, so a later undo of the retype does not bring back the original items; it still never moves.
- **A newly orphaned anchor** gets `orphanedAt`, the state before this frame, and, if its block was deleted, `block`. It is then validated once more behind that fence, so a deletion and its undo that arrive in one frame (offline, then reconnect) reattach the comment at once.

**What the spike showed.**

- Typing inside the range grows it, including one character just after its first character.
- Typing at either edge stays outside it.
- Every replica and the server agree.
- Bolding any word earlier in the same text node collapses the raw positions; alone they orphan, and the DocDO's frame map re-mints them on the same text, which resolves on every replica.
- Typing inside the range and then bolding an earlier word keeps the grown text, and a 3-character comment keeps its word through that bold.
- Deleting a commented line orphans it even when an identical line is next to it, and a later frame does not move it. Deleting one of two blocks with identical context orphans the deleted one's comment.
- Deleting commented text and undoing it, past an identical line, brings the comment back at the same offset; deleting a commented paragraph and undoing it does too.
- Deleting commented text and typing the same text again leaves the comment orphaned, in separate frames or in one.
- Text a peer typed in front of the commented text before it saw the deletion, which names the deleted character as its right origin, does not take the comment.
- A deletion and its undo in one frame, of text or of a paragraph, leave the comment anchored in place.
- Text typed inside the range and the range then deleted, sent as one frame, comes back with the comment when the deletion is undone.
- A block comment survives a paragraph inserted above it and edits inside its register.

Both sides run the check:

- **Client, for paint.** After every editor update and comments-map change, the paint layer validates each root anchor locally. Around its own transactions it keeps the last projection as `before` and applies the same frame map, so a bold never makes a highlight blink while waiting for the server.
- **DocDO, refresh with the frame.** After every applied client frame that touched `root`, the DocDO calls `refreshAnchors(doc, COMMENT_ORIGIN, before)` (spiked in `tree-anchor.ts`): one projection, `validateAnchor` for each record, the frame map, and one transaction that rewrites only the records whose `changed` is set (a refreshed quote, a re-mint or a status change; a hint-only change is never written, because the hint only breaks ties). It runs in the same synchronous step as the frame's apply, with no `await` between, so `#persist` writes the frame's row and the refresh's row in the same turn and the DO's write coalescing commits them together. That holds when the frame's row triggers a compaction too: the refresh row lands after the new snapshot. `before` is the projection the DO already holds from the previous frame, and nothing else is kept in memory, so A§5.1's rule (memory is rebuilt from storage or safe to reset) holds: after a wake the first frame's `before` is computed from storage. The DO applies frames one at a time and is the only writer of `comments`, so a refresh never races another writer.
- **Cost.** A record is rewritten when typing lands inside a commented range or within 32 characters of either edge (the quote's stored context changes), and when a frame re-mints or orphans it; typing elsewhere writes nothing. Each write is one small record update, broadcast to every socket like any server write, and it passes through `#overCap`. While an orphan with `orphanedAt` exists, each refresh also scans the items inserted since its fence for restored copies; T4.1 bounds that scan.

### 3.5 Residual risk

A single frame that both types in a block and splits a text node in it (a paste-and-format, or a client batching several edits) changes that block's text, so the frame map does not apply and a collapsed anchor orphans. It never moves, and the comment stays listed as detached. T4.1's fast-check over two bound editors measures how often this happens with the binding's real batching.

A deleted block nested inside another deleted block (a list item when the whole list goes) is restored without a link from its children to the old ones, so only the outermost deleted block is recorded and the offset is taken within it.

## 4. Paint (SP10)

- **Highlights.** One `Highlight` per moss color, named `moss-comment-0`, `-3` and `-4` (user, agent, external, after `COMMENT_CHALK_COLORS`), plus `moss-comment-hover` and `moss-comment-active` for the underline states. The rules live in host CSS and read the same tokens as `MarkdownEditor.css:831–904`. A thread filtered out by `commentThreadFilterAtom` is simply not added.
- **Rebuilt, never kept.** A requestAnimationFrame pass after each editor update, each comments-map change and each filter change resolves every anchor to Lexical points (`$getAnchorAndFocusForUserState`, exported by `@lexical/yjs`), then to DOM positions (the `domPoint` helper `host/link-highlight.ts` already uses), and replaces the ranges. SP10 shows a live Range collapses when a text node's data is replaced, which is how Lexical writes text, so a Range is never kept across updates.
- **One registry per document.** `CSS.highlights` is global, so a module-level registry merges every pane's ranges into each named highlight. Split panes then never clear each other.
- **Decorators** get `comment-highlight-active` and `comment-decorator-hover` on their `[data-block-decorator-key]` wrapper, as moss does today. That is a DOM class, not a tree write.
- **Hidden content** (inactive tabs, collapsed headings) produces no rects. The gutter already skips zero-height targets (`CommentGutter.tsx:35`).
- **Hit-testing.** There is no `.comment-mark` element for a pointer to land on, so `commentsAtPoint(x, y)` takes the caret position under the pointer (`caretPositionFromPoint`, falling back to `caretRangeFromPoint`) and asks each painted range `isPointInRange`. SP10 proves both directions in both engines.
- **Nothing reaches the doc.** No MarkNode and no `__commentIds` ever enter the synced tree. `__commentIds` (on the ten commentable decorators, `CommentAnchorTrackerPlugin.tsx:34`) joins `EXCLUDED_FIELDS` on both sides, so a stale or forged id list never syncs. The frame-scan positive-control pattern (A§10.9) covers it.

SP10 results: in Chromium and Linux WebKit, two overlapping comment highlights and an underline highlight paint over a contenteditable with zero mutation records, the range's rect gives the gutter its line, and a pointer hit-test finds the comment under it and not the one beside it. The pixels were checked in real 2× screenshots.

## 5. The adapter for moss's call sites

S-conv §3.1 named eight places where moss finds comments by walking the tree for `MarkNode`s or decorator `__commentIds`. Reading the pin finds 17 touch points. They group into eight adapter functions in `apps/web/src/host/comments/adapter.ts`, reached from vendored files through `@moss-multi/host/comments` seams recorded with `moss-vendor.mjs extract`:

| Adapter function | Moss sites at the pin (vendor paths under `desktop/src/renderer/`) |
|---|---|
| `liveAnchorIds(noteId)` | `editor/plugins/CommentAnchorTrackerPlugin.tsx` `collectLiveCommentAnchorIds` (`:47`) and its mutation listeners `:108–110`; feeds `noteCommentAnchorIdsAtom`, read by `panels/CanvasAreaContent.tsx:286` and `prompt/CommandPaletteOverlay.tsx:284` |
| `targets(noteId)`: per root, its rects and its first Lexical key | `editor/components/CommentGutter.tsx:40` `getCommentPositions` and its `MarkNode` listener `:128` |
| `commentsAtPoint(x, y)` | `editor/components/CommentUIWrapper.tsx:76` `findCommentHoverAnchor`, `:217` `getHoveredRootComment`, the root listeners `:484–493`; `editor/components/CommentPopover.tsx:964` (the outside-click guard) |
| `anchorTarget(id)`: element, rect and node key for scroll and reveal | `CommentUIWrapper.tsx:264` `findInlineCommentAnchor`, `:295` `revealTabContainingNode` |
| `commentsOnDecorator(nodeKey)` | `CommentUIWrapper.tsx:439` `handleDecoratorCommentClick`; `:653` `handleSendToAgent`'s decorator walk (that action is hidden; below) |
| `paint.setActive(id)` / `paint.setHover(id)` | `editor/plugins/CommentPlugin.tsx:137` `forEachCommentElement`; `CommentUIWrapper.tsx:110` `highlightComment`, `:154` `clearCommentHighlight`; `editor/utils/comment-hover-state.ts:24, 41`; colors from `CommentPlugin.tsx:277–330` `applyCommentColors`; `MarkdownEditor.css:831–904` |
| `create(payload)` | `CommentPlugin.tsx:203` `CREATE_COMMENT_COMMAND` (the single write seam A§13 names); the anchor minted at open (§3.2, `MarkdownEditor.tsx:2869` `openCommentInput`) and posted at submit (`:2998`) |
| `mutate(op)` | `CommentUIWrapper.tsx:536–640`: `handleUpdate`, `handleDelete` (with `utils/comment-cleanup.ts` and `$getMarkNodesWithId`, `CommentPlugin.tsx:166`, which become unused on bound notes), `handleReply`, `handleSetThreadResolved` |

The comments atom (`noteCommentsMapAtom`, `shared/src/state/note-atoms.ts:114`) stays moss's read model:

- A per-pane observer projects `Y.Map('comments')` into it as `NoteComment`s. Color is derived from `source`. Orphaned roots stay in the thread list marked as detached from text; `liveAnchorIds` leaves them out, so they get no highlight or gutter icon.
- A short-lived pending overlay keyed by the client-proposed id shows a new comment, reply or edit until the server's record arrives. A refusal removes it and announces through `refuseInput`.
- The bound pane already skips moss's disk hydration and save paths (A§9; `CanvasAreaContent.tsx:1601, 2028–2058, 2393, 3087, 3380`), so nothing else writes the atom.

Moss UI changes beyond routing:

- **Author labels.** `utils/comment-author-display.ts` maps `source: 'user'` to "Me". A seam labels the caller's own comments "Me", others by name from `/people`, or "Collaborator" when names are withheld. LEARNINGS §4.11: "non-authors saw 'Me' plus Edit and Delete".
- **Edit and Delete** show only on the caller's own comments, and "Delete thread" only on their own root (§6.1).
- **Reactions** follow glyphdown's `CommentThreadList.tsx:569–640`: count pills toggled per principal, plus a five-emoji picker. They are rebuilt in the moss DS under each comment row of `CommentPopover.tsx`.
- **Mentions.** People join the mention typeahead (`prompt/MentionPlugin`, used by `MentionInput.tsx:51`) from `/people`.
- **"Send to agent"** in the comment popover (`CommentPopover.tsx:391, 1061`) opens the hidden AI action, so it joins the `ai-run-action` registry entry.
- **Image attach** in the composer requires editor (PRODUCT: "Uploading requires editor role or above"), so commenters do not see it.
- **The `comments` staged entry** in `host/affordances.ts:157` (toolbar button, Cmd+Shift+A, block buttons) is unstaged by T4.2 together with these.

## 6. Identity, mentions, notifications

### 6.1 Authorship and capability

- `author` is always the server principal id from the Worker; a body field never sets it.
- Edit and delete are the author's own. A thread delete, which also removes other people's replies as moss's header action does, belongs to the root's author.
- Resolve and react are open to any commenter or above.
- An agent comments with its owner's access plus any direct grant (A§8). Its records get `source: 'agent'` and moss's agent color.

### 6.2 Who sees what

Everyone who can open a doc receives its Y.Doc, comments included. That is why records carry ids and never names or emails. `/people` answers the owner and grant holders, the same set that receives presence identities (T1.5). Signed-in link-only readers and anonymous viewers see other authors as "Collaborator". Text a person typed, such as a mention, is content and is visible to every reader.

### 6.3 Mentions

Moss encodes `U+2063 @Title [U+2062 id] U+2064`, with `@folder:` for folders (`utils/comment-mentions.ts`). A person mention adds `@person:Name U+2062 <principalId>`. `splitCommentMentionSegments` gains the `person` kind in the same seam, and older text still parses.

### 6.4 Notifications (T4.3)

After a successful `create` or `reply`, the Worker writes `notifications` rows (`apps/web/src/db/schema.ts:232`; `mention` and `comment-reply` already exist):

- one per mentioned **user** principal who can open the doc;
- one for the root's author on a reply, when that author is a user and not the replier;
- none to the actor.

`notifications.userId` is a non-null foreign key to `user.id` (`schema.ts:232–242`), so agent principals never get rows. An agent's owner is not notified on the agent's behalf either: a mention of an agent is content, and an agent reads its comments through the doc it already has access to (its owner's access plus any direct grant, A§8). Recipients are filtered through the same access resolver as reads, so a direct agent grant never widens who is notified. T4.3 tests that a mention of an agent principal writes no row.

It then publishes `{type: 'notifications'}` to each recipient's PrincipalDO. Reads re-check the live grant (A§8). This depends on T2.8's bell.

## 7. Import and export

### 7.1 Moss interchange import (T4.1; reused by T7.4)

The interchange path is a moss note plus `comments.json`, or the legacy footer. It runs as one `serverWrite` mutation:

1. **Parse.** `$importNoteBody(body, {comments: sidecar})` runs moss's own `$processCommentMarkers` (`utils/comment-import.ts:422`), producing MarkNodes and decorator `__commentIds`. Unknown ids are stripped, as moss does.
2. **Record.** In the same update, record each id's ranges as projection offsets over the mark-transparent tree. MarkNodes contribute only their children, so the offsets do not move when the marks go. Each block decorator's position is recorded the same way.
3. **Clean the tree.** Unwrap every MarkNode and clear every `__commentIds`, so the tree that reaches Yjs is clean.
4. **Anchor and write.** After the mirror's update commits (its binding has then written the tree into the mirror doc), mint each anchor from the mirror's projection (§3.1) and write the records into the mirror's comments map. `serverWrite` gains this after-commit step; it runs on the mirror before the diff is taken.
   - Ids are kept, `author` is the importing principal, and `source` is preserved.
   - Replies whose root has no surviving anchor are dropped, as moss prunes them.
   - A root with several marker pairs gets one anchor from its first pair's start to its last pair's end. Moss writes several pairs for one selection when it crosses text-node or block boundaries, and `normalizeCommentWrappedImages` splits a pair around an image, so the pairs of one id are one contiguous selection. A T4.1 test asserts that every id in the onboarding fixture (S-conv §3.1: 16 pairs, 4 threads) spans exactly the text its pairs wrap.
5. **One diff.** Tree and map land as a single update.

`POST /api/docs {markdown}` keeps passing `comments: {}`: a plain `.md` carries no threads, and its markers are stripped.

### 7.2 Export

Default export, CLI pull and Copy markdown are clean by construction: no MarkNode or `__commentIds` exists in the tree. As defense in depth, `exportDocMarkdown`'s disposable mirror unwraps any MarkNode and clears any `__commentIds` before exporting. An editor client could still forge one into `root`, and SP7 does not police node types inside `root`. L1 asserts zero `%%m:` and zero `{%c:` across the corpus, plus a forged-MarkNode fixture.

An optional moss-format export (markers plus `comments.json`, for migrating back to desktop) is built later by T7.4. It resolves anchors in a disposable mirror, wraps them in MarkNodes there, and runs moss's own `COMMENT_MARKER_TRANSFORMER` and `buildCommentMetadata`. The mirror is discarded, so nothing reaches the live doc.

## 8. Interactions with the rest of the system

- **Typing after commenting.** Creating a comment never edits the tree, so it cannot drop a keystroke. The B24 and "WORDWORD" families need a tree mutation and cannot occur. L§4.11's nested-update timing bug cannot occur either, because the anchor is minted before submit and the POST needs no `editor.update`.
- **Undo.** Cmd+Z never removes or restores a comment; Delete in the popover does. Moss at the pin undoes the mark wrap. This is a deviation for owner confirmation (§10).
- **Role changes and terminal states.** The composer and every comment action subscribe to the terminal store (A§10.6) and to the pane's role. A demotion below commenter closes them in place with a notice, and a REST 403 or 404 is announced through `refuseInput`.
- **History (M6) and CLI push (M7).** Both keep untouched items, so anchors survive. Anchors on rewritten text orphan in place; they never move to matching text elsewhere. A restore does not resurrect deleted comments; whether it should is M6's call.
- **Suggestions (M5).** `suggestions` is outside `CLIENT_ROOTS` from T4.1 on. Suggester vetting builds on the same `touchedTypes` pass.
- **Split view.** Each pane has its own binding and projection observer, and the one highlight registry merges panes (§4).

## 9. Task split and tests

These refine BUILDPLAN's tests-first lists. Each item is a claim from this design that must be proven red first.

**T4.1, the data plane** (`[A·codex]`)
- Wire `touchedTypes` into `classifySync` with `CLIENT_ROOTS`. Harness: a client frame touching `comments` gets `write-refused('protected-type')` and 4409, and so do an unresolved-dependency frame, a clock-gap frame, a forged partly held struct and a cyclic frame (the spike's raw encodings). The spike's property test moves here.
- The `comments` module and RPC; the REST routes of §2.2.
  - Unit tests: authorship from the principal, 403 for a non-author edit or delete, anchors in `title` refused, `anchor-pending`, `anchor-mismatch`.
- `tree-anchor.ts` hardening: `kind`, fuzzy matching for never-positioned quotes (import), a binary search over the projection runs for large docs, and a bound on the restore scan (§3.4).
  - fast-check: anchors survive random concurrent typing, formatting and paragraph splits on two bound editors plus the server, and no anchor ever resolves to text other than the characters it was minted on or their restored copies.
- `anchorsBefore` and `refreshAnchors` around each `root` frame in the same synchronous step (§3.4). DocDO harness tests: type inside a range, restart the DO (abort and wake) before any save tick, then format in a later frame, and the comment keeps the grown text; the same across a compaction (more than 500 rows between the two frames).
- `touchedTypes` in `classifySync`, with DocDO harness tests built from the spike's raw forged encodings, each asserting 4409, an empty pending queue and an unchanged `comments` map after the server's next write.
- The marker import and the export guard. "Importing the onboarding note and its sidecar yields 4 anchored threads"; "export contains zero `%%m:` or `{%c:`", including a forged MarkNode.
- `__commentIds` in `EXCLUDED_FIELDS`, with a frame-scan control.

**T4.2, paint and moss's UI** (`[B·codex]`)
- The adapter, the highlight layer, the composer seam, the atom projection, and unstaging `comments`.
- j15 as BUILDPLAN lists it, plus three legs this design adds:
  - bolding a word before a commented phrase keeps its highlight on both sides;
  - a peer typing above while the composer is open still lands the comment on the selected text;
  - a reply composer autofocuses.

**T4.3, reactions, mentions, edit and delete, notifications** (`[B·fresh]`)
- As BUILDPLAN lists it, plus: a signed-in link-only reader sees "Collaborator" and no names in `/people`; deleting a root message with replies promotes the oldest reply with the anchor (§1); mentioning an agent writes no notification row (§6.4).

## 10. Owner decisions recorded (made under delegation, for confirmation at the M4 hand-off)

1. Cmd+Z does not undo creating a comment (Delete removes it). PRODUCT says programmatic writes create no undo step; moss at the pin undoes the mark.
2. Commenters cannot attach images to comments, because PRODUCT reserves uploads to editors.
3. Readers without a grant (link-only or anonymous) see other commenters as "Collaborator".
4. A comment whose text or block was deleted is orphaned: it stays in the thread list marked as detached, keeps its positions, and returns in place only when an undo or a peer's restore brings that text back. It never moves to another occurrence (owner ruling 2026-10-04, PRODUCT restart ruling 16).

## 11. Spike evidence (this branch)

| Spike | File | Claim | Result |
|---|---|---|---|
| SP7 | `packages/sync/src/doc/touched-types.test.ts` | Classifies typing, title, comment writes (new, nested, deleted), mixed frames and new root names without applying; inert step 2; refuses future-item dependencies (a missing parent, a missing right origin beside a held `root` or `frontmatter` left origin, two items whose right origins name each other: each proven to park when applied), clock gaps, forged partly held structs (raw encodings that really overwrite `comments.c2` when applied) and parent cycles; keeps an honest partly held run; agrees with "apply to a copy and read `transaction.changed`" on 300 random concurrent edit sets across every root | Red on the stub: [37194578875](https://github.com/brsbl/moss-multi/actions/runs/37194578875). Round 1 regressions red: [37196600135](https://github.com/brsbl/moss-multi/actions/runs/37196600135). Round 2 regressions red: [37197850712](https://github.com/brsbl/moss-multi/actions/runs/37197850712). Green, 814 of 814 unit tests: [37198023178](https://github.com/brsbl/moss-multi/actions/runs/37198023178) |
| Anchors | `packages/sync/src/tree-anchor.test.ts` | One projection on every replica and the server; binding-minted positions equal projection-minted ones; edge and interior typing; a format split collapses positions, which orphan alone, and the frame map re-mints them on the same text; a short comment keeps its word through a bold and orphans when it is deleted; a deleted paragraph orphans; a block anchor survives; typing inside a range refreshes the quote; `refreshAnchors` persists the refresh with the frame, so replaying the log (or a compacted snapshot) before a later format split keeps the grown text, while the in-memory-only control loses it; no jump: deleting a line or block beside an identical one orphans it and it never moves, delete-and-retype stays orphaned (also in one frame), a peer's stale insert in front of the deleted text is not a restore, and undoing a deletion of text or of a paragraph reattaches it in place (also in the deletion's own frame, and after an in-range edit batched with the deletion); a never-positioned anchor attaches by its quote | Same runs as SP7, then round 3: no-jump regressions red [37201712490](https://github.com/brsbl/moss-multi/actions/runs/37201712490); green: [37203048315](https://github.com/brsbl/moss-multi/actions/runs/37203048315). Round 4 regressions red: [37204180272](https://github.com/brsbl/moss-multi/actions/runs/37204180272); green: [37204459616](https://github.com/brsbl/moss-multi/actions/runs/37204459616). Round 5 regression red: [37205533516](https://github.com/brsbl/moss-multi/actions/runs/37205533516) |
| SP10 | `e2e/selftest/highlight-paint.spec.ts` | Zero-mutation paint with overlap and underline; rect geometry; pointer hit-test; a replaced text node collapses a live Range, so paint is rebuilt | Green in Chromium and Linux WebKit: [37194962320](https://github.com/brsbl/moss-multi/actions/runs/37194962320). The first run ([37194584664](https://github.com/brsbl/moss-multi/actions/runs/37194584664)) already passed in WebKit; it corrected two probe tolerances, Chromium's subpixel fringe on unpainted text and the half-leading above a line box |

The spikes stay in the tree as the first tests of T4.1 (`touched-types`, `tree-anchor`) and as the engine probe T4.2's paint relies on (`highlight-paint`, a selftest, so it runs first in every e2e shard of both engines and costs about 3 s).

## 12. Review log

The fresh architect and the Codex critic review this document at the head the checker names. Each finding and its disposition (fixed in this doc, ruled out with a citation, or moved to a named task) is appended here.

**Round 1 (checker at `d72a80d`).**

| Sev | Finding | Disposition |
|---|---|---|
| P1 | A forged struct whose head the server holds splices its tail into the latest comment record | Fixed: partly held structs must name the held item's parent and key (§2.3); raw-encoding regression test |
| P1 | A parent cycle among a frame's structs spins the classifier | Fixed: per-chain visited set, `malformed` (§2.3); regression test |
| P1 | `similarity` ignored the common prefix and suffix, so typing one character orphaned a comment | Fixed (§3.4); regression test over bound editors |
| P1 | The stored quote went stale while positions held, so a later format split lost typed text | Fixed: `validateAnchor` refreshes the quote (§3.4); regression test |
| P2 | Deleting only a thread's first message | Decided: the oldest reply is promoted with the anchor (§1); T4.3 test |
| P2 | Notifications for agent principals | Decided: user principals only (§6.4); T4.3 test |

**Round 2 (checker at `7797554`).**

| Sev | Finding | Disposition |
|---|---|---|
| P1 | A held left origin hid a missing right origin, so Yjs could park a frame the classifier admitted | Fixed: the classifier replays Yjs's integration order and checks every referenced id (§2.3); regression tests for a missing right origin (root and frontmatter left origins) and for two items whose right origins name each other, each proven to park when applied |
| P1 | Refreshed anchors lived only in DocDO memory until the save tick, so a restart lost them | Fixed: `refreshAnchors` writes in the same synchronous step as the `root` frame and there is no in-memory anchor state (§3.4); regression test replays the log and a compacted snapshot; T4.1 adds the DO restart test (§9) |
| P2 | Stale spike evidence and an empty review log | Fixed: §11 and this log |

**Round 3 (checker at `c18d372`).**

| Sev | Finding | Disposition |
|---|---|---|
| P1 | The quote fallback durably retargeted a comment to another matching occurrence when its text or block was deleted, so undo could not bring it back | Fixed under the owner ruling of 2026-10-04 (PRODUCT restart ruling 16): the quote is searched only for never-positioned anchors; collapsed or deleted positions orphan with positions kept; a format split is carried by the frame map and an undo by the restored copy's right origin (§3.4). Regression tests: delete and undo past an identical line, delete a paragraph beside an identical one, delete one of two blocks with identical context, delete and retype, delete and undo a paragraph |
| P2 | The cost note ignored the 32 characters of context the quote stores | Fixed: §3.4 "Cost" |

**Round 4 (checker at `93a8009`).**

| Sev | Finding | Disposition |
|---|---|---|
| P1 | A peer's insert typed before it saw the deletion names the deleted character as its right origin and was taken for a restore | Fixed: a restored side's copy must hold the quote's edge character and the restored range must read exactly as the quote (§3.4); regression test |
| P1 | The frame map re-anchored a comment whose text was deleted and retyped in one frame | Fixed: the map needs a text-node split or merge in the block, not only unchanged text (§3.4); regression test |
| P1 | A deletion and its undo in one frame left the comment orphaned for good | Fixed: the fence is the state before the orphaning frame and the anchor is validated again behind it (§3.4); regression tests for text and for a paragraph |

**Round 5 (checker at `2cf947b`).**

| Sev | Finding | Disposition |
|---|---|---|
| P1 | Undo after an in-range edit and the range's deletion, batched in one frame, never reattached the comment: the restored text differed from the pre-frame quote | Fixed: a range whose two sides are both one client's restored copies is accepted without the exact-quote check (§3.4); regression test |
| P2 | A frame that splits a text node elsewhere in the block and deletes and retypes the commented text re-mints instead of orphaning | Documented in §3.4; no jump. Left as is |
| P2 | The restore candidate search does not backtrack after a failed edge or quote check | Documented in §3.4; fails toward orphaned. T4.1 restore index rebuild |
| P2 | A peer that had not seen the deletion and types exactly the deleted text there reattaches the comment | Already disclosed in §3.4; indistinguishable from an undo copy on the wire |

---

## Owner summary

**What this decides.** In M4 a comment becomes shared data inside the note, the same way the note's text, title and properties already are. Everyone with the note open sees new comments, replies, reactions and resolves arrive live. Nothing about a comment is written into the note's text, so typing next to a comment, before it or inside it can never lose a keystroke, and an exported or downloaded `.md` never contains comment markers.

**How it works, in four lines.**
1. **The server is the only writer of comments.** The web app asks the server to add, edit, delete, resolve or react. The server checks who you are and your role, then writes the comment into the note. A commenter therefore can never touch the note's text, and the author's name comes from the server, never from the browser.
2. **A browser cannot sneak a comment in.** Every edit a browser sends is checked first for which part of the note it would change. Anything aimed at comments, at something the server has not created yet, or shaped to trick that check (reviewers found several such shapes; all are now refused and tested), is refused loudly and never lands.
3. **A comment remembers its exact characters, plus a copy of the quoted text.** Ordinary typing moves the highlight with the text. When someone bolds a word earlier in the same line, the editor quietly rewrites that line and the exact link breaks. The tests proved this happens. The server sees that the line's text did not change in that edit and puts the comment back on the same characters, saved together with the edit, so it holds even if the server restarts in between. A comment never jumps to the same words elsewhere: if its text is deleted it stays in the thread list marked as detached, and it comes back in place only if that text is restored, for example by undo. Typing the same words again does not reattach it.
4. **Highlights are painted on top of the page, never into it.** The tests proved this works in both Chrome and Safari's engine: overlapping comments, the hover underline, finding the comment under the mouse, and repainting after typing.

**What stays exactly like moss.** The gutter icons, highlight colors, popover, threads, replies, resolve, the open/resolved filter and Cmd+Shift+A are moss's own code, with small marked hooks. Reactions follow glyphdown's design (emoji pills plus a small picker), built from moss parts. Mentioning a person and replying notify them in the bell.

**Four calls I made for you (please confirm or overturn).**
1. Cmd+Z does not remove a comment you just added; you delete it from its popover. Moss undoes it today, but PRODUCT says server-side writes add no undo step.
2. Commenters can't attach images to comments, because PRODUCT says uploading needs editor.
3. People who only hold a link see other commenters as "Collaborator" rather than their names, matching how presence already hides identities from link-only readers.
4. If the text a comment is attached to is deleted, the comment stays in the thread list marked as detached, and comes back in place if the text is restored, for example by undo. It never moves to another copy of the same words. (You ruled this on 2026-10-04.)

**What's next.** T4.1 builds the server side: refusing forged writes, the comment API, re-attaching anchors, and importing moss notes with their comments. T4.2 connects moss's comment UI with the highlight painting. T4.3 adds reactions, mentions, edit and delete rules, and notifications. Each starts from tests that fail first, including the tests that back this document.

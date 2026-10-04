# Comments as CRDT data: design review (T4.0)

This resolves A§13's comments sketch for M4 (BUILDPLAN T4.1–T4.4). It follows the 2026-10-04 design panel, which replaced the six-round first attempt (`t/T4.0-r1`): C2's identity-free anchors with C1's reserved-writer write guard. It was written against `origin/m4` at `80a4327`, yjs 13.6.31, @lexical/yjs 0.48.0 and moss at the pin `762abb777`. The spike proves only the load-bearing properties (§10); the owner summary is the last section.

**The whole design in a few sentences.** Comment data lives in `Y.Map('comments')` in the note's Y.Doc, and only the DocDO writes it, under a reserved Yjs client id R. A client frame can never place or delete an R item; this is proved by induction and needs no prediction of Yjs placement. An anchor is two RelativePositions. After a frame it changes in only four ways:
1. it shrinks to its own surviving characters;
2. in the frame that deleted an endpoint, it is re-minted onto text that frame inserted, between the same surviving neighbours, and only if that text reads the same;
3. it becomes orphaned and records its *lost place*;
4. an orphan reattaches only when live items inside its own lost place read exactly as the lost passage did.

Nothing searches the document for a positioned anchor, scores similarity, or trusts undo-copy identity.

## 0. Invariants (the checker reviews against these)

- **I1 Write isolation.** Every item in the `comments` subtree has client R, and every deletion of a live R item comes from a `writeComments` transaction.
- **I2 No late integration.** No struct or delete integrates after the frame that carried it, and nothing parked is ever persisted.
- **I3 Lineage endpoints.** An anchored comment's endpoints are always one of:
  - (a) the items it was minted on;
  - (b) items that were inside its live range when a frame began and survived that frame;
  - (c) items placed by I4 or I5.
- **I4 Gap re-mint.** A re-mint within one frame targets only items that frame inserted and that are still live, between the same two survivors in flattened order. Their text-mode tokens must equal the pre-frame range exactly.
- **I5 Exact reattach.** An orphan reattaches only to live items inside its own lost-place segments, and only when their full-mode token stream equals the recorded `pre` signature exactly.
- **I6 No search.** A quote search runs only at create or import, for an anchor that never had positions.
- **I7 Frame-bounded cost.** Server work per frame is O(the Yjs transaction's structs plus delete ranges) times fixed constants: the 32-comment overlap cap and the 4,096-struct walk budget. It never depends on doc size or comment count.
- **I8 Durable anchor state.** Anchor changes are written in the same synchronous turn as their frame. All in-memory indexes are rebuilt from records at onStart.

**Supported liveness (the list the spike proves).** A comment keeps its exact characters through:
- format on, off, or across its boundary (V1 split and join);
- Enter before or inside it (the range may then cross blocks);
- a soft break;
- a Backspace join of its block;
- the moss markdown inline shortcuts.

It orphans on deletion of all its characters, including its block. It reattaches on undo or redo of:
- a text deletion;
- a block deletion;
- a cross-block deletion;
- a text deletion followed by deletion of its paragraph, with both undone;
- delete, undo, redo, undo;
- each of the above made offline and replayed under the frame discipline (§6).

A shape not on this list must fail toward orphaned or shrunk, never toward other text. Such a gap is a P2 follow-on, not a design break.

## 1. Pinned Yjs facts

Each has a CI test in `packages/sync/test/harness/yjs-facts.test.ts`, on yjs 13.6.31 and @lexical/yjs 0.48.0.

| Fact | Statement | Source | Test |
|---|---|---|---|
| F1 | `afterTransaction` runs before `tryGcDeleteSet` and struct merging, so deleted content, parents and children are still readable in the hook. | yjs `src/utils/Transaction.js:313` emits it inside `callAll`; `:325` GCs and `:327` merges in the `finally` after it | F1 |
| F2 | An `XmlText` insert (`insert`/`insertEmbed`, the only way V1 writes text, property maps, linebreaks and blocks) runs `minimizeAttributeChanges`, which skips deleted items. Any insert by a replica that has seen a deletion lands after the whole run of tombstones that follows the insert point. | yjs `src/types/YText.js:200` (`minimizeAttributeChanges` steps over `right.deleted`), called at `:262` (`insertText`) and `:291` | F2 |
| F3 | `redoItem` for list items inserts the copy with `origin = item.left` (traced into the redone parent) and `rightOrigin = item`, so a copy lands before its original. A deleted parent is redone first, and children are placed inside the new parent between the copies of their old neighbours. | yjs `src/structs/Item.js:161-169` (parent first), `:174-206` (left and right traced), `:233-243` | F3 (text, block, cross-block, and the lifted case) |
| F4 | Every container type @lexical/yjs V1 creates for moss's node registry is an `XmlText`: decorators are `XmlElement` leaves, and text-node property maps and linebreaks are map embeds. The one nested type an attribute holds is a node's NodeState, a `__state` Y.Map of JSON values (the callout fixture has one), which tokens read like any attribute. No node at the pin declares slots, so no text lives outside the child lists. | @lexical/yjs `src/Utils.ts:301-352` (`$createCollabNodeFromLexicalNode`), `:605-646` (NodeState), `:270-298` (slots only for nodes that declare them) | F4: a registry scan plus the converter corpus |
| F5 | Integrate takes a non-R item's parent only from its string parent, its ID parent, its left item (origin, or the held predecessor `(client, clock−1)` for a partly held struct), or its right item (rightOrigin). | yjs `src/structs/Item.js:372-416` (`getMissing`), `:419-426` (`integrate` with an offset) | Proved in §3; the guard suite and its fast-check exercise it |

## 2. Data model

`Y.Map('comments')` holds JSON values only, with no nested Y types:

- `c:<id>` is the thread record (author principal id, text in moss's mention encoding, imageUrls, timestamps in seconds, `parentId` for replies, `resolvedAt`/`resolvedBy`, `reactions {emoji → principalIds}`, `source`). Root delete promotes the oldest reply (§12).
- `a:<id>` is the anchor record of a root, kept separate so a re-mint rewrites about 200 bytes, not the thread:

```ts
interface Anchor {
  kind: 'text' | 'block';
  start: string; end: string;           // b64 RelativePositions: start assoc 0 on the first unit, end assoc -1 on the last
  status: 'anchored' | 'orphaned';
  quote: string;                        // server-computed at mint; rewritten only on a status change; display only
  lost?: LostPlace;                     // orphaned with a recoverable place
}
interface Seg { list: ItemId | 'root'; left: ItemId | null; last?: ItemId; right?: ItemId | null }
  // (left, last] over the members in one list; (left, right) once re-homed by a lift (§5.5)
interface LostPlace {
  v: 1;
  segs: Seg[];                          // in flattened document order
  members: [client, clock, len][];      // top-level deleted members, ≤ 512 runs
  pre: { h: string; n: number; a: number; b: number }; // 128-bit SHA-256 prefix of full-mode tokens, length, comment span [a,b)
  inner?: { at: number; list: number; pre: LostPlace['pre']; inner?: … }; // set by a lift, depth ≤ 3
}
```

A unit is a character, a decorator (an `XmlElement` embed) or an opaque embed. The spike types are `packages/core/src/anchor-frame.ts`. `inner.list` (the token index of the inner place's list in the outer stream) is added to the panel's shape: without it, a place at the end of a block's children and one right after the block share a token offset.

## 3. Write isolation

**Writer.** `writeComments(fn)` (`CommentsWriter.write`, `packages/sync/src/doc/comments-guard.ts`) is the only code that touches `comments`. It sets `doc.clientID = R`, runs `doc.transact(fn, COMMENT_ORIGIN)`, and restores the clientID in `finally`. It is never called from inside an observer or `afterTransaction`: it runs after `applyUpdate` returns, in the same synchronous turn. It keeps a sorted array of R's live clocks, updated from each of its own transactions.

**Ingress guard (gate 2b in `classifySync`).** It runs on every sync step-2 or update frame, inert or not, whatever the role, before apply, and reuses the frame decode. The frame is refused with `write-refused('protected-type')` and 4409 if:
- (a) any Item, GC or Skip struct has client R;
- (b) any Item names R as origin, rightOrigin or ID parent;
- (c) any Item has a string parent outside `CLIENT_ROOTS = {root, title, frontmatter, frontmatterOrder, registers}`;
- (d) a delete range on client R covers a live R item (a binary search in R's live clocks).

It costs O(frame · log) and follows no references.

**Proof of I1 (from F5).** By induction over integrations. Initially every comments item is R. A non-R item gets its parent from an allowlisted string (c), a non-R ID parent (b), a non-R origin (b), its own non-R held predecessor (a), or a non-R right item (b). By the induction hypothesis none of these is in `comments`, so the item does not land there. A map overwrite deletes the entry's previous item, which would have to be a comments item, so the overwriting item would itself need to be in `comments`. Merges are same-client only. A deletion of a live R item needs a delete range on client R, which (d) refuses. Nothing in the proof predicts where Yjs places a struct.

**Pending purge and compaction (I2).**
- `DocStore.record` no longer compacts inside the `update` handler: Yjs's `encodeStateAsUpdate` includes `pendingStructs` and `pendingDs`, so a compaction there could snapshot structs a frame left parked.
- After `super.onMessage` applies a client sync frame, if `store.pendingStructs` or `store.pendingDs` is non-null, the DO nulls both, unicasts `write-refused('unresolved')` and closes 4409.
- Then it flushes anchor writes, then runs any due compaction (`compactIfDue`, which also covers an update too large for one row). Server writes compact in their own handler, since nothing is ever parked between frames.
- Honest clients never park, because everything they hold arrived over the same ordered socket. A frame Yjs throws on mid-apply (a self-parented struct) is purged and refused the same way (T4.1 wires this into the DocDO; the spike host does it).

**R lifecycle.** R is persisted as `meta.commentsClient`, regenerated at first write if any struct already has that client (`newCommentsClient`). `onStart` regenerates the DO's own clientID if it equals R. Marker import writes records through `writeComments` right after its tree diff, in the same turn.

**Proof of I8.** The frame's row and the R row are written in one turn, and DO output gates hold their broadcast until both commit. EP, MI and AI (§5.1) are rebuilt from `a:` records at onStart in O(comments × depth). The engine skips the `persistence`, `server-seed` and `COMMENT_ORIGIN` origins.

## 4. Create and import

**Create.** A commenter or above sends `{id, text, anchor: {kind, start, end, quote?}}`.
- Both positions must resolve (`followUndoneDeletions = false`), in order, under `root`. Otherwise:
  - 409 `anchor-pending`: an item the server lacks; the client retries after an ack covers it, at most 3 times;
  - 409 `anchor-gone`: an empty range.
- The server computes `quote` from its own projection. The client's quote is advisory; the server's is returned.
- If any character of the new range would be covered by more than 32 anchored comments, the answer is 409 `too-many-overlapping`, an O(C log C) sweep at create.
- Caps: 2,000 records per doc, 60 operations per principal per minute (429), and a quote of at most 10,000 characters (413).

**Quote-only create (REST, CLI, agents)** runs one search with A§13's thresholds (8-character minimum, 0.8 context similarity, with the round-1 suffix fix in `similarity`). It needs a unique best match, otherwise 409 `quote-ambiguous` or `quote-not-found` (`findQuote` in `packages/core/src/tree-anchor.ts`). It never runs again.

**Client minting.** The composer seam mints at open, from the live selection through the pane's binding: `collabNodeMap.get(key)` gives a `CollabTextNode`, and the index is `getOffset() + 1 + offset` in `_parent._xmlText` (start assoc 0, end assoc -1). A block comment anchors the decorator's one embed. The spike shows these bytes equal the projection-minted ones (`tree-anchor.test.ts`).

**Import.** Positions are minted from `%%m:` markers in the import's own serverWrite (§13). Sidecar comments with no marker go through the quote-only path once. Export never reads `comments`.

## 5. The anchor engine

`packages/core/src/anchor-frame.ts` is pure; T4.2 wires it into the DocDO's pre-GC `afterTransaction` hook for client frames and serverWrite origins. It is read-only: it collects changes, and `writeComments` flushes them after apply returns (`CommentsHost` in the spike).

**Liveness predicates.** `preLive(x)`: `x.id.clock < beforeState[client]` and the item was live before this transaction (or deleted by it). `postLive(x)`: `!x.deleted`. A *survivor* is preLive and postLive. `frameNew(x)`: `x.id.clock ≥ beforeState[client]`.

**Token modes.** One flattened walk visits each block before its children; a decorator is atomic.
- `text` mode, used for gap maps: characters, plus a decorator fingerprint (nodeName plus its sorted attributes, which include the register key). Format maps, linebreak maps and block boundaries are skipped.
- `full` mode, used for lost places: adds the property-map attributes (including linebreaks), formats, and a block-open token (its attributes). Attributes are read at their pre-frame or post-frame values.

### 5.1 Indexes (in memory, rebuilt from records)

- **EP.** Endpoint item id → anchored comment ids.
- **MI.** Lost member runs, and the two bounds of a re-homed place, → orphan ids.
- **AI.** The ancestor blocks of each orphan's segment lists → orphan ids (depth ≤ 32).

EP and MI are disjoint clock spans per client, so a lookup is a binary search. The overlap cap bounds each item's fan-out in EP and MI to 32.

### 5.2 Anchored comments: only when the transaction deletes an endpoint

Each delete range in `txn.deleteSet` is looked up in EP. Comments whose endpoints survive are never visited, so typing inside or at the edges of a range costs nothing and writes nothing. For each hit comment:
1. **Gap map (I4).** For each deleted endpoint, walk the flattened order both ways to the nearest survivors (at most 4,096 structs per direction). Let D be the text-mode tokens of the preLive-but-not-postLive items in the gap, and I those of the frameNew postLive items.
   - If D == I, map the endpoint by offset.
   - Otherwise let p = LCP and s = LCSuffix, with p + s ≤ min(|D|, |I|). Map only if the comment's part of the gap lies wholly in D[0, p) or in D[|D|−s, |D|), and its text occurs exactly once in D and exactly once in I.
   - Accept the mapping only if the whole new range, in text mode, equals the pre-frame range. Then re-mint.
   - This carries V1 format split and join, Enter (the end may move into the new block), soft break, a join, and markdown shortcuts.
2. **Survivor shrink (I3b).** Otherwise, re-mint each deleted endpoint onto the nearest surviving unit inside the pre-frame range, walking inward. Replacement text typed at a deleted edge is not adopted.
3. **Lose (§5.3).** If no survivor exists, the comment takes the lost path. A walk over budget orphans it with no `lost`.

### 5.3 Losing the text

**Members.** M is the set of preLive structs of the pre-frame range that this transaction deleted, each lifted to its outermost ancestor deleted in this same transaction. Members are whole structs, the granularity at which Yjs's UndoManager restores: a struct is split at every deletion boundary, so it holds only characters deleted together.

**Segments.** For each list that holds top-level members, the segment is `(left, last]`: `left` is the item immediately left of that list's first member (or the list start), and `last` is the list's last member. Segments are in flattened order.

**Signature.** `pre` is the full-mode tokens of the preLive items in the members' full subtrees, in flattened order, with [a, b) the comment's span inside it, hashed to 128 bits of SHA-256.

**Outcome.** If the segments' live tokens already equal `pre` (a same-frame undo), reattach. Otherwise write `status: 'orphaned'`, `quote` = the pre-frame text, positions unchanged, and `lost`. Over budget, or more than 512 member runs, orphans with no `lost`: permanently detached, the safe failure.

**Why an honest retype cannot reattach.** By F2, an insert by a replica that has seen the deletion lands after the tombstone run that ends at or after `last`, so it is outside the segment. That includes text typed at the comment's old spot and new blocks inserted after a deleted block, which in flattened order come after its whole subtree.

**Why an undo does reattach.** By F3, an undo or redo copy lands between `item.left` and `item`, inside `(left, last]`. Redo chains behave the same way, and a restored block's children sit inside the restored block, which is itself inside the segment.

### 5.4 Reattach (I5)

**Trigger.** A frame-new item whose `origin` or `rightOrigin` falls in an MI run. F3 points undo copies' right origins at members and a lifted copy's origin at a re-homed bound; a stale peer's insert into the span points there too. Each orphan is checked at most once per frame.

**Check.** Walk each segment, plus the full subtrees of its live items, in full mode, with a budget of 4,096 + 4n structs, stopping as soon as the stream is longer than `pre.n`.
- On an equal length and signature, re-mint the start and end on the live units at [a, b) and set `status: 'anchored'`.
- A failed check writes nothing.

The panel described a token-by-token comparison that stops at the first mismatch. A 128-bit signature cannot be compared token by token, so the spike stops at the stream length instead; the bound is the same (`4,096 + 4n`), and the forged one-item frame in the cost test stops after one struct per orphan. T4.2 may store a prefix-hash array if the measured cost needs it.

### 5.5 Lift (an orphan's place inside a block this transaction deletes)

AI is looked up for each deleted block in `txn.deleteSet`. While still pre-GC:
- compute the outer lost place around the outermost deleted block (§5.3), shared by every orphan under it;
- store the old `pre` as `inner = {at: k, list, pre}`, where k is the token offset of the old place inside the outer stream and `list` the token of its list's block-open.

When the outer place matches (the block was restored), the inner place is re-homed in the restored copy: between the live children of the same list around offset k, splitting a merged character run if k falls inside it. Its MI trigger is those two bounds (F3: a later undo traces its copies' origin and right origin to them). Nesting is limited to depth 3, and only single-segment places lift; deeper or cross-block orphans become permanently detached.

### 5.6 Cost (I7), by mechanism

| Mechanism | Bound per frame | Counted by |
|---|---|---|
| Guard | O(F · log N) over the frame's structs and delete ranges | — |
| EP lookups | one binary search per delete range | `stats.lookups` |
| Hit comment | ≤ two 4,096-struct gap walks + two range walks (≤ 4,096 + 4 × 10,000) + one loss emission + one check (`COMMENT_BUDGET`), × ≤ 32 comments per deleted endpoint | `stats.structs`, `stats.comments` |
| Lift | one emission per deleted outer block, shared by every orphan under it | `stats.structs` |
| Reattach trigger | one MI search per frame-new struct's origin and right origin; each candidate's check is ≤ 4,096 + 4n structs and stops past n tokens | `stats.structs` |
| Records | written only on a re-mint or a status change | — |

Never per frame: a whole-doc projection, an LCS, a store scan, a container scan, or a mirror apply. The spike counts this deterministically (`anchor-cost.test.ts`): on a 2,000-comment, 500-orphan doc a single-key insert or delete visits zero structs and zero comments; a frame deleting one character shared by 32 comments visits 32 comments within 32 × 64 structs; a forged one-item frame naming a lost member visits one struct per orphan sharing that member. T4.2 measures CPU in workerd and records the budget in METHOD.md.

## 6. Client

**Frame discipline** (honest-client transport; `groupPending` in `packages/core/src/group-pending.ts`, wired into `acks.ts` and the patched provider by T4.2):
- Each local Yjs transaction's update is kept separately, as `AckLedger.#pending` already does.
- On recovery or reconnect, before answering step 1, the client replays pending updates as separate frames, coalescing only runs of insert-only updates or runs of delete-only updates. An update that both inserts and deletes goes alone. A deleting update is never merged with another update's inserts.
- The client then sends step 2, which arrives inert.
- Replay is paced to at most 40 frames per second, below the 300-per-5-s rate limit.

The discipline matters only for honest users and ruling 16. Safety (I1–I8) never depends on it: a client that ignores it can at most keep a comment on identical text in the identical place.

**Paint.** The client resolves positions with `followUndoneDeletions = false` and paints with CSS Custom Highlights (SP10, §11). It runs the same pure §5.2 engine read-only on every applied transaction as an overlay until the server's `a:` record arrives, so a bold never blinks the highlight. Orphans show `quote` in the thread list, marked as detached.

**Refusals.** A 4409 takes the existing discard-and-rebind path (A§10.5); `unresolved` reads "Your last change could not be saved. Reconnecting to the saved note."

## 7. Accepted limitations (P2 register)

1. Live text that ends up inside a deleted span (a concurrent peer, or a mixed transaction) blocks reattachment until a later copy arrives after it is removed. In that state, typing exactly the deleted text in exactly that spot can reattach the comment.
2. When a paragraph is deleted after its commented text and both are undone, an exact retype at the restored spot after the first undo can reattach the comment (the open bounds of a lift).
3. A forged frame that deletes and retypes identical text in one frame keeps the comment on identical text in the identical place.
4. An undo of a partial trim does not regrow the highlight. The comment stays on its surviving text.
5. Undoing an adjacent older deletion inside a segment, or anything over budget, leaves the comment detached.
6. Version restore does not reattach orphans; M6 owns server-trusted re-minting from snapshots.
7. Dragging a block or cut-and-paste orphans the comment.
8. A markdown shortcut that wraps the commented text itself (typing `**` on both sides of it) deletes and reinserts it with different neighbours in its gap, so the comment orphans. Shortcuts beside it keep it (the spike scene).
9. Orphans whose lost place spans blocks, or is nested deeper than 3 lifts, do not lift; deleting their block detaches them.

None of these moves a comment to different text or to another occurrence.

## 8. Disposition of every finding

Every finding in `.panel/T4.0-review-history.md` (six rounds and two commit security reviews) and every panel-review break on C1, C2 and C3 that touches an adopted part. "Test" names the spike test that proves it, or the follow-on task's red-first test.

| Source | Finding | Disposition |
|---|---|---|
| R1 P1 | A partly held forged struct splices its tail into the latest comment record | I1: the tail lands beside its own client's held predecessor; an R struct is refused (a). Test: guard "tail splices at R's and the DocDO's latest clocks" |
| R1 P1 | The classifier loops on cyclic parents | I7: the guard follows no references. A cycle parks or throws in Yjs and is purged (I2). Test: "parent cycles and right origins that name each other are purged" |
| R1 P1 | `similarity` ignored the common suffix | Kept fixed, create-only (I6). Test: `tree-anchor.test.ts` similarity |
| R1 P1 | A stale quote plus a later format collapse orphans the comment | No quote fallback for positioned anchors (I6); format splits are gap maps (I4). Test: the bold scenes |
| R1 P2 | Root delete strands replies | T4.4: root delete promotes the oldest reply, with the anchor and resolution, in one writeComments call. Test: T4.4 "deleting a root with replies keeps the thread anchored under the promoted reply" |
| R1 P2 | Notifications for agent principals | T4.4: user principals only. Test: T4.4 "mentioning an agent writes no notification row" |
| R2 P1 | A held left origin hid a missing right origin | (b) for R; any other parked frame is purged (I2). Test: "a missing right origin beside a held left origin" |
| R2 P1 | Refreshed anchors lived in memory until the save tick | I8. Test: T4.1 "restart between a deletion and its undo: the comment still reattaches" |
| R2 P2 | Stale evidence, empty log | This table and §10 |
| R3 P1 | The quote fallback moved a comment to another occurrence | I6. Test: never-jump "two identical lines" |
| R3 P2 | The cost note ignored the quote's context | No context is stored; records are written only on a re-mint or status change (§5.6) |
| R4 P1 | A stale peer's insert was taken for an undo | I5 compares the whole place. Test: never-jump "a stale peer typing inside the deleted span"; identical text in the identical spot is P2 #1 |
| R4 P1 | Delete and retype in one frame re-anchored | Frame discipline (§6). Test: "offline: delete it, then retype it identically"; a forged frame is P2 #3 |
| R4 P1 | Delete and undo in one frame stayed orphaned | Gap map, D == I. Test: "delete then undo, in the same frame" |
| R5 P1 | Batched in-range edit plus deletion, then undo, never reattached | Discipline plus `pre` over the members (the typed X is preLive in the deleting frame). Test: "offline: type inside it, delete all of it, undo" reattaches as `brXown` |
| R5 P2 | A split elsewhere plus delete-and-retype in one frame re-mints | Separate frames under the discipline; a forged frame is P2 #3 |
| R5 P2 | The restore candidate search does not backtrack | Not applicable: there is no candidate search |
| R5 P2 | A stale peer typing the exact deleted text there reattaches | P2 #1, and the ruling 16 clarification |
| R6 P1 | A fully held struct with a missing dependency parks and the classifier admits it | I2: purge after every applied frame. Test: "a fully held struct with a forged missing origin parks the tail and is purged" |
| R6 P1 | Delete, undo, redo, undo in one frame stays orphaned | Gap map over the frame's live copies. Test: "delete, undo, redo, undo: frame by frame, and as one frame" |
| R6 P2 | The cost note understated per-frame work | §5.6, counted. T4.2 records the workerd CPU budget |
| Security review | `refreshAnchors` does whole-doc work on every frame | I7. Test: `anchor-cost.test.ts`; T4.2 workerd budget |
| Security review fe3c2f8 | Forged undo copies around new text attach another person's comment | I5. Test: never-jump "forged edge copies around new text" |
| C1 §1 P2 | Compaction snapshots parked structs | I2: compaction after the purge. Test: "a frame that parks is closed 4409; a forced compaction and a restart leave nothing parked" |
| C1 P1 | A forged copy chain placed far from the lost text | Not adopted: no right-origin identity; placement decides. Test: never-jump "a forged item whose origin is a distant live item" |
| C1 P1 | An index re-mint lands on surviving text | Not adopted: I4 targets only frame-new items. Test: never-jump "an identical paste over a different occurrence" |
| C1 P1 | A batched format split plus a keystroke orphans | The gap is bounded by survivors, so a keystroke elsewhere is outside D and I; under the discipline the split travels alone. Test: T4.2 fast-check over random concurrent edits |
| C1 P1 | Batched in-range edit plus block deletion, then undo | Segments over full member subtrees plus the discipline. Tests: "block delete then undo", "offline: type inside it…" |
| C1 P1 | Cross-block delete then undo | Per-list segments. Test: "cross-block delete (after an Enter inside it) then undo" |
| C1 P1 | Anchor work grows with comment count | EP plus the 32 overlap cap. Test: cost "one character shared by 32 comments" |
| C1 P2 | A decorator swap carries a block comment through U+FFFC | Decorator fingerprints. Test: never-jump "a decorator swapped for a different one" |
| C2 P1 | The mirror judge's inert-frame bypass | The mirror is dropped; the guard runs on every sync frame. Test: T4.1 "an inert step 2 carrying an R struct is refused 4409" |
| C2 P1 | Same-frame delete plus identical retype keeps the comment | Discipline; a forged frame is P2 #3 |
| C2 P1 | The lost place leaves out a deleted block's children | Segments include full member subtrees. Tests: block and cross-block undo |
| C2 P1 | A batched interior edit, deletion and undo leaves a partial range | Survivor rule (I3b) plus `pre` over the members. Test: "offline: type inside it…" |
| C2 P1 | Container-indexed rechecks are not frame-bounded | MI trigger only. Test: cost "a forged one-item frame naming a lost member" |
| C2 P2 | A delete-only frame never rechecks | P2 #1 and #5 |
| C2 P2 | The lift's open bounds let a retype reattach | P2 #2 |
| C2 P2 | An adjacent older undo blocks reattachment | P2 #5 |
| C3 P1/P2 | Endpoint envelopes, unseen comments, lineage rows, companion-doc restore | Not applicable: no lineage declarations or companion doc |
| C3 P2 | Region-diff prefix mapping keeps a comment on replacement text | V1's text diff keeps the common prefix as survivors, so typing over a commented selection shrinks the comment to those characters (P2 #4 family); the gap map's prefix rule needs the comment's whole part inside the common prefix and unique in both |

## 9. Architecture edits landed with this review

- A§13: "SP7 is the classifier" and the 0.5 re-anchor threshold are dropped; the reserved writer and the frame engine replace them; the 0.8 / 8-character thresholds stay, create-only.
- A§5.1: gate 2b's R checks join the `onMessage` order; compaction moves out of the update handler to after the pending purge; the anchor indexes join the in-memory state rebuilt from storage.
- A§22: SP7 is closed as not needed; SP10 is answered.

## 10. Spike evidence

| Claim | Tests | Runs |
|---|---|---|
| Guard (a)–(d), the history's raw fixtures, an honest step 2 with R tombstones, and a 300-run fast-check that every comments item is R | `packages/sync/test/harness/comments-guard.test.ts` | Red (stubs): [37221588284](https://github.com/brsbl/moss-multi/actions/runs/37221588284). Green: see below |
| Pending purge: 4409, then a forced compaction and a restart leave nothing parked, and a release frame integrates nothing | same file, against the DocDO harness | same |
| F1–F4 | `yjs-facts.test.ts` | same |
| Supported liveness: bold and unbold before, inside, across and after; Enter before and inside; a soft break; a Backspace join; a markdown shortcut; delete then undo in separate frames, one frame and DURDU; block, cross-block and lifted undo; the two offline replays | `anchor-scenes.test.ts` (real @lexical/yjs V1 editors with Y.UndoManager) | same |
| Never-jump and integrity | `anchor-integrity.test.ts` | same |
| Cost by counters | `anchor-cost.test.ts` | same |
| Kept pieces: one projection, binding minting, the create-time search | `tree-anchor.test.ts`, `group-pending.test.ts` | same |
| SP10 paint: zero-mutation highlights, overlap, underline, geometry, hit-test, and that a live Range collapses when Lexical replaces a text node | `e2e/selftest/highlight-paint.spec.ts` (kept from r1; green in Chromium and Linux WebKit in [37194962320](https://github.com/brsbl/moss-multi/actions/runs/37194962320)) | runs first in every e2e shard |

The workerd CPU budget, the DocDO wiring of the guard and engine, REST, paint and notifications belong to T4.1–T4.4.

## 11. Paint (SP10)

- **Highlights.** One `Highlight` per moss color, `moss-comment-0`, `-3` and `-4` (user, agent, external), plus `moss-comment-hover` and `moss-comment-active` for the underline states, styled in host CSS from the tokens in `MarkdownEditor.css:831–904`. A thread filtered out by `commentThreadFilterAtom` is not added.
- **Rebuilt, never kept.** A requestAnimationFrame pass after each editor update, comments-map change and filter change resolves every anchor to Lexical points (`$getAnchorAndFocusForUserState`), then to DOM positions, and replaces the ranges. SP10 shows a live Range collapses when a text node's data is replaced, which is how Lexical writes text.
- **One registry per document.** `CSS.highlights` is global, so a module-level registry merges every pane's ranges into each named highlight.
- **Decorators** get `comment-highlight-active` and `comment-decorator-hover` on their `[data-block-decorator-key]` wrapper, a DOM class, not a tree write.
- **Hit-testing.** `commentsAtPoint(x, y)` takes the caret position under the pointer and asks each painted range `isPointInRange`.
- **Nothing reaches the doc.** No MarkNode and no `__commentIds` ever enter the synced tree; `__commentIds` joins `EXCLUDED_FIELDS` on both sides.

## 12. Moss's UI, identity and notifications

**The adapter.** Moss finds comments by walking the tree for `MarkNode`s or decorator `__commentIds` at 17 touch points, grouped into eight adapter functions in `apps/web/src/host/comments/adapter.ts`, reached through `@moss-multi/host/comments` seams (vendor paths under `desktop/src/renderer/`):

| Adapter function | Moss sites at the pin |
|---|---|
| `liveAnchorIds(noteId)` | `editor/plugins/CommentAnchorTrackerPlugin.tsx:47`, `:108–110`; read by `panels/CanvasAreaContent.tsx:286`, `prompt/CommandPaletteOverlay.tsx:284` |
| `targets(noteId)` | `editor/components/CommentGutter.tsx:40`, `:128` |
| `commentsAtPoint(x, y)` | `editor/components/CommentUIWrapper.tsx:76`, `:217`, `:484–493`; `editor/components/CommentPopover.tsx:964` |
| `anchorTarget(id)` | `CommentUIWrapper.tsx:264`, `:295` |
| `commentsOnDecorator(nodeKey)` | `CommentUIWrapper.tsx:439`, `:653` |
| `paint.setActive(id)` / `paint.setHover(id)` | `editor/plugins/CommentPlugin.tsx:137`, `:277–330`; `CommentUIWrapper.tsx:110`, `:154`; `editor/utils/comment-hover-state.ts:24, 41` |
| `create(payload)` | `CommentPlugin.tsx:203` `CREATE_COMMENT_COMMAND`; minted at `MarkdownEditor.tsx:2869`, posted at `:2998` |
| `mutate(op)` | `CommentUIWrapper.tsx:536–640` |

A per-pane observer projects `Y.Map('comments')` into moss's `noteCommentsMapAtom` (`shared/src/state/note-atoms.ts:114`); a short pending overlay keyed by the client-proposed id shows a new comment until the server's record arrives.

**REST** (under `/api/docs/:id/comments`, one access resolver, the shared 404): create, reply, edit and delete (author only; thread delete is the root author's), resolve, react (one grapheme, ≤ 20 distinct per comment), and `GET /api/docs/:id/people` (names for the owner and grant holders only). Anonymous callers get 401 "Sign in to comment".

**Identity.** `author` is always the server principal id. Records carry ids, never names or emails. Readers without a grant see other authors as "Collaborator".

**Mentions** use moss's encoding, with a `@person:Name U+2062 <principalId>` kind added in the same seam.

**Notifications (T4.4).** After a create or reply, the Worker writes rows for mentioned user principals who can open the doc and for the root's author on a reply, never for the actor and never for an agent (`notifications.userId` is a user FK). Recipients are re-checked against the live grant.

**Root delete** promotes the oldest reply in one writeComments call: it takes the root's anchor (`a:<id>` is re-keyed), `resolvedAt` and `resolvedBy`, loses its `parentId`, and the other replies are re-parented to it.

## 13. Import and export

**Moss interchange import** (T4.1, reused by T7.4) runs as one serverWrite: moss's `$processCommentMarkers` produces MarkNodes; each id's ranges are recorded over the mark-transparent tree; the tree is cleaned (MarkNodes unwrapped, `__commentIds` cleared); then, right after the tree diff and in the same turn, positions are minted from the live doc and the records written through `writeComments`. A root with several marker pairs gets one anchor from its first pair's start to its last pair's end. Replies whose root has no anchor are dropped, as moss prunes them.

**Export** (default, CLI pull, Copy markdown) is clean by construction; as defense in depth, `exportDocMarkdown`'s mirror unwraps any MarkNode and clears any `__commentIds`. L1 asserts zero `%%m:` and zero `{%c:` across the corpus.

## 14. Owner decisions recorded (under delegation, for confirmation at the M4 hand-off)

1. Cmd+Z does not undo creating a comment; Delete in its popover removes it. PRODUCT says programmatic writes create no undo step.
2. Commenters cannot attach images to comments, because PRODUCT reserves uploads to editors.
3. Readers without a grant see other commenters as "Collaborator".
4. A deleted comment is orphaned and comes back only onto identical text in the identical place, as clarified in PRODUCT restart ruling 16 (2026-10-04).

---

## Owner summary

**What this decides.** In M4 a comment becomes shared data inside the note, like the note's text and title. Everyone sees new comments, replies, reactions and resolves arrive live. Nothing about a comment is written into the note's text, so typing next to or inside a comment never loses a keystroke, and a downloaded `.md` never contains comment markers.

**How it works.**
1. **Only the server writes comments, under its own reserved signature.** Every comment write carries a writer id that only the server uses. A browser's edit is refused, loudly, if it carries that id, points at it, aims at the comments directly, or deletes a comment. Reviewers spent six rounds finding ways around the old "predict what this edit will do" check; this rule doesn't predict anything, so there is nothing to outguess. A malformed edit that the database would hold back and apply later is dropped instead, and the note is never saved with one inside.
2. **A comment stays on its own characters.** Bolding, Enter, line breaks, joining paragraphs and markdown shortcuts keep it on exactly the text you commented on; the server checks, in the same step, that the re-written text reads the same and sits between the same untouched neighbours.
3. **Deleting the text detaches the comment; undo brings it back.** The comment stays in the thread list marked as detached. It reattaches only when the restored text reappears in exactly the spot it was deleted from and reads exactly the same, which is what undo and redo do, online or offline. Typing the same words again lands just after that spot, so it does not reattach. Two rare cases look identical to an undo and are written into PRODUCT ruling 16 as a clarification: a collaborator who hadn't seen the deletion typing inside it, and a paragraph deleted after its text and then restored.
4. **It stays fast with many comments.** The server only looks at comments whose first or last character an edit actually deletes, capped at 32 per character, so a keystroke in a note with 2,000 comments does no comment work at all. The tests count this.
5. **Highlights are painted on top of the page, never into it**, proven in Chrome's and Safari's engines.

**What's next.** T4.1 builds the server side (the comment API, the guard inside the live server, import). T4.2 wires the anchor engine and the offline replay rule. T4.3 connects moss's comment UI with the painting. T4.4 adds reactions, mentions, edit and delete rules, and notifications.

# Decorator payload lifecycle (T1.R design review)

**Decision: keep each payload in `Y.Map('registers')` under its block's stable id, let clients only create and edit it, and make the DocDO the one writer that deletes and restores payload text.** A code block's code, an HTML block's HTML and a formula's source stay a `Y.Text` keyed by `__regId`, as in M1, so a Lexical move (which V1 performs as delete plus recreate) never touches the text and nobody's typing is lost to a move. What changes is who removes text. No client ever deletes a payload. After every applied update, the DocDO's janitor checks only the ids that update touched:

- text that no live block names moves into a private trash, out of the served state;
- text whose block comes back (undo, redo, a raced move) returns to where it was;
- when two blocks name one id, one of them is removed.

The janitor is a single serial writer that sees every update, so it settles the races that no client can see at delete time.

## Owner summary

- **What was wrong.** In M1, deleting a code, HTML or formula block left its text in the shared map, so later readers and duplicates still received it (the privacy P1). Deleting the text together with the block breaks moves. A move deletes the block and recreates it under the same id, and a client that deletes cannot see a move happening at the same moment elsewhere. T1.P tried to repair that race on the clients and failed three checks.
- **What attempt 1 proposed, and why it was refuted.** It moved the text inside the block's own Yjs element. That fixed privacy, but a move then copied the text into a new element, so anything a peer typed into the old one during the move was lost, including all of a briefly offline peer's typing. M1 keeps those edits. Dropping them would change the PRODUCT contract ("neither ever loses work"), and that needs your decision. This design keeps them instead.
- **What changes now.**
  - Deleting a block takes its text out of what the server serves within the same message.
  - The text waits in a server-only trash for 30 days, the same retention as deleted notes, and is never served or copied. Undo, redo, or a move that raced the delete brings it back exactly where it was, together with what the other people typed.
  - When two people move the same block at the same moment, the server keeps one copy.
  - Only the person who creates a block ever creates its text, so someone joining mid-draft cannot replace it.
- **What stays the same.** People typing in one code block merge character by character, Cmd+Z undoes only your own typing, a move keeps every character, and export bytes do not change.
- **What you give up (narrow; nothing is destroyed in any of these):**
  1. Undoing the creation of a block that someone else typed into hides it, along with their typing. Redo brings all of it back. V1 already does this for paragraphs on m1. Fixing it for all blocks is an undo-policy question for the whole tree, not a payload question, so it is filed separately.
  2. When a delete and a move of one block race, the move wins: the block survives, as a V1 paragraph does. If the deleter then undoes, the server removes the duplicate and keeps the copy that comes first in the note, so the block may return to its original position.
  3. If a block is deleted and restored while someone is typing inside its text, their characters are kept but can land at the end of the restored stretch instead of in the middle. Yjs's own undo positions text the same way.
  4. If text was typed in a block before it was deleted and restored, its author can no longer undo that typing, because the restored text counts as a server write. The block and its text are unaffected.
  5. A property change made, at the same instant, to the duplicate the server removes (for example the code language) is lost.
- **Cost.** The janitor reads only the ids an update touched (the spike counts one id per edit, delete or move in a 200-block note). The client side is T1.9s's per-id refresh, unchanged.

## Requirements and how each is met

| Requirement | Map model (M1 head) | Element-owned payload (attempt 1) | Map + janitor (chosen) |
| --- | --- | --- | --- |
| (a) Deleted text is not served to later readers, viewers or duplicates | Fails: the entry outlives its block (`it.fails` below) | Met | Met. The janitor deletes unnamed text in the same DocDO handler, before anything is persisted or served; the doc has GC on and no undo manager, so the bytes go. Trash is server-only and is not part of the Yjs state, so duplicates, snapshots and joiners never see it |
| (b) No loss or doubling under delete, move or undo | Moves fine; never deletes | Loses typing that races a move (refuted P1) | Moves never touch the text. Delete ∥ move, concurrent moves, concurrent undos, and multi-step undo all converge to one block with the text once (spike) |
| (c) A joining peer never loses the drafter's committed code | Any peer whose map lacks the key could create a second `Y.Text` | Met | Only the minting client creates the payload, inside the transaction that creates its element. Peers never create, replace or whole-value-write one, and the janitor never mistakes a new block for an orphan (spike, every join point) |
| (d) Cost proportional to the change | T1.9s fixed the walk | Met | Janitor work per update is the ids it touched, plus the subtree of an added or deleted container; client work is unchanged |

## Why the alternatives fail

| Option | Verdict |
| --- | --- |
| A. Map, with the client deleting the payload alongside the block and repairing racing moves (T1.P) | Rejected. Three failed checks. A client cannot see a concurrent move at delete time, and a client-side repair adds a second writer for the same text, so the text comes back doubled or lost. |
| B. Payload as a `Y.Text` attribute of the block's own element (attempt 1) | Rejected. A V1 move copies the text into a new element, so a peer's typing during the move is lost, which M1 keeps. Undo also needed two rules. The checker refuted both of them: one missed blocks restored by an earlier undo, the other missed containers. |
| C. Map plus a server pass that only deletes unnamed text | Rejected. It breaks the deleter's undo, because server writes never enter a client undo stack (A§10.8), and a raced move loses its text. C plus a trash with positional revival is the chosen design. |
| D. Lexical named slots (`@experimental` in 0.48): the payload as a nested Lexical node | Rejected for now. It would rewrite moss's node model and views, and it has B's move problem. |
| E. Glyphdown: the whole body is one `Y.Text` of markdown | Not applicable. A fenced block there is plain characters, so there is no payload lifecycle; our V1 tree schema is fixed (A§10.2). |
| Moss desktop at the pin | One writer and whole-value fields (`CodeBlockNode.tsx:535`, `FormulaNode.tsx:252–260`), so it has no concurrency to manage. |

## Lifecycle rules

1. **Identity.** `__regId` is minted once by the client that creates the node. Property sync carries it through every V1 move, including a move of the paragraph or container around it. Every copy gets a fresh id: clipboard, `$copyNode`, duplicate block and import. `afterCloneFrom` keeps the id only for `getWritable` clones, which share the node's key.
2. **Create.** A client creates `registers[id] = new Y.Text(text)` only for an id it minted, and only inside the binding transaction (origin `binding`) that syncs the node's element: `syncLexicalUpdateToYjs` and the creation run in one `doc.transact(…, binding)`. The client works from its own minted-ids list, not from dirty leaves, so a node inside a new paragraph or container is covered. No other path ever writes a payload: not the node transform, not hydration, not remote updates, undo, redo, refresh or migration. A node whose payload has not arrived reads its cache, refuses edits and never invents text.
3. **Move.** Nothing to do. The text is keyed by id, and the recreated element carries the same id.
4. **Delete.** The client deletes the element and leaves the payload alone. The janitor does the rest.
5. **Undo.** The undo scope is `[root, registers]`, with the `binding` and `REGISTER_LOCAL_ORIGIN` origins tracked. `deleteFilter` returns `item.parent !== registers`, so an undo never deletes a payload entry. That is the only undo rule. Undoing a creation deletes the element and the undoer's own characters; the janitor reclaims whatever else is left, and redo brings the element back for the janitor to revive. Nothing depends on struct identity, so `followRedone` replacements and container deletions need no special case (attempt 1's P1-2 and P1-3).
6. **Janitor (DocDO).** It runs after every applied update from any origin except its own, in the same handler, before the update is persisted or anything is served. Its writes use origin `janitor`, which no client manager tracks.
   - **Index:** id → live elements. It is kept from root events, walking the whole subtree of each added or deleted item, because a moved or deleted paragraph or container reports only its top item. It is built once on load.
   - **J1 reclaim:** an id with no live element and live text moves its runs to trash, as (client, clock, text), and then deletes the text. The runs' tombstones stay in place.
   - **J2 revive:** an id with a live element and trash gets each run back. A new item is inserted directly before the run's own tombstone, which is split at the run's start, so a peer's insert made next to any character stays next to it. The trash entry is dropped.
   - **J3 dedupe:** an id with two or more live elements keeps the first in document order and deletes the rest. Only the serial janitor does this, so the last copy is never deleted (attempt 1's P1-5).
   - **J4 honor deletions:** characters in trash that a peer deleted concurrently are dropped from trash, so that peer's later undo restores them once. An incremental update carries only its sender's own deletions, so all of them are honored. A sync step 2 carries every deletion its sender knows, including the reclaim itself. So each reclaim also bumps a marker in `Y.Map('janitor')`, which advances the server's clock. Pieces the sender had already seen reclaimed, by its state vector, are kept.
   - **J5 load pass:** index the doc and reclaim every unnamed payload. This also clears the orphans M1 has already stored, so persisted M1 docs need no other migration.
7. **Trash.** A DocDO SQLite table `register_trash(reg_id, client, clock, text, seen_client, seen_clock, at)`, indexed by `reg_id` and by `client` for J4. Rows expire after 30 days and are deleted with the doc. They are never served, snapshotted, exported or copied.
8. **Reads, writes and events.** Payload edits are events on `registers`, never on the V1 root, so the official observer is untouched (T1.9s's per-id refresh stays). Views resolve the payload at the moment of use and write minimal diffs under `REGISTER_LOCAL_ORIGIN` (T1.F4).
9. **Mixed versions.** Nothing has shipped. Before staging carries real docs, the DocDO refuses clients whose bundle predates this design (by `bundleHash`), because an M1 client still creates payloads for ids it did not mint.

## Evidence

The spike is `packages/sync/src/register-lifecycle.spike.test.ts` (unit lane). It runs the client rules on the real `@lexical/yjs` 0.48 V1 binding with `yjs` 13.6.31, and the janitor on a server doc with GC on and no undo manager, as the DocDO has. Clients send one incremental update per transaction, as a connected provider does. A reconnecting client sends a sync step 2 with its state vector.

- **Privacy:** after a delete, the text is absent from the served bytes, a late reader and a duplicate, with a positive control first. Offline typing into a deleted block is reclaimed as well.
- **Deleter's undo:** block and text come back after the server reclaimed them, including a peer's characters and that peer's offline typing.
- **Moves (attempt 1's P1-1 and P1-4):** typing that races a move is kept in both arrival orders, including a long offline stretch. A formula inside a moved paragraph and a block inside a moved container keep their text and the racing peer's typing. The spike asserts that V1 really recreated both elements.
- **Delete racing a move:** both orders, three peers. The result is one block with the text once, including the mover's typing after the move. The deleter's undo restores nothing twice, and the mover's undo keeps a third peer's edit.
- **Concurrent moves, then concurrent undos (P1-5):** exactly one block, in both orders.
- **Multi-step undo (P1-2):** create, delete, undo, a peer types, then undo the creation. The block hides, nothing is served, and redo restores the peer's characters.
- **Paragraph holding a formula (P1-3):** undoing its creation after a peer's formula edit hides both. Redo restores every character. A control shows V1 does the same to a paragraph's text on m1.
- **Join:** a peer that joins after every prefix of a drafter's update stream and touches the block never costs the drafter a character. The janitor never reclaims a new block, and only the drafter creates the payload.
- **J4:** a concurrent character deletion is honored, both through incremental updates and through a reconnect's sync step 2, and a control without the rule doubles the characters. A reconnecting peer that had seen the reclaim does not cancel it.
- **J5:** the load pass reclaims an M1-style orphan and keeps live payloads.
- **Cost:** in a 200-block note the janitor evaluates one id for an edit, one for a delete and one for a move.
- **M1 comparison:** the map's privacy failure stays `it.fails`. Binding order is safe (the register precedes its element on the wire). A whole-value write of a stale field snapshot deletes a peer's characters, which T1.F4 removes.

Runs: the tests-first run was red on attempt 1's privacy assertion: [37194871289](https://github.com/brsbl/moss-multi/actions/runs/37194871289). The checker's five findings, written as tests against attempt 1's prototype, were red before this design replaced it (see the T1.R commit history). The final green run is on the branch head.

**P0 (c) reproduction.** Attempt 1 made two local passes on m1 `8d2a388`, warm and cold, and neither reproduced the loss. The spike rules out binding order. Three mechanisms remain that fit "committed locally, gone after reload", and this design removes the first. T1.F4 removes the other two.

1. A second creator for one id. The node transform calls `registers.set` whenever `!registers.has(id)`, and so does `migrateRegisters`. Y.Map then keeps one `Y.Text` and silently drops the other's text. Rule 2 removes both paths.
2. A view that captured the payload `Y.Text` at mount (`useRegisterDraft`'s observer effect, keyed only by node key).
3. Whole-value setter calls from view state that missed a peer's edit: `commitCode`, the double-Enter path's `textarea.value` and the Tab path's `localCode` in `CodeBlockNode.view.tsx`.

## Implementation brief

**T1.F2: payload creation, undo and the janitor (`packages/sync`, the plugin seams, the DocDO).**

- `packages/sync/src/registers.ts`: delete the node transform's `registers.set` and `migrateRegisters`'s map writes. Add `mintRegisterId(node)`, which records (editor, key) in a per-editor minted list, and `$createMintedPayloads(binding)`, which runs inside the binding transaction (rule 2). Readers and writers keep `__regId`. Nothing on a client calls `registers.delete`.
- Wrap `syncLexicalUpdateToYjs` and the create step in one `doc.transact(…, binding)`: in `vendor/lexical-react/shared/useYjsCollaboration.tsx` (seam plugin-b already wraps it through `syncUnderOrigin`) and in `server-doc.ts`'s mirror for `serverWrite` imports.
- `apps/web/src/host/collab/undo.ts`: add `deleteFilter: (item) => item.parent !== registers` (rule 5) and nothing else. T1.P's keep and recovery rules are not ported.
- New `packages/sync/src/janitor.ts`, a Yjs-level module with no Lexical dependency: index, J1–J5 and the trash interface. The DocDO calls it after every `applyUpdate`, passing the message's update and, for a sync step 2, the sender's state vector, before persistence and fan-out. `serverWrite` imports, pushes and restores call it too. Trash goes into the DO's SQLite (rule 7). Revival builds `Y.Item`s directly (`Y.Item`, `Y.getItemCleanStart`, `Y.ContentString` are exported) and then clears the text's search marker, as the spike does.
- Copies mint fresh ids (rule 1). The mixed-version gate (rule 9) goes into the DocDO's admission check.
- Tests: port every spike case to the real moss nodes (code, HTML, formula, including a formula inside a paragraph that splits) through `serverWrite`, the DocDO harness and two live clients. Flip the M1 `it.fails` to `it`. Add a frame scan proving a deleted payload's text never appears in a later joiner's sync step 2 or a version snapshot. Export bytes stay identical, and the j01 register legs run in both engines. Include a restart test: the trash and revive work across DO hibernation, because tombstones persist in the doc and trash persists in SQLite.
- Rewrite A§10.10's "Decorator payloads use registers" bullet in the same commit, so it states the janitor, trash and creator-only rules. Recheck deviation 21.

**T1.F4: views, drafting and joining (`apps/web/src/host/collab/register-input.ts` and the three view seams).**

- First, write a red j01 leg for the verified P0: Ada creates a code block from "```" and drafts; Ben joins the note mid-draft and opens the block; Ada commits; both reload. Vary the state: warm and cold stack, both engines, and Ben typing versus only opening the block.
- `useRegisterDraft` resolves the payload by id on every write and re-subscribes when the id's `Y.Text` changes, never holding one from mount.
- Remove or convert every whole-value setter call from view state on a bound note: `commitCode`, the double-Enter and Tab paths, and the HTML and formula commits. Edits go through the field's own minimal diff against the payload's current text, with a caret hint.
- A block whose payload has not yet arrived, or whose text the janitor is reviving, renders its cache read-only and accepts input only once the payload is present. A remote dedupe that removes an open field's block closes the field with a visible notice. A leg covers a peer moving a block while its field is open.

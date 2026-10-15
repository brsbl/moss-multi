# Decorator payload lifecycle (T1.R design review)

**Decision: give each payload its own Y.Doc, keyed by its block's stable id, and have the DocDO withhold a payload while no live element names it. Nobody ever deletes payload text on anyone's behalf.** A code block's code, an HTML block's HTML and a formula's source each become a `Y.Text` in a payload doc whose guid is the block's `__regId`. The note's own doc carries only the id. The payload doc syncs over the note's socket under its own message type. The DocDO keeps every payload's updates in a private SQLite table, and it decides per frame, before anything is sent:

- while a live element names the id, the payload is served like the note: updates fan out and a step 1 is answered;
- while none does (the block was deleted, or its creation undone), updates are stored and acknowledged but neither fanned out nor answered, so later readers, duplicates and versions never get the text;
- when an element names the id again (undo, redo, a raced move), the server sends the payload's state to every socket. That includes everything typed meanwhile, under the original item ids.

Because nobody rewrites payload text, every client edit keeps its identity. A late erase, an author's undo and a reconnect's step 2 land exactly as Yjs places them. Attempts 1 and 2 broke exactly that.

## Owner summary

- **What was wrong.** In M1, deleting a code, HTML or formula block left its text in the shared state, so later readers and duplicates still received it (the privacy P1). Deleting the text together with the block breaks moves, because a move deletes the block and recreates it under the same id, and no client can see a move happening elsewhere at delete time. T1.P tried to repair that race on the clients and failed three checks.
- **Why the two earlier designs failed.**
  - Attempt 1 put the text inside the block. A move then copied the text, so a peer's typing during the move was lost.
  - Attempt 2 had the server delete the text and re-insert it on undo. The re-inserted text is new to Yjs. A later erase or undo aimed at the old text then misses, and Yjs cannot tell a peer's deletion from a peer merely repeating the server's. The checker showed text lost, doubled and served.
- **What changes now.**
  - Each block's text is its own small document beside the note. Deleting the block hides that document from everyone who has not already got it: late readers, duplicates, versions and exports. Nothing is erased, so undo, redo or a move that raced the delete shows it again exactly as it was, including what others typed meanwhile.
  - Hidden text waits in server storage for 30 days, the same retention as deleted notes. It is never sent to anyone while hidden.
  - Only the person who creates a block writes its first text. Someone joining mid-draft only reads, so they cannot replace it (the verified P0).
- **What stays the same.** People typing in one code block merge character by character, Cmd+Z undoes only your own edits (body and code in one stack, as in M1), a move keeps every character, and export bytes do not change.
- **What you give up (narrow):**
  1. Undoing the creation of a block that someone else typed into hides it, along with their typing, until redo. For paragraphs, m1 is worse today: the spike shows V1 deletes the other person's text with the paragraph, and redo does not restore it. That is a tree-wide undo question, filed separately.
  2. When a delete and a move of one block race, the move wins, as it does for a paragraph.
  3. When two people move the same block at the same moment, or a deleter's undo races a move, two copies appear briefly and the server keeps one. **A setting changed on the removed copy at that same moment, such as the code language, is lost.** The text is never lost, because both copies show the same text. Which copy survives, and so where the block ends up, is arbitrary.
  4. Someone who had the block open when it was deleted already has its text, as with any shared edit. Hiding stops new readers, not people who already saw it.
  5. Undoing a delete more than 30 days later brings back the block with empty text.
- **Cost.** A keystroke in a block costs the server one lookup. Deleting or moving a block costs the elements V1 rewrote. A move rewrites more than the moved block: V1 recreates every later sibling, so moving block 120 of 200 rewrote 79. Restoring a block costs one send of its text. There are no scans of the note or of stored text. The client keeps T1.9s's per-id refresh, which gets cheaper because each payload has its own observer.

## Requirements and how each is met

| Requirement | M1 map | Attempt 1: text in the element | Attempt 2: map + janitor | Chosen: withheld payload docs |
| --- | --- | --- | --- | --- |
| (a) Deleted text not served to later readers, viewers or duplicates | Fails (`it.fails` below) | Met | Fails: offline typing into a deleted block was persisted and fanned out before the janitor ran (P1-3) | Met. The note's state never holds payload text. A withheld payload's frames go only to private storage, decided before any send. Snapshot, duplicate and export read only named payloads |
| (b) No loss or doubling under delete, move, undo | Moves fine; never deletes | Loses typing that races a move | Loses or doubles text around revival (P1-1, P1-2) | Met. No text is ever rewritten, so every edit and undo applies to the original items. Delete ∥ move, concurrent moves and undos, multi-step undo, late erases in every arrival order and reconnects all converge with the text once |
| (c) A joiner never loses the drafter's committed code | A second `registers.set` replaces the `Y.Text` | Met | Met | Met structurally. A payload doc has no map slot to overwrite, and only the minter writes its first text. A joiner at every point of the draft's frame stream costs nothing, and the payload's items all come from the drafter |
| (d) Cost proportional to the change | T1.9s fixed the walk | Met | Honor scanned all trash per update; dedupe walked the note (P2) | Met. Per note update the server's work is the ids it touched. A payload update costs an O(1) naming check. Dedupe costs the copies of one id |

## Why the alternatives fail

| Option | Verdict |
| --- | --- |
| A. Map, with the client deleting the payload alongside the block (T1.P) | Rejected. A client cannot see a concurrent move at delete time, and a client-side repair is a second writer for the same text. |
| B. Payload inside the block's own element (attempt 1) | Rejected. A V1 move copies the text into a new element, so racing typing is lost, and V1 recreates every later sibling, so the loss would reach every block below a moved one. |
| C. Map plus a server that deletes unnamed text and re-inserts it (attempt 2) | Rejected. Re-inserted text gets new ids, so late operations on the old ids miss (P1-2). Yjs deletions are state, not authored operations: a step 2 echoes every deletion its sender knows, including the server's own, and carries no state vector (P1-1). A server write after `applyUpdate` comes after the DocDO persisted and y-partyserver fanned out the update, both synchronously inside `applyUpdate` (P1-3). |
| D. Lexical named slots (`@experimental` in 0.48) | Rejected for now. It rewrites moss's node model and has B's move problem. |
| E. Yjs subdocuments (`Y.Doc` inside the note's doc) | Not used. y-partyserver does not sync subdocs, and the parent's map slot would bring back the LWW slot of (c). An explicit payload doc per id, keyed by `__regId`, gives the same separation without that slot. |
| F. Glyphdown | Not applicable. Its body is one `Y.Text` of markdown, so a fenced block is plain characters with no lifecycle. Our V1 tree schema is fixed (A§10.2). |
| Moss desktop at the pin | One writer and whole-value fields (`CodeBlockNode.tsx:535`, `FormulaNode.tsx:252–260`), so it has no concurrency to manage. |

## Lifecycle rules

1. **Identity.** `__regId` is minted once by the client (or `serverWrite`) that creates the node. Property sync carries it through every V1 move, including a move of the paragraph or container around it. Every copy mints a fresh id and writes its text as a new payload: clipboard, `$copyNode`, duplicate block and import. `afterCloneFrom` keeps the id only for `getWritable` clones.
2. **Create.** Only the minter writes a payload's first text, in the binding update that creates its element, driven by its own minted-ids list (so nodes inside a new paragraph or container are covered). That write is outside every undo manager. No other path writes a payload's text except a user's edit through the field: not transforms, hydration, remote updates, undo, refresh or migration on a client.
3. **Move.** Nothing to do. The id is unchanged and the payload is untouched.
4. **Delete.** The client deletes the element. The payload is left alone everywhere.
5. **Withhold and reveal (DocDO).**
   - The naming index (id → live elements) is kept from each note transaction's own structs: the elements it integrated and the ones it deleted, across whole subtrees. It is built by the load replay. Its cost is the transaction.
   - Before fan-out, a payload update fans out only if its id is named. Otherwise it is stored and acknowledged, and nothing else happens.
   - A payload step 1 is answered only for a named id.
   - After each note update, every id that went from unnamed to named has its payload state sent to every socket.
   - Snapshots, duplicates, versions, exports and the CLI read only named payloads.
6. **One element per id (DocDO).** After each note update, an id with two or more live elements keeps the element with the lowest Yjs item id and deletes the others (origin `janitor`, which no client tracks). Concurrent moves, or an undo racing a move, are the only causes. Dedupe costs the copies of one id.
7. **Undo.** Cmd+Z in the body is one stack over the body's `UndoManager([root])`, tracking `binding`, and one `UndoManager` per held payload doc, tracking `REGISTER_LOCAL_ORIGIN`. A Y.UndoManager spans one doc. The stack records which manager took each new tracked edit and replays that order. A new edit clears every manager's redo stack. Undoing a creation removes the element, which withholds the payload. Redo brings the element back, which reveals it.
8. **Storage.** A DocDO SQLite table `payload_updates(reg_id, seq, data)`, compacted per id like `yupdates`, plus `payload_meta(reg_id, unnamed_since)`. A payload unnamed for 30 days is dropped, and so is everything when the doc is purged. Payload docs load lazily, on first frame or step 1 for that id, or on reveal. `stateBytes` counts the note plus named payloads; withheld payloads have their own cap, oldest dropped first.
9. **Reads and events.** Each node getter reads its payload doc's text through the registry, with T1.9s's cache. A payload's own observer refreshes only its node, so the V1 observer is untouched. A node whose payload has not arrived renders its cache read-only and never invents text.
10. **Mixed versions.** Nothing has shipped. Before staging carries real docs, the server refuses clients whose bundle predates this design: every doc socket names its client protocol, and one older than `MIN_CLIENT_PROTOCOL` (or none) is closed 4426 before it reaches the DocDO, with an in-app "reload to update" (A§4.1, A§10.5; T8.0). The load pass moves an M1 doc's `Y.Map('registers')` entries into payload docs, with the server as their only writer, and deletes the map entries (GC drops the bytes). Unnamed entries become withheld payloads.

## Evidence

The spike is `packages/sync/src/register-lifecycle.spike.test.ts` (unit lane). It runs on the real `@lexical/yjs` 0.48 V1 binding with `yjs` 13.6.31. Clients send one frame per transaction, as a connected provider does. The server is a DocDO model: GC on, no undo manager, and a `wire` log of every byte it persists for the note or sends on a socket. Frames are delivered from per-socket inboxes. A reconnect drops queued frames and exchanges y-protocols step 2s, which carry an update and nothing else. A restart rebuilds the server from what SQLite would hold.

- **The checker's three P1s, as regressions** (red on attempt 2's janitor in [37200631229](https://github.com/brsbl/moss-multi/actions/runs/37200631229), green here, unchanged):
  - P1-1: a real step 2 after the delete, with no state vector, leaves the deleter's undo its text. The janitor returned `['']`.
  - P1-2: Ada's erase arriving after Ben's delete and undo is applied, and her undo restores it once. The janitor dropped the erase.
  - P1-3: offline typing into a deleted block is in no persisted or sent frame. The janitor's wire carried it.
- **Late operations in every order:** a peer's erase inside a block that is deleted and restored lands exactly, and its undo restores it once. Covered orders: before the delete, after the delete, after the restore, and through a reconnect after the restore.
- **Privacy:** after a delete, late readers, snapshots and the note's state carry no text, while the private store keeps it for undo (positive control first). Offline typing into a deleted block stays private (`withheld = 1`), and the deleter's undo brings it back.
- **Deleter's undo:** block and text come back with the payload's state vector unchanged (nothing rewritten), and the peer's own undo of their typing still works afterwards.
- **Moves:** typing that races a move is kept in both orders, including a long offline stretch. A formula in a moved paragraph and a block in a moved container keep their text and the peer's typing. The spike asserts V1 recreated the elements and nothing was withheld.
- **Delete racing a move:** both orders, three peers, then every undo. One block with the text once, and the mover's undo keeps a third peer's edit.
- **Concurrent moves, then concurrent undos:** exactly one block, in both orders. In a 40-block note, two concurrent moves rewrite overlapping siblings on both sides. One element per id survives, and the server compares only each id's two copies.
- **Undo of a creation** (a block, and a paragraph holding a formula) after a peer's edit hides both, and redo restores every character. The paragraph control shows V1's own loss.
- **Join (P0 c):** a peer joins after every prefix of a drafter's frame stream, and touches the block. The stream includes the first text arriving before its element. The drafter never loses a character, the joiner sees the text, and every item in the payload comes from the drafter.
- **Restart:** hibernation between the delete and the undo serves nothing early and loses nothing.
- **Migration:** an M1 doc's register entries become payload docs. The note's state no longer carries any text, and an orphan is never served.
- **Cost:** in a 200-block note, an edit costs the server no note ids. A delete or move costs exactly the elements V1 rewrote, with no reveals and no dedupe comparisons.
- **M1 comparison:** the map's privacy failure stays `it.fails`. A whole-value write of a stale field snapshot deletes a peer's characters, which T1.F4 removes.

Earlier runs: attempt 1's tests-first run [37194871289](https://github.com/brsbl/moss-multi/actions/runs/37194871289); attempt 1's five findings red on its prototype [37198306446](https://github.com/brsbl/moss-multi/actions/runs/37198306446).

**P0 (c) mechanisms.** Three mechanisms fit "committed locally, gone after reload". This design removes the first; T1.F4 removes the other two.

1. A second creator for one map slot: the node transform and `migrateRegisters` call `registers.set` whenever `!registers.has(id)`, and Y.Map keeps one `Y.Text`.
2. A view that captured the payload at mount (`useRegisterDraft`'s observer effect, keyed only by node key).
3. Whole-value setter calls from view state that missed a peer's edit: `commitCode`, and the double-Enter and Tab paths in `CodeBlockNode.view.tsx`.

## Implementation brief

**T1.F2: payload docs, the DocDO gate, undo (`packages/sync`, `packages/protocol`, the plugin seams).**

- `packages/protocol`: a payload message type on the doc socket, binary `[PAYLOAD, regId, y-protocols sync message]`. Use a type number y-protocols does not use, for example 7. The provider registers it in its own `messageHandlers`, and DocDO `parseFrame` gets a `payload` kind (unknown types are dropped today).
- New `packages/sync/src/payloads.ts`, Yjs-level with no Lexical: the naming index (the spike's `nameIndex`), and the payload store over SQLite (rule 8) with lazy load, compaction and TTL. Add `gate(id)`, plus reveal and dedupe after each note update (rules 5 and 6).
- `doc-do.ts`:
  - Route payload frames through the same role, rate and size gates as note frames, each classified against its own payload doc.
  - Apply the frame. Fan it out only if the id is named, otherwise store it. Ack it in the existing ack, extended with per-payload vectors, so `data-sync-unacked` covers code typing.
  - Answer payload step 1s only for named ids.
  - After every note update (frame, `serverWrite`, restore, push), run reveal and dedupe in the same handler.
  - `snapshotForDuplicate`, `createFromSnapshot` and exports carry named payloads only.
  - On load, move M1 `registers` entries into payload docs (rule 10).
- `registers.ts`:
  - The register map becomes a per-editor payload-doc registry. Delete the node transform's `registers.set` and `migrateRegisters`' writes.
  - `mintRegisterId(node)` records the minted key, and the binding update writes each minted payload's first text under an untracked origin (rule 2).
  - Getters and the T1.9s cache read the payload doc. Each payload doc's observer refreshes its node.
- The client session: hold one Y.Doc per named id, send its frames on the doc socket, and on every connect and wake send step 1 and step 2 for each held payload. Destroy them with the note's doc (A§10.1 teardown order). `server-doc.ts`'s mirror resolves payloads from the DocDO's store.
- `apps/web/src/host/collab/undo.ts`: the body's one stack over the root manager and the per-payload managers (rule 7), replacing `UndoManager([root, registers])`. Seam (a) dispatches undo and redo to it.
- Tests: port every spike case to the real code, HTML and formula nodes through two live clients and the DocDO harness. Include a formula inside a paragraph that splits. Flip the M1 `it.fails`. Add:
  - a frame scan proving a deleted payload's text never appears in a later joiner's frames, a duplicate, a version or `yupdates`;
  - a restart test across DO hibernation;
  - a wake resync with a held, withheld payload;
  - an ack test for withheld frames.
  Export bytes stay identical, and the j01 register legs run in both engines.
- Rewrite A§10.10's "Decorator payloads use registers" bullet, A§5.1's shared-types list and A§10.2 seam (a) in the same commit. Recheck deviation 21.

**T1.F4: views, drafting and joining (`apps/web/src/host/collab/register-input.ts` and the three view seams).**

- First, write a red j01 leg for the verified P0: Ada creates a code block from "```" and drafts, Ben joins the note mid-draft and opens the block, Ada commits, and both reload. Vary the state: warm and cold stack, both engines, and Ben typing versus only opening the block.
- `useRegisterDraft` resolves the payload doc by id on every write and re-subscribes when the id's doc changes, never holding one from mount.
- Remove or convert every whole-value setter call from view state on a bound note: `commitCode`, the double-Enter and Tab paths, and the HTML and formula commits. Edits are minimal diffs against the payload's current text under `REGISTER_LOCAL_ORIGIN`, with a caret hint.
- A block whose payload has not arrived renders its cache read-only and accepts input once the payload is present. When a remote dedupe removes an open field's block, the field closes with a visible notice. A leg covers a peer moving a block while its field is open.

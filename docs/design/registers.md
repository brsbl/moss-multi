# Decorator payload lifecycle (T1.R design review)

**Decision: move each decorator payload into its own block.** A code block's code, an HTML block's HTML and a formula's source become a `Y.Text` stored as an attribute of that block's own Yjs element, instead of an entry in the shared `Y.Map('registers')`. Deleting, restoring, copying and serving the block then carry the payload with it, through Yjs's own rules, with no lifecycle code of ours. `@lexical/yjs` already stores `__state` and `__slots` this way (`Utils.ts:55–100`), so this is the binding's native shape, not a workaround.

## Owner summary

- **What was wrong.** Code, HTML and formula text lived in a side table keyed by an id the block carries. A block and its text could therefore drift apart. Deleting a block left its text in the table, where later readers and duplicates still received it (the privacy P1). Deleting the text with the block broke moves, because a Lexical move deletes the block and recreates it under the same id, and another person's concurrent delete could not tell the two apart. T1.P tried to repair that race after the fact and failed three checks: lost text, doubled text, and revived deletions.
- **What changes.** The text moves inside the block. Delete the block and its text goes with it, in the same step, so the server stops serving it at once; undo brings both back together. A move copies the text into the new block, as Lexical's collaboration binding already does for every paragraph. Nobody but the block's creator ever creates its text, so a person joining mid-edit cannot overwrite it.
- **What you give up (stated plainly).** These are limits of Lexical's move model that every block type in the editor already has; none is new to code blocks:
  1. Characters typed into a block by one person during the fraction of a second in which another person moves it are lost.
  2. Text typed offline into a block someone else deleted is lost, as it would be in a deleted paragraph.
  3. Two people moving the same block at the same moment get two copies of it.
- **What stays the same.** Two people typing in one code block still merge character by character. Undo still removes only your own typing. Export bytes do not change.
- **Cost.** Each edit touches one block. The full-map refresh that T1.9s is fixing disappears for payloads, because a payload edit names its block directly.

## Requirements and how each is met

| Requirement | Map model (M1 head) | Element-owned payload |
| --- | --- | --- |
| (a) Deleted payload text is not served to later readers, viewers or duplicates | Fails: the map entry survives its block (spike `M1 map: a deleted block's payload…`, red in run 37194871289) | Deleting the element deletes its attribute types in the same transaction; the DocDO's doc runs with `gc: true` and no undo manager, so the text is collected before any later sync step 2 or snapshot copy (spike, two tests) |
| (b) No loss or doubling under delete, move, undo | Cannot hold with a delete rule: the deleter cannot see a concurrent move that re-names the id (T1.P's three rounds) | Delete ∥ move: the mover's copy survives with the text once. The deleter's undo restores nothing the move kept. The mover's undo keeps a third peer's edit. Both merge orders are covered (spike) |
| (c) A joining peer never loses the drafter's committed code | A payload can be created by any peer whose map lacks the key, and Y.Map then silently drops one of two concurrent `Y.Text`s | Only the element's creator attaches a payload, inside the transaction that creates the element; peers never create, replace or whole-value-write one (spike, every join point) |
| (d) Cost proportional to the change | A refresh walks every node, or every register | A payload event's target is the payload, whose parent element names the Lexical key (`_collabNode._key`); exactly one node refreshes (spike asserts one key per event) |

## Why the map cannot be fixed in place

The id outlives any one element: V1 has no move operation, so `syncChildrenFromLexical` deletes the old element and creates a new one for a moved key (`CollabElementNode.ts:583–606`). Whether a payload is still wanted is therefore a global question ("does any live element, anywhere, on any peer, still name this id?"), and no client can answer it at delete time.

- **Client deletes the payload with the block (T1.P).** A concurrent move re-names the id after the delete, so the merged doc holds a live block with empty text. Repairing that afterwards needs the mover to re-insert text, which doubles it when the deleter also undoes, and revives a third peer's deletions.
- **Server reclaims unnamed payloads.** The deleter's undo restores the block but cannot restore text a server-origin transaction removed, since server writes never enter a client undo manager (A§10.8). It also leaves deleted text served for the length of the reclamation delay.
- **Never delete.** This violates (a).

An element-owned payload has no id to outlive. Its lifetime is its element's lifetime, and every peer agrees on that by construction.

## Alternatives considered

| Option | Verdict |
| --- | --- |
| A. Map plus client delete and racing-move recovery (T1.P) | Rejected: three failed checks. Recovery is inherently a second writer for the same text. |
| B. Payload as a `Y.Text` attribute of the block's element | **Chosen.** Native to V1 (`__state` and `__slots` precedent); delete, undo, GC, duplicate and snapshot semantics come from Yjs. |
| C. Map plus server-authoritative reclamation | Rejected: it breaks the deleter's undo (server origins are not undoable) and serves deleted text until the pass runs. |
| D. Lexical named slots (`@experimental`, 0.48): the payload as a nested Lexical node | Rejected for now: it rewrites moss's node model and views (a textarea over a slot editor), and the API is experimental. It has the same lifecycle as B, so B keeps this door open. |
| E. glyphdown's model: the whole body is one `Y.Text` of markdown (S-gd §0) | Not applicable: a fenced block is plain characters there, so it has no payload lifecycle at all. Our V1 tree schema is fixed (A§10.2). |
| Moss desktop at the pin | One writer and whole-value fields (`CodeBlockNode.tsx:535`, `FormulaNode.tsx:252–260`); no concurrency to manage. |

## Lifecycle rules

1. **Create.** In the binding's own transaction (origin `binding`), right after `syncLexicalUpdateToYjs`, each register-type element *this transaction created* gets `element.setAttribute('<field>', new Y.Text(text))`. The text is the old element's live payload when the key had one before the sync (a move), else the node's cache (a new block or a paste). The attribute key is the excluded field name itself (`__code`, `__rawHtml`, `__formula`), as `__slots` reuses its field name, so the binding never syncs or restores it as a property.
2. **Never create for another client's element.** Hydration, remote updates, undo and redo (collaboration or historic tags) never attach a payload. An element with no payload (legacy data before migration) reads its cache and refuses edits; it never invents text.
3. **Read and write.** Resolve the payload through `binding.collabNodeMap.get(key)._xmlElem.getAttribute(field)` at the moment of use. Never hold a `Y.Text` across a move: the element, and so the payload, is new after one. Writes are minimal diffs under `REGISTER_LOCAL_ORIGIN`, from text read from the payload in the same tick.
4. **Remote events.** The tree observer routes events whose target is a payload (`isPayload`: a non-`XmlText` `Y.Text` whose `_item.parentSub` is a register field) to a per-key cache refresh, and passes only the rest to `syncYjsChangesToLexical`. Unrouted, V1 raises "Expected text, element, or decorator event" (spike).
5. **Delete.** Nothing to do: Yjs deletes the payload with its element.
6. **Undo scope.** `[root]` only, since payloads are inside root. The undo manager's `deleteFilter` keeps any block whose payload holds another client's live text (T1.P's rule, now local to the block), so undoing a creation or a move never takes a peer's typing.
7. **Undo identity check.** `__regId` stays as the block's identity (minted once, kept through Lexical moves, fresh on every copy). After an undo or redo transaction, the undoing client deletes, in an untracked follow-up transaction, any block that undo just created when another live block, not created by that undo, has the same id. A block a peer moved is then never resurrected beside its moved copy. Only the undoer acts, and only on elements it just created, so the check can never delete a peer's content.
8. **Copy.** Clipboard, `$copyNode` and duplicate-block paths mint a fresh `__regId`; `afterCloneFrom` keeps it only for `getWritable` clones (same key). Duplicate-note copies the Yjs snapshot, payloads included, into a new doc.
9. **Server.** The mirror uses the same binding hooks (create rule, event routing), so `serverWrite` imports carry payloads, and export reads through the node getters unchanged. The DocDO migrates persisted M1 docs once in `onLoad` (one serialized writer, so no race): each element without a payload gets one from its `registers` entry, or from a legacy string attribute, and then every `registers` entry is deleted. That deletion also removes the orphans the map has already stored.

## Evidence

Spike: `packages/sync/src/register-lifecycle.spike.test.ts` (unit lane). It runs a prototype on the real `@lexical/yjs` 0.48 V1 binding and `yjs` 13.6.31, with a server doc that has GC on and no undo manager, as the DocDO does.

- Privacy: the deleted text is absent from the bytes of the served state, a late reader and a duplicate copy; a positive control precedes the check.
- The deleter's undo after the server collected the text restores block and payload in one step, including a peer's characters; a late reader sees them.
- Move: one payload carries every character for peers and after reload.
- Delete racing a move, in both merge orders, with three peers: one block, text once; the deleter's undo restores nothing extra; the mover's undo keeps the third peer's later edit. A control without rule 7 shows the V1 doubling.
- Concurrent typing in one payload merges, undo is per client, and a remote edit names exactly one block.
- Join: a peer that hydrates after every prefix of a drafter's update stream, and then touches the block, never costs the drafter a character.
- The stated limits run as tests: typing that races a move, and offline typing into a deleted block, are lost and never served.
- M1 comparison: the map's privacy failure is `it.fails`. The binding order is shown safe (the register precedes its element on the wire, and Yjs integrates one client's updates in clock order). A whole-value write of a stale field snapshot is shown to delete a peer's characters.

The tests-first run was red on the M1 privacy assertion: [37194871289](https://github.com/brsbl/moss-multi/actions/runs/37194871289).

**P0 (c) reproduction.** Two local passes on m1 `8d2a388`, one on a warm DO and one after a stack restart, did not reproduce the loss. In both, Ada created a code block with "```js", drafted it, and Ben joined, opened the block and typed in it while Ada kept typing. The spike rules out binding order. Three mechanisms remain that fit "committed locally, gone after reload", and the design removes each:

1. A second creator for one register key. Any path that calls `registers.set(id, …)` for an id the client did not mint makes Y.Map keep one `Y.Text` and drop the other's text without error: the node transform when `!registers.has(id)`, and `migrateRegisters`.
2. A view that captured the payload `Y.Text` at mount, so it keeps showing text the doc no longer names (`useRegisterDraft`'s observer effect, keyed only by node key).
3. Whole-value setter calls from view state that missed a peer's edit: `commitCode`, the double-Enter path's `textarea.value` and the Tab path's `localCode` in `CodeBlockNode.view.tsx`.

T1.F4 must first reproduce the evidence pass's journey as a red j01 leg.

## Implementation brief

**T1.F2: payload storage and lifecycle (data model; `packages/sync`, the plugin seams, the DocDO).**

- Replace the map in `packages/sync/src/registers.ts` with the element-owned payload: `payloadOf(binding, key)`, the create hook (rule 1), `isPayload` routing (rule 4), and per-key cache refresh. Delete `bindRegisters`'s node transform, `$refreshRegisters`'s full walk and `migrateRegisters`'s map writes. Readers in the node seams (`readRegister` and `writeRegister`) resolve through the active editor's binding; keep `__regId` as identity only.
- Wrap `syncLexicalUpdateToYjs` in one `doc.transact(…, binding)` with the create hook, in `vendor/lexical-react/shared/useYjsCollaboration.tsx` (seam plugin-b already wraps it through `syncUnderOrigin`) and in `server-doc.ts`'s mirror; route payload events in both observers.
- Undo: scope `[root]`, the `deleteFilter` keep rule, and the post-undo identity check (rule 7), in `apps/web/src/host/collab/undo.ts`. Index live register blocks by `__regId` through Lexical mutation listeners rather than walking the root.
- Copies mint fresh ids (rule 8). The DocDO migration (rule 9) ships with a test over a persisted M1 doc state that holds a register map, including an orphan.
- Tests: port each spike case to the real moss nodes (code, HTML and formula, including a formula inside a paragraph that splits) through `serverWrite`, the DocDO harness and two live clients. Flip the M1 `it.fails` to `it`. Add a frame scan proving a deleted payload's text never appears in a later joiner's sync step 2. Export bytes stay identical. Run the j01 register legs in both engines.
- A§10.10's "Decorator payloads use registers" bullet is rewritten in the same commit; deviation 21 is rechecked.

**T1.F4: views, drafting and joining (`apps/web/src/host/collab/register-input.ts` and the three view seams).**

- First, write a red j01 leg for the verified P0: Ada creates a code block from "```" and drafts; Ben joins the note mid-draft and opens the block; Ada commits; both reload. Vary the state: warm and cold stack, both engines, and Ben typing versus only opening the block.
- `useRegisterDraft` resolves the payload through `payloadOf` on every write and re-subscribes when the key's element changes (a local move recreates it), never holding a `Y.Text` from mount.
- Remove or convert every whole-value setter call from view state on a bound note: `commitCode`, the double-Enter and Tab paths, the HTML and formula commits. Edits go through the field's own minimal diff against the payload's current text, with a caret hint.
- A remote move that remounts an open field closes it with a visible notice, never silently. A leg covers a peer moving a block while its field is open.

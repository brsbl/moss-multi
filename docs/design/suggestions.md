# Suggestions: design (T5.0)

A suggestion is a record of the exact Yjs ops a suggester's private fork produced, plus id-precise delete parts. It lives beside the body until an editor accepts it. A suggester never writes the body. Accept applies the record to a mirror and lands it only if every gate passes, so it lands exactly what the reviewer was shown or nothing. Reject and withdraw write only the record.

This resolves ARCHITECTURE §13 "Suggestions" and spike SP11 for M5, and wins where A§13 is shorter. It replaces the vetting design of the first T5.0 attempt (`origin/t/T5.0-r1`), which failed six adversarial review rounds. A design panel then produced three designs; this is the winner, S3, amended by the judge (`.panel/T5.0-decision.md`, binding under the owner's delegation). PRODUCT restart rulings 16 and 17 hold.

Inputs: PRODUCT "Collaboration on meaning" (mean-2, L34) and the `suggester` role; A§5.1, §8, §10, §12, §13; LEARNINGS §4.3 and §4.12; glyphdown@faf98d0 `packages/editor/src/suggest-mode.ts` and `apps/web/src/components/editor/SuggestionsPanel.tsx`; the current binding, registers, converter and DocDO.

Evidence: the spike (§9) with red run [37220685257](https://github.com/brsbl/moss-multi/actions/runs/37220685257) and the green run linked there.

**Amended for payload docs (T5.P, coordinator ruling 2026-10-05; §14).** T1.F2 moved code, HTML, formula, chart and sketch payloads out of the note's `registers` map into one Y.Doc per payload (docs/design/registers.md). A record's ops now carry per-doc updates, leases cover the author's payload forks, G4 is `payload-alias`, and the preview shows payload diffs. Where this document still says "register", read "payload doc".

## 0. Invariants

These hold by construction; every later section serves them.

- **I1. A suggester never writes the body.** The body is `root`, `title`, `frontmatter` and every payload doc (§14). A doc-changing sync frame (the A§5.1 write classifier) from a connection whose live role is below editor gets `write-refused('role')` and close 4403 before Yjs applies it; A§5.1 step 2's floor is editor. Authorization reads the role, never the frame, so no struct form (GC, tombstone, same-value write, embed map, recursive delete, `__regId`, parking) reaches the body from a suggester.
- **I2. A suggestion is data.** Only the DocDO writes `Y.Map('suggestions')`, under origin `server-suggestions`; SP7 refuses every client frame that touches it, for every role (T4.1's classifier). A record's ops are stored and never applied to the body, except by accept.
- **I3. Accept is an editor action that lands exactly the diff the editor was shown.** That diff is the record's own bytes and exact delete targets, applied only while their context is unchanged (gates G0–G8, §4).
- **I4. Reject and withdraw write only record metadata and clear the record's ops and parts.** No code path writes the body on reject or withdraw. No other author's content can be inside a pending suggestion, because pending items exist only in the record (ruling 16, §4.6).
- **I5. Bounded DO cost.** Every client frame costs O(frame bytes): a body frame gets one `parseUpdateMeta` lease check; `suggest-ops` gets `parseUpdateMeta`, a struct decode for the `__type` check, lease lookups and one `Y.Array.push`; a delete part gets O(spans × log n) store lookups. O(doc) work happens only on an editor's rate-limited accept and preview.
- **I6. Ordinary suggest-mode writing is never refused.** The suggester types into a real moss Lexical editor bound to a local fork. An honest client is refused only on the record-closed race or a size cap; both are loud, and the client offers back everything not yet acknowledged.

## 1. Data

```ts
// suggestions.get(id): Y.Map
//  'meta'  : JSON {v:2, id, author, authorName, source:'live'|'cli', note?, createdAt, updatedAt,
//            status:'open'|'accepted'|'rejected'|'withdrawn', resolvedBy?, resolvedAt?,
//            clients:number[], continues?: id, continuedBy?: id, outdated?: Reason[], broken?: Reason}
//  'ops'   : Y.Array<{doc: 'body' | payloadId, update: Uint8Array}>   // V1 updates exactly as the author's fork produced them, per doc
//  'parts' : Y.Array<{id, kind:'delete', targets: IdSpan[], quote}>   // body items proposed for deletion
type IdSpan = { client: number; clock: number; len: number };
```

- `author` is the server principal; the client never supplies it. `quote` is derived by the DO and is display only.
- Each op is one fork transaction's update, so its delete set is only that transaction's deletes (§4.3 G5 reads it per op).
- DO SQLite (T5.2): `suggest_leases(client_id PK, principal_id, record_id NULL, next_clock, spent)`. A lease is a Yjs client id absent from the body's state vector and from every other lease. Each record owns its leases exclusively; a merge can give one record several.
- Caps: ops ≤ 256 KB per record; at most 20 open records per principal; all open records' ops ≤ 25% of `STATE_CAP`; the projected `stateBytes` cap and 300 writes per 5 s still apply.

## 2. Wire

Doc-socket string frames; replies use the `__YPS:` envelope.

- `suggest-lease` → `{clients}`. Entering Suggest pre-leases one active id and one spare.
- `suggest-ops {record, update}`. The first frame for an unused record id creates the record.
- `suggest-delete {record, part:{id, targets}}` and `suggest-undelete {record, partId}`.
- `suggest-merge {into, from}` and `suggest-withdraw {record}`.
- Replies: `suggest-ack {record, sv, parts}`, which counts toward `data-sync-unacked`, and `suggest-refused {record, reason}`.

## 3. DO ingest (bookkeeping, not authorization)

**Body sync frames.** From a suggester: I1. From an editor or owner: refused `protected-type` if `parseUpdateMeta(frame).from` names a leased id. An honest colliding client regenerates its clientID on rebind.

**`suggest-ops`.** The live role is suggester or above, and the record is open with this principal as author, or the id is unused. Then, with `m = parseUpdateMeta(update)`:

- every client in `m.from` is leased to this principal and bound to this record or a record it continues (an unbound lease binds now);
- `m.from[c] ≤ next_clock[c]` (no clock gap);
- the caps hold;
- every struct in the update sits in a channel of the §4.4 table (refused `channel`; §14). Each struct is placed through its explicit parent, or its origin, against the same update, the record's earlier ops and the note's docs, and every item enclosing it must sit in a table channel too; O(structs × (log n + depth)), depth capped at 256, with the delete set's ranges sorted once so each coverage check is a binary search. The caps run first, so an oversized frame is never placed. A struct ingest cannot place (its origin is gone, or its parent is a tombstone an editor deleted before the frame arrived) is left to accept, where it parks (G1) or integrates as GC (G5 c), so an honest suggester racing a delete is not refused (I6);
- every `__type` value written in the update names a registered node type. This is an O(frame) decode, a cheap early reject; the full check is G7.

If all pass, one server transaction pushes the update and bumps `updatedAt`, `clients` and `next_clock`. The delete set is not inspected here; accept's G3 checks every item it removes.

**Frames for a record that is no longer open.** Accepted: the frame opens a continuation record (same author, `continues`), whatever it holds, delete-only included, so `m.from` is not consulted. Rejected or withdrawn: `suggest-refused('record-closed')`.

**`suggest-delete`.** Every target is a live body item in a channel of the §4.4 table whose client is not under a pending lease; the DO derives the quote. O(spans × log n) plus the items named, capped per part.

**Refusal rate.** Three refusals per principal per minute trigger a 60 s 4429 cooldown.

## 4. Accept, reject, withdraw

### 4.1 Accept

`POST /api/docs/:id/suggestions/:sid/accept {previewHash, digest}` requires editor or above and is rate-limited per principal. It runs in one synchronous DO turn: the DO hydrates a gc-free mirror of the live doc, projects it (§4.4), applies every op and every delete part in one transaction `T`, and checks the gates. The first failure answers 409 with its reason and nothing is applied. An `outdated` or `broken` reason is stored on the record's meta.

### 4.2 Gates

- **G0:** the record is open, and its digest (every op's bytes, every part, its clients) equals the one the reviewer previewed.
- **G1 `unresolvable`:** `store.pendingStructs` or `store.pendingDs` is non-null after `T` (a clock gap, a missing origin, a delete of an unknown id).
- **G2 `foreign-client`:** a client advanced in `T` that is not in `meta.clients`.
- **G3 `outside-body`** (default-deny, §4.4 and §14): an item the record inserted, or an item its accept transaction deletes, outside the channel table. The deleted items are read from the transaction's own delete set, so they include what Yjs deletes implicitly: a deleted type's contents, and the value a map-key write overwrites. This covers title, frontmatter, comments, suggestions and every Yjs channel the preview does not render. An op holding a Skip struct is refused `unresolvable`.
- **G4 `payload-alias`** (§14):
  - a `__regId` the record writes sits on an element the record created (never re-points an existing decorator), and that element is the only live one naming the id;
  - a fresh decorator names only a payload id created in the same record (one the note did not know), never an existing payload, served or withheld;
  - the one exception is a move: the record removed every element that named the id, so after `T` its one new element names it (an Enter before an inline formula re-creates the decorator);
  - a payload op writes only a new payload or one a live element names before `T`, never a withheld one.
- **G5 `outdated`** (the structural precondition). An *authoring step* is one op (its own delete set) or one delete part (its targets). For each step, let R be the ids it removes that existed before `T` (the record's own inserts do not exist yet, so R is other people's items):
  - **(a)** every item of R is a live Item before `T`;
  - **(b)** in each parent sequence holding an item of R, walking it in document order, no live item outside R lies between two items of R (deleted items are skipped; a map key's overwrite chain is not a sequence);
  - **(c)** after `T`, every struct the record inserted (each leased client's clocks from its state before `T` to after) is a live Item unless the record's own delete set covers it. A struct that integrated as GC or deleted means its parent or neighbour is gone.

  Together these make "the record applies to the same context it was written against". A step's removals are one contiguous selection in the author's view (Lexical edits one range per transaction), so (b) is judged per step: a later step may keep text between earlier removals.

  **Deviation from the decision.** `.panel/T5.0-decision.md` states G5(b) over the record's whole removal set. Read that way, two separate deletes in one record (a and c of "abc") form one run with live "b" inside, so an honest record is refused (I6). Judging per step fixes that. It cannot remove foreign content: when an editor inserts X between two single-character parts on a and b, accept removes only a and b, X stays, and the hash-bound preview shows exactly that (I3). T5.3 pins it with `g5_split_parts_around_foreign_insert_keep_foreign_text_and_preview_shows_it`.
- **G6 `changed`:** `projectionDiff(before, after)` hashes to something other than `previewHash`.
- **G7 `broken`:** binding the converter editor to the result throws (an unregistered node type, an invalid parent), or rerunning the node transforms on every node the record created and its parent changes the body's shared content (a list item under the root gets wrapped). Same-value writes back are not changes.
- **G8 `doc-cap`:** the result exceeds the state cap.

The spike runs G1–G5 and G7 in `applyRecord`, then G6 and G8, so a record that fails several reports the first in that order.

### 4.3 Landing

On pass, the DO applies the mirror's diff from the hydration state vector to the live doc under origin `suggest-accept`, then in the same turn sets `status:'accepted'`, `resolvedBy`, `resolvedAt`, clears `ops` and `parts`, and marks the leases spent. Comment anchors refresh through T4.1's per-root-frame path, exactly as for an editor's direct edit.

### 4.4 projectionDiff (payload hunks per §14)

`packages/core/src/suggest/apply.ts`, shared by the client preview and the DocDO accept:

- **The channel table** (`CHANNELS`) is the whole surface a record may write or remove, and the projection renders exactly these channels, recursively:

  | Doc | Root | Parent type | Channel | Content |
  |---|---|---|---|---|
  | body | `root` | XmlText (an element; the root itself) | sequence | ContentString, ContentType(XmlText), ContentType(XmlElement), ContentType(Map), ContentDeleted |
  | body | `root` | XmlText | keys (node properties; the root's are root properties such as `__dir`) | ContentAny, ContentType(Map) (`__state`), ContentDeleted |
  | body | `root` | XmlElement (a decorator) | keys | ContentAny, ContentType(Map), ContentDeleted |
  | body | `root` | Map (a text node, a line break, a `__state`) | keys | ContentAny, ContentType(Map), ContentDeleted |
  | payload | `payload` | Text | sequence | ContentString, ContentDeleted |
  | payload | `payload-map` | Map | keys | ContentAny, ContentDeleted |

  These are the structs Lexical's V1 binding and the payload writers produce (@lexical/yjs 0.48: elements are XmlText, text and line breaks are Maps, decorators are XmlElements, properties go through `setAttribute` or `Map.set`; payload text goes through `applyDelta` without attributes, compound fields are JSON). Everything else is refused: any other root, sequence items on a Map, keys on a payload Text, Y.Text, Y.Array, XmlFragment and XmlHook types, ContentFormat, ContentEmbed, ContentBinary, ContentJSON and ContentDoc. A GC struct or ContentDeleted is accepted only inside the op's own delete set (an insert and a delete in one fork transaction), and types nest at most 256 deep. A struct is in the table only when its whole ancestor path is: every item enclosing it, from the root down, sits in a table channel with a listed content. So a key on a Map an editor nested in a Y.Array is refused even though Map keys are listed, because the Array edge is not and the projection renders an Array as its kind alone. Removals are checked against the same table at accept, over every item the accept transaction deletes, implicit deletions included (§4.2 G3).
- Each top-level block is keyed by its Yjs item id. Its value holds the converter editor's recursive `exportJSON` (children included; register-backed fields read through their getters), passed in by the caller, and the block's table rendering: each listed sequence as runs of characters and child types, each listed key by its content.
- Each payload a live element names is rendered by the table: its text and its compound fields. A payload hunk is `added`, `removed` or `changed`.
- The note root's keys (Lexical's root properties) form one `note` hunk when they change.
- Hunks are added, removed or changed; an added block carries the id of the block it follows, never an absolute position. The hash is SHA-256 over the hunks in id order.
- The card renders the same hunk list, so every change is shown. Display may label derived keys (`listitem.__value`); the hash always covers them.

### 4.5 Reject and withdraw

One server transaction sets the status, `resolvedBy` and `resolvedAt`, and clears `ops` and `parts`. Reject requires editor or above; withdraw requires the author, at any role from suggester up. The body is never written (I4).

### 4.6 D2b: ruling 16

Ruling 16 says reject and withdraw remove only the suggester's own items and keep other authors' words. Under this design it holds trivially: a pending suggestion's items exist only in its record, nobody can type inside it, and reject and withdraw write only the record.

### 4.7 Outdated, broken, empty, export

- A record that fails G5 or G7 on the client preview or at accept is badged, cannot be accepted, and offers "Copy suggested text", decoded from its ops bytes, so nothing is silent.
- A record whose preview has no hunks (a split and its undo) is auto-rejected by `onSave` with `resolvedBy:'system'`.
- The default export is the body: clean, with no pending inserts, so a pull-then-push can never accept a suggestion by accident. `?view=working` exports the composite of all valid open records. No marker ever enters any `.md`.

## 5. Client

**Docs per pane.**

- **B** is the provider doc. It is never mutated in Suggest mode.
- **F** is the fork: B plus the author's own valid open records, plus local delete parts painted as a strike. Used only in Suggest mode.
- **C** is the composite: B plus every valid open record, Lexical-free, updated incrementally and rebuilt when a record closes or turns invalid.

A record enters F or C only after `applyRecord` passes on a scratch copy: G1–G3, then a headless bind check. A record that fails is marked broken locally and excluded. As a backstop, Review mode falls back to B if binding C throws.

**Suggest mode** (a role-locked suggester, or an editor who toggled it):

- Lexical binds to F through a provider shim. F's clientID is the active lease. Sync status and awareness come from B. F is filled after the binding attaches, so the official plugin reconciles it like a first sync.
- **Forwarding.** Every F transaction whose origin is not one of the shim's own (`shim-body-apply`, `shim-record-apply`) is sent as `suggest-ops`: the binding, `REGISTER_INIT`, `REGISTER_LOCAL_ORIGIN`, the UndoManager, and anything added later. There is no allowlist to miss.
- **Routed deletes.** Explicit deletion over body items becomes a `suggest-delete` part with exact ids from the collab maps, and the caret moves past the struck text (glyphdown's `suggest-mode.ts`): Backspace, Delete, word and line delete, Cut, typing over a selection. Deleting the author's own record items is native.
- **Everything else is native and recorded verbatim:** Enter, soft break, formatting, links, lists, tables, checkboxes, indent, new decorators, register edits, paste, undo and drag.
- The title and Properties are read-only, and background writers are off.

**Grouping and leases.** A new group, with a new lease, starts after 30 s idle or more than one paragraph away. If a transaction references another open own record's leased ids, the client sends `suggest-merge` first; if it misses one, accept fails G1 loudly with "depends on X". While offline the active record continues, and a fresh lease is taken on reconnect. On accept, reject or withdraw of an own record, UndoManager stack items touching it are dropped and the client rotates leases.

**Edit mode** (editor and above) binds to B and paints an insertion wedge and a gutter bar at the left body neighbour of each run of record items in C; a strike on delete-part targets and on body items in any record's delete set; an attribute dot on blocks a record changes; and a hover popover that previews the inserted text. Clicking any of these opens the card, and a one-click "Review" switches modes.

**Review mode** is the default for viewers and commenters, and any role can choose it: a read-only Lexical bound to C, so every valid open suggestion is painted inline.

**Mode switches** wait for `data-sync-unacked=0`, remount, and restore the caret through a RelativePosition on body items.

**Refusal path** (`record-closed`, a size cap, or the leased-id refusal of a body frame):

1. Close input in the same tick.
2. Export the markdown of every block holding an unacked F change.
3. Rebuild F and remount.
4. Show "Copy what wasn't saved" in the band until dismissed.

Typing after the remount lands normally.

**CLI `--suggest`.** The T6.1 reconcile runs on a mirror under a leased id, and the diff becomes the record's ops. The diff must carry only the reconcile transaction's deletes: an update encoded with `encodeStateAsUpdate` carries the doc's whole delete set, and every already-deleted id in it reads as outdated under G5(a).

## 6. Cost

| Path | Cost |
|---|---|
| Body frame | +O(frame bytes) (the lease check) |
| `suggest-ops` | O(frame bytes) |
| `suggest-delete` | O(spans log n), items capped |
| Accept or preview | O(doc ≤ STATE_CAP), REST, rate-limited |
| Reject or withdraw | O(record metadata) |
| Client composite | O(frame) per update; O(doc) per record validation, debounced |

DO memory is about one doc, with no warm mirror. The spike measures ingest at the frame cap and the lease check on a small doc against the 1.69 MB census doc (§9, test 8).

## 7. Paint

Paint is derived and never mutates the tree (L§4.12), on the T4.0 paint layer (CSS Custom Highlights plus geometry, SP10).

- Review mode: record items in C paint `::highlight(suggest-insert)` (glyphdown's green, as moss-DS tokens); delete-part targets and body items in a record's delete set paint `::highlight(suggest-delete)` (strike, glyphdown's red).
- Edit mode: wedges and gutter bars at each insert run's left body neighbour, strikes, attribute dots on changed blocks, and the hover preview, positioned from range geometry in the pointer-transparent overlay.
- Hover and click find the suggestion under the pointer through the paint layer's hit test and open its card. The active suggestion gets an outline, mirrored in the list.

## 8. Review UI

- **Top-bar Suggestions button** (moss DS, beside `CommentsMenuButton`, inside `[data-top-bar]`): a count of open suggestions; it opens a popover list of glyphdown's `SuggestionCard`s rebuilt in the moss DS: author ("you" for own), time, the hunk list as `+` and `−` excerpts, an "outdated" or "broken" badge with "Copy suggested text", and Accept and Reject (editor and above) or Withdraw (the author). Open first, newest first; then "Reviewed", at most 20, dimmed. Comments on a suggestion go on its card. The empty state uses glyphdown's copy.
- **Suggestion popover** from the painted suggestion: the same card, built like moss's `CommentPopover`.
- Accept and reject converge on every client through the doc; a failed review shows its reason in the card, never a silent no-op.
- DOM contract additions: `data-edit-mode` on the pane, `data-suggestions-button`, `data-suggestion-card[data-suggestion-id][data-suggestion-status]`, `data-suggestion-popover`.

## 9. Census and spike

**Census.** Real moss editors (the converter's nodes, headless, bound V1 with the client's list and whitespace transforms and registers) make each operation on F through the fork shim. The census note holds a link, a soft line break, an inline formula, an indented paragraph, a quote, a check list, a bullet list, a table and a code block.

| Operation | Expected |
|---|---|
| Colliding prefix ("the " before "the cat"), a duplicated word, a sentence pasted before itself | recorded; accept equals the direct edit |
| Enter mid-paragraph before an original link, line break or inline formula | recorded; the moved formula decorator keeps its register (G4 move) |
| Enter in an indented paragraph and in a quote; Shift+Enter | recorded; accept equals the direct edit |
| Bold of own and original text | recorded as two ops |
| List Enter mid-list; Tab | recorded |
| Table row insert; checkbox | recorded |
| New code, HTML, formula, chart and sketch blocks | the payload's first text forwarded as an op on its new payload doc, after the block's body op |
| An edit of an original code payload | recorded as a payload-only op on that payload's doc |
| Undo of a split; join | recorded; a split and its undo shows no hunk |

**Spike** (`packages/core/src/suggest/apply.ts`; `packages/sync/src/doc/suggest.ts`, ingest with in-memory leases; `packages/sync/src/suggest/{records,review,fork-shim}.ts`; the DocDO role floor):

1. Forged-frame table as suggester body frames (`packages/sync/test/harness/suggest-role.test.ts`): GC overlap, clock gap, foreign client, tombstone, formatting mark, three same-value writes, text map before original text, new map behind new characters, recursive block delete, register Y.Text and Y.Map legs, `__regId` retarget, forged split past an untouched block, title, suggestions. Each is refused by role, close 4403, and the body's encoded state is byte-identical.
2. Census (`packages/sync/src/suggest/census.test.ts`): zero ops on bind; every frame ingests with no refusal.
3. Accept-equivalence oracle (same file): accept gives exported markdown and registers equal to an editor making the same steps directly on B. The oracle shares no code with the gates.
4. Reject and withdraw (`review.test.ts`): the body is unchanged and every changed type is under `suggestions`; only an editor rejects and only the author withdraws.
5. Gates (`review.test.ts`), forged records written straight into the map: G1 gap and missing origin; G2; G3 title, frontmatter, comments, suggestions; G4 original register, peer register, replaced entry, re-pointed decorator, deleted-while-named; G7 unregistered type and list item under root; G0 changed ops; a suggester's accept is 403.
6. G5 (`review.test.ts`): an editor types inside the run a bold record removed; deletes a delete-part target; deletes the paragraph a record inserts into (Yjs collects it); two records bold the same text and the second is accepted after the first.
7. projectionDiff (`review.test.ts`): text-only, attribute-only and register-only records each have a hunk; a stale preview hash gets 409 `changed`.
8. Cost (`packages/sync/src/doc/suggest.test.ts`): `suggest-ops` at the frame cap and the body-frame lease check, small doc against the 1.69 MB doc.

Red: run [37220685257](https://github.com/brsbl/moss-multi/actions/runs/37220685257) on the tests-first commit failed tests 2–8 on the unimplemented spike. In that run, 7 of the 17 role-table cases failed on `reason: 'suggest'`. The other 10 crashed while building their fixtures, because the helper read a deleted block. The fixture was fixed with the implementation. Red control for test 1: run [37223175293](https://github.com/brsbl/moss-multi/actions/runs/37223175293) runs the corrected table against m4's pre-change role floor (scratch branch `t/T5.0-red2`, which restores m4's `#refused`). All 17 cases fail there on `reason: 'suggest'` instead of `'role'`. Green: run [37221610786](https://github.com/brsbl/moss-multi/actions/runs/37221610786), 912 of 912 tests. Measured there (test 8, medians, one ~200 KB frame of 20 000 structs at the cap): `suggest-ops` 23.7 ms on a 3 KB doc and 14.5 ms on the 1.77 MB doc; the lease check of a typing frame plus the cap frame 9.4 ms and 11.2 ms. Neither grows with the doc; both are the frame's own decode.

## 10. What it costs users (ruling 17)

- In Edit mode, pending inserts show as markers and a preview, not inline; Review mode shows them inline.
- Nobody can type inside, or comment inline on, someone else's pending suggestion; comments go on the card.
- A pending format, split or delete whose text an editor later edits becomes outdated: shown, not acceptable, and its text can be copied.
- Format and split suggestions render as the re-created result, and the card shows the struck original.
- Toggling between Edit and Suggest remounts the editor.
- The default export is the clean body.

## 11. Findings disposition

Every finding from the six review rounds and the commit security reviews of the first attempt (`.panel/T5.0-review-history.md`), every panel break on S3 (`.panel/T5.0-panel-review.json`), and what the spike found.

| # | Source | Finding | Disposition |
|---|---|---|---|
| 1 | R1 P1 | A forged GC overlapping known clocks hides deletes of original text | Closed by I1: refused by role before apply. Test 1 "a GC overlapping known clocks" |
| 2 | R1 P1 | Owning a new container lets the author reformat moved original text or delete a peer's text in it | Closed by I1 and I4: there is no ownership of body items; pending items exist only in the record, so no peer text is inside one |
| 3 | R1 P1 | Insert parts lose identity when anyone splits or reformats pending text | Closed by I4: no identity carry; editors cannot reach pending items, which live only in the record |
| 4 | R1 P1 | Frames with clock gaps or missing origins are accepted, not refused | Closed by I1 for frames (test 1 "clock gap"); at accept by G1 (test 5 gap and missing origin) |
| 5 | R1 P1 | The client self-check cannot run the vetter in afterTransaction | Moot: there is no client vetting; nothing is refused locally (I6); F forwards every non-shim transaction |
| 6 | R1 P1 | A refusal only the server sees loses later typing on rebind | Refusals are limited to `record-closed`, caps and the leased-id refusal; the refusal path (§5) offers back every unacked block. T5.1 test: a record-closed race offers back every unacked block, and typing after the remount lands |
| 7 | R1 P1 | A new decorator's register is never owned, so editing it later is refused | Moot: register edits in F are recorded verbatim (census "new code block", "edit of an original code register"); G4 checks aliasing at accept |
| 8 | R1 P2 | Indent and join parts have no stored structure for the drift guard | Moot: no indent or join parts; both are native ops recorded verbatim (census "Tab in a list", "join"); no drift guard |
| 9 | R1 P2 | Link changes don't fit a numeric format part | Moot: no format parts; formatting is recorded verbatim |
| 10 | R1 P1 | The review-findings section was a placeholder | This table; no placeholders |
| 11 | R2 P1 | A forged tombstone (ContentDeleted) overwrites and deletes a live original map entry | Closed by I1. Test 1 "a tombstone placed after an original map value" |
| 12 | R2 P1 | Deleting an owned container recursively deletes moved or peer content | Closed by I1 (frames) and I4 (no peer content in pending items). At accept a record removing a container removes items shown in the hash-bound preview (G6); a foreign live item inside a removed run makes it outdated (G5b) |
| 13 | R2 P1 | An attribute write on an owned text map or block changes a peer's characters | Closed by I1; at accept any attribute change is a hunk (G6 covers the Yjs-level value). Test 1 "a text map placed before original text" |
| 14 | R2 P1 | Identity carry drops suggested text when a join removes its block | Moot: no identity carry (I4) |
| 15 | R2 P1 | Undoing a suggested split is refused | Closed by I6: census "undo of a split" ingests and accepts equal to the direct edit |
| 16 | R3 P1 | A same-value write deletes an original attribute | Closed by I1. Test 1, three same-value rows; at accept G6 hashes the Yjs-level attributes |
| 17 | R3 P1 | A new text map restyles original text through a new character between them | Closed by I1. Test 1 "a new text map behind new characters"; at accept the restyle is a hunk |
| 18 | R3 P1 | Reject and withdraw delete a peer's words in the suggester's new block | Closed by I4 and ruling 16 (§4.6). Test 4 |
| 19 | R4 P1 | Identity carry gives one copy to two records when identical characters sit side by side | Moot: no identity carry |
| 20 | R4 P1 | rejectPlan deletes a peer's text inside a suggested code, HTML or formula register | Closed by I4: no rejectPlan; reject writes only the record |
| 21 | R4 P1 | A forged split restyles original text through the fresh block's attributes | Closed by I1 (test 1 "a forged split"); an honest split's new block attributes are in the preview (G6), and a stale one is outdated (G5) |
| 22 | R4 P2 | Per-frame caps bound the frame's size, not the vetter's work | Closed by I5: no per-frame vetting. Test 8 |
| 23 | R5 P1 | A forged split moves original text past an untouched block | Closed by I1. Test 1 "a forged split moving original text past an untouched block" |
| 24 | R5 P1 | Deleting or retargeting an own decorator hides a peer's text in its register | Closed by I1 and I4 (no peer content in pending registers); a retarget at accept is G4. Test 5 "an original decorator re-pointed" |
| 25 | R5 P1 | rejectPlan misses a peer's entries in a Y.Map register | Moot: no rejectPlan (I4) |
| 26 | R6 P1 | Enter mid-paragraph is refused before an original link, line break or inline decorator | Closed by I6: census rows ingest and accept equal to the direct edit. The spike found that @lexical/yjs re-creates the moved formula decorator naming its register; G4 allows that as a move (§4.2) |
| 27 | R6 P1 | Attribute changes on an own decorator ignore a peer's content in its register | Closed by I1 and I4: no peer content in a pending decorator; at accept attribute changes are hunks |
| 28 | R6 P2 | rejectPlan misses Y.Map entries reached through a sequence | Moot: no rejectPlan (I4) |
| 29 | Security reviews | Forged tombstones and GC, same-value writes, embed maps restyling neighbours, recursive container deletes, decorator `__regId` and register ownership | Closed by I1: authorization reads the role, never the frame. Test 1 carries each family |
| 30 | Security reviews | Per-frame vetting cost (DoS) | Closed by I5. Test 8 |
| 31 | Security reviews | Parser differential: the vetter decoded the frame separately from what Yjs applied | Closed by I1 (no decode authorizes anything); accept judges Yjs's applied mirror transaction (G1–G5) |
| 32 | Panel P1 (S3) | projectionDiff on block exportJSON omits child text | Recursive serialization plus each block's Yjs-level value and full registers (§4.4). Test 7: text-only, attribute-only and register-only records each have a hunk |
| 33 | Panel P1 (S3) | Range marks with fuzzy matching delete unproposed words | Id-precise delete parts; G5(a) and (b) make a moved or interrupted target outdated; the quote is display only. Tests 6 "deletes a delete-part target" and ingest's target validation |
| 34 | Panel P1 (S3) | An unregistered node type crashes Review readers | Ingest's registry check, the client's bind check before F or C, Review's fallback to B, and G7 at accept. Test 5 G7 rows; ingest test "unregistered node type" |
| 35 | Panel P1 (S3) | Format and split records go stale and resurrect text at accept | G5, all-or-nothing. Test 6 "types inside the run a bold record removed" and "two records bold the same text" |
| 36 | Panel P1 (S3) | Edit mode shows pending inserts only as markers; the export default changes | Ruling 17 and DEVIATIONS 22; mitigated by wedges, the hover preview, one-click Review, and Review as the default for viewers and commenters |
| 37 | Panel P1 (S3) | REGISTER_INIT is not forwarded | The fork forwards every non-shim origin. Census "new code, HTML, formula, chart and sketch blocks" |
| 38 | Panel P2 (S3) | A delete-only frame racing an accept has no continuation path | Any frame for an accepted record opens a continuation; `m.from` is not consulted (§3). T5.2 test: a delete-only frame after accept opens a continuation record |
| 39 | Panel P2 (S3) | Leases run out while offline | The active record continues offline; a fresh lease on reconnect (§5). T5.1 scope |
| 40 | Panel P2 (S3) | Marks cost O(doc) per frame | No marks and no per-frame refresh; delete parts cost O(spans log n) (I5) |
| 41 | Panel P2 (S3) | Records under a GC'd parent integrate as GC and lose content | G5(c) treats GC and deleted inserts as outdated; the ops bytes are kept for "Copy suggested text". Test 6 "deletes, and Yjs collects, the paragraph" |
| 42 | Spike | An op encoded with `encodeStateAsUpdate` carries the doc's whole delete set, so every old deletion reads as outdated | Ops are per-transaction updates (§1); the CLI diff must carry only its own deletes (§5). Routed to T6.1/T7 `--suggest` |
| 43 | Spike | The binding writes object-valued decorator properties back unchanged when a node is marked dirty | G7 compares the body's shared content, not whether a write happened (§4.2) |
| 44 | Checker (attempt 1) | Editor and owner sync frames can still write `Y.Map('suggestions')`: I2 depends on T4.1 SP7, not yet on m4 | Design holds (I2). Routed: T5.2 `all_roles_cannot_write_suggestions_via_sync` |
| 45 | Checker (attempt 1) | A continuation record can overwrite an occupied record id; 48-character truncation can collide | Routed: T5.2 `accepted_record_continuation_preserves_occupied_id` |
| 46 | Checker (attempt 1) | Leases are never marked spent on accept, so accepted text can never be a delete target | §4.3 already marks leases spent. Routed: T5.2 `accepted_suggestion_text_is_valid_body_delete_target`, with the transition in T5.3 |
| 47 | Checker (attempt 1) | Root `XmlText` attributes are missing from the hash-bound projectionDiff | Routed: T5.3 `preview_hash_covers_root_attributes` |
| 48 | Checker (attempt 1) | G7 takes its baseline after hydration has repaired the candidate | Routed: T5.3 `g7_refuses_candidate_repaired_during_hydration` |
| 49 | Checker (attempt 1) | G5(b) is per step, not record-wide as the decision says | Deliberate, stated in §4.2. Pinned by T5.3 `g5_split_parts_around_foreign_insert_keep_foreign_text_and_preview_shows_it` |
| 50 | Checker (attempt 1) | Ingest cost grows with closed-record history and continuation depth | Routed: T5.2 and T5.4 `fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth` |
| 51 | Checker (attempt 1) | Red evidence for 10 of 17 role-table cases was a fixture crash, not the assertion | Re-proven red against m4's role floor (§9) |

## 12. Changes to other documents

- **ARCHITECTURE.** A§5.1: the write classifier no longer feeds suggester vetting; step 2's floor is editor ("a write from a role below editor gets `write-refused('role')` and close 4403, before Yjs applies it"); step 4 names the leased-id `protected-type` refusal instead of mirror vetting. A§13 "Suggestions" is rewritten to this design. SP11 is answered.
- **DEVIATIONS 22.** A pending suggestion stays beside the body until accepted; Edit mode shows markers; the default export is the clean body. It departs from glyphdown (A§0.5) and the earlier A§13 sketch, citing PRODUCT L34, rulings 16 and 17 and the six failed rounds.
- **PRODUCT.** Ruling 16 (carried from the first attempt, unchanged) and ruling 17:

  17. **A pending suggestion lives beside the body until an editor accepts it** (coordinator ruling under the standing delegation, 2026-10-04; it supersedes the "inserts physically enter the tree" sketch in ARCHITECTURE A§13 after six failed design reviews; the owner can overturn it). A suggester types into a private fork of the note with the full editor. Every change they make (text, Enter, formatting, lists, tables, blocks, code and other block payloads, undo) is recorded as their suggestion and never written into the shared note. Deleting existing text proposes deleting exactly those characters, which stay visible and struck. Nothing a suggester types is refused, except when someone rejects that suggestion while they are still typing in it; then the unsaved text is offered back to copy. An editor or owner accepts or rejects a whole suggestion. Accept applies exactly the change the reviewer was shown. A suggestion whose text an editor has since changed underneath it is marked outdated and cannot be accepted, and its text can still be copied. Reject and withdraw never change the note. Review mode, the default for viewers and commenters and one click for everyone else, shows pending suggestions inline. While editing, editors see them as markers with a preview. Nobody can type inside someone else's pending suggestion, and comments on it go on its card. Export is always the note without pending suggestions; `?view=working` exports it with them. Ruling 16 holds unchanged.

- **BUILDPLAN.** The M5 entries T5.0–T5.3 are replaced and T5.4 added with the panel's text verbatim (BUILDPLAN.md, M5). The previous T5.2 security brief is kept: each requirement is mapped to the invariant or gate that now owns it. Trace rows R16 and R17 are added for M5.

## 13. Routed follow-ups

Implementation-level items the spike leaves for the named tasks, each a red-first test in that task:

- **T5.2:** leases persisted in `suggest_leases`; open-record counts and bytes kept per principal without re-reading metas; the doc-socket handlers and acks; the `protected-type` refusal; `suggest-merge` and `suggest-undelete`.
- **T5.3:** the accept REST route with its rate limit; storing every failing reason; auto-reject of an empty preview; `?view=working`.
- **T5.2:** `all_roles_cannot_write_suggestions_via_sync` (I2 depends on T4.1 SP7, which is not on m4 yet; the spike's `#refused` checks only role, rate and cap); `accepted_record_continuation_preserves_occupied_id`; `accepted_suggestion_text_is_valid_body_delete_target`; `fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth` (findings 44–46, 50).
- **T5.3:** `preview_hash_covers_root_attributes`; `g7_refuses_candidate_repaired_during_hydration`; `g5_split_parts_around_foreign_insert_keep_foreign_text_and_preview_shows_it`; leases marked spent on accept (findings 46–49).
- **T5.4:** `fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth` at fuzz scale (finding 50).
- **T6.1/T7 (`--suggest`):** record ops built from the reconcile transaction's own updates (finding 42).
- **T5.R (DocDO wiring), P2 from the T5.P checks:** G8 at accept counts the note plus every stored payload, withheld ones included (A§10), not the body plus the payloads the record writes; the census oracle's fork binds payloads synchronously, where the client writes a new block's first payload text in a microtask, so the client's frame timing is pinned by T5.1's own census.

## 14. Payload docs (T5.P amendment)

T1.F2 gave each code, HTML, formula, chart and sketch payload its own Y.Doc keyed by the block's `__regId`, which the DocDO withholds while no element names it (docs/design/registers.md). The design above read the `registers` map; the coordinator's ruling of 2026-10-05 moves it onto payload docs:

- **Ops are per doc.** A record's op is `{doc: 'body' | <payloadId>, update}`, one fork transaction in that doc. The fork holds a private copy of each payload doc it touches, loaded from the note's served payloads, and forwards every non-shim transaction in any of them. A new block's body op precedes its payload's first text.
- **Leases cover the payload forks.** The fork writes every payload doc under the same leased client id as its body. Ingest checks `m.from` against the lease for payload ops as for body ops, keeping `next_clock` per (lease, doc); the `__type` check reads body ops only. T5.2 also checks a lease against a payload's state vector the first time a record writes that payload.
- **G4 is `payload-alias`** (§4.2): a fresh decorator may name only a payload id created in the same record, never an existing payload; a move keeps its one element. A payload op on a withheld payload is refused `payload-alias` before anything of it is loaded.
- **Edits to an existing payload are proposals.** Ingest stores them; nothing reaches the payload until an editor accepts. Accept hydrates a gc-free mirror of each payload the record writes, applies its ops in one transaction per doc, and runs G1 (nothing parked in any doc), G2 (only leased clients advanced in any doc), G3 (payload roots only), G4, G5 (a)–(c) per doc, G6, and G8. The preview projects, in full, every payload a live element names before or after the record and every payload the record writes, named or not, so the hash binds each payload change accept would land: a payload op for an id no element names shows as added, and an edit to a payload whose decorator the record removes shows its new text. A payload op may write only the payload rows of the §4.4 table, so an attribute on the payload text, a nested type in its map, a subdoc or any other struct the projection would not show is refused. G8 follows A§10: the state cap counts the note plus every stored payload, withheld ones included. The payload source exposes every stored payload's bytes, and accept counts them all (T5.R).
- **Landing** writes each touched payload's diff through the note's payload source, then the body's diff, as `serverWrite` does, so the body's new elements name payloads the note already holds.
- **Default-deny (the I3 rule).** Accept lands only what the hash-bound preview showed because a record can write nothing the preview does not render. The channel table (§4.4) is the one list of what a record may insert or remove; the projection renders exactly its channels; ingest (`channel`) and accept (G3 `outside-body`) refuse every struct outside it. A new channel is added to the table and the projection together, or it is refused. Three review rounds each found a channel the projection missed (payloads no element names; Y.Text attributes; sequence items on a Map root, formats on the root, and a subdoc's meta and options) before the table replaced enumeration. The census (`channels.test.ts`) crosses every content constructor, GC and Skip with every root and both parent channels, and again one level down under a parent of every Y type an editor wrote (on a table edge in the body's sequence, off the table at a payload-map key): each either shows in the preview and lands only as shown, or is refused at ingest and at accept. A struct counts as shown only when every edge of its ancestor path is a channel, not only its own (leaf) edge. A removal counts the same way: accept checks every item its transaction deletes, so a delete set naming only an in-table holder, or a forged key write over an off-table value, is refused at accept although ingest, which cannot know what the live doc will hold then, takes the frame.
- **Reject and withdraw still write nothing** but the record: no payload is touched (test 4 now carries payload ops and asserts every payload byte-identical).

Spike tests (T5.P): the census adds "payload ops are recorded per payload doc" (new code, HTML and formula blocks and an edit of an original code payload each travel on their own payload doc under the lease, and the body's payload is untouched until accept); accept-equivalence compares payloads in body order; the gate table adds a payload clock gap (G1), a payload update outside the record's leases (G2), the retired registers map and a payload op outside the payload's roots (G3), and for G4 a fresh decorator naming an original, a peer's or a withheld payload, an edit to a withheld payload, a re-pointed decorator and two fresh decorators sharing one new payload; G5 adds an editor typing inside payload text a record removed; projection adds a payload-only hunk, a proposal leg (the payload changes only at accept, as the preview showed), a payload op no element names, and a payload edit whose decorator the record removes (each shown in the preview and landed only as shown). The forged-frame table (test 1) adds an edit to an original payload, a fresh decorator aliasing an existing payload, a payload update outside the record's leases, and a payload frame for a fresh payload no element names, each refused by role with the body and every payload byte-identical; ingest adds payload ops on the same leases with per-doc clocks.

## Appendix: the BUILDPLAN M5 text (the panel's, verbatim)

BUILDPLAN.md carries this, plus one bullet in T5.2's security brief that maps the previous brief's requirements to their new owners.

- **T5.0 Design review** `[—·codex]`
  - **Scope:** `docs/design/suggestions.md`, built on the records model:
    - suggesters never write the body;
    - a suggestion is a record of the exact Yjs ops from the author's fork, plus id-precise delete parts;
    - accept is an editor action gated by G0–G8 and bound to a projection-diff hash;
    - reject and withdraw change only the record.
    - A spike proves the role gate, accept equivalence, reject leaving the body byte-identical, the gates, the outdated rule, projectionDiff and O(frame) ingest cost.
  - **Done:** merged, with every review-history and panel finding dispositioned, and the ARCHITECTURE A§5.1/A§13, DEVIATIONS and PRODUCT ruling 17 diffs included.
- **T5.1 Suggest-mode client: fork, modes, routing, paint** `[A·codex]`
  - **Scope:**
    - the toolbar toggle and the role-locked "Suggesting" chip;
    - suggester in the share role menu;
    - the fork shim: F = B plus the author's valid open records, with clientID set to the active lease. It forwards every transaction whose origin is not `shim-body-apply` or `shim-record-apply`, so REGISTER_INIT, REGISTER_LOCAL_ORIGIN and the UndoManager are included;
    - the baseline taken after first sync;
    - the composite C and Review mode;
    - Edit-mode wedge, gutter, strike, attribute-dot and hover-preview paint;
    - explicit deletes over body items (Backspace, Delete, word or line delete, Cut, typing over a selection) recorded as id-precise delete parts, with the caret moving past struck text;
    - grouping (30 s idle or one paragraph away), `suggest-merge`, and offline continuation of the active record;
    - dropping UndoManager items when a record closes;
    - mode switches waiting for `data-sync-unacked=0`, with caret restore;
    - the refusal copy-back: close input in the same tick, export the unacked blocks, rebuild F, show "Copy what wasn't saved" until dismissed;
    - title and Properties read-only;
    - background writers off.
  - **Tests first:**
    - journey **j16-suggest**:
      - a solo owner with nothing selected toggles Suggest in the docked toolbar;
      - a principal shared as suggester through the dialog opens locked to the chip;
      - on a cold load, a suggester's first delete leaves the text in the server export and paints a strike;
    - zero ops emitted when F binds, before the first input;
    - every census operation through the real UI with zero refusals: colliding prefixes, Enter before a link, line break or inline formula, Enter in an indented paragraph or quote, lists, tables, checkbox, new code, HTML, formula, chart and sketch blocks, an edit of an original register, undo of a split, join;
    - a record that fails the bind check is marked broken and excluded from C, and Review falls back to B if binding C throws;
    - a record-closed race offers back every unacked block, and typing after the remount lands.
  - **Done:** green.
- **T5.2 Server: role floor, record ingest, leases, loud refusal** `[B·codex]`
  - **Scope:**
    - A§5.1 step 2 floor raised to editor, so a doc-changing frame from role suggester gets write-refused('role') and 4403 before apply;
    - editor and owner body frames naming a leased client id refused `protected-type`;
    - the `suggest_leases` table, and the `suggest-lease`, `suggest-ops`, `suggest-delete`, `suggest-merge` and `suggest-withdraw` handlers;
    - continuation records for frames aimed at an accepted record, and `record-closed` for rejected or withdrawn ones;
    - caps: ops ≤ 256 KB per record, at most 20 open records per principal, all open ops ≤ 25% of STATE_CAP, the projected stateBytes cap, and 300 writes per 5 s;
    - a registry-name check on `__type` values at ingest;
    - a refusal rate limit of 3 per principal per minute, then a 60 s 4429 cooldown;
    - acks driving `data-sync-unacked`.
  - **Security brief** (commit reviews of the old T5.0 spike `vet.ts`, 2026-10-04, carried in full). Seven reviews found authorization bypasses: forged tombstones and GC, same-value writes, embed maps restyling neighbours, recursive container deletes, and decorator `__regId` and register ownership. They also found a per-frame vetting DoS and a parser differential. Required:
    - **Authorization never decodes a frame.** Suggester body writes are refused by role, and `parseUpdateMeta` is bookkeeping only.
    - **Every forged-frame case from the T5.0 review tables is refused.** Each is sent as a suggester body frame, refused by role, and the body bytes are asserted unchanged.
    - **Per-frame DO cost is O(frame bytes) for body frames, `suggest-ops` and `suggest-delete`.** Test a maximum-size forged frame, and show the cost is independent of doc size (small doc against 1.69 MB).
    - **Nothing a suggester sends can be applied to the body except through T5.3's accept.**
  - **Tests first:**
    - colliding-prefix typing ("the " before "the …", a duplicated word, a sentence pasted before itself) and an insert outside any existing suggestion are never refused;
    - a forged raw frame from a suggester deleting original text never lands, and the refusal is visible in the band;
    - leases are exclusive and never in the body state vector;
    - a delete-only frame after accept opens a continuation record.
  - **Done:** green.
- **T5.3 Review, accept, reject, withdraw, notify** `[B·codex]`
  - **Scope:**
    - glyphdown's SuggestionsPanel rebuilt in the moss DS inside moss chrome, with accept and reject reachable from painted suggestions (moss's ActionsPanel stays the inert agent panel);
    - `packages/core/suggest/apply.ts`, shared by client and server: projectionDiff serializes each top-level block recursively, keyed by Y item id, plus full register contents; the hunk list and previewHash;
    - accept through `serverWrite` in one synchronous DO turn, with these gates (any failure answers 409 and applies nothing):
      - G0: the record is open and its ops are the ones previewed;
      - G1: no pending structs or deletes;
      - G2: advanced clients ⊆ the record's leases;
      - G3: changed types only under `root` and `registers`;
      - G4: register aliasing (a fresh decorator names only a key this record created; an existing registers entry is never replaced or re-pointed, and deleted only with every decorator naming it);
      - G5: outdated (removed body items live, no foreign item inside a removed run, every inserted struct integrates live);
      - G6: the previewHash matches;
      - G7: the headless bind succeeds;
      - G8: the state cap holds;
    - reject and withdraw as status-only transactions that never write the body (PRODUCT ruling 16);
    - outdated and broken badges with "Copy suggested text", and auto-reject when the preview is empty;
    - accept rate-limited per principal;
    - the default export is the clean body, with `?view=working` for the composite;
    - notifications for live suggestions.
  - **Tests first:**
    - an editor's accept and reject converge on both sides;
    - withdraw removes the inserted text from every view while the body stays byte-identical;
    - the peer's review UI lists the suggestion;
    - accept-equivalence: for every census operation, accept equals an editor's direct edit (markdown and registers);
    - each gate refused with nothing applied;
    - outdated cases: an editor types inside a bolded run, deletes a delete target, or deletes the parent paragraph and it is GC'd; and two conflicting records;
    - a text-only, an attribute-only and a register-only record each produce a hunk;
    - a stale hash gets 409.
  - **Done:** green, with a triptych against the glyphdown panel.
- **T5.4 Adversarial suite and composite robustness** `[B·codex]`
  - **Scope:**
    - a randomized struct-level fuzz over records built from real peer frames: retarget origins, swap content kinds, add deletes, re-point `__regId`, write non-body roots, use non-leased clients, open gaps, GC parents. It asserts that accept either refuses with nothing applied, or lands exactly the hashed preview, touching only `root` and `registers` and only leased clients;
    - the same fuzz applied to clients' F and C builds, asserting no throw escapes and broken records are excluded;
    - a generative honest-edit fuzz through real moss editors in suggest mode (random typing, Enter, soft breaks, formatting, undo, lists, tables, decorators next to links, line breaks and inline formulas), asserting zero ingest refusals, zero broken records and accept-equivalence;
    - cost regression tests for ingest and the body-frame lease check at the frame cap.
  - **Done:** green in CI.

**M5 exit criteria** (replacement text): colliding-prefix typing is never refused; a suggester's first delete never removes text on the server; a suggester's body frame never lands and the client shows the refusal; reject and withdraw never change the body; accept lands exactly the previewed diff or nothing; the demo note shows live pending suggestions (Review mode inline, Edit mode markers).

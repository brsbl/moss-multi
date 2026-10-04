# Suggestions: design review (T5.0)

This resolves ARCHITECTURE §13 "Suggestions" and spike SP11 for M5. It says what a suggestion is in the shared doc, which edits a suggester's client may send, how the DocDO vets them, how suggestions are painted, reviewed, accepted and rejected, and what T5.1–T5.3 build. Where it differs from the A§13 sketch, this document wins, and A§13 now points here.

Inputs: PRODUCT "Collaboration on meaning" (mean-2) and the `suggester` role; A§5.1, §8, §10, §12, §13, §19; LEARNINGS §4.3 and §4.12; glyphdown@faf98d0 `packages/core/src/{suggestions,suggest-session}.ts`, `packages/sync/src/{enforce,do}.ts`, `packages/editor/src/suggest-mode.ts` and `apps/web/src/components/editor/SuggestionsPanel.tsx`; the current binding, registers, converter and DocDO on m3; the comment design's anchors and frame classifier on `t/T4.0` (`packages/core/src/tree-anchor.ts`, `packages/sync/src/doc/touched-types.ts`).

Evidence: the SP11 census, `packages/sync/src/suggest/vet.{ts,test.ts}`. It drives real moss editors (headless, bound V1 to a Y.Doc) through the operations below and vets each resulting frame. Red run [37194248778](https://github.com/brsbl/moss-multi/actions/runs/37194248778) (the stub accepted everything), green run [37195017540](https://github.com/brsbl/moss-multi/actions/runs/37195017540).

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **Additive edits land; everything else is a proposal.** Typing, pasting, Enter, new list items, table rows and new decorators enter the tree and are registered as the author's parts. Deleting, formatting, retyping or re-indenting original content never touches the tree: the client records a proposal part, painted as an overlay, applied only on accept. | PRODUCT: a violating edit never lands. L§4.12: a suggester's first delete was a real deletion. Proposals keep original content byte-identical until an editor decides. |
| D2 | **Ownership is Yjs identity, not text offsets.** An insert part is an id set (`{client, clock, len}` spans) of the items the author created. There is no baseline. | The false-4403 family came from re-diffing flat text (L§4.12); the stale baseline came from snapshotting before sync. Item ids have neither problem: colliding-prefix typing is just new items. |
| D3 | **The DocDO vets each suggest-mode frame by decoding it against the live doc, without applying it.** A mirror is built only for frames that move original text (a split), to prove the moved text is unchanged. | A mirror per keystroke costs a full-state copy (megabytes near the cap). The census shows ordinary typing never needs one. |
| D4 | **Splits are allowed and their moved text stays original.** Enter mid-paragraph, a soft break or a differently formatted run mid-word make @lexical/yjs delete the tail and insert a copy. The vetter proves the copy and records it as `moved`: never the author's to delete, kept on reject. | Refusing Enter mid-paragraph would refuse ordinary writing. Treating the copy as the author's insert would let reject delete original text. |
| D5 | **Only the DocDO writes `Y.Map('suggestions')`.** Inserts are registered from the vetted frame in the same transaction that applies it; proposals arrive as socket messages the DO validates. | A§13 (only the DO writes the meaning maps). One transaction means a peer never sees unpainted suggested text. |
| D6 | **Structural ops are parts, not refusals** (SP11): checkbox toggle and block type are `attr` parts, list indent is an `indent` part, a table row or column insert is an insert, a row or column delete is a `delete` part, Backspace at a block start is a `join` part. | A§13 allows refusal only after an owner ruling. None is needed. |
| D7 | **A refusal is loud and loses nothing typed after it.** The client checks its own outgoing transactions with the same rules, closes the editor to input at once and rebinds from the server; the server's `write-refused` plus 4409 is the backstop. | PRODUCT: never silently dropped. DEF-1 (L§4.12): the client kept rejected text. |
| D8 | **Review lives in moss's chrome:** a Suggestions button in the top bar beside moss's `CommentsMenuButton`, opening glyphdown's suggestion cards in a moss-DS popover, plus a popover from the painted suggestion with Accept and Reject. | Moss lists a note's annotations from a top-bar menu (`CanvasAreaContent.tsx:265`); its right panel is the inert agent panel. Glyphdown's interaction is a list of cards with Accept and Reject. |
| D9 | **Export is the working text.** Pending inserts are exported as written and pending deletes are kept; no markers ever. `?view=clean` drops pending inserts and undoes pending splits. | Glyphdown as-is (its content route's `view=clean`, `do.ts:493`); the CLI's three-way merge needs the working text as its base. |

## 2. Data

`Y.Map('suggestions')` maps a suggestion id to a plain JSON record. The DocDO is its only writer, under origin `server-suggestions`; clients never write it (the SP7 classifier refuses any client frame touching it, for every role), and the map is outside every client undo scope (A§10.8).

```ts
interface SuggestionRecord {
  id: string;                 // minted by the author's client (a group), checked by the DO
  author: string;             // server principal id, never client-supplied
  authorName: string;         // display copy from the connection attachment
  source: 'live' | 'cli';
  note?: string;              // `--suggest -m`
  createdAt: number;          // seconds
  updatedAt: number;
  status: 'open' | 'accepted' | 'rejected' | 'withdrawn';
  resolvedBy?: string;        // principal id, or 'system' for auto-reject
  resolvedAt?: number;
  outdated?: number;          // parts skipped on accept by the drift guard
  parts: Part[];
  moved: IdSpan[];            // original text this suggestion's splits moved (D4)
}
type IdSpan = { client: number; clock: number; len: number };
type Part =
  | { id: string; kind: 'insert'; ids: IdSpan[] }
  | { id: string; kind: 'delete'; anchor: TreeAnchor }
  | { id: string; kind: 'format'; anchor: TreeAnchor; set: number; clear: number }
  | { id: string; kind: 'attr'; block: IdRef; key: AttrKey; from: Json; to: Json }
  | { id: string; kind: 'indent'; block: IdRef; by: 1 | -1 }
  | { id: string; kind: 'join'; block: IdRef }
  | { id: string; kind: 'replace'; regId: string; from: string; to: string };
type IdRef = { client: number; clock: number };   // the block's (or decorator's) item: its stable identity in V1
```

- `TreeAnchor` is the comment anchor from T4.0 (two RelativePositions, assoc 0 and −1, plus a W3C quote over the tree projection). Proposals reuse it so re-anchoring, the quote and the drift guard are one implementation.
- `AttrKey` is an allowlist: `__checked`, `__listType`, `blockType` (paragraph, heading level, quote), `__format` on elements (alignment), `__language` (code), `__level` (callout), and image and video alt text and width (T5.1 lists moss's property names). Anything else is not suggestible as an attribute (§5.4).
- Record size stays small: consecutive typing extends the last span (`register` in the spike), and a group ends on the glyphdown coalescing rule (30 s or more than one paragraph away; `suggest-session.ts`).

## 3. Operations

The census rows are the spike's assertions; "client" is what the suggest-mode client sends.

| Operation | Census verdict on the raw frame | Client sends | Part | Paint | Accept | Reject or withdraw |
|---|---|---|---|---|---|---|
| Type, paste inline, colliding prefix, sentence before itself | allowed | the frame | `insert` | insert highlight | close | remove the ids |
| Enter at a block end; new list item; new table row or column; new decorator | allowed | the frame | `insert` (the block's item covers its content) | insert highlight, ¶ marker for a new empty block | close | remove the ids |
| Enter mid-paragraph; soft break; a differently formatted run mid-word | allowed as a split (`moved` > 0) | the frame | `insert` for the new boundary and text; `moved` on the record | ¶ marker at the break; moved text unpainted | close | remove the new boundary and keep the moved text: an inserted block holding moved text merges into its previous sibling; an inserted text node of moved text stays and Lexical's normalization rejoins it |
| Delete original text (Backspace, Delete, word or line delete, Cut, typing or pasting over a selection) | refused `delete-original` | a `delete` proposal for the original segments; own segments are deleted for real | `delete` | strike highlight | remove the range if its text still matches (§6.3) | close |
| Backspace at the start of an original block | refused | a `join` proposal | `join` | struck ¶ at the end of the previous block | merge the block into its previous sibling | close |
| Bold, italic, code, link on original text | refused `delete-original` (the split re-inserts with new properties) | a `format` proposal | `format` | dotted underline in the author colour plus a format chip in the popover | apply the format bits to the range | close |
| Toggle an original checkbox; change block type, alignment, code language, callout level, alt text | refused `mutate-original` | an `attr` proposal | `attr` | a marker at the block start | set `key = to` if the value still equals `from` | close |
| Indent or outdent an original list item (Tab) | refused `delete-original` (it moves the item) | an `indent` proposal | `indent` | an indent arrow at the block start | indent or outdent the block | close |
| Delete a table row or column, or a whole block | refused | a `delete` proposal over the block range | `delete` | strike plus a tint on the row, column or block | remove | close |
| Edit an original code, HTML or formula payload, or a chart or sketch register | refused `mutate-original` | a `replace` proposal from the decorator's draft (§5.3) | `replace` | a "Suggested change" chip on the decorator | write the register by minimal diff if it still equals `from` | close |
| Edit, delete or format the author's own pending content | allowed | the frame | updates the same parts | — | — | — |
| Delete text a split of theirs moved | refused `delete-original` | a `delete` proposal | `delete` | strike | remove | close |
| Title, properties (frontmatter), comments map, suggestions map | refused `outside-body` | nothing: the title and Properties are read-only in suggest mode | — | — | — | — |

Move by drag (an original block dragged elsewhere) is a copy plus a delete: the client inserts a copy at the destination (an insert) and proposes deleting the source, in one record that the review card labels "Moved". Accept removes the source; reject removes the copy.

## 4. Server vetting (SP11)

**Where it runs.** In `DocDO.onMessage` step 4 (A§5.1), beside the cap check, for every write from a connection whose attachment says suggest mode: always for `suggester`, and for an editor or owner who switched Suggest on (§5.1). Inert frames are never vetted.

**Rules** (`vetSuggestFrame(doc, update, own, moved)`, decode only):

1. Decode the frame with `Y.decodeUpdate`. Each new item's place comes from its parent (a root name or a parent item) or, when the encoding omits it, from its origin's place; this is the same resolution as T4.0's `touchedTypes`, and T5.2 merges the two into one module (one decode, one classifier).
2. A **sequence insert** under `root` is allowed. It is registered as an insert unless its parent is already the author's (new in this frame or inside an own part).
3. An **attribute or map write** is allowed only when its parent is the author's. A new key in `registers` is allowed (a new decorator's payload); overwriting a live key is `mutate-original`. A write under any other root (`title`, `frontmatter`, `comments`, `suggestions`) is `outside-body`.
4. A **delete** is allowed for items new in the frame and for items inside the author's own content (checked per deleted clock range, since the store merges an editor's text with the same client's later suggestions), except items in `moved`.
5. **Splits.** A delete of original characters, or a new embed placed before original characters, marks its block. For marked blocks only, a mirror (`encodeStateAsUpdate` + the frame) is built and every original element of the block must survive in order, by identity, or, if deleted, as a fresh character with the same text and the same text properties, in the block or in the fresh blocks right after it. Matched copies are returned as `moved`. Any original element missing, reordered or re-formatted refuses the frame.
6. An item the doc cannot place (a forged or out-of-order dependency) is `unresolvable` and refused, never parked.

**On a pass** the DO wraps the apply and the record write in one transaction: `super.onMessage` under origin `connection`, then the record upsert extending the connection's current group (D5).

**On a refusal** the DO sends `__YPS:{t:'write-refused', reason:'suggest'}` and closes 4409 (the protocol value is the shipped `'suggest'`; A§13's `suggest-policy` is the same thing). The frame is never applied.

**Cost.** Decoding is linear in the frame. The mirror is built only for split frames (an Enter mid-paragraph, a format run mid-word), never for typing. At the 2 MB cap a mirror costs one state encode and apply, the price `serverWrite` already pays per accept.

**What the census proved** (19 assertions, green): additive edits and colliding-prefix typing pass and register inserts; the three split shapes pass with a non-empty `moved`; deletes, formatting, checkbox, indent and register edits of original content are refused; own pending text can be retyped, deleted and formatted; moved text cannot be deleted; a forged text map that re-formats original text without moving it is refused; title and suggestions-map writes are refused; and opening a doc writes nothing, so a suggester is never refused for loading it.

## 5. Client

### 5.1 Entering suggest mode

- **Toggle.** "Suggest" sits in moss's floating toolbar beside the formatting controls, reachable by a solo owner with nothing selected (docked at rest); a role-locked `suggester` sees a non-interactive "Suggesting" chip instead (L§1.3). The pane publishes `data-edit-mode=edit|suggest`.
- **Wire.** The mode rides the doc socket: `{t:'suggest-mode', on, group}` as the first message after open and on every toggle; the DO stores `suggest` and `group` in the hibernation-safe attachment. A suggester's attachment is always `suggest: true` whatever it sends. A toggle waits for `data-sync-unacked=0`, so buffered edits are always vetted under the mode they were typed in.
- **Inert while in suggest mode.** Background writers (A§10.10) do not run; the title field and Properties are closed (§3, last row); decorator payload views edit drafts (§5.3).

### 5.2 The suggest seam

One new seam, (e), in the vendored `useYjsCollaboration.tsx`, next to (a)–(d), plus host modules in `apps/web/src/host/suggest/`:

1. **Command routing.** High-priority listeners for the delete family (`KEY_BACKSPACE`, `KEY_DELETE`, `DELETE_CHARACTER`, `DELETE_WORD`, `DELETE_LINE`, `REMOVE_TEXT`, `CUT`, and text or paste over a range), `FORMAT_TEXT`, `FORMAT_ELEMENT`, `INDENT_CONTENT` and `OUTDENT_CONTENT`, and moss's block-type and table row and column actions (T5.1 lists the call sites). Over original content they emit proposals and return `true`; over own content they fall through to Lexical. A collapsed delete moves the caret past the struck text, as glyphdown's `suggest-mode.ts` does.
2. **Attribute conversion.** Before the update listener syncs a suggest-mode update to Yjs, it checks the dirty nodes: an update that only changes allowlisted properties of original nodes (a checkbox click, a language picker) becomes `attr` proposals, the previous editor state is restored under `SKIP_COLLAB_TAG`, and nothing is synced. This covers decorator controls that write node properties directly instead of dispatching a command.
3. **Self-check.** An `afterTransaction` hook runs the vet rules on the binding's own transactions (items deleted in the transaction still hold their content there). A violating transaction is not sent: the hardened provider drops that update, the pane closes to input at once (A§10.3 closed fields), the band says "That change can't be suggested; switch to Edit to make it" (an editor) or "…ask an editor" (a suggester), and the session rebinds from the server once earlier edits are acked. Nothing typed after the refused change is accepted before the rebind, so nothing is silently lost. The server's 4409 is the backstop for anything the client misses.
4. **Ownership on the client.** Own content is the author's open records' `ids` plus the clocks this Y.Doc created while in suggest mode and not yet confirmed; `moved` is read from the records.

### 5.3 Proposals and decorator drafts

- A proposal is `{t:'suggest', group, part}` on the doc socket. The part carries a client-minted id, so a resend after a reconnect is idempotent. Proposals queue while offline and are flushed after the provider reports `sync`, so they always follow the frames they reference on the same socket.
- The DO validates a proposal (role, group ownership, the anchor resolves inside `root`, the attribute key is allowlisted, `from` equals the current value), computes the quote itself, and writes the record. A refused proposal gets `{t:'suggest-refused', id, reason}` and a band notice; the client drops its pending paint. Nothing was applied locally, so there is no rebind.
- Pending proposals count toward `data-sync-unacked` until their part appears in the map.
- **Decorator drafts.** In suggest mode the register wrapper (A§10.10) hands an original decorator's view a local draft (a detached `Y.Text` or `Y.Map` copy) instead of the shared register. When the view commits (blur or its own Done), the wrapper sends one `replace` proposal. Own new decorators edit their real register.

### 5.4 Undo

Cmd+Z in suggest mode undoes the newer of the last own Yjs edit (the binding's UndoManager, seam (a)) and the last own proposal (withdrawn with `{t:'suggest-withdraw-part', id}`). Undoing a split is allowed: it re-inserts the tail as fresh copies in the original block, which the vetter proves like any split.

## 6. DocDO

### 6.1 Modules

- `packages/sync/src/doc/suggest.ts`: the vetter (merged with T4.0's classifier), record writes, group extension and proposal validation. Lane-owned for M5 (A§5.1 split).
- `onMessage` step 4 vets suggest-mode writes; the placeholder that refuses every suggester write today (`#refused`) is replaced. String frames route `suggest-mode`, `suggest` and `suggest-withdraw-part`.

### 6.2 Review RPC and REST

- `POST /api/docs/:id/suggestions/:sid/{accept|reject|withdraw}` reaches `DocDO.reviewSuggestion(principal, sid, action)`. Accept and reject need editor or above (A§8); withdraw needs the record's author at suggester or above, which also lets an editor withdraw their own (fixing L§4.12). A record that is not open answers 200 with its current status (idempotent under concurrent review). Every owner GET of a trashed doc shares the trashed read path (L§4.10).
- The RPC runs one `serverWrite` (A§5.1): it resolves each part through T4.0's anchor mapper to Lexical points on the mirror and applies the outcome with Lexical's own operations (`removeText`, `formatText`, `setChecked`, `setIndent`, a block merge, a register diff), so the result equals what an editor's direct edit would produce. The record's status change is written in the same transaction. A whole record is accepted or rejected at once, as in glyphdown.

### 6.3 Drift, orphans, notifications

- **Drift guard.** A `delete` or `format` part applies only when its range's text still matches the quote at similarity ≥ 0.8 (glyphdown `FUZZY_ACCEPT_THRESHOLD`); `attr`, `indent`, `join` and `replace` apply only when the current value or structure still matches `from`. Skipped parts are counted in `outdated`, shown as an "outdated" badge, and never applied silently.
- **Orphans.** `onSave` revalidates open records: a part whose items or anchor are all gone (an editor deleted the text) is dropped; a record left with no parts is auto-rejected with `resolvedBy: 'system'` (A§13).
- **Notifications.** When a record is created, the DO writes one `suggestion` notification to the doc's owner, unless the owner is the author (glyphdown's rule, extended to live suggestions per A§13). Recipients are re-checked on read (A§8).

## 7. Paint

Paint is derived and never mutates the tree (L§4.12), on the T4.0 paint layer (CSS Custom Highlights plus geometry, SP10):

- `insert` ids resolve to runs of visible items (a peer's characters typed inside someone's suggestion are not painted as theirs) and paint `::highlight(suggest-insert)`: glyphdown's green background and ink, as moss-DS tokens.
- `delete` and `format` anchors paint `::highlight(suggest-delete)` (strike, glyphdown's red) and `::highlight(suggest-format)` (dotted underline).
- Markers (¶ for a split or a new empty block, struck ¶ for a join, an indent arrow, an attribute dot, a decorator chip) are positioned from range geometry in the pointer-transparent overlay.
- Hover and click find the suggestion under the pointer through the paint layer's hit test and open the suggestion popover (§8). The active suggestion gets an outline highlight, mirrored in the list.
- Moved text is never painted: it is original.

## 8. Review UI

- **Top-bar Suggestions button** (moss DS, beside `CommentsMenuButton`, inside `[data-top-bar]`): a count of open suggestions; it opens a popover list of glyphdown's `SuggestionCard`s rebuilt in the moss DS: author ("you" for own), time, up to three `+` and `−` excerpts, an "outdated" badge, and Accept and Reject (editor and above) or Withdraw (the author). Open first, newest first; then "Reviewed", at most 20, dimmed. The empty state uses glyphdown's copy. Clicking a card scrolls to and activates the suggestion.
- **Suggestion popover** from the painted suggestion: the same card, anchored to the range, built like moss's `CommentPopover`.
- Accept or reject converge on every client through the doc; the list updates from the map. A failed review shows an error in the popover, never a silent no-op.
- DOM contract additions (`dom-contract.ts`): `data-edit-mode` on the pane, `data-suggestions-button`, `data-suggestion-card[data-suggestion-id][data-suggestion-status]`, `data-suggestion-popover`. Painted state is read through the paint layer's test hook, as for comments.

## 9. Converter, export and the CLI

- **Export** (A§12) is the working text (D9). `exportMarkdown({view: 'clean'})` exports a copy of the tree with every open insert removed and every open split rejoined; it backs `?view=clean` and is offered nowhere else in M5. Pending proposals never appear in either view, and nothing marks a suggestion in any `.md`.
- **CLI `--suggest`** (T7.3): the T6.1 reconcile runs on the mirror in suggest mode. Its insertions land as an insert part; every deletion, attribute change or move it would make is emitted as the matching proposal part instead; the result is vetted by the same rules before it applies. Pushed suggestions notify like live ones.
- **History** (M6): records live in the doc, so versions carry them. A restore runs through `serverWrite` and leaves records whose parts no longer resolve to the orphan rule.

## 10. Security

- Authorship always comes from the connection attachment or the REST principal.
- Client frames touching `suggestions` (or `comments`) are refused for every role (SP7). A suggester's frame is vetted by identity, so a forged frame that deletes or re-formats original text never lands (census rows and the forged-map assertion).
- Proposals and reviews are checked against the live role. Withdraw is author-only (L§4.17 SEC-1). Notifications are re-checked on read.
- The vetter refuses unresolvable dependencies instead of letting Yjs park them, so a forged frame cannot wait for a predictable future server item.

## 11. Tests for M5

Each task keeps BUILDPLAN's tests and adds the legs this design needs.

- **T5.1** (j16): the BUILDPLAN legs, plus Enter mid-paragraph in suggest mode lands as a split whose moved text survives the author's reject; a checkbox click becomes an `attr` part and the box stays unchecked on the server; an unsupported change is refused locally, announced in the band, and the next typed character lands after the rebind. A unit test enumerates moss's toolbar and slash actions in suggest mode and asserts each one lands, proposes or refuses loudly.
- **T5.2**: the census moves into the DocDO harness over real sockets (frames through `onMessage`), with BUILDPLAN's colliding-prefix and forged-frame legs; plus a reconnect step 2 carrying buffered suggest-mode typing, a split and a delete proposal in order.
- **T5.3**: the BUILDPLAN legs, plus accept and reject for every part kind (§3) converging on both clients, the drift guard skipping an edited range, auto-reject of an orphan, and withdraw by an editor-author.

## 12. Changes to other documents

- ARCHITECTURE §13 "Suggestions" now summarizes this design and points here; SP11 in §22 records the result.
- BUILDPLAN is unchanged except in substance the coordinator may want to reflect: T5.1 owns §5 (seam (e), the proposal channel and decorator drafts), T5.2 owns §4 and §6.1, T5.3 owns §6.2–§8.
- The spike files stay as the seed of T5.2's module; T5.2 merges the decode with T4.0's `touchedTypes`.

## 13. Risks

- **Coverage of moss's editing surface.** Any moss action that mutates original content and is neither routed nor attribute-only is refused loudly (D7) until it is routed. The T5.1 enumeration test keeps the list honest.
- **@lexical/yjs internals.** The split proof depends on V1 storing a text node as a map embed followed by its characters, and on Lexical keeping the head of a split in the original node; both are pinned by the census at 0.48. A Lexical upgrade re-runs it.
- **Copy matching.** A split's copy is matched character by character with identity preferred, so it cannot steal an original that survived; the only ambiguity (identical adjacent fresh text) does not change the resulting text.
- **Paint in WebKit.** Strike and underline ride ::highlight text decoration; T4.0's SP10 probe covers both engines, and its overlay fallback applies if it fails.

## Review findings

Pending: the fresh architect and the Codex critic review this document; each finding is dispositioned here.

---

## Owner summary

**What a suggestion is.** When someone suggests, what they add (words, new paragraphs, list items, table rows, images) goes into the note right away, highlighted green, so everyone sees it as they type. What they would remove or change (deleting words, bolding, ticking a checkbox, indenting, deleting a table row) is never done to the note: it is drawn on top as a strike-through or a marker, and only happens if an editor accepts it. Rejecting takes the additions back out and leaves the original exactly as it was.

**Why it is safe this time.** The old attempts compared text before and after, which wrongly refused ordinary typing (typing "the " before "the cat") and once let a suggester's first delete really delete. This design tracks who created each character, using the identity the sync engine already gives every character. A test drove real moss editors through 14 kinds of edits and confirmed: ordinary typing, pasting, pressing Enter anywhere (even mid-paragraph) and new rows are accepted; every delete, format or checkbox change of someone else's text is caught; a forged edit is refused; and opening a note never trips anything.

**What you will see.** "Suggest" sits in moss's floating toolbar; someone shared as a suggester sees a fixed "Suggesting" chip. A Suggestions button next to moss's comments button lists every open suggestion with Accept and Reject; clicking a highlighted suggestion opens the same card in place. The note's owner gets a bell notification when someone suggests.

**If something cannot be suggested.** If someone tries a change the app does not know how to turn into a suggestion, it says so plainly in the notice band, nothing they typed afterwards is lost, and the server refuses it anyway as a backstop. The test suite lists every moss editing action so that this stays rare.

**Choices made for you** (each can be overturned):
1. The title and note properties cannot be suggested; they stay read-only in Suggest mode, as in glyphdown.
2. Editing the inside of an existing code block, chart, sketch or HTML block is suggested as one "replace this block" change, shown as a chip, rather than painted character by character.
3. Exports contain the suggested additions as written (the note as it currently reads), with no markers; a "clean" export without pending additions exists for tools.
4. A suggestion is accepted or rejected as a whole, not part by part, as in glyphdown.

No owner decision is needed to start M5.

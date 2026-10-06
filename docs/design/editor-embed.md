## Status: DRAFT, review findings still open

**Security review of 0aba043 (2026-10-05): three contract gaps, required before API 1 is final. T3.9 fixes the contract text and tests each one; the host must enforce each one too:**
1. **Arbitrary file read.** Every host read takes a path or ref that came from note content or the editor: `readCompanion`, `assets.url`, `copyFromNote`'s `sourceNoteId` and `sourceRef`. The host must:
   - resolve each one against its own note's folder;
   - realpath both sides and refuse anything outside that folder: symlinks, hard-linked escapes, `..`, absolute paths, NUL, and `~`;
   - for `copyFromNote`, require that the source note is itself an editable or viewable note the user opened in bb, never an arbitrary id. Refusals are typed results, never a read.
2. **Path traversal on writes.** Asset `name`, `desiredName` and every write target must pass Moss desktop's own filename sanitizer at the pin (no separators, no `..`, no leading dot, no reserved names, byte-length limits). The host re-validates them with `isMossFolderName` and `isMossAssetName` from `moss-editor-host.js` (T3.9a); it never trusts the editor's string. Writes stay inside the note folder, and renames inside its parent.
3. **Stored XSS through served assets.** SVG (and any type a browser can render as active content) must never be same-origin with the editor or plugin frame. The host serves assets with `X-Content-Type-Options: nosniff`, an exact `Content-Type`, and for SVG `Content-Security-Policy: sandbox; default-src 'none'`, with `Content-Disposition` where possible. The editor shows SVG only through `<img>`, never inline. A sniffed or mislabeled upload is refused.

The latest review (Codex) returned FAIL. These findings are open and must be resolved before the contract is settled:

- Meta-only changes and meta retries can revert commentColors changed in Moss (fixed in T3.9: a meta refresh hands changed colors to the editor, and each color the user has not changed takes the new one)
- Receipt guarantee has no mandatory delivery path for autosaves (dispositioned: every autosave's `saved` event carries its receipt, so a host that retains receipts must pass `onEvent`; making that mandatory in contract.ts is owner item (d) below)
- Receipts do not restore media that Moss trashes after replacing a bb save (dispositioned: a known API 1 limit; the editor never trashes assets, and media Moss trashes is outside the receipt, so restoring shows a missing image rather than losing text)
- Rollback and failure paths are underspecified and conflict with the plan feedback (fixed in T3.9: §5.3 steps 5-6 and the typed `failed` result define them; the fixture host rolls back only files still holding its own bytes and re-reads every file at step 6, both tested)
- Layout sidecar rule misstates desktop's conditional write and can delete a sidecar desktop keeps (fixed in T3.9: `planSave` follows desktop's conditional rule, golden-tested, and the §2 table states it)
- Retitle into an existing distinct <newName>.md diverges from desktop and leaves the host step ambiguous (dispositioned: the fixture host verified-replaces the distinct target, as desktop overwrites it, and deletes the old `.md` only if it still holds the base bytes; the contract wording is owner item (d))
- A stale draft restored in conflict was exported with the new disk version as its base (fixed in T3.9: it keeps its own base and companions until Reload or Overwrite, tested)
- A failed Reload read moved a restored stale draft from conflict to error, so the retry wrote it over the newer disk (fixed in T3.9: a read that fails in conflict reports an error and keeps the conflict, and a stale draft writes only after Overwrite, tested)
- An edit (a comment reply) that landed while unmount waited for its final write was dropped at teardown (fixed in T3.9: unmount freezes the editor, including moss's popovers portalled into the page body, which take no input while frozen, and flushes again until nothing is unsaved or returns `kept`, tested in the real editor)
- Undo after an in-place reload brought back the replaced text, and the next save wrote it over the Mac app's (fixed in T3.9: every in-place load clears the editor's history, as desktop's `applyDiskUpdate` does, tested)
- A reload that finished after unmount changed the torn-down session, and a restored receipt already on disk lost its comment colors (fixed in T3.9, tested)
- Media still uploading at unmount is outside the flush barrier, and a refused upload has no inline error (open, follow-up: both lose only the dropped file, never note text)
- Editability gate admits notes whose meta.json desktop rejects (fixed in `noteEditability`, T3.9a: a truthy `id` and `title` are required)
- Open for the owner (T3.9). API 1 is published (editor-v0.0.1), so each of these is a contract change, and contract.ts keeps the published text until the owner decides: (a) `MossNoteWrite` step 4 asks the host to respell a same-inode markdown entry to `<folderName>.md`, but desktop's `persistFile` renames a temp over the path, and on APFS that keeps the old spelling (checked locally), so a case-only retitle leaves `Plan.md` under `plan/` in desktop and `plan.md` in bb; (b) the security review's item 1 narrows `copyFromNote` to notes open in the host, where API 1 allows any note the host can resolve; (c) its items 1-3 as host obligations in contract.ts itself; (d) wording for the two dispositioned findings above (`onEvent` required for receipt retention; the distinct-target retitle step). The fixture host and the golden suite follow the published text and compare that one entry's letter case loosely.

# Embeddable editor: file-backed `mountMossEditor` (T3.9)

Status: contract settled for API 1. Implemented by `@moss-multi/editor` 0.1.0 (T3.9), against contract.ts unchanged.
Contract: `packages/editor/src/contract.ts`. Moss pin: brsbl/moss@762abb777 (vendor/moss/PORTED.json). Line references below are to that pin's `packages/desktop/src`.

## 1. Summary

- `mountMossEditor(element, {noteId, bridge, theme, services, htmlFrameUrl, onEvent, restoreDraft})` mounts moss's own editor at the pin, editable, inside a bb plugin frame.
- The editor produces the final bytes of every note file a Moss desktop save touches: the `.md`, `comments.json`, `layout.json` and `meta.json`. It also ports desktop's main-process read and save steps, so moss-multi owns byte compatibility.
- The host moves those strings to disk unchanged. It owns path resolution, its per-note lock, version checks, the folder rename, lossless verified replacement of each file, exclusive asset creation, change detection, asset serving and retention of save receipts.
- `noteId` is meta.json's id (trimmed, case preserved, exactly as Moss matches it), not a path. A title edit renames the folder and the `.md`, both in Moss desktop and in this editor. The rename is an explicit, typed part of the write.
- API 1 edits only internal notes: adopted note folders under `~/Moss/Notes`, outside `Notes/External`. External `.md` files, unadopted folders and trashed notes (`~/Moss/Trash`) open in the viewer.
- **What is guaranteed about concurrent Moss writes, stated precisely:**
  - bb never destroys bytes Moss wrote. Every displaced byte sequence is verified, put back, or preserved and reported.
  - bb cannot stop Moss from later replacing a bb save, and cannot always detect it. Moss renames unconditionally after its own check, with no bound on the delay, and a Moss window holding unsaved edits rebases "user wins" on its next save by design. API 1 makes such a loss recoverable: every save returns a `receipt` (its exact bytes) that the host retains beyond unmount. A mounted editor also shows a best-effort notice when a replacement arrives within 5 s of its save. Neither is a detection guarantee (§5.5).
- Conflicts: the host refuses stale writes and never merges. A clean editor reloads in place. A dirty editor shows "Changed in Moss". Automatic merging arrives with M7.
- Unsaved edits never vanish silently. A failed final flush keeps the editor mounted, or hands the host a draft that also carries the meta.json inputs. A mount whose first read failed has a typed `notLoaded` outcome.
- Editing requires a host that can exchange two paths atomically. bb's Mac host qualifies; a host that cannot must not offer editing.

## 2. Who writes what

One Moss desktop save (`notes.update` → `noteStore.updateNote`, note-store.ts:10218-10787) does the steps below, in this order. The bb columns say how API 1 reproduces each one.

| # | Desktop step | Bytes or decision come from (bb) | Written by (bb) |
|---|---|---|---|
| 1 | Rename the note folder when the H1 title changed (`renameNoteFolder`, unique name in the parent) | Editor: `rename: {kind:'renameFolder', desiredName}`, where `desiredName` is `toFolderBaseName(title)` | Host: `allocateFolderName`, then an exclusive rename; returns the final `location` |
| 2 | Write markdown to `<folderName>.md` and unlink the previous `.md` if it is a different path (`ensureContentFile`, runs on every save) | Editor: the full note text, after desktop's main-side transforms (strip the legacy `<!--moss:comments` footer, migrate `{%c:…%}` markers to `%%m:…%%`). Sent when the bytes differ, when there is a rename, or when the file is not yet named `<folderName>.md` | Host: verified replace; verified delete of the old file only if it is a different inode |
| 3 | Update the backlink index | Not written by bb. Moss-internal state, refreshed when Moss's watcher sees the change | none |
| 4 | Write `comments.json` (`serializeCommentMetadata`: compact, top-level ids sorted, no trailing newline); delete it when the map is empty | Editor | Host: verified replace or delete |
| 5 | Write `layout.json` (`JSON.stringify(v, null, 2)`, no trailing newline) only when this editor changed the layout, or when content is written over a sidecar with widths (rebased against the markdown); otherwise leave it as it is | Editor | Host: verified replace or delete |
| 6 | Asset lifecycle: trash source assets that are no longer referenced, delete stale derived previews | Not done in API 1 (§7) | none |
| 7 | Write `meta.json` last (`JSON.stringify(v, null, 2)`, no trailing newline). `updatedAt` = now in unix seconds; `title` from the first H1; `folderPath` from the folder's real location (3953-3972); `contentType` reclassified; `frontmatterMeta` merged with pending provenance; `commentColors` replaced by the full snapshot; unknown keys preserved; `cacheHydrationState` stripped | Editor: derived from the latest meta.json text, `location.folderPath`, and its `MossMetaIntents` | Host: verified replace |

meta.json holds no folder name, so its bytes do not depend on the name the host allocates in step 1.

**meta.json inputs follow desktop's two rules.** The renderer sends both on every save (CanvasAreaContent.tsx:2645-2652, 2849-2853):
- `frontmatterMetaUpdates` is merged into the stored `frontmatterMeta` key by key (note-store.ts:10307-10314). The editor keeps only pending updates.
- `commentColors` is a full snapshot built from the current comments. Main filters it to non-negative integers and assigns it without spreading the old map (10356-10363). So deleting the last colored comment writes `commentColors: {}`. The editor sends the full snapshot every time, including in drafts and meta-conflict retries.

Read side, also ported by the editor:
- **Markdown resolution** (`resolveContentPathForRead`, 703-743) asks the filesystem. First it probes the candidates `<folderName>.md`, `<id>.md`, `note.md` in order with `stat`. On a case-insensitive volume, `Plan.md` exists when the entry is `plan.md`, and desktop returns the candidate's spelling. Only when no candidate exists does it list the folder and take the only `.md`/`.markdown` file, or else the newest by mtime (ties by name). The host helpers split this accordingly: `markdownCandidates()` gives the order, the host probes, and `pickMarkdownFallback(entries)` handles the listing step. A string match against a listing would choose the wrong file: with `plan.md` and a newer `Other.md` in folder `Plan`, desktop reads `plan.md`.
- **Editor-read migrations.** Desktop migrates internal markdown before the editor sees it (`applyEditorReadMigrations`, 3144-3157, called at 3453). The legacy mockup migration inlines `assets/<name>-mockup.html` into the fence (common/legacy-mockup-migration.ts:207-229). The bridge's `readCompanion(noteId, relativePath)` supplies such files with desktop's `readNoteRelativeCompanionFile` rules (3047-3069): realpath-confined to the note folder, `absent` when outside or missing. Each result carries a version that the editor sends back with every write (§5).
- **Comment metadata fallback** (`readPersistedCommentMetadata`, 2776-2796): use `comments.json` if it parses into a map. If it is absent or not valid JSON, use the legacy `<!--moss:comments` footer if the markdown has one. Otherwise there are no comments. The next save strips the footer and writes or deletes `comments.json`.
- **One divergence on read:** desktop also falls back to the footer when `comments.json` exists but cannot be read (for example EACCES; 2689-2703). Through the bridge, such an I/O error rejects `read` and the mount fails with `readFailed`. This fails safe, with no data written.

Rules:
- Every non-empty save includes `meta`, because desktop rewrites meta.json on every `updateNote`. A save with no differences, no due rename and no due markdown normalization sends nothing (desktop's idempotent skip).
- The host never parses, pretty-prints, re-encodes, adds or strips a BOM, normalizes newlines, or appends a final newline. Strings are UTF-8 in both directions, decoded as Node does (a BOM is kept as U+FEFF, invalid bytes become U+FFFD).
- CI holds the bytes to desktop's. T3.9's golden tests run fixture notes through desktop's `note-store` at the pin and through the editor plus an in-memory host, and compare all four files, the folder name and the markdown file name byte for byte. Fixtures include a legacy footer, a corrupt sidecar, a legacy mockup, a legacy `note.md` with a comment-only edit, a moved folder, a title rename into a taken name, a case-only retitle, a case-variant `.md` beside a newer `.md`, deleting the last colored comment, and a 252-byte folder name. The in-memory host has a case-insensitive mode.

## 3. File layout and the v0 editable scope

Moss workspace: `~/Moss/` holds `Notes/` (live notes) and `Trash/` (trashed notes, a sibling of `Notes`, note-store.ts:2059-2062; `deleteNote` moves notes there, 10942-10949).

Internal note (editable): `~/Moss/Notes/<path>/<Folder>/`
- `<Folder>.md`. On read, the host resolves the markdown as in §2: probe `markdownCandidates()` in order, then `pickMarkdownFallback()`.
- `meta.json`, `comments.json`, `layout.json`, and `assets/<name>`.

External `.md` (read-only in API 1):
- `layout.json` and `meta.json` live in the mirror folder `~/Moss/Notes/External/<title>/`.
- `comments.json` sits next to the `.md` only when the file is bundle-shaped (`<X>/<X>.md`); otherwise it is in the mirror folder.
- Assets are localized copies in the mirror folder's `assets/`. On save, desktop rewrites `assets/…` refs back to the source refs (`delocalizeExternalImageRefs`).
- So "the note folder" means three different places, and pasted images would get refs that do not resolve next to the source file. A later release may add external editing behind a `'scope.external'` feature, once the editor ports delocalization and the split sidecar paths. Both sides must list that feature before the host offers it (§8).

`noteEditability` reasons, plus two the host adds:
- `external`: under `Notes/External`, or meta.json marks the note as external.
- `unadopted`: a folder without meta.json, or with an id that fails `NOTE_ID_PATTERN`. Desktop adopts on open, adding `created_date` to the frontmatter with a non-atomic write and creating meta.json. bb must not adopt; once Moss has opened the note, it becomes editable.
- `trashed`: under `~/Moss/Trash`, or meta.json `trashedAt` is set. A user folder named `Notes/Trash` is ordinary and editable.
- `outsideNotes`: a loose `.md` outside the workspace, the `Notes` root itself, or a folder container.
- `noMarkdown` and `unreadableMeta`.
- Host: `duplicateId` (two folders carry the same id) and `hostUnsupported` (the volume cannot do the atomic exchange, §5.4).

## 4. noteId

- `noteId` is meta.json `id`. Valid ids match Moss's `NOTE_ID_PATTERN` (note-store.ts:96-97): 8-4-4-4-12 hex, any UUID version, either case.
- Identity is the trimmed id with case preserved, exactly as desktop: `assertValidNoteId` only trims (588-598), `getNoteDirectory` keys its index by that string and compares meta.json `id` with strict equality (4990-5032), and folder allocation does the same (4969-4975). `noteIdKey()` in `moss-editor-host.js` returns this key. Lowercasing would alias two notes desktop treats as distinct. If two folders carry the same key, the host returns `notEditable` with `duplicateId`.
- An absolute `.md` path is not stable. A title edit, in Moss desktop or in this editor, renames both the folder and the `.md`.
- The host keeps an `id → folder` index built from `~/Moss/Notes/**/meta.json`. On a miss it rescans, because Moss may have renamed or moved the folder.
- The host resolves the id on every `read`, `write`, asset call and poll. bb may still open a note from a path: read that folder's meta.json to get the id, then mount with the id.
- Wiki-link targets (`MossEditorTarget.noteId`, `services.notes()[].id`) use the same ids, which is what Moss stores in `[[Title|id]]`.

## 5. Versions, writes and conflicts

### 5.1 What each version covers

Recommendation: one whole-note content version, one meta version, and per-companion versions. Not per-file content versions, because comment markers in the `.md` and entries in `comments.json` only make sense together, and desktop guards the three content layers together under one lock (`expectedDiskContent`, `expectedCommentMetadata`, `expectedLayoutMetadata`).

| Token | Covers exactly | Does not cover |
|---|---|---|
| `version` | The bytes of the resolved markdown file, of `comments.json`, and of `layout.json`, each with a present/absent tag | meta.json, file names, mtimes, assets, companion files |
| `metaVersion` | meta.json's bytes, and the note's `folderPath` as UTF-8 | everything else |
| companion version (one per file) | The bytes of one companion file the read migrations consumed (for example `assets/<name>-mockup.html`), with a present/absent tag | — |

- Recommended formula (`versionToken` in `moss-editor-host.js`, asynchronous because it uses `crypto.subtle`): `sha256:` + hex of `sha256(for each part: role ‖ 0x00 ‖ (absent ? "-" : decimal byteLength ‖ 0x00 ‖ bytes) ‖ 0x00)`. Any deterministic opaque string is allowed.
- The presence tag matters: desktop deletes empty sidecars, so absent and empty must differ.
- The markdown's name is not in `version`; a rename by Moss with identical bytes is not a content conflict.
- `folderPath` is in `metaVersion` because desktop derives meta.json `folderPath` from the folder's real location; a Finder move needs new meta.json bytes.
- Companions are checked at write time, not watched, as in desktop: desktop's watcher covers only the four note files, but its CAS compares the migrated content (`updateNote` reads with `readInternalMarkdownContent`, 10528, which runs the migrations, 3451-3461), so a changed companion makes desktop's save conflict. The `companion` reason reproduces that.

### 5.2 What each write outcome means to the editor

| Result | Meaning | Editor action | User-visible |
|---|---|---|---|
| `conflict` `content` | md, comments or layout changed since the base | `conflict` banner, unless the disk is the editor's own state (each file equals its base or the editor's last-sent bytes), in which case it adopts silently | yes |
| `conflict` `companion` | A companion file the migrated markdown came from changed | `conflict` banner | yes |
| `conflict` `meta` | Only meta.json or `folderPath` changed (Moss stamped `lastOpenedAt`, pinned, collapsed a heading, or the folder moved) | Re-read, re-derive meta.json from the new text plus intents and location, retry at once, up to 3 times. A content change found on re-read becomes `content`. If retries run out: `error` event, retry after 5 s | no (an `error` status only if retries run out) |
| `conflict` `raced` | Another writer changed a file during the write | `conflict` banner; `preserved` paths shown if any | yes |
| `failed` | An I/O error; the host rolled back what it could | `error` status, `preserved` paths shown; re-read before the retry, adopt own state, retry after 5 s or on the next edit or flush | yes |
| rejection | The bridge could not even report the state | `error` status; disk state treated as unknown; re-read before retrying | yes |

Desktop never conflicts on meta (it re-reads and merges metadata under its lock), so `meta` stays invisible.

### 5.3 Host write algorithm: lossless verified replacement

Specified in full on `MossNoteWrite`. In short:
1. Take the bb per-note lock; resolve the id (`notFound`, `duplicateId`, editability, `hostUnsupported`).
2. Read all files (two-step markdown resolution); check `version`, then companions, then `metaVersion`; refuse with nothing written on any mismatch. Keep the bytes read as the expected state E of each target, and the markdown file's `(dev, ino)`.
3. Folder rename, if requested: `allocateFolderName`, then an exclusive rename (a case-only change is a plain rename). Not rolled back later.
4. For markdown, comments, layout, meta in order, a verified replacement:
   - **put over an existing file:** write a temp, fsync, then **atomically exchange** temp and target. The temp path now holds the displaced bytes D. If D = E, keep it as the holding file. If not, exchange back so the other writer's bytes return to the target, and report `raced`.
   - **put where the file was absent:** exclusive create (`link(2)`, or a no-replace rename). EEXIST means another writer created it: `raced`.
   - **delete:** rename the target to a holding name, compare with E, and move it back exclusively on a mismatch.
   - **markdown identity:** the put goes to `<folderName>.md`. Before it, `lstat` that path. If it is the same `(dev, ino)` as the file read in step 2, the old file and the target are one file (a case-only retitle such as `Plan` → `plan`, or a case-variant entry, on a case-insensitive volume). Exchange onto it, then rename(2) the entry to the exact spelling `<folderName>.md` if it differs only in case, and delete nothing. Only a genuinely different old file gets a verified delete. Without this check, the delete would move aside the bytes just written, see they differ from E, restore them and report `raced`, so every case-only retitle would fail.
5. On `raced`, roll back the files already replaced in this write, in reverse order, by exchanging their holding files back, but only where the target still holds this write's bytes.
6. Re-read and recompute. A mismatch means someone replaced a file after the swap: `raced`. Otherwise remove the holding files and return `{kind:'saved', version, metaVersion, location}`.

On an I/O failure after step 2, the host attempts the step-5 rollback and returns `{kind:'failed', code, message, applied, preserved, location}`. Desktop also ends a failed save in a partial state (`persistFile` throws after renames across separate writes, 1843-1859); the difference is that bb reports exactly which files hold what.

**Invariant:** the host never deletes bytes it did not write unless they equal E. Every displaced byte sequence is back at its path or kept as a preserved holding file (`.<name>.<uuid>.displaced`, named by `sidecarFileName`), reported in `preserved` of a `conflict` or `failed` result, and never deleted by the host. Temp and holding names use `sidecarFileName`, which applies `persistFile`'s byte-aware truncation (note-store.ts:1819-1832, 653-660); the naive `.<name>.<uuid>.tmp` overflows 255 bytes for valid 252-byte folder names.

### 5.4 Required primitives, stated as semantics

A host needs, on the note's volume:
- **Atomic exchange of two paths in one directory**: after it, each path holds the other's previous file, with no moment where either path is missing or holds a third file. The displaced file stays readable at the other path so it can be compared.
- **Exclusive placement**: move or link a file to a path, failing with EEXIST if the path exists. Also for the folder rename.
- Fsync of a file and of a directory (EINVAL, ENOTSUP, EPERM and ENOSYS ignored, as `persistFile` does).
- `lstat` with `(dev, ino)`, for the markdown identity check.

How a host provides them is its own choice. On macOS: `renamex_np(RENAME_SWAP)` and `renamex_np(RENAME_EXCL)` on APFS and HFS+. On Linux: `renameat2(RENAME_EXCHANGE)` and `renameat2(RENAME_NOREPLACE)` on filesystems that support them. Exclusive placement of files is also available as `link(2)` plus `unlink`, and the delete path needs only `rename(2)` and `link(2)`, which Node provides (`fs.link`, `fs.rename`, `fs.lstat`). Only overwriting an existing file and the exclusive folder rename need a native helper from Node.

A host that cannot perform the atomic exchange on a note's volume (another platform, or a volume that returns ENOTSUP, such as some network or exFAT volumes) must not offer editing for it at API 1: it shows the viewer, and if the bridge is called anyway it returns `notEditable` with `hostUnsupported`. A plain `rename` over the target is not an acceptable fallback, because it can destroy a Moss save without anyone noticing. Making editing Mac-only in bb is consistent with this contract.

### 5.5 What bb cannot prevent, and how it is made recoverable

Moss's locks (`mutationQueues`, `casLocks`, `runWithNoteLock`, note-store.ts:2066-2067, 5595-5631, 10496-10504) are in-process. Moss checks its expected content (10617-10633) and then does further work before its unconditional rename in `persistFile` (1835-1845): the folder rename, `ensureContentFile`, the backlink index (10726) and the sidecar writes. Nothing bounds that gap. Separately, a Moss editor with unsaved edits rebases "user wins" onto whatever is on disk at its next save, so its body replaces bb's by design.

- **bb overwriting Moss** cannot happen silently. If Moss lands bytes between bb's check and bb's exchange, the exchange displaces them, the comparison catches it, and they are restored or preserved.
- **Moss overwriting bb** can happen at any later time, including after the bb editor has unmounted. What API 1 provides:
  1. **Receipts (the guarantee).** Every `saved` result and event, and every `saved` flush result, carries `receipt`: the exact bytes the save put on disk, as a `MossDraft` based on the version it replaced. The host retains at least the latest receipt per note for a host-chosen period that outlives the mount, and offers it (for example as "Restore last bb save") by mounting with `restoreDraft`. Restoring onto a disk that already equals the receipt opens clean; onto a later disk it opens in `conflict`, so the user chooses explicitly.
  2. **In-editor notice (best effort).** If a mounted, clean editor sees an external change within `recentSaveGuardMs` (5 s, the same value as Moss's own-write TTL, chosen as a typical window and not a bound) of its save, it emits `reloaded` with `overwrittenSave` and shows "Moss replaced your last save" with Restore. Replacements outside that window, or after unmount, are not flagged.
- So the honest statement is: bb never destroys Moss's bytes; Moss can replace bb's bytes without bb being able to detect it in general; bb's last save stays recoverable for as long as the host keeps its receipt. Editing the same note in both apps at once is unsupported in the same way as editing it in Moss and any other editor.
- Closing the window needs Moss to cooperate, for example by honouring an advisory lock or by exchanging instead of renaming. That is a Moss change outside API 1.

### 5.6 Error rule

- Expected outcomes are results: `conflict`, `notFound`, `notEditable`, and for assets `exists` and `refused`.
- `write` returns I/O failures as `{kind:'failed', code, message, applied, preserved, location}`, because the editor must learn which files moved and which Moss bytes were preserved. It rejects only when it cannot report state (crashed helper, broken transport); the editor then re-reads before retrying.
- `read`, `readCompanion` and the asset methods reject on I/O errors with `code` set to the POSIX code, mirroring desktop's thrown errors. They change no note file.
- The editor turns any of these into an `error` event (with `failure` set for `failed`), shows `preserved` paths, keeps the edits, and retries on the next edit, on `flush()`, or after 5 s, re-reading first and adopting its own state as in §5.2.

### 5.7 Editor behaviour

- External change while clean: re-read after a 200 ms debounce and reload in place, keeping selection and scroll. Event `reloaded`, cause `external`, with `overwrittenSave` as in §5.5.
- External change while dirty: event `conflict`, cause `external`, and the "Changed in Moss" banner with **Reload** (discard local edits), **Keep editing**, and **Overwrite** (save the local version on top of the current disk version, only on an explicit click; an addition to T3.9, §12).
- Refused (`content`, `companion`) or `raced` write: event `conflict`, cause `refused`; edits stay unsaved until the user chooses.
- Deliberate divergence from desktop: desktop's renderer silently rebases ("user wins"), three-way merges comments, retries 3 times, then forces `activeUserWins`. API 1 does not, because the host has no merge logic and T3.9 defers merging to M7. When M7 lands only editor behaviour changes; the host contract stays the same.

### 5.8 Change detection

- `bridge.watch(noteId, listener)` is a bridge method the editor subscribes to; it returns an unsubscriber, like moss's `notes.onDiskChange`.
- The host does not report its own writes; it compares against the tokens it last returned. The editor also ignores notifications whose version it already holds.
- `handle.reload()` is the host-driven alternative.
- Moss identifies its own writes by `size:mtimeMs` with a 5 s TTL. bb's writes always look external to Moss, which is intended: a clean Moss editor reloads, a dirty one rebases user-wins on its next save. When bb rolls back by exchange, the restored file keeps Moss's original inode and mtime, so Moss sees its own bytes.

## 6. Save timing, flush and unmount

- Timing mirrors desktop's `CanvasAreaContent` exactly (1242-1265):
  - Each edit restarts a 1500 ms idle timer.
  - When an edit arrives at least 15 s after the first unsaved edit, it saves immediately instead. The check runs only on edits, so the longest gap is just under 16.5 s (an edit at 14.9 s saves at about 16.4 s). It is not a hard deadline.
  - A 30 min safety-net save while dirty; a 200 ms debounce on external changes.
  - None are configurable in API 1.
- Edits that schedule a save: body edits, a title commit, comment changes, and frontmatter property changes.
- At most one write is in flight per mount. A new save chains onto it, as desktop's `savePromiseRef` does (CanvasAreaContent.tsx:3121-3127).

**`flush()`.** Each call:
1. waits for `ready` if the first read is in progress; returns `{kind:'notLoaded'}` if it failed or was abandoned;
2. commits the drafts desktop commits before saving: a focused title field, and decorator drafts such as an open table cell (CanvasAreaContent.tsx:2070-2095, 3198-3200);
3. takes revision R, every edit present at that moment;
4. waits for any in-flight write, then writes again if R is not yet on disk;
5. resolves `{kind:'saved', version, receipt}` only when R is on disk.
- Calls at the same revision share a write. Later edits are not covered; `status` reports `dirty` if any exist.
- It never rejects. A failure returns `conflict` (with `preserved`), `removed` or `error` (with `failure`), each with a `draft`.
- It replaces desktop's awaited quit flush (`onRequestFlush`, App.tsx:985-1068). The host must await it before hiding, suspending or destroying the frame, and on app quit.

**Before the first read.** The editor is not editable while `loading`, so no edits exist. If the first read fails, status becomes `notLoaded`, `ready` rejects, `flush()` and `reload()` resolve `{kind:'notLoaded'}`, and `unmount()` resolves `{kind:'unmounted', flush:{kind:'notLoaded'}}`. Desktop likewise treats a save with no loaded note as a no-op (CanvasAreaContent.tsx:2517-2519, 2540-2542). An `unmount()` during the first read abandons it, rejects `ready` with code `unmounted`, and resolves the same way. `notLoaded` is part of the API-1 baseline, so hosts can switch exhaustively.

**Drafts and receipts.** A `MossDraft` holds `baseVersion`, the companion versions, the markdown, comments and layout bytes, and `intents`: pending `frontmatterMetaUpdates` (merged) and the full `commentColors` snapshot (replaces). Neither is recoverable from the content files (comments.json carries no colors). On restore, the editor re-derives meta.json from the then-current meta.json plus these intents, so restoring a draft does not revert other metadata. A receipt is the same shape, holding the bytes of a completed save.

**`unmount(options?)`.**
1. Make the editor read-only.
2. Flush, as `flush()`.
3. If the result is `clean`, `saved` or `notLoaded`, or `discardUnsaved: true` was passed: unsubscribe `watch`, tear down, resolve `{kind:'unmounted', flush}`.
4. Otherwise do not tear down: make the editor editable again, keep the conflict or error UI, resolve `{kind:'kept', flush}`.
- This matches desktop's quit path, which collects save failures before deciding to close.
- On `kept`, the host either keeps the frame open, or stores `flush.draft`, calls `unmount({discardUnsaved: true})`, and later mounts with `restoreDraft`. A restored draft whose base or companions are stale opens in `conflict`.
- On `unmounted` with `saved`, the host stores `flush.receipt` (§5.5).
- Recommended sequence: `flush()`, inspect, then `unmount()`. Concurrent calls share one attempt.

**Page lifecycle.** The editor also starts a best-effort (unawaited) flush on `pagehide`, on `visibilitychange` to hidden, and on `beforeunload`. Desktop skips visibility changes because they are noisy in a desktop window; in a plugin frame, becoming hidden often precedes teardown, and an early save produces identical bytes. These are a backstop; `flush()` and `unmount()` are the contract.

## 7. Assets

- `assets.put(noteId, {name, data, mimeType, purpose})` returns `{kind:'stored', ref:'assets/<name>'}`, relative to the note folder.
- The editor names files with desktop's `buildImageFilename` (ipc-handlers.ts:2532-2545): `<sanitized-base>-<ms>-<uuid8><ext>`, or `<base>-<ms>-<uuid8>-mockup<ext>` when the base ends in `-mockup`.
- The host creates the file exclusively (temp, then `link(2)` or a no-replace rename) and returns `exists` on a collision; the editor regenerates the name once. The host never renames.
- Types: png, jpg, jpeg, gif, webp, svg, mp4, webm, mov. Unknown image MIME types are stored as `.png`, as in desktop.
- Size: no editor limit, because desktop has none. The host may refuse (`refused`, `tooLarge`, `maxBytes`). The moss-multi web caps (10 MB, 95 MB) are Worker limits and do not apply.
- Comment image attachments use the same `put` (`purpose:'comment'`) and are stored in `comments.json` `imageUrls`. Desktop's native picker becomes an in-frame file chooser.
- **Cross-note paste**, as desktop (ExternalImagePastePlugin.tsx:252-300): the editor recognises `moss-asset://` URLs and, via `assets.parseUrl`, URLs this host issued; calls `assets.copyFromNote(noteId, {sourceNoteId, sourceRef, name})`; rewrites the ref; strips refs it could not copy. The host confines the source to the source note's folder by realpath.
- `assets.url(noteId, ref, kind)` is synchronous and returns `string | null`. Video URLs must answer Range requests with 206. URLs are keyed by note id so they survive a folder rename.
- Divergences in API 1: no trashing of unreferenced assets (orphans are left, the safe direction); remote-URL images stay remote refs, because the frame has no network access.

## 8. Contract versioning and release

- `MOSS_EDITOR_API = 1`. `bridge.api` must be `1`; otherwise `ready` rejects with `apiMismatch`.
- Additive changes keep API 1 and are negotiated by feature strings:
  - The editor publishes `MOSS_EDITOR_INFO {api, version, features}`, mirrored in `editor.json`. A host returns a new result kind or reason, or sends a new notification kind, only if the editor lists its feature.
  - The host publishes `bridge.features`. The editor sends a new op, calls a new optional method, or emits a new event, flush-result or reload-result kind only if the bridge lists the matching feature. Hosts may therefore switch exhaustively on every union.
  - The baseline defines no feature strings. 0.2.0 adds two editor features (§8.1).
- Hosts ignore unknown event fields and manifest fields. Removing, renaming, narrowing, or changing a default or a meaning requires API 2.
- Package: `@moss-multi/editor` in `packages/editor`, a sibling of `packages/viewer`. Not on npm; installed by release URL.
- Entries:
  - `moss-editor.js` and `moss-editor.css`: the frame bundle.
  - `moss-editor-host.js`: pure helpers for the host process: `isMossNoteId`, `noteIdKey`, `markdownCandidates`, `pickMarkdownFallback`, `allocateFolderName`, `folderPathFor`, `sidecarFileName`, `versionToken`, `noteEditability`, `isMossFolderName`, `isMossAssetName`, `MOSS_NOTE_FILES`, `MOSS_EDITOR_INFO`. One ES2022 module with no imports (globals: `TextEncoder`, `crypto.subtle`), built ahead of the frame editor by T3.9a and shipped as the `moss-editor-host` CI artifact with `contract.d.ts` and `editor-host.json`.
  - `moss-html-frame.html`: the moss-html frame document (§9).
- Release: GitHub Release `editor-v0.1.0` on brsbl/moss-multi with `moss-editor-0.1.0.tgz` (unpacks to `moss-editor/`), `SHA256SUMS` and `editor.json`. CI on the integrated head runs `pnpm pack` (T3.8's packing), uploads the `moss-editor` artifact and records the run. The coordinator publishes the release and notifies thr_6fabbskqcf.
- `editor.json` has `viewer.json`'s fields plus `features`, `hostEntry`, `htmlFrame {file, policy}`, `build.run`, `editableScopes: ['internal']` and `csp`.
- Semver stays 0.x until bb has shipped against it. The API number is independent of semver.

### 8.1 Editor features in 0.2.0 (T3.10)

Both are additive within API 1 and listed in `MOSS_EDITOR_INFO.features` and `editor.json` `features`. The viewer (1.1.0) has the same two, with the same shapes.

- **`selection-1`: `handle.selection(): MossSelection | null`.** Null when the selection is collapsed, outside the note body (the title, a popover) or the note is not loaded. Otherwise:
  - `text`: the selected plain text as rendered, never a `%%m:` marker: one line per block, table cells tab-separated, a code block's source without its header or gutter.
  - `lines: {start, end}`: 1-based, inclusive lines in the note's markdown exactly as a save would write the current buffer, unsaved edits included, frontmatter and the `# Title` line counted. They come from the save's own export, run once on the body and once per top-level block. Inside a list, table or code block they name the items, rows or code lines selected (a code block's source counts from its textarea while it is open, the unblurred edit included); a selection across table cells is Lexical's table selection, which outlives the mouseup; elsewhere every line of each block touched.
  - `markdown`: those lines, comment markers stripped.
  - `headings`: the heading path over the selection's start, outermost first (a selected heading included).
  - `blocks: {type, line, heading?}[]`: each top-level block touched, its Lexical node type (`paragraph`, `heading`, `list`, `table`, `code-block`, …), first line and innermost heading.
  - Moss markdown has no persisted block ids, so the line range plus the heading path is the stable reference.
- **`share-with-agent-1`: optional `services.shareWithAgent(selection)`.** When the host supplies it, the editor shows Moss's Share with Agent button (the header button the web app hides under P:Agents) above the note; a press calls the service with `selection()` at that moment, or null. A service that throws or rejects is logged, not raised. Without the service the button stays hidden, as in 0.1.0.

## 9. CSP

The editor needs no eval, no wasm, no workers and no network of its own. Relative to a viewer frame it needs `blob:` for just-pasted media, `data:` frames, and the host-served moss-html frame.

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self';
img-src 'self' data: blob: https: <asset-origin>;
media-src 'self' data: blob: <asset-origin>;
frame-src data: https: <html-frame-origin>;
connect-src 'none';
worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'
```

- `style-src 'unsafe-inline'`: Lexical and moss set inline styles, as in the moss-multi web app.
- `frame-src data:`: moss's `IframeFrame` renders `srcDoc` frames as `data:text/html` URLs (renderer/editor/iframe/IframeFrame.tsx:17-18, 35-45), as ARCHITECTURE.md §CSP already lists for the web app.
- **moss-html blocks**: a `data:` frame inherits the embedding frame's CSP (SP13, settled at T0.5a), so a block's inline scripts cannot run there under `script-src 'self'`. As in the web app's `/frame/html` (apps/web/src/worker/html-frame.ts), the tarball ships `moss-html-frame.html`. The host serves it with the response header `Content-Security-Policy: sandbox allow-scripts` (opaque origin, no access to the editor or host) and passes its URL as `htmlFrameUrl`; `<html-frame-origin>` is that URL's origin. The editor points moss-html blocks at it and posts the block HTML (`moss-html-frame-ready` / `moss-html-frame-content`). Without `htmlFrameUrl`, blocks render in `data:` frames with scripts blocked.
- `https:` in `frame-src` covers web embeds.
- `connect-src 'none'`: unfurl and assets go through host services and the bridge.
- The frame must also permit a user-activated `<input type=file>` for comment attachments and the media picker.
- The renderer and shared sources at the pin contain no `eval`, `new Function`, `WebAssembly` or `new Worker`. Third-party code is not yet verified, so CI's e2e suite runs the editor under exactly this policy and fails on any violation; the final requirement is published in `editor.json` `csp`.

## 10. Answers to the consumer's questions

1. **Options, handle, constants.**
   - Options: `{noteId, bridge, theme?, services?: {notes?, navigate?, unfurl?}, htmlFrameUrl?, onEvent?, restoreDraft?}`. Asset URLs come from `bridge.assets.url`, scoped by note.
   - Handle: `{info, noteId, status, location, ready, setTheme, flush(), reload({discardUnsaved?}), unmount({discardUnsaved?})}`.
   - `flush()` covers every edit present at the call and never rejects. Results: `clean`, `saved` (with `receipt`), `notLoaded`, or a failure carrying a `draft`.
   - `unmount()` flushes and tears down only if nothing is left unsaved or `discardUnsaved` is set; otherwise `{kind:'kept', flush}`. A mount whose first read failed unmounts with `flush: {kind:'notLoaded'}`.
   - Constants: `MOSS_EDITOR_API = 1`, `MOSS_EDITOR_INFO {api, version, features}`, manifest `editor.json` (§8); entries `moss-editor.js`, `moss-editor.css`, `moss-editor-host.js`, `moss-html-frame.html`.
2. **Bridge** (`bridge.api` must be 1; `bridge.features` optional).
   - **read:** `{kind:'note', files:{markdown, comments, layout, meta}, location:{folderPath, folderName, markdownName}, version, metaVersion} | {kind:'notFound'} | {kind:'notEditable', reason}`. Raw text; `null` means absent ("no sidecar"). Versions are opaque strings. `readCompanion` returns `{kind:'file', text, version} | {kind:'absent', version}`.
   - **write:** `{baseVersion, baseMetaVersion, companions, rename: {kind:'renameFolder', desiredName} | null, ops}`. `ops` carries only changed files (plus `meta` always, plus a markdown put on rename or normalization), as `{kind:'put', file, text} | {kind:'delete', file:'comments'|'layout'}`. Deletion is explicit. Files are raw strings serialized exactly as desktop does. Result: `{kind:'saved', version, metaVersion, location} | {kind:'conflict', reason:'content'|'companion'|'meta'|'raced', version, metaVersion, applied, preserved, location} | {kind:'failed', code, message, applied, preserved, location} | {kind:'notFound'} | {kind:'notEditable', reason}`. Write I/O errors are the typed `failed` result; a rejection means state unknown. Reads and asset calls reject on I/O errors. One version covers md, comments and layout (§5.1).
   - **assets:** `put` stores to `assets/<name>` relative to the note folder; the editor names with desktop's rule; the host creates exclusively and returns `exists` on collision. Allow-list, no editor size limit, optional host `refused`. Comment attachments covered. `copyFromNote` for cross-note paste. `url` and `parseUrl` are synchronous.
   - **onExternalChange:** `bridge.watch(noteId, listener) → unsubscribe`, subscribed by the editor. Notifications `{kind:'changed', version, metaVersion} | {kind:'removed', reason}`. `handle.reload()` for host-driven reloads.
   - **events:** one option callback, `onEvent(event)`, with a `kind` union: `dirty`, `saving`, `saved` (with `receipt`), `conflict`, `conflictResolved`, `reloaded`, `removed`, `error` (with `failure`). Chosen over `handle.on` so no event can fire before the host subscribes.
3. **noteId:** meta.json's id, trimmed, case preserved, exact match as desktop does. Not the path (§4).
4. **Desktop save behaviour.** Every save rewrites meta.json (`updatedAt` in unix seconds, H1 `title`, `folderPath`, `contentType`, merged provenance, the full `commentColors` snapshot) and writes `<folderName>.md`, unlinking a legacy name. A title change renames the folder and the `.md`. The bridge writes meta.json; the editor supplies its bytes. Comments for a `.md` outside `~/Moss/Notes` sit next to it only for `<X>/<X>.md`, otherwise in `~/Moss/Notes/External/<title>/`, where layout.json and meta.json always are. So only adopted `~/Moss/Notes` notes are editable in API 1.
5. **Debounce:** 1500 ms idle; the 15 s cap is checked on each edit, as desktop does, so the worst case is about 16.5 s; 30 min safety net. Best-effort flush on `pagehide`, `visibilitychange` to hidden and `beforeunload` (desktop does only `beforeunload`). Awaited paths: `flush()` and `unmount()`.
6. **Release shape:** `editor-v0.x.y` with tarball, `SHA256SUMS`, `editor.json` and the CI run, like the viewer. `@moss-multi/editor` is a separate package. CSP: §9 (`blob:`, `frame-src data:`, the host-served moss-html frame; no eval, wasm, workers or `connect-src`).
7. **RENAME_SWAP from a Node host (follow-up).** The requirement is semantic (§5.4): atomic exchange keeping the displaced bytes, comparison with the expected bytes, then restore or `raced`, with nothing displaced ever deleted unless it equals the expected bytes. Any mechanism is fine: a JXA `ObjC.bindFunction('renamex_np', …)` script under `osascript`, or a vendored helper binary. Prefer a long-lived helper over one spawn per swap, since a save can need up to five exchanges plus rollbacks. Exclusive creation, `lstat` and the delete path work in plain Node. A host that cannot exchange atomically must not offer editing at API 1 and answers `notEditable` with `hostUnsupported` if called. Linux has `renameat2(RENAME_EXCHANGE)`, so it is not excluded in principle; bb making editing Mac-only is fine.
8. **Title renames (follow-up).** The editor decides; the host executes. The write carries `rename: {kind:'renameFolder', desiredName}` exactly when the new H1 differs from meta.json `title`, always together with a markdown put and a meta put. The host allocates the final name with `allocateFolderName`, renames the folder exclusively (plain rename for a case-only change), writes `<final>.md`, and verified-deletes the old `.md` only if it is a different inode (a case-only retitle on APFS deletes nothing; the entry is just respelled). meta.json is written last. The host never infers a rename from meta. After the write, `saved.location` is `{folderPath: unchanged, folderName: <final>, markdownName: '<final>.md'}`; the `saved` event carries the same `location` and `renamed: true`, and `handle.location` updates. Worked examples on `MossFolderRename`.
9. **Version scope (follow-up).** §5.1 and §5.2: `version` = resolved markdown + comments.json + layout.json bytes with presence tags; `metaVersion` = meta.json bytes + `folderPath`; each consumed companion such as `assets/<name>-mockup.html` has its own version, sent back in `write.companions`, and a mismatch is `conflict` `companion` (user-visible). `meta` is never user-visible: the editor re-derives and retries up to 3 times, then reports `error` and retries after 5 s.

## 11. The consumer's host plan

1. **Version = sha256 over markdown, layout and comments: OK, with changes.** Tag presence per file. Keep meta.json out of `version`; hash it with `folderPath` as `metaVersion`. Add per-companion versions for files `readCompanion` served.
2. **Refuse stale writes, re-checked under a per-note lock: OK as a precondition, not sufficient.** Moss's locks are in-process and do not see bb's. Replace "re-check then rename" with the verified replacement of §5.3: atomic exchange, compare the displaced bytes, restore or preserve, roll back on `raced`, and verify after the write. Return conflicts and I/O failures as results. A plain rename over the target can destroy a Moss save and is not allowed.
3. **Temp + fsync + rename in the same folder: changed.** Overwrites use an atomic exchange instead of rename; new files use exclusive placement. Name temps with `sidecarFileName` (byte-aware truncation to 255 bytes), fsync the directory after each move, ignore EINVAL, ENOTSUP, EPERM and ENOSYS from fsync, and remove the temp on failure. Order: folder rename → `<folder>.md` (then delete the old file only if it is a different inode) → comments → layout → meta.
4. **Assets confined to the note folder, realpath confinement and Range serving: OK for internal notes.** Add exclusive creation (`exists`), `copyFromNote` with source confinement, `parseUrl`, and `readCompanion` with the same confinement. Confinement would be wrong for external notes; one more reason they are read-only.
5. **External changes by polling the hash: OK.** Poll about once a second while mounted plus on frame focus; resolve the note by id on each poll so a Moss rename or move is followed; also poll meta.json and the location; do not report your own writes.
6. **Missing from the plan:** writing meta.json; the explicit folder rename and `.md` rename/delete with the inode check; the two-step markdown resolution by probing (not by matching a listing); the editability gate (Trash is `~/Moss/Trash`); exact-id lookup (not path, not lowercased) with `duplicateId`; serving `moss-html-frame.html`; storing drafts when `unmount()` returns `kept`; retaining save receipts beyond unmount and offering Restore.

## 12. Deviations and open risks

- **From T3.9:**
  - The banner adds an explicit **Overwrite** next to Reload and Keep editing; without it, "keep editing" after a refused write can only end in discarding the edits. Never automatic.
  - Save receipts and a best-effort "Moss replaced your last save" notice with Restore (§5.5).
  - The bridge is more specific than T3.9's sketch: `kind` unions, `watch` instead of `onExternalChange`, `metaVersion`, companion versions, `rename`, verified replacement, a typed `failed` result, `readCompanion`, `copyFromNote`/`parseUrl`, feature negotiation, drafts with intents, receipts, `notLoaded`, `htmlFrameUrl`. The owner should confirm these.
- **From desktop:**
  - No automatic rebase or merge; no asset garbage collection; no adoption of unadopted notes; flushes on visibility and pagehide; unmount refuses to drop unsaved edits; an unreadable (EACCES) `comments.json` fails the mount instead of falling back to the footer. All in the safe direction.
  - After a case-only retitle, desktop's `persistFile` renames a temp over the path, while bb exchanges and then respells the entry. The final names should match; the golden suite's case-insensitive mode checks it.
- **Risks:**
  - Moss can replace a bb save at any later time (§5.5). It is recoverable from the host's receipt, not prevented and not always detected, until Moss honours an external lock or exchanges instead of renaming.
  - Desktop's meta.json key order, `contentType` classifier, editor-read migrations, comment fallback, markdown resolution, folder allocation and temp-name truncation must be ported exactly. Golden tests against desktop's `note-store` gate the release.
  - Moss desktop and the embed may rename the same folder concurrently; `raced`, `notFound` or a version change surfaces it.
  - Editing is limited to volumes with atomic exchange; network and exFAT volumes may fall back to the viewer.
  - The editor does not exist yet, and T3.8 (packing, moss-html in frames) comes first.

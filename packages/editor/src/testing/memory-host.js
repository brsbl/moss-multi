// A fixture host for @moss-multi/editor: a MossEditorBridge (contract.ts, API 2) over an in-memory Moss workspace.
// It follows the host's side of the contract with the pure helpers from moss-editor-host.js: notes are found by
// meta.json id, the markdown is resolved by probing then listing, writes are checked against the content, companion
// and meta versions and applied in order with a rollback when a target no longer holds its expected bytes, folders
// are renamed with allocateFolderName, assets are created exclusively, media is copied only out of notes the user
// opened, and external changes are reported through watch. A volume can be case-insensitive, as default APFS is.
// The unit tests and the e2e fixture page share it.
import {
  MOSS_NOTE_FILES,
  allocateFolderName,
  folderPathFor,
  isMossAssetName,
  isMossFolderName,
  markdownCandidates,
  noteEditability,
  noteIdKey,
  pickMarkdownFallback,
  versionToken,
} from '../host/moss-editor-host.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ROOT = '/Moss';

const dirname = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);
const bytesOf = (data) => (typeof data === 'string' ? encoder.encode(data) : data);

/** A flat in-memory volume of files; directories exist while a file sits under them. Paths are absolute POSIX. */
export class MemoryVolume {
  constructor({ caseInsensitive = false } = {}) {
    this.caseInsensitive = caseInsensitive;
    /** key → { path, data: string | Uint8Array, mtimeMs } */
    this.files = new Map();
    /** key → path, for empty directories created on purpose */
    this.dirs = new Map();
    this.clock = 1_000;
    this.listeners = new Set();
    this.quiet = 0;
  }

  key(path) {
    return this.caseInsensitive ? path.normalize('NFD').toLowerCase() : path;
  }

  changed(path) {
    if (this.quiet > 0) return;
    for (const listener of this.listeners) listener(path);
  }

  /** Runs `fn` without reporting its changes (the host's own writes). */
  silently(fn) {
    this.quiet += 1;
    try {
      return fn();
    } finally {
      this.quiet -= 1;
    }
  }

  exists(path) {
    return this.files.has(this.key(path)) || this.isDir(path);
  }

  isFile(path) {
    return this.files.has(this.key(path));
  }

  isDir(path) {
    const prefix = `${this.key(path)}/`;
    if (this.dirs.has(this.key(path))) return true;
    for (const key of this.files.keys()) if (key.startsWith(prefix)) return true;
    for (const key of this.dirs.keys()) if (key.startsWith(prefix)) return true;
    return false;
  }

  mkdir(path) {
    if (!this.exists(path)) this.dirs.set(this.key(path), path);
  }

  readBytes(path) {
    const entry = this.files.get(this.key(path));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return bytesOf(entry.data);
  }

  /** Node's `readFile(path, 'utf8')`: a BOM stays, invalid bytes become U+FFFD. */
  readFile(path) {
    const entry = this.files.get(this.key(path));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return typeof entry.data === 'string' ? entry.data : decoder.decode(entry.data);
  }

  mtimeMs(path) {
    const entry = this.files.get(this.key(path));
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return entry.mtimeMs;
  }

  /**
   * Creates or replaces a file. Replacing keeps the existing entry's spelling: on APFS a rename over `plan.md`
   * named `Plan.md` leaves the entry `plan.md`, which is what desktop's persistFile (temp, then rename) produces.
   */
  writeFile(path, data, mtimeMs) {
    this.clock += 1;
    const existing = this.files.get(this.key(path));
    this.files.set(this.key(path), { path: existing?.path ?? path, data, mtimeMs: mtimeMs ?? this.clock });
    this.changed(path);
  }

  unlink(path) {
    if (!this.files.delete(this.key(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    this.changed(path);
  }

  /** Renames a file or a whole directory. */
  rename(from, to) {
    const fromKey = this.key(from);
    const file = this.files.get(fromKey);
    if (file) {
      // A case-only rename respells the entry; a rename over another file keeps that entry's spelling.
      const replaced = this.key(to) === fromKey ? null : this.files.get(this.key(to));
      this.files.delete(fromKey);
      this.files.set(this.key(to), { ...file, path: replaced?.path ?? to });
      this.changed(to);
      return;
    }
    const prefix = `${fromKey}/`;
    const moved = [...this.files].filter(([key]) => key.startsWith(prefix));
    for (const [key, entry] of moved) {
      this.files.delete(key);
      const path = `${to}${entry.path.slice(from.length)}`;
      this.files.set(this.key(path), { ...entry, path });
    }
    for (const [key, dir] of [...this.dirs]) {
      if (key === fromKey || key.startsWith(prefix)) {
        this.dirs.delete(key);
        const path = `${to}${dir.slice(from.length)}`;
        this.dirs.set(this.key(path), path);
      }
    }
    this.changed(to);
  }

  /** Direct entries of a directory. */
  readdir(dir) {
    const prefix = `${this.key(dir)}/`;
    const entries = new Map();
    const add = (path, isFile) => {
      const rest = path.slice(dir.length + 1);
      const name = rest.split('/')[0];
      const direct = !rest.includes('/');
      const mtimeMs = direct && isFile ? this.mtimeMs(path) : 0;
      if (!entries.has(name)) entries.set(name, { name, isFile: direct && isFile, mtimeMs });
    };
    for (const [key, entry] of this.files) if (key.startsWith(prefix)) add(entry.path, true);
    for (const [key, path] of this.dirs) if (key.startsWith(prefix)) add(path, false);
    return [...entries.values()];
  }

  /** Every file's text (assets as `bytes:<n>`), keyed by its spelled path, sorted. */
  snapshot(under = '') {
    return Object.fromEntries(
      [...this.files.values()]
        .filter((entry) => entry.path.startsWith(under))
        .map((entry) => [entry.path, typeof entry.data === 'string' ? entry.data : `bytes:${entry.data.length}`])
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  }
}

const tagged = (code, message) => Object.assign(new Error(message), { code });

/**
 * The bridge. `onApply(file)` runs before each op lands, so a test can race a writer.
 */
export class MemoryHost {
  constructor({ volume = new MemoryVolume(), api = 2, features = [], unsupported = false } = {}) {
    this.volume = volume;
    this.api = api;
    this.features = features;
    this.unsupported = unsupported;
    this.calls = [];
    this.watchers = new Map();
    this.own = new Map();
    this.lastRead = new Map();
    this.locks = new Map();
    this.onApply = null;
    this.urls = new Map();
    this.pendingNotify = null;
    /** Note id keys the user has open in the host: editor mounts (their read) and `open` (a viewer tab). */
    this.opened = new Set();
    volume.listeners.add(() => this.scheduleNotify());
    this.assets = {
      put: (noteId, asset) => this.assetPut(noteId, asset),
      copyFromNote: (noteId, copy) => this.assetCopy(noteId, copy),
      url: (noteId, ref, kind) => this.assetUrl(noteId, ref, kind),
      parseUrl: (url) => this.parseAssetUrl(url),
    };
  }

  // ---- resolution -----------------------------------------------------------------------------------------------

  /** Every note folder (a directory holding meta.json) under the workspace, by id key. */
  index() {
    const found = new Map();
    for (const entry of this.volume.files.values()) {
      if (basename(entry.path) !== MOSS_NOTE_FILES.meta || !entry.path.startsWith(`${ROOT}/`)) continue;
      let id;
      try {
        id = JSON.parse(this.volume.readFile(entry.path)).id;
      } catch {
        continue;
      }
      if (typeof id !== 'string') continue;
      const key = noteIdKey(id);
      found.set(key, [...(found.get(key) ?? []), dirname(entry.path)]);
    }
    return found;
  }

  segments(dir) {
    return dir.startsWith(`${ROOT}/`) ? dir.slice(ROOT.length + 1).split('/') : null;
  }

  markdownName(dir) {
    const folderName = basename(dir);
    let noteId = '';
    try {
      noteId = JSON.parse(this.volume.readFile(`${dir}/${MOSS_NOTE_FILES.meta}`)).id ?? '';
    } catch {
      // no id: only the folder name and note.md are candidates
    }
    for (const candidate of markdownCandidates({ folderName, noteId: String(noteId) })) {
      if (this.volume.isFile(`${dir}/${candidate}`)) return candidate;
    }
    return pickMarkdownFallback(this.volume.readdir(dir));
  }

  /** `{dir}` for an editable note, else the typed refusal. */
  resolve(noteId) {
    const dirs = this.index().get(noteIdKey(noteId)) ?? [];
    if (dirs.length === 0) return { kind: 'notFound' };
    if (dirs.length > 1) return { kind: 'notEditable', reason: 'duplicateId' };
    const dir = dirs[0];
    const metaPath = `${dir}/${MOSS_NOTE_FILES.meta}`;
    const editability = noteEditability({
      workspaceSegments: this.segments(dir),
      metaText: this.volume.isFile(metaPath) ? this.volume.readFile(metaPath) : null,
      hasMarkdown: this.markdownName(dir) !== null,
    });
    if (editability.kind !== 'editable') return editability;
    if (this.unsupported) return { kind: 'notEditable', reason: 'hostUnsupported' };
    return { kind: 'note', dir };
  }

  readText(path) {
    return this.volume.isFile(path) ? this.volume.readFile(path) : null;
  }

  async state(dir) {
    const markdownName = this.markdownName(dir);
    const files = {
      markdown: this.volume.readFile(`${dir}/${markdownName}`),
      comments: this.readText(`${dir}/${MOSS_NOTE_FILES.comments}`),
      layout: this.readText(`${dir}/${MOSS_NOTE_FILES.layout}`),
      meta: this.volume.readFile(`${dir}/${MOSS_NOTE_FILES.meta}`),
    };
    const segments = this.segments(dir);
    const folderPath = folderPathFor(segments);
    const location = { folderPath, folderName: basename(dir), markdownName };
    const bytes = (text) => (text === null ? null : encoder.encode(text));
    const version = await versionToken([
      { role: 'markdown', bytes: this.volume.readBytes(`${dir}/${markdownName}`) },
      { role: 'comments', bytes: this.volume.isFile(`${dir}/${MOSS_NOTE_FILES.comments}`) ? this.volume.readBytes(`${dir}/${MOSS_NOTE_FILES.comments}`) : null },
      { role: 'layout', bytes: this.volume.isFile(`${dir}/${MOSS_NOTE_FILES.layout}`) ? this.volume.readBytes(`${dir}/${MOSS_NOTE_FILES.layout}`) : null },
    ]);
    const metaVersion = await versionToken([
      { role: 'meta', bytes: this.volume.readBytes(`${dir}/${MOSS_NOTE_FILES.meta}`) },
      { role: 'folderPath', bytes: bytes(folderPath) },
    ]);
    return { files, location, version, metaVersion };
  }

  /** desktop's readNoteRelativeCompanionFile confinement (note-store.ts:3047-3069): `null` when outside or absent. */
  companionPath(dir, relativePath) {
    if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\0')) return null;
    if (relativePath.startsWith('/') || relativePath.startsWith('~') || relativePath.split(/[\\/]+/).includes('..')) return null;
    const segments = relativePath.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (segments.length === 0) return null;
    return `${dir}/${segments.join('/')}`;
  }

  async companionVersion(dir, relativePath) {
    const path = this.companionPath(dir, relativePath);
    const bytes = path && this.volume.isFile(path) ? this.volume.readBytes(path) : null;
    return { path, bytes, version: await versionToken([{ role: 'companion', bytes }]) };
  }

  async lock(noteId) {
    const key = noteIdKey(noteId);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((done) => (release = done));
    this.locks.set(key, previous.then(() => gate));
    await previous;
    return release;
  }

  // ---- the bridge -----------------------------------------------------------------------------------------------

  /** The user opened `noteId` in the host outside an editor, for example in a viewer. */
  open(noteId) {
    this.opened.add(noteIdKey(noteId));
  }

  close(noteId) {
    this.opened.delete(noteIdKey(noteId));
  }

  async read(noteId) {
    this.calls.push({ op: 'read', noteId });
    this.opened.add(noteIdKey(noteId));
    const resolved = this.resolve(noteId);
    if (resolved.kind !== 'note') return resolved;
    const state = await this.state(resolved.dir);
    this.lastRead.set(noteIdKey(noteId), { version: state.version, metaVersion: state.metaVersion });
    return { kind: 'note', ...state };
  }

  async readCompanion(noteId, relativePath) {
    this.calls.push({ op: 'readCompanion', noteId, relativePath });
    const resolved = this.resolve(noteId);
    if (resolved.kind !== 'note') throw tagged('ENOENT', 'note not found');
    const { bytes, version } = await this.companionVersion(resolved.dir, relativePath);
    return bytes === null ? { kind: 'absent', version } : { kind: 'file', text: decoder.decode(bytes), version };
  }

  async write(noteId, write) {
    this.calls.push({ op: 'write', noteId, write });
    const release = await this.lock(noteId);
    // The host never reports its own writes.
    this.volume.quiet += 1;
    try {
      return await this.applyWrite(noteId, write);
    } finally {
      this.volume.quiet -= 1;
      release();
    }
  }

  async applyWrite(noteId, write) {
    const resolved = this.resolve(noteId);
    if (resolved.kind !== 'note') return resolved;
    let dir = resolved.dir;
    const current = await this.state(dir);
    const conflict = async (reason, applied = [], preserved = []) => {
      const now = await this.state(dir);
      return { kind: 'conflict', reason, version: now.version, metaVersion: now.metaVersion, applied, preserved, location: now.location };
    };
    if (current.version !== write.baseVersion) return conflict('content');
    for (const companion of write.companions) {
      if ((await this.companionVersion(dir, companion.relativePath)).version !== companion.version) return conflict('companion');
    }
    if (current.metaVersion !== write.baseMetaVersion) return conflict('meta');

    if (write.rename) {
      if (!isMossFolderName(write.rename.desiredName)) {
        return { kind: 'failed', code: 'EINVAL', message: 'desiredName fails isMossFolderName', applied: [], preserved: [], location: current.location };
      }
      const parent = dirname(dir);
      const own = basename(dir);
      const finalName = allocateFolderName({
        desiredName: write.rename.desiredName,
        currentName: own,
        siblingNames: this.volume.readdir(parent).map((entry) => entry.name).filter((name) => name !== own),
        caseInsensitive: this.volume.caseInsensitive,
      });
      if (finalName !== own) {
        const target = `${parent}/${finalName}`;
        const caseOnly = this.volume.key(target) === this.volume.key(dir);
        if (!caseOnly && this.volume.exists(target)) return conflict('raced');
        this.volume.rename(dir, target);
        dir = target;
      }
    }

    // Expected bytes E per target, read in the check above.
    const folderName = basename(dir);
    const oldMarkdown = `${dir}/${current.location.markdownName}`;
    const targets = {
      markdown: `${dir}/${folderName}.md`,
      comments: `${dir}/${MOSS_NOTE_FILES.comments}`,
      layout: `${dir}/${MOSS_NOTE_FILES.layout}`,
      meta: `${dir}/${MOSS_NOTE_FILES.meta}`,
    };
    const sameEntry = this.volume.key(targets.markdown) === this.volume.key(oldMarkdown);
    const expected = {
      markdown: sameEntry ? current.files.markdown : this.readText(targets.markdown),
      comments: current.files.comments,
      layout: current.files.layout,
      meta: current.files.meta,
    };
    const applied = [];
    const undo = [];
    for (const op of write.ops) {
      await this.onApply?.(op.file, dir);
      const path = targets[op.file];
      const before = this.readText(path);
      if (before !== expected[op.file]) {
        for (const step of undo.reverse()) step();
        return conflict('raced');
      }
      if (op.kind === 'put') this.volume.writeFile(path, op.text);
      else if (before !== null) this.volume.unlink(path);
      // Step 5: roll a file back only while it still holds this write's bytes; another writer's bytes stay.
      const ours = op.kind === 'put' ? op.text : null;
      undo.push(() => {
        if (this.readText(path) !== ours) return;
        if (before === null) this.volume.unlink(path);
        else this.volume.writeFile(path, before);
      });
      applied.push(op.file);
      // Step 4, markdown identity: the same entry keeps its spelling (API 2), as desktop's rename over it does on APFS.
      if (op.file === 'markdown' && !sameEntry && this.volume.isFile(oldMarkdown)) {
        const old = this.volume.readFile(oldMarkdown);
        if (old === current.files.markdown) {
          this.volume.unlink(oldMarkdown);
          undo.push(() => {
            if (!this.volume.isFile(oldMarkdown)) this.volume.writeFile(oldMarkdown, old);
          });
        }
      }
    }
    // Step 6: re-read every file; one another writer replaced after its own op makes this write `raced`, no rollback.
    const produced = { ...expected };
    for (const op of write.ops) produced[op.file] = op.kind === 'put' ? op.text : null;
    for (const file of Object.keys(targets)) {
      if (this.readText(targets[file]) !== produced[file]) {
        return conflict('raced', applied.filter((name) => this.readText(targets[name]) === produced[name]), []);
      }
    }
    const after = await this.state(dir);
    this.own.set(noteIdKey(noteId), { version: after.version, metaVersion: after.metaVersion });
    return { kind: 'saved', version: after.version, metaVersion: after.metaVersion, location: after.location };
  }

  watch(noteId, listener) {
    const key = noteIdKey(noteId);
    const set = this.watchers.get(key) ?? new Set();
    set.add(listener);
    this.watchers.set(key, set);
    // The baseline is the version the editor last read, so a change between that read and this call is reported.
    const read = this.lastRead.get(key);
    if (read && !this.own.has(key)) this.own.set(key, read);
    return () => set.delete(listener);
  }

  scheduleNotify() {
    if (this.pendingNotify) return;
    this.pendingNotify = setTimeout(() => {
      this.pendingNotify = null;
      void this.notify();
    }, 0);
  }

  /** Reports each watched note whose files differ from the last version this host wrote or reported. */
  async notify() {
    for (const [key, listeners] of this.watchers) {
      if (listeners.size === 0) continue;
      const resolved = this.resolve(key);
      let change;
      if (resolved.kind !== 'note') {
        change = { kind: 'removed', reason: resolved.kind === 'notFound' ? 'notFound' : resolved.reason };
        this.own.delete(key);
      } else {
        const state = await this.state(resolved.dir);
        const last = this.own.get(key);
        if (last && last.version === state.version && last.metaVersion === state.metaVersion) continue;
        this.own.set(key, { version: state.version, metaVersion: state.metaVersion });
        change = { kind: 'changed', version: state.version, metaVersion: state.metaVersion };
      }
      for (const listener of listeners) listener(change);
    }
  }

  // ---- assets ---------------------------------------------------------------------------------------------------

  assetDir(dir) {
    return `${dir}/${MOSS_NOTE_FILES.assetsDir}`;
  }

  async assetPut(noteId, asset) {
    this.calls.push({ op: 'assetPut', noteId, name: asset.name, mimeType: asset.mimeType, purpose: asset.purpose });
    if (!isMossAssetName(asset.name)) return { kind: 'refused', reason: 'name' };
    const resolved = this.resolve(noteId);
    if (resolved.kind !== 'note') return resolved;
    const path = `${this.assetDir(resolved.dir)}/${asset.name}`;
    if (this.volume.exists(path)) return { kind: 'exists' };
    const bytes = new Uint8Array(await asset.data.arrayBuffer());
    this.volume.silently(() => this.volume.writeFile(path, bytes));
    return { kind: 'stored', ref: `${MOSS_NOTE_FILES.assetsDir}/${asset.name}` };
  }

  async assetCopy(noteId, copy) {
    const call = { op: 'assetCopy', noteId, sourceNoteId: copy.sourceNoteId, sourceRef: copy.sourceRef, name: copy.name, result: '' };
    this.calls.push(call);
    const result = await this.copyAsset(noteId, copy);
    call.result = result.kind === 'refused' ? `refused:${result.reason}` : result.kind;
    return result;
  }

  async copyAsset(noteId, copy) {
    if (!isMossAssetName(copy.name)) return { kind: 'refused', reason: 'name' };
    // Only a note the user has open; checked before any lookup, so a refusal says nothing about other notes.
    if (!this.opened.has(noteIdKey(copy.sourceNoteId))) return { kind: 'refused', reason: 'sourceNotOpen' };
    const source = this.index().get(noteIdKey(copy.sourceNoteId)) ?? [];
    if (source.length !== 1) return { kind: 'notFound' };
    const sourcePath = this.companionPath(source[0], copy.sourceRef);
    if (!sourcePath || !copy.sourceRef.startsWith(`${MOSS_NOTE_FILES.assetsDir}/`) || !this.volume.isFile(sourcePath)) return { kind: 'notFound' };
    const resolved = this.resolve(noteId);
    if (resolved.kind !== 'note') return resolved;
    const path = `${this.assetDir(resolved.dir)}/${copy.name}`;
    if (this.volume.exists(path)) return { kind: 'exists' };
    const bytes = this.volume.readBytes(sourcePath);
    this.volume.silently(() => this.volume.writeFile(path, bytes));
    return { kind: 'stored', ref: `${MOSS_NOTE_FILES.assetsDir}/${copy.name}` };
  }

  /** A blob URL per stored asset, made on first use; anything else is moss's missing state. */
  assetUrl(noteId, ref, kind) {
    this.calls.push({ op: 'assetUrl', noteId, ref, kind });
    const resolved = this.index().get(noteIdKey(noteId)) ?? [];
    if (resolved.length !== 1 || typeof ref !== 'string' || !ref.startsWith(`${MOSS_NOTE_FILES.assetsDir}/`)) return null;
    const path = this.companionPath(resolved[0], ref);
    if (!path || !this.volume.isFile(path)) return null;
    const cacheKey = `${noteIdKey(noteId)}\0${ref}`;
    const cached = this.urls.get(cacheKey);
    if (cached) return cached.url;
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
    const type = types[ref.slice(ref.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([this.volume.readBytes(path)], { type }));
    this.urls.set(cacheKey, { url, noteId: noteIdKey(noteId), ref });
    return url;
  }

  parseAssetUrl(url) {
    for (const entry of this.urls.values()) if (entry.url === url) return { noteId: entry.noteId, ref: entry.ref };
    return null;
  }
}

/** Seeds an internal note folder at `Notes/<...segments>` and returns its directory. */
export function seedNote(volume, segments, { markdownName, markdown, meta, comments = null, layout = null, assets = {} }) {
  const dir = `${ROOT}/${segments.join('/')}`;
  volume.silently(() => {
    volume.writeFile(`${dir}/${markdownName ?? `${segments[segments.length - 1]}.md`}`, markdown);
    volume.writeFile(`${dir}/${MOSS_NOTE_FILES.meta}`, typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2));
    if (comments !== null) volume.writeFile(`${dir}/${MOSS_NOTE_FILES.comments}`, comments);
    if (layout !== null) volume.writeFile(`${dir}/${MOSS_NOTE_FILES.layout}`, layout);
    for (const [name, data] of Object.entries(assets)) volume.writeFile(`${dir}/${MOSS_NOTE_FILES.assetsDir}/${name}`, data);
  });
  return dir;
}

export const WORKSPACE_ROOT = ROOT;

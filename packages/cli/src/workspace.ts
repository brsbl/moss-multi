// Pull and push state (A§17): each workspace keeps `.moss-multi/<docId>/{meta.json, base.md}`. The base is the exact
// bytes last pulled, so a push sends its hash and the server can three-way merge against it. Nothing here follows a
// symbolic link: every path is checked step by step below the workspace root, its real parent must lie inside the
// root's real path, and each name passes moss's filename rules. Every command that reads or writes a local file
// goes through `confined`.
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, constants, type Dirent, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  utimesSync, writeFileSync, type Stats,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ASSET_DIR, MEDIA_TYPES, mediaTypeOf } from '@moss-multi/protocol/media';
import { CliError } from './errors.ts';
import { isUnsafeChar } from './output.ts';

export const STATE_DIR = '.moss-multi';
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface DocMeta {
  docId: string;
  /** The tracked file, relative to the workspace root. */
  file: string;
  baseHash: string;
  pulledAt: number;
  /** The server filename when the file was last synced, so sync can tell when the server renamed it. */
  filename?: string;
  /** The file's hash when it was last synced; the base's hash when absent (the file was the base). */
  localHash?: string;
  /** `moss`: the file is a moss note kept in moss format (title line, markers), and the base is its clean body. */
  mode?: 'moss';
  /** For a moss note, the title its title line held when it was last synced. */
  title?: string;
  /**
   * The texts the file held, in the base's form, each time sync wrote over it within the last PRIOR_MS
   * (`prior-<hash>.md`), oldest first: an editor may still hold one and save it back (T7.P2).
   */
  priors?: Prior[];
}

export interface Prior {
  hash: string;
  /** When sync wrote over it. */
  at: number;
  /** A save sync refused (its ancestor unknown) or pushed with hunks that clashed: it never reached the doc whole, so it is no revert target. */
  refused?: true;
}

/** The only hash form a prior record may hold: sha256Hex's. */
const HASH = /^[0-9a-f]{64}$/;
const PRIOR_FILE = /^prior-[0-9a-f]{32}\.md$/;

/**
 * How long after sync's write a save can still come from an editor holding the prior text: moss saves a dirty editor
 * within its 15 s unsaved window (1.5 s when idle), and reloads a clean one. A later save is from a reloaded editor.
 */
export const PRIOR_MS = 60_000;
/** A save's mtime may read up to this much before sync's write on a volume with coarse timestamps. */
const MTIME_SLACK_MS = 2_000;
/** The bytes of prior texts a workspace keeps (MOSS_MULTI_PRIOR_BYTES overrides); past it the oldest are evicted. */
const PRIOR_BYTES = 64 * 1024 * 1024;
const priorBudget = (): number => Number(process.env.MOSS_MULTI_PRIOR_BYTES) || PRIOR_BYTES;

/** What else a synced doc records beside its base. */
export interface SyncedState {
  filename?: string;
  localHash?: string;
  mode?: 'moss';
  title?: string;
  /** What the file held before this write, in the base's form: it joins the prior texts kept for the same file. */
  prior?: Uint8Array;
  /** The prior is a save sync refused (Prior.refused). */
  refused?: boolean;
}

export const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const lstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
};

/** A real directory: a link to one does not count. */
const isDir = (path: string) => lstat(path)?.isDirectory() === true;

/**
 * moss's filename rules: no `< > : " / \ | ? *` or U+0000-U+001F, not `.` or `..`, at most 255 UTF-8 bytes. Also no
 * character the terminal treats as a control (DEL, C1, bidi marks).
 */
const BAD_NAME = /[<>:"/\\|?*]/;
export const isAllowedName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && !BAD_NAME.test(name) && Buffer.byteLength(name, 'utf8') <= 255 &&
  ![...name].some((char) => char.charCodeAt(0) <= 0x1f || isUnsafeChar(char.charCodeAt(0)));

export interface MediaRef {
  /** The span of the reference's file name in the text. */
  start: number;
  end: number;
  name: string;
}

const NAME_END = new Set([' ', '\t', '\n', '\r', ')', '>', '"', "'"]);

/** Every `](assets/<file>)` (or `](./assets/…`, `](<assets/…`) reference to a moss media file in `text`, in order. */
export function mediaRefs(text: string): MediaRef[] {
  const refs: MediaRef[] = [];
  let at = text.indexOf('](');
  while (at >= 0) {
    let i = at + 2;
    if (text[i] === '<') i += 1;
    if (text.startsWith('./', i)) i += 2;
    let next = at + 2;
    if (text.startsWith(ASSET_DIR, i)) {
      const start = i + ASSET_DIR.length;
      let end = start;
      while (end < text.length && !NAME_END.has(text[end]!)) end += 1;
      next = Math.max(next, end);
      let name = text.slice(start, end);
      try {
        name = decodeURIComponent(name);
      } catch {
        // A stray % stays as it is.
      }
      if (mediaTypeOf(name) && isAllowedName(name)) refs.push({ start, end, name });
    }
    at = text.indexOf('](', next);
  }
  return refs;
}

/** The media names `text` references. */
export const refNames = (text: string) => new Set(mediaRefs(text).map((ref) => ref.name));

/** Each workspace root's real path and identity, recorded when the command selects it (`findRoot`, `pinRoot`). */
const roots = new Map<string, { real: string; dev: number; ino: number }>();

/** Starts a command: each root is recorded afresh at its first check. */
export const resetRootPins = (): void => roots.clear();

/** The root's real path, refusing a root moved, replaced or swapped for a link since the command first checked it. */
function pinnedRoot(root: string): string {
  const real = realpathSync(root);
  const { dev, ino } = statSync(real);
  const pinned = roots.get(root);
  if (!pinned) roots.set(root, { real, dev, ino });
  else if (pinned.real !== real || pinned.dev !== dev || pinned.ino !== ino) {
    throw new CliError(1, `the workspace at ${root} was moved or replaced while moss-multi was working, so nothing more was written`);
  }
  return real;
}

/**
 * Records `root`'s identity for this command, or refuses it if it no longer matches the one recorded. Call it as soon
 * as a command selects its root, before any network request or lock wait, so a root swapped meanwhile is never trusted.
 */
export function pinRoot(root: string): string {
  pinnedRoot(root);
  return root;
}

/** The nearest existing directory holding `root/rel` must resolve inside the root's real path. */
function realInside(root: string, rel: string): void {
  const realRoot = pinnedRoot(root);
  let dir = dirname(join(root, rel));
  while (!lstat(dir) && dir !== root) dir = dirname(dir);
  const inner = relative(realRoot, realpathSync(dir));
  if (inner === '..' || inner.startsWith(`..${sep}`) || isAbsolute(inner)) throw new CliError(1, `${rel} resolves outside the workspace at ${root}`);
}

/** Refuses a symbolic link at any step from `root` down to `rel`, the last step included; returns the full path. */
function noLinks(root: string, rel: string): string {
  let path = root;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    const stats = lstat(path);
    if (!stats) break;
    if (stats.isSymbolicLink()) throw new CliError(1, `${relative(root, path)} is a symbolic link; moss-multi does not follow links out of the workspace`);
  }
  return join(root, rel);
}

/**
 * Writes `bytes` to `rel` through a temporary file and a rename. With `expectHash` the file must still hash to it
 * (null: still be absent) just before the replace, so an edit saved while a request was in flight is not lost.
 */
function writeInside(root: string, rel: string, bytes: Uint8Array, expectHash?: string | null, durable = false): void {
  const target = noLinks(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  noLinks(root, rel);
  realInside(root, rel);
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx');
  let made: Stats;
  try {
    writeFileSync(fd, bytes);
    if (durable) fsyncSync(fd);
    made = fstatSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // A directory swapped for a link (or the root replaced) since the checks above fails closed: check again, and that
    // the temporary file is still the one made, where it was made, right before the rename.
    noLinks(root, rel);
    realInside(root, rel);
    const placed = lstat(temp);
    if (!placed || placed.dev !== made.dev || placed.ino !== made.ino) throw new CliError(1, `${rel}: its folder changed while moss-multi was writing, so nothing was written`);
    if (expectHash !== undefined) {
      const current = lstat(target) ? sha256Hex(readFileSync(target)) : null;
      if (current !== expectHash) throw new CliError(1, `${rel} changed while moss-multi was working, so it was not overwritten; run the command again`);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  if (durable) syncDir(dirname(target));
}

/** Flushes a directory's entries (a rename into it), where the platform allows it. */
function syncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch {
    // Not every platform opens or flushes a directory.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The nearest directory at or above `start` holding a real `.moss-multi` directory, or null. Callers pass the working
 * directory, never a file's directory: a marker found below a link would make the link's target the root.
 */
export function findRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isDir(join(dir, STATE_DIR))) return pinRoot(dir);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The folder between `root` and `rel` (relative to it) that is a workspace with its own scope file, or null. That scope
 * governs the file, so nothing run from outside it reads, uploads or writes it. A nested workspace with no scope file
 * stays reachable, as before scopes.
 */
export function scopedNest(root: string, rel: string): string | null {
  let dir = root;
  for (const part of rel.split(sep).slice(0, -1)) {
    dir = join(dir, part);
    if (lstat(join(dir, STATE_DIR, 'scope.json'))) return dir;
  }
  return null;
}

/** Refuses `rel` when it is inside a nested scoped workspace (scopedNest). */
export function notInNested(root: string, rel: string): void {
  const dir = scopedNest(root, rel);
  if (dir) throw new CliError(1, `${rel} is inside another moss-multi workspace with its own scope (${dir}); run the command from there so its scope applies`);
}

/**
 * `file` relative to `root`, refusing anything outside it, reached through a symbolic link, inside the state
 * directory, or named against moss's filename rules.
 */
export function confined(root: string, file: string): string {
  const rel = relative(root, resolve(root, file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CliError(1, `${file} is outside the workspace at ${root}`);
  const parts = rel.split(sep);
  // In any letter case: on a case-insensitive volume `.MOSS-MULTI` is the state directory.
  if (parts[0]!.toLowerCase() === STATE_DIR) throw new CliError(1, `${rel} is inside ${STATE_DIR}, where moss-multi keeps its own state`);
  const bad = parts.find((part) => !isAllowedName(part));
  if (bad !== undefined) throw new CliError(1, `"${bad}" is not a file name moss allows (no < > : " / \\ | ? * or control characters)`);
  noLinks(root, rel);
  realInside(root, rel);
  return rel;
}

/** The bytes of a regular file confined to `root`: a link, a directory or a missing file is refused. */
export function readConfined(root: string, file: string): Buffer {
  const rel = confined(root, file);
  const path = join(root, rel);
  if (!lstat(path)?.isFile()) throw new CliError(1, `no such file: ${rel}`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw new CliError(1, `${rel} changed while moss-multi was reading it (${(error as NodeJS.ErrnoException).code ?? 'error'}); run the command again`);
  }
  try {
    // Opened by name after the checks, so check again: the file read is the one confined, not one swapped in meanwhile.
    const opened = fstatSync(fd);
    confined(root, rel);
    const now = lstat(path);
    if (!opened.isFile() || !now || now.dev !== opened.dev || now.ino !== opened.ino) throw new CliError(1, `${rel} changed while moss-multi was reading it; run the command again`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function stateRel(docId: string, name?: string): string {
  if (!DOC_ID.test(docId)) throw new CliError(1, `not a doc id: ${docId}`);
  return name ? join(STATE_DIR, docId, name) : join(STATE_DIR, docId);
}

export function readMeta(root: string, docId: string): DocMeta | null {
  const path = noLinks(root, stateRel(docId, 'meta.json'));
  if (!lstat(path)) return null;
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')) as DocMeta;
    if (meta.docId !== docId || typeof meta.file !== 'string' || typeof meta.baseHash !== 'string') return null;
    // A prior record names a state file: only the exact form the CLI writes is taken, so none can name another path.
    const records: unknown[] = Array.isArray(meta.priors) ? meta.priors : [];
    const priors = records
      .filter((prior): prior is Prior => {
        const record = prior as Partial<Prior> | null;
        return typeof record?.hash === 'string' && HASH.test(record.hash) && typeof record.at === 'number' && Number.isFinite(record.at);
      })
      .map((prior): Prior => ({ hash: prior.hash, at: prior.at, ...(prior.refused === true ? { refused: true } : {}) }));
    delete meta.priors;
    return priors.length ? { ...meta, priors } : meta;
  } catch {
    return null;
  }
}

export function readBase(root: string, docId: string): Uint8Array {
  return readFileSync(noLinks(root, stateRel(docId, 'base.md')));
}

const priorName = (hash: string) => `prior-${hash.slice(0, 32)}.md`;

/**
 * The doc's prior texts (DocMeta.priors) an editor could have saved back at `savedAt`, the file's mtime: from sync's
 * write over each until PRIOR_MS after it. A file whose mtime predates the write (a restored copy) was saved by none.
 * `missing`: one of them is no longer kept (evicted or damaged), so the text the editor held may be unknown.
 */
export function readPriors(root: string, meta: DocMeta, savedAt: number): { priors: (Prior & { bytes: Uint8Array })[]; missing: boolean } {
  const priors: (Prior & { bytes: Uint8Array })[] = [];
  let missing = false;
  for (const prior of meta.priors ?? []) {
    if (!HASH.test(prior.hash)) continue;
    if (savedAt < prior.at - MTIME_SLACK_MS || savedAt - prior.at > PRIOR_MS) continue;
    const same = priors.find((kept) => kept.hash === prior.hash);
    if (same) {
      if (prior.refused) same.refused = true;
      continue;
    }
    try {
      const bytes = readFileSync(noLinks(root, stateRel(meta.docId, priorName(prior.hash))));
      if (sha256Hex(bytes) === prior.hash) priors.push({ ...prior, bytes });
      else missing = true;
    } catch {
      missing = true;
    }
  }
  return { priors, missing };
}

/**
 * Evicts the oldest prior texts across the workspace until they fit its budget. Their records stay until their window
 * ends, so a save inside it is known to lack the text it may descend from.
 */
function trimPriors(root: string): void {
  const files: { path: string; at: number; size: number }[] = [];
  for (const docId of readdirSync(join(root, STATE_DIR))) {
    if (!DOC_ID.test(docId)) continue;
    // Only the doc's own prior files are candidates; its records give their times, never their paths.
    const latest = new Map<string, number>();
    for (const prior of readMeta(root, docId)?.priors ?? []) latest.set(priorName(prior.hash), Math.max(prior.at, latest.get(priorName(prior.hash)) ?? 0));
    let dir: string;
    try {
      dir = noLinks(root, stateRel(docId));
      if (!lstatSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !PRIOR_FILE.test(entry.name)) continue;
      const path = join(dir, entry.name);
      if (dirname(resolve(path)) !== resolve(dir)) continue;
      try {
        files.push({ path, at: latest.get(entry.name) ?? 0, size: lstatSync(path).size });
      } catch {
        // Already gone.
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const budget = priorBudget();
  for (const file of files.sort((a, b) => a.at - b.at)) {
    if (total <= budget) break;
    rmSync(file.path, { force: true });
    total -= file.size;
  }
}

/**
 * Whether the volume under `root` folds case, as APFS and NTFS do by default: there, `NOTE.md` is `note.md`, so
 * tracked paths compare case-insensitively. Probed on the real state directory.
 */
export function probeFoldsCase(root: string): boolean {
  const lower = lstat(join(root, STATE_DIR));
  const upper = lstat(join(root, STATE_DIR.toUpperCase()));
  return lower !== null && upper !== null && lower.ino === upper.ino && lower.dev === upper.dev;
}

/**
 * Whether the volume holding the existing `path` folds case, for a folder that is no workspace: the nearest name on the
 * path with a letter in it, in the other case, is the same file.
 */
export function foldsAt(path: string): boolean {
  for (let at = resolve(path); dirname(at) !== at; at = dirname(at)) {
    const name = basename(at);
    const swapped = [...name].map((char) => (char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase())).join('');
    if (swapped === name) continue;
    const one = lstat(at);
    const other = lstat(join(dirname(at), swapped));
    return one !== null && other !== null && one.ino === other.ino && one.dev === other.dev;
  }
  return false;
}

const foldPath = (path: string) => path.normalize('NFC').toLowerCase();
/** Whether two tracked paths name one file. */
const samePath = (a: string, b: string, folds: boolean) => (folds ? foldPath(a) === foldPath(b) : a === b);

/** Every doc tracked under `root`. */
export function trackedMetas(root: string): DocMeta[] {
  const dir = noLinks(root, STATE_DIR);
  if (!isDir(dir)) return [];
  const metas: DocMeta[] = [];
  for (const name of readdirSync(dir).sort()) {
    const meta = DOC_ID.test(name) ? readMeta(root, name) : null;
    if (meta) metas.push(meta);
  }
  return metas;
}

/** The tracked doc whose file is `file`, or null. */
export function metaForFile(root: string, file: string, folds = false): DocMeta | null {
  const rel = confined(root, file);
  return trackedMetas(root).find((meta) => samePath(meta.file, rel, folds)) ?? null;
}

/** Whether two workspace paths name one file on this volume. */
export const sameFile = (a: string, b: string, folds: boolean): boolean => samePath(a, b, folds);

/**
 * Writes `bytes` to a confined file through a temporary file and a rename; with `expectHash` the file must still hash
 * to it (null: still be absent).
 */
export function writeConfined(root: string, file: string, bytes: Uint8Array, expectHash?: string | null): void {
  writeInside(root, confined(root, file), bytes, expectHash);
}

/** A media file last synced for a doc: its bytes' hash, and the size and mtime it had then, so an unchanged file is not hashed again. */
export interface MediaState { hash: string; size: number; mtimeMs: number }

/** The doc's synced media by name (`.moss-multi/<docId>/media.json`); empty when there is none or it is unreadable. */
export function readMediaRecord(root: string, docId: string): Record<string, MediaState> {
  const path = noLinks(root, stateRel(docId, 'media.json'));
  if (!lstat(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, MediaState> : {};
  } catch {
    return {};
  }
}

export function writeMediaRecord(root: string, docId: string, record: Record<string, MediaState>): void {
  writeInside(root, stateRel(docId, 'media.json'), Buffer.from(`${JSON.stringify(record, null, 2)}\n`));
}

/**
 * The folder taint store (T7.S9), `.moss-multi/served-names.json`: for each note folder's assets/, every media name a
 * text the CLI wrote into that folder from the server could name. It only grows, it is flushed to disk before the text
 * is written, and a name in it never uploads from that folder. Folders and names are kept in one Unicode form and one
 * case on every volume, so a lookup never misses a spelling the volume would match.
 */
export const TAINT_FILE = 'served-names.json';
const ASSETS = ASSET_DIR.replace(/\/$/, '');
type Taint = Map<string, Set<string>>;

const fold = (text: string): string => text.normalize('NFC').toLowerCase();
/** The store's key for the assets/ folder of the notes in `folder`. */
const folderKey = (folder: string): string => fold(join(folder, ASSETS));

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", sol: '/', bsol: '\\', period: '.', lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[',
  rbrack: ']', colon: ':', excl: '!', num: '#', percnt: '%', equals: '=', nbsp: ' ', hyphen: '-', dash: '-', lowbar: '_', grave: '`', tilde: '~',
  plus: '+', comma: ',', semi: ';', quest: '?', ast: '*', verbar: '|', vert: '|', commat: '@', dollar: '$', hat: '^', lcub: '{', rcub: '}',
};
const decodeEntities = (text: string): string =>
  text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = /^#[xX]/.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
const decodePercent = (text: string): string =>
  text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
const unescapeMarkdown = (text: string): string => text.replace(/\\([!-/:-@[-`{-~])/g, '$1');

/** `text` and every form a reader could decode it to: entities, percent escapes, backslash escapes, compatibility forms. */
function decodedForms(text: string): string[] {
  const seen = new Set([text]);
  let frontier = [text];
  for (let round = 0; round < 3 && frontier.length > 0; round += 1) {
    const next: string[] = [];
    for (const form of frontier) {
      for (const decode of [decodeEntities, decodePercent, unescapeMarkdown]) {
        const decoded = decode(form);
        if (!seen.has(decoded)) {
          seen.add(decoded);
          next.push(decoded);
        }
      }
    }
    frontier = next;
  }
  for (const form of [...seen]) seen.add(form.normalize('NFKC'));
  return [...seen];
}

const MEDIA_END = new RegExp(`\\.(?:${Object.keys(MEDIA_TYPES).join('|')})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu');
/** Characters no file name holds: a run of name characters stops at one. */
const NOT_NAME = /[<>:"/\\|?*\p{Cc}]/u;
/** Characters that may sit inside a name: a name can start only after something else. */
const IN_WORD = /[\p{L}\p{N}\p{M}_.~-]/u;

/**
 * Every token in `text` that could name a media file, liberally and without the markdown parser: each run of name
 * characters (at most 255) ending in a media extension, from each place a name could start in it.
 */
function mediaTokens(text: string, add: (name: string) => void): void {
  for (const match of text.matchAll(MEDIA_END)) {
    const dot = match.index ?? 0;
    const end = dot + match[0].length;
    let start = dot;
    while (start > 0 && end - start < 255 && !NOT_NAME.test(text[start - 1]!)) start -= 1;
    for (let at = start; at <= dot; at += 1) {
      if (at !== start && IN_WORD.test(text[at - 1]!)) continue;
      const name = text.slice(at, end);
      if (isAllowedName(name)) add(fold(name));
      const trimmed = name.trim();
      if (trimmed !== name && isAllowedName(trimmed)) add(fold(trimmed));
    }
  }
}

/** The names of the entries in the assets/ beside the notes in `folder`; none when it cannot be listed safely. */
function assetEntries(root: string, folder: string): string[] {
  try {
    const dir = noLinks(root, join(folder, ASSETS));
    return lstat(dir)?.isDirectory() ? readdirSync(dir) : [];
  } catch {
    return [];
  }
}

/** The names `texts` could name in the assets/ beside the notes in `folder`: its files they mention, and every media token. */
function namesIn(root: string, folder: string, texts: (Uint8Array | string | undefined)[]): Set<string> {
  const names = new Set<string>();
  const present = assetEntries(root, folder).map(fold);
  for (const text of texts) {
    if (text === undefined) continue;
    for (const form of decodedForms(typeof text === 'string' ? text : Buffer.from(text).toString('utf8'))) {
      mediaTokens(form, (name) => names.add(name));
      const folded = fold(form);
      for (const name of present) if (folded.includes(name)) names.add(name);
    }
  }
  return names;
}

const isTaint = (value: unknown): value is { folders: Record<string, string[]> } => {
  const folders = (value as { folders?: unknown } | null)?.folders;
  return typeof folders === 'object' && folders !== null && !Array.isArray(folders) &&
    Object.values(folders).every((names) => Array.isArray(names) && names.every((name) => typeof name === 'string'));
};

/** Whether the state directory holds any doc's record, readable or not. */
const tracksAny = (root: string): boolean => {
  try {
    return readdirSync(noLinks(root, STATE_DIR)).some((name) => DOC_ID.test(name));
  } catch (error) {
    // No state directory yet: nothing was ever tracked here. Anything else counts as tracked.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
};

/**
 * The store as it stands, and the bytes it was read from (null: there is none). One that is missing while the
 * workspace tracks a doc, or that cannot be read or parsed, is rebuilt closed (rebuildTaint); it is never taken as empty.
 */
function loadTaint(root: string): { taint: Taint; raw: Buffer | null; fresh: boolean } {
  let raw: Buffer | null;
  try {
    raw = readStateFile(root, TAINT_FILE);
  } catch {
    return { taint: rebuildTaint(root), raw: null, fresh: true };
  }
  if (raw === null) return { taint: tracksAny(root) ? rebuildTaint(root) : new Map(), raw: null, fresh: true };
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown;
    if (!isTaint(parsed)) throw new Error('malformed');
    return { taint: new Map(Object.entries(parsed.folders).map(([key, names]): [string, Set<string>] => [key, new Set(names)])), raw, fresh: false };
  } catch {
    return { taint: rebuildTaint(root), raw, fresh: true };
  }
}

const serializeTaint = (taint: Taint): Buffer =>
  Buffer.from(`${JSON.stringify({ version: 1, folders: Object.fromEntries([...taint].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, names]) => [key, [...names].sort()])) })}\n`);

/** Adds `add` to the store and flushes it, retrying when another process wrote it meanwhile; a failure throws. */
function addTaint(root: string, add: Taint): void {
  for (let attempt = 0; ; attempt += 1) {
    const { taint, raw, fresh } = loadTaint(root);
    let grew = fresh;
    for (const [key, names] of add) {
      const held = taint.get(key) ?? new Set<string>();
      taint.set(key, held);
      for (const name of names) {
        if (held.has(name)) continue;
        held.add(name);
        grew = true;
      }
    }
    if (!grew) return;
    try {
      writeInside(root, join(STATE_DIR, TAINT_FILE), serializeTaint(taint), raw ? sha256Hex(raw) : null, true);
      return;
    } catch (error) {
      if (attempt >= 5 || !(error instanceof CliError)) throw error;
    }
  }
}

/**
 * Records, before a text from the server is written into the note `rel` (or beside it), every media name the texts
 * could name in that note's assets/. Throws when it cannot be recorded, so the text is not written.
 */
export function taintNote(root: string, rel: string, texts: (Uint8Array | string | undefined)[]): void {
  const folder = dirname(rel);
  addTaint(root, new Map([[folderKey(folder), namesIn(root, folder, texts)]]));
}

/** Records `names` themselves (names the server gave files) as the server's in the assets/ beside the note `rel`. */
export function taintNames(root: string, rel: string, names: Iterable<string>): void {
  addTaint(root, new Map([[folderKey(dirname(rel)), new Set([...names].map(fold))]]));
}

/** Makes sure the store exists before a pass tracks anything: an empty one for a workspace that tracks no doc yet. */
export function ensureTaintStore(root: string): void {
  const { taint, raw, fresh } = loadTaint(root);
  if (!fresh) return;
  try {
    writeInside(root, join(STATE_DIR, TAINT_FILE), serializeTaint(taint), raw ? sha256Hex(raw) : null, true);
  } catch {
    // Read again (and rebuilt) by every check, and a write it blocks fails closed.
  }
}

/** Whether the media `name` beside the note `rel` is one the server ever showed in that folder, read once per call. */
export function taintCheck(root: string): (rel: string, name: string) => boolean {
  const { taint } = loadTaint(root);
  return (rel, name) => taint.get(folderKey(dirname(rel)))?.has(fold(name)) ?? false;
}

/**
 * The store rebuilt closed: for every tracked doc's folder and every folder holding notes or an assets/ folder, every
 * name in those assets/ folders, and every name the note files, conflict files, bases, prior texts, titles and media
 * records there could name. A doc whose record cannot be read counts for every folder.
 */
function rebuildTaint(root: string): Taint {
  const texts: { folder: string | null; text: Uint8Array | string }[] = [];
  const folders = new Set<string>();
  const taint: Taint = new Map();
  const add = (folder: string, names: Iterable<string>) => {
    const key = folderKey(folder);
    const held = taint.get(key) ?? new Set<string>();
    taint.set(key, held);
    for (const name of names) held.add(fold(name));
  };
  let ids: string[] = [];
  try {
    ids = readdirSync(noLinks(root, STATE_DIR)).filter((name) => DOC_ID.test(name));
  } catch {
    // No state to read.
  }
  const loose: string[] = [];
  for (const id of ids) {
    let meta: DocMeta | null = null;
    let own: (Uint8Array | string)[] = [];
    try {
      meta = readMeta(root, id);
      const dir = noLinks(root, stateRel(id));
      own = readdirSync(dir).filter((name) => name === 'base.md' || /^prior(-[0-9a-f]+)?\.md$/.test(name)).map((name) => readFileSync(noLinks(root, stateRel(id, name))));
    } catch {
      // What cannot be read is not there to scan.
    }
    if (meta?.title) own.push(meta.title);
    let media: string[] = [];
    try {
      media = Object.keys(readMediaRecord(root, id));
    } catch {
      // No record to read.
    }
    if (meta) {
      const folder = dirname(meta.file);
      folders.add(folder);
      add(folder, media);
      for (const text of own) texts.push({ folder, text });
    } else {
      loose.push(...media);
      for (const text of own) texts.push({ folder: null, text });
    }
  }
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === ASSETS || /\.md$/i.test(entry.name))) folders.add(dir);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || ['.git', STATE_DIR].some((marker) => lstat(join(root, rel, marker)))) continue;
        walk(rel);
      } else if (entry.isFile() && /\.(md|rej)$/i.test(entry.name)) {
        try {
          texts.push({ folder: dir, text: readFileSync(join(root, rel)) });
        } catch {
          // Gone or unreadable: nothing to scan.
        }
      }
    }
  };
  walk('.');
  for (const folder of folders) add(folder, [...assetEntries(root, folder), ...loose]);
  for (const { folder, text } of texts) {
    for (const target of folder === null ? folders : [folder]) add(target, namesIn(root, target, [text]));
  }
  return taint;
}

/** Writes a text from the server into the note `rel`, recording what it could name first; a file that already holds it is left alone. */
function writeServed(root: string, rel: string, bytes: Uint8Array, expectHash: string | null | undefined, extra: (string | undefined)[]): void {
  try {
    const path = join(root, rel);
    if (lstat(path)?.isFile() && readFileSync(path).equals(bytes)) return;
  } catch {
    // Written below, or refused there.
  }
  taintNote(root, rel, [bytes, ...extra]);
  writeInside(root, rel, bytes, expectHash);
}

/** Rewrites a doc's meta.json (its file or server filename moved); the base is unchanged. */
export function writeMeta(root: string, meta: DocMeta): void {
  writeInside(root, stateRel(meta.docId, 'meta.json'), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
}

/**
 * Renames one confined file to another name; false when something already holds the new name (on a volume that folds
 * case, the file itself does not count).
 */
export function renameInside(root: string, from: string, to: string, folds: boolean): boolean {
  const source = join(root, confined(root, from));
  const target = join(root, confined(root, to));
  if (lstat(target) && !(folds && samePath(relative(root, source), relative(root, target), true))) return false;
  if (!lstat(source)?.isFile()) return false;
  renameSync(source, target);
  return true;
}

/** A workspace-wide file in the state directory (`scope.json`), or null when there is none; a link is refused. */
export function readStateFile(root: string, name: string): Buffer | null {
  const path = noLinks(root, join(STATE_DIR, name));
  const stats = lstat(path);
  if (!stats) return null;
  if (!stats.isFile()) throw new CliError(1, `${join(STATE_DIR, name)} is not a regular file`);
  return readFileSync(path);
}

/** Writes a workspace-wide state file; without `replace` it must not exist yet. */
export function writeStateFile(root: string, name: string, bytes: Uint8Array, replace = false): void {
  writeInside(root, join(STATE_DIR, name), bytes, replace ? undefined : null);
}

/** Whether `root` holds a real state directory. */
export const isWorkspace = (root: string): boolean => isDir(join(root, STATE_DIR));

/** Creates the state directory, so `root` is a workspace; a link in its place is refused. */
export function ensureStateDir(root: string): void {
  const dir = noLinks(root, STATE_DIR);
  if (!lstat(dir)) mkdirSync(dir);
  if (!isDir(dir)) throw new CliError(1, `${dir} is not a directory`);
}

/**
 * Writes the pulled bytes to `file` and records them as the base. `expectHash` is what the file must still hold
 * when it is replaced (null: still absent; undefined: --force replaces whatever is there).
 */
export function recordPull(root: string, docId: string, file: string, bytes: Uint8Array, expectHash: string | null | undefined, folds = false, state: Pick<SyncedState, 'prior' | 'refused'> = {}): DocMeta {
  const rel = confined(root, file);
  writeServed(root, rel, bytes, expectHash, []);
  return recordBase(root, docId, rel, bytes, folds, state);
}

/**
 * Writes `local` to `file` (which must still hash to `expectHash`) and records `base`, the server's bytes, as its
 * base: for a file kept in another form than the server's, as a moss note is.
 */
export function recordSynced(root: string, docId: string, file: string, local: Uint8Array, base: Uint8Array, expectHash: string | null, folds: boolean, state: SyncedState): DocMeta {
  const rel = confined(root, file);
  writeServed(root, rel, local, expectHash, [state.title]);
  return recordBase(root, docId, rel, base, folds, { ...state, localHash: sha256Hex(local) });
}

/**
 * Records `bytes` as the doc's base for `rel`. The file holds the base unless `state.localHash` says otherwise; the
 * server filename, mode and title carry over unless given. Any other doc that tracked `rel` lets go of it: a file has
 * one owner.
 */
export function recordBase(root: string, docId: string, rel: string, bytes: Uint8Array, folds = false, state: SyncedState = {}): DocMeta {
  writeInside(root, stateRel(docId, 'base.md'), bytes);
  const previous = readMeta(root, docId);
  const baseHash = sha256Hex(bytes);
  const known = state.filename ?? previous?.filename;
  const mode = state.mode ?? previous?.mode;
  const title = state.title ?? previous?.title;
  // Every write inside its window keeps its record, however many: an editor may hold a text from before all of them.
  // Only the bytes are bounded (trimPriors); a later save is from an editor that reloaded since.
  const now = Date.now();
  let priors = (previous?.file === rel ? previous.priors ?? [] : []).filter((prior) => now - prior.at <= PRIOR_MS);
  if (state.prior !== undefined) {
    const hash = sha256Hex(state.prior);
    writeInside(root, stateRel(docId, priorName(hash)), state.prior);
    priors = [...priors, { hash, at: now, ...(state.refused ? { refused: true as const } : {}) }];
  }
  const kept = new Set(priors.map((prior) => priorName(prior.hash)));
  const stateDir = noLinks(root, stateRel(docId));
  for (const name of readdirSync(stateDir)) {
    if (/^prior(-[0-9a-f]+)?\.md$/.test(name) && !kept.has(name)) rmSync(join(stateDir, name), { force: true });
  }
  const meta: DocMeta = {
    docId, file: rel, baseHash, pulledAt: Date.now(), ...(known !== undefined ? { filename: known } : {}),
    ...(state.localHash !== undefined && state.localHash !== baseHash ? { localHash: state.localHash } : {}),
    ...(mode ? { mode } : {}), ...(title !== undefined ? { title } : {}), ...(priors.length ? { priors } : {}),
  };
  writeMeta(root, meta);
  if (state.prior !== undefined) trimPriors(root);
  for (const name of readdirSync(join(root, STATE_DIR))) {
    if (name === docId || !DOC_ID.test(name)) continue;
    const other = readMeta(root, name);
    if (other && samePath(other.file, rel, folds)) rmSync(join(root, STATE_DIR, name), { recursive: true, force: true });
  }
  return meta;
}

/** A local file name for a doc: its server filename's last segment, or one made from its title. */
export function localName(filename: string, title: string): string {
  const last = filename.split(/[\\/]/).pop() ?? '';
  if (isAllowedName(last) && !last.startsWith('pending-') && last !== '.md' && !last.startsWith('.')) return last;
  const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|(?<!-)-+$/g, '').slice(0, 80);
  return `${slug || 'untitled'}.md`;
}

/** The workspace lock: one process at a time classifies and records files, so no file is adopted twice. */
const LOCK = join(STATE_DIR, '.lock');
/** A lock from another host, or one never written in full, counts as stale once untouched this long. */
const FOREIGN_STALE_MS = 10 * 60_000;
const PARTIAL_STALE_MS = 10_000;

interface LockOwner { pid: number; host: string; nonce: string }

export interface WorkspaceLock {
  /** Marks the lock as still in use, for a long pass seen from another host. */
  touch(): void;
  release(): void;
}

function readLock(path: string): { raw: string; owner: LockOwner | null; mtimeMs: number } | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const { mtimeMs } = lstatSync(path);
    let owner: LockOwner | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<LockOwner>;
      if (Number.isInteger(parsed.pid) && typeof parsed.host === 'string' && typeof parsed.nonce === 'string') owner = parsed as LockOwner;
    } catch {
      // Written only in part.
    }
    return { raw, owner, mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Stale: its process is gone (same host), or it has not been touched for a long time. */
function isStale(lock: NonNullable<ReturnType<typeof readLock>>): boolean {
  const { owner } = lock;
  if (owner && owner.host === hostname()) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return Date.now() - lock.mtimeMs > (owner ? FOREIGN_STALE_MS : PARTIAL_STALE_MS);
}

/** Moves a stale lock aside; one that changed meanwhile (a fresh holder's) is put back. */
function breakStale(path: string, raw: string): void {
  const aside = `${path}.${randomBytes(6).toString('hex')}.stale`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    if (readFileSync(aside, 'utf8') !== raw) linkSync(aside, path);
  } catch {
    // Someone holds the lock again.
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Takes the workspace lock with an exclusive create, waiting up to `waitMs` for another holder and taking over a
 * stale one. An aborted `signal` ends the wait.
 */
export async function lockWorkspace(root: string, waitMs = 5 * 60_000, signal?: AbortSignal): Promise<WorkspaceLock> {
  const path = noLinks(root, LOCK);
  const nonce = randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: hostname(), nonce, at: Date.now() });
  const deadline = Date.now() + waitMs;
  for (;;) {
    // A root swapped while this waited is refused before the lock is written through it.
    pinRoot(root);
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return {
        touch: () => {
          const now = new Date();
          if (readLock(path)?.raw === body) utimesSync(path, now, now);
        },
        release: () => {
          if (readLock(path)?.raw === body) rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const held = readLock(path);
    if (!held) continue;
    if (isStale(held)) {
      breakStale(path, held.raw);
      continue;
    }
    if (signal?.aborted) throw new CliError(1, 'stopped while waiting for the workspace lock');
    if (Date.now() >= deadline) {
      throw new CliError(1, `another moss-multi process${held.owner ? ` (pid ${held.owner.pid})` : ''} is syncing ${root}; try again once it finishes`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

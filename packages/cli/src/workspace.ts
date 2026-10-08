// Pull and push state (A§17): each workspace keeps `.moss-multi/<docId>/{meta.json, base.md}`. The base is the exact
// bytes last pulled, so a push sends its hash and the server can three-way merge against it. Nothing here follows a
// symbolic link: every path is checked step by step below the workspace root, its real parent must lie inside the
// root's real path, and each name passes moss's filename rules. Every command that reads or writes a local file
// goes through `confined`.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

/** The nearest existing directory holding `root/rel` must resolve inside the root's real path. */
function realInside(root: string, rel: string): void {
  const realRoot = realpathSync(root);
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
function writeInside(root: string, rel: string, bytes: Uint8Array, expectHash?: string | null): void {
  const target = noLinks(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  noLinks(root, rel);
  realInside(root, rel);
  const temp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temp, bytes, { flag: 'wx' });
  try {
    if (expectHash !== undefined) {
      const current = lstat(target) ? sha256Hex(readFileSync(target)) : null;
      if (current !== expectHash) throw new CliError(1, `${rel} changed while moss-multi was working, so it was not overwritten; run the command again`);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * The nearest directory at or above `start` holding a real `.moss-multi` directory, or null. Callers pass the working
 * directory, never a file's directory: a marker found below a link would make the link's target the root.
 */
export function findRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isDir(join(dir, STATE_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `file` relative to `root`, refusing anything outside it, reached through a symbolic link, inside the state
 * directory, or named against moss's filename rules.
 */
export function confined(root: string, file: string): string {
  const rel = relative(root, resolve(root, file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CliError(1, `${file} is outside the workspace at ${root}`);
  const parts = rel.split(sep);
  if (parts[0] === STATE_DIR) throw new CliError(1, `${rel} is inside ${STATE_DIR}, where moss-multi keeps its own state`);
  const bad = parts.find((part) => !isAllowedName(part));
  if (bad !== undefined) throw new CliError(1, `"${bad}" is not a file name moss allows (no < > : " / \\ | ? * or control characters)`);
  noLinks(root, rel);
  realInside(root, rel);
  return rel;
}

/** The bytes of a regular file confined to `root`: a link, a directory or a missing file is refused. */
export function readConfined(root: string, file: string): Buffer {
  const rel = confined(root, file);
  if (!lstat(join(root, rel))?.isFile()) throw new CliError(1, `no such file: ${rel}`);
  return readFileSync(join(root, rel));
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
    return meta.docId === docId && typeof meta.file === 'string' && typeof meta.baseHash === 'string' ? meta : null;
  } catch {
    return null;
  }
}

export function readBase(root: string, docId: string): Uint8Array {
  return readFileSync(noLinks(root, stateRel(docId, 'base.md')));
}

/** The tracked doc whose file is `file`, or null. */
export function metaForFile(root: string, file: string): DocMeta | null {
  const rel = confined(root, file);
  const dir = join(root, STATE_DIR);
  if (!isDir(dir)) return null;
  for (const name of readdirSync(dir)) {
    if (!DOC_ID.test(name)) continue;
    const meta = readMeta(root, name);
    if (meta && meta.file === rel) return meta;
  }
  return null;
}

/**
 * Writes the pulled bytes to `file` and records them as the base. `expectHash` is what the file must still hold
 * when it is replaced (null: still absent; undefined: --force replaces whatever is there).
 */
export function recordPull(root: string, docId: string, file: string, bytes: Uint8Array, expectHash?: string | null): DocMeta {
  const rel = confined(root, file);
  writeInside(root, rel, bytes, expectHash);
  return recordBase(root, docId, rel, bytes);
}

/** Records `bytes` as the doc's base for `rel`. Any other doc that tracked `rel` lets go of it: a file has one owner. */
export function recordBase(root: string, docId: string, rel: string, bytes: Uint8Array): DocMeta {
  writeInside(root, stateRel(docId, 'base.md'), bytes);
  const meta: DocMeta = { docId, file: rel, baseHash: sha256Hex(bytes), pulledAt: Date.now() };
  writeInside(root, stateRel(docId, 'meta.json'), Buffer.from(`${JSON.stringify(meta, null, 2)}\n`));
  for (const name of readdirSync(join(root, STATE_DIR))) {
    if (name === docId || !DOC_ID.test(name)) continue;
    if (readMeta(root, name)?.file === rel) rmSync(join(root, STATE_DIR, name), { recursive: true, force: true });
  }
  return meta;
}

/** A local file name for a doc: its server filename's last segment, or one made from its title. */
export function localName(filename: string, title: string): string {
  const last = filename.split(/[\\/]/).pop() ?? '';
  if (isAllowedName(last) && !last.startsWith('pending-') && last !== '.md' && !last.startsWith('.')) return last;
  const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${slug || 'untitled'}.md`;
}

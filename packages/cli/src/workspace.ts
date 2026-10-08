// Pull and push state (A§17): each workspace keeps `.moss-multi/<docId>/{meta.json, base.md}`. The base is the exact
// bytes last pulled, so a push sends its hash and the server can three-way merge against it.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CliError } from './errors.ts';

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

const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

/** The nearest directory at or above `start` holding `.moss-multi`, or null. */
export function findRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (isDir(join(dir, STATE_DIR))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** `file` relative to `root`, refusing anything outside it. */
export function confined(root: string, file: string): string {
  const rel = relative(root, resolve(root, file));
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CliError(1, `${file} is outside the workspace at ${root}`);
  return rel;
}

function docDir(root: string, docId: string): string {
  if (!DOC_ID.test(docId)) throw new CliError(1, `not a doc id: ${docId}`);
  return join(root, STATE_DIR, docId);
}

export function readMeta(root: string, docId: string): DocMeta | null {
  const path = join(docDir(root, docId), 'meta.json');
  if (!existsSync(path)) return null;
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8')) as DocMeta;
    return meta.docId === docId && typeof meta.file === 'string' && typeof meta.baseHash === 'string' ? meta : null;
  } catch {
    return null;
  }
}

export function readBase(root: string, docId: string): Uint8Array {
  return readFileSync(join(docDir(root, docId), 'base.md'));
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

/** Writes the pulled bytes to `file` and records them as the base. */
export function recordPull(root: string, docId: string, file: string, bytes: Uint8Array): DocMeta {
  const rel = confined(root, file);
  const target = join(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return recordBase(root, docId, rel, bytes);
}

export function recordBase(root: string, docId: string, rel: string, bytes: Uint8Array): DocMeta {
  const dir = docDir(root, docId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'base.md'), bytes);
  const meta: DocMeta = { docId, file: rel, baseHash: sha256Hex(bytes), pulledAt: Date.now() };
  writeFileSync(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** A local file name for a doc: its server filename's last segment, or one made from its title. */
export function localName(filename: string, title: string): string {
  const last = filename.split(/[\\/]/).pop() ?? '';
  if (last && !last.startsWith('pending-') && last !== '.md' && !last.startsWith('.')) return last;
  const slug = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return `${slug || 'untitled'}.md`;
}

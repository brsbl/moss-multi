// A workspace scope (`.moss-multi/scope.json`): which notes sync may adopt, pull and push. `allow` lists note folders
// or path globs; `follow` lists entry notes whose links (moss wiki links by title or id, and relative markdown links)
// bring the notes they reach into scope, `depth` hops out, re-read every pass; `deny` lists paths or globs that are
// never synced and win over both. A moss note is a folder (`<Title>/<Title>.md`), so a pattern matching the note's
// folder, or any folder above it, matches the note. Without the file every note is in scope.
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { CliError } from './errors.ts';
import { readConfined, readStateFile } from './workspace.ts';

export const SCOPE_FILE = 'scope.json';
const MAX_DEPTH = 10;

export interface Scope {
  allow: string[];
  follow: string[];
  depth: number;
  deny: string[];
}

const where = `.moss-multi/${SCOPE_FILE}`;

/** A pattern relative to the workspace root, `/`-separated: no absolute path, no `..`. */
function checkPattern(pattern: unknown, field: string): string {
  if (typeof pattern !== 'string' || pattern.trim() === '') throw new CliError(1, `${where}: every "${field}" entry is a non-empty path`);
  const parts = pattern.replace(/\\/g, '/').split('/').filter((part) => part !== '' && part !== '.');
  if (pattern.startsWith('/') || parts.length === 0 || parts.includes('..')) throw new CliError(1, `${where}: "${pattern}" must be a path inside the workspace`);
  return parts.join('/');
}

/** A scope from its JSON, refusing anything it cannot read exactly: a misspelt key must not widen what syncs. */
export function parseScope(text: string): Scope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError(1, `${where} is not JSON; nothing was synced`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError(1, `${where} is not an object with allow, follow, depth and deny; nothing was synced`);
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !['allow', 'follow', 'depth', 'deny'].includes(key));
  if (unknown !== undefined) throw new CliError(1, `${where}: unknown key "${unknown}" (it holds allow, follow, depth and deny); nothing was synced`);
  const list = (field: 'allow' | 'follow' | 'deny'): string[] => {
    const value = record[field] ?? [];
    if (!Array.isArray(value)) throw new CliError(1, `${where}: "${field}" is a list of paths; nothing was synced`);
    return value.map((entry) => checkPattern(entry, field));
  };
  const depth = record.depth ?? 1;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > MAX_DEPTH) {
    throw new CliError(1, `${where}: "depth" is a whole number from 0 to ${MAX_DEPTH}; nothing was synced`);
  }
  return { allow: list('allow'), follow: list('follow'), depth, deny: list('deny') };
}

/** The workspace's scope, or null when it has none. */
export function readScope(root: string): Scope | null {
  const bytes = readStateFile(root, SCOPE_FILE);
  return bytes ? parseScope(bytes.toString('utf8')) : null;
}

/** One glob segment against one path segment: `*` any run of characters, `?` one. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      mark = t;
      p += 1;
    } else if (star >= 0) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** Whole-path glob over segments, `**` matching any number of them (memoized, so linear in their product). */
function globMatches(pattern: string[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const at = (p: number, s: number): boolean => {
    const key = p * (path.length + 1) + s;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    if (p === pattern.length) result = s === path.length;
    else if (pattern[p] === '**') result = at(p + 1, s) || (s < path.length && at(p, s + 1));
    else result = s < path.length && segmentMatches(pattern[p]!, path[s]!) && at(p + 1, s + 1);
    memo.set(key, result);
    return result;
  };
  return at(0, 0);
}

const fold = (text: string) => text.normalize('NFC').toLowerCase();
const segments = (rel: string) => rel.split(/[\\/]/).filter((part) => part !== '');

/** Whether `pattern` matches `rel` or a folder above it. */
function covers(pattern: string, rel: string, insensitive: boolean): boolean {
  const pat = segments(insensitive ? fold(pattern) : pattern.normalize('NFC'));
  const path = segments(insensitive ? fold(rel) : rel.normalize('NFC'));
  for (let end = 1; end <= path.length; end += 1) if (globMatches(pat, path.slice(0, end))) return true;
  return false;
}

/** A moss note's folder (`<Title>/<Title>.md`), or the file itself for any other note. */
export function noteUnit(rel: string): string {
  const dir = dirname(rel);
  return dir !== '.' && basename(dir) === basename(rel, extname(rel)) ? dir : rel;
}

/** A title as moss names its folder, compared without case: no `< > : " / \ | ? *` or controls, spaces collapsed. */
function titleKey(title: string): string {
  let out = '';
  for (const char of title.normalize('NFC')) {
    if ('<>:"/\\|?*'.includes(char) || char.charCodeAt(0) <= 0x1f) continue;
    out += char;
  }
  return out.split(/\s/).filter(Boolean).join(' ').toLowerCase();
}

const NOTE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

interface LinkTarget { title?: string; id?: string; path?: string }

/** A wiki link's inside: `Title`, `Title#Heading`, `Title|alias`, `Title|<note id>` (the last `|` splits). */
function wikiTarget(inner: string): LinkTarget | null {
  const bar = inner.lastIndexOf('|');
  let title = bar >= 0 ? inner.slice(0, bar) : inner;
  const suffix = bar >= 0 ? inner.slice(bar + 1).trim() : '';
  for (let i = 0; i < title.length; i += 1) {
    if (title[i] === '\\') i += 1;
    else if (title[i] === '#') {
      title = title.slice(0, i);
      break;
    }
  }
  title = title.split('\\#').join('#').trim();
  const id = NOTE_ID.test(suffix) ? suffix : undefined;
  if (!title && !id) return null;
  return { ...(title ? { title } : {}), ...(id ? { id } : {}) };
}

/** Every note link in `text`: wiki links, and relative markdown links resolved against the note's folder. */
export function noteLinks(text: string, from: string): LinkTarget[] {
  const out: LinkTarget[] = [];
  for (let at = text.indexOf('[['); at >= 0; at = text.indexOf('[[', at + 2)) {
    const end = text.indexOf(']]', at + 2);
    if (end < 0) break;
    const inner = text.slice(at + 2, end);
    if (inner.includes('\n')) continue;
    const target = wikiTarget(inner);
    if (target) out.push(target);
    at = end;
  }
  for (let at = text.indexOf(']('); at >= 0; at = text.indexOf('](', at + 2)) {
    let i = at + 2;
    const angled = text[i] === '<';
    if (angled) i += 1;
    let end = i;
    while (end < text.length && (angled ? text[end] !== '>' : !' \t\n)'.includes(text[end]!)) && text[end] !== '\n') end += 1;
    let target = text.slice(i, end);
    const cut = [target.indexOf('#'), target.indexOf('?')].filter((index) => index >= 0);
    if (cut.length) target = target.slice(0, Math.min(...cut));
    if (!target || target.startsWith('/') || SCHEME.test(target)) continue;
    try {
      target = decodeURIComponent(target);
    } catch {
      // A stray % stays as it is.
    }
    const path = normalize(join(dirname(from), target));
    if (path === '..' || path.startsWith(`..${sep}`) || path === '.') continue;
    out.push({ path: segments(path).join(sep) });
  }
  return out;
}

/** Which workspace files are in scope this pass. */
export interface ScopeView {
  /** Whether a note at `rel` (there or not yet) may be synced. */
  admits(rel: string): boolean;
  /** How many of the scanned files are out of scope. */
  outOfScope: number;
}

/**
 * Evaluates `scope` over the scanned `files` and the `tracked` files (a tracked file deleted here still resolves, so it
 * comes back). Only entry notes and the notes they reach are read, for their links; a denied note is never read, and
 * an out-of-scope moss note only for its `meta.json` id and title.
 */
export function evaluateScope(root: string, scope: Scope, files: string[], tracked: { file: string; title?: string }[], folds: boolean): ScopeView {
  const key = (rel: string) => (folds ? fold(rel) : rel.normalize('NFC'));
  // Deny compares without case always: a denied folder must not slip through spelt otherwise.
  const denied = (rel: string) => scope.deny.some((pattern) => covers(pattern, rel, true));
  const allowed = (rel: string) => scope.allow.some((pattern) => covers(pattern, rel, folds));

  const notes = new Map<string, { file: string; unit: string }>();
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, Set<string>>();
  const byId = new Map<string, string>();
  const addTitle = (title: string, file: string) => {
    const k = titleKey(title);
    if (!k) return;
    if (!byTitle.has(k)) byTitle.set(k, new Set());
    byTitle.get(k)!.add(file);
  };
  const candidates = [...files, ...tracked.map((meta) => meta.file)];
  for (const file of candidates) {
    if (denied(file) || notes.has(key(file))) continue;
    const unit = noteUnit(file);
    notes.set(key(file), { file, unit });
    byPath.set(key(file), file);
    byPath.set(key(unit), file);
    if (unit === file) byPath.set(key(file.slice(0, -extname(file).length)), file);
    addTitle(basename(unit, unit === file ? extname(file) : ''), file);
    if (unit !== file) {
      try {
        const meta = JSON.parse(readConfined(root, join(unit, 'meta.json')).toString('utf8')) as { id?: unknown; title?: unknown };
        if (typeof meta.id === 'string' && NOTE_ID.test(meta.id)) byId.set(meta.id.toLowerCase(), file);
        if (typeof meta.title === 'string') addTitle(meta.title, file);
      } catch {
        // No meta.json, or not one moss wrote.
      }
    }
  }
  for (const meta of tracked) if (meta.title && notes.has(key(meta.file))) addTitle(meta.title, meta.file);

  const resolvePath = (path: string): string[] => {
    const found = byPath.get(key(path)) ?? byPath.get(key(path.replace(/\.md$/i, '')));
    return found ? [found] : [];
  };
  const resolveTitle = (title: string): string[] => {
    const plain = title.replace(/\.md$/i, '');
    const found = byTitle.get(titleKey(title)) ?? byTitle.get(titleKey(plain));
    if (found) return [...found];
    return title.includes('/') ? resolvePath(normalize(plain)) : [];
  };
  const resolve = (target: LinkTarget): string[] => {
    if (target.id) {
      const found = byId.get(target.id.toLowerCase());
      if (found) return [found];
    }
    if (target.path !== undefined) return resolvePath(target.path);
    return target.title ? resolveTitle(target.title) : [];
  };

  const inScope = new Set<string>();
  for (const file of candidates) if (!denied(file) && allowed(file)) inScope.add(key(file));
  // An entry is a note's folder or file; failing that, a note's title.
  let frontier: string[] = [];
  const seen = new Set<string>();
  for (const entry of scope.follow) {
    const path = segments(entry).join(sep);
    const found = resolvePath(path);
    for (const file of found.length ? found : resolveTitle(entry)) {
      inScope.add(key(file));
      if (!seen.has(key(file))) {
        seen.add(key(file));
        frontier.push(file);
      }
    }
  }
  for (let hop = 0; hop < scope.depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      let text: string;
      try {
        text = readConfined(root, file).toString('utf8');
      } catch {
        continue;
      }
      for (const target of noteLinks(text, file)) {
        for (const linked of resolve(target)) {
          inScope.add(key(linked));
          if (!seen.has(key(linked))) {
            seen.add(key(linked));
            next.push(linked);
          }
        }
      }
    }
    frontier = next;
  }

  return {
    admits: (rel) => !denied(rel) && (inScope.has(key(rel)) || allowed(rel)),
    outOfScope: files.filter((file) => denied(file) || !inScope.has(key(file))).length,
  };
}

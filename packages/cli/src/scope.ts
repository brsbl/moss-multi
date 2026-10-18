// A workspace scope (`.moss-multi/scope.json`): which notes sync may adopt, pull and push. `allow` lists note folders
// or path globs; `follow` lists entry notes whose links (moss wiki links by title or id, and relative markdown links)
// bring the notes they reach into scope, `depth` hops out, re-read every pass; `deny` lists paths or globs that are
// never synced and win over both. A moss note is a folder (`<Title>/<Title>.md`), so a pattern matching the note's
// folder, or any folder above it, matches the note. Without the file every note is in scope.
//
// Remote text never widens what is uploaded: a link counts for uploading only when it was written here, that is it is
// in the note's file and was not in the text last pulled, or `init --scope` / `scope confirm` recorded it
// (`.moss-multi/scope-links.json`). A note reached only through a link that came in a pull may be pulled, never sent.
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { CliError } from './errors.ts';
import { readBase, readConfined, readStateFile } from './workspace.ts';

export const SCOPE_FILE = 'scope.json';
export const LINKS_FILE = 'scope-links.json';
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

/** The links written here, per note: anything unreadable is no link, so it can only narrow what is uploaded. */
export type Confirmed = Record<string, string[]>;

export function readConfirmed(root: string): Confirmed {
  try {
    const parsed = JSON.parse(readStateFile(root, LINKS_FILE)?.toString('utf8') ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Confirmed = {};
    for (const [note, links] of Object.entries(parsed)) if (Array.isArray(links)) out[note] = links.filter((link): link is string => typeof link === 'string');
    return out;
  } catch {
    return {};
  }
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

/** `text` without fenced code blocks and code spans, where moss shows link syntax as text. */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = null;
      kept.push('');
    } else if (mark) {
      fence = mark;
      kept.push('');
    } else kept.push(line);
  }
  return withoutSpans(kept.join('\n'));
}

/** `text` without code spans: a backtick run up to the next run of the same length (an unclosed run is text). */
function withoutSpans(text: string): string {
  const runEnd = (at: number) => {
    let end = at;
    while (text[end] === '`') end += 1;
    return end;
  };
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('`', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    const after = runEnd(open);
    let close = -1;
    for (let at = text.indexOf('`', after); at >= 0; at = text.indexOf('`', runEnd(at))) {
      if (runEnd(at) - at === after - open) {
        close = runEnd(at);
        break;
      }
    }
    if (close < 0) {
      out += text.slice(open, after);
      i = after;
    } else {
      out += ' ';
      i = close;
    }
  }
  return out;
}

/** Every note link in `source`: wiki links, and relative markdown links resolved against the note's folder; none in code. */
export function noteLinks(source: string, from: string): LinkTarget[] {
  const text = withoutCode(source);
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
    while (end < text.length && text[end] !== (angled ? '>' : ')') && text[end] !== '\n') end += 1;
    let target = text.slice(i, end);
    // A link title follows the path after a space; the path itself may hold spaces (`../Reading list/Reading list.md`).
    if (!angled) {
      const titled = [' "', " '", ' ('].map((mark) => target.indexOf(mark)).filter((index) => index >= 0);
      if (titled.length) target = target.slice(0, Math.min(...titled));
      target = target.trim();
    }
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
  /** Whether a note at `rel` (there or not yet) may be synced: pulled, and sent unless `uploads` says otherwise. */
  admits(rel: string): boolean;
  /** Whether a note at `rel` may be sent: in scope through `allow`, `follow` or links written here. */
  uploads(rel: string): boolean;
  /** Whether `rel` (a note, or a file inside its folder) is denied. */
  denies(rel: string): boolean;
  /** How many of the scanned files are out of scope. */
  outOfScope: number;
}

export interface ScopeInput {
  /** The scanned `.md` files. */
  files: string[];
  /** The tracked files (a tracked file deleted here still resolves, so it comes back). */
  tracked: { file: string; docId: string; title?: string }[];
  folds: boolean;
  /** The links recorded as written here; null records every link the notes reached hold now (`scope confirm`). */
  confirmed: Confirmed | null;
}

/**
 * Evaluates `scope` over the workspace. Only entry notes and the notes they reach are read, for their links; a denied
 * note is never read, and an out-of-scope moss note only for its `meta.json` id and title. Returns the view and the
 * links recorded as written here after this read (`changed` when they differ from `input.confirmed`).
 */
export function evaluateScope(root: string, scope: Scope, input: ScopeInput): { view: ScopeView; confirmed: Confirmed; changed: boolean } {
  const { files, tracked, folds } = input;
  const key = (rel: string) => (folds ? fold(rel) : rel.normalize('NFC'));
  // Deny compares without case always: a denied folder must not slip through spelt otherwise.
  const denied = (rel: string) => scope.deny.some((pattern) => covers(pattern, rel, true));
  const allowed = (rel: string) => scope.allow.some((pattern) => covers(pattern, rel, folds));

  const notes = new Map<string, { file: string; unit: string }>();
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, Set<string>>();
  // Titles the server gave tracked docs: remote text, so they resolve links for pulling only.
  const byServerTitle = new Map<string, Set<string>>();
  const byId = new Map<string, string>();
  const addTitle = (map: Map<string, Set<string>>, title: string, file: string) => {
    const k = titleKey(title);
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(file);
  };
  const candidates = [...files, ...tracked.map((meta) => meta.file)];
  for (const file of candidates) {
    if (denied(file) || notes.has(key(file))) continue;
    const unit = noteUnit(file);
    notes.set(key(file), { file, unit });
    byPath.set(key(file), file);
    byPath.set(key(unit), file);
    if (unit === file) byPath.set(key(file.slice(0, -extname(file).length)), file);
    addTitle(byTitle, basename(unit, unit === file ? extname(file) : ''), file);
    if (unit !== file) {
      try {
        const meta = JSON.parse(readConfined(root, join(unit, 'meta.json')).toString('utf8')) as { id?: unknown; title?: unknown };
        if (typeof meta.id === 'string' && NOTE_ID.test(meta.id)) byId.set(meta.id.toLowerCase(), file);
        if (typeof meta.title === 'string') addTitle(byTitle, meta.title, file);
      } catch {
        // No meta.json, or not one moss wrote.
      }
    }
  }
  for (const meta of tracked) if (meta.title && notes.has(key(meta.file))) addTitle(byServerTitle, meta.title, meta.file);

  const resolvePath = (path: string): string[] => {
    const found = byPath.get(key(path)) ?? byPath.get(key(path.replace(/\.md$/i, '')));
    return found ? [found] : [];
  };
  const resolveTitle = (title: string, local: boolean): string[] => {
    const plain = title.replace(/\.md$/i, '');
    const found = new Set([...(byTitle.get(titleKey(title)) ?? byTitle.get(titleKey(plain)) ?? [])]);
    if (!local) for (const file of byServerTitle.get(titleKey(title)) ?? byServerTitle.get(titleKey(plain)) ?? []) found.add(file);
    if (found.size) return [...found];
    return title.includes('/') ? resolvePath(normalize(plain)) : [];
  };
  const resolve = (target: LinkTarget, local: boolean): string[] => {
    if (target.id) {
      const found = byId.get(target.id.toLowerCase());
      if (found) return [found];
    }
    if (target.path !== undefined) return resolvePath(target.path);
    return target.title ? resolveTitle(target.title, local) : [];
  };
  const linkKey = (target: LinkTarget): string =>
    target.path !== undefined ? `path:${key(segments(target.path).join('/'))}` : `wiki:${target.id?.toLowerCase() ?? ''}:${titleKey(target.title ?? '')}`;

  // Each note's links as its file holds them, and which of them were written here.
  const before = input.confirmed;
  const confirmed = new Map(Object.entries(before ?? {}));
  const read = new Map<string, { links: { target: LinkTarget; key: string }[]; local: Set<string> } | null>();
  const tracking = new Map(tracked.map((meta) => [key(meta.file), meta.docId]));
  const linksOf = (file: string) => {
    if (read.has(key(file))) return read.get(key(file)) ?? null;
    let found: { links: { target: LinkTarget; key: string }[]; local: Set<string> } | null = null;
    try {
      const links = noteLinks(readConfined(root, file).toString('utf8'), file).map((target) => ({ target, key: linkKey(target) }));
      const now = new Set(links.map((link) => link.key));
      let local: Set<string>;
      if (!before) local = now;
      else {
        // Written here: in the file and not in the text last pulled (an untracked file was never pulled).
        const docId = tracking.get(key(file));
        let pulled = new Set<string>();
        if (docId) {
          try {
            pulled = new Set(noteLinks(Buffer.from(readBase(root, docId)).toString('utf8'), file).map(linkKey));
          } catch {
            // No base: every link counts as pulled, the narrow side.
            pulled = now;
          }
        }
        local = new Set([...(before[key(file)] ?? [])].filter((link) => now.has(link)));
        for (const link of now) if (!pulled.has(link)) local.add(link);
      }
      if (local.size) confirmed.set(key(file), [...local].sort());
      else confirmed.delete(key(file));
      found = { links, local };
    } catch {
      // Unreadable: no links.
    }
    read.set(key(file), found);
    return found;
  };

  /** The notes in scope, following every link or only links written here. */
  const reach = (localOnly: boolean): Set<string> => {
    const inScope = new Set<string>();
    for (const file of candidates) if (!denied(file) && allowed(file)) inScope.add(key(file));
    // An entry is a note's folder or file; failing that, a note's title.
    let frontier: string[] = [];
    const seen = new Set<string>();
    for (const entry of scope.follow) {
      const found = resolvePath(segments(entry).join(sep));
      for (const file of found.length ? found : resolveTitle(entry, true)) {
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
        const note = linksOf(file);
        if (!note) continue;
        for (const link of note.links) {
          if (localOnly && !note.local.has(link.key)) continue;
          for (const linked of resolve(link.target, localOnly)) {
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
    return inScope;
  };
  const anyLink = reach(false);
  const localLink = reach(true);

  const after = Object.fromEntries([...confirmed].sort(([a], [b]) => a.localeCompare(b)));
  const changed = JSON.stringify(after) !== JSON.stringify(before ?? {});
  return {
    view: {
      admits: (rel) => !denied(rel) && (anyLink.has(key(rel)) || allowed(rel)),
      uploads: (rel) => !denied(rel) && (localLink.has(key(rel)) || allowed(rel)),
      denies: denied,
      outOfScope: files.filter((file) => denied(file) || !anyLink.has(key(file))).length,
    },
    confirmed: after,
    changed,
  };
}

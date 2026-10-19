// A workspace scope (`.moss-multi/scope.json`): which notes sync may upload and pull. Only `allow` (note folders, files
// or path globs) authorizes an upload: adopting a note or pushing its edits. `follow` lists entry notes whose links
// (moss wiki links by title or id, and relative markdown links) reach other notes, `depth` hops out, re-read every
// pass; those notes are download only, since a link may have come from the server, until `moss-multi scope confirm`
// writes them into `allow` as exact paths. `deny` lists paths or globs that are never synced and win over both. A
// moss note is a folder (`<Title>/<Title>.md`), so a pattern matching the note's folder, or any folder above it,
// matches the note. Without the file every note is in scope.
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { CliError } from './errors.ts';
import { frontmatterOf, hasMarkers, parseMoss } from './moss-format.ts';
import { type DocMeta, readBase, readConfined, readStateFile } from './workspace.ts';

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
  // The next `]]` and line break at or after the scan point, each found once and reused, so the scan stays linear.
  let close = -1;
  let eol = -1;
  for (let at = text.indexOf('[['); at >= 0; at = text.indexOf('[[', at + 2)) {
    if (close < at + 2) close = text.indexOf(']]', at + 2);
    if (close < 0) break;
    if (eol < at + 2) eol = text.indexOf('\n', at + 2);
    if (eol < 0) eol = text.length;
    if (eol < close) continue;
    const target = wikiTarget(text.slice(at + 2, close));
    if (target) out.push(target);
    at = close;
  }
  // Where the last scan for each closing mark stopped (at it, a line break or the end): a scan starting before that
  // stops there too, so the scan stays linear.
  const stopped: Record<string, number> = { '>': -1, ')': -1 };
  for (let at = text.indexOf(']('); at >= 0; at = text.indexOf('](', at + 2)) {
    let i = at + 2;
    const angled = text[i] === '<';
    if (angled) i += 1;
    const mark = angled ? '>' : ')';
    let end = i <= stopped[mark]! ? stopped[mark]! : i;
    while (end < text.length && text[end] !== mark && text[end] !== '\n') end += 1;
    stopped[mark] = end;
    // An unclosed link is not a link.
    if (text[end] !== mark) continue;
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

const lf = (text: string) => text.replace(/\r\n?/g, '\n');

/** Where a note's links are read: a moss file without its title line and markers, past any frontmatter. */
function linkSource(text: string, moss: boolean): string {
  const body = moss ? parseMoss(lf(text)).clean : lf(text);
  return body.slice(frontmatterOf(body).length);
}

/** Whether a note is kept in moss form: a tracked note by its mode, any other by moss's layout or markers. */
const isMoss = (meta: DocMeta | undefined, rel: string, text: string) => (meta ? meta.mode === 'moss' : noteUnit(rel) !== rel || hasMarkers(text));

/** A path or glob holding glob syntax, which `scope confirm` cannot write as an exact allow entry. */
const GLOB = /[*?]/;

/** Which workspace files are in scope this pass. */
export interface ScopeView {
  /** Whether a note at `rel` (there or not yet) may be pulled: allowed, or reached through `follow`. */
  admits(rel: string): boolean;
  /** Whether a note at `rel` may be sent (adopted or pushed): only an `allow` entry authorizes that. */
  uploads(rel: string): boolean;
  /** Whether the media file `asset` of note `file` may be read and sent: the note uploads, and the file is its own or allowed. */
  sendsAsset(file: string, asset: string): boolean;
  /** Whether `rel` (a note, or a file inside its folder) is denied. */
  denies(rel: string): boolean;
  /** The local notes `follow` reaches that `allow` does not cover (download only until `scope confirm`). */
  followed: Followed[];
  /** How many of the scanned files are out of scope. */
  outOfScope: number;
}

/** A note `follow` reaches that `allow` does not cover. */
export interface Followed {
  file: string;
  title: string;
  /** The notes whose links reach it (none for a `follow` entry itself). */
  from: string[];
  /** A link reaching it is also in its note's base, the text last synced: it may have come from the server. */
  synced: boolean;
}

export interface ScopeInput {
  /** The scanned `.md` files. */
  files: string[];
  /** The tracked docs (a tracked file deleted here still resolves, so it comes back). */
  tracked: DocMeta[];
  folds: boolean;
}

/**
 * Evaluates `scope` over the workspace. Only entry notes and the notes they reach are read, for their links; a denied
 * note is never read, and an out-of-scope moss note only for its `meta.json` id and title. Paths compare as the
 * volume resolves them: NFC, and without case only where it folds case.
 */
export function evaluateScope(root: string, scope: Scope, input: ScopeInput): ScopeView {
  const { files, tracked, folds } = input;
  const key = (rel: string) => (folds ? fold(rel) : rel.normalize('NFC'));
  const denied = (rel: string) => scope.deny.some((pattern) => covers(pattern, rel, folds));
  const allowed = (rel: string) => scope.allow.some((pattern) => covers(pattern, rel, folds));

  const byPath = new Map<string, string>();
  const byTitle = new Map<string, Set<string>>();
  const byId = new Map<string, string>();
  const addTitle = (title: string, file: string) => {
    const k = titleKey(title);
    if (!k) return;
    if (!byTitle.has(k)) byTitle.set(k, new Set());
    byTitle.get(k)!.add(file);
  };
  const trackedBy = new Map(tracked.map((meta) => [key(meta.file), meta]));
  const candidates = [...files, ...tracked.map((meta) => meta.file)];
  const known = new Set<string>();
  for (const file of candidates) {
    if (denied(file) || known.has(key(file))) continue;
    known.add(key(file));
    const unit = noteUnit(file);
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

  const resolvePath = (path: string): string[] => {
    const found = byPath.get(key(path)) ?? byPath.get(key(path.replace(/\.md$/i, '')));
    return found ? [found] : [];
  };
  const resolveTitle = (title: string): string[] => {
    const plain = title.replace(/\.md$/i, '');
    const found = [...(byTitle.get(titleKey(title)) ?? byTitle.get(titleKey(plain)) ?? [])];
    // Moss opens one note for a title: of several, the one already synced, else none.
    if (found.length > 1) {
      const synced = found.filter((file) => trackedBy.has(key(file)));
      return synced.length === 1 ? synced : [];
    }
    if (found.length) return found;
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
  const linksOf = (file: string): LinkTarget[] => {
    try {
      const text = readConfined(root, file).toString('utf8');
      return noteLinks(linkSource(text, isMoss(trackedBy.get(key(file)), file, text)), file);
    } catch {
      return [];
    }
  };

  // Follow: the entries (a note's folder or file, failing that its title) and the notes their links reach, depth hops out.
  const reached = new Map<string, string>();
  const reachedFrom = new Map<string, Set<string>>();
  let frontier: string[] = [];
  const visit = (file: string, next: string[], from?: string) => {
    if (from !== undefined) {
      if (!reachedFrom.has(key(file))) reachedFrom.set(key(file), new Set());
      reachedFrom.get(key(file))!.add(from);
    }
    if (reached.has(key(file))) return;
    reached.set(key(file), file);
    next.push(file);
  };
  for (const entry of scope.follow) {
    const found = resolvePath(segments(entry).join(sep));
    for (const file of found.length ? found : resolveTitle(entry)) visit(file, frontier);
  }
  for (let hop = 0; hop < scope.depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const file of frontier) for (const link of linksOf(file)) for (const linked of resolve(link)) visit(linked, next, file);
    frontier = next;
  }

  /** Whether tracked note `from`'s base links to `file`; an unreadable base counts as yes. */
  const syncedLink = (from: string, file: string): boolean => {
    const meta = trackedBy.get(key(from));
    if (!meta) return false;
    try {
      const base = Buffer.from(readBase(root, meta.docId)).toString('utf8');
      return noteLinks(linkSource(base, false), from).some((link) => resolve(link).some((found) => key(found) === key(file)));
    } catch {
      return true;
    }
  };

  const uploads = (rel: string) => !denied(rel) && allowed(rel);
  const admits = (rel: string) => uploads(rel) || (!denied(rel) && reached.has(key(rel)));
  const onDisk = new Set(files.map(key));
  return {
    admits,
    uploads,
    // A moss note's own folder holds its media; a folder plain notes share needs the file itself allowed.
    sendsAsset: (file, asset) => {
      if (!uploads(file) || denied(asset)) return false;
      const unit = noteUnit(file);
      return allowed(asset) || (unit !== file && key(asset).startsWith(`${key(unit)}${sep}`));
    },
    denies: denied,
    get followed() {
      return [...reached.values()].filter((file) => onDisk.has(key(file)) && !uploads(file) && !denied(file)).sort().map((file) => {
        const from = [...(reachedFrom.get(key(file)) ?? [])].sort();
        const unit = noteUnit(file);
        return { file, title: basename(unit, unit === file ? extname(file) : ''), from, synced: from.some((note) => syncedLink(note, file)) };
      });
    },
    outOfScope: files.filter((file) => !admits(file)).length,
  };
}

/** A workspace path as `scope.json` and `scope confirm` spell it: `/`-separated. */
export const scopePath = (rel: string): string => segments(rel).join('/');

/** Whether `scope confirm` can write `path` as an exact allow entry: glob syntax in it would match other paths. */
export const exactPattern = (path: string): boolean => !GLOB.test(path);

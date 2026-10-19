// A workspace scope (`.moss-multi/scope.json`): which notes sync may adopt, pull and push. `allow` lists note folders
// or path globs; `follow` lists entry notes whose links (moss wiki links by title or id, and relative markdown links)
// bring the notes they reach into scope, `depth` hops out, re-read every pass; `deny` lists paths or globs that are
// never synced and win over both. A moss note is a folder (`<Title>/<Title>.md`), so a pattern matching the note's
// folder, or any folder above it, matches the note. Without the file every note is in scope.
//
// Remote text never widens what is uploaded. Before server text is written into a note's file, the links and media
// references it brings that the file did not hold are recorded as remote for that doc (`.moss-multi/<docId>/remote.json`),
// so a crash after the write cannot pass them off as written here. A link or media reference counts for uploading
// only when it is in the note's body and not recorded as remote; `init --scope` and `scope confirm` clear the
// records. Links are read from the body in the server's form on both sides: a moss note's title line and any
// frontmatter never hold one. A note reached only through a remote link may be pulled, never sent.
import { basename, dirname, extname, join, normalize, sep } from 'node:path';
import { CliError } from './errors.ts';
import { mediaRefs } from './media.ts';
import { frontmatterOf, hasMarkers, parseMoss } from './moss-format.ts';
import { type DocMeta, readBase, readConfined, readRemoteKeys, readStateFile, writeRemoteKeys } from './workspace.ts';

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

/** A link's identity for provenance, the same however its path is cased. */
const linkKey = (target: LinkTarget): string =>
  target.path !== undefined ? `path:${fold(segments(target.path).join('/'))}` : `wiki:${target.id?.toLowerCase() ?? ''}:${titleKey(target.title ?? '')}`;
const assetKey = (name: string) => `asset:${fold(name)}`;
const lf = (text: string) => text.replace(/\r\n?/g, '\n');
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

/** A note's body in the server's form: a moss file without its title line and markers, any other file as it is. */
const bodyOf = (text: string, moss: boolean): string => (moss ? parseMoss(lf(text)).clean : lf(text));
/** A body past its frontmatter, where links and media references are read. */
const pastFrontmatter = (body: string) => body.slice(frontmatterOf(body).length);

/** Every link and media reference in a body (server form), as provenance keys. */
function keysOf(body: string, from: string): Set<string> {
  const rest = pastFrontmatter(body);
  const keys = new Set(noteLinks(rest, from).map(linkKey));
  for (const ref of mediaRefs(rest)) keys.add(assetKey(ref.name));
  return keys;
}

/** Whether a note is kept in moss form: a tracked note by its mode, any other by moss's layout or markers. */
const isMoss = (meta: DocMeta | undefined, rel: string, text: string) => (meta ? meta.mode === 'moss' : noteUnit(rel) !== rel || hasMarkers(text));

/** The doc's remote keys: its record, or failing that all its base holds; null when neither can be read. */
function remoteOf(root: string, docId: string, from: string): Set<string> | null {
  const recorded = readRemoteKeys(root, docId);
  if (recorded) return recorded;
  try {
    return keysOf(lf(utf8(readBase(root, docId))), from);
  } catch {
    return null;
  }
}

/** The links and media references written here in note `file` holding `text`: an untracked note was never pulled. */
export function writtenHere(root: string, meta: DocMeta | undefined, file: string, text: string): Set<string> {
  const now = keysOf(bodyOf(text, isMoss(meta, file, text)), file);
  if (!meta) return now;
  const remote = remoteOf(root, meta.docId, file);
  return remote ? new Set([...now].filter((key) => !remote.has(key))) : new Set();
}

/** Which media files tracked note `meta` (holding `text`) may read and send: those whose reference was written here. */
export function sendsMedia(root: string, meta: DocMeta, text: string): (name: string) => boolean {
  const mine = writtenHere(root, meta, meta.file, text);
  return (name) => mine.has(assetKey(name));
}

/**
 * Records, before server text is written into note `rel` of doc `docId`, which of its links and media references came
 * from the server: those the file does not hold (a missing file stands on its base) and those already recorded.
 */
export function recordIncoming(root: string, docId: string, rel: string, server: Uint8Array, moss: boolean): void {
  const incoming = keysOf(lf(utf8(server)), rel);
  const old = remoteOf(root, docId, rel);
  let held: Set<string>;
  try {
    held = keysOf(bodyOf(readConfined(root, rel).toString('utf8'), moss), rel);
  } catch {
    try {
      held = keysOf(lf(utf8(readBase(root, docId))), rel);
    } catch {
      held = new Set();
    }
  }
  writeRemoteKeys(root, docId, [...incoming].filter((key) => !held.has(key) || old === null || old.has(key)));
}

/** Takes every link and media reference doc `docId`'s file holds now as written here (adoption, `scope confirm`). */
export const clearRemote = (root: string, docId: string): void => writeRemoteKeys(root, docId, []);

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
  /** The tracked docs (a tracked file deleted here still resolves, so it comes back). */
  tracked: DocMeta[];
  folds: boolean;
}

/**
 * Evaluates `scope` over the workspace. Only entry notes and the notes they reach are read, for their links; a denied
 * note is never read, and an out-of-scope moss note only for its `meta.json` id and title.
 */
export function evaluateScope(root: string, scope: Scope, input: ScopeInput): ScopeView {
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
  const trackedBy = new Map(tracked.map((meta) => [key(meta.file), meta]));
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
    // Moss opens one note for a title: of several, the one already synced, else none.
    if (found.size > 1) {
      const synced = [...found].filter((file) => trackedBy.has(key(file)));
      return synced.length === 1 ? synced : [];
    }
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

  // Each note's links as its body holds them, and which of them were written here.
  const read = new Map<string, { links: { target: LinkTarget; key: string }[]; local: Set<string> } | null>();
  const linksOf = (file: string) => {
    if (read.has(key(file))) return read.get(key(file)) ?? null;
    let found: { links: { target: LinkTarget; key: string }[]; local: Set<string> } | null = null;
    try {
      const text = readConfined(root, file).toString('utf8');
      const meta = trackedBy.get(key(file));
      const links = noteLinks(pastFrontmatter(bodyOf(text, isMoss(meta, file, text))), file).map((target) => ({ target, key: linkKey(target) }));
      found = { links, local: writtenHere(root, meta, file, text) };
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
  return {
    admits: (rel) => !denied(rel) && (anyLink.has(key(rel)) || allowed(rel)),
    uploads: (rel) => !denied(rel) && (localLink.has(key(rel)) || allowed(rel)),
    denies: denied,
    outOfScope: files.filter((file) => denied(file) || !anyLink.has(key(file))).length,
  };
}

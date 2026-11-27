// Pure helpers for the search index (A§5.3; ported from glyphdown's search-core.ts). Engine-agnostic: the FTS5 path
// uses buildFtsMatch and bm25, the LIKE fallback scoreEntry, and both snippet through makeSnippet. No I/O.
import { slug } from '@moss-multi/core/filenames';

/** The one index's name (A§5.3): SearchDO('global'). */
export const SEARCH_DO_NAME = 'global';

/**
 * The inside of each `[[Target]]`, `[[Target|noteId]]`, `[[Target#Heading]]`, never an embed (`![[img.png]]`): what
 * `/(?<!!)\[\[([^\]]+)\]\]/g` captures, scanned in linear time, since a run of `[` with no `]` makes that regex quadratic.
 */
function* wikiLinkContents(body: string): Generator<string> {
  let close = -1;
  for (let i = body.indexOf('[['); i !== -1; ) {
    if (i > 0 && body[i - 1] === '!') {
      i = body.indexOf('[[', i + 1);
      continue;
    }
    if (close < i + 2) close = body.indexOf(']', i + 2);
    if (close === -1) return;
    if (close > i + 2 && body[close + 1] === ']') {
      yield body.slice(i + 2, close);
      i = body.indexOf('[[', close + 2);
    } else {
      i = body.indexOf('[[', i + 1);
    }
  }
}

/** moss's resolved-link suffix (markdown/transformers.ts at the pin): a UUID after the last pipe names the note. */
const NOTE_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** The key of a link that names its target by id; a doc is also matched by it, so a rename or a twin title can't move it. */
export const idKey = (docId: string): string => `id:${docId.toLowerCase()}`;

/**
 * The key a wiki target and a doc are matched by: the title's slug, which is also how a filename stem is made (R3),
 * so `[[Launch Plan]]` meets a doc titled "Launch Plan" and a doc whose file is `launch-plan.md`.
 */
export const wikiKey = (raw: string): string => slug(raw);

/**
 * The distinct wiki keys a markdown body links to: `[[title|noteId]]` by its id (moss resolved it), any other link by
 * its title's slug. A non-UUID suffix is an alias, as in moss.
 */
export function extractWikiLinks(body: string): string[] {
  const out = new Set<string>();
  for (const inside of wikiLinkContents(body)) {
    const content = inside.trim();
    const pipe = content.lastIndexOf('|');
    const primary = pipe >= 0 ? content.slice(0, pipe) : content;
    const suffix = pipe >= 0 ? content.slice(pipe + 1).trim() : '';
    const title = primary.split(/(?<!\\)#/)[0].replace(/\\([#\\])/g, '$1').trim();
    if (title === '') continue;
    const key = NOTE_ID_RE.test(suffix) ? idKey(suffix) : wikiKey(title);
    if (key !== '') out.add(key);
  }
  return [...out];
}

/** Lowercased word tokens of a query. */
export function tokenizeQuery(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

/** A safe FTS5 MATCH: every token quoted (no user input is FTS syntax) with a prefix `*`, joined by AND. */
export function buildFtsMatch(query: string): string | null {
  const tokens = tokenizeQuery(query);
  return tokens.length === 0 ? null : tokens.map((token) => `"${token}"*`).join(' ');
}

/**
 * moss's snippet cleaning (ipc-handlers notes:search at the pin): structure out, inline markdown kept for NoteCard.
 * Comments, tags and links are scanned in linear time; moss's regexes are quadratic on openers with no closer.
 */
export function cleanForSnippet(body: string): string {
  return unwrapLinks(removeSpans(removeSpans(body, '<!--', '-->'), '<', '>'))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/---+/g, '')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text.replace(/<open>[\s\S]*?<close>/g, '')` in linear time; `<[^>]*>` is the same scan, as `>` ends it. */
function removeSpans(text: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (let i = text.indexOf(open); i !== -1; ) {
    const end = text.indexOf(close, i + open.length);
    // No close after this opener means none after any later one.
    if (end === -1) break;
    out += text.slice(from, i);
    from = end + close.length;
    i = text.indexOf(open, from);
  }
  return out + text.slice(from);
}

/** `text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')` in linear time. */
function unwrapLinks(text: string): string {
  let out = '';
  let from = 0;
  let close = -1;
  for (let i = text.indexOf('['); i !== -1; ) {
    if (close < i + 1) close = text.indexOf(']', i + 1);
    if (close === -1) break;
    if (text[close + 1] === '(') {
      const end = text.indexOf(')', close + 2);
      if (end === -1) break;
      out += text.slice(from, i) + text.slice(i + 1, close);
      from = end + 1;
      i = text.indexOf('[', from);
    } else {
      i = text.indexOf('[', i + 1);
    }
  }
  return out + text.slice(from);
}

/**
 * moss's snippet window: 20 characters before the match and 130 after, "..." at a clipped edge. The match is the
 * whole query when the text holds it, else the earliest token. A body with no match gives its head.
 */
export function makeSnippet(body: string, query: string): string {
  const cleaned = cleanForSnippet(body);
  const lower = cleaned.toLowerCase();
  const whole = query.trim().toLowerCase();
  let at = whole ? lower.indexOf(whole) : -1;
  let length = whole.length;
  if (at === -1) {
    length = 0;
    for (const token of tokenizeQuery(query)) {
      const i = lower.indexOf(token);
      if (i !== -1 && (at === -1 || i < at)) {
        at = i;
        length = token.length;
      }
    }
  }
  if (at === -1) return cleaned.length > 150 ? `${cleaned.slice(0, 150).trim()}...` : cleaned;
  const start = Math.max(0, at - 20);
  const end = Math.min(cleaned.length, at + length + 130);
  let snippet = cleaned.slice(start, end).trim();
  if (start > 0) snippet = `...${snippet}`;
  if (end < cleaned.length) snippet = `${snippet}...`;
  return snippet;
}

/** The LIKE fallback's rank: every token must appear; title hits dominate body hits. */
export function scoreEntry(title: string, body: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    const inTitle = occurrences(t, token);
    const inBody = occurrences(b, token);
    if (inTitle === 0 && inBody === 0) return 0;
    score += inTitle * 100 + inBody;
  }
  return score;
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count += 1;
  return count;
}

export interface HeadingInfo {
  level: 1 | 2 | 3 | 4;
  text: string;
}

/**
 * moss's stripWikiLinks (common/utils at the pin), `[[target|alias]]` to `target`, in linear time: its regex
 * `/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g` is quadratic on a run of `[` with no `]`.
 */
function stripWikiLinks(text: string): string {
  let out = '';
  let from = 0;
  let close = -1;
  // The first `|` from the current opener on: -2 before the first look, -1 once none is left.
  let pipe = -2;
  for (let i = text.indexOf('[['); i !== -1; ) {
    if (close < i + 2) close = text.indexOf(']', i + 2);
    if (close === -1) break;
    if (pipe !== -1 && pipe < i + 2) pipe = text.indexOf('|', i + 2);
    const stop = pipe !== -1 && pipe < close ? pipe : close;
    let end = -1;
    if (stop > i + 2) {
      if (stop === close) end = text[close + 1] === ']' ? close + 2 : -1;
      else end = close > stop + 1 && text[close + 1] === ']' ? close + 2 : -1;
    }
    if (end === -1) {
      i = text.indexOf('[[', i + 1);
      continue;
    }
    out += text.slice(from, i) + text.slice(i + 2, stop);
    from = end;
    i = text.indexOf('[[', from);
  }
  return out + text.slice(from);
}

/** moss's getHeadings (note-store at the pin): h1–h4 outside fenced code, wiki-link syntax stripped. */
export function parseHeadings(markdown: string): HeadingInfo[] {
  const outsideCode = markdown.replace(/```[\s\S]*?```/g, '');
  const headings: HeadingInfo[] = [];
  for (const match of outsideCode.matchAll(/^(#{1,4})\s+(.+)$/gm)) {
    headings.push({ level: match[1].length as HeadingInfo['level'], text: stripWikiLinks(match[2]).trim() });
  }
  return headings;
}

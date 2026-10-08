// Pure helpers for the search index (A§5.3; ported from glyphdown's search-core.ts). Engine-agnostic: the FTS5 path
// uses buildFtsMatch and bm25, the LIKE fallback scoreEntry, and both snippet through makeSnippet. No I/O.
import { stripWikiLinks } from '@moss-desktop/common/utils';
import { slug } from '@moss-multi/core/filenames';

/** The one index's name (A§5.3): SearchDO('global'). */
export const SEARCH_DO_NAME = 'global';

/**
 * The contents of `[[Target]]`, `[[Target|noteId]]`, `[[Target#Heading]]`; never an embed (`![[img.png]]`). What
 * `/(?<!!)\[\[([^\]]+)\]\]/g` matched, in one pass: a start whose first `]` doesn't close the link can't be followed by
 * one that does before that `]`, so the scan resumes after it (docs/METHOD.md).
 */
export function* wikiLinkContents(body: string): Generator<string> {
  let at = body.indexOf('[[');
  while (at !== -1) {
    if (at > 0 && body[at - 1] === '!') {
      at = body.indexOf('[[', at + 1);
      continue;
    }
    const close = body.indexOf(']', at + 2);
    if (close === -1) return;
    if (close > at + 2 && body[close + 1] === ']') {
      yield body.slice(at + 2, close);
      at = body.indexOf('[[', close + 2);
    } else {
      at = body.indexOf('[[', close + 1);
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
  for (const link of wikiLinkContents(body)) {
    const content = link.trim();
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

/** moss's snippet cleaning (ipc-handlers notes:search at the pin): structure out, inline markdown kept for NoteCard. */
export function cleanForSnippet(body: string): string {
  return linkTexts(withoutTags(body.replace(/<!--[\s\S]*?-->/g, '')))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/-{3,}/g, '')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `text.replace(/<[^>]*>/g, '')` in one pass: once a `<` has no `>` after it, no later one does. */
export function withoutTags(text: string): string {
  let out = '';
  let last = 0;
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', last)) {
    const close = text.indexOf('>', at + 1);
    if (close === -1) break;
    out += text.slice(last, at);
    last = close + 1;
  }
  return out + text.slice(last);
}

/**
 * `text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')` in one pass: every `[` before a start's first `]` shares that `]`,
 * so a start that fails there resumes after it, and once a `](` has no `)` after it, no later one does.
 */
export function linkTexts(text: string): string {
  let out = '';
  let last = 0;
  let at = text.indexOf('[');
  while (at !== -1) {
    const close = text.indexOf(']', at + 1);
    if (close === -1) break;
    if (text[close + 1] !== '(') {
      at = text.indexOf('[', close + 1);
      continue;
    }
    const end = text.indexOf(')', close + 2);
    if (end === -1) break;
    out += text.slice(last, at) + text.slice(at + 1, close);
    last = end + 1;
    at = text.indexOf('[', last);
  }
  return out + text.slice(last);
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

/** moss's getHeadings (note-store at the pin): h1–h4 outside fenced code, wiki-link syntax stripped. */
export function parseHeadings(markdown: string): HeadingInfo[] {
  const outsideCode = markdown.replace(/```[\s\S]*?```/g, '');
  const headings: HeadingInfo[] = [];
  for (const [hashes, text] of headingMatches(outsideCode)) {
    headings.push({ level: hashes.length as HeadingInfo['level'], text: stripWikiLinks(text).trim() });
  }
  return headings;
}

const isLineBreak = (char: string): boolean => char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029';
const SPACE = /\s/;

/**
 * The groups of `/^(#{1,4})\s+(.+)$/gm`, scanned line by line in linear time. As in the regex, the spaces may run
 * over line breaks, and spaces that run to the end leave their last non-break character as the text.
 */
export function headingMatches(text: string): [string, string][] {
  const out: [string, string][] = [];
  let line = 0;
  while (line <= text.length) {
    let next = -1;
    let hashes = line;
    while (text[hashes] === '#') hashes += 1;
    let space = hashes;
    if (hashes > line && hashes - line <= 4) while (space < text.length && SPACE.test(text[space]!)) space += 1;
    if (space > hashes) {
      if (space < text.length) {
        let end = space;
        while (end < text.length && !isLineBreak(text[end]!)) end += 1;
        out.push([text.slice(line, hashes), text.slice(space, end)]);
        next = end;
      } else {
        let last = text.length - 1;
        while (last > hashes && isLineBreak(text[last]!)) last -= 1;
        if (last > hashes) {
          out.push([text.slice(line, hashes), text[last]!]);
          next = last + 1;
        }
      }
    }
    // The next line starts after the next break at or after the match's end (or this line's start).
    let at = next === -1 ? line : next;
    while (at < text.length && !isLineBreak(text[at]!)) at += 1;
    if (at >= text.length) break;
    line = at + 1;
  }
  return out;
}

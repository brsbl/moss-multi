// Pure helpers for the search index (A§5.3; ported from glyphdown's search-core.ts). Engine-agnostic: the FTS5 path
// uses buildFtsMatch and bm25, the LIKE fallback scoreEntry, and both snippet through makeSnippet. No I/O.
import { stripWikiLinks } from '@moss-desktop/common/utils';
import { slug } from '@moss-multi/core/filenames';

/** The one index's name (A§5.3): SearchDO('global'). */
export const SEARCH_DO_NAME = 'global';

/** `[[Target]]`, `[[Target|noteId]]`, `[[Target#Heading]]`; never an embed (`![[img.png]]`) or a same-note `[[#H]]`. */
export const WIKI_LINK_RE = /(?<!!)\[\[([^\]]+)\]\]/g;

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
  for (const match of body.matchAll(WIKI_LINK_RE)) {
    const content = match[1].trim();
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
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/---+/g, '')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
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
  for (const match of outsideCode.matchAll(/^(#{1,4})\s+(.+)$/gm)) {
    headings.push({ level: match[1].length as HeadingInfo['level'], text: stripWikiLinks(match[2]).trim() });
  }
  return headings;
}

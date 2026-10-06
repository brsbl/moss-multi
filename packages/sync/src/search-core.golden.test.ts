// The linear scans in search-core give what moss's regexes give, byte for byte: over the real notes of the converter
// corpus and over random strings of the delimiters they scan. scripts/measure-converter.mjs holds them to linear cost.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stripWikiLinks } from '@moss-desktop/common/utils';
import { describe, expect, it } from 'vitest';
import { cleanForSnippet, extractWikiLinks, idKey, makeSnippet, parseHeadings, tokenizeQuery, wikiKey } from './search-core.ts';

// The regex forms the scans replace, as they stood (moss's own at the pin for cleaning and headings).
const NOTE_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function regexWikiLinks(body: string): string[] {
  const out = new Set<string>();
  for (const match of body.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)) {
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

function regexClean(body: string): string {
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

function regexSnippet(body: string, query: string): string {
  const cleaned = regexClean(body);
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

function regexHeadings(markdown: string) {
  const outsideCode = markdown.replace(/```[\s\S]*?```/g, '');
  return [...outsideCode.matchAll(/^(#{1,4})\s+(.+)$/gm)].map((match) => ({ level: match[1].length, text: stripWikiLinks(match[2]).trim() }));
}

const fixtures = fileURLToPath(new URL('./converter/fixtures/', import.meta.url));
const NOTES = readdirSync(fixtures).filter((file) => file.endsWith('.md')).map((file) => [file, readFileSync(`${fixtures}${file}`, 'utf8')] as const);

/** A few queries per note: words from its start, middle and end, a phrase, and one it lacks. */
function queriesFor(note: string): string[] {
  const words = note.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const at = (f: number) => words[Math.floor(f * (words.length - 1))] ?? '';
  return [at(0), at(0.5), at(1), `${at(0.3)} ${at(0.31)}`, 'zzqxabsent'];
}

const PIECES = ['[', ']', '(', ')', '<', '>', '!', '|', '#', '-', '~', '\\', '`', ' ', '\n', 'a', 'Bé', '[[', ']]', '](', '<!--', '-->', '---', '~~', '# ', '> ', '0f8fad5b-d9cb-469f-a165-70867728950e'];

/** Deterministic strings of the delimiters (xorshift32). */
function* fuzz(count: number, seed: number): Generator<string> {
  let state = seed;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let n = 0; n < count; n += 1) {
    let text = '';
    for (let length = next() % 48; length > 0; length -= 1) text += PIECES[next() % PIECES.length];
    yield text;
  }
}

describe('search core scans match the regexes they replace (A§5.3)', () => {
  it.each(NOTES)('%s gives the same links, snippets and headings', (_name, note) => {
    expect(extractWikiLinks(note)).toEqual(regexWikiLinks(note));
    expect(cleanForSnippet(note)).toBe(regexClean(note));
    expect(parseHeadings(note)).toEqual(regexHeadings(note));
    for (const query of queriesFor(note)) expect(makeSnippet(note, query)).toBe(regexSnippet(note, query));
  });

  it('gives the same results on random strings of the delimiters', () => {
    for (const text of fuzz(20_000, 0x5eed)) {
      expect(extractWikiLinks(text), JSON.stringify(text)).toEqual(regexWikiLinks(text));
      expect(cleanForSnippet(text), JSON.stringify(text)).toBe(regexClean(text));
      expect(parseHeadings(text), JSON.stringify(text)).toEqual(regexHeadings(text));
    }
  });

  it('keeps the edge cases of each regex', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    for (const text of [
      '[[[Foo]]', '![[img]] [[Real]]', '[[a]b]]', '[[]]', '[[ ]]', `[[x|${id}]]`, '[[a|]]', '[[a||b]]', '[[a|b|c]]',
      '<!--> a -->b', '<!---->', '<a<b>c', '<<>>', '[a[b](c)', '[](x)', '[a] (b)', '[a](b', '[a](b)(c)', '~~a~~~b~~',
      '# [[A|alias]] and [[B]]', '## [[a]b]] [[c|]] [[|d]]', '# [[x|y|z]]', '```\n# no\n```\n### [[Yes]]',
    ]) {
      expect(extractWikiLinks(text), text).toEqual(regexWikiLinks(text));
      expect(cleanForSnippet(text), text).toBe(regexClean(text));
      expect(parseHeadings(text), text).toEqual(regexHeadings(text));
    }
  });
});

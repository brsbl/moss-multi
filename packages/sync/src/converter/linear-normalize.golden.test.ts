// moss's import normalization (markdown/normalize.ts) runs its global regexes through the helpers in
// markdown/linear-match.ts: each gives its regex's result over the corpus and random token strings, and normalizing
// a note of openers that rescanned to the end of the line or the text takes linear time.
import { escapedBlockquoteSearchEnd, replaceFormattedTargets, stripWikiLinkDelimiters } from '@moss-desktop/renderer/editor/markdown/linear-match';
import { escapeHtmlEntities, normalizeMarkdownForImport } from '@moss-desktop/renderer/editor/markdown/normalize';
import { describe, expect, it } from 'vitest';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';
import { FIXTURES } from './fixtures.ts';

// The regexes at the pin.
const ESCAPED_BLOCKQUOTE = /&lt;blockquote\b[\s\S]*?&lt;\/blockquote&gt;/gi;
const WIKI_LINK_DELIMITERS = /(\*{1,2}|~~)\[\[((?:[^\]]|\](?!\]))+)\]\]\1/g;
const targetRegExp = (delimiter: string) => {
  const escaped = delimiter === '*' ? '(?<!\\*)\\*(?!\\*)' : delimiter === '**' ? '(?<!\\*)\\*\\*(?!\\*)' : '(?<!~)~~(?!~)';
  return new RegExp(`${escaped}([^\\n]*?(?:https?:\\/\\/|\\?\\[)[^\\n]*?)${escaped}`, 'g');
};

const TOKENS = [
  '*', '**', '***', '~', '~~', '[', ']', '[[', ']]', '?[', '(', ')', 'http://x', 'https://y', 'http:/', ' ', '\n', 'a', 'b c',
  '&lt;blockquote', '&LT;BlockQuote', '&lt;blockquotes', '&lt;/blockquote&gt;', '&lt;/BLOCKQUOTE&gt;', '&lt;', '&gt;', '`', '\\',
];

function* fuzz(count: number, seed: number): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const length = next() % 30;
    let text = '';
    for (let j = 0; j < length; j += 1) text += TOKENS[next() % TOKENS.length];
    yield text;
  }
}

const texts = [
  ...FIXTURES.flatMap((f) => [f.markdown, ...f.markdown.split('\n')]),
  ...Object.values(CONVERTER_CASES).map((c) => converterBody(c, 2_000)),
  ...fuzz(30_000, 5),
];

// The first few texts a helper and its regex treat differently.
const differing = (same: (text: string) => boolean) => texts.filter((text) => !same(text)).slice(0, 5);
const matches = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => [m.index, m[0]]);

describe('linear import normalization @p:tech-4', () => {
  it('finds the escaped blockquotes the regex finds, searching only up to the last closer', () => {
    expect(differing((text) => JSON.stringify(matches(ESCAPED_BLOCKQUOTE, text.slice(0, escapedBlockquoteSearchEnd(text)))) === JSON.stringify(matches(ESCAPED_BLOCKQUOTE, text)))).toEqual([]);
  });

  it('strips formatting around wiki links as the regex does', () => {
    expect(differing((text) => stripWikiLinkDelimiters(text) === text.replace(WIKI_LINK_DELIMITERS, '[[$2]]'))).toEqual([]);
  });

  it.each(['**', '~~', '*'])('replaces %s-formatted URL and pill targets as the regex does', (delimiter) => {
    const re = targetRegExp(delimiter);
    const replacer = (full: string, content: string) => `<${content}|${full.length}>`;
    expect(differing((text) => replaceFormattedTargets(text, delimiter, re, replacer) === text.replace(re, replacer))).toEqual([]);
  });

  // Notes of openers each regex rescanned from, about 200 KB: each normalizes in well under a second.
  it.each([
    ['formatted wiki-link openers', '*[[a'.repeat(50_000)],
    ['formatted wiki-link openers before one close', `${'**[[a'.repeat(40_000)}]]`],
    ['isolated asterisks', `x ${'*x '.repeat(70_000)}`],
    ['isolated asterisks after a URL', `x https://example.com ${'*x '.repeat(70_000)}*`],
    ['isolated strikethrough after a pill', `x ?[a](b) ${'~~x '.repeat(50_000)}~~`],
    ['escaped blockquote openers', `x ${'&lt;blockquote '.repeat(15_000)}`],
    ['escaped blockquote openers after a closer', `x &lt;/blockquote&gt; ${'&lt;blockquote '.repeat(15_000)}`],
  ])('normalizes in linear time: %s', (_name, markdown) => {
    const started = performance.now();
    escapeHtmlEntities(normalizeMarkdownForImport(markdown));
    expect(performance.now() - started).toBeLessThan(1_000);
  }, 120_000);
});

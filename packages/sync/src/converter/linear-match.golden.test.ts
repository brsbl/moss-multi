// The linear matchers in markdown/linear-match.ts give what their regexes give, byte for byte: over every line and
// paragraph of the converter corpus and over random strings of the tokens the regexes care about.
// scripts/measure-converter.mjs holds the converter to linear cost on unclosed openers in workerd.
import { LINEAR_REGEXP_KEYS, linearRegExp } from '@moss-desktop/renderer/editor/markdown/linear-match';
import { describe, expect, it } from 'vitest';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';
import { FIXTURES } from './fixtures.ts';
import { MARKDOWN_EDITOR_TRANSFORMERS } from './index.ts';

const FIELDS = ['importRegExp', 'regExp', 'regExpStart'] as const;
const keyOf = (re: RegExp) => `/${re.source}/${re.flags}`;

// The regex fields of the converter's list, as [key, the RegExp the list holds].
const listed = MARKDOWN_EDITOR_TRANSFORMERS.flatMap((transformer) =>
  FIELDS.map((field) => (transformer as unknown as Record<string, unknown>)[field]).filter((value): value is RegExp => value instanceof RegExp),
);

// A match as plain data: the captures, where it starts, its input and its named groups.
const shape = (match: RegExpMatchArray | null) => (match ? { captures: [...match], index: match.index, input: match.input, groups: match.groups } : null);

const TOKENS = [
  '[', ']', '(', ')', '[[', ']]', '![', '?[', '](', '|', '-', ':', '*', '**', '~~', '"', '\\', ' ', '  ', '\t', '\n', '\r', '\u2028', '\u00a0',
  'a', 'b c', 'http://x', 'https://y', '/', '#', '<', '>', '.', '`', '!',
];
// Table rows and dividers.
const ROW_TOKENS = ['|', '-', '--', ':', ' ', '\t', '\r', '\u2028', 'a'];

// Deterministic pseudo-random strings of tokens, each also behind the openers the anchored regexes need.
function* fuzz(count: number, seed: number, tokens: string[]): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const length = next() % 24;
    let text = '';
    for (let j = 0; j < length; j += 1) text += tokens[next() % tokens.length];
    yield* [text, `![${text}`, `![${text})`, `[http://${text}`, `*?[${text}`, ` ${text} | `];
  }
}

const corpusTexts = [
  ...FIXTURES.flatMap((f) => [f.markdown, ...f.markdown.split('\n'), ...f.markdown.split(/\n\s*\n/)]),
  ...Object.values(CONVERTER_CASES).map((c) => converterBody(c, 2_000)),
];

describe('linear transformer matching @p:tech-4', () => {
  it('wraps every regex it knows in the converter list, and only those', () => {
    const keys = new Set(listed.map(keyOf));
    expect(LINEAR_REGEXP_KEYS.filter((key) => !keys.has(key))).toEqual([]);
    for (const re of listed) expect(Object.getPrototypeOf(re) !== RegExp.prototype, keyOf(re)).toBe(LINEAR_REGEXP_KEYS.includes(keyOf(re)));
  });

  describe.each(LINEAR_REGEXP_KEYS.map((key) => [key] as const))('%s', (key) => {
    const original = listed.find((re) => keyOf(re) === key)!;
    const plain = new RegExp(original.source, original.flags);
    const linear = linearRegExp(plain);
    // The first few texts the two match differently.
    const differing = (texts: string[]) => texts.filter((text) => JSON.stringify(shape(text.match(linear))) !== JSON.stringify(shape(text.match(plain)))).slice(0, 5);

    it('is a RegExp with the same source and flags', () => {
      expect(linear).toBeInstanceOf(RegExp);
      expect(keyOf(linear)).toBe(key);
      expect('a[b'.split(linear)).toEqual('a[b'.split(plain));
    });

    it('matches like the regex over the corpus', () => {
      expect(differing(corpusTexts).map((text) => text.slice(0, 200))).toEqual([]);
    });

    it('matches like the regex over random token strings', () => {
      expect(differing([...fuzz(30_000, key.length, TOKENS), ...fuzz(10_000, key.length, ROW_TOKENS)])).toEqual([]);
    });
  });
});

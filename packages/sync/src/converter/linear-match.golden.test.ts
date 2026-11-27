// The linear matchers in markdown/linear-match.ts give what their regexes give, byte for byte: over every line and
// paragraph of the converter corpus and over random strings of the tokens the regexes care about.
// scripts/measure-converter.mjs holds the converter to linear cost on unclosed openers in workerd; the typing
// shortcuts and the table divider check, which it does not reach, are held to it here.
import { LINEAR_REGEXP_KEYS, linearRegExp } from '@moss-desktop/renderer/editor/markdown/linear-match';
import { isTableDividerRow } from '@moss-desktop/renderer/editor/markdown/transformers';
import { describe, expect, it } from 'vitest';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';
import { FIXTURES } from './fixtures.ts';
import { MARKDOWN_EDITOR_TRANSFORMERS } from './index.ts';

const FIELDS = ['importRegExp', 'regExp', 'regExpStart'] as const;
const keyOf = (re: RegExp) => `/${re.source}/${re.flags}`;
// Wrapped outside the list: moss's table divider check (isTableDividerRow).
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
const STANDALONE = [DIVIDER];

// The regex fields of the converter's list, as [key, the RegExp the list holds].
const listed = MARKDOWN_EDITOR_TRANSFORMERS.flatMap((transformer) =>
  FIELDS.map((field) => (transformer as unknown as Record<string, unknown>)[field]).filter((value): value is RegExp => value instanceof RegExp),
);

// A match as plain data: the captures, where it starts, its input and its named groups.
const shape = (match: RegExpMatchArray | null) => (match ? { captures: [...match], index: match.index, input: match.input, groups: match.groups } : null);

const TOKENS = [
  '[', ']', '(', ')', '[[', ']]', '![', '?[', '](', '|', '-', ':', '*', '**', '~~', '"', '\\', ' ', '  ', '\t', '\n', '\r', '\u2028', '\u00a0',
  'a', 'b c', 'http://x', 'https://y', '/', '#', '<', '>', '.', '`', '!',
  // Hosts, ports and paths for the raw-URL typing shortcut.
  'a.co', 'b-c', 'x1', ':80', ':123456', '?q', '..', '-.', '.-', 'é',
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
    // The typing shortcuts' forms, anchored at the end.
    yield* [`?[${text})`, `[[${text}]]`, `[[${text}]`, `[http://${text})`, `*?[${text})*`, `*http://${text}*`, `|-${text}`];
    yield* [`${text} `, `${text}a.co `, `a.${text}\t`];
  }
}

const corpusTexts = [
  ...FIXTURES.flatMap((f) => [f.markdown, ...f.markdown.split('\n'), ...f.markdown.split(/\n\s*\n/)]),
  ...Object.values(CONVERTER_CASES).map((c) => converterBody(c, 2_000)),
];

describe('linear transformer matching @p:tech-4', () => {
  it('wraps every regex it knows in the converter list, and only those', () => {
    const keys = new Set([...listed, ...STANDALONE].map(keyOf));
    expect(LINEAR_REGEXP_KEYS.filter((key) => !keys.has(key))).toEqual([]);
    for (const re of listed) expect(Object.getPrototypeOf(re) !== RegExp.prototype, keyOf(re)).toBe(LINEAR_REGEXP_KEYS.includes(keyOf(re)));
  });

  describe.each(LINEAR_REGEXP_KEYS.map((key) => [key] as const))('%s', (key) => {
    const original = [...listed, ...STANDALONE].find((re) => keyOf(re) === key)!;
    const plain = new RegExp(original.source, original.flags);
    const linear = linearRegExp(plain);
    // The first few texts the two match differently.
    const differing = (texts: string[]) =>
      texts.filter((text) => JSON.stringify(shape(text.match(linear))) !== JSON.stringify(shape(text.match(plain))) || linear.test(text) !== plain.test(text)).slice(0, 5);

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

  // Text the original regexes take quadratic time on, 50 KB of it; the wrapped ones take a few ms.
  const SLOW_MS = 500;
  const timed = (run: () => unknown) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  it('checks a table divider in linear time', () => {
    expect(timed(() => isTableDividerRow(`|-|-${' '.repeat(100_000)}x`))).toBeLessThan(SLOW_MS);
  });

  /** The regex executions `run` makes: the linear scans test a character class per character they read. */
  const executions = (run: () => unknown) => {
    const exec = RegExp.prototype.exec;
    let calls = 0;
    RegExp.prototype.exec = function (this: RegExp, text: string) {
      calls += 1;
      return exec.call(this, text);
    };
    try {
      run();
    } finally {
      RegExp.prototype.exec = exec;
    }
    return calls;
  };

  // The raw-URL shortcut runs on every typed space, over the text up to the caret: four times the text, about four
  // times the character tests (sixteen when a scan restarts per start), and the plain regex's quadratic retries pass
  // the time ceiling.
  it.each([
    ['path segments', 'a/'],
    ['dots', 'a.'],
    ['colons', 'a:'],
    ['hosts with ports and paths', 'a.bc:1/'],
    ['hyphens and dots', 'a-.'],
  ])('matches the raw-URL typing shortcut in linear time on %s', (_name, run) => {
    const shortcut = MARKDOWN_EDITOR_TRANSFORMERS.find((t) => t.type === 'text-match' && t.trigger === ' ')!;
    const re = (shortcut as { regExp: RegExp }).regExp;
    const text = (chars: number) => `${run.repeat(Math.ceil(chars / run.length))} `;
    const small = executions(() => text(80_000).match(re));
    const large = executions(() => text(320_000).match(re));
    expect(large, `80k characters: ${small} regex executions, 320k: ${large}`).toBeLessThanOrEqual(4 * small + 64);
    const long = text(320_000);
    expect(timed(() => long.match(re))).toBeLessThan(SLOW_MS);
  });

  it('runs every typing shortcut in linear time on unclosed openers', () => {
    const slow: string[] = [];
    for (const transformer of MARKDOWN_EDITOR_TRANSFORMERS) {
      if (transformer.type !== 'text-match' || !transformer.trigger || !transformer.regExp) continue;
      for (const [name, c] of Object.entries(CONVERTER_CASES)) {
        // Lexical matches the text up to the caret once the trigger character is typed.
        const text = `${converterBody(c, 50_000)}${transformer.trigger}`;
        const ms = timed(() => text.match(transformer.regExp));
        if (ms > SLOW_MS) slow.push(`${keyOf(transformer.regExp)} on ${name}: ${Math.round(ms)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 300_000);
});

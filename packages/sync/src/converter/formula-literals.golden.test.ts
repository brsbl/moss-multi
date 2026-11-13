// moss's formula numeric-literal regex retried its leading \s* from every position of a blank run that no number
// follows, quadratic in the run. replaceNumericLiterals (the formula-runtime `linear-numeric-literals` seam) scans
// once; here it must give the regex's exact matches and groups over the corpus, hand cases and generated formulas.
import { describe, expect, it } from 'vitest';
import { MARKDOWN_CAP_BYTES } from '@moss-multi/protocol/limits';
import { LINEAR_IMPORT_LIMITS } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { replaceNumericLiterals } from '@moss-desktop/renderer/editor/utils/formula-runtime';
import { FIXTURES } from './fixtures.ts';

// NUMERIC_LITERAL_REGEX in packages/desktop/src/renderer/editor/utils/formula-runtime.ts @ 762abb777.
const MOSS_NUMERIC_LITERAL_REGEX = /(\$)?\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([kKmMbB]?)(%?)/g;

type Groups = [full: string, currency: string | undefined, rawNumber: string, unit: string, percent: string];
const mark = (...groups: Groups) => `\u0001${JSON.stringify(groups)}\u0002`;

const viaRegex = (text: string) => {
  MOSS_NUMERIC_LITERAL_REGEX.lastIndex = 0;
  return text.replace(MOSS_NUMERIC_LITERAL_REGEX, (full, currency, rawNumber, unit, percent) => mark(full, currency, rawNumber, unit, percent));
};
const viaScan = (text: string) => replaceNumericLiterals(text, (full, currency, rawNumber, unit, percent) => mark(full, currency, rawNumber, unit, percent));

const HAND = [
  '', ' ', '1', '$1', '$ 1', '$  x', '$$5', '$ $5', '  $5', '1 + 2', '1+ 2 +3', '  12  ', '1,000.50k%', '1,,2', '1.',
  '1.2.3', '.5', '. 5', '..5', '1 . 5', '5k', '5 K', '5 m %', '5%k', '5 x', '$.5b%', '$\t\n 7 %', '  3',
  'a1b2', '@(x#1#2)*3', '(1+2)*3/4-5', '1e5', '١٢', '$', '%', '1 ', ' 1', '1  k', 'x$', '$x1', '0,0.0', '9,', ',9',
  `1+${' '.repeat(50)}+2`, `$${' '.repeat(30)}x`, `${' \t'.repeat(20)}5`,
];

// Seeded, so a failure reproduces.
function generated(count: number): string[] {
  let seed = 0x2f6b9d1;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ['$', ' ', ' ', '\t', '\n', ' ', '　', '0', '1', '7', '9', ',', '.', 'k', 'K', 'm', 'M', 'b', 'B', '%', '+', '-', '*', '/', '(', ')', 'x', '@', '|', 'e'];
  return Array.from({ length: count }, () => {
    const length = next() % 48;
    let text = '';
    for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
    return text;
  });
}

function corpusFormulas(): string[] {
  const texts: string[] = [];
  for (const { markdown } of FIXTURES) {
    texts.push(markdown);
    for (const [, payload] of markdown.matchAll(/\{\{([^{}\n]+)\}\}/g)) texts.push(payload, ...payload.split('|'));
  }
  return texts;
}

describe('replaceNumericLiterals matches moss\'s numeric-literal regex exactly', () => {
  it('over the corpus notes and their formula payloads', () => {
    const texts = corpusFormulas();
    expect(texts.some((text) => text.includes('{{'))).toBe(true);
    for (const text of texts) expect(viaScan(text), JSON.stringify(text.slice(0, 80))).toBe(viaRegex(text));
  });

  it('over hand cases: currency, units, percent, commas, decimals and every kind of blank', () => {
    for (const text of HAND) expect(viaScan(text), JSON.stringify(text)).toBe(viaRegex(text));
  });

  it('over generated formulas', () => {
    for (const text of generated(20_000)) expect(viaScan(text), JSON.stringify(text)).toBe(viaRegex(text));
  });

  it('passes the regex\'s replacement through unchanged, as String.replace does', () => {
    expect(replaceNumericLiterals('$1,000k + 5% - x', () => '0')).toBe('0 +0 - x');
    expect(replaceNumericLiterals('no numbers', () => '0')).toBe('no numbers');
  });
});

it('the harness\'s doubling legs (4 KB to the 2 MB cap) run formulas on both sides of lineChars', () => {
  expect(LINEAR_IMPORT_LIMITS.lineChars).toBeGreaterThan(4096);
  expect(LINEAR_IMPORT_LIMITS.lineChars).toBeLessThan(MARKDOWN_CAP_BYTES);
});

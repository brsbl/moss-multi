// The scans that replaced search-core's super-linear regexes (docs/METHOD.md): golden-equal to the regexes they
// replaced over fixtures and fuzz strings, and linear on note text an attacker writes.
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- the old patterns are the golden references */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cleanForSnippet, headingMatches, linkTexts, wikiLinkContents, withoutTags } from './search-core.ts';

const SCANS: [string, (text: string) => unknown, (text: string) => unknown, string[], ((n: number) => string)[]][] = [
  [
    'wikiLinkContents',
    (text) => [...wikiLinkContents(text)],
    (text) => [...text.matchAll(/(?<!!)\[\[([^\]]+)\]\]/g)].map((match) => match[1]),
    ['[', ']', '!', 'a', '|', '[[', ']]', '![['],
    [(n) => '['.repeat(n), (n) => '[[a'.repeat(n / 3), (n) => `[[${'a'.repeat(n)}]`, (n) => '![['.repeat(n / 3)],
  ],
  [
    'withoutTags',
    withoutTags,
    (text) => text.replace(/<[^>]*>/g, ''),
    ['<', '>', 'a', '/', ' '],
    [(n) => '<'.repeat(n), (n) => '<a'.repeat(n / 2)],
  ],
  [
    'linkTexts',
    linkTexts,
    (text) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'),
    ['[', ']', '(', ')', 'a', '](', '$1'],
    [(n) => '['.repeat(n), (n) => '[a]('.repeat(n / 4), (n) => `[a](${'a'.repeat(n)}`],
  ],
  [
    'headingMatches',
    headingMatches,
    (text) => [...text.matchAll(/^(#{1,4})\s+(.+)$/gm)].map((match) => [match[1], match[2]]),
    ['#', '##', '#####', ' ', '\t', '\n', '\r', '\u2028', '\u00A0', 'a', 'b c'],
    [(n) => `#${' '.repeat(n)}`, (n) => `#${'\n'.repeat(n)}`, (n) => '# \n'.repeat(n / 3), (n) => '\n'.repeat(n), (n) => `# ${' \n'.repeat(n / 2)}`],
  ],
];

const FIXTURES = [
  '',
  '# Title\n\nSee [[Launch Plan]] and ![[img.png]] and [[#H]].\n## Two [[a|b]]\n##### five\n#\n#\tx',
  'Some <b>bold</b> <!-- c --> [link](https://x.y/z) and [[wiki]] [bad] (x) [a](b',
  '#\n# foo\n#   \n  \n',
  '[[a[b]] [[]] [[x]y]] ![[[c]]',
];

function expectLinear(run: (text: string) => unknown, attack: (n: number) => string): void {
  const time = (n: number): number => {
    const text = attack(n);
    const start = performance.now();
    run(text);
    return performance.now() - start;
  };
  time(8 * 1024);
  let previous = time(16 * 1024);
  for (let n = 32 * 1024; n <= 1024 * 1024; n *= 2) {
    const took = time(n);
    expect(took, `${n} chars took ${Math.round(took)} ms after ${Math.round(previous)} ms for half`).toBeLessThan(3 * previous + 25);
    previous = took;
  }
}

describe('search-core scans replace super-linear regexes', () => {
  for (const [name, scan, regex, alphabet, attacks] of SCANS) {
    it(`${name} is golden-equal to the regex it replaced`, () => {
      for (const text of FIXTURES) expect(scan(text), JSON.stringify(text)).toEqual(regex(text));
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 30 }), (parts) => {
          const text = parts.join('');
          expect(scan(text)).toEqual(regex(text));
        }),
        { numRuns: 5000 },
      );
    });
    it(`${name} is linear on attacker-written text`, () => {
      for (const attack of attacks) expectLinear(scan, attack);
    }, 120_000);
  }

  it('cleanForSnippet is linear on attacker-written bodies', () => {
    for (const attack of [(n: number) => '<'.repeat(n), (n: number) => '['.repeat(n), (n: number) => '[a]('.repeat(n / 4)]) expectLinear(cleanForSnippet, attack);
  }, 120_000);
});

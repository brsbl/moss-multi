// The scans that replaced search-core's super-linear regexes (docs/METHOD.md): golden-equal to the regexes they
// replaced over fixtures and fuzz strings, and linear on note text an attacker writes.
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- the old patterns are the golden references */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { doubling, expectLinearTime } from '../../../scripts/lib/linear-time.mjs';
import { MARKDOWN_MAX_BYTES } from '@moss-multi/protocol/limits';
import { cleanForSnippet, headingMatches, linkTexts, makeSnippet, parseHeadings, wikiLinkContents, wikiLinkTexts, withoutComments, withoutFences, withoutTags } from './search-core.ts';

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
    'withoutComments',
    withoutComments,
    (text) => text.replace(/<!--[\s\S]*?-->/g, ''),
    ['<', '!', '-', '>', 'a', '<!--', '-->', '<!-->', '\n'],
    [(n) => '<!--'.repeat(n / 4), (n) => '<!-'.repeat(n / 3), (n) => `<!--${'-'.repeat(n)}`],
  ],
  [
    'withoutFences',
    withoutFences,
    (text) => text.replace(/```[\s\S]*?```/g, ''),
    ['`', '``', '```', '````', 'a', '\n', '#'],
    [(n) => '`'.repeat(n), (n) => '````a'.repeat(n / 5), (n) => `\`\`\`${'`a'.repeat(n / 2)}`],
  ],
  [
    'wikiLinkTexts',
    wikiLinkTexts,
    (text) => text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1'),
    ['[', ']', '|', 'a', '[[', ']]', '|]', '\n'],
    [(n) => '[[a'.repeat(n / 3), (n) => '[[a|'.repeat(n / 4), (n) => '[[a]'.repeat(n / 4), (n) => '[[a|a]'.repeat(n / 6), (n) => `[[a${'|'.repeat(n)}`],
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
  'a <!-- one --> b <!--> c --> d <!---> e --> <!-- open <!-- x',
  '```\n# not\n```\n# yes\n````\n```` `` ``` tail ```` ```',
];

function expectLinear(run: (text: string) => unknown, attack: (n: number) => string, max = 1024 * 1024) {
  return expectLinearTime({
    shape: String(attack),
    sizes: doubling(16 * 1024, max),
    warmup: [8 * 1024],
    slack: 25,
    measure: (n) => {
      const text = attack(n);
      const start = performance.now();
      run(text);
      return performance.now() - start;
    },
  });
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
    it(`${name} is linear on attacker-written text`, async () => {
      for (const attack of attacks) await expectLinear(scan, attack);
    }, 120_000);
  }

  it('cleanForSnippet is linear on attacker-written bodies', async () => {
    for (const attack of [(n: number) => '<'.repeat(n), (n: number) => '['.repeat(n), (n: number) => '[a]('.repeat(n / 4), (n: number) => '<!--'.repeat(n / 4)]) await expectLinear(cleanForSnippet, attack);
  }, 120_000);

  it('makeSnippet and parseHeadings are linear up to the 4 MB of markdown a note may run to, on repeated openers', async () => {
    const attacks = [(n: number) => `quokka ${'<!--'.repeat(n / 4)}`, (n: number) => `${'<!--'.repeat(n / 4)} quokka`, (n: number) => '````a'.repeat(n / 5), (n: number) => `# ${'[[a'.repeat(n / 3)}`];
    for (const attack of attacks) await expectLinear((text) => makeSnippet(text, 'quokka'), attack, MARKDOWN_MAX_BYTES);
    for (const attack of attacks) await expectLinear(parseHeadings, attack, MARKDOWN_MAX_BYTES);
  }, 120_000);
});

// The linear rewrites in note-store.port.ts and the paste plugin's URL scan (docs/METHOD.md): golden-equal to moss's
// regexes over fixtures and fuzz strings, and linear on note text and clipboard HTML an attacker writes.
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- moss's patterns are the golden references */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { URL_IN_HTML } from '../substitutes/url-in-html';
import { MOSS_CANVAS_FENCE_PATTERN_SOURCE } from '@moss-desktop/common/markdown-fences';
import {
  blankMarkdownLinks,
  blankWikiLinks,
  classifyNoteContentType,
  codeBlockSpans,
  countMarkdownTableSeparators,
  imageMarkdownSpans,
} from './note-store.port';

const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
const spans = (text: string, pattern: RegExp): [number, number][] => [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
const MOSS_CODE_BLOCK_REGEX = new RegExp('```(?!(?:moss-chart|' + MOSS_CANVAS_FENCE_PATTERN_SOURCE + ')\\b)[^\\n]*\\n[\\s\\S]*?```', 'g');

const REWRITES: [string, (text: string) => unknown, (text: string) => unknown, string[], ((n: number) => string)[]][] = [
  [
    'the table separator count',
    countMarkdownTableSeparators,
    (text) => count(text, /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*$/gm),
    ['|', '-', '---', ':', ' ', '\t', '\n', '\r', '\r\n', '\u2028', '\u00a0', 'a', '|---|---', '| --- |', '---|', ':---:'],
    [
      (n) => '\n'.repeat(n),
      (n) => ' '.repeat(n),
      (n) => `|${'\n'.repeat(n)}`,
      (n) => '|---\n'.repeat(n / 5),
      (n) => '-'.repeat(n),
      (n) => '---|\n'.repeat(n / 5),
      (n) => ':---|\r\n'.repeat(n / 7),
      (n) => `${'\n'.repeat(n / 2)}|${' '.repeat(n / 2)}`,
      (n) => `${'\n'.repeat(n / 2)}---|${' '.repeat(n / 2)}`,
      (n) => '---|---a\n'.repeat(n / 9),
    ],
  ],
  [
    'the fenced code block scan',
    codeBlockSpans,
    (text) => spans(text, MOSS_CODE_BLOCK_REGEX),
    ['`', '```', '\n', ' ', 'a', 'moss-chart', 'moss-canvas', '-', '```moss-chart', '```js\n'],
    [(n) => '`'.repeat(n), (n) => '```a'.repeat(n / 4), (n) => '```moss-chart'.repeat(n / 13), (n) => `\`\`\`\n${'`'.repeat(n)}`],
  ],
  [
    'the image scan',
    imageMarkdownSpans,
    (text) => spans(text, /!\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g),
    ['!', '[', ']', '(', ')', '\\', '\n', 'a', '![', '](', '\\(', '![a](b)'],
    [(n) => '!['.repeat(n / 2), (n) => '![a]('.repeat(n / 5), (n) => `![a](${'a'.repeat(n)}`, (n) => '[!['.repeat(n / 3)],
  ],
  [
    'blankWikiLinks',
    blankWikiLinks,
    (text) => text.replace(/\[\[[^\]]+\]\]/g, ' '),
    ['[', ']', 'a', '[[', ']]'],
    [(n) => '['.repeat(n), (n) => '[[a'.repeat(n / 3), (n) => `[[${'a'.repeat(n)}]`],
  ],
  [
    'blankMarkdownLinks',
    blankMarkdownLinks,
    (text) => text.replace(/\[[^\]]*\]\((?:[^()\n]|\\\(|\\\))*\)/g, ' '),
    ['[', ']', '(', ')', '\\', '\n', 'a', '](', '\\(', '\\)'],
    [(n) => '['.repeat(n), (n) => '[a]('.repeat(n / 4), (n) => `[a](${'a'.repeat(n)}`, (n) => `[a](${'\\('.repeat(n / 2)}`, (n) => '[](\\('.repeat(n / 5)],
  ],
  [
    'URL_IN_HTML',
    (text) => [...text.matchAll(URL_IN_HTML)].map((match) => [match.index! + match[0].length - match[1]!.length, match[1]]),
    (text) => [...text.matchAll(/[a-z][a-z\d+.-]*:[^\s"'<>]+/gi)].map((match) => [match.index, match[0]]),
    ['a', 'Z', '1', '+', '.', '-', ':', '/', ' ', '"', '<', '>', 'https://h/x', '1a:b'],
    [(n) => 'a'.repeat(n), (n) => `1${'a1'.repeat(n / 2)}`, (n) => '-'.repeat(n)],
  ],
];

const FIXTURES = [
  '',
  '| a | b |\n| --- | :---: |\n| 1 | 2 |\n\n|---|---\n\n   \n\n  |---|---|\n',
  '|\n---|---\n---|\n\n\n',
  '---|\n---|\n---|\n',
  '---|\n---\n\n---|---  \n  |\n:---:\r\n',
  'x ---|---\n\u2028 | ---|---|\u2029',
  '```js\nconst a = 1;\n```\n```moss-chart\n{}\n```\n``` \nb```',
  'An ![image](a.png) and ![x](a\\(b\\)) ![[a]](b) !![y](z) ![no](\n)',
  'See [[Plan]] and [x](y) and [z](a\\(b\\)c) and [w](a(b) and [v](\n) and [[]] [[a]b]]',
  '<p>moss-asset://n/a.png <img src="https://bb.example/media/x?a=1&amp;b=2">9a:b 1+x.y:z</p>',
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

describe("linear rewrites of moss's note-store regexes", () => {
  for (const [name, scan, regex, alphabet, attacks] of REWRITES) {
    it(`${name} is golden-equal to the regex it replaced`, () => {
      for (const text of FIXTURES) expect(scan(text), JSON.stringify(text)).toEqual(regex(text));
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 30 }), (parts) => {
          const text = parts.join('');
          expect(scan(text)).toEqual(regex(text));
        }),
        { numRuns: 20000 },
      );
    });
    it(`${name} is linear on attacker-written text`, () => {
      for (const attack of attacks) expectLinear(scan, attack);
    }, 120_000);
  }

  it('classifyNoteContentType is linear on attacker-written notes', () => {
    for (const attack of [(n: number) => '['.repeat(n), (n: number) => `x\n${'\n'.repeat(n)}`, (n: number) => '[a]('.repeat(n / 4), (n: number) => '---|\n'.repeat(n / 5), (n: number) => '`'.repeat(n), (n: number) => '!['.repeat(n / 2)]) {
      expectLinear(classifyNoteContentType, attack);
    }
  }, 120_000);
});

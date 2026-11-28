// matchTitleLine and markerMatches against moss's regexes they replace (docs/METHOD.md): golden-equal over fixtures
// and fuzz strings, and linear on a note an attacker writes (a first line of spaces was quadratic).
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move -- moss's patterns are the golden references */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { markerMatches, matchTitleLine } from './title-line.ts';

const TITLE_LINE = /^#(?!#)[^\S\r\n]+(.*?)(?:[^\S\r\n]+#+)?[^\S\r\n]*(?:\r?\n|$)/;
const MARKER = /%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:(?:start|end)%%/g;

const titleBefore = (text: string) => {
  const match = TITLE_LINE.exec(text);
  return match ? { line: match[1], length: match[0].length } : null;
};
const markersBefore = (text: string) => [...text.matchAll(MARKER)].map((match) => ({ index: match.index, token: match[0] }));

const CASES: [string, (text: string) => unknown, (text: string) => unknown, string[], ((n: number) => string)[]][] = [
  [
    'matchTitleLine',
    matchTitleLine,
    titleBefore,
    ['#', ' ', '\t', '\n', '\r', '\u2028', '\u00a0', 'a', 'b c', '##', ' #'],
    [(n) => `# ${' '.repeat(n)}x`, (n) => `# ${' #'.repeat(n / 2)}x`, (n) => `# a${' '.repeat(n)}\rb`, (n) => `#${'\u00a0'.repeat(n)}`],
  ],
  [
    'markerMatches',
    (text) => [...markerMatches(text)],
    markersBefore,
    ['%%m:', ':start%%', ':end%%', 'a', ',', '-', ' ', '\n', ':', '%', 'x1'],
    [(n) => `%%m:${' '.repeat(n)}`, (n) => '%%m:a'.repeat(n / 5), (n) => `%%m:${'a '.repeat(n / 2)}:stop`],
  ],
];

const FIXTURES = [
  '',
  '# Tomato log\n\nPlant out in May.\n',
  '# Tomato log ##\nBody.',
  '#  Two  words  #  \r\nx',
  '#\tTabbed\u2028more\n',
  '## Not a title',
  '#NoSpace',
  'Some %%m:c1:start%%commented%%m:c1:end%% text %%m: a, b :start%%x%%m:a,b:end%% %%m::start%% %%m:x:stop%%',
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

describe("moss's interchange patterns as linear scans", () => {
  for (const [name, scan, regex, alphabet, attacks] of CASES) {
    it(`${name} is golden-equal to moss's regex`, () => {
      for (const text of FIXTURES) expect(scan(text), JSON.stringify(text)).toEqual(regex(text));
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...alphabet), { maxLength: 30 }), (parts) => {
          const text = parts.join('');
          expect(scan(text)).toEqual(regex(text));
          expect(scan(`# ${text}`)).toEqual(regex(`# ${text}`));
        }),
        { numRuns: 5000 },
      );
    });
    it(`${name} is linear on attacker-written text`, () => {
      for (const attack of attacks) expectLinear(scan, attack);
    }, 120_000);
  }
});

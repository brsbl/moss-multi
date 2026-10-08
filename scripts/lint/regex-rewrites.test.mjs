// The one-line regex rewrites made for regexp/no-super-linear-* (docs/METHOD.md): each new pattern gives what the old
// one gave over fixtures and fuzz strings, sits in the file it was written for, and runs in linear time on the
// one-character attack the lint rule reported. The scans that replaced regexes are tested beside their code.
/* eslint-disable regexp/no-super-linear-backtracking, regexp/no-super-linear-move, regexp/optimal-quantifier-concatenation -- the old patterns are the golden references */
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { withoutQuery } from '../ci/deps.mjs';

const REPO = new URL('../../', import.meta.url);
const source = (file) => readFileSync(new URL(file, REPO), 'utf8');

const groups = (match) => (match ? [...match] : null);
const USE = {
  replace: (re, text, by = '') => text.replace(re, by),
  test: (re, text) => re.test(text),
  exec: (re, text) => groups(re.exec(text)),
  all: (re, text) => [...text.matchAll(re)].map(groups),
  count: (re, text) => (text.match(re) ?? []).length,
};
const lower = (name) => name.toLowerCase();

/** [what, files with the new literal, old, new, use, extra arg, alphabet, prefixes, attack]. */
const REWRITES = [
  ['host dots', [['apps/web/src/api/ssrf.ts', String.raw`/(?<!\.)\.+$/`]], /\.+$/, /(?<!\.)\.+$/, 'replace', '', ['.', 'a', ']'], [''], (n) => `${'.'.repeat(n)}a`],
  [
    'unfurl attributes',
    [['apps/web/src/api/unfurl.ts', String.raw`/(?<![a-zA-Z_:-])([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g`]],
    /([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    /(?<![a-zA-Z_:-])([a-zA-Z_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    'all',
    undefined,
    ['a', 'B', '-', ':', '_', '=', ' ', '"', "'", '>', '/', 'x="y"'],
    ['', '<meta '],
    (n) => 'a'.repeat(n),
  ],
  ['open count', [['e2e/lib/strike-census.ts', String.raw`/(?<!\d)0*[1-9]\d* open/`]], /[1-9]\d* open/, /(?<!\d)0*[1-9]\d* open/, 'test', undefined, ['0', '1', '9', ' ', 'x', ' open'], [''], (n) => '1'.repeat(n)],
  ['server slashes', [['packages/cli/src/config.ts', String.raw`/(?<!\/)\/+$/`]], /\/+$/, /(?<!\/)\/+$/, 'replace', '', ['/', 'a', ':'], [''], (n) => `${'/'.repeat(n)}a`],
  [
    'slug hyphens',
    [
      ['packages/cli/src/workspace.ts', '/^-+|(?<!-)-+$/g'],
      ['packages/core/src/filenames.ts', '/^-+|(?<!-)-+$/g'],
    ],
    /^-+|-+$/g,
    /^-+|(?<!-)-+$/g,
    'replace',
    '',
    ['-', 'a'],
    [''],
    (n) => `a${'-'.repeat(n)}a`,
  ],
  ['slug tail', [['packages/core/src/filenames.ts', '/(?<!-)-+$/,']], /-+$/, /(?<!-)-+$/, 'replace', '', ['-', 'a'], [''], (n) => `a${'-'.repeat(n)}a`],
  ['base64 padding', [['packages/core/src/tree-anchor.ts', '/(?<!=)=+$/']], /=+$/, /(?<!=)=+$/, 'replace', '', ['=', 'A'], [''], (n) => `${'='.repeat(n)}A`],
  [
    'cut sequences',
    [
      ['packages/editor/src/desktop/note-store.port.ts', '/(?<!\uFFFD)\uFFFD+$/'],
      ['packages/editor/src/host/moss-editor-host.js', String.raw`/(?<!\uFFFD)\uFFFD+$/`],
    ],
    /\uFFFD+$/,
    /(?<!\uFFFD)\uFFFD+$/,
    'replace',
    '',
    ['\uFFFD', 'a'],
    [''],
    (n) => `${'\uFFFD'.repeat(n)}a`,
  ],
  ['last path segment', [['packages/editor/src/desktop/pipeline.golden.test.ts', '/(?<![^/])[^/]+$/']], /[^/]+$/, /(?<![^/])[^/]+$/, 'replace', lower, ['/', 'A', 'b'], [''], (n) => `${'A'.repeat(n)}/`],
  [
    'import lines',
    [['packages/editor/src/host/moss-editor-host.test.ts', String.raw`/^[^\S\n\r\u2028\u2029]*import[\s{*]/m`]],
    /^\s*import[\s{*]/m,
    /^[^\S\n\r\u2028\u2029]*import[\s{*]/m,
    'test',
    undefined,
    ['\n', '\r', ' ', '\t', '\u2028', 'x', 'import', 'import ', 'import{'],
    [''],
    (n) => '\n'.repeat(n),
  ],
  ['media stem ends', [['packages/protocol/src/media.ts', '/^[-.]+|(?<![-.])[-.]+$/g']], /^[-.]+|[-.]+$/g, /^[-.]+|(?<![-.])[-.]+$/g, 'replace', '', ['-', '.', 'a'], [''], (n) => `a${'-'.repeat(n)}a`],
  ['media stem tail', [['packages/protocol/src/media.ts', '/(?<![-.])[-.]+$/,']], /[-.]+$/, /(?<![-.])[-.]+$/, 'replace', '', ['-', '.', 'a'], [''], (n) => `a${'.'.repeat(n)}a`],
  ['snippet rules', [['packages/sync/src/search-core.ts', '/-{3,}/g']], /---+/g, /-{3,}/g, 'replace', '', ['-', 'a', ' '], [''], (n) => '-'.repeat(n)],
  [
    'journey legs',
    [['scripts/ci/journeys.mjs', String.raw`/^[^\S\n\r\u2028\u2029]*test(?:\.(?:only|fixme|fail|slow))?\(\s*[` + "`'\"]/gm"]],
    /^\s*test(?:\.(?:only|fixme|fail|slow))?\(\s*[`'"]/gm,
    /^[^\S\n\r\u2028\u2029]*test(?:\.(?:only|fixme|fail|slow))?\(\s*[`'"]/gm,
    'count',
    undefined,
    ['\n', '\r', ' ', '\t', 'x', 'test(', 'test.only(', "'", '`', ');'],
    [''],
    (n) => '\n'.repeat(n),
  ],
  [
    'lockfile keys',
    [['scripts/ci/single-version.mjs', String.raw`/^([A-Za-z]\w*):\s*((?:\S.*)?)$/`]],
    /^([A-Za-z]\w*):\s*(.*)$/,
    /^([A-Za-z]\w*):\s*((?:\S.*)?)$/,
    'exec',
    undefined,
    ['a', ':', ' ', '\t', '\n', '\r', '\u00A0', 'b'],
    ['', 'k:'],
    (n) => `k:${' '.repeat(n)}\n`,
  ],
  [
    'lockfile entries',
    [['scripts/ci/single-version.mjs', String.raw`/^ {2}('[^']+'|"[^"]+"|[^\s:]+):\s*(\S.*|[^\S\n\r\u2028\u2029])$/`]],
    /^ {2}('[^']+'|"[^"]+"|[^\s:]+):\s*(.+)$/,
    /^ {2}('[^']+'|"[^"]+"|[^\s:]+):\s*(\S.*|[^\S\n\r\u2028\u2029])$/,
    'exec',
    undefined,
    ['a', ':', ' ', '\t', '\n', '\r', "'", '"'],
    ['', '  ', '  a:'],
    (n) => `  a:${' '.repeat(n)}\n`,
  ],
  [
    'converter timings',
    [['scripts/measure-converter.mjs', String.raw`/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*|[^\S\n\r\u2028\u2029])$/`]],
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/,
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S.*|[^\S\n\r\u2028\u2029])$/,
    'exec',
    undefined,
    ['1', ' ', '\t', '\n', '\r', 'x'],
    ['', '1 2 3 x'],
    (n) => `1 2 3 x${' '.repeat(n)}\n`,
  ],
  ['trailing newlines', [['scripts/moss-extract.mjs', String.raw`/(?<!\n)\n*$/`]], /\n*$/, /(?<!\n)\n*$/, 'replace', '\n', ['\n', 'a', '\r'], [''], (n) => `${'\n'.repeat(n)}a`],
  [
    'diff index lines',
    [['scripts/moss-vendor.mjs', String.raw`/^index [0-9a-f]+\.\.[0-9a-f].*\n/m`]],
    /^index [0-9a-f]+\.\.[0-9a-f]+.*\n/m,
    /^index [0-9a-f]+\.\.[0-9a-f].*\n/m,
    'replace',
    '',
    ['index ', 'a', '1', '..', '\n', 'x', ' '],
    ['', 'index 1..'],
    (n) => `index 1..${'1'.repeat(n)}`,
  ],
  [
    'stack run paths',
    [['scripts/stack.mjs', String.raw`/(?<!\S)(\S*\/\.local-stack\/runs\/([A-Za-z0-9._-]+))\/state(?:\s|$)/`]],
    /(\S*\/\.local-stack\/runs\/([A-Za-z0-9._-]+))\/state(?:\s|$)/,
    /(?<!\S)(\S*\/\.local-stack\/runs\/([A-Za-z0-9._-]+))\/state(?:\s|$)/,
    'exec',
    undefined,
    ['a', '/', ' ', '\n', '/.local-stack/runs/', 'r1', '/state', 'x'],
    [''],
    (n) => 'a'.repeat(n),
  ],
  [
    'process lines',
    [['scripts/stack.mjs', String.raw`/^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:\S.*)?)$/`]],
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/,
    /^\s*(\d+)\s+(\d+)\s+(\S+)\s+((?:\S.*)?)$/,
    'exec',
    undefined,
    ['1', ' ', '\t', '\n', '\r', 'x'],
    ['', '1 2 x'],
    (n) => `1 2 x${' '.repeat(n)}\n`,
  ],
  [
    'html attributes',
    [['scripts/stack.mjs', String.raw`/(?<![\w-])([\w-]+)\s*=\s*"([^"]*)"/g`]],
    /([\w-]+)\s*=\s*"([^"]*)"/g,
    /(?<![\w-])([\w-]+)\s*=\s*"([^"]*)"/g,
    'all',
    undefined,
    ['a', '-', '=', ' ', '"', 'x', '>'],
    [''],
    (n) => 'a'.repeat(n),
  ],
];

const FIXTURES = ['', 'a', ' ', '\n', 'a\nb', '  key: value  ', '<meta property="og:title" content="Moss">', 'x/y/Z.MD', '1 open', 'note--title--', '=='];

/** Doubling the input at most roughly doubles the time, from 16 K to 1 M characters. */
function expectLinear(run, attack) {
  const time = (n) => {
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

describe('regex rewrites for regexp/no-super-linear-*', () => {
  for (const [what, files, before, after, use, arg, alphabet, prefixes, attack] of REWRITES) {
    const run = (re, text) => USE[use](re, text, arg);
    it(`${what}: the new pattern is the one in the code`, () => {
      for (const [file, literal] of files) expect(source(file), file).toContain(literal);
    });
    it(`${what}: golden-equal to the old pattern`, () => {
      for (const text of [...FIXTURES, attack(64)]) expect(run(after, text), JSON.stringify(text)).toEqual(run(before, text));
      const text = fc
        .tuple(fc.constantFrom(...prefixes), fc.array(fc.constantFrom(...alphabet), { maxLength: 24 }))
        .map(([prefix, parts]) => prefix + parts.join(''));
      fc.assert(
        fc.property(text, (value) => {
          expect(run(after, value)).toEqual(run(before, value));
        }),
        { numRuns: 3000 },
      );
    });
    it(`${what}: linear on the reported attack`, () => expectLinear((text) => run(after, text), attack), 60_000);
  }
});

describe('withoutQuery (scripts/ci/deps.mjs)', () => {
  const before = (spec) => spec.replace(/\?.*$/, '');
  it('is golden-equal to /\\?.*$/', () => {
    for (const spec of ['', './a.css?inline', '@moss/shared?x?y', 'a\n?b', '?', 'x?\ny?z', 'a\u2028?b\rc?d']) expect(withoutQuery(spec)).toBe(before(spec));
    fc.assert(
      fc.property(fc.array(fc.constantFrom('?', 'a', '\n', '\r', '\u2028', '/'), { maxLength: 24 }), (parts) => {
        expect(withoutQuery(parts.join(''))).toBe(before(parts.join('')));
      }),
      { numRuns: 3000 },
    );
  });
  it('is linear', () => expectLinear(withoutQuery, (n) => `${'?'.repeat(n)}\n`), 60_000);
});

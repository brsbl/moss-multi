// The AutoLinkPlugin matchers (MarkdownEditor's linear-autolink seam) against moss's own regexes, read from the
// vendored MarkdownEditor.tsx: the same matches over hand cases, the corpus notes and fuzz, and linear time on long
// words, where the regexes take quadratic time.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { findEmail, schemelessUrlMatches } from './autolink.ts';

const repo = new URL('../../../../', import.meta.url);
const editor = readFileSync(new URL('vendor/moss/packages/desktop/src/renderer/editor/MarkdownEditor.tsx', repo), 'utf8');

/** A regex literal declared in moss's MarkdownEditor.tsx as `const NAME =\n  /.../flags;`. */
function mossRegex(name: string): RegExp {
  const literal = new RegExp(`const ${name} =\\s*\\n\\s*(/.+/[a-z]*);\\n`).exec(editor)?.[1];
  if (!literal) throw new Error(`${name} is not declared in MarkdownEditor.tsx`);
  const close = literal.lastIndexOf('/');
  return new RegExp(literal.slice(1, close), literal.slice(close + 1));
}

const EMAIL_REGEX = mossRegex('EMAIL_REGEX');
const SCHEMELESS_URL_REGEX = mossRegex('SCHEMELESS_URL_REGEX');

const regexEmail = (text: string) => {
  const match = EMAIL_REGEX.exec(text);
  return match && { index: match.index, text: match[0] };
};
const regexSchemeless = (text: string) => [...text.matchAll(SCHEMELESS_URL_REGEX)].map((match) => ({ index: match.index, text: match[0] }));

function expectSame(text: string): void {
  expect(findEmail(text), `email in ${JSON.stringify(text)}`).toEqual(regexEmail(text));
  expect([...schemelessUrlMatches(text)], `schemeless URLs in ${JSON.stringify(text)}`).toEqual(regexSchemeless(text));
}

const CASES = [
  '',
  'plain words only',
  'see example.com today',
  'example.com/cat.png and sub.example.co.uk/a/b?x=1#frag',
  'localhost:3000/x foo.bar:8080/path a.bc:123456 a.bc:x',
  'a.b a.bc ab.c -a.bc a-.bc a-b.cd ab.c-d.ef 1.2.3.4 x1.y2z',
  'label.' + 'q'.repeat(30) + ' and a.' + 'b'.repeat(23) + '-c.d',
  'a.b.c.d.e.f.gh.1 a..bc a.bc. .bc a.-b.cd',
  'ada@example.invalid, "Ada L"@example.invalid; root@[192.168.0.1] x@[1.2.3] y@[1234.1.1.1]',
  'a.b@c.de a@b.c a@b.c.de1 foo@bar.com.1 x@-y.zz q@a.b.c "a"@b "x"y"@a.bc ""@a.bc',
  'mail ada@example.invalid\nand "quoted\nline"@a.bc "one"@x "two"@y.zz',
  'é@example.com ñame@dømain.com a b@c.de x "y"@z.ab',
  '<ada@example.invalid> (a@b.cd) [a@b.cd] a,b@c.de a;b@c.de',
  'https://example.com/report.zip http://192.168.1.20/admin www.example.com',
  'emoji 😀.com and a.😀b.cd and 😀@a.bc',
  'tab\ta.bc\vb.cd\fc.de\re.fg',
];

it('matches moss’s EMAIL_REGEX and SCHEMELESS_URL_REGEX on hand cases', () => {
  for (const text of CASES) expectSame(text);
});

it('matches them over every corpus note, whole and line by line', () => {
  const dirs = [new URL('packages/sync/src/converter/fixtures/', repo), new URL('e2e/fixtures/', repo)];
  let notes = 0;
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((file) => file.endsWith('.md'))) {
      const text = readFileSync(join(fileURLToPath(dir), name), 'utf8');
      notes += 1;
      expectSame(text);
      for (const line of text.split('\n')) expectSame(line);
    }
  }
  expect(notes).toBeGreaterThan(5);
});

/** mulberry32: a seeded generator, so a failure names a reproducible string. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARS = [...'aabbzZQ019-..@"::/?#[]  _é <>(),;\\`^{}|'].concat(['\n', '\r', ' ', '\t', '😀']);
const TOKENS = ['ab', 'a', 'x1', '.', '.', '-', '@', '"', 'com', 'co', '1', '123', '[1.2.3.4]', '[1.2', ':80', ':123456', '/p', '?q', '#f', ' ', '\n', 'é', 'q'.repeat(25), '"@', 'a@b'];

it('matches them on random strings over the characters both regexes care about', () => {
  const next = rng(0x5eed);
  for (let i = 0; i < 20_000; i += 1) {
    const length = Math.floor(next() * 40);
    let text = '';
    for (let j = 0; j < length; j += 1) text += CHARS[Math.floor(next() * CHARS.length)];
    expectSame(text);
  }
});

it('matches them on random strings of URL and email fragments', () => {
  const next = rng(0xa11);
  for (let i = 0; i < 20_000; i += 1) {
    const length = 1 + Math.floor(next() * 14);
    let text = '';
    for (let j = 0; j < length; j += 1) text += TOKENS[Math.floor(next() * TOKENS.length)];
    expectSame(text);
  }
});

// Long words, each a worst case for one of the regexes' retries.
const WORDS: Record<string, (n: number) => string> = {
  letters: (n) => 'a'.repeat(n),
  'quoted, unclosed': (n) => '"' + 'a'.repeat(n - 1),
  'dotted labels': (n) => 'ab.'.repeat(Math.floor(n / 3)),
  'ends in @': (n) => 'a'.repeat(n - 1) + '@',
  'domain without a top level': (n) => 'a@' + 'b.'.repeat(Math.floor(n / 2) - 1),
  'quote-at pairs': (n) => '"@'.repeat(Math.floor(n / 2)),
  'hyphenated host': (n) => 'a-'.repeat(Math.floor(n / 2)) + '.',
};

/** Thrown once a scan reads more than its budget: a quadratic scan stops early instead of running for minutes. */
class OverBudget extends Error {}

/**
 * The scanned text, counting every character the matchers read: one per `charCodeAt`, and the characters an `indexOf`,
 * `includes` or `slice` passes over. A string method the matchers start to use without a count here throws.
 */
class CountedText {
  reads = 0;
  constructor(readonly text: string, readonly budget: number) {}
  get length(): number {
    return this.text.length;
  }
  #read(count: number): void {
    this.reads += count;
    if (this.reads > this.budget) throw new OverBudget(`read more than ${this.budget} characters`);
  }
  charCodeAt(index: number): number {
    this.#read(1);
    return this.text.charCodeAt(index);
  }
  indexOf(search: string, from = 0): number {
    const at = this.text.indexOf(search, from);
    this.#read((at === -1 ? this.text.length : at + search.length) - Math.max(0, from));
    return at;
  }
  includes(search: string): boolean {
    return this.indexOf(search) !== -1;
  }
  slice(start: number, end = this.text.length): string {
    this.#read(Math.max(0, end - start));
    return this.text.slice(start, end);
  }
}

/** Characters both matchers read over `text`; Infinity past `budget`. */
function reads(text: string, budget: number): number {
  const counted = new CountedText(text, budget);
  try {
    findEmail(counted as unknown as string);
    Array.from(schemelessUrlMatches(counted as unknown as string));
  } catch (error) {
    if (error instanceof OverBudget) return Infinity;
    throw error;
  }
  return counted.reads;
}

/** At most this many reads per character: the matchers scan no character more than a few times. */
const READS_PER_CHAR = 16;

it('scans a long word in linear time: doubling it from 25k to 50k to 100k characters at most doubles the characters read', () => {
  for (const [name, build] of Object.entries(WORDS)) {
    let previous = reads(build(25_000), READS_PER_CHAR * 25_000);
    expect(previous, `${name}: 25000 chars read ${previous} times`).toBeLessThanOrEqual(READS_PER_CHAR * 25_000);
    for (const n of [50_000, 100_000]) {
      const count = reads(build(n), READS_PER_CHAR * n);
      expect(count, `${name}: ${n / 2} chars read ${previous} times, ${n} read ${count}`).toBeLessThanOrEqual(2 * previous + 64);
      previous = count;
    }
  }
});

it('scans each 100k-character word within a generous time ceiling', () => {
  for (const build of Object.values(WORDS)) {
    findEmail(build(2_000));
    Array.from(schemelessUrlMatches(build(2_000)));
  }
  for (const [name, build] of Object.entries(WORDS)) {
    const text = build(100_000);
    const start = performance.now();
    findEmail(text);
    Array.from(schemelessUrlMatches(text));
    const ms = performance.now() - start;
    // About ten times the slowest word's time on a loaded CI runner (28 ms); a quadratic scan takes seconds.
    expect(ms, `${name}: 100k chars took ${ms.toFixed(1)} ms`).toBeLessThan(250);
  }
});

it('gives the regexes’ matches on the long words', () => {
  for (const build of Object.values(WORDS)) expectSame(build(300));
});

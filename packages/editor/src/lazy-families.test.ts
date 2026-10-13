// The lazy-family scan over a note body: the fences and blockquotes that need a lazy view, and linear time on
// adversarial bodies (a push security review flagged the earlier regexes as quadratic on long backtick runs).
import { expect, it } from 'vitest';
import { lazyFamilies } from './lazy-families';

it('finds each family by the markdown that imports it', () => {
  expect(lazyFamilies('# Plan\n\nPlain text, `code`, and ``inline``.\n')).toEqual([]);
  expect(lazyFamilies('```moss-chart\n{}\n```')).toEqual(['chart']);
  expect(lazyFamilies('Intro\n\n````  moss-chart\n{}\n````\n')).toEqual(['chart']);
  expect(lazyFamilies('```moss-canvas\n..\n```')).toEqual(['sketch']);
  expect(lazyFamilies('```moss-sketch\n..\n```')).toEqual(['sketch']);
  expect(lazyFamilies('```moss-html\n<p>x</p>\n```')).toEqual(['html-block']);
  expect(lazyFamilies('<BLOCKQUOTE>quoted</BLOCKQUOTE>')).toEqual(['html-block']);
  expect(lazyFamilies('&lt;blockquote&gt;')).toEqual(['html-block']);
  expect(lazyFamilies('```moss-html\n```\n\n```moss-canvas\n```\n\n```moss-chart\n```')).toEqual(['chart', 'sketch', 'html-block']);
  expect(lazyFamilies('``moss-chart`` and `moss-canvas` in inline code')).toEqual([]);
  expect(lazyFamilies('```js\nmoss-chart\n```')).toEqual([]);
});

const BODIES: Record<string, (n: number) => string> = {
  'one backtick run': (n) => '`'.repeat(n),
  'a fence then whitespace': (n) => '```' + ' \n'.repeat(Math.floor(n / 2)),
  'fences without a family': (n) => '```\n'.repeat(Math.floor(n / 4)),
  'near misses': (n) => '```moss-'.repeat(Math.floor(n / 8)),
  'unclosed blockquotes': (n) => '<blockquot'.repeat(Math.floor(n / 10)),
};

/** Thrown once a scan reads more than its budget: a quadratic scan stops early instead of running for minutes. */
class OverBudget extends Error {}

/**
 * `body` behind a proxy that counts every character the scan reads: one per index or `charCodeAt`, and the characters
 * an `indexOf`, `includes`, `startsWith`, `slice` or `toLowerCase` passes over. A string method the scan starts to use
 * without a count here throws.
 */
function counted(body: string, budget: number): { text: string; reads: () => number } {
  let reads = 0;
  const read = (count: number) => {
    reads += Math.max(0, count);
    if (reads > budget) throw new OverBudget(`read more than ${budget} characters`);
  };
  const wrap = (text: string): string => new Proxy({} as Record<string | symbol, unknown>, {
    get(_target, key) {
      if (key === 'length') return text.length;
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        read(1);
        return text[Number(key)];
      }
      switch (key) {
        case 'charCodeAt': return (at: number) => { read(1); return text.charCodeAt(at); };
        case 'indexOf': return (search: string, from = 0) => {
          const at = text.indexOf(search, from);
          read((at === -1 ? text.length : at + search.length) - Math.max(0, from));
          return at;
        };
        case 'includes': return (search: string) => {
          const at = text.indexOf(search);
          read(at === -1 ? text.length : at + search.length);
          return at !== -1;
        };
        case 'startsWith': return (search: string, at = 0) => { read(search.length); return text.startsWith(search, at); };
        case 'slice': return (from = 0, to = text.length) => { read(Math.min(to, text.length) - from); return text.slice(from, to); };
        case 'toLowerCase': return () => { read(text.length); return wrap(text.toLowerCase()); };
        default: throw new Error(`the scan used ${String(key)}, which this test does not count`);
      }
    },
  }) as unknown as string;
  return { text: wrap(body), reads: () => reads };
}

/** Characters the scan reads in `body`; Infinity past `budget`. */
function reads(body: string, budget: number): number {
  const scanned = counted(body, budget);
  try {
    lazyFamilies(scanned.text);
  } catch (error) {
    if (error instanceof OverBudget) return Infinity;
    throw error;
  }
  return scanned.reads();
}

/** At most this many reads per character: the scan reads no character more than a few times. */
const READS_PER_CHAR = 8;

it('scans in linear time: doubling a body from 25k to 50k to 100k characters at most doubles the characters read', () => {
  for (const [name, build] of Object.entries(BODIES)) {
    const sample = build(1_000);
    expect(lazyFamilies(counted(sample, Infinity).text), `${name}: the counted scan finds what the plain one does`).toEqual(lazyFamilies(sample));
    let previous = reads(build(25_000), READS_PER_CHAR * 25_000);
    expect(previous, `${name}: 25000 chars read ${previous} times`).toBeLessThanOrEqual(READS_PER_CHAR * 25_000);
    for (const n of [50_000, 100_000]) {
      const count = reads(build(n), READS_PER_CHAR * n);
      expect(count, `${name}: ${n / 2} chars read ${previous} times, ${n} read ${count}`).toBeLessThanOrEqual(2 * previous + 64);
      previous = count;
    }
  }
});

it('scans each 100k-character body within a generous time ceiling', () => {
  for (const build of Object.values(BODIES)) lazyFamilies(build(2_000));
  for (const [name, build] of Object.entries(BODIES)) {
    const body = build(100_000);
    const start = performance.now();
    lazyFamilies(body);
    const ms = performance.now() - start;
    // CI ran this whole file, every size three times, in 50-100 ms; a quadratic scan of 100k characters takes seconds.
    expect(ms, `${name}: 100k chars took ${ms.toFixed(1)} ms`).toBeLessThan(250);
  }
});

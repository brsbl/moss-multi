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

/** The fastest of a few scans of `body`, in ms; one scan when it is already slow. */
function time(body: string): number {
  let best = Infinity;
  for (let run = 0; run < 3; run += 1) {
    const start = performance.now();
    lazyFamilies(body);
    best = Math.min(best, performance.now() - start);
    if (best > 500) break;
  }
  return best;
}

it('scans in linear time: doubling a body from 25k to 50k to 100k characters at most triples the time', { timeout: 240_000 }, () => {
  for (const build of Object.values(BODIES)) time(build(2_000));
  for (const [name, build] of Object.entries(BODIES)) {
    let previous = time(build(25_000));
    for (const n of [50_000, 100_000]) {
      const ms = time(build(n));
      expect(ms, `${name}: ${n / 2} chars took ${previous.toFixed(1)} ms, ${n} took ${ms.toFixed(1)} ms`).toBeLessThanOrEqual(3 * previous + 5);
      previous = ms;
    }
    expect(previous, `${name}: 100k chars`).toBeLessThan(100);
  }
});

// The caret text checks read lines a peer writes, up to most of a note's size: each stays linear in the line's length
// (docs/METHOD.md), on repeated characters, repeated tokens and lines that differ only at one end.
import { describe, it } from 'vitest';
import { doubling, expectLinearTime } from '../../../../../scripts/lib/linear-time.mjs';
import { movedOut, replacedOffset, splitOffset } from './peer-caret-text.ts';

const SHAPES: [string, (n: number) => string][] = [
  ["'a' repeated", (n) => 'a'.repeat(n)],
  ["'ab' repeated", (n) => 'ab'.repeat(n / 2)],
  ['a long line', (n) => `b${'a'.repeat(n - 2)}b`],
];
/** The same line with one character changed at its start or at its end. */
const changed = (text: string, at: 'start' | 'end') => (at === 'start' ? `c${text.slice(1)}` : `${text.slice(0, -1)}c`);

const CALLS: [string, (text: string) => void][] = [
  ['replacedOffset', (text) => {
    const half = text.length >> 1;
    replacedOffset(text.slice(0, half), text.slice(half), text);
    replacedOffset(text.slice(0, half), text.slice(half), changed(text, 'start'));
    replacedOffset(text.slice(0, half), text.slice(half), changed(text, 'end'));
    replacedOffset(text, '', changed(text, 'end'));
  }],
  ['splitOffset', (text) => {
    const half = text.length >> 1;
    const quarter = text.length >> 2;
    splitOffset(text.slice(0, half), text.slice(half), text.slice(0, quarter), [text.slice(quarter)], false);
    splitOffset(text, text.slice(half), changed(text.slice(0, quarter), 'end'), [text.slice(quarter)], false);
    splitOffset(changed(text, 'start'), '', text.slice(0, quarter), [text.slice(quarter)], true);
    splitOffset(text, text.slice(half), text.slice(0, half), [text.slice(half)], true);
  }],
  ['movedOut', (text) => {
    const half = text.length >> 1;
    movedOut(text, text.slice(0, half), text.slice(half));
    movedOut(changed(text, 'start'), text.slice(0, half), text.slice(half));
    movedOut(changed(text, 'end'), text.slice(half), text.slice(0, half));
  }],
];

describe('the caret text checks are linear in the line @p:col-1', () => {
  for (const [name, call] of CALLS) {
    it(`${name} doubles in time when its lines double`, async () => {
      for (const [shape, make] of SHAPES) {
        await expectLinearTime({
          shape: `${name} on ${shape}`,
          sizes: doubling(32 * 1024, 1024 * 1024),
          warmup: [16 * 1024],
          slack: 25,
          measure: (n: number) => {
            const text = make(n);
            const start = performance.now();
            for (let i = 0; i < 4; i++) call(text);
            return performance.now() - start;
          },
        });
      }
    }, 120_000);
  }
});

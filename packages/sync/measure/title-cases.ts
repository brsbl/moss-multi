// Worst-case pairs for a server title write (REST rename): each side is caller-controlled text, so every pair must
// diff within the per-request CPU budget in scripts/measure-converter.mjs and still land exactly.

/** A deterministic lowercase string of `length` from `seed` (xorshift32). */
function letters(length: number, seed: number): string {
  let state = seed;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += String.fromCharCode(97 + ((state >>> 0) % 26));
  }
  return out;
}

const LINES = 1_980;
const lines = (line: (i: number) => string) => Array.from({ length: LINES }, (_, i) => `${line(i)}\n`).join('');
const prefix = 'x'.repeat(97);

export const TITLE_CASES: Record<string, readonly [string, string]> = {
  // About 200 KB each, 1,980 lines: under the old 4M-cell budget, so the line table is fully built.
  'two different 200 KB strings': [lines((i) => letters(100, i + 1)), lines((i) => letters(100, i + 7_919))],
  // Lines that share 97 characters and alternate their tails, so every line comparison scans the shared prefix.
  'alternating 200 KB lines': [lines((i) => `${prefix}${i % 2 ? 'ab' : 'ba'}${i % 10}`), lines((i) => `${prefix}${i % 2 ? 'ba' : 'ab'}${i % 10}`)],
  // Alternating characters at the old character budget's edge, and at 200 KB.
  'alternating 2,000 characters': ['ab'.repeat(999) + 'a', 'ba'.repeat(999) + 'b'],
  'alternating 200 KB characters': ['ab'.repeat(100_000), 'ba'.repeat(100_000)],
};

// The linear-time guard the unit tests share: each size must cost less than three times the size before it, plus a
// slack in ms. The caller measures (its own clock, preparation and runs); this compares.
import { expect } from 'vitest';

/** The sizes from `from` to `to`, doubling. */
export function doubling(from, to) {
  const sizes = [];
  for (let n = from; n <= to; n *= 2) sizes.push(n);
  return sizes;
}

const fastest = (samples) => Math.min(...samples);

async function take(measure, size, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push(await measure(size));
  return samples;
}

/**
 * Times `measure` at each of `sizes` (`samples` runs each, the fastest counts) after the `warmup` sizes, and fails
 * when a size costs `3 * previous + slack` ms or more. Returns each step's figures.
 */
export async function expectLinearTime({ shape, sizes, measure, slack, samples = 1, warmup = [] }) {
  for (const size of warmup) await measure(size);
  let half = { size: sizes[0], samples: await take(measure, sizes[0], samples) };
  const steps = [];
  for (const size of sizes.slice(1)) {
    const full = { size, samples: await take(measure, size, samples) };
    const took = fastest(full.samples);
    const previous = fastest(half.samples);
    steps.push({ size, half: half.size, took, previous, ratio: took / previous, samples: full.samples, halfSamples: half.samples });
    expect(took, `${size} chars took ${Math.round(took)} ms after ${Math.round(previous)} ms for half`).toBeLessThan(3 * previous + slack);
    half = full;
  }
  return steps;
}

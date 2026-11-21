// The linear-time guard the unit tests share: each size must cost less than three times the size before it, plus a
// slack in ms. The caller measures (its own clock, preparation and runs); this compares.
import { expect } from 'vitest';

/** On a miss, at most this many more samples of each of the two sizes. */
const RETIMES = 9;

/** The sizes from `from` to `to`, doubling. */
export function doubling(from, to) {
  const sizes = [];
  for (let n = from; n <= to; n *= 2) sizes.push(n);
  return sizes;
}

const fastest = (samples) => Math.min(...samples);
const list = (samples) => samples.map((sample) => sample.toFixed(1)).join(', ');

async function take(measure, size, count) {
  const samples = [];
  for (let i = 0; i < count; i += 1) samples.push(await measure(size));
  return samples;
}

/**
 * Times `measure` at each of `sizes` (`samples` runs each, the fastest counts) after the `warmup` sizes, and fails
 * when a size costs `3 * previous + slack` ms or more. A step that misses is re-timed: up to nine more samples of the
 * two sizes, alternating, and the fastest of all its samples against the fastest of all the half's. More half samples
 * can only tighten the bound, so a slow window cannot pass a step; a quadratic cost is about 4x at every sample.
 * Returns each step's figures.
 */
export async function expectLinearTime({ shape, sizes, measure, slack, samples = 1, warmup = [] }) {
  for (const size of warmup) await measure(size);
  let half = { size: sizes[0], samples: await take(measure, sizes[0], samples) };
  const steps = [];
  for (const size of sizes.slice(1)) {
    const full = { size, samples: await take(measure, size, samples) };
    const misses = () => fastest(full.samples) >= 3 * fastest(half.samples) + slack;
    for (let i = 0; i < RETIMES && misses(); i += 1) {
      half.samples.push(await measure(half.size));
      full.samples.push(await measure(size));
    }
    const took = fastest(full.samples);
    const previous = fastest(half.samples);
    steps.push({ size, half: half.size, took, previous, ratio: took / previous, samples: full.samples, halfSamples: half.samples });
    expect(
      took,
      `${shape}: ${size} took ${took.toFixed(1)} ms after ${previous.toFixed(1)} ms for ${half.size} (ratio ${(took / previous).toFixed(2)}, ` +
        `allowed 3 x ${previous.toFixed(1)} + ${slack} ms); samples at ${size}: ${list(full.samples)}; at ${half.size}: ${list(half.samples)}`,
    ).toBeLessThan(3 * previous + slack);
    half = full;
  }
  return steps;
}

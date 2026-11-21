// The shared linear-time guard on an injected clock: a runner slowing down for one window does not fail a linear cost,
// and noise cannot pass a quadratic one.
import { describe, expect, it } from 'vitest';
import { doubling, expectLinearTime } from './linear-time.mjs';

const K = 1024;
const linear = (n) => n / 10_000; // 1 MiB: 105 ms, as the table-separator shape costs on a runner
const quadratic = (n) => (n / K) ** 2 / 500; // 128 K: 33 ms, 256 K: 131 ms

/** A fake clock and a run that advances it by `cost(size)`, times `slow(size, call)` for the call-th run at that size. */
function rig(cost, slow = () => 1) {
  let t = 0;
  const now = () => t;
  const calls = new Map();
  const samples = new Map();
  const measure = (size) => {
    const call = calls.get(size) ?? 0;
    calls.set(size, call + 1);
    const start = now();
    t += cost(size) * slow(size, call);
    const took = now() - start;
    samples.set(size, [...(samples.get(size) ?? []), took]);
    return took;
  };
  return { measure, samples };
}

describe('expectLinearTime', () => {
  it('passes a linear cost when the runner slows for the whole window of the last size', async () => {
    // Fastest of three at 1 MiB, all three 1.9 times slower: 199 ms against 3 * 52 + 25 = 182.
    const { measure } = rig(linear, (size, call) => (size === 1024 * K && call < 3 ? 1.9 : 1));
    await expect(expectLinearTime({ shape: 'linear', sizes: doubling(16 * K, 1024 * K), warmup: [8 * K], measure, slack: 25, samples: 3 })).resolves.toBeDefined();
  });

  it('fails a quadratic cost', async () => {
    const { measure } = rig(quadratic);
    await expect(expectLinearTime({ shape: 'quadratic', sizes: doubling(16 * K, 1024 * K), measure, slack: 25, samples: 3 })).rejects.toThrow();
  });

  it('fails a quadratic cost when the re-timed half size runs slowly', async () => {
    // Slow re-timings of 128 K would raise the bound for 256 K if any one re-timing could pass the step.
    const { measure } = rig(quadratic, (size, call) => (size === 128 * K && call >= 1 ? 3 : 1));
    await expect(expectLinearTime({ shape: 'quadratic', sizes: doubling(16 * K, 1024 * K), measure, slack: 25 })).rejects.toThrow();
  });

  it('names the shape and lists every sample of both sizes when it fails', async () => {
    const { measure, samples } = rig(quadratic, (size, call) => 1 + call / 100);
    const failure = await expectLinearTime({ shape: "'[a](' repeated", sizes: doubling(16 * K, 1024 * K), measure, slack: 25 }).then(
      () => null,
      (error) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("'[a](' repeated");
    for (const size of [128 * K, 256 * K]) {
      expect(samples.get(size).length).toBeGreaterThan(1);
      for (const sample of samples.get(size)) expect(failure.message).toContain(sample.toFixed(1));
    }
  });
});

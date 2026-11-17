import { describe, expect, it } from 'vitest';
import { SEARCH_SIZES, payloadBudgetProblems, searchBudgetProblems } from './measure-converter.mjs';

const FULL_CAP = 2 * 1024 * 1024;
const OPS = ['indexCpuMs', 'searchCpuMs', 'headingsCpuMs'];

/** A search size as measureSearchCase records it: per op, the median and the max of its samples. */
function size(chars, samples) {
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const record = { chars, maxCpuMs: {} };
  for (const op of OPS) {
    const values = samples[op] ?? samples.all;
    record[op] = median(values);
    record.maxCpuMs[op] = Math.max(...values);
  }
  return record;
}

const quiet = { all: [0, 10, 0] };
/** One family: every size within budget, the warm doc found again after the adversarial requests. */
function family(overrides = {}) {
  return {
    name: 'open brackets [',
    sizes: [size(200_000, quiet), size(400_000, quiet), size(FULL_CAP, quiet)],
    warm: { snippet: 'quokka', after: { snippet: 'quokka', cpuMs: 0 } },
    ...overrides,
  };
}

describe('searchBudgetProblems', () => {
  it('passes a family whose every sample is within budget', () => {
    expect(searchBudgetProblems([family()])).toEqual([]);
  });

  it('measures every opener family at the 2 MB note cap', () => {
    expect(SEARCH_SIZES).toContain(FULL_CAP);
    expect(searchBudgetProblems([family({ sizes: [size(200_000, quiet), size(400_000, quiet)] })]).join('\n')).toMatch(/2097152 chars/);
  });

  it('fails a family over budget only at the full cap', () => {
    const problems = searchBudgetProblems([family({ sizes: [size(200_000, quiet), size(400_000, quiet), size(FULL_CAP, { all: [150, 150, 150] })] })]);
    expect(problems.join('\n')).toMatch(/2097152 chars: indexCpuMs/);
  });

  it('fails one slow sample of three, though the median is within budget', () => {
    for (const op of OPS) {
      const spiky = size(400_000, { all: [0, 0, 0], [op]: [20, 20, 150] });
      const problems = searchBudgetProblems([family({ sizes: [size(200_000, quiet), spiky, size(FULL_CAP, quiet)] })]);
      expect(problems.join('\n')).toMatch(new RegExp(`400000 chars: ${op} .*150 ms`));
    }
  });

  it('fails when the ordinary search after the adversarial requests returns a wrong result', () => {
    const problems = searchBudgetProblems([family({ warm: { snippet: 'quokka', after: { snippet: '[[[[', cpuMs: 0 } } })]);
    expect(problems.join('\n')).toMatch(/after the adversarial requests/);
  });

  it('fails when the ordinary search after the adversarial requests is over budget', () => {
    const problems = searchBudgetProblems([family({ warm: { snippet: 'quokka', after: { snippet: 'quokka', cpuMs: 150 } } })]);
    expect(problems.join('\n')).toMatch(/after the adversarial requests.*150 ms/);
  });

  it('fails when no ordinary search followed the adversarial requests', () => {
    expect(searchBudgetProblems([family({ warm: { snippet: 'quokka' } })]).join('\n')).toMatch(/after the adversarial requests/);
  });
});

const KB_PER_MB = 1024;
const BASE_MB = 410;
/**
 * A payload note: `rssMb` is the single pre-round delta to the 20 ms peak that the gate read before T3.B21; `rss` holds
 * the samples it reads now (a settled baseline after a warm-up round, settled samples after each measured round, the peak).
 */
function payloadNote(blocks, { rssMb, settled, peak }) {
  const kb = (mb) => Math.round((BASE_MB + mb) * KB_PER_MB);
  return {
    blocks,
    frames: blocks * 2,
    frameCpuMs: 0.8,
    held: Math.min(blocks, 256),
    widestAck: blocks / 12,
    foreign: 0,
    rssMb,
    rss: { baselineKb: [0.4, -0.3, 0.1, 0, 0.2].map(kb), settledKb: settled.map((round) => round.map(kb)), peakKb: kb(peak) },
  };
}

describe('payloadBudgetProblems', () => {
  const small = payloadNote(300, { rssMb: 12.1, settled: [[8.2, 8.4, 8.1, 8.3, 8.2], [9.0, 9.1, 8.9, 9.2, 9.0]], peak: 12.1 });

  it('gives one verdict for two runs of the same code whose peaks straddle the budget', () => {
    // The same settled growth; one run's 20 ms sampler caught a transient spike past 64 MB, the other's did not.
    const quiet = payloadNote(3_000, { rssMb: 61.8, settled: [[30.1, 30.6, 29.8, 30.4, 30.2], [33.9, 34.2, 33.7, 34.4, 34.0]], peak: 61.8 });
    const spiked = payloadNote(3_000, { rssMb: 66.4, settled: [[30.3, 30.0, 30.9, 30.2, 30.5], [34.1, 33.8, 34.6, 34.0, 34.3]], peak: 66.4 });
    const verdicts = [quiet, spiked].map((large) => payloadBudgetProblems([small, large]));
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[0]).toEqual([]);
  });

  it('fails sustained growth past the budget', () => {
    const growing = payloadNote(3_000, { rssMb: 95, settled: [[45, 46, 44, 45, 47], [88, 90, 89, 91, 90]], peak: 95 });
    expect(payloadBudgetProblems([small, growing]).join('\n')).toMatch(/3000 ids: RSS grew/);
  });

  it('fails a catastrophic peak even when memory settles back', () => {
    const blowup = payloadNote(3_000, { rssMb: 400, settled: [[30, 30, 30, 30, 30], [32, 32, 32, 32, 32]], peak: 400 });
    expect(payloadBudgetProblems([small, blowup]).join('\n')).toMatch(/3000 ids: RSS peaked/);
  });

  it('fails more payload docs held than the bound', () => {
    const held = { ...payloadNote(3_000, { rssMb: 30, settled: [[30], [30]], peak: 30 }), held: 257 };
    expect(payloadBudgetProblems([small, held]).join('\n')).toMatch(/257 payload docs held/);
  });
});

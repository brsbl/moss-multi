import { describe, expect, it } from 'vitest';
import { fileMinutesIn, percentile, recordProblems, summarize } from './durations.mjs';

const leg = (projectName, duration) => ({ projectName, results: [{ duration }] });

describe('durations', () => {
  it('takes nearest-rank percentiles', () => {
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10);
  });

  it('sums journey legs per file and leaves the selftests out', () => {
    const report = {
      suites: [
        { file: 'journeys/j01-undo.spec.ts', specs: [{ file: 'journeys/j01-undo.spec.ts', tests: [leg('webkit', 60_000), leg('webkit', 30_000)] }] },
        { file: 'selftest/lib.spec.ts', specs: [{ file: 'selftest/lib.spec.ts', tests: [leg('selftest-webkit', 60_000)] }] },
      ],
    };
    expect(fileMinutesIn(report)).toEqual({ 'j01-undo.spec.ts': 1.5 });
  });

  it("records each file's p95 per engine and the shard's fixed cost as the job less its journeys", () => {
    const sample = (engine, jobMinutes, value) => ({ engine, jobMinutes, files: { 'j01-undo.spec.ts': value }, legs: { 'j01-undo.spec.ts': 4 } });
    expect(summarize([sample('chromium', 3, 1), sample('chromium', 5, 2), sample('webkit', 6, 2), sample('webkit', 4, 3)])).toEqual({
      setup: { chromium: 3, webkit: 4 },
      perLeg: { chromium: 0.5, webkit: 0.75 },
      journeys: { 'j01-undo.spec.ts': { legs: 4, chromium: 2, webkit: 3 } },
    });
  });

  it('refuses to write a record from incomplete samples', () => {
    const sample = (engine) => ({ engine, jobMinutes: 3, files: { 'j01-undo.spec.ts': 1 }, legs: { 'j01-undo.spec.ts': 4 } });
    expect(recordProblems(summarize([sample('chromium'), sample('webkit')]), [])).toEqual([]);
    expect(recordProblems(summarize([sample('chromium'), sample('webkit')]), ['run 1 webkit/editing: no artifact'])).toEqual(['run 1 webkit/editing: no artifact']);
    expect(recordProblems(summarize([]), [])).toEqual(['no setup minutes for chromium', 'no setup minutes for webkit', 'no per-leg rate for chromium', 'no per-leg rate for webkit', 'no journey minutes']);
  });
});

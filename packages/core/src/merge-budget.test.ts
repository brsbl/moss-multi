// T7.S2: a push's merge runs on one budget. Every diff it makes draws on the same time and work, so a push with many
// changed regions on a drifted doc cannot multiply the per-diff time limit; past the budget the merge is refused,
// never landed in part. A degenerate push is refused before the region merge runs. Time here is a simulated clock
// that each diff advances, so the counts are deterministic. @p:agt-1 @p:tech-5
import { makeDiff } from '@sanity/diff-match-patch';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeMergedTarget, DIFF_CALL_WORK, MERGE_TIME_MS, mergeBudget, MergeBudgetExceeded } from './merge.ts';

vi.mock('@sanity/diff-match-patch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sanity/diff-match-patch')>();
  return { ...actual, makeDiff: vi.fn(actual.makeDiff) };
});
const diff = vi.mocked(makeDiff);

/** `regions` lines changed by the person and `regions` by the push, interleaved, so no two edits overlap. */
function interleaved(regions: number): { base: string; current: string; next: string } {
  const lines = Array.from({ length: regions * 2 + 1 }, (_, i) => `line ${i} of the note`);
  return {
    base: lines.join('\n'),
    current: lines.map((line, i) => (i % 2 === 0 ? `${line} (person)` : line)).join('\n'),
    next: lines.map((line, i) => (i % 2 === 1 ? `${line} (agent)` : line)).join('\n'),
  };
}

const realDiff = diff.getMockImplementation()!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(0);
  diff.mockClear();
});

afterEach(() => {
  diff.mockImplementation(realDiff);
  vi.useRealTimers();
});

describe('a push merge runs on one budget @p:agt-1', () => {
  it('lands an ordinary drifted push with many regions inside the default budget', () => {
    const { base, current, next } = interleaved(500);
    const merge = computeMergedTarget(current, base, next);
    expect(merge.failedHunks).toEqual([]);
    expect(merge.target).toBe(current.split('\n').map((line, i) => (i % 2 === 1 ? `${line} (agent)` : line)).join('\n'));
  });

  it('gives each diff only the time left in the push, and refuses once it is spent', () => {
    const STEP = 250;
    const calls: { at: number; timeout: number | undefined }[] = [];
    diff.mockImplementation((a, b, options) => {
      calls.push({ at: Date.now(), timeout: options?.timeout });
      const result = realDiff(a, b, options);
      vi.setSystemTime(Date.now() + STEP); // each diff runs a quarter second
      return result;
    });
    const { base, current, next } = interleaved(2000);
    expect(() => computeMergedTarget(current, base, next)).toThrow(MergeBudgetExceeded);
    expect(calls.length, 'diffs stop once the push budget is spent').toBeLessThanOrEqual(Math.ceil(MERGE_TIME_MS / STEP));
    expect(Date.now(), 'the whole merge stays within the budget plus one diff').toBeLessThanOrEqual(MERGE_TIME_MS + STEP);
    for (const { at, timeout } of calls) {
      expect(timeout, 'every diff gets an explicit time limit').toBeGreaterThan(0);
      expect(timeout! * 1000, 'no diff may run past the push deadline').toBeLessThanOrEqual(MERGE_TIME_MS - at);
    }
  });

  it('counts work across regions: a small budget refuses after a bounded number of diffs', () => {
    const { base, current, next } = interleaved(2000);
    const WORK = 400_000; // the whole-text diffs fit; a few hundred regions do not
    const budget = mergeBudget(WORK);
    expect(() => computeMergedTarget(current, base, next, { budget })).toThrow(MergeBudgetExceeded);
    expect(budget.work, 'never overdrawn').toBeGreaterThanOrEqual(0);
    expect(diff.mock.calls.length, 'the regions drew on the budget').toBeGreaterThan(3);
    expect(diff.mock.calls.length, 'each diff is charged, so the count is bounded').toBeLessThanOrEqual(WORK / DIFF_CALL_WORK);
  });

  it('refuses a degenerate push before diffing the regions, and merges it when forced', () => {
    const { base, current } = interleaved(2000);
    const refused = computeMergedTarget(current, base, '', { refuseDegenerate: true });
    expect(refused).toMatchObject({ degenerate: true, target: current, failedHunks: [] });
    expect(diff.mock.calls.length, 'only the deletion ratio is diffed').toBe(1);
    diff.mockClear();
    const forced = computeMergedTarget(current, base, '');
    expect(forced.degenerate).toBe(false);
    expect(diff.mock.calls.length).toBeGreaterThan(1);
  });
});

// T7.S2: a push's merge runs on one budget of diff search steps, counted, never timed: on deployed Workers the clock
// stands still during synchronous code. Every diff draws on the same budget, so many changed regions on a drifted doc
// cannot each restart a limit; past it a drifted merge is refused, never landed in part, and an undrifted push still
// lands. A degenerate push is refused before the doc's own edits are diffed. @p:agt-1 @p:tech-5
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeMergedTarget, MERGE_WORK, mergeBudget, MergeBudgetExceeded, type MergeBudget } from './merge.ts';

/** A seeded xorshift, so every run builds the same texts. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/** `count` paragraphs of `size` random letters, and each with every `every`th letter redrawn: costly to diff. */
function mutated(count: number, size: number, every: number): { base: string; next: string } {
  const next = random(7);
  const letters = (n: number): string => Array.from({ length: n }, () => 'abcd'[Math.floor(next() * 4)]).join('');
  const paragraphs = Array.from({ length: count }, (_, i) => `Paragraph ${i} ${letters(size)}`);
  const pushed = paragraphs.map((text) => [...text].map((c, i) => (i > 12 && i % every === 0 ? 'abcd'[Math.floor(next() * 4)] : c)).join(''));
  return { base: ['Intro.', ...paragraphs].join('\n\n'), next: ['Intro.', ...pushed].join('\n\n') };
}

/** `regions` lines changed by the person and `regions` by the push, interleaved, so no two edits overlap. */
function interleaved(regions: number): { base: string; current: string; next: string } {
  const lines = Array.from({ length: regions * 2 + 1 }, (_, i) => `line ${i} of the note`);
  return {
    base: lines.join('\n'),
    current: lines.map((line, i) => (i % 2 === 0 ? `${line} (person)` : line)).join('\n'),
    next: lines.map((line, i) => (i % 2 === 1 ? `${line} (agent)` : line)).join('\n'),
  };
}

const spent = (budget: MergeBudget): number => MERGE_WORK - budget.work;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a push merge runs on one counted budget @p:agt-1', { timeout: 60_000 }, () => {
  it('never reads a clock, so the bound holds where time stands still, as on deployed Workers', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    const precise = vi.spyOn((globalThis as unknown as { performance: { now: () => number } }).performance, 'now').mockReturnValue(0);
    // Two unrelated lines: an exact diff is quadratic, so only a limit on the search itself ends it.
    const letters = random(3);
    const line = (): string => Array.from({ length: 20_000 }, () => 'ab'[Math.floor(letters() * 2)]).join('');
    const base = line();
    const budget = mergeBudget();
    const merge = computeMergedTarget(`${base}\n\nTyped by a person.`, base, line(), { budget });
    expect(now, 'Date.now does not move on Workers').not.toHaveBeenCalled();
    expect(precise, 'nor does performance.now').not.toHaveBeenCalled();
    expect(merge.target).toContain('Typed by a person.');
    expect(spent(budget)).toBeLessThanOrEqual(MERGE_WORK);
  });

  it('charges the search, so a line changed in many places costs more than the same line changed once', () => {
    const words = Array.from({ length: 2_000 }, (_, i) => `w${String(i).padStart(4, '0')}`);
    const base = words.join(' ');
    const current = `${base}\n\nTyped by a person.`;
    const cost = (next: string): number => {
      const budget = mergeBudget();
      computeMergedTarget(current, base, next, { budget });
      return spent(budget);
    };
    const once = cost(words.map((word, i) => (i === 1_000 ? 'WORD!' : word)).join(' '));
    const often = cost(words.map((word, i) => (i % 10 === 0 ? 'WORD!' : word)).join(' '));
    expect(once, 'one change is cheap').toBeLessThan(10_000);
    expect(often, 'two hundred changes in the same length cost far more').toBeGreaterThan(20 * once);
  });

  it('refuses a drifted push with many costly regions once the budget is spent, never overdrawn, the same every run', () => {
    const { base, next } = mutated(200, 1_000, 5);
    const current = base.replace('Intro.', 'Intro, typed by a person.');
    const left: number[] = [];
    for (let run = 0; run < 2; run++) {
      const budget = mergeBudget();
      expect(() => computeMergedTarget(current, base, next, { budget })).toThrow(MergeBudgetExceeded);
      expect(budget.work, 'never overdrawn').toBeGreaterThanOrEqual(0);
      expect(spent(budget), 'it ran until the budget was nearly spent, not refused up front').toBeGreaterThan(MERGE_WORK / 2);
      left.push(budget.work);
    }
    expect(left[1], 'deterministic').toBe(left[0]);
    // Undrifted, the same push lands as pushed: its edits need not be exact.
    const budget = mergeBudget();
    expect(computeMergedTarget(base, base, next, { budget })).toMatchObject({ target: next, failedHunks: [] });
    expect(budget.work).toBeGreaterThanOrEqual(0);
  });

  it('lands a large doc with thousands of scattered edits well inside the budget, and does not take it for a deletion', () => {
    const paragraphs = Array.from({ length: 12_000 }, (_, i) => `Row ${i} is steady text.`);
    const base = paragraphs.join('\n\n');
    const current = base.replace('Row 0 is', 'Row 0, typed, is');
    const next = paragraphs.map((text, i) => (i % 2 ? text.replace('steady', 'agent-edited') : text)).join('\n\n');
    const budget = mergeBudget();
    const merge = computeMergedTarget(current, base, next, { budget, refuseDegenerate: true });
    expect(merge).toMatchObject({ degenerate: false, failedHunks: [], applied: 6_000 });
    expect(merge.deletedRatio).toBeLessThan(0.1);
    expect(merge.target).toBe(current.split('\n\n').map((text, i) => (i % 2 ? text.replace('steady', 'agent-edited') : text)).join('\n\n'));
    expect(spent(budget)).toBeLessThan(MERGE_WORK / 4);
  });

  it('lands an ordinary drifted push with many regions using a small share of the budget', () => {
    const { base, current, next } = interleaved(300);
    const budget = mergeBudget();
    const merge = computeMergedTarget(current, base, next, { budget });
    expect(merge.failedHunks).toEqual([]);
    expect(merge.target).toBe(current.split('\n').map((line, i) => (i % 2 === 1 ? `${line} (agent)` : line)).join('\n'));
    expect(spent(budget)).toBeLessThan(MERGE_WORK / 20);
  });

  it('refuses a degenerate push before diffing the doc\'s own edits, and merges it when forced', () => {
    // The person's side is too costly to diff: only the early refusal answers without running out.
    const { base, next: current } = mutated(200, 1_000, 5);
    const most = 'Intro.';
    expect(computeMergedTarget(current, base, most, { refuseDegenerate: true })).toMatchObject({ degenerate: true, target: current, failedHunks: [] });
    expect(() => computeMergedTarget(current, base, most), 'forced, both sides are diffed').toThrow(MergeBudgetExceeded);
  });
});

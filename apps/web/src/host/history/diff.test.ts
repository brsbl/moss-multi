// T6.S8: Diff vs current shares one Myers work budget across the line diff and every word refinement, and renders
// coarse spans once it is spent, so hundreds of rewritten paragraphs cannot freeze the render that computes them.
import { describe, expect, it } from 'vitest';
import { DIFF_WORK_BUDGET, diffText, type DiffBudget, type DiffSpan } from './diff.ts';

const side = (spans: DiffSpan[], drop: DiffSpan['kind']) => spans.filter((s) => s.kind !== drop).map((s) => s.text).join('');

function paragraph(seed: number, prefix: string, words = 100): string {
  return Array.from({ length: words }, (_, i) => `${prefix}${seed}.${i}`).join(' ');
}

describe('diffText work budget', () => {
  it('bounds the aggregate steps for hundreds of rewritten regions and falls back to coarse spans', () => {
    // 400 paragraphs, each rewritten word by word, separated by unchanged lines so each is its own region.
    const oldParas = Array.from({ length: 400 }, (_, i) => paragraph(i, 'old'));
    const newParas = Array.from({ length: 400 }, (_, i) => paragraph(i, 'new'));
    const oldText = oldParas.map((p, i) => `keep ${i}\n${p}\n`).join('');
    const newText = newParas.map((p, i) => `keep ${i}\n${p}\n`).join('');

    const budget: DiffBudget = { used: 0 };
    const spans = diffText(oldText, newText, budget);

    expect(budget.used).toBeGreaterThan(0);
    expect(budget.used).toBeLessThanOrEqual(DIFF_WORK_BUDGET);
    // Every span still reconstructs both sides.
    expect(side(spans, 'insert')).toBe(oldText);
    expect(side(spans, 'delete')).toBe(newText);
    // The first regions are still refined word by word.
    expect(spans.slice(0, 2)).toEqual([
      { kind: 'equal', text: 'keep 0\n' },
      { kind: 'delete', text: oldParas[0]!.split(' ')[0] },
    ]);
    // Once spent, the last region is one coarse delete and insert of its whole line.
    expect(spans.slice(-3)).toEqual([
      { kind: 'equal', text: 'keep 399\n' },
      { kind: 'delete', text: `${oldParas[399]}\n` },
      { kind: 'insert', text: `${newParas[399]}\n` },
    ]);
  });

  it('bounds one region whose edit distance passes the cap', () => {
    const oldText = Array.from({ length: 3000 }, (_, i) => `a${i}\n`).join('');
    const newText = Array.from({ length: 3000 }, (_, i) => `b${i}\n`).join('');
    const budget: DiffBudget = { used: 0 };
    const spans = diffText(oldText, newText, budget);
    expect(budget.used).toBeGreaterThan(0);
    expect(budget.used).toBeLessThanOrEqual(DIFF_WORK_BUDGET);
    expect(spans).toEqual([
      { kind: 'delete', text: oldText },
      { kind: 'insert', text: newText },
    ]);
  });

  it('leaves a small diff unchanged', () => {
    expect(diffText('Title\nalpha beta gamma\ntail\n', 'Title\nalpha delta gamma\ntail\n')).toEqual([
      { kind: 'equal', text: 'Title\nalpha ' },
      { kind: 'delete', text: 'beta' },
      { kind: 'insert', text: 'delta' },
      { kind: 'equal', text: ' gamma\ntail\n' },
    ]);
    expect(diffText('a\nb\n', 'a\nx\nb\n')).toEqual([
      { kind: 'equal', text: 'a\n' },
      { kind: 'insert', text: 'x\n' },
      { kind: 'equal', text: 'b\n' },
    ]);
  });
});

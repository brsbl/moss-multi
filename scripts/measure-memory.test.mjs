import { describe, expect, it } from 'vitest';
import { gcEvents, kindCosts, median, memoryProblems, mergeShapeRuns, phaseFigures, REST_BUDGET_MB } from './measure-memory.mjs';

const LOG = [
  '[123:0x7f00]     1200 ms: Scavenge 30.5 (40.0) -> 22.1 (41.0) MB, pooled: 0 MB, 3.10 / 0.00 ms  (average mu = 1.000, current mu = 1.000) allocation failure;',
  'some other line',
  '[123:0x7f00]     1500 ms: Mark-Compact 81.2 (90.0) -> 64.3 (88.0) MB, pooled: 0 MB, 40.10 / 0.00 ms  (average mu = 0.9, current mu = 0.8) allocation failure; GC in old space requested',
  '[123:0x7f00]     1600 ms: Mark-Compact (reduce) 70.0 (90.0) -> 50.5 (60.0) MB, pooled: 0 MB, 30.10 / 0.00 ms  (average mu = 0.9, current mu = 0.8) testing; GC in old space requested',
].join('\n');

describe('gcEvents and phaseFigures', () => {
  it('reads every GC line and marks gc() collections', () => {
    expect(gcEvents(LOG)).toEqual([
      { kind: 'Scavenge', before: 30.5, after: 22.1, testing: false },
      { kind: 'Mark-Compact', before: 81.2, after: 64.3, testing: false },
      { kind: 'Mark-Compact (reduce)', before: 70, after: 50.5, testing: true },
    ]);
  });

  it('gives the highest heap before a GC, the highest after a full GC, and the last full GC as rest', () => {
    expect(phaseFigures(gcEvents(LOG))).toEqual({ highMb: 81.2, liveMb: 64.3, restMb: 50.5 });
  });
});

describe('memoryProblems', () => {
  const ok = { measured: { phases: { export: { restMb: 20 } } }, capped: { phases: {} } };

  it('passes notes that fit the cap and rest under budget', () => {
    expect(memoryProblems([{ name: 'a', ...ok }])).toEqual([]);
  });

  it('fails a phase that does not fit the capped heap, a note heavy at rest, and an unmeasured note', () => {
    const problems = memoryProblems([
      { name: 'capped', ...ok, capped: { failed: { phase: 'create', message: 'Fatal JavaScript out of memory' } } },
      { name: 'heavy', measured: { phases: { export: { restMb: REST_BUDGET_MB + 1 } } }, capped: { phases: {} } },
      { name: 'lost', measured: { failed: { phase: 'start', message: 'workerd exited' } }, capped: { phases: {} } },
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^capped: the create does not fit a 96 MB heap/);
    expect(problems[1]).toMatch(/^heavy: the note at rest holds/);
    expect(problems[2]).toMatch(/^lost: not measured/);
  });
});

describe('kindCosts and median', () => {
  it('gives the heap per struct a shape adds over its base, and per block', () => {
    const shapes = [
      { shape: 'XmlText', n: 1_000, structs: 1_000, mb: 1 },
      { shape: 'XmlText + 7 entries', n: 1_000, structs: 8_000, mb: 2 },
    ];
    const costs = kindCosts(shapes);
    const block = costs.find((cost) => cost.shape === 'XmlText');
    expect(block.perStruct).toBeCloseTo(2 ** 20 / 1_000);
    expect(block.structsPerBlock).toBe(1);
    const entries = costs.find((cost) => cost.shape === 'XmlText + 7 entries' && cost.base === 'XmlText');
    expect(entries.structsPerBlock).toBe(7);
    expect(entries.perStruct).toBeCloseTo(2 ** 20 / 7_000);
    expect(entries.perBlock).toBeCloseTo(2 ** 20 / 1_000);
    expect(costs.find((cost) => cost.shape === 'XmlText + string').missing).toBe(true);
  });

  it("takes the median of each shape's rounds across processes", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const shape = (rounds) => ({ shape: 'XmlText', n: 10, structs: 10, kinds: {}, rounds });
    const merged = mergeShapeRuns([{ shapes: [shape([1, 2])] }, { shapes: [shape([4, 3])], failed: 'lost' }]);
    expect(merged.shapes).toHaveLength(1);
    expect(merged.shapes[0].processes).toEqual([[1, 2], [4, 3]]);
    expect(merged.shapes[0].mb).toBe(2.5);
    expect(merged.failed).toBe('lost');
  });
});

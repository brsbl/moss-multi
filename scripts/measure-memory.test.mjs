import { describe, expect, it } from 'vitest';
import { CREATE_BUDGET, EXPORT_BUDGET, gcEvents, memoryProblems, NEED_RUNS, phaseFigures, ratio, reliableCap, smallestCap, STRUCT_BOUNDS } from './measure-memory.mjs';

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

describe('memoryProblems: relative budgets', () => {
  const REST = 100;
  const note = (name, needs, extra = {}) => ({
    name,
    budget: true,
    needs,
    plain: { phases: { save: { restMb: REST } } },
    measured: { phases: {} },
    ...extra,
  });

  it('passes notes whose create and export stay within their multiples of the note at rest', () => {
    expect([CREATE_BUDGET, EXPORT_BUDGET]).toEqual([1.45, 1.6]);
    expect(memoryProblems([note('a', { create: 145, wake: 500, export: 160 })])).toEqual([]);
  });

  it('fails a create or an export over its multiple, and a need never found', () => {
    const problems = memoryProblems([
      note('create', { create: 147, export: REST }),
      note('export', { create: REST, export: 162 }),
      note('lost', { create: null, export: REST }),
    ]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^create: the create needs 147 MB, 1\.47x the note at rest \(100 MB\), over 1\.45x/);
    expect(problems[1]).toMatch(/^export: the export needs 162 MB, 1\.62x .* over 1\.6x/);
    expect(problems[2]).toMatch(/^lost: the create's need is unknown/);
  });

  it('holds only budgeted notes to the multiples, and fails any note whose run failed', () => {
    expect(memoryProblems([note('small', { create: REST * 3, export: REST * 3 }, { budget: false })])).toEqual([]);
    const failed = note('failed', { create: REST, export: REST }, { budget: false, plain: { failed: { phase: 'create', message: 'workerd exited' } } });
    expect(memoryProblems([failed])).toEqual(['failed: the untraced run failed (create: workerd exited)']);
  });

  it('reads the note at rest from the untraced run, whose figures no in-phase gc() inflates', () => {
    const traced = { phases: { save: { restMb: REST * 2 } } };
    expect(memoryProblems([note('n', { create: REST * 1.5, export: REST }, { measured: traced })])).toHaveLength(1);
  });

  it('gives the ratio only when both figures are known', () => {
    expect(ratio(150, 100)).toBe(1.5);
    expect(ratio(null, 100)).toBeNull();
    expect(ratio(150, undefined)).toBeNull();
  });
});

describe('memoryProblems: structs per block', () => {
  const note = (name, block, blocks) => ({ name, budget: false, block, plain: { phases: {}, blocks }, measured: { phases: {} } });

  it('holds a paragraph to 5 structs, a list item to 6 and a two-cell table row to 16', () => {
    expect(STRUCT_BOUNDS).toEqual({ paragraph: 5, 'list item': 6, 'table row': 16 });
    expect(memoryProblems([
      note('p', 'paragraph', { median: 5, mean: 5, blocks: 10 }),
      note('l', 'list item', { median: 6, mean: 6, blocks: 10 }),
      note('t', 'table row', { median: 16, mean: 16, blocks: 10 }),
      note('mixed', null, { median: 40, mean: 40, blocks: 10 }),
    ])).toEqual([]);
  });

  it('fails a note whose blocks cost more, or whose count is missing', () => {
    expect(memoryProblems([note('p', 'paragraph', { median: 15, mean: 15, blocks: 10 }), note('lost', 'table row', undefined)])).toEqual([
      'p: a paragraph costs 15 structs, over 5',
      'lost: its structs per block are unknown',
    ]);
  });
});

describe('smallestCap', () => {
  const needing = (need) => {
    const probes = [];
    const fits = async (cap) => {
      probes.push(cap);
      return cap >= need;
    };
    return { fits, probes };
  };

  it('bisects to within 2 MB above the need', async () => {
    const { fits } = needing(131);
    const cap = await smallestCap(fits, 87, 197);
    expect(cap).toBeGreaterThanOrEqual(131);
    expect(cap).toBeLessThanOrEqual(133);
  });

  it('lowers a low bound that already fits and raises a high bound that does not', async () => {
    expect(await smallestCap(needing(20).fits, 40, 60)).toBeLessThanOrEqual(22);
    const high = await smallestCap(needing(300).fits, 90, 120);
    expect(high).toBeGreaterThanOrEqual(300);
    expect(high).toBeLessThanOrEqual(302);
  });

  it('gives up past the ceiling', async () => {
    expect(await smallestCap(async () => false, 90, 120)).toBeNull();
  });
});

describe('reliableCap', () => {
  it('steps up past a cap that fits only some of the time', async () => {
    // Fits from 100 MB, but 100 and 101 MB fail every other try.
    const tries = new Map();
    const fits = async (cap) => {
      tries.set(cap, (tries.get(cap) ?? 0) + 1);
      if (cap < 100) return false;
      if (cap < 102) return tries.get(cap) % 2 === 1;
      return true;
    };
    const cap = await reliableCap(fits, 60, 140);
    expect(cap).toBeGreaterThanOrEqual(102);
    expect(cap).toBeLessThanOrEqual(104);
  });

  it('returns a cap only once it fit in each of its runs', async () => {
    const results = new Map();
    const fits = async (cap) => {
      const ok = cap >= 100;
      results.set(cap, [...(results.get(cap) ?? []), ok]);
      return ok;
    };
    const cap = await reliableCap(fits, 60, 140);
    expect(results.get(cap)).toEqual(Array.from({ length: NEED_RUNS }, () => true));
  });
});

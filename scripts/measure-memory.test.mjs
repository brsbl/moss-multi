import { describe, expect, it } from 'vitest';
import { gcEvents, memoryProblems, phaseFigures, reliableCap, REST_BUDGET_MB, smallestCap } from './measure-memory.mjs';

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

describe('memoryProblems reads the note at rest from the untraced run', () => {
  it('prefers the untraced run, whose figures no in-phase gc() inflates', () => {
    const note = {
      name: 'n',
      measured: { phases: { export: { restMb: REST_BUDGET_MB + 50 } } },
      plain: { phases: { export: { restMb: REST_BUDGET_MB - 1 } } },
      capped: { phases: {} },
    };
    expect(memoryProblems([note])).toEqual([]);
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
});

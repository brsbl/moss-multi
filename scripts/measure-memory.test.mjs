import { describe, expect, it } from 'vitest';
import { STRUCT_CAP, STRUCT_HEADROOM, TEXT_CHAR_CAP } from '../packages/protocol/src/limits.ts';
import { gcEvents, memoryProblems, NEED_RUNS, PHASE_LIMIT_MB, phaseFigures, reliableCap, REST_LIMIT_MB, smallestCap, stateAllowance, STRUCT_BOUNDS, STRUCT_CEILING } from './measure-memory.mjs';

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

describe('memoryProblems: absolute budgets at the caps', () => {
  /** What the save fed search: the note's whole body, as SearchDO receives it. */
  const FED = { docId: 'measure', bodyChars: 1_000 };
  const note = (name, needs, extra = {}) => ({
    name,
    budget: true,
    needs,
    plain: { phases: { save: { restMb: 40 } }, fed: FED },
    measured: { phases: {} },
    ...extra,
  });

  it('holds every phase to 96 MB less 10% and the note at rest to 64 MB less 10%', () => {
    expect([PHASE_LIMIT_MB, REST_LIMIT_MB]).toEqual([96 * 0.9, 64 * 0.9]);
    expect(memoryProblems([note('a', { create: 86, wake: 70, save: 72, export: 86 })])).toEqual([]);
  });

  it('fails a phase over its budget, a need never found, and a note at rest over its own', () => {
    const problems = memoryProblems([
      note('create', { create: 88, wake: 60, save: 60, export: 60 }),
      note('export', { create: 60, wake: 60, save: 60, export: 92 }),
      note('save', { create: 60, wake: 60, save: 90, export: 60 }),
      note('lost', { create: null, wake: 60, save: 60, export: 60 }),
      note('unsaved', { create: 60, wake: 60, export: 60 }),
      note('rest', { create: 60, wake: 60, save: 60, export: 60 }, { plain: { phases: { save: { restMb: 58 } }, fed: FED } }),
    ]);
    expect(problems).toEqual([
      'create: the create needs 88 MB, over 86.4 MB',
      'export: the export needs 92 MB, over 86.4 MB',
      'save: the save needs 90 MB, over 86.4 MB',
      "lost: the create's need is unknown",
      "unsaved: the save's need is unknown",
      'rest: at rest it takes 58 MB, over 57.6 MB',
    ]);
  });

  it('fails a note at a cap whose save fed search nothing, since its save then left out the export and the feed', () => {
    const unfed = (name, fed) => note(name, { create: 60, wake: 60, save: 60, export: 60 }, { plain: { phases: { save: { restMb: 40 } }, fed } });
    expect(memoryProblems([unfed('fed', FED)])).toEqual([]);
    expect(memoryProblems([unfed('none', null), unfed('empty', { docId: 'measure', bodyChars: 0 })])).toEqual([
      'none: its save fed search no entry of the note',
      'empty: its save fed search no entry of the note',
    ]);
  });

  it('holds a grown table\'s create (the largest table an import takes) and its save like any note\'s', () => {
    expect(memoryProblems([note('table', { create: 70, wake: 60, save: 62, export: 60 }, { grow: true })])).toEqual([]);
    expect(memoryProblems([note('table', { create: null, wake: 60, save: 62, export: 60 }, { grow: true })])).toEqual(["table: the create's need is unknown"]);
    expect(memoryProblems([note('table', { create: 90, wake: 60, save: 62, export: 60 }, { grow: true })])).toEqual(['table: the create needs 90 MB, over 86.4 MB']);
  });

  it('holds a note at a cap to within 2% under it, and its state to what its text and structs allow', () => {
    const sized = (name, size, extra) => note(name, { create: 60, wake: 60, save: 60, export: 60 }, {
      plain: { phases: { save: { restMb: 40 } }, fed: FED, size, stateBytes: 1_000 },
      ...extra,
    });
    expect(memoryProblems([
      sized('text', { chars: TEXT_CHAR_CAP, structs: 70_000 }, { cap: 'text', chars: TEXT_CHAR_CAP }),
      sized('structure', { chars: 400_000, structs: STRUCT_CAP - 8 }, { cap: 'structure' }),
    ])).toEqual([]);
    expect(memoryProblems([
      sized('over', { chars: TEXT_CHAR_CAP + 1, structs: 70_000 }, { cap: 'text' }),
      sized('short', { chars: 400_000, structs: Math.floor(STRUCT_CAP * 0.9) }, { cap: 'structure' }),
      sized('miscounted', { chars: TEXT_CHAR_CAP - 10, structs: 70_000 }, { cap: 'text', chars: TEXT_CHAR_CAP }),
    ])).toEqual([
      `over: it holds ${TEXT_CHAR_CAP + 1} characters, not at the cap of ${TEXT_CHAR_CAP}`,
      `short: it holds ${Math.floor(STRUCT_CAP * 0.9)} structs, not at the cap of ${STRUCT_CAP}`,
      `miscounted: it holds ${TEXT_CHAR_CAP - 10} characters where its markdown counts ${TEXT_CHAR_CAP}`,
    ]);
    const heavy = { chars: 10, structs: 10 };
    expect(memoryProblems([note('heavy', null, { budget: false, plain: { phases: {}, size: heavy, stateBytes: stateAllowance(heavy) + 1 } })]))
      .toEqual([`heavy: its state is ${stateAllowance(heavy) + 1} bytes, over the ${stateAllowance(heavy)} its text and structs allow`]);
  });

  it('holds a note past a cap to a refusal with that limit', () => {
    const past = (refused, got) => ({ name: `past ${refused}`, refused, plain: { phases: {}, refused: got }, measured: { phases: {} } });
    expect(memoryProblems([past('text', 'text'), past('structure', 'structure')])).toEqual([]);
    expect(memoryProblems([past('text', undefined), past('structure', 'state')])).toEqual([
      'past text: the create was not refused with the text limit (admitted)',
      'past structure: the create was not refused with the structure limit (state)',
    ]);
  });

  it('holds only budgeted notes to the budgets, and fails any note whose run failed', () => {
    expect(memoryProblems([note('small', { create: 300, export: 300 }, { budget: false })])).toEqual([]);
    const failed = note('failed', { create: 60, wake: 60, save: 60, export: 60 }, { budget: false, plain: { failed: { phase: 'create', message: 'workerd exited' } } });
    expect(memoryProblems([failed])).toEqual(['failed: the untraced run failed (create: workerd exited)']);
  });
});

describe('memoryProblems: notes at the structure ceiling (coordinator ruling 2)', () => {
  const FED = { docId: 'measure', bodyChars: 1_000 };
  const NEEDS = { create: 80, wake: 70, save: 90, export: 90 };
  const at = (name, needs, { structs = STRUCT_CEILING, rest = 60, deletions = { landed: 4_000, structs: STRUCT_CEILING, refused: 'structure' } } = {}) => ({
    name,
    budget: true,
    cap: 'ceiling',
    needs,
    plain: { phases: { save: { restMb: rest } }, fed: FED, size: { chars: 400_000, structs }, stateBytes: 1_000, deletions },
    measured: { phases: {} },
  });

  it('is the structure cap and 5% of it', () => {
    expect(STRUCT_CEILING).toBe(STRUCT_CAP + STRUCT_HEADROOM);
    expect(STRUCT_CEILING).toBe(173_250);
  });

  it('holds a note there to 96 MB a phase and 64 MB at rest: the headroom spends the budgets\' margin', () => {
    expect(memoryProblems([at('ceiling', { create: 80, wake: 70, save: 95, export: 96 }, { rest: 63 })])).toEqual([]);
  });

  it('fails one over those budgets, one short of the ceiling, and one whose deletions were not refused past it', () => {
    expect(memoryProblems([
      at('heavy', { create: 80, wake: 70, save: 98, export: 90 }, { rest: 65 }),
      at('short', NEEDS, { structs: STRUCT_CAP }),
      at('admitted', NEEDS, { deletions: { landed: 4_000, structs: STRUCT_CEILING, refused: null } }),
      at('stopped', NEEDS, { deletions: { landed: 0, structs: STRUCT_CAP, refused: 'structure within the headroom' } }),
    ])).toEqual([
      'heavy: at rest it takes 65 MB, over 64.0 MB',
      'heavy: the save needs 98 MB, over 96.0 MB',
      `short: it holds ${STRUCT_CAP} structs, not at the ceiling of ${STRUCT_CEILING}`,
      'admitted: the deletion past the ceiling was not refused with the structure limit (admitted)',
      'stopped: no deletion landed in the headroom',
      'stopped: the deletion past the ceiling was not refused with the structure limit (structure within the headroom)',
    ]);
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

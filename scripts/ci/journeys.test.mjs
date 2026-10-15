import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUPS, budgetProblems, countLegs, groupOf, journeyMatch, readJourneys, shardEstimates } from './journeys.mjs';

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journeyDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'journeys-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'nested'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe('groupOf', () => {
  it('puts each catalog journey in its group', () => {
    expect(groupOf('j00-shell.spec.ts')).toBe('shell');
    expect(groupOf('e2e/journeys/j07-auth.spec.ts')).toBe('shell');
    expect(groupOf('j00-roundtrip.spec.ts')).toBe('import');
    expect(groupOf('j00-persist.spec.ts')).toBe('editing');
    expect(groupOf('j01-editing.spec.ts')).toBe('editing');
    expect(groupOf('j01-new.spec.ts')).toBe('editing');
    expect(groupOf('j01-coedit.spec.ts')).toBe('coedit');
    expect(groupOf('j01-registers.spec.ts')).toBe('registers');
    expect(groupOf('j08-share.spec.ts')).toBe('share');
    expect(groupOf('j11-media.spec.ts')).toBe('media');
    expect(groupOf('j04-hibernation.spec.ts')).toBe('hibernation');
    expect(groupOf('j05-trash.spec.ts')).toBe('workspace');
    expect(groupOf('j18-agents.spec.ts')).toBe('cli');
    expect(groupOf('j18-other.spec.ts')).toBe('meaning');
  });

  it('matches whole name segments, and the longest prefix wins', () => {
    const groups = { a: ['j00'], b: ['j00-x'] };
    expect(groupOf('j00-x.spec.ts', groups)).toBe('b');
    expect(groupOf('j00-x-more.spec.ts', groups)).toBe('b');
    expect(groupOf('j00-y.spec.ts', groups)).toBe('a');
    expect(groupOf('j000-y.spec.ts', groups)).toBe(null);
    expect(groupOf('j00-xy.spec.ts', groups)).toBe('a');
  });

  it('leaves an unlisted journey in no group', () => {
    expect(groupOf('j99-new.spec.ts')).toBe(null);
  });
});

describe('readJourneys', () => {
  it('lists spec files with their group and whether any leg is @slow', () => {
    const dir = journeyDir({
      'j00-shell.spec.ts': "test('boots', async () => {});",
      'j00-persist.spec.ts': "test('holds one socket for 60 s @slow', async () => {});",
      'notes.md': '@slow',
    });
    expect(readJourneys(dir)).toEqual([
      { file: 'j00-persist.spec.ts', group: 'editing', slow: true, legs: 1 },
      { file: 'j00-shell.spec.ts', group: 'shell', slow: false, legs: 1 },
    ]);
  });

  it('places every journey in the suite in exactly one group', () => {
    const journeys = readJourneys();
    expect(journeys.length).toBeGreaterThan(0);
    expect(journeys.filter((journey) => journey.group === null)).toEqual([]);
    for (const { group } of journeys) expect(Object.keys(GROUPS)).toContain(group);
  });
});

describe('journeyMatch', () => {
  const dir = () =>
    journeyDir({
      'j00-shell.spec.ts': '',
      'j07-auth.spec.ts': '',
      'j00-roundtrip.spec.ts': '',
    });

  it("matches exactly the group's files, wherever Playwright roots the path", () => {
    const patterns = journeyMatch('shell', dir());
    const matches = (path) => patterns.some((pattern) => pattern.test(path));
    expect(matches('/w/e2e/journeys/j00-shell.spec.ts')).toBe(true);
    expect(matches('/w/e2e/journeys/j07-auth.spec.ts')).toBe(true);
    expect(matches('/w/e2e/journeys/j00-roundtrip.spec.ts')).toBe(false);
    expect(matches('/w/e2e/journeys/xj00-shell.spec.ts')).toBe(false);
  });

  it('refuses an unknown group and a group with no journeys, so a shard never runs empty', () => {
    expect(() => journeyMatch('nope', dir())).toThrow(/unknown journey group/);
    expect(() => journeyMatch('meaning', dir())).toThrow(/no journeys/);
  });
});

describe('shard budget', () => {
  const minutes = {
    setup: { chromium: 2, webkit: 3 },
    perLeg: { chromium: 0.5, webkit: 1 },
    journeys: {
      'j00-shell.spec.ts': { legs: 4, chromium: 1, webkit: 2 },
      'j07-auth.spec.ts': { legs: 2, chromium: 1, webkit: 1 },
    },
  };
  const journey = (file, legs) => ({ file, group: groupOf(file), slow: false, legs });

  it('counts declared legs, a looped declaration once, and never describe blocks or skipped legs', () => {
    const text = [
      "test.describe('group', () => {",
      "  test('one', async () => {});",
      '  for (const x of xs) test(`two ${x}`, async () => {});',
      '  test.fixme("three", async () => {});',
      "  test.skip('skipped', async () => {});",
      "  test.skip(cond, 'reason');",
      '});',
    ].join('\n');
    expect(countLegs(text)).toBe(2);
    expect(countLegs("test('a', () => {});\n  test.slow('b', () => {});")).toBe(2);
  });

  it("estimates a group as the shard's fixed cost plus its files, scaled by legs declared since they were measured", () => {
    const files = ['j00-shell.spec.ts', 'j07-auth.spec.ts'];
    expect(shardEstimates([journey(files[0], 8), journey(files[1], 1)], minutes)).toEqual([
      { group: 'shell', engine: 'chromium', minutes: 2 + 1 * 2 + 1, files },
      { group: 'shell', engine: 'webkit', minutes: 3 + 2 * 2 + 1, files },
    ]);
  });

  it('estimates a journey with no recorded minutes at the per-leg rate', () => {
    expect(shardEstimates([journey('j00-import.spec.ts', 3)], minutes).map((shard) => shard.minutes)).toEqual([2 + 1.5, 3 + 3]);
  });

  it('names the shard over budget and the files to split', () => {
    expect(budgetProblems([journey('j00-shell.spec.ts', 4)], minutes, 4.5)).toEqual([
      'webkit/shell is estimated at 5 min, over its 4.5: split j00-shell.spec.ts across groups in scripts/ci/journeys.mjs',
    ]);
    expect(budgetProblems([journey('j00-shell.spec.ts', 4)], minutes, 5)).toEqual([]);
  });

  it('fails a record whose minutes are missing instead of counting them as zero', () => {
    const broken = { ...minutes, setup: { ...minutes.setup, webkit: null } };
    expect(budgetProblems([journey('j00-shell.spec.ts', 4)], broken, 5)).toEqual([
      'webkit/shell has no recorded minutes: refresh scripts/ci/journey-minutes.json with scripts/ci/durations.mjs --write',
    ]);
  });
});

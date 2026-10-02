import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GROUPS, groupOf, journeyMatch, readJourneys } from './journeys.mjs';

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
    expect(groupOf('j00-roundtrip.spec.ts')).toBe('editing');
    expect(groupOf('j00-persist.spec.ts')).toBe('editing');
    expect(groupOf('j01-coedit.spec.ts')).toBe('editing');
    expect(groupOf('j05-trash.spec.ts')).toBe('workspace');
    expect(groupOf('j18-agents.spec.ts')).toBe('meaning');
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
      { file: 'j00-persist.spec.ts', group: 'editing', slow: true },
      { file: 'j00-shell.spec.ts', group: 'shell', slow: false },
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

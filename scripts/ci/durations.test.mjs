import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileMinutesIn, main, percentile, recordProblems, summarize } from './durations.mjs';

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

// B042: --write keeps the record unless every required shard of every run was read in both engines.
describe('durations --write', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const FILES = { editing: 'j01-undo.spec.ts', sharing: 'j08-share.spec.ts' };
  const report = (engine, file) => ({ suites: [{ specs: [{ file: `journeys/${file}`, tests: [leg(engine, 60_000)] }] }] });

  /** A stub gh serving runs whose jobs have the given conclusions, keyed `engine/group`. */
  function stubGh(runs) {
    return (args) => {
      const path = args[0] === 'api' ? args[1] : null;
      const runMatch = path && /actions\/runs\/(\d+)$/.exec(path);
      if (runMatch) return JSON.stringify({ head_sha: 'abc' });
      const jobsMatch = path && /actions\/runs\/(\d+)\/attempts\/1\/jobs/.exec(path);
      if (jobsMatch) {
        const jobs = Object.entries(runs[jobsMatch[1]]).map(([shard, conclusion]) => {
          const [engine, group] = shard.split('/');
          return { name: `e2e (${engine}, ${group})`, conclusion, started_at: '2026-10-01T00:00:00Z', completed_at: '2026-10-01T00:03:00Z' };
        });
        return JSON.stringify({ jobs });
      }
      if (args[0] === 'run' && args[1] === 'download') {
        const [, engine, group] = /^e2e-(\w+)-(\w+)-1$/.exec(args[args.indexOf('-n') + 1]);
        const out = join(args[args.indexOf('-D') + 1], 'e2e/test-results');
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, 'results.json'), JSON.stringify(report(engine, FILES[group])));
        return '';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
  }

  function minutesFile() {
    const dir = mkdtempSync(join(tmpdir(), 'durations-'));
    dirs.push(dir);
    const path = join(dir, 'journey-minutes.json');
    writeFileSync(path, '{"runs":[1],"setup":{},"perLeg":{},"journeys":{}}\n');
    return path;
  }

  const run = (runs) => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const file = minutesFile();
    const before = readFileSync(file);
    const code = main(['--write', '--repo', 'o/r', ...Object.keys(runs)], { gh: stubGh(runs), legsAt: () => 4, minutesFile: file });
    return { code, file, before, errors: errors.mock.calls.map((call) => String(call[0])) };
  };

  it('refuses a run whose required WebKit shard was cancelled or timed out, leaving the record byte-identical', () => {
    const { code, file, before, errors } = run({
      101: { 'chromium/editing': 'success', 'webkit/editing': 'success', 'chromium/sharing': 'success', 'webkit/sharing': 'cancelled' },
      102: { 'chromium/editing': 'success', 'webkit/editing': 'failure', 'chromium/sharing': 'success', 'webkit/sharing': 'timed_out' },
    });
    expect(code).toBe(1);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(errors).toEqual(expect.arrayContaining(['run 101 webkit/sharing: cancelled', 'run 102 webkit/sharing: timed_out', 'j08-share.spec.ts: sampled in chromium only']));
  });

  it('reports a file sampled in only one engine', () => {
    const sample = (engine, file) => ({ engine, jobMinutes: 3, files: { [file]: 1 }, legs: { [file]: 4 } });
    const samples = [sample('chromium', 'j01-undo.spec.ts'), sample('webkit', 'j01-undo.spec.ts'), sample('chromium', 'j08-share.spec.ts')];
    expect(recordProblems(summarize(samples), [], samples)).toEqual(['j08-share.spec.ts: sampled in chromium only']);
  });

  it('writes a record from complete runs', () => {
    const complete = { 'chromium/editing': 'success', 'webkit/editing': 'success', 'chromium/sharing': 'success', 'webkit/sharing': 'failure' };
    const { code, file } = run({ 101: complete, 102: complete });
    expect(code).toBe(0);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.runs).toEqual([101, 102]);
    expect(Object.keys(written.journeys)).toEqual(['j01-undo.spec.ts', 'j08-share.spec.ts']);
  });
});

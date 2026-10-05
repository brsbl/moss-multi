#!/usr/bin/env node
// Records journey minutes for the shard budget (T0.9d; scripts/ci/journeys.mjs). Reads the attempt-1 e2e shards of
// the given full-lane runs: each shard's results.json gives every journey file's minutes, and the job's duration less
// those gives the shard's fixed cost. Prints per-file p95s, the per-group estimates against the budget and the
// measured shard p95s; --write stores the p95s in scripts/ci/journey-minutes.json. Read-only gh calls.
// Usage: node scripts/ci/durations.mjs [--write] [--repo owner/name] <run id>...
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINES, MINUTES_FILE, SHARD_BUDGET_MINUTES, countLegs, readJourneys, shardEstimates } from './journeys.mjs';

/** Nearest-rank percentile, as METHOD's latency rows. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * Journey minutes per file in one Playwright JSON report: the journey projects only (selftests are fixed cost).
 * @returns {Record<string, number>}
 */
export function fileMinutesIn(report) {
  /** @type {Record<string, number>} */
  const files = {};
  const walk = (suite) => {
    for (const child of suite.suites ?? []) walk(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        if (!ENGINES.includes(test.projectName)) continue;
        const file = spec.file.split('/').pop();
        for (const result of test.results) files[file] = (files[file] ?? 0) + result.duration / 60_000;
      }
    }
  };
  for (const suite of report.suites ?? []) walk(suite);
  return files;
}

/**
 * Per-file p95s, the per-engine fixed cost and the per-leg rate from shard samples
 * `{ engine, jobMinutes, files: {file: minutes}, legs: {file: n} }`.
 */
export function summarize(samples) {
  const journeys = {};
  const byFile = new Map();
  for (const sample of samples) {
    for (const [file, value] of Object.entries(sample.files)) {
      const entry = byFile.get(file) ?? { legs: 0, chromium: [], webkit: [] };
      entry[sample.engine].push(value);
      entry.legs = Math.max(entry.legs, sample.legs[file] ?? 0);
      byFile.set(file, entry);
    }
  }
  for (const [file, entry] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    if (!entry.chromium.length || !entry.webkit.length) continue;
    journeys[file] = { legs: entry.legs, chromium: round(percentile(entry.chromium, 0.95)), webkit: round(percentile(entry.webkit, 0.95)) };
  }
  const setup = {};
  const perLeg = {};
  for (const engine of ENGINES) {
    const fixed = samples.filter((sample) => sample.engine === engine).map((sample) => sample.jobMinutes - Object.values(sample.files).reduce((a, b) => a + b, 0));
    setup[engine] = round(percentile(fixed, 0.95));
    const rates = Object.values(journeys).filter((entry) => entry.legs > 0).map((entry) => entry[engine] / entry.legs);
    perLeg[engine] = round(percentile(rates, 0.9));
  }
  return { setup, perLeg, journeys };
}

/** Why a summary may not replace the record: a shard whose report could not be read, or minutes it lacks. */
export function recordProblems(minutes, failures) {
  const problems = [...failures];
  for (const engine of ENGINES) if (!Number.isFinite(minutes.setup[engine])) problems.push(`no setup minutes for ${engine}`);
  for (const engine of ENGINES) if (!Number.isFinite(minutes.perLeg[engine])) problems.push(`no per-leg rate for ${engine}`);
  if (Object.keys(minutes.journeys).length === 0) problems.push('no journey minutes');
  return problems;
}

function gh(args, options = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

function legsAt(sha, file) {
  try {
    return countLegs(execFileSync('git', ['show', `${sha}:e2e/journeys/${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return 0;
  }
}

function collect(repo, runIds) {
  const samples = [];
  const shards = [];
  const failures = [];
  for (const id of runIds) {
    const run = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}`]));
    const jobs = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${id}/attempts/1/jobs?per_page=100`])).jobs;
    for (const job of jobs) {
      const match = /^e2e \((chromium|webkit), (\w+)\)$/.exec(job.name);
      if (!match || match[2] === 'all' || !['success', 'failure'].includes(job.conclusion)) continue;
      const [, engine, group] = match;
      const jobMinutes = (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 60_000;
      shards.push({ engine, group, jobMinutes, run: id });
      const dir = mkdtempSync(join(tmpdir(), 'durations-'));
      try {
        gh(['run', 'download', String(id), '--repo', repo, '-n', `e2e-${engine}-${group}-1`, '-D', dir]);
        const path = join(dir, 'e2e/test-results/results.json');
        if (!existsSync(path)) {
          failures.push(`run ${id} ${engine}/${group}: no results.json`);
          continue;
        }
        const files = fileMinutesIn(JSON.parse(readFileSync(path, 'utf8')));
        const legs = Object.fromEntries(Object.keys(files).map((file) => [file, legsAt(run.head_sha, file)]));
        samples.push({ engine, group, jobMinutes, files, legs });
      } catch (error) {
        failures.push(`run ${id} ${engine}/${group}: ${String(error).split('\n')[0]}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return { samples, shards, failures };
}

function main(argv) {
  const write = argv.includes('--write');
  const repoAt = argv.indexOf('--repo');
  const repo = repoAt >= 0 ? argv[repoAt + 1] : 'brsbl/moss-multi';
  const runIds = argv.filter((arg, i) => /^\d+$/.test(arg) && argv[i - 1] !== '--repo');
  if (runIds.length === 0) {
    console.error('usage: node scripts/ci/durations.mjs [--write] [--repo owner/name] <run id>...');
    return 2;
  }
  const { samples, shards, failures } = collect(repo, runIds);
  const minutes = summarize(samples);
  console.log('| Journey file | legs | Chromium p95 | WebKit p95 |\n| --- | --- | --- | --- |');
  for (const [file, entry] of Object.entries(minutes.journeys)) console.log(`| ${file} | ${entry.legs} | ${entry.chromium} | ${entry.webkit} |`);
  console.log(`\nfixed cost per shard: ${JSON.stringify(minutes.setup)}; per-leg rate: ${JSON.stringify(minutes.perLeg)}\n`);
  console.log('| Measured shard | n | job p50 | job p95 |\n| --- | --- | --- | --- |');
  const byShard = Map.groupBy(shards, (shard) => `${shard.engine}/${shard.group}`);
  for (const [name, list] of [...byShard].sort(([a], [b]) => a.localeCompare(b))) {
    const values = list.map((shard) => shard.jobMinutes);
    console.log(`| ${name} | ${values.length} | ${round(percentile(values, 0.5))} | ${round(percentile(values, 0.95))} |`);
  }
  console.log(`\n| Estimated shard (this checkout's groups) | minutes | budget ${SHARD_BUDGET_MINUTES} |\n| --- | --- | --- |`);
  for (const shard of shardEstimates(readJourneys(), minutes)) console.log(`| ${shard.engine}/${shard.group} | ${shard.minutes} | ${shard.minutes <= SHARD_BUDGET_MINUTES ? 'fits' : 'OVER'} |`);
  const problems = recordProblems(minutes, failures);
  for (const problem of problems) console.error(problem);
  if (write && problems.length) {
    console.error('not written: every sampled shard needs its report (artifacts expire after 7 days)');
    return 1;
  }
  if (write) writeFileSync(MINUTES_FILE, `${JSON.stringify({ runs: runIds.map(Number), ...minutes }, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

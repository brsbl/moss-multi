// T9.25: the deploy workflows' "Read the CI run" step, run in bash against a fake gh. GitHub answers 502 to a jobs page of
// more than about 50 jobs, so the step reads pages of 50 with bounded retries; the listing it writes must judge exactly as
// one complete page would, and a failed or short listing must fail the step.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { presentGroups, testedRunProblems } from './tested-run.mjs';

const REPO = 'brsbl/moss-multi';
const RUN_ID = '4242';
const workflow = (file) => yaml.load(readFileSync(fileURLToPath(new URL(`../../.github/workflows/${file}`, import.meta.url)), 'utf8'));
const TESTED_RUN = fileURLToPath(new URL('./tested-run.mjs', import.meta.url));
const readStep = (file) => workflow(file).jobs.deploy.steps.find((step) => step.name === 'Read the CI run').run;

// A fake gh: the run, and its jobs by page as GitHub serves them (502 for a page over 50 when the run has more than 50).
const FAKE_GH = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const dir = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const count = Number(readFileSync(dir + '/calls', 'utf8')) + 1;
writeFileSync(dir + '/calls', String(count));
const path = args.find((arg) => arg.startsWith('repos/'));
const fail = () => { process.stdout.write('{"message":"Server Error"}'); process.stderr.write('gh: HTTP 502\\n'); process.exit(1); };
if (args[0] !== 'api' || !path) { process.stderr.write('unexpected gh ' + args.join(' ') + '\\n'); process.exit(2); }
if (count <= Number(process.env.FAKE_FAILURES ?? 0)) fail();
const url = new URL(path, 'https://api.github.com/');
if (/\\/actions\\/runs\\/\\d+$/.test(url.pathname)) { process.stdout.write(readFileSync(dir + '/run.json', 'utf8')); process.exit(0); }
if (!/\\/actions\\/runs\\/\\d+\\/jobs$/.test(url.pathname)) { process.stderr.write('unexpected path ' + path + '\\n'); process.exit(2); }
const jobs = JSON.parse(readFileSync(dir + '/jobs.json', 'utf8'));
const perPage = Number(url.searchParams.get('per_page') ?? 30);
if (perPage > 50 && jobs.length > 50) fail();
const served = Number(process.env.FAKE_SERVED ?? jobs.length);
const pages = [];
for (let at = 0; at < Math.max(served, 1); at += perPage) pages.push(jobs.slice(at, Math.min(at + perPage, served)));
const page = Number(url.searchParams.get('page') ?? 1);
const wanted = args.includes('--paginate') ? pages : [pages[page - 1] ?? []];
if (args.includes('--jq')) { for (const list of wanted) for (const job of list) process.stdout.write(JSON.stringify(job) + '\\n'); }
else process.stdout.write(JSON.stringify({ total_count: jobs.length, jobs: wanted[0] }));
`;

const repo = { full_name: REPO };
const RUN = { id: Number(RUN_ID), path: '.github/workflows/ci.yml', conclusion: 'success', event: 'push', head_sha: 'a'.repeat(40), repository: repo, head_repository: repo };
const job = (name, conclusion = 'success', id = 0) => ({ id, name, conclusion, status: 'completed', started_at: '2026-11-13T00:00:00Z', completed_at: '2026-11-13T00:03:00Z', labels: ['ubuntu-latest'] });

/** A full lane's jobs padded with other jobs to `size` (the e2e shards last, so WebKit's are past the first page), or its
 * first `size` jobs when that is fewer; `failing` names a job that failed. */
function lane(size, failing) {
  const shards = ['chromium', 'webkit'].flatMap((engine) => presentGroups().map((group) => `e2e (${engine}, ${group})`));
  const names = ['plan', 'checks', 'build', 'editor-host', 'oracle', 'parity', 'viewer', 'editor', 'canary'];
  while (names.length + shards.length + 1 < size) names.push(`extra ${names.length}`);
  return [...names, ...shards, 'ci-ok'].slice(0, size).map((name, index) => job(name, name === failing ? 'failure' : 'success', 1000 + index));
}

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the step in bash as Actions does (bash -e, pipefail), with the fake gh and a sleep that returns at once. */
function readRun(file, jobs, { failures = 0, served } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'read-run-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  writeFileSync(join(dir, 'sleep'), '#!/bin/sh\necho "$1" >> "$FAKE_DIR/slept"\n');
  for (const name of ['gh', 'sleep']) chmodSync(join(dir, name), 0o755);
  writeFileSync(join(dir, 'calls'), '0');
  writeFileSync(join(dir, 'run.json'), JSON.stringify(RUN));
  writeFileSync(join(dir, 'jobs.json'), JSON.stringify(jobs));
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_DIR: dir,
    FAKE_FAILURES: String(failures),
    ...(served === undefined ? {} : { FAKE_SERVED: String(served) }),
    GITHUB_REPOSITORY: REPO,
    RUN_ID,
    RUNNER_TEMP: dir,
  };
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', readStep(file)], { env, encoding: 'utf8', timeout: 30_000 });
  const read = (name) => {
    try {
      return readFileSync(join(dir, name), 'utf8');
    } catch {
      return null;
    }
  };
  return { dir, status: result.status, stderr: result.stderr, stdout: result.stdout, run: read('run.json'), jobs: read('jobs.ndjson'), calls: Number(read('calls')), slept: read('slept') };
}

// The step's files judged by tested-run.mjs as the deploy runs it, to compare with the judgement of one complete page.
function judge(dir) {
  const result = spawnSync(process.execPath, [TESTED_RUN, join(dir, 'run.json'), join(dir, 'jobs.ndjson')], { env: { ...process.env, GITHUB_REPOSITORY: REPO }, encoding: 'utf8', timeout: 30_000 });
  const errors = result.stderr.split('\n').filter((line) => line.startsWith('::error::')).map((line) => line.replace(`::error::run ${RUN_ID}: `, ''));
  return { status: result.status, errors };
}
const problems = (jobs) => testedRunProblems({ run: RUN, jobs, groups: presentGroups(), repository: REPO });

describe.each(['deploy-pilot.yml', 'deploy-staging.yml'])('%s reads the CI run', (file) => {
  it.each([
    ['84 jobs, all green', 84, undefined, true],
    ['84 jobs, one failed on the second page', 84, 'e2e (webkit, share)', false],
    ['82 jobs, ci-ok failed on the last page', 82, 'ci-ok', false],
    ['40 jobs on one page, the lane incomplete', 40, undefined, false],
  ])('%s: the paged listing is every job, one per line, and judges as one page does', (_, size, failing, green) => {
    const jobs = lane(size, failing);
    expect(problems(jobs).length === 0).toBe(green);
    const out = readRun(file, jobs);
    expect(out.status, out.stderr).toBe(0);
    expect(JSON.parse(out.run)).toEqual(RUN);
    const lines = out.jobs.split('\n').filter(Boolean);
    expect(lines).toHaveLength(size);
    expect(lines.map((line) => JSON.parse(line))).toEqual(jobs);
    const judged = judge(out.dir);
    expect(judged.errors).toEqual(problems(jobs));
    expect(judged.status).toBe(green ? 0 : 1);
  });

  it('retries a call GitHub fails, with a growing pause', () => {
    const jobs = lane(84);
    const out = readRun(file, jobs, { failures: 2 });
    expect(out.status, out.stderr).toBe(0);
    expect(out.jobs.split('\n').filter(Boolean).map((line) => JSON.parse(line))).toEqual(jobs);
    const pauses = out.slept.trim().split('\n').map(Number);
    expect(pauses).toHaveLength(2);
    expect(pauses[1]).toBeGreaterThan(pauses[0]);
  });

  it('fails the step when a call still fails after its retries', () => {
    const out = readRun(file, lane(84), { failures: 1000 });
    expect(out.status).not.toBe(0);
    expect(out.calls).toBeLessThanOrEqual(10);
  });

  it('fails the step on a short listing: fewer jobs than the run has', () => {
    const out = readRun(file, lane(84), { served: 50 });
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toMatch(/50 of 84/);
  });
});

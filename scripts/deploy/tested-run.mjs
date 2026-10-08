#!/usr/bin/env node
// Which bytes deploy-staging may ship (A§21): only the web-dist of a green CI run whose full lane passed, every
// journey group in both engines, on a branch head (push or dispatch, so the built commit is the run's head).
//   node scripts/deploy/tested-run.mjs <run.json> <jobs.ndjson>    (gh api .../runs/<id> and .../runs/<id>/jobs)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALL, GROUPS, readJourneys } from '../ci/journeys.mjs';

const ENGINES = ['chromium', 'webkit'];
const E2E = /^e2e \(([a-z]+), ([a-z0-9-]+)\)$/;

/** The journey groups a full lane shards at this commit (scripts/ci/plan.mjs shardsFor). */
export function presentGroups(journeys = readJourneys()) {
  return Object.keys(GROUPS).filter((group) => journeys.some((journey) => journey.group === group));
}

export function testedRunProblems({ run, jobs, groups }) {
  const problems = [];
  if (run.path !== '.github/workflows/ci.yml') problems.push(`run is ${run.path}, not .github/workflows/ci.yml`);
  if (run.conclusion !== 'success') problems.push(`run concluded ${run.conclusion ?? run.status}`);
  if (!['push', 'workflow_dispatch'].includes(run.event)) problems.push(`run event ${run.event}: deploy a branch run (push or dispatch), whose build is its head commit`);
  const result = (name) => jobs.find((job) => job.name === name)?.conclusion ?? 'missing';
  for (const name of ['build', 'ci-ok']) if (result(name) !== 'success') problems.push(`${name}: ${result(name)}`);
  const shards = jobs.flatMap((job) => {
    const match = E2E.exec(job.name);
    return match ? [{ engine: match[1], group: match[2], conclusion: job.conclusion }] : [];
  });
  if (shards.some((shard) => shard.group === ALL)) problems.push('a grep run (one all shard per engine), not the full lane');
  for (const engine of ENGINES) {
    if (!shards.some((shard) => shard.engine === engine)) {
      problems.push(`no ${engine} journeys ran`);
      continue;
    }
    for (const group of groups) {
      const name = `e2e (${engine}, ${group})`;
      if (result(name) !== 'success') problems.push(`${name}: ${result(name)}`);
    }
  }
  return problems;
}

const readJobs = (text) => (text.trim().startsWith('[') ? JSON.parse(text) : text.split('\n').filter(Boolean).map((line) => JSON.parse(line)));

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [runPath, jobsPath] = process.argv.slice(2);
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  const problems = testedRunProblems({ run, jobs: readJobs(readFileSync(jobsPath, 'utf8')), groups: presentGroups() });
  for (const problem of problems) console.error(`::error::run ${run.id}: ${problem}`);
  if (problems.length === 0) console.log(`run ${run.id} passed the full lane at ${run.head_sha}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}

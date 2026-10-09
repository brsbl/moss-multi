#!/usr/bin/env node
// Whether a CI run may deploy to staging (A§21). deploy-staging.yml runs this from its own commit, before it checks
// out the run's commit or puts a secret in reach, so a fork's run cannot vouch for itself. It fails closed:
// dependency-free, and anything missing or unexpected is a refusal. tested-run.mjs then checks the full lane.
//   node scripts/deploy/run-gate.mjs branch <run.json>                        prints the run's branch if the run passes
//   node scripts/deploy/run-gate.mjs sha <run.json> <ref.json> <compare.json>   prints sha=<head_sha> if everything passes
// ref.json is `gh api repos/<repo>/git/ref/heads/<branch>` and compare.json `gh api repos/<repo>/compare/<head>...<tip>`
// (`null` when the fetch failed). GITHUB_REPOSITORY names this repository.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
// A plain branch name, safe in an API path: no `..`, no leading or trailing slash.
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]+$/;

/** The checks that need only the run: whose it is, which workflow, how it ended, and what it built. */
export function runProblems(run, repository) {
  if (!run || typeof run !== 'object') return ['no run'];
  const problems = [];
  if (!repository) problems.push('GITHUB_REPOSITORY is not set');
  if (run.repository?.full_name !== repository) problems.push(`run belongs to ${run.repository?.full_name ?? 'no repository'}, not ${repository}`);
  if (run.head_repository?.full_name !== repository) problems.push(`run's head repository is ${run.head_repository?.full_name ?? 'unknown'}, not ${repository}`);
  if (run.path !== '.github/workflows/ci.yml') problems.push(`run is ${run.path}, not .github/workflows/ci.yml`);
  if (run.status !== 'completed') problems.push(`run is ${run.status}, not completed`);
  if (run.conclusion !== 'success') problems.push(`run concluded ${run.conclusion}`);
  if (!['push', 'workflow_dispatch'].includes(run.event)) problems.push(`run event ${run.event}: deploy a branch run (push or dispatch)`);
  if (!SHA.test(run.head_sha ?? '')) problems.push(`head_sha ${run.head_sha} is not a commit sha`);
  if (!BRANCH.test(run.head_branch ?? '')) problems.push(`head branch ${JSON.stringify(run.head_branch)} is not a branch name`);
  return problems;
}

/** The run passes, its branch exists here, and its head is the branch's head or an ancestor of it. */
export function gateProblems({ run, ref, compare, repository }) {
  const problems = runProblems(run, repository);
  if (problems.length > 0) return problems;
  const tip = ref?.object?.sha;
  if (ref?.ref !== `refs/heads/${run.head_branch}` || ref?.object?.type !== 'commit' || !SHA.test(tip ?? '')) {
    return [`branch ${run.head_branch} does not exist in ${repository}`];
  }
  const reachable =
    compare?.base_commit?.sha === run.head_sha &&
    compare?.merge_base_commit?.sha === run.head_sha &&
    ((compare.status === 'identical' && tip === run.head_sha) || (compare.status === 'ahead' && tip !== run.head_sha));
  if (!reachable) problems.push(`${run.head_sha} is not on ${run.head_branch} (its head is ${tip}; compare: ${compare?.status ?? 'none'})`);
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, runPath, refPath, comparePath] = process.argv.slice(2);
  const read = (path) => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };
  const repository = process.env.GITHUB_REPOSITORY ?? '';
  const run = read(runPath);
  const problems =
    mode === 'branch' ? runProblems(run, repository) : mode === 'sha' ? gateProblems({ run, ref: read(refPath), compare: read(comparePath), repository }) : [`unknown mode ${mode}`];
  for (const problem of problems) console.error(`::error::run ${run?.id}: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(mode === 'branch' ? run.head_branch : `sha=${run.head_sha}`);
}

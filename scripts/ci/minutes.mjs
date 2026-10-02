#!/usr/bin/env node
// Prints this month's billable Actions minutes for the repo: each job rounded up to a minute,
// macOS ×10 and Windows ×2, as GitHub bills private repos. Read-only gh api calls.
// Usage: node scripts/ci/minutes.mjs [--month YYYY-MM] [--repo owner/name] [--budget 3000] [--json]
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DEFAULT_BUDGET = 3000; // OA2: about 3,000 billable minutes a month

export function jobMinutes({ started_at: started, completed_at: completed, labels = [] }) {
  if (!started) return 0;
  const end = completed ? Date.parse(completed) : Date.now();
  const minutes = Math.ceil(Math.max(0, end - Date.parse(started)) / 60_000);
  const runner = labels.join(' ').toLowerCase();
  if (runner.includes('macos')) return minutes * 10;
  if (runner.includes('windows')) return minutes * 2;
  return minutes;
}

export function summarize(jobs, { budget = DEFAULT_BUDGET } = {}) {
  const minutes = jobs.reduce((sum, job) => sum + jobMinutes(job), 0);
  return { jobs: jobs.length, minutes, budget };
}

export function monthRange(month) {
  const [year, index] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  return `${month}-01..${month}-${String(last).padStart(2, '0')}`;
}

async function ghLines(path, jq) {
  const { stdout } = await run('gh', ['api', '--paginate', path, '--jq', jq], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').filter(Boolean);
}

async function monthJobs(repo, month) {
  const runIds = await ghLines(`repos/${repo}/actions/runs?per_page=100&created=${monthRange(month)}`, '.workflow_runs[].id');
  const jobs = [];
  const queue = [...runIds];
  const worker = async () => {
    while (queue.length > 0) {
      const id = queue.shift();
      const lines = await ghLines(`repos/${repo}/actions/runs/${id}/jobs?filter=all&per_page=100`, '.jobs[] | {started_at, completed_at, labels}');
      jobs.push(...lines.map((line) => JSON.parse(line)));
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { runs: runIds.length, jobs };
}

function parseArgs(argv) {
  const args = { month: new Date().toISOString().slice(0, 7), repo: process.env.GITHUB_REPOSITORY, budget: DEFAULT_BUDGET, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json') args.json = true;
    else if (argv[i] === '--month') args.month = argv[(i += 1)];
    else if (argv[i] === '--repo') args.repo = argv[(i += 1)];
    else if (argv[i] === '--budget') args.budget = Number(argv[(i += 1)]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!/^\d{4}-\d{2}$/.test(args.month)) throw new Error(`--month must be YYYY-MM, got "${args.month}"`);
  args.repo ??= execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' }).trim();
  return args;
}

async function main(argv) {
  const { month, repo, budget, json } = parseArgs(argv);
  const { runs, jobs } = await monthJobs(repo, month);
  const summary = { repo, month, runs, ...summarize(jobs, { budget }) };
  const now = new Date();
  if (month === now.toISOString().slice(0, 7)) {
    const days = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    summary.prorated = Math.round((budget * now.getUTCDate()) / days);
  }
  if (json) {
    console.log(JSON.stringify(summary));
    return 0;
  }
  const share = Math.round((100 * summary.minutes) / budget);
  const prorated = summary.prorated === undefined ? '' : `; prorated budget to date ${summary.prorated}`;
  console.log(`${repo} ${month}: ${summary.minutes} billable minutes over ${runs} runs (${summary.jobs} jobs), ${share}% of ${budget}${prorated}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}

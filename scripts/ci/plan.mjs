#!/usr/bin/env node
// CI lane planner and the ci-ok aggregator. Dependency-free: the plan and ci-ok jobs skip install.
//   node scripts/ci/plan.mjs          prints GITHUB_OUTPUT lines for this event
//   node scripts/ci/plan.mjs ci-ok    fails unless every planned job passed (NEEDS_JSON = toJSON(needs))
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BROWSERS = ['chromium', 'webkit'];
const LANES = ['auto', 'checks', 'e2e', 'full'];
const BROWSER_INPUTS = { both: BROWSERS, chromium: ['chromium'], webkit: ['webkit'] };

// BUILDPLAN.md feeds trace.mjs, e2e/ markdown may feed the suite and vendor/ markdown is drift-checked,
// so none of them is docs-only.
export function isDocsOnlyPath(path) {
  if (path === 'BUILDPLAN.md' || path.startsWith('e2e/') || path.startsWith('vendor/')) return false;
  return path.startsWith('docs/') || path.endsWith('.md');
}

// Branches of milestone k (m<k>, t/T<k>.<n>, m<k>/T<k>.<n>) must keep every earlier milestone's trace rows tagged.
export function traceMilestoneFor(branch) {
  const match = /^m(\d+)$/.exec(branch) ?? /(?:^|\/)T(\d+)\.\d+/.exec(branch);
  if (!match) return null;
  const closed = Number(match[1]) - 1;
  return closed >= 0 ? closed : null;
}

function lanes({ checks = false, build = false, browsers = [] }, reason, extra = {}) {
  return { checks, build, browsers, grep: '', repeat: 1, traceMilestone: null, reason, ...extra };
}

function docsOnly(changedFiles) {
  return Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.every(isDocsOnlyPath);
}

function dispatchPlan(payload) {
  const inputs = payload.inputs ?? {};
  const grep = String(inputs.grep ?? '').trim();
  if (/[\r\n]/.test(grep)) throw new Error('grep must be a single line');
  const repeatText = String(inputs.repeat_each ?? '1').trim();
  const repeat = Number(repeatText);
  if (!/^\d+$/.test(repeatText) || repeat < 1 || repeat > 10) throw new Error(`repeat_each must be 1-10, got "${repeatText}"`);
  const browsers = BROWSER_INPUTS[inputs.browsers ?? 'both'];
  if (!browsers) throw new Error(`browsers must be both, chromium or webkit, got "${inputs.browsers}"`);
  let lane = inputs.lane ?? 'auto';
  if (!LANES.includes(lane)) throw new Error(`lane must be one of ${LANES.join(', ')}, got "${lane}"`);
  if (lane === 'auto') lane = grep ? 'e2e' : 'full';
  const journeys = lane === 'e2e' || lane === 'full';
  const traceMilestone = traceMilestoneFor((payload.ref ?? '').replace(/^refs\/heads\//, ''));
  return lanes(
    { checks: lane === 'checks' || lane === 'full', build: journeys, browsers: journeys ? browsers : [] },
    `dispatch, ${lane} lane`,
    { grep, repeat, traceMilestone },
  );
}

function pushPlan(payload, changedFiles) {
  const ref = payload.ref ?? '';
  if (!ref.startsWith('refs/heads/')) return lanes({}, `push to ${ref || 'unknown ref'}, not a branch`);
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted) return lanes({}, `branch ${branch} deleted`);
  if (docsOnly(changedFiles)) return lanes({}, 'docs-only push');
  if (branch === 'main') return lanes({ checks: true, build: true, browsers: BROWSERS }, 'push to main');
  return lanes({ checks: true, build: true }, `push to ${branch}`, { traceMilestone: traceMilestoneFor(branch) });
}

function pullRequestPlan(payload, changedFiles, degraded) {
  const pr = payload.pull_request ?? {};
  if (payload.action === 'closed') return lanes({}, 'pull request closed');
  if (docsOnly(changedFiles)) return lanes({}, 'docs-only pull request');
  const labels = (pr.labels ?? []).map((label) => label.name);
  const head = pr.head?.ref ?? '';
  const exit = /^m(\d+)$/.exec(head);
  const traceMilestone =
    exit && !pr.draft && pr.base?.ref === 'main' ? Number(exit[1]) : traceMilestoneFor(head);
  if (pr.draft) {
    const e2e = labels.includes('e2e');
    return lanes({ checks: true, build: e2e, browsers: e2e ? ['chromium'] : [] }, 'draft pull request', { traceMilestone });
  }
  const browsers = degraded && !labels.includes('e2e-full') ? ['chromium'] : BROWSERS;
  const reason = browsers.length < BROWSERS.length ? 'ready pull request (CI_DEGRADED: Chromium only)' : 'ready pull request';
  return lanes({ checks: true, build: true, browsers }, reason, { traceMilestone });
}

// Pure: the event name, its payload, the changed paths (null when unknown) and CI_DEGRADED decide the lanes.
export function computePlan({ event, payload = {}, changedFiles = null, degraded = false }) {
  if (event === 'workflow_dispatch') return dispatchPlan(payload);
  if (event === 'push') return pushPlan(payload, changedFiles);
  if (event === 'pull_request') return pullRequestPlan(payload, changedFiles, degraded);
  return lanes({}, `unhandled event ${event}`);
}

export function toOutputs(plan) {
  return (
    [
      `checks=${plan.checks}`,
      `build=${plan.build}`,
      `e2e=${plan.browsers.length > 0}`,
      `browsers=${JSON.stringify(plan.browsers)}`,
      `grep=${plan.grep}`,
      `repeat=${plan.repeat}`,
      `trace_milestone=${plan.traceMilestone ?? ''}`,
      `plan=${JSON.stringify(plan)}`,
    ].join('\n') + '\n'
  );
}

// A planned job must succeed; an unplanned one must be skipped.
export function ciOk(needs) {
  const planJob = needs.plan;
  if (planJob?.result !== 'success') return { ok: false, problems: [`plan: ${planJob?.result ?? 'missing'}`] };
  let plan;
  try {
    plan = JSON.parse(planJob.outputs?.plan ?? '');
  } catch {
    return { ok: false, problems: ['plan: outputs.plan is not JSON'] };
  }
  const expected = { checks: plan.checks, build: plan.build, e2e: plan.browsers.length > 0 };
  const problems = [];
  for (const [job, planned] of Object.entries(expected)) {
    const result = needs[job]?.result ?? 'missing';
    if (planned ? result !== 'success' : result !== 'skipped') {
      problems.push(`${job}: ${result} (planned to ${planned ? 'run' : 'skip'})`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function changedFilesFor(event, payload) {
  const diff = (...range) =>
    execFileSync('git', ['diff', '--name-only', ...range], { encoding: 'utf8' }).split('\n').filter(Boolean);
  try {
    if (event === 'push') {
      if (!payload.before || /^0+$/.test(payload.before) || !payload.after) return null;
      return diff(payload.before, payload.after);
    }
    if (event === 'pull_request') {
      return diff(`${payload.pull_request.base.sha}...${payload.pull_request.head.sha}`);
    }
  } catch {
    return null; // missing history (force push, shallow clone): treat as code
  }
  return null;
}

function main(argv) {
  if (argv[0] === 'ci-ok') {
    const { ok, problems } = ciOk(JSON.parse(process.env.NEEDS_JSON ?? '{}'));
    console.log(ok ? 'ci-ok: every planned job passed' : `ci-ok: FAILED\n${problems.join('\n')}`);
    return ok ? 0 : 1;
  }
  const event = process.env.GITHUB_EVENT_NAME;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const plan = computePlan({
    event,
    payload,
    changedFiles: changedFilesFor(event, payload),
    degraded: process.env.CI_DEGRADED === 'true',
  });
  process.stdout.write(toOutputs(plan));
  const summary = `plan: ${plan.reason}. checks=${plan.checks} build=${plan.build} browsers=${JSON.stringify(plan.browsers)} trace_milestone=${plan.traceMilestone ?? 'none'}`;
  console.error(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

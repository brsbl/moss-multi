#!/usr/bin/env node
// CI lane planner and the ci-ok aggregator. Dependency-free: the plan and ci-ok jobs skip install.
//   node scripts/ci/plan.mjs          prints GITHUB_OUTPUT lines for this event
//   node scripts/ci/plan.mjs ci-ok    fails unless every planned job passed (NEEDS_JSON = toJSON(needs))
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ALL, GROUPS, readJourneys } from './journeys.mjs';

export const BROWSERS = ['chromium', 'webkit'];
// Minutes per e2e shard (the job timeout): a ready-PR shard must finish within 13; repeated and @slow runs get 25.
const SHARD_MINUTES = 13;
const LONG_SHARD_MINUTES = 25;
const LANES = ['auto', 'checks', 'e2e', 'full', 'parity', 'viewer'];
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

// macos: the @macos legs in WebKit on a macOS runner (SP15: Linux WebKit never navigates on Backspace).
// parity: the Ladle oracle and the shell parity job (A§20), on the build job's bytes.
// viewer: the read-only viewer bundle and its acceptance fixture in both engines (T0.13); it needs no stack.
// slow: @slow legs (60 s holds, soaks, idles) are excluded, included (milestone gates, on request) or the only
// legs run (nightly).
function lanes({ checks = false, build = false, browsers = [], macos = false, parity = false, viewer = false }, reason, extra = {}) {
  return { checks, build: build || parity, browsers, macos, parity, viewer, grep: '', repeat: 1, slow: 'exclude', traceMilestone: null, reason, ...extra };
}

// One shard per engine and journey group, each on its own stack (A§20). A grep dispatch runs the whole suite in
// one shard per engine; with no journey yet, that shard runs the selftests alone.
function shardsFor(plan, journeys) {
  if (plan.browsers.length === 0) return [];
  const orphans = journeys.filter((journey) => !journey.group).map((journey) => journey.file);
  if (orphans.length > 0) throw new Error(`${orphans.join(', ')} in no journey group: add it to GROUPS in scripts/ci/journeys.mjs`);
  let groups = [ALL];
  if (!plan.grep) {
    const pool = plan.slow === 'only' ? journeys.filter((journey) => journey.slow) : journeys;
    const present = Object.keys(GROUPS).filter((group) => pool.some((journey) => journey.group === group));
    if (present.length > 0) groups = present;
  }
  const timeout = plan.slow === 'exclude' && plan.repeat === 1 ? SHARD_MINUTES : LONG_SHARD_MINUTES;
  return plan.browsers.flatMap((browser) => groups.map((group) => ({ browser, group, timeout })));
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
  const macosText = String(inputs.macos ?? 'false');
  if (macosText !== 'true' && macosText !== 'false') throw new Error(`macos must be true or false, got "${macosText}"`);
  const parityText = String(inputs.parity ?? 'false');
  if (parityText !== 'true' && parityText !== 'false') throw new Error(`parity must be true or false, got "${parityText}"`);
  const slowText = String(inputs.slow ?? 'false');
  if (slowText !== 'true' && slowText !== 'false') throw new Error(`slow must be true or false, got "${slowText}"`);
  const journeys = lane === 'e2e' || lane === 'full';
  const traceMilestone = traceMilestoneFor((payload.ref ?? '').replace(/^refs\/heads\//, ''));
  return lanes(
    {
      checks: lane === 'checks' || lane === 'full',
      build: journeys,
      browsers: journeys ? browsers : [],
      macos: journeys && macosText === 'true',
      parity: lane === 'full' || lane === 'parity' || (lane === 'e2e' && parityText === 'true'),
      viewer: lane === 'full' || lane === 'viewer',
    },
    `dispatch, ${lane} lane`,
    { grep, repeat, traceMilestone, slow: slowText === 'true' ? 'include' : 'exclude' },
  );
}

function pushPlan(payload, changedFiles) {
  const ref = payload.ref ?? '';
  if (!ref.startsWith('refs/heads/')) return lanes({}, `push to ${ref || 'unknown ref'}, not a branch`);
  const branch = ref.slice('refs/heads/'.length);
  if (payload.deleted) return lanes({}, `branch ${branch} deleted`);
  if (docsOnly(changedFiles)) return lanes({}, 'docs-only push');
  if (branch === 'main') return lanes({ checks: true, build: true, browsers: BROWSERS, parity: true, viewer: true }, 'push to main');
  return lanes({ checks: true, build: true, viewer: true }, `push to ${branch}`, { traceMilestone: traceMilestoneFor(branch) });
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
  // A milestone gate (ready m<k> -> main) also runs the @macos and @slow legs.
  const gate = Boolean(exit) && pr.base?.ref === 'main';
  return lanes({ checks: true, build: true, browsers, macos: gate, parity: true, viewer: true }, gate ? `${reason}, milestone gate` : reason, {
    traceMilestone,
    slow: gate ? 'include' : 'exclude',
  });
}

// Nightly, on main: only the @slow legs, in both engines, and only when main moved since the last green nightly.
function schedulePlan(journeys, headSha, lastNightlySha) {
  if (headSha && headSha === lastNightlySha) return lanes({}, `nightly: main is still ${headSha.slice(0, 12)}, already green`);
  if (!journeys.some((journey) => journey.slow)) return lanes({}, 'nightly: no @slow legs');
  return lanes({ build: true, browsers: BROWSERS }, 'nightly @slow legs', { slow: 'only' });
}

// Pure: the event name, its payload, the changed paths (null when unknown), CI_DEGRADED, the journey files and,
// nightly, main's head and the last green nightly's head decide the lanes and shards.
export function computePlan({ event, payload = {}, changedFiles = null, degraded = false, journeys = [], headSha = '', lastNightlySha = '', closedMilestone = null }) {
  let plan;
  if (event === 'workflow_dispatch') plan = dispatchPlan(payload);
  else if (event === 'push') plan = pushPlan(payload, changedFiles);
  else if (event === 'pull_request') plan = pullRequestPlan(payload, changedFiles, degraded);
  else if (event === 'schedule') plan = schedulePlan(journeys, headSha, lastNightlySha);
  else plan = lanes({}, `unhandled event ${event}`);
  if (closedMilestone !== null) {
    if (!Number.isInteger(closedMilestone) || closedMilestone < 0) throw new Error('closed milestone must be a non-negative integer');
    const pr = payload.pull_request;
    const milestoneExit = event === 'pull_request' && !pr?.draft && pr?.base?.ref === 'main' && /^m\d+$/.test(pr?.head?.ref ?? '');
    if (!milestoneExit && plan.traceMilestone !== null) plan.traceMilestone = Math.min(plan.traceMilestone, closedMilestone);
  }
  return { ...plan, shards: shardsFor(plan, journeys) };
}

export function toOutputs(plan) {
  return (
    [
      `checks=${plan.checks}`,
      `build=${plan.build}`,
      `e2e=${plan.browsers.length > 0}`,
      `browsers=${JSON.stringify(plan.browsers)}`,
      `macos=${plan.macos}`,
      `parity=${plan.parity}`,
      `viewer=${plan.viewer}`,
      `grep=${plan.grep}`,
      `repeat=${plan.repeat}`,
      `slow=${plan.slow}`,
      `shards=${JSON.stringify(plan.shards)}`,
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
  const parity = Boolean(plan.parity);
  const expected = {
    checks: plan.checks,
    build: plan.build,
    e2e: plan.browsers.length > 0,
    macos: Boolean(plan.macos),
    oracle: parity,
    parity,
    viewer: Boolean(plan.viewer),
    // The embeddable editor bundle and its fixture (T3.9) ride the viewer lane.
    editor: Boolean(plan.viewer),
    // The moss-editor-host artifact builds whenever the checks run.
    'editor-host': Boolean(plan.checks),
  };
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
    journeys: readJourneys(),
    headSha: process.env.GITHUB_SHA ?? '',
    lastNightlySha: process.env.LAST_NIGHTLY_SHA ?? '',
    closedMilestone: process.env.CI_CLOSED_MILESTONE ? Number(process.env.CI_CLOSED_MILESTONE) : null,
  });
  process.stdout.write(toOutputs(plan));
  const shards = plan.shards.map((shard) => `${shard.browser}/${shard.group}`).join(' ') || 'none';
  const summary = `plan: ${plan.reason}. checks=${plan.checks} build=${plan.build} shards=${shards} slow=${plan.slow} macos=${plan.macos} parity=${plan.parity} viewer=${plan.viewer} trace_milestone=${plan.traceMilestone ?? 'none'}`;
  console.error(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

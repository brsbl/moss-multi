#!/usr/bin/env node
// Tests-first harness stub: always plans checks and build. The real planner replaces this.
import { pathToFileURL } from 'node:url';

export function isDocsOnlyPath() {
  return false;
}

export function traceMilestoneFor() {
  return null;
}

export function computePlan() {
  return { checks: true, build: true, browsers: [], grep: '', repeat: 1, traceMilestone: null, reason: 'stub' };
}

export function toOutputs(plan) {
  return [
    `checks=${plan.checks}`,
    `build=${plan.build}`,
    `e2e=${plan.browsers.length > 0}`,
    `browsers=${JSON.stringify(plan.browsers)}`,
    `grep=${plan.grep}`,
    `repeat=${plan.repeat}`,
    `trace_milestone=${plan.traceMilestone ?? ''}`,
    `plan=${JSON.stringify(plan)}`,
  ].join('\n') + '\n';
}

export function ciOk(needs) {
  const problems = Object.entries(needs)
    .filter(([, job]) => job.result === 'failure' || job.result === 'cancelled')
    .map(([name, job]) => `${name}: ${job.result}`);
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'ci-ok') {
    const { ok, problems } = ciOk(JSON.parse(process.env.NEEDS_JSON ?? '{}'));
    console.log(ok ? 'ci-ok' : problems.join('\n'));
    process.exit(ok ? 0 : 1);
  }
  process.stdout.write(toOutputs(computePlan()));
}

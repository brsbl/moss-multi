import { describe, expect, it } from 'vitest';
import { ciOk, computePlan, isDocsOnlyPath, toOutputs, traceMilestoneFor } from './plan.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BOTH = ['chromium', 'webkit'];
const NOTHING = { checks: false, build: false, browsers: [] };

function push(branch, changedFiles = ['scripts/ci/plan.mjs'], extra = {}) {
  return computePlan({
    event: 'push',
    payload: { ref: `refs/heads/${branch}`, before: SHA_A, after: SHA_B, ...extra },
    changedFiles,
  });
}

function pr({ draft = false, head = 't/T0.1', base = 'm0', labels = [], degraded = false, action = 'synchronize', changedFiles = ['package.json'] } = {}) {
  return computePlan({
    event: 'pull_request',
    payload: {
      action,
      pull_request: {
        draft,
        head: { ref: head, sha: SHA_B },
        base: { ref: base, sha: SHA_A },
        labels: labels.map((name) => ({ name })),
      },
    },
    changedFiles,
    degraded,
  });
}

function dispatch(inputs, branch = 't/T0.1') {
  return computePlan({ event: 'workflow_dispatch', payload: { ref: `refs/heads/${branch}`, inputs } });
}

describe('push', () => {
  it('runs checks and build on a task branch, with no journey run', () => {
    expect(push('t/T0.1')).toMatchObject({ checks: true, build: true, browsers: [], traceMilestone: null });
  });

  it('gates every closed milestone on later branches', () => {
    expect(push('t/T1.3').traceMilestone).toBe(0);
    expect(push('m2/T2.4').traceMilestone).toBe(1);
    expect(push('m1').traceMilestone).toBe(0);
    expect(push('m0').traceMilestone).toBe(null);
  });

  it('skips a docs-only push', () => {
    expect(push('m0', ['docs/briefs/T0.2.md', 'PROGRESS.md'])).toMatchObject(NOTHING);
  });

  it('still checks a BUILDPLAN.md change, because trace.mjs reads it', () => {
    expect(push('m0', ['BUILDPLAN.md'])).toMatchObject({ checks: true });
  });

  it('treats unknown changed files (a new branch) as code', () => {
    expect(push('t/T0.2', null)).toMatchObject({ checks: true, build: true });
  });

  it('does nothing for a deleted branch', () => {
    expect(push('t/T0.1', null, { deleted: true })).toMatchObject(NOTHING);
  });

  it('runs both engines on main', () => {
    expect(push('main')).toMatchObject({ checks: true, build: true, browsers: BOTH });
  });
});

describe('pull_request', () => {
  it('runs only checks on a draft', () => {
    expect(pr({ draft: true })).toMatchObject({ checks: true, build: false, browsers: [] });
  });

  it('adds build and Chromium journeys to a draft labelled e2e', () => {
    expect(pr({ draft: true, labels: ['e2e'] })).toMatchObject({ checks: true, build: true, browsers: ['chromium'] });
  });

  it('runs both engines on a ready PR', () => {
    expect(pr()).toMatchObject({ checks: true, build: true, browsers: BOTH });
  });

  it('drops WebKit under CI_DEGRADED unless labelled e2e-full', () => {
    expect(pr({ degraded: true }).browsers).toEqual(['chromium']);
    expect(pr({ degraded: true, labels: ['e2e-full'] }).browsers).toEqual(BOTH);
  });

  it('skips a docs-only PR', () => {
    expect(pr({ changedFiles: ['docs/METHOD.md'] })).toMatchObject(NOTHING);
  });

  it('gates the exiting milestone on its ready m<k> → main PR', () => {
    expect(pr({ head: 'm1', base: 'main' }).traceMilestone).toBe(1);
    expect(pr({ head: 'm1', base: 'main', draft: true }).traceMilestone).toBe(0);
    expect(pr({ head: 't/T1.2', base: 'm1' }).traceMilestone).toBe(0);
  });

  it('does nothing when a PR closes', () => {
    expect(pr({ action: 'closed' })).toMatchObject(NOTHING);
  });
});

describe('workflow_dispatch', () => {
  it('has a checks-only lane', () => {
    expect(dispatch({ lane: 'checks' })).toMatchObject({ checks: true, build: false, browsers: [] });
  });

  it('turns a grep dispatch into a targeted journey run', () => {
    expect(dispatch({ grep: 'j00-shell', browsers: 'chromium', repeat_each: '5' })).toMatchObject({
      checks: false,
      build: true,
      browsers: ['chromium'],
      grep: 'j00-shell',
      repeat: 5,
    });
  });

  it('runs everything in both engines by default', () => {
    expect(dispatch({})).toMatchObject({ checks: true, build: true, browsers: BOTH, grep: '', repeat: 1 });
  });

  it('carries the branch trace gate', () => {
    expect(dispatch({ lane: 'checks' }, 't/T2.1').traceMilestone).toBe(1);
  });

  it('refuses invalid inputs loudly', () => {
    expect(() => dispatch({ repeat_each: '0' })).toThrow(/repeat/);
    expect(() => dispatch({ repeat_each: '11' })).toThrow(/repeat/);
    expect(() => dispatch({ repeat_each: 'x' })).toThrow(/repeat/);
    expect(() => dispatch({ browsers: 'firefox' })).toThrow(/browsers/);
    expect(() => dispatch({ lane: 'nightly' })).toThrow(/lane/);
    expect(() => dispatch({ grep: 'a\nb' })).toThrow(/grep/);
  });
});

describe('isDocsOnlyPath', () => {
  it('classifies paths', () => {
    expect(isDocsOnlyPath('docs/design/x.md')).toBe(true);
    expect(isDocsOnlyPath('README.md')).toBe(true);
    expect(isDocsOnlyPath('BUILDPLAN.md')).toBe(false);
    expect(isDocsOnlyPath('e2e/README.md')).toBe(false);
    expect(isDocsOnlyPath('vendor/moss/packages/shared/src/mocks/notes/files/checklist.md')).toBe(false);
    expect(isDocsOnlyPath('package.json')).toBe(false);
  });
});

describe('traceMilestoneFor', () => {
  it('derives the last closed milestone from a branch name', () => {
    expect(traceMilestoneFor('t/T3.2')).toBe(2);
    expect(traceMilestoneFor('m4')).toBe(3);
    expect(traceMilestoneFor('main')).toBe(null);
    expect(traceMilestoneFor('feature/x')).toBe(null);
  });
});

describe('toOutputs', () => {
  it('writes one GITHUB_OUTPUT line per key', () => {
    const lines = toOutputs(dispatch({ grep: 'j01', browsers: 'webkit' }, 't/T1.1')).trim().split('\n');
    expect(lines).toContain('checks=false');
    expect(lines).toContain('build=true');
    expect(lines).toContain('e2e=true');
    expect(lines).toContain('browsers=["webkit"]');
    expect(lines).toContain('grep=j01');
    expect(lines).toContain('repeat=1');
    expect(lines).toContain('trace_milestone=0');
    const plan = lines.find((line) => line.startsWith('plan='));
    expect(JSON.parse(plan.slice('plan='.length))).toMatchObject({ browsers: ['webkit'] });
  });

  it('writes an empty trace gate as an empty value', () => {
    expect(toOutputs(push('t/T0.1'))).toMatch(/^trace_milestone=$/m);
  });
});

describe('ciOk', () => {
  function needs(plan, results = {}) {
    return {
      plan: { result: results.plan ?? 'success', outputs: { plan: JSON.stringify(plan) } },
      checks: { result: results.checks ?? 'skipped' },
      build: { result: results.build ?? 'skipped' },
      e2e: { result: results.e2e ?? 'skipped' },
    };
  }

  const checksOnly = { checks: true, build: false, browsers: [] };
  const everything = { checks: true, build: true, browsers: BOTH };

  it('passes when every planned job passed and the rest were skipped', () => {
    expect(ciOk(needs(checksOnly, { checks: 'success' }))).toEqual({ ok: true, problems: [] });
    expect(ciOk(needs(everything, { checks: 'success', build: 'success', e2e: 'success' })).ok).toBe(true);
  });

  it('fails when a planned job failed', () => {
    const verdict = ciOk(needs(checksOnly, { checks: 'failure' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/checks/);
  });

  it('fails when a planned job was skipped or cancelled', () => {
    expect(ciOk(needs(everything, { checks: 'success', build: 'failure', e2e: 'skipped' })).problems).toHaveLength(2);
    expect(ciOk(needs(everything, { checks: 'cancelled', build: 'success', e2e: 'success' })).ok).toBe(false);
  });

  it('fails when the plan itself failed', () => {
    expect(ciOk({ plan: { result: 'failure', outputs: {} } }).ok).toBe(false);
  });
});

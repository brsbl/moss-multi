import { describe, expect, it } from 'vitest';
import { ciOk, computePlan, isDocsOnlyPath, toOutputs, traceMilestoneFor } from './plan.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const BOTH = ['chromium', 'webkit'];
const NOTHING = { checks: false, build: false, browsers: [], macos: false, shards: [] };
// One journey per group in use: a quick shell leg and an editing journey with a 60 s hold.
const JOURNEYS = [
  { file: 'j00-shell.spec.ts', group: 'shell', slow: false },
  { file: 'j00-persist.spec.ts', group: 'editing', slow: true },
];

function push(branch, changedFiles = ['scripts/ci/plan.mjs'], extra = {}) {
  return computePlan({
    event: 'push',
    payload: { ref: `refs/heads/${branch}`, before: SHA_A, after: SHA_B, ...extra },
    changedFiles,
    journeys: JOURNEYS,
  });
}

function pr({ draft = false, head = 't/T0.1', base = 'm0', labels = [], degraded = false, action = 'synchronize', changedFiles = ['package.json'], journeys = JOURNEYS } = {}) {
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
    journeys,
  });
}

function dispatch(inputs, branch = 't/T0.1', journeys = JOURNEYS) {
  return computePlan({ event: 'workflow_dispatch', payload: { ref: `refs/heads/${branch}`, inputs }, journeys });
}

function nightly({ journeys = JOURNEYS, lastNightlySha = SHA_A } = {}) {
  return computePlan({ event: 'schedule', payload: { schedule: '23 7 * * *' }, journeys, headSha: SHA_B, lastNightlySha });
}

const shard = (browser, group, timeout = 13) => ({ browser, group, timeout });

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

  it('runs shell parity on main only', () => {
    expect(push('main').parity).toBe(true);
    expect(push('t/T0.5a').parity).toBe(false);
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

  it('runs the @macos legs only at a milestone gate', () => {
    expect(pr({ head: 'm1', base: 'main' }).macos).toBe(true);
    expect(pr({ head: 'm1', base: 'main', draft: true }).macos).toBe(false);
    expect(pr({ head: 't/T1.2', base: 'm1' }).macos).toBe(false);
  });

  it('gates the exiting milestone on its ready m<k> → main PR', () => {
    expect(pr({ head: 'm1', base: 'main' }).traceMilestone).toBe(1);
    expect(pr({ head: 'm1', base: 'main', draft: true }).traceMilestone).toBe(0);
    expect(pr({ head: 't/T1.2', base: 'm1' }).traceMilestone).toBe(0);
  });

  it('runs shell parity on a ready PR, not a draft', () => {
    expect(pr().parity).toBe(true);
    expect(pr({ draft: true, labels: ['e2e'] }).parity).toBe(false);
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

  it('adds the macOS lane only to a journey dispatch that asks for it', () => {
    expect(dispatch({}).macos).toBe(false);
    expect(dispatch({ macos: 'true', browsers: 'webkit' })).toMatchObject({ build: true, browsers: ['webkit'], macos: true });
    expect(dispatch({ lane: 'checks', macos: true }).macos).toBe(false);
  });

  it('runs parity in the full lane, the parity lane, or a journey dispatch that asks for it', () => {
    expect(dispatch({}).parity).toBe(true);
    expect(dispatch({ lane: 'parity' })).toMatchObject({ checks: false, build: true, browsers: [], parity: true });
    expect(dispatch({ grep: 'j00-shell', browsers: 'chromium' }).parity).toBe(false);
    expect(dispatch({ grep: 'j00-shell', browsers: 'chromium', parity: 'true' })).toMatchObject({ build: true, parity: true });
    expect(dispatch({ lane: 'checks', parity: true })).toMatchObject({ build: false, parity: false });
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
    expect(() => dispatch({ macos: 'yes' })).toThrow(/macos/);
    expect(() => dispatch({ parity: 'yes' })).toThrow(/parity/);
    expect(() => dispatch({ slow: 'yes' })).toThrow(/slow/);
  });
});

describe('journey shards', () => {
  it('shards a ready PR by journey group, one stack per engine and group, within 13 minutes each', () => {
    expect(pr().shards).toEqual([
      shard('chromium', 'shell'),
      shard('chromium', 'editing'),
      shard('webkit', 'shell'),
      shard('webkit', 'editing'),
    ]);
  });

  it('shards only the groups that have journeys', () => {
    expect(pr({ journeys: [JOURNEYS[0]] }).shards).toEqual([shard('chromium', 'shell'), shard('webkit', 'shell')]);
  });

  it('runs one shard per engine over the whole suite for a grep dispatch', () => {
    expect(dispatch({ grep: 'j00-shell', browsers: 'chromium' }).shards).toEqual([shard('chromium', 'all')]);
  });

  it('runs the selftests in one shard per engine when no journey exists yet', () => {
    expect(pr({ journeys: [] }).shards).toEqual([shard('chromium', 'all'), shard('webkit', 'all')]);
  });

  it('fails the plan when a journey is in no group, so no shard silently drops it', () => {
    expect(() => pr({ journeys: [...JOURNEYS, { file: 'j99-new.spec.ts', group: null, slow: false }] })).toThrow(/j99-new\.spec\.ts.*no journey group/);
  });

  it('plans no shard when no journey run is planned', () => {
    expect(push('t/T0.1').shards).toEqual([]);
    expect(dispatch({ lane: 'checks' }).shards).toEqual([]);
  });

  it('gives repeated or @slow runs a longer shard timeout', () => {
    expect(dispatch({ browsers: 'chromium', repeat_each: '5' }).shards[0].timeout).toBe(25);
    expect(dispatch({ browsers: 'chromium', slow: 'true' }).shards[0].timeout).toBe(25);
    expect(dispatch({ browsers: 'chromium' }).shards[0].timeout).toBe(13);
  });
});

describe('@slow legs', () => {
  it('leaves @slow legs out of task branches, drafts, ready PRs and main pushes', () => {
    expect(push('t/T0.1').slow).toBe('exclude');
    expect(pr({ draft: true, labels: ['e2e'] }).slow).toBe('exclude');
    expect(pr().slow).toBe('exclude');
    expect(pr({ head: 't/T1.2', base: 'm1' }).slow).toBe('exclude');
    expect(push('main').slow).toBe('exclude');
  });

  it('runs @slow legs at a milestone gate', () => {
    expect(pr({ head: 'm1', base: 'main' }).slow).toBe('include');
    expect(pr({ head: 'm1', base: 'main', draft: true }).slow).toBe('exclude');
  });

  it('runs @slow legs on a dispatch that asks for them', () => {
    expect(dispatch({}).slow).toBe('exclude');
    expect(dispatch({ slow: 'true' }).slow).toBe('include');
    expect(dispatch({ grep: 'j00-persist', slow: true }).slow).toBe('include');
  });

  it('runs only the @slow legs nightly, in both engines, for the groups that have them', () => {
    expect(nightly()).toMatchObject({
      checks: false,
      build: true,
      browsers: BOTH,
      parity: false,
      slow: 'only',
      shards: [shard('chromium', 'editing', 25), shard('webkit', 'editing', 25)],
    });
  });

  it('skips the nightly when main has not moved since the last green nightly', () => {
    expect(nightly({ lastNightlySha: SHA_B })).toMatchObject(NOTHING);
  });

  it('skips the nightly when no journey has a @slow leg', () => {
    expect(nightly({ journeys: [JOURNEYS[0]] })).toMatchObject(NOTHING);
  });
});

describe('the viewer lane', () => {
  it('builds and checks the viewer bundle on every code push and ready PR', () => {
    expect(push('t/T0.13').viewer).toBe(true);
    expect(push('main').viewer).toBe(true);
    expect(pr().viewer).toBe(true);
  });

  it('skips it for docs, drafts, journey greps and the nightly', () => {
    expect(push('m0', ['docs/x.md']).viewer).toBe(false);
    expect(pr({ draft: true, labels: ['e2e'] }).viewer).toBe(false);
    expect(dispatch({ grep: 'j00-shell' }).viewer).toBe(false);
    expect(nightly().viewer).toBe(false);
  });

  it('runs alone in the viewer lane, and in the full lane', () => {
    expect(dispatch({ lane: 'viewer' })).toMatchObject({ checks: false, build: false, browsers: [], parity: false, viewer: true, shards: [] });
    expect(dispatch({}).viewer).toBe(true);
    expect(toOutputs(dispatch({ lane: 'viewer' }))).toMatch(/^viewer=true$/m);
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
    expect(lines).toContain('macos=false');
    expect(lines).toContain('parity=false');
    expect(lines).toContain('grep=j01');
    expect(lines).toContain('repeat=1');
    expect(lines).toContain('trace_milestone=0');
    expect(lines).toContain('slow=exclude');
    expect(lines).toContain('shards=[{"browser":"webkit","group":"all","timeout":13}]');
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
      macos: { result: results.macos ?? 'skipped' },
      oracle: { result: results.oracle ?? 'skipped' },
      parity: { result: results.parity ?? 'skipped' },
      viewer: { result: results.viewer ?? 'skipped' },
      editor: { result: results.editor ?? results.viewer ?? 'skipped' },
      'editor-host': { result: results['editor-host'] ?? results.checks ?? 'skipped' },
    };
  }

  const checksOnly = { checks: true, build: false, browsers: [] };
  const everything = { checks: true, build: true, browsers: BOTH };

  it('fails when the editor-host artifact job failed or was skipped beside the checks', () => {
    expect(ciOk(needs(checksOnly, { checks: 'success', 'editor-host': 'failure' })).problems).toEqual(['editor-host: failure (planned to run)']);
    expect(ciOk(needs(checksOnly, { checks: 'success', 'editor-host': 'skipped' })).problems).toEqual(['editor-host: skipped (planned to run)']);
  });

  it('fails when the editor bundle job failed beside the viewer lane', () => {
    const viewerLane = { checks: true, build: false, browsers: [], viewer: true };
    expect(ciOk(needs(viewerLane, { checks: 'success', viewer: 'success', editor: 'failure' })).problems).toEqual(['editor: failure (planned to run)']);
    expect(ciOk(needs(viewerLane, { checks: 'success', viewer: 'success' })).ok).toBe(true);
  });

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

  it('requires the macOS lane when planned', () => {
    const gate = { ...everything, macos: true };
    expect(ciOk(needs(gate, { checks: 'success', build: 'success', e2e: 'success' })).problems).toEqual(['macos: skipped (planned to run)']);
    expect(ciOk(needs(gate, { checks: 'success', build: 'success', e2e: 'success', macos: 'success' })).ok).toBe(true);
  });

  it('requires the oracle and parity jobs when parity is planned', () => {
    const gate = { ...everything, parity: true };
    const passed = { checks: 'success', build: 'success', e2e: 'success' };
    expect(ciOk(needs(gate, passed)).problems).toEqual(['oracle: skipped (planned to run)', 'parity: skipped (planned to run)']);
    expect(ciOk(needs(gate, { ...passed, oracle: 'success', parity: 'failure' })).problems).toEqual(['parity: failure (planned to run)']);
    expect(ciOk(needs(gate, { ...passed, oracle: 'success', parity: 'success' })).ok).toBe(true);
  });

  it('requires the viewer job when planned', () => {
    const branch = { ...checksOnly, build: true, viewer: true };
    expect(ciOk(needs(branch, { checks: 'success', build: 'success' })).problems).toEqual(['viewer: skipped (planned to run)', 'editor: skipped (planned to run)']);
    expect(ciOk(needs(branch, { checks: 'success', build: 'success', viewer: 'failure', editor: 'success' })).problems).toEqual(['viewer: failure (planned to run)']);
    expect(ciOk(needs(branch, { checks: 'success', build: 'success', viewer: 'success' })).ok).toBe(true);
  });

  it('accepts a nightly that built and ran its @slow shards, and a skipped nightly', () => {
    expect(ciOk(needs(nightly(), { build: 'success', e2e: 'success' })).ok).toBe(true);
    expect(ciOk(needs(nightly({ lastNightlySha: SHA_B }))).ok).toBe(true);
  });

  it('fails when the plan itself failed', () => {
    expect(ciOk({ plan: { result: 'failure', outputs: {} } }).ok).toBe(false);
  });
});


it('parallel milestone branches gate the actual closed milestone, while ready milestone exits keep the full gate', () => {
  expect(computePlan({ event: 'push', payload: { ref: 'refs/heads/t/T2.1' }, closedMilestone: 0 }).traceMilestone).toBe(0);
  expect(computePlan({ event: 'workflow_dispatch', payload: { ref: 'refs/heads/m2', inputs: { lane: 'checks' } }, closedMilestone: 0 }).traceMilestone).toBe(0);
  expect(computePlan({ event: 'push', payload: { ref: 'refs/heads/t/T2.1' }, closedMilestone: 1 }).traceMilestone).toBe(1);
  expect(computePlan({ event: 'pull_request', payload: { pull_request: { head: { ref: 'm2' }, base: { ref: 'main' }, draft: false } }, closedMilestone: 0 }).traceMilestone).toBe(2);
  expect(() => computePlan({ event: 'push', closedMilestone: Number.NaN })).toThrow(/closed milestone/);
});

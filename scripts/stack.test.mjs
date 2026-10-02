import { describe, expect, it } from 'vitest';
import { judgeGroup, parseArgs, parseEtime, parsePs } from './stack.mjs';

const RUN = '/repo/.local-stack/runs/r1';
const WRANGLER = `/usr/bin/node /repo/apps/web/node_modules/wrangler/bin/wrangler.js dev --persist-to ${RUN}/state --port 8850`;
const NOW = Date.parse('2026-10-02T12:00:00Z');
const running = { status: 'running', pgid: 100, startedAt: '2026-10-02T11:00:00Z' };

describe('ps parsing', () => {
  it('reads etime in every ps form', () => {
    expect(parseEtime('05')).toBe(5);
    expect(parseEtime('01:05')).toBe(65);
    expect(parseEtime('02:01:05')).toBe(7265);
    expect(parseEtime('3-02:01:05')).toBe(3 * 86400 + 7265);
  });

  it('keeps the whole command line', () => {
    expect(parsePs(`  100   100 01:00 ${WRANGLER}\n  101   100    05 /x/workerd serve --binary -\n`)).toEqual([
      { pid: 100, pgid: 100, age: 60, command: WRANGLER },
      { pid: 101, pgid: 100, age: 5, command: '/x/workerd serve --binary -' },
    ]);
  });
});

describe('judgeGroup', () => {
  const leader = { pid: 100, pgid: 100, age: 3600, command: WRANGLER };
  const workerd = { pid: 101, pgid: 100, age: 3600, command: '/x/workerd serve --binary -' };
  const judge = (state, list = [leader, workerd], maxAge = 4 * 3600) =>
    judgeGroup({ pgid: 100, runDir: RUN, state, list, maxAge, now: NOW });

  it('keeps a live run inside its TTL', () => {
    expect(judge(running)).toEqual({ ours: true, why: null });
  });

  it.each([
    ['state.json missing', null],
    ['run stopped', { ...running, status: 'stopped' }],
    ['run failed', { ...running, status: 'failed' }],
    ["not the run's recorded group", { ...running, pgid: 999 }],
  ])('reaps: %s', (why, state) => {
    expect(judge(state)).toEqual({ ours: true, why });
  });

  it('reaps a leaderless group whose workerd outlived wrangler', () => {
    expect(judge(running, [workerd]).why).toBe('leader dead');
  });

  it('reaps a run older than the TTL', () => {
    expect(judge(running, [leader, workerd], 1800).why).toMatch(/older than/);
  });

  it('never claims a group whose live leader names another run', () => {
    const stranger = { ...leader, command: '/usr/bin/node something-else --persist-to /other/state' };
    expect(judge(null, [stranger, workerd])).toEqual({ ours: false, why: null });
  });
});

describe('parseArgs', () => {
  it('reads flags with values, inline values and booleans', () => {
    expect(parseArgs(['start', '--run-id', 'r1', '--port=8851', '--hooks', '--json'])).toEqual({
      command: 'start',
      opts: { 'run-id': 'r1', port: '8851', hooks: true, json: true },
    });
  });
});

import { describe, expect, it } from 'vitest';
import { jobMinutes, monthRange, summarize } from './minutes.mjs';

const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 0, 0, seconds)).toISOString();
const job = (seconds, labels = ['ubuntu-latest']) => ({ started_at: at(0), completed_at: at(seconds), labels });

describe('jobMinutes', () => {
  it('rounds each job up to a whole minute, as GitHub bills', () => {
    expect(jobMinutes(job(1))).toBe(1);
    expect(jobMinutes(job(60))).toBe(1);
    expect(jobMinutes(job(61))).toBe(2);
  });

  it('counts a job that never started as zero', () => {
    expect(jobMinutes({ started_at: null, completed_at: null, labels: ['ubuntu-latest'] })).toBe(0);
    expect(jobMinutes(job(0))).toBe(0);
  });

  it('applies the macOS and Windows multipliers', () => {
    expect(jobMinutes(job(30, ['macos-14']))).toBe(10);
    expect(jobMinutes(job(30, ['windows-latest']))).toBe(2);
  });
});

describe('summarize', () => {
  it('totals billable minutes against the budget', () => {
    expect(summarize([job(30), job(61), job(30, ['macos-14'])], { budget: 3000 })).toMatchObject({
      jobs: 3,
      minutes: 13,
      budget: 3000,
    });
  });
});

describe('monthRange', () => {
  it('covers the whole month', () => {
    expect(monthRange('2026-10')).toBe('2026-10-01..2026-10-31');
    expect(monthRange('2028-02')).toBe('2028-02-01..2028-02-29');
  });
});

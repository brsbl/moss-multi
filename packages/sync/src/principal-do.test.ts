// The PrincipalDO's REST write window (A§5.2): a sliding window per principal in which denied attempts count.
import { describe, expect, it } from 'vitest';
import { RateWindow } from './principal-do.ts';

describe('REST write window @p:tech-8', () => {
  it('grants max writes per window, then refuses until the window slides', () => {
    const window = new RateWindow(3, 1_000);
    expect([0, 10, 20, 30].map((at) => window.take(at))).toEqual([true, true, true, false]);
    expect(window.take(1_005)).toBe(false);
    expect(window.take(1_031)).toBe(true);
  });

  it('counts denied attempts, so a caller that keeps hammering stays refused', () => {
    const window = new RateWindow(2, 1_000);
    for (let at = 0; at < 5_000; at += 100) window.take(at);
    expect(window.take(5_000)).toBe(false);
    expect(window.take(6_001)).toBe(true);
  });

  it('resumes from its store after a wake, so an exhausted caller stays refused', () => {
    let saved: number[] = [];
    const store = { load: () => [...saved], save: (attempts: number[]) => { saved = [...attempts]; } };
    const before = new RateWindow(2, 1_000, store);
    expect([0, 10, 20].map((at) => before.take(at))).toEqual([true, true, false]);
    const woken = new RateWindow(2, 1_000, store);
    expect(woken.take(30)).toBe(false);
    expect(woken.take(1_031)).toBe(true);
  });
});

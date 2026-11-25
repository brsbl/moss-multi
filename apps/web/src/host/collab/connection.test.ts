import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAction } from '@moss-multi/protocol/sync';
import {
  CUE_SETTLE_MS, CUE_START, PENDING_CUE_AFTER_MS, connectionOf, cueFor, cueOf, cueWakeAt, holdCue, publishUnacked, reduceLink,
  startLink, stepCue, unackedFor, type CueClock,
} from './connection.ts';

describe('connection truth', () => {
  it('keeps a silence verdict through reconnect attempts until sync delivers', () => {
    let link = reduceLink(startLink(0), { type: 'synced' });
    expect(connectionOf(link, 20_000)).toBe('online');
    link = reduceLink(link, { type: 'silent', lastHeard: 20_000 });
    link = reduceLink(link, { type: 'closed', at: 33_000 });
    expect(connectionOf(link, 33_000)).toBe('offline');
    expect(connectionOf(reduceLink(link, { type: 'synced' }), 34_000)).toBe('online');
  });
  it.each([1001, 1006, 1011, 1012, 1013, 4408, 4420])('keeps buffered edits on transient close %s', (code) => {
    expect(closeAction(code)).toEqual({ kind: 'retry' });
  });
  it.each([[4401, 'session-ended'], [4402, 'session-ended'], [4404, 'unavailable'], [4410, 'deleted'], [4426, 'outdated'], [4429, 'conn-limit']] as const)(
    'stops designed refusal %s', (code, reason) => expect(closeAction(code)).toEqual({ kind: 'terminal', reason }),
  );
  it('a suggestion cooldown is its own terminal reason, which ends by itself; any other 4429 is the connection limit (T5.S16)', () => {
    const withReason = closeAction as (code: number, reason?: string) => ReturnType<typeof closeAction>;
    expect(withReason(4429, 'suggest-cooldown')).toEqual({ kind: 'terminal', reason: 'suggest-cooldown' });
    expect(withReason(4429, 'refused')).toEqual({ kind: 'terminal', reason: 'conn-limit' });
    expect(withReason(4429)).toEqual({ kind: 'terminal', reason: 'conn-limit' });
  });
  it('rechecks a changed grant and rebinds a refused write', () => {
    expect(closeAction(4403)).toEqual({ kind: 'reask' });
    expect(closeAction(4409)).toEqual({ kind: 'refused' });
    expect(closeAction(1000)).toEqual({ kind: 'normal' });
  });
});

describe('pending-write cue (T9.40)', () => {
  const run = (steps: [number, boolean, boolean?][]): CueClock =>
    steps.reduce((clock, [now, unacked, held = false]) => stepCue(clock, { unacked, held }, now), CUE_START);

  it('stays hidden for writes acked inside 2 s, and each ack restarts the wait', () => {
    expect(PENDING_CUE_AFTER_MS).toBe(2_000);
    let clock = run([[0, true], [1_900, false], [2_000, true], [3_900, false], [4_000, true], [5_999, true]]);
    expect(cueOf(clock)).toBe('hidden');
    expect(cueWakeAt(clock, false), 'it wakes when the current write has waited 2 s').toBe(6_000);
    clock = stepCue(clock, { unacked: true, held: false }, 6_000);
    expect(cueOf(clock)).toBe('pending');
  });

  it('drops its words at the ack, keeps the anchor for 1 s idle, then leaves', () => {
    expect(CUE_SETTLE_MS).toBe(1_000);
    let clock = run([[0, true], [2_000, true], [2_500, false]]);
    expect(cueOf(clock), 'settled at once on the ack').toBe('settled');
    expect(cueWakeAt(clock, false)).toBe(3_500);
    expect(cueOf(stepCue(clock, { unacked: false, held: false }, 3_499))).toBe('settled');
    clock = stepCue(clock, { unacked: false, held: false }, 3_500);
    expect(cueOf(clock)).toBe('hidden');
    expect(cueWakeAt(clock, false)).toBeNull();
  });

  it('does not oscillate: a new write while the anchor shows says pending at once, without a new 2 s wait', () => {
    const clock = run([[0, true], [2_000, true], [2_100, false], [2_600, true]]);
    expect(cueOf(clock)).toBe('pending');
    expect(cueOf(stepCue(clock, { unacked: false, held: false }, 2_700)), 'and its idle second starts over').toBe('settled');
    expect(cueWakeAt(stepCue(clock, { unacked: false, held: false }, 2_700), false)).toBe(3_700);
  });

  it('keeps the anchor while its details are open, and leaves when they close after the idle second', () => {
    let clock = run([[0, true], [2_000, true], [2_100, false, true], [5_000, false, true]]);
    expect(cueOf(clock)).toBe('settled');
    expect(cueWakeAt(clock, true), 'no timer while held').toBeNull();
    clock = stepCue(clock, { unacked: false, held: false }, 5_001);
    expect(cueOf(clock)).toBe('hidden');
  });
});

describe('pending-write cue store (T9.40)', () => {
  afterEach(() => vi.useRealTimers());

  it('follows the session unacked writes on its own timers, and forgets a withdrawn session', () => {
    vi.useFakeTimers();
    const owner = {};
    publishUnacked('doc-a', owner, true);
    expect(unackedFor('doc-a')).toBe(true);
    expect(cueFor('doc-a')).toBe('hidden');
    vi.advanceTimersByTime(1_999);
    expect(cueFor('doc-a')).toBe('hidden');
    vi.advanceTimersByTime(1);
    expect(cueFor('doc-a')).toBe('pending');
    publishUnacked('doc-a', owner, false);
    expect(cueFor('doc-a')).toBe('settled');
    holdCue('doc-a', true);
    vi.advanceTimersByTime(5_000);
    expect(cueFor('doc-a'), 'held open').toBe('settled');
    holdCue('doc-a', false);
    expect(cueFor('doc-a')).toBe('hidden');
    publishUnacked('doc-a', {}, true);
    publishUnacked('doc-a', owner, null);
    expect(unackedFor('doc-a'), 'only its owner withdraws it').toBe(true);
    publishUnacked('doc-a', owner, true);
    publishUnacked('doc-a', owner, null);
    expect(unackedFor('doc-a')).toBe(false);
    expect(cueFor('doc-a')).toBe('hidden');
  });
});

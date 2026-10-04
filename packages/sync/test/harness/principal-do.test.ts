// The PrincipalDO's REST write window across its lifecycle (A§5.1, A§5.2): a hibernated or evicted PrincipalDO
// wakes empty, so the window lives in its storage and an exhausted identity stays refused after a wake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import { PrincipalDO } from '../../src/principal-do.ts';
import { Backing, FakeState } from './workerd.ts';

const open = (backing: Backing) => {
  const state = new FakeState(backing);
  return { dobj: new PrincipalDO(state as never, {} as never), state };
};

/** Eviction: the instance dies with its memory; a fresh one opens over the same storage. */
const wake = (opened: ReturnType<typeof open>) => {
  opened.state.alive = false;
  return open(opened.state.backing);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PrincipalDO write window across wakes @p:tech-8', () => {
  it('keeps an exhausted identity refused after an eviction inside the window', () => {
    let opened = open(new Backing('principal-1'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) expect(opened.dobj.takeWriteToken()).toBe(true);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    // Idle until hibernation (~10 s), then continue inside the same minute.
    vi.advanceTimersByTime(10_000);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    vi.advanceTimersByTime(20_000);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);
  });

  it('counts denied attempts across wakes and grants again once the window slides', () => {
    let opened = open(new Backing('principal-2'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) opened.dobj.takeWriteToken();
    // Denied attempts at +30 s keep the window full until +90 s.
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) expect(opened.dobj.takeWriteToken()).toBe(false);
    vi.advanceTimersByTime(REST_WRITE_RATE.windowMs - 1);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(false);

    vi.advanceTimersByTime(REST_WRITE_RATE.windowMs);
    opened = wake(opened);
    expect(opened.dobj.takeWriteToken()).toBe(true);
  });

  it('keeps identities apart', () => {
    const a = open(new Backing('principal-a'));
    for (let i = 0; i < REST_WRITE_RATE.max; i += 1) a.dobj.takeWriteToken();
    expect(a.dobj.takeWriteToken()).toBe(false);
    expect(open(new Backing('principal-b')).dobj.takeWriteToken()).toBe(true);
  });
});

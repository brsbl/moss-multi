// Before a trash (A§10.6): the doc closes to writes, the guard waits for its unacked edits at most 5 s, and past that
// asks, with Cancel the default; a cancel or a finished request reopens it.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createTrashGuard, TRASH_ACK_WAIT_MS } from './trash-guard.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function harness({ ackAfter = null as number | null, confirm = false } = {}) {
  const log: string[] = [];
  const guard = createTrashGuard({
    close: (ids, closed) => { log.push(`${closed ? 'close' : 'open'} ${ids.join(',')}`); },
    waitAcked: (ids, timeoutMs) => new Promise((resolve) => {
      log.push(`wait ${ids.join(',')} ${timeoutMs}`);
      if (ackAfter !== null && ackAfter <= timeoutMs) setTimeout(() => resolve(true), ackAfter);
      else setTimeout(() => resolve(false), timeoutMs);
    }),
    confirm: async () => { log.push('confirm'); return confirm; },
  });
  return { log, guard };
}

it('waits for the acks and goes ahead without asking when they arrive', async () => {
  const { log, guard } = harness({ ackAfter: 800 });
  const ready = guard.prepare(['d1']);
  await vi.advanceTimersByTimeAsync(800);
  expect(await ready).toBe(true);
  expect(log).toEqual(['close d1', `wait d1 ${TRASH_ACK_WAIT_MS}`]);
  guard.release(['d1']);
  expect(log.at(-1)).toBe('open d1');
});

it('asks after at most 5 s, and a cancel reopens the doc for writing', async () => {
  expect(TRASH_ACK_WAIT_MS).toBe(5_000);
  const { log, guard } = harness();
  const ready = guard.prepare(['d1', 'd2']);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(log).not.toContain('confirm');
  await vi.advanceTimersByTimeAsync(1);
  expect(await ready).toBe(false);
  expect(log).toEqual(['close d1,d2', 'wait d1,d2 5000', 'confirm', 'open d1,d2']);
});

it('goes ahead when the person confirms the unsynced trash', async () => {
  const { guard } = harness({ confirm: true });
  const ready = guard.prepare(['d1']);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await ready).toBe(true);
});

import { afterEach, expect, it, vi } from 'vitest';
import { recoverChunk, reloadOnce } from './ChunkReloadBoundary.tsx';
import { markSession, markUnacked } from './collab/unacked.ts';
const session = {};
afterEach(() => { markSession(session, false); markUnacked(session, false); vi.unstubAllGlobals(); });
it('never reloads away an open document or a lingering unacked edit', () => {
  const reload = vi.fn();
  markSession(session, true);
  expect(reloadOnce(20_000, null, reload)).toBe(false);
  markSession(session, false);
  markUnacked(session, true);
  expect(reloadOnce(20_000, null, reload)).toBe(false);
  expect(reload).not.toHaveBeenCalled();
});
it('a network outage is not a reason to hard reload', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await recoverChunk()).toBe(false);
});

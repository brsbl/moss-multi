import { afterEach, expect, it, vi } from 'vitest';
import * as boundary from './ChunkReloadBoundary.tsx';
import { markSession, markUnacked } from './collab/unacked.ts';
import { setLeaving, type Leave } from './leave.ts';
const { recoverChunk, reloadOnce } = boundary;
const session = {};
afterEach(() => { markSession(session, false); markUnacked(session, false); setLeaving(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A page that started to leave (beforeunload): WebKit then stops its loads, so pending imports and fetches fail. */
function left(): void {
  const controller = new AbortController();
  controller.abort();
  setLeaving((): Leave => ({ signal: controller.signal, stayed: new Promise(() => undefined) }));
}
const chunkError = () => new TypeError('Importing a module script failed.');
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

it('a chunk that failed because the page is leaving starts no recovery: no version fetch, so WebKit logs no cancelled fetch', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  left();
  expect(await recoverChunk()).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it('a chunk error while the page leaves is not logged; one while it stays is, as is any other caught error', () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  boundary.logCaughtError(chunkError());
  boundary.reportChunkFailure('[suggest] the paste handlers did not load', chunkError());
  expect(log).toHaveBeenCalledTimes(2);
  log.mockClear();
  left();
  boundary.logCaughtError(chunkError());
  boundary.reportChunkFailure('[suggest] the paste handlers did not load', chunkError());
  expect(log).not.toHaveBeenCalled();
  boundary.logCaughtError(new Error('render failed'));
  expect(log).toHaveBeenCalledTimes(1);
});

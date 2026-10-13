// notes.getContent (A§9): the DocDO export through GET /api/docs/:id/content, at most 3 reads in flight, and
// undefined for a note the caller cannot read. moss's file-link hover and workspace formulas read it.
import { expect, it, vi } from 'vitest';
import { createBridge } from './index.ts';

const LISTING = { vault: { id: 'v1', name: 'Home' }, docs: [{ id: 'mine', title: 'Mine', createdAt: 1, updatedAt: 1 }] };

it("returns the server's markdown for a note the caller reads, undefined for one it cannot, and never more than 3 reads in flight", async () => {
  let inFlight = 0;
  let most = 0;
  const waiting: (() => void)[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = String(input);
    if (path.startsWith('/api/workspace')) return Response.json(LISTING);
    const match = /^\/api\/docs\/([^/]+)\/content$/.exec(path);
    if (!match) return new Response(null, { status: 404 });
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise<void>((resolve) => waiting.push(resolve));
    inFlight -= 1;
    const id = decodeURIComponent(match[1]);
    if (id === 'hidden') return Response.json({ error: 'not-found' }, { status: 404 });
    return new Response(`# ${id}\n\nThe body of ${id}.`, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  });
  const api = createBridge({ pathname: () => '/', fetch });
  const ids = ['mine', 'hidden', 'shared-1', 'shared-2', 'shared-3', 'shared-4'];
  const reads = ids.map((id) => api.notes.getContent(id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let released = 0; released < ids.length; released += 1) {
    await vi.waitFor(() => expect(waiting.length, 'a content read is waiting').toBeGreaterThan(0));
    expect(inFlight, 'at most 3 reads in flight').toBeLessThanOrEqual(3);
    waiting.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const answers = await Promise.all(reads);
  expect(most, 'the limit was reached, not exceeded').toBe(3);
  expect(answers[0]).toEqual(expect.objectContaining({ id: 'mine', content: '# mine\n\nThe body of mine.' }));
  expect(answers[1], 'an inaccessible note reads as undefined').toBeUndefined();
  expect(answers[5]).toEqual(expect.objectContaining({ id: 'shared-4', content: '# shared-4\n\nThe body of shared-4.' }));
  const content = fetch.mock.calls.find(([input]) => String(input) === '/api/docs/mine/content');
  expect(content?.[1], 'it asks for markdown, with the session').toMatchObject({ credentials: 'same-origin', headers: expect.objectContaining({ accept: 'text/markdown' }) });
});

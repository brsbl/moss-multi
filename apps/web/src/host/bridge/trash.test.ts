// The bridge's trash (T2.3; A§9, A§10.6): a trash first closes the doc to writes and waits for its acks through the
// guard, then DELETEs, retrying a 503 from a DocDO that did not close; a refusal reaches moss as a sentence. The
// owner's trashed notes come from the listing in seconds, read their content on the one trashed-doc read path, and
// restore through REST.
import { formatRelativeTime } from '@moss-desktop/renderer/panels/notesPanelUtils';
import { expect, it, vi } from 'vitest';
import { AFFORDANCES } from '../affordances.ts';
import { createBridge } from './index.ts';
import { INVENTORY } from './inventory.ts';

interface Call { method: string; path: string }
const DAY = 86_400_000;

function fakeServer() {
  const calls: Call[] = [];
  const now = Date.now();
  const state = {
    docs: [
      { id: 'd1', title: 'One', createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY, role: 'owner', folderPath: 'Notes', trashedAt: null as number | null },
      { id: 'd2', title: 'Two', createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY, role: 'owner', folderPath: 'Notes/Plans', trashedAt: null as number | null },
      { id: 'old', title: 'Old plan', createdAt: now - 9 * DAY, updatedAt: now - 3 * DAY, role: 'owner', folderPath: 'Notes', trashedAt: now - 2 * DAY },
    ],
    folders: [{ id: 'f-plans', name: 'Plans', path: 'Notes/Plans', surfaced: false, createdAt: now, noteCount: 1, role: 'owner' }],
    answers: new Map<string, (() => Response)[]>(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    calls.push({ method, path: url.pathname });
    const queued = state.answers.get(`${method} ${url.pathname}`);
    if (queued?.length) return queued.shift()!();
    if (url.pathname === '/api/workspace') {
      return Response.json({ vault: { id: 'home', name: 'Home', role: 'owner', owned: true }, docs: state.docs, folders: state.folders });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/docs/')) {
      const id = url.pathname.split('/').pop();
      state.docs = state.docs.map((doc) => doc.id === id ? { ...doc, trashedAt: Date.now() } : doc);
      return Response.json({ doc: { id }, action: 'trashed', restorable: true, retentionDays: 30 });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/folders/')) {
      state.folders = [];
      state.docs = state.docs.map((doc) => doc.folderPath.startsWith('Notes/Plans') ? { ...doc, trashedAt: Date.now() } : doc);
      return Response.json({ trashBatchId: 'b', docIds: ['d2'], folderIds: ['f-plans'], action: 'trashed', restorable: true, retentionDays: 30 });
    }
    if (method === 'POST' && url.pathname.endsWith('/restore')) {
      const id = url.pathname.split('/')[3];
      state.docs = state.docs.map((doc) => doc.id === id ? { ...doc, trashedAt: null, folderPath: 'Notes' } : doc);
      return Response.json({ doc: { id, folderId: 'home' } });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/trash/')) {
      const id = url.pathname.split('/').pop();
      const doc = state.docs.find((row) => row.id === id && row.trashedAt !== null);
      return doc ? Response.json({ doc, markdown: `The body of ${doc.title}\n` }) : Response.json({ error: 'not-found' }, { status: 404 });
    }
    // The index holds live docs only (T3.4).
    if (method === 'GET' && url.pathname === '/api/search') return Response.json({ results: [] });
    return Response.json({ error: 'not-found' }, { status: 404 });
  });
  return { calls, state, fetch };
}

function guard(answer = true) {
  const log: string[] = [];
  return {
    log,
    prepare: vi.fn(async (ids: string[]) => {
      log.push(`prepare ${ids.join(',')}`);
      return answer;
    }),
    release: vi.fn((ids: string[]) => { log.push(`release ${ids.join(',')}`); }),
  };
}

it('lists the owner’s trashed notes in seconds: a note trashed two days ago reads "2 days ago", never "Just now"', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  const notes = await bridge.notes.getAll();
  const old = notes.find((note) => note.id === 'old');
  expect(old?.trashedAt).toBe(Math.floor(server.state.docs[2].trashedAt! / 1000));
  expect(formatRelativeTime(old!.trashedAt!)).toBe('2 days ago');
  expect(formatRelativeTime(old!.updatedAt)).toBe('3 days ago');
  expect(notes.find((note) => note.id === 'd1')?.trashedAt).toBeNull();
  expect(formatRelativeTime(notes.find((note) => note.id === 'd1')!.updatedAt)).not.toBe('Just now');
});

it('closes the note to writes and waits through the guard before the DELETE, then lists it as trashed', async () => {
  const server = fakeServer();
  const trash = guard();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, trashGuard: trash });
  await bridge.notes.getAll();
  server.fetch.mockClear();
  server.calls.length = 0;
  trash.prepare.mockImplementation(async (ids: string[]) => {
    trash.log.push(`prepare ${ids.join(',')}`);
    expect(server.calls.filter((call) => call.method === 'DELETE'), 'nothing is sent while edits may be unacked').toEqual([]);
    return true;
  });
  expect(await bridge.notes.delete('d1')).toBe(true);
  expect(trash.log).toEqual(['prepare d1', 'release d1']);
  expect(server.calls).toContainEqual({ method: 'DELETE', path: '/api/docs/d1' });
  expect((await bridge.notes.getAll()).find((note) => note.id === 'd1')?.trashedAt).toEqual(expect.any(Number));
});

it('sends nothing when the guard is cancelled, and moss keeps the note', async () => {
  const server = fakeServer();
  const trash = guard(false);
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, trashGuard: trash });
  await bridge.notes.getAll();
  expect(await bridge.notes.delete('d1')).toBe(false);
  expect(server.calls.filter((call) => call.method === 'DELETE')).toEqual([]);
  expect(trash.log).toEqual(['prepare d1', 'release d1']);
});

it('retries a 503 from a DocDO that did not close, and passes a refusal’s sentence through', async () => {
  const server = fakeServer();
  const trash = guard();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, trashGuard: trash });
  await bridge.notes.getAll();
  const unavailable = () => Response.json({ error: 'unavailable', message: 'The note is in Trash, but it hasn’t closed for everyone yet. Try again.' }, { status: 503 });
  server.state.answers.set('DELETE /api/docs/d1', [unavailable]);
  expect(await bridge.notes.delete('d1')).toBe(true);
  expect(server.calls.filter((call) => call.method === 'DELETE' && call.path === '/api/docs/d1')).toHaveLength(2);

  server.state.answers.set('DELETE /api/docs/d2', [() => Response.json({ error: 'forbidden', message: 'Only the note’s owner can move it to Trash.' }, { status: 403 })]);
  await expect(bridge.notes.delete('d2')).rejects.toThrow('Only the note’s owner can move it to Trash.');
  expect(trash.log.at(-1)).toBe('release d2');
});

it('reads a trashed note’s content on the one trashed-doc read path, and binds nothing for it', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  const record = await bridge.notes.getById('old');
  expect(record).toMatchObject({ id: 'old', content: 'The body of Old plan\n', trashedAt: expect.any(Number) });
  expect(server.calls).toContainEqual({ method: 'GET', path: '/api/trash/old' });
  expect((await bridge.notes.getById('d1'))?.content, 'a live note’s content comes from its binding').toBe('');
});

it('restores through REST and gives moss the record back where it now lives', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  await bridge.notes.getAll();
  const record = await bridge.notes.restore('old');
  expect(server.calls).toContainEqual({ method: 'POST', path: '/api/docs/old/restore' });
  expect(record).toMatchObject({ id: 'old', trashedAt: null, folderPath: 'Notes' });
});

it('a restored note opens live at once, even when the listing after the restore has not landed', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  await bridge.notes.getAll();
  server.state.answers.set('GET /api/workspace', [() => Response.json({ error: 'unavailable' }, { status: 503 })]);
  await bridge.notes.restore('old');
  const record = await bridge.notes.getById('old');
  expect(record, 'the restored note binds').toMatchObject({ id: 'old', content: '', trashedAt: null });
  expect(server.calls, 'never the Trash view’s read path').not.toContainEqual({ method: 'GET', path: '/api/trash/old' });
});

it('searches trashed notes only in the trash view', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  expect((await bridge.notes.search({ query: 'plan' })).map((hit) => hit.id)).toEqual([]);
  expect((await bridge.notes.search({ query: 'plan', searchTrashed: true })).map((hit) => hit.id)).toEqual(['old']);
});

it('closes a folder’s open notes to writes before its trash, and retries a 503', async () => {
  const server = fakeServer();
  const trash = guard();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, trashGuard: trash });
  await bridge.notes.getAll();
  server.state.answers.set('DELETE /api/folders/f-plans', [() => Response.json({ error: 'unavailable', message: 'Try again.' }, { status: 503 })]);
  expect(await bridge.folders.delete({ path: 'Notes/Plans', moveNotesTo: 'trash' })).toBe(true);
  expect(trash.log).toEqual(['prepare d2', 'release d2']);
  expect(server.calls.filter((call) => call.method === 'DELETE' && call.path === '/api/folders/f-plans')).toHaveLength(2);
});

it('is real: trash and restore are no longer staged, and no trash entry point is withheld', () => {
  expect(INVENTORY['notes.delete'].treatment).toBe('real');
  expect(INVENTORY['notes.restore'].treatment).toBe('real');
  expect(AFFORDANCES.map((entry) => entry.id)).not.toContain('trash');
});

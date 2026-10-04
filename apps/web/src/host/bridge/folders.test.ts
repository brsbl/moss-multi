// The bridge's folders namespace (T2.2; A§9): moss's folder paths map to server ids through the refreshed id↔path
// map, every change re-reads the listing, and a refusal reaches moss as the server's sentence.
import { expect, it, vi } from 'vitest';
import { createBridge, WORKSPACE } from './index.ts';

interface Call { method: string; path: string; body: unknown }

function fakeServer() {
  const calls: Call[] = [];
  const state = {
    folders: [{ id: 'f-plans', name: 'Plans', path: 'Notes/Plans', surfaced: false, createdAt: 5000, noteCount: 1, role: 'owner' }],
    docs: [{ id: 'd1', title: 'One', createdAt: 1000, updatedAt: 2000, role: 'owner', folderPath: 'Notes' }],
    vaultRole: 'owner',
    answers: new Map<string, () => Response>(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const answer = state.answers.get(`${method} ${url.pathname}`);
    if (answer) return answer();
    if (url.pathname === '/api/workspace') {
      return Response.json({ vault: { id: 'home', name: 'Home', role: state.vaultRole, owned: true }, docs: state.docs, folders: state.folders });
    }
    if (method === 'POST' && url.pathname === '/api/folders') {
      const parent = body.parentId === 'home' ? 'Notes' : state.folders.find((f) => f.id === body.parentId)?.path;
      const folder = { id: `f-${body.name}`, name: body.name, path: `${parent}/${body.name}`, surfaced: false, createdAt: 9000, noteCount: 0, role: 'owner' };
      state.folders = [...state.folders, folder];
      return Response.json({ folder: { id: folder.id, name: body.name, parentId: body.parentId } }, { status: 201 });
    }
    if (method === 'PATCH' && url.pathname.startsWith('/api/docs/')) {
      const id = url.pathname.split('/').pop();
      const path = state.folders.find((f) => f.id === body.folderId)?.path ?? 'Notes';
      state.docs = state.docs.map((doc) => doc.id === id ? { ...doc, folderPath: path, updatedAt: 3000 } : doc);
      return Response.json({ doc: { ...state.docs.find((doc) => doc.id === id), folderId: body.folderId }, role: 'owner' });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/folders/')) {
      state.folders = state.folders.filter((f) => !url.pathname.endsWith(f.id));
      return Response.json({ trashBatchId: 'b', docIds: [], folderIds: [] });
    }
    if (method === 'POST' && url.pathname === '/api/docs') {
      return Response.json({ doc: { id: 'new', title: '', createdAt: 1, updatedAt: 1, folderId: body.folderId }, role: 'owner' }, { status: 201 });
    }
    return Response.json({ error: 'not-found' }, { status: 404 });
  });
  return { calls, state, fetch };
}

it('creates a folder under a path, re-reads the listing and lists it for moss', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  await bridge.notes.getAll();
  const created = await bridge.folders.create({ name: 'Drafts', parentPath: 'Notes/Plans', noteIds: [] });
  expect(server.calls).toContainEqual({ method: 'POST', path: '/api/folders', body: { parentId: 'f-plans', name: 'Drafts' } });
  expect(created).toMatchObject({ name: 'Drafts', path: 'Notes/Plans/Drafts' });
  expect((await bridge.folders.list()).map((folder) => folder.path)).toEqual(['Notes/Plans', 'Notes/Plans/Drafts']);
  await bridge.folders.create({ name: 'Top' });
  expect(server.calls).toContainEqual({ method: 'POST', path: '/api/folders', body: { parentId: 'home', name: 'Top' } });
});

it('passes the server’s sentence through, and explains a parent that is no longer there without a coded error', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  await bridge.notes.getAll();
  server.state.answers.set('POST /api/folders', () => Response.json({ error: 'folder-exists', message: 'A folder named “Plans” already exists here.' }, { status: 409 }));
  await expect(bridge.folders.create({ name: 'plans' })).rejects.toThrow('A folder named “Plans” already exists here.');
  server.state.answers.delete('POST /api/folders');
  const error = await bridge.folders.create({ name: 'Q3', parentPath: 'Notes/Gone' }).then(() => null, (e: Error) => e);
  expect(error?.message).toMatch(/no longer/);
  expect(error?.message).not.toMatch(/Unknown parent folder|^Failed$/);
  server.state.answers.set('POST /api/folders', () => new Response('upstream', { status: 503 }));
  const outage = await bridge.folders.create({ name: 'Later' }).then(() => null, (e: Error) => e);
  expect(outage?.message).toMatch(/^[A-Z].*\S \S.*\.$/);
});

it('renames, moves and trashes by id, and has moss re-read notes and folders after each', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  const changed = vi.fn();
  bridge.notes.onDiskChange(changed);
  await bridge.notes.getAll();
  await bridge.folders.rename({ currentPath: 'Notes/Plans', newName: 'Projects' });
  expect(server.calls).toContainEqual({ method: 'PATCH', path: '/api/folders/f-plans', body: { name: 'Projects' } });
  await bridge.folders.moveFolder({ sourcePath: 'Notes/Plans', targetParentPath: 'Notes' });
  expect(server.calls).toContainEqual({ method: 'PATCH', path: '/api/folders/f-plans', body: { parentId: 'home' } });
  const moved = await bridge.folders.moveNotes({ noteIds: ['d1'], targetFolderPath: 'Notes/Plans' });
  expect(server.calls).toContainEqual({ method: 'PATCH', path: '/api/docs/d1', body: { folderId: 'f-plans' } });
  expect(moved).toEqual([expect.objectContaining({ id: 'd1', folderPath: 'Notes/Plans' })]);
  expect(await bridge.folders.delete({ path: 'Notes/Plans', moveNotesTo: 'trash' })).toBe(true);
  expect(server.calls).toContainEqual({ method: 'DELETE', path: '/api/folders/f-plans', body: undefined });
  expect(changed).toHaveBeenCalledWith([], []);
  expect(await bridge.folders.list()).toEqual([]);
});

it('creates a note in the active folder, and reports each folder’s role for the sidebar’s controls', async () => {
  const server = fakeServer();
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch });
  await bridge.notes.getAll();
  await bridge.notes.create('Untitled', 'Notes/Plans');
  expect(server.calls).toContainEqual({ method: 'POST', path: '/api/docs', body: { folderId: 'f-plans' } });
  expect(bridge[WORKSPACE].folderRole('Notes/Plans')).toBe('owner');
  expect(bridge[WORKSPACE].folderRole('Notes')).toBe('owner');
  server.state.vaultRole = 'viewer';
  server.state.folders = server.state.folders.map((folder) => ({ ...folder, role: 'viewer' }));
  await bridge[WORKSPACE].switchVault('home');
  expect(bridge[WORKSPACE].folderRole('Notes')).toBe('viewer');
  expect(bridge[WORKSPACE].folderRole('Notes/Plans')).toBe('viewer');
  expect(bridge[WORKSPACE].folderRole('Notes/Nowhere')).toBeNull();
});

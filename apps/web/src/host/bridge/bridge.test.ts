import { describe, expect, it, vi } from 'vitest';
import { createBridge, docIdFromPath } from './index.ts';

const LISTING = {
  vault: { id: 'v1', name: 'Home' },
  docs: [{ id: 'd1', title: 'Plans', createdAt: 1_700_000_000_500, updatedAt: 1_700_000_100_999 }],
};

function bridge(pathname = '/', response: Response = Response.json(LISTING)) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response.clone());
  return { fetch, api: createBridge({ pathname: () => pathname, fetch }) };
}

describe('the T0.5a bridge', () => {
  it('lists the vault from GET /api/workspace in moss seconds under Notes', async () => {
    const { api, fetch } = bridge();
    expect(await api.notes.getAll()).toEqual([
      { id: 'd1', title: 'Plans', createdAt: 1_700_000_000, updatedAt: 1_700_000_100, folderPath: 'Notes', lastOpenedAt: null, trashedAt: null },
    ]);
    await api.notes.getMetadataByIds(['d1']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/workspace', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('opens the doc the route names, and nothing elsewhere', async () => {
    expect((await bridge('/d/d1').api.system.getWindowContext()).initialNoteId).toBe('d1');
    expect((await bridge('/').api.system.getWindowContext()).initialNoteId).toBeNull();
    expect(docIdFromPath('/d/a%20b')).toBe('a b');
    expect(docIdFromPath('/d/a/b')).toBeNull();
  });

  it('retries a failed listing instead of caching the failure', async () => {
    const { api, fetch } = bridge('/', new Response('{}', { status: 503 }));
    await expect(api.notes.getAll()).rejects.toThrow(/503/);
    await expect(api.notes.getAll()).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps every subscription callable', () => {
    const { api } = bridge();
    for (const subscribe of [api.notes.onDiskChange, api.notes.onRequestFlush, api.agent.onStream, api.update.onReady]) {
      expect(typeof subscribe()).toBe('function');
    }
  });
});

describe('the T0.5b bridge', () => {
  it('refuses a content write loudly and sends no request (P:Tech; A§9) @p:tech-7', async () => {
    const { api, fetch } = bridge('/d/d1');
    await expect(api.notes.update('d1', { content: '' })).rejects.toThrow(/content write.*refused/i);
    await expect(api.notes.update('d1', { title: 'Plans', content: '# wiped' })).rejects.toThrow(/refused/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates a note with POST /api/docs and lists it in moss seconds', async () => {
    const created = { doc: { id: 'd2', folderId: 'v1', title: '', filename: 'untitled.md', createdAt: 1_700_000_200_000, updatedAt: 1_700_000_200_000 } };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === '/api/docs' && init?.method === 'POST' ? Response.json(created, { status: 201 }) : Response.json(LISTING),
    );
    const api = createBridge({ pathname: () => '/', fetch });
    const note = await api.notes.create('Untitled', 'Notes');
    expect(fetch).toHaveBeenCalledWith('/api/docs', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    const body = JSON.parse(String(fetch.mock.calls.find(([url]) => String(url) === '/api/docs')?.[1]?.body));
    expect(body, 'the placeholder "Untitled" is never authored as a title (A§5.1 seed)').toEqual({});
    expect(note).toMatchObject({ id: 'd2', title: 'Untitled', createdAt: 1_700_000_200, updatedAt: 1_700_000_200, folderPath: 'Notes', content: '' });
    expect(await api.notes.getById('d2'), 'the created note is readable before the next listing').toMatchObject({ id: 'd2', content: '' });
  });

  it('surfaces a failed create as an error, never a fake note', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: 'not-found' }, { status: 404 }));
    const api = createBridge({ pathname: () => '/', fetch });
    await expect(api.notes.create('Untitled')).rejects.toThrow(/POST \/api\/docs: 404/);
  });
});

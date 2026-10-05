import { describe, expect, it, vi } from 'vitest';
import { knownRole } from '../access.ts';
import { createBridge, docIdFromPath, WORKSPACE } from './index.ts';

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

describe('the T1.1 bridge', () => {
  it("reads a doc shared with the caller from GET /api/docs/:id when the listing lacks it, with the caller's role", async () => {
    const shared = { doc: { id: 's1', folderId: 'v9', title: 'Their plans', createdAt: 1_700_000_300_000, updatedAt: 1_700_000_400_000 }, role: 'editor' };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input);
      if (url === '/api/docs/s1') return Response.json(shared);
      if (url.startsWith('/api/docs/')) return Response.json({ error: 'not-found' }, { status: 404 });
      return Response.json(LISTING);
    });
    const api = createBridge({ pathname: () => '/d/s1', fetch });
    expect(await api.notes.getById('s1')).toMatchObject({ id: 's1', title: 'Their plans', updatedAt: 1_700_000_400, folderPath: 'Notes', content: '' });
    expect(knownRole('s1')).toBe('editor');
    expect(await api.notes.getById('gone'), 'a doc the caller cannot open is no note at all').toBeUndefined();
    expect(knownRole('gone')).toBeNull();
  });

  it('knows the caller owns every doc of its own listing and every doc it creates', async () => {
    const created = { doc: { id: 'n1', folderId: 'v1', title: '', filename: 'untitled.md', createdAt: 1, updatedAt: 1 }, role: 'owner' };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === '/api/docs' && init?.method === 'POST'
        ? Response.json(created, { status: 201 })
        : Response.json({ ...LISTING, docs: LISTING.docs.map((doc) => ({ ...doc, id: 'o1', role: 'owner' })) }),
    );
    const api = createBridge({ pathname: () => '/', fetch });
    await api.notes.getAll();
    expect(knownRole('o1')).toBe('owner');
    await api.notes.create('Untitled');
    expect(knownRole('n1')).toBe('owner');
  });
});


describe('title rename through the bridge', () => {
  it('returns the DocDO projection after an unbound rename', async () => {
    const renamed = { ...LISTING.docs[0], title: 'Next plans' };
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) =>
      init?.method === 'PATCH' ? Response.json({ doc: renamed }) : Response.json(LISTING));
    const api = createBridge({ pathname: () => '/', fetch });
    expect(await api.notes.update('d1', { title: 'Next plans' })).toMatchObject({ title: 'Next plans' });
    expect(await api.notes.getById('d1')).toMatchObject({ title: 'Next plans' });
    expect(fetch).toHaveBeenCalledWith('/api/docs/d1', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ title: 'Next plans' }) }));
  });
});

it('switches the listing without losing an open note, persists the vault and creates in the selected vault', async () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const shared = { vault: { id: 'v2', name: 'Shared', role: 'editor', owned: false },
    docs: [{ ...LISTING.docs[0], id: 's2', folderPath: 'Notes/Project' }],
    folders: [{ id: 'f2', path: 'Notes/Project', name: 'Project', createdAt: 1_700_000_000_000, noteCount: 1, surfaced: false }] };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    if (init?.method === 'POST') return Response.json({ doc: { ...LISTING.docs[0], id: 'new' } });
    return Response.json(String(input).includes('vault=v2') ? shared : LISTING);
  });
  const api = createBridge({ pathname: () => '/', fetch, storage });
  await api.notes.getAll();
  const changed = vi.fn();
  api.notes.onDiskChange(changed);
  await api[WORKSPACE].switchVault('v2');
  expect(changed).toHaveBeenCalledWith([], []);
  expect((await api.notes.getAll()).map((note) => note.id)).toEqual(['s2']);
  expect(await api.notes.getById('d1')).toMatchObject({ id: 'd1' });
  expect(await api.folders.list()).toContainEqual(expect.objectContaining({ path: 'Notes/Project', createdAt: 1_700_000_000 }));
  await api.notes.create('Untitled');
  const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(post?.[1]?.body))).toEqual({ folderId: 'v2' });
  const reopened = createBridge({ pathname: () => '/', fetch, storage });
  expect((await reopened.notes.getAll()).map((note) => note.id)).toEqual(['s2']);
});

it('keeps the last successful vault after a failed switch', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input).includes('vault=broken')
    ? new Response('{}', { status: 503 }) : Response.json(LISTING));
  const api = createBridge({ pathname: () => '/', fetch });
  await api.notes.getAll();
  await expect(api[WORKSPACE].switchVault('broken')).rejects.toThrow('503');
  expect(api[WORKSPACE].getSnapshot()?.vault.id).toBe('v1');
  expect((await api.notes.getAll()).map((note) => note.id)).toEqual(['d1']);
});

it('refreshes peer-created metadata only when it changes and stops polling when the last subscriber leaves', async () => {
  vi.useFakeTimers();
  try {
    let listing = LISTING;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(listing));
    const api = createBridge({ pathname: () => '/', fetch });
    await api.notes.getAll();
    const changed = vi.fn();
    const stop = api.notes.onDiskChange(changed);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(changed).not.toHaveBeenCalled();
    listing = { ...LISTING, docs: [...LISTING.docs, { ...LISTING.docs[0], id: 'copy' }] };
    await vi.advanceTimersByTimeAsync(3_000);
    expect(changed).toHaveBeenCalledExactlyOnceWith([], []);
    expect((await api.notes.getAll()).map((doc) => doc.id)).toEqual(['d1', 'copy']);
    stop();
    const requests = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(fetch).toHaveBeenCalledTimes(requests);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

it.each(['switch', 'navigation'] as const)('a listing poll never overrides an in-flight vault %s', async (action) => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const target = { vault: { id: 'v2', name: 'Other' }, docs: [{ ...LISTING.docs[0], id: 'd2' }] };
  let resolve!: (response: Response) => void;
  const held = new Promise<Response>((done) => { resolve = done; });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    return url.includes('vault=v2') || url.includes('doc=d2') ? (await held).clone() : Response.json(LISTING);
  });
  const api = createBridge({ pathname: () => '/', fetch, storage });
  const stop = api.notes.onDiskChange(vi.fn());
  try {
    await api.notes.getAll();
    const navigate = action === 'switch' ? api[WORKSPACE].switchVault('v2') : api.system.setFocusedNoteId('d2');
    await vi.advanceTimersByTimeAsync(3_000);
    resolve(Response.json(target));
    await navigate;
    expect(api[WORKSPACE].getSnapshot()?.vault.id).toBe('v2');
    expect(values.get('moss-multi:active-vault')).toBe('v2');
    expect((await api.notes.getAll()).map((doc) => doc.id)).toEqual(['d2']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(api[WORKSPACE].getSnapshot()?.vault.id).toBe('v2');
  } finally {
    stop();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

describe('a listing the browser cancels as the page leaves', () => {
  const failing = () => {
    let fail: (error: Error) => void = () => undefined;
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => { fail = reject; });
    });
    let leave: () => void = () => undefined;
    const browser = {
      origin: 'http://localhost', open: () => undefined, replacePath: () => undefined,
      onPopState: () => () => undefined, copy: async () => undefined,
      onLeave: (listener: () => void) => { leave = listener; return () => { leave = () => undefined; }; },
    };
    const api = createBridge({ pathname: () => '/', fetch, browser });
    return { api, signals, fail: (error: Error) => fail(error), leave: () => leave() };
  };

  // WebKit logs a fetch the navigation cancels as "cannot load … due to access control checks", a console error
  // Playwright reports as a page error whether or not the page catches it; a fetch the page aborts first logs nothing.
  it('aborts the listing fetch itself as the page starts to leave', () => {
    const { api, signals, leave } = failing();
    void api.notes.getAll().catch(() => undefined);
    expect(signals[0]?.aborted).toBe(false);
    leave();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('does not reject while the page unloads (WebKit reports the cancel as an access-control error)', async () => {
    vi.useFakeTimers();
    try {
      const { api, fail, leave } = failing();
      const outcome = vi.fn();
      api.notes.getAll().then(() => outcome('resolved'), () => outcome('rejected'));
      leave();
      fail(new TypeError('http://127.0.0.1:8850/api/workspace due to access control checks.'));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(outcome).not.toHaveBeenCalled();
      // A page that stayed (an unload prompt answered "Stay") still learns of the failure.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toHaveBeenCalledWith('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('still rejects at once when the page is not leaving', async () => {
    const { api, fail } = failing();
    const listed = api.notes.getAll();
    fail(new TypeError('Load failed'));
    await expect(listed).rejects.toThrow('Load failed');
  });
});

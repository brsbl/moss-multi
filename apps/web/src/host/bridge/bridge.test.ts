import { describe, expect, it, vi } from 'vitest';
import { knownRole } from '../access.ts';
import { createBridge, docIdFromPath, inertBrowser, WORKSPACE, type BrowserHooks } from './index.ts';

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

it.each(['switch', 'navigation'] as const)('a workspace event never overrides an in-flight vault %s', async (action) => {
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
  let receive: (event: { type: 'vaults' }) => void = () => undefined;
  const api = createBridge({ pathname: () => '/', fetch, storage, subscribeWorkspace: (cb) => { receive = cb; return () => undefined; } });
  const stop = api.notes.onDiskChange(vi.fn());
  try {
    await api.notes.getAll();
    const navigate = action === 'switch' ? api[WORKSPACE].switchVault('v2') : api.system.setFocusedNoteId('d2');
    receive({ type: 'vaults' });
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

describe('the T3.7 bridge: tab, print and download (R4; A§9 Export)', () => {
  const memory = (seed: Map<string, string> = new Map()) => {
    const values = new Map(seed);
    return { values, getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  };
  const hooks = (overrides: Partial<BrowserHooks> = {}): BrowserHooks => ({ ...inertBrowser, origin: 'https://moss.example', ...overrides });
  const quiet = () => vi.fn<typeof globalThis.fetch>(async () => Response.json(LISTING));

  it('opens a note in a new browser tab at /d/<id>, keeping a share link', async () => {
    const open = vi.fn();
    const api = createBridge({ pathname: () => '/', fetch: quiet(), browser: hooks({ open }) });
    expect(await api.system.createWindow({ noteId: 'd1' })).toEqual({ action: 'created', windowId: -1 });
    expect(open).toHaveBeenLastCalledWith('https://moss.example/d/d1');
    const shared = createBridge({ pathname: () => '/d/d1', fetch: quiet(), browser: hooks({ open, share: () => 'tok en' }) });
    await shared.system.createWindow({ noteId: 'd1' });
    expect(open).toHaveBeenLastCalledWith('https://moss.example/d/d1?share=tok+en');
  });

  it('hands a PDF session to the /pdf-export tab it opens, and only that session', async () => {
    const session = memory();
    const openWindow = vi.fn(() => true);
    const api = createBridge({ pathname: () => '/d/d1', fetch: quiet(), browser: hooks({ openWindow, session }) });
    const input = { title: 'Plans', markdown: 'Body', renderedHtml: '<p>Body</p>', serializedEditorState: { root: {} }, tabGroupActiveIndices: [1] };
    const id = await api.notes.createPdfExportSession('d1', input);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await api.notes.openPdfExportPreview(id)).not.toBeNull();
    expect(openWindow).toHaveBeenCalledWith(`/pdf-export?pdfExportSessionId=${id}`);

    // The print tab reads the session from its own copy of the opener's session storage, or from the opener's.
    // PdfExportApp never reads renderedHtml, so it is not stored.
    const expected = { noteId: 'd1', title: 'Plans', markdown: 'Body', serializedEditorState: { root: {} }, tabGroupActiveIndices: [1] };
    const child = createBridge({ pathname: () => '/pdf-export', fetch: quiet(), browser: hooks({ session: memory(session.values) }) });
    expect(await child.notes.getPdfExportSession(id)).toEqual(expected);
    const viaOpener = createBridge({ pathname: () => '/pdf-export', fetch: quiet(), browser: hooks({ session: memory(), openerSession: () => session }) });
    expect(await viaOpener.notes.getPdfExportSession(id)).toEqual(expected);
    expect(await child.notes.getPdfExportSession('another'), 'an unknown session is none').toBeNull();
  });

  it('reports a blocked print tab as a failed open', async () => {
    const api = createBridge({ pathname: () => '/', fetch: quiet(), browser: hooks({ openWindow: () => false, session: memory() }) });
    const id = await api.notes.createPdfExportSession('d1', { title: 'Plans', markdown: '' });
    expect(await api.notes.openPdfExportPreview(id)).toBeNull();
  });

  it("downloads the server's export of the doc, named by its title, ignoring moss's client markdown", async () => {
    const download = vi.fn();
    const exported = 'Totals {{2+2|4}} and [[Launch Plan]].\n';
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input) === '/api/docs/d1/content'
      ? new Response(exported, { headers: { 'content-type': 'text/markdown; charset=utf-8' } })
      : Response.json(LISTING));
    const api = createBridge({ pathname: () => '/d/d1', fetch, browser: hooks({ download, share: () => 'tok' }) });
    expect(await api.notes.exportMarkdown('d1', { title: ' Q4 / plan: draft? ', markdown: 'Totals 4 and Launch Plan.' })).toEqual({ canceled: false });
    expect(fetch).toHaveBeenCalledWith('/api/docs/d1/content', expect.objectContaining({ headers: expect.objectContaining({ 'x-moss-share': 'tok' }) }));
    const [name, blob] = download.mock.calls[0] as [string, Blob];
    expect(name).toBe('Q4 - plan- draft-.md');
    expect(await blob.text()).toBe(exported);
    await api.notes.exportMarkdown('d1', { title: '   ', markdown: '' });
    expect(download.mock.calls[1][0]).toBe('Untitled.md');
  });

  it('fails Save as Markdown loudly when the export is refused, and downloads nothing', async () => {
    const download = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: 'not-found' }, { status: 404 }));
    const api = createBridge({ pathname: () => '/d/d1', fetch, browser: hooks({ download }) });
    await expect(api.notes.exportMarkdown('d1', { title: 'Plans', markdown: '' })).rejects.toThrow(/couldn’t export/i);
    expect(download).not.toHaveBeenCalled();
  });
});

describe('the T3.4 bridge', () => {
  const listing = { vault: { id: 'v1', name: 'Home' }, docs: [
    { id: 'd1', title: 'Quokka plans', filename: 'quokka-plans.md', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 },
    { id: 'd2', title: 'Diary', filename: 'diary.md', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_200_000 },
  ] };
  const routes = (extra: Record<string, unknown>) => vi.fn<typeof globalThis.fetch>(async (input) => {
    const path = String(input).split('?')[0];
    return Response.json(path in extra ? extra[path] : listing);
  });

  it('searches titles over the listing first, then content hits from GET /api/search with their snippet @p:note-7', async () => {
    const fetch = routes({ '/api/search': { results: [
      { id: 'd1', title: 'Quokka plans', snippet: 'x', folderId: 'v1', updatedAt: 1 },
      { id: 'd2', title: 'Diary', snippet: '...a quokka grazing...', folderId: 'v1', updatedAt: 1_700_000_200_000 },
      { id: 's9', title: '', snippet: 'shared quokka', folderId: 'v9', updatedAt: 1_700_000_300_000 },
    ] } });
    const api = createBridge({ pathname: () => '/', fetch });
    const results = await api.notes.search({ query: 'quokka', limit: 10 });
    expect(results).toEqual([
      { id: 'd1', title: 'Quokka plans', folderPath: 'Notes', updatedAt: 1_700_000_100, matchType: 'title' },
      { id: 'd2', title: 'Diary', folderPath: 'Notes', updatedAt: 1_700_000_200, snippet: '...a quokka grazing...', matchType: 'content' },
      { id: 's9', title: 'Untitled', folderPath: 'Notes', updatedAt: 1_700_000_300, snippet: 'shared quokka', matchType: 'content' },
    ]);
    expect(fetch).toHaveBeenCalledWith('/api/search?q=quokka&limit=10', expect.anything());
    expect(await api.notes.search({ query: 'quokka', excludeNoteId: 'd2' })).not.toContainEqual(expect.objectContaining({ id: 'd2' }));
    expect(await api.notes.search({ query: '  ' })).toEqual([]);
  });

  it('reads headings from GET /api/docs/:id/headings', async () => {
    const api = createBridge({ pathname: () => '/', fetch: routes({ '/api/docs/d1/headings': { headings: [{ level: 2, text: 'Risks' }] } }) });
    expect(await api.notes.getHeadings('d1')).toEqual([{ level: 2, text: 'Risks' }]);
  });

  it("carries an opened note's backlinks as moss's incomingLinks and announces them as a metadata change @p:note-7", async () => {
    const fetch = routes({ '/api/docs/d1/backlinks': { backlinks: [{ id: 'd2', title: 'Diary', folderId: 'v1', updatedAt: 1_700_000_200_000 }] } });
    const api = createBridge({ pathname: () => '/', fetch });
    const changed = vi.fn();
    const off = api.notes.onDiskChange(changed);
    try {
      await api.notes.getById('d1');
      await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(['d1'], []));
      const [record] = await api.notes.getMetadataByIds(['d1']);
      expect(record.incomingLinks).toEqual([{ noteId: 'd2', title: 'Diary', folderPath: 'Notes', updatedAt: 1_700_000_200 }]);
      expect((await api.notes.getAll()).find((note) => note.id === 'd1')?.incomingLinks, 'a full hydrate keeps them').toHaveLength(1);
    } finally { off(); }
  });
});

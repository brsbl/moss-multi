import { describe, expect, it, vi } from 'vitest';
import { knownRole } from '../access.ts';
import { markUnacked } from '../collab/unacked.ts';
import { runNativeMenuCommand } from '../media/image-menu.ts';
import { webAssetsInHtml } from '../media/web-asset-url.ts';
import { refusalMessage } from '../refusal.ts';
import { createBridge, docIdFromPath, EXPORT_ACK_WAIT_MS, inertBrowser, WORKSPACE, type BrowserHooks } from './index.ts';

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

  it('holds a listing in flight while the page leaves, and sends it again if the page stays', async () => {
    const controller = new AbortController();
    let stay = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { stay = resolve; });
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => ++calls > 1
      ? Promise.resolve(Response.json(LISTING))
      : new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
    let leave = { signal: controller.signal, stayed };
    const api = createBridge({ pathname: () => '/', fetch, leaving: () => leave });
    const settled = vi.fn();
    const listed = api.notes.getAll();
    void listed.then(settled, settled);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted, 'the read carries the leave, with its deadline').toBe(true);
    expect(settled, 'a leave never fails the read').not.toHaveBeenCalled();
    leave = { signal: new AbortController().signal, stayed: new Promise(() => undefined) };
    stay();
    expect((await listed).map((note) => note.id), 'the page stayed, so the read is sent again').toEqual(['d1']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('holds a listing whose body is still arriving when the page leaves, and sends it again if the page stays', async () => {
    const controller = new AbortController();
    let stay = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { stay = resolve; });
    let calls = 0;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      if (++calls > 1) return Promise.resolve(Response.json(LISTING));
      // The headers are in; the body fails when the navigation aborts the read.
      const body = new ReadableStream<Uint8Array>({ start(stream) {
        init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
      } });
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
    });
    let leave = { signal: controller.signal, stayed };
    const api = createBridge({ pathname: () => '/', fetch, leaving: () => leave });
    const settled = vi.fn();
    const listed = api.notes.getAll();
    void listed.then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled, 'a leave never fails the read').not.toHaveBeenCalled();
    leave = { signal: new AbortController().signal, stayed: new Promise(() => undefined) };
    stay();
    expect((await listed).map((note) => note.id), 'the page stayed, so the read is sent again').toEqual(['d1']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // An opened note's backlinks read, in flight as the page navigated, was WebKit's "…due to access control checks"
  // page error (j01-presence, run 38410412024; T3.B27).
  it("holds an opened note's backlinks read while the page leaves, and sends it again if the page stays", async () => {
    const controller = new AbortController();
    let stay = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { stay = resolve; });
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      if (!String(input).endsWith('/backlinks')) return Promise.resolve(Response.json(LISTING));
      signals.push(init?.signal);
      if (signals.length > 1) return Promise.resolve(Response.json({ backlinks: [] }));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    let leave = { signal: controller.signal, stayed };
    const api = createBridge({ pathname: () => '/', fetch, leaving: () => leave });
    await api.notes.getAll();
    await api.notes.getById('d1');
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0]?.aborted).toBe(false);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted, 'the read carries the leave').toBe(true);
    expect(signals, 'held while the page leaves').toHaveLength(1);
    leave = { signal: new AbortController().signal, stayed: new Promise(() => undefined) };
    stay();
    await vi.waitFor(() => expect(signals, 'the page stayed, so the read is sent again').toHaveLength(2));
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

describe('the T3.1 images bridge (A§9 images; A§16)', () => {
  const uploadBridge = (answer: (url: string, init?: RequestInit) => Response) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => answer(String(input), init));
    return { fetch, api: createBridge({ pathname: () => '/d/d1', fetch }) };
  };

  it("uploads a saved file's raw bytes to its note's asset route and returns moss's relative path", async () => {
    const { api, fetch } = uploadBridge(() => Response.json({ relativePath: 'assets/shot.png', filename: 'shot.png' }, { status: 201 }));
    const result = await api.images.save({ data: btoa('png-bytes'), filename: 'shot.png', mimeType: 'image/png', noteId: 'd1' });
    expect(result).toEqual({ relativePath: 'assets/shot.png', absolutePath: '/api/docs/d1/assets/shot.png', filename: 'shot.png' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/docs/d1/assets?filename=shot.png');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('image/png');
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toBe('png-bytes');
  });

  it("refuses a failed upload visibly with the server's sentence, never silently", async () => {
    const message = 'That file is larger than this note accepts.';
    const { api } = uploadBridge(() => Response.json({ error: 'too-large', message }, { status: 413 }));
    await expect(api.images.save({ data: btoa('x'), filename: 'big.png', mimeType: 'image/png', noteId: 'd1' })).rejects.toThrow(message);
    expect(refusalMessage()).toBe(message);
  });

  it('copies an asset from another note on the server', async () => {
    const { api, fetch } = uploadBridge(() => Response.json({ relativePath: 'assets/a.png', filename: 'a.png' }, { status: 201 }));
    const result = await api.images.copyFromNoteAsset({ sourceNoteId: 'd2', sourceRelativePath: 'assets/a.png', destinationNoteId: 'd1' });
    expect(result.relativePath).toBe('assets/a.png');
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/docs/d1/assets/copy');
    expect(JSON.parse(String(init?.body))).toEqual({ sourceNoteId: 'd2', sourceRelativePath: 'assets/a.png' });
  });

  it("carries the page's share link on an upload and a cross-note copy, as on every read", async () => {
    vi.stubGlobal('location', { search: '?share=tok%2F1', origin: 'http://localhost', pathname: '/d/d1' });
    try {
      const { api, fetch } = uploadBridge(() => Response.json({ relativePath: 'assets/a.png', filename: 'a.png' }, { status: 201 }));
      const saved = await api.images.save({ data: btoa('png'), filename: 'a.png', mimeType: 'image/png', noteId: 'd1' });
      await api.images.copyFromNoteAsset({ sourceNoteId: 'd2', sourceRelativePath: 'assets/a.png', destinationNoteId: 'd1' });
      const [upload, copy] = fetch.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
      expect(upload.pathname).toBe('/api/docs/d1/assets');
      expect(upload.searchParams.get('share'), 'the upload carries the link').toBe('tok/1');
      expect(copy.pathname).toBe('/api/docs/d1/assets/copy');
      expect(copy.searchParams.get('share'), 'the copy carries the link').toBe('tok/1');
      expect(new URL(saved.absolutePath, 'http://localhost').searchParams.get('share')).toBe('tok/1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends the link a pasted asset URL carried as the copy's sourceShare, apart from the page's own link (B221)", async () => {
    vi.stubGlobal('location', { search: '?share=page-link', origin: 'http://localhost', pathname: '/d/d1' });
    try {
      const { api, fetch } = uploadBridge(() => Response.json({ relativePath: 'assets/a.png', filename: 'a.png' }, { status: 201 }));
      // moss's paste plugin reads the clipboard HTML, then copies each asset by note and path alone.
      const pasted = webAssetsInHtml('<img src="/api/docs/s1/assets/a.png?share=source%2Flink"><img src="/api/docs/s2/assets/b.png">');
      expect(pasted.map((asset) => asset.noteId)).toEqual(['s1', 's2']);
      await api.images.copyFromNoteAsset({ sourceNoteId: 's1', sourceRelativePath: 'assets/a.png', destinationNoteId: 'd1' });
      await api.images.copyFromNoteAsset({ sourceNoteId: 's2', sourceRelativePath: 'assets/b.png', destinationNoteId: 'd1' });
      const [linked, member] = fetch.mock.calls.map(([url, init]) => ({ url: new URL(String(url), 'http://localhost'), body: JSON.parse(String(init?.body)) }));
      expect(linked.url.searchParams.get('share'), "the destination opens through the page's link").toBe('page-link');
      expect(linked.body).toEqual({ sourceNoteId: 's1', sourceRelativePath: 'assets/a.png', sourceShare: 'source/link' });
      expect(member.body, 'a URL with no link sends none').toEqual({ sourceNoteId: 's2', sourceRelativePath: 'assets/b.png' });
      // The same file pasted again without a link forgets the one remembered before.
      webAssetsInHtml('<img src="/api/docs/s1/assets/a.png">');
      await api.images.copyFromNoteAsset({ sourceNoteId: 's1', sourceRelativePath: 'assets/a.png', destinationNoteId: 'd1' });
      expect(JSON.parse(String(fetch.mock.calls[2][1]?.body)), 'a later tokenless paste sends no stale link')
        .toEqual({ sourceNoteId: 's1', sourceRelativePath: 'assets/a.png' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("carries the image context menu's Edit Alt Text… into moss's native command listener", async () => {
    const { api } = uploadBridge(() => Response.json({}));
    const commands: string[] = [];
    const stop = api.system.onNativeMenuCommand((command: string) => commands.push(command));
    runNativeMenuCommand('edit-image-alt-text');
    expect(commands).toEqual(['edit-image-alt-text']);
    stop();
    runNativeMenuCommand('edit-image-alt-text');
    expect(commands).toHaveLength(1);
  });
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
    const shared = createBridge({ pathname: () => '/d/d1', fetch: quiet(), share: () => 'tok en', browser: hooks({ open }) });
    await shared.system.createWindow({ noteId: 'd1' });
    expect(open).toHaveBeenLastCalledWith('https://moss.example/d/d1?share=tok%20en');
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

  it("opens the /pdf-export tab with the page's share link, so a link reader's images load there (B171)", async () => {
    const openWindow = vi.fn(() => true);
    const api = createBridge({ pathname: () => '/d/d1', fetch: quiet(), share: () => 'tok en/1?&', browser: hooks({ openWindow, session: memory() }) });
    const id = await api.notes.createPdfExportSession('d1', { title: 'Plans', markdown: '' });
    expect(await api.notes.openPdfExportPreview(id)).not.toBeNull();
    expect(await api.notes.openPdfExportRenderSurface(id)).not.toBeNull();
    for (const [opened] of openWindow.mock.calls as unknown as [string][]) {
      const url = new URL(opened, 'https://moss.example');
      expect(url.pathname).toBe('/pdf-export');
      expect(url.searchParams.get('pdfExportSessionId')).toBe(id);
      expect(url.searchParams.get('share'), 'the share link rides along, whole').toBe('tok en/1?&');
      expect([...url.searchParams.keys()].sort()).toEqual(['pdfExportSessionId', 'share']);
    }
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
    const api = createBridge({ pathname: () => '/d/d1', fetch, share: () => 'tok', browser: hooks({ download }) });
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

  it("waits for this tab's unacked edits before reading the export, so the file holds them", async () => {
    const download = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => String(input) === '/api/docs/d1/content'
      ? new Response('typed', { headers: { 'content-type': 'text/markdown' } })
      : Response.json(LISTING));
    const api = createBridge({ pathname: () => '/d/d1', fetch, browser: hooks({ download }) });
    const session = {};
    markUnacked(session, true);
    try {
      const saved = api.notes.exportMarkdown('d1', { title: 'Plans', markdown: '' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetch.mock.calls.map(([input]) => String(input)), 'no export read while an edit is unacked').not.toContain('/api/docs/d1/content');
      markUnacked(session, false);
      expect(await saved).toEqual({ canceled: false });
      expect(fetch.mock.calls.map(([input]) => String(input))).toContain('/api/docs/d1/content');
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      markUnacked(session, false);
    }
  });

  it('refuses Save as Markdown loudly when the edits stay unacked, and downloads nothing', async () => {
    vi.useFakeTimers();
    const download = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('stale', { headers: { 'content-type': 'text/markdown' } }));
    const api = createBridge({ pathname: () => '/d/d1', fetch, browser: hooks({ download }) });
    const session = {};
    markUnacked(session, true);
    try {
      const saved = expect(api.notes.exportMarkdown('d1', { title: 'Plans', markdown: '' })).rejects.toThrow(/haven’t synced/i);
      await vi.advanceTimersByTimeAsync(EXPORT_ACK_WAIT_MS + 1);
      await saved;
      expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain('/api/docs/d1/content');
      expect(download).not.toHaveBeenCalled();
    } finally {
      markUnacked(session, false);
      vi.useRealTimers();
    }
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

  it('a displayed result keeps the vault it opens in, whatever search answers after it (T9.18)', async () => {
    const home = { ...listing, vaults: [{ id: 'v1', name: 'Home' }, { id: 'v2', name: 'Scratch' }] };
    const answers = [
      { results: [
        { id: 's1', title: 'Lentil soup', snippet: 'lentil', folderId: 'v2', updatedAt: 1_700_000_300_000, vaultId: 'v2' },
        { id: 'd2', title: 'Diary', snippet: 'a lentil', folderId: 'v1', updatedAt: 1_700_000_200_000, vaultId: 'v1' },
        { id: 'x9', title: 'Shared', snippet: 'lentil', folderId: 'f9', updatedAt: 1_700_000_200_000 },
      ] },
      { results: [] },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      Response.json(String(input).startsWith('/api/search') ? answers.shift() : home));
    const api = createBridge({ pathname: () => '/', fetch });
    const shown = await api.notes.search({ query: 'lentil' });
    // An older or unrelated answer arrives after the displayed one.
    await api.notes.search({ query: 'nothing' });
    const pick = (id: string) => shown.find((hit) => hit.id === id) ?? {};
    expect(pick('s1'), 'the result names its vault').toMatchObject({ vaultId: 'v2' });
    expect(api[WORKSPACE].resultVault(pick('s1')), 'a result from another vault opens there').toBe('v2');
    expect(api[WORKSPACE].resultVault(pick('d2')), 'a result from the vault on screen opens in place').toBeNull();
    expect(api[WORKSPACE].resultVault(pick('x9')), 'a note reached on its own opens as before').toBeNull();
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

// m1's unload fix (T1.S1) is met on m2 by the `leaving` signal above, which also re-sends a read if the page stays.
it('still rejects a failed listing at once when the page is not leaving', async () => {
  let fail: (error: Error) => void = () => undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise<Response>((_resolve, reject) => { fail = reject; }));
  const api = createBridge({ pathname: () => '/', fetch });
  const listed = api.notes.getAll();
  fail(new TypeError('Load failed'));
  await expect(listed).rejects.toThrow('Load failed');
});

describe("the T9.19 bridge: the browser's Back and Forward move between notes (A§9 navigation)", () => {
  /** A tab's address and its history entries, as the browser keeps them. */
  function tab(start = '/', { trashed = new Set<string>(), opener = (): unknown => undefined } = {}) {
    const entries = [start];
    let index = 0;
    let pop: (() => void) | null = null;
    const browser: BrowserHooks = {
      ...inertBrowser,
      pushPath: (path: string) => { entries.splice(index + 1, Infinity, path); index = entries.length - 1; },
      replacePath: (path: string) => { entries[index] = path; },
      onPopState: (listener: () => void) => { pop = listener; return () => { pop = null; }; },
    };
    const docs = () => ['a', 'b', 'c'].map((id) => ({ id, title: id.toUpperCase(), createdAt: 1, updatedAt: 1, trashedAt: trashed.has(id) ? 2_000 : null }));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ vault: LISTING.vault, docs: docs() }));
    const api = createBridge({ pathname: () => entries[index].split('?')[0], fetch, browser });
    const opened: string[] = [];
    const off = api.notes.onInternalFileOpen((id: string) => { opened.push(id); return opener(); });
    const go = (delta: number) => { index += delta; pop?.(); };
    return { api, entries, opened, off, go, at: () => entries[index] };
  }
  /** moss reports the notes its panes show, then the focused one (App.tsx, one effect after the other, once it has
   * rendered: a task after its switch settled). */
  const show = async (api: ReturnType<typeof createBridge>, panes: string[], focused: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await api.notes.setOpenFileWatchTargets(panes);
    await api.system.setFocusedNoteId(focused);
  };

  it('adds one entry per note opened, none for the first note, and Back and Forward reopen them through moss', async () => {
    const t = tab('/');
    await show(t.api, ['a'], 'a');
    expect(t.entries, 'the first note of the session replaces the address').toEqual(['/d/a']);
    await show(t.api, ['b'], 'b');
    await show(t.api, ['c'], 'c');
    expect(t.entries, 'one entry per note opened').toEqual(['/d/a', '/d/b', '/d/c']);

    t.go(-1);
    expect(t.opened, 'Back opens B through moss').toEqual(['b']);
    await show(t.api, ['b'], 'b');
    t.go(-1);
    await show(t.api, ['a'], 'a');
    t.go(1);
    await show(t.api, ['b'], 'b');
    expect(t.opened).toEqual(['b', 'a', 'b']);
    expect(t.entries, 'Back and Forward add no entry').toEqual(['/d/a', '/d/b', '/d/c']);
    expect(t.at()).toBe('/d/b');
    t.off();
  });

  it('adds no entry when focus moves between split panes, and one when a pane goes to another note', async () => {
    const t = tab('/d/a');
    await show(t.api, ['a'], 'a');
    expect(t.entries, 'a note already in the address').toEqual(['/d/a']);
    await show(t.api, ['a', 'b'], 'b');
    await show(t.api, ['a', 'b'], 'a');
    await show(t.api, ['a', 'b'], 'b');
    expect(t.entries, 'opening a split and clicking between its panes adds nothing; the address follows focus').toEqual(['/d/b']);
    await show(t.api, ['a', 'c'], 'c');
    expect(t.entries, 'the right pane going to C is a visit').toEqual(['/d/b', '/d/c']);
    await show(t.api, ['a'], 'a');
    expect(t.entries, 'closing the split adds nothing').toEqual(['/d/b', '/d/a']);
    t.off();
  });

  it("waits for moss to reach the note Back chose, so a quick second Back keeps Forward's entries", async () => {
    const t = tab('/');
    for (const id of ['a', 'b', 'c']) await show(t.api, [id], id);
    t.go(-1);
    t.go(-1);
    // moss switches one note at a time: B first, then A.
    await show(t.api, ['b'], 'b');
    await show(t.api, ['a'], 'a');
    expect(t.entries).toEqual(['/d/a', '/d/b', '/d/c']);
    expect(t.at()).toBe('/d/a');
    t.off();
  });

  it('never puts a note trashed since its entry was made in the address when Back or Forward reaches it', async () => {
    const trashed = new Set<string>();
    const t = tab('/', { trashed });
    for (const id of ['a', 'b', 'c']) await show(t.api, [id], id);
    t.go(-1);
    await show(t.api, ['b'], 'b');
    t.go(-1);
    trashed.add('b');
    await show(t.api, ['a'], 'a');
    t.go(1);
    expect(t.opened, "moss opens B's Trash view, as its own arrow does").toEqual(['b', 'a', 'b']);
    await show(t.api, ['b'], 'b');
    expect(t.at(), 'the address names the last live note, never the trashed one').toBe('/d/a');
    t.go(1);
    await show(t.api, ['c'], 'c');
    t.go(-1);
    await show(t.api, ['a'], 'a');
    t.go(-1);
    await show(t.api, ['a'], 'a');
    expect(t.entries).toEqual(['/d/a', '/d/a', '/d/c']);
    t.off();
  });

  it("keeps Forward's entries however long moss takes to pass the note between two quick Backs", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const t = tab('/');
      for (const id of ['a', 'b', 'c']) await show(t.api, [id], id);
      t.go(-1);
      t.go(-1);
      now += 60_000;
      await show(t.api, ['b'], 'b');
      now += 60_000;
      await show(t.api, ['a'], 'a');
      expect(t.entries).toEqual(['/d/a', '/d/b', '/d/c']);
      expect(t.at()).toBe('/d/a');
      t.go(1);
      await show(t.api, ['b'], 'b');
      t.go(1);
      await show(t.api, ['c'], 'c');
      expect(t.entries).toEqual(['/d/a', '/d/b', '/d/c']);
      t.off();
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the last live note in the address when Back passes two notes trashed since their entries were made', async () => {
    const trashed = new Set<string>();
    const t = tab('/', { trashed });
    await show(t.api, ['a'], 'a');
    await show(t.api, ['b'], 'b');
    // A and B go to Trash; opening C reads the listing that says so.
    trashed.add('a');
    trashed.add('b');
    await show(t.api, ['c'], 'c');
    expect(t.entries).toEqual(['/d/a', '/d/b', '/d/c']);
    t.go(-1);
    await show(t.api, ['b'], 'b');
    expect(t.at(), "B's Trash view: the address names C").toBe('/d/c');
    t.go(-1);
    await show(t.api, ['a'], 'a');
    expect(t.opened, "moss opens each note's Trash view").toEqual(['b', 'a']);
    expect(t.at(), "A's Trash view: the address still names C, the last live note").toBe('/d/c');
    t.off();
  });

  it('keeps the last live note in the address when Forward reaches a note trashed while it showed in the other pane', async () => {
    const trashed = new Set<string>();
    const t = tab('/', { trashed });
    await show(t.api, ['a'], 'a');
    await show(t.api, ['a', 'b'], 'b');
    await show(t.api, ['a', 'c'], 'c');
    expect(t.entries).toEqual(['/d/b', '/d/c']);
    t.go(-1);
    // C goes to Trash while it shows in the other pane; reaching B reads the listing that says so.
    trashed.add('c');
    await show(t.api, ['b', 'c'], 'b');
    // moss shows C's Trash view in the other pane, and focus goes to it.
    await show(t.api, ['b', 'c'], 'c');
    expect(t.at()).toBe('/d/b');
    t.go(1);
    await show(t.api, ['c'], 'c');
    expect(t.at(), 'a trashed note has no address: it names B').toBe('/d/b');
    t.off();
  });

  it('puts the shown note back in the address when the switch Back asked for does not happen', async () => {
    let went: unknown;
    const t = tab('/', { opener: () => Promise.resolve(went) });
    for (const id of ['a', 'b', 'c']) await show(t.api, [id], id);
    went = false;
    t.go(-1);
    await vi.waitFor(() => expect(t.at(), 'C is still shown, so the address names C').toBe('/d/c'));
    went = true;
    t.go(-1);
    await show(t.api, ['a'], 'a');
    expect(t.at()).toBe('/d/a');
    expect(t.entries).toEqual(['/d/a', '/d/c', '/d/c']);
    t.off();
  });
});

describe('the T9.56 bridge: a note opened by its address and not listed', () => {
  const doc = (id: string) => ({ id, title: id.toUpperCase(), createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000 });
  /** A tab whose listing carries `listed`, and whose `GET /api/docs/x` opens x at editor; x's backlinks read is a 404. */
  function tab() {
    const listed = [doc('d1')];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input).split('?')[0];
      if (path === '/api/docs/x') return Response.json({ role: 'editor', doc: doc('x') });
      if (path === '/api/docs/x/backlinks') return new Response('{}', { status: 404 });
      if (path.endsWith('/backlinks')) return Response.json({ backlinks: [] });
      return Response.json({ vault: LISTING.vault, docs: listed });
    });
    return { api: createBridge({ pathname: () => '/', fetch }), listed, fetch };
  }

  it('is outside the listing once the gate admits it, until a listing carries it', async () => {
    const { api, listed } = tab();
    await api.notes.getAll();
    api[WORKSPACE].admit(doc('x'));
    expect(api[WORKSPACE].outsideListing('x'), 'an admitted note').toBe(true);
    expect(api[WORKSPACE].outsideListing('d1'), 'a listed note').toBe(false);
    expect(api[WORKSPACE].outsideListing('y'), 'a note the tab never learned by its address').toBe(false);
    listed.push(doc('x'));
    await api.system.setFocusedNoteId('x');
    await vi.waitFor(() => expect(api[WORKSPACE].outsideListing('x'), 'the same note once a listing carries it').toBe(false));
  });

  it('stays outside the listing after the backlinks read that drops it from the admitted notes', async () => {
    const { api, fetch } = tab();
    await api.notes.getAll();
    expect((await api.notes.getById('x'))?.id, 'byId opens it by its address').toBe('x');
    expect(api[WORKSPACE].outsideListing('x')).toBe(true);
    await vi.waitFor(() => expect(fetch.mock.calls.map(([input]) => String(input).split('?')[0])).toContain('/api/docs/x/backlinks'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api[WORKSPACE].outsideListing('x'), 'after the backlinks 404').toBe(true);
  });
});

// The page's leave (METHOD: WebKit logs a fetch a navigation cancelled as an access-control page error): every read
// that can span a reload is aborted as the page leaves, request or body, and sent again if it stays; a change is sent
// at most once and, cut off by a leave, settles as a handled cancellation the caller reconciles.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askDocAccess } from './access.ts';
import { createBridge, WORKSPACE } from './bridge/index.ts';
import { isLeaveCancelled, setLeaving, type Leave } from './leave.ts';

vi.stubGlobal('window', { location: { search: '', origin: 'http://localhost' } });
const { call } = await import('./surfaces/ShareDialog.tsx');
const { askAccess } = await import('./collab/doc-session.ts');

afterEach(() => {
  setLeaving(null);
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '', origin: 'http://localhost' } });
});

/** A page whose leave the test fires and ends. */
function page() {
  const arm = () => {
    let end = () => undefined as void;
    const stayed = new Promise<void>((resolve) => { end = resolve; });
    return { controller: new AbortController(), stayed, end };
  };
  let current = arm();
  return {
    leaving: (): Leave => ({ signal: current.controller.signal, stayed: current.stayed }),
    leave: () => current.controller.abort(),
    stay: () => {
      const left = current;
      current = arm();
      left.end();
    },
  };
}

type Hold = 'request' | 'body';
const LISTING = { vault: { id: 'v1', name: 'Home' }, docs: [{ id: 'd1', title: 'Plans', createdAt: 1, updatedAt: 1 }] };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The first matching request never answers (`request`) or never finishes its body (`body`) until aborted. */
function held(how: Hold, init: RequestInit | undefined): Promise<Response> {
  if (how === 'request') {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  }
  const body = new ReadableStream<Uint8Array>({ start(stream) {
    init?.signal?.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')));
  } });
  return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/json' } }));
}

/** A fetch whose first request matching `target` is held; every other answers from `answer`. */
function fetcher(how: Hold, target: (path: string, init?: RequestInit) => boolean, answer: (path: string, init?: RequestInit) => Response) {
  const sent: { path: string; signal: AbortSignal | null | undefined }[] = [];
  let holding = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = String(input);
    if (target(path, init)) {
      sent.push({ path, signal: init?.signal });
      if (holding) {
        holding = false;
        return held(how, init);
      }
    }
    return answer(path, init);
  });
  return { fetch, sent };
}

describe.each<Hold>(['request', 'body'])('with the %s held', (how) => {
  const mutations = [
    { name: 'create', path: '/api/docs', method: 'POST', run: (api: ReturnType<typeof createBridge>) => api.notes.create('Plans') },
    { name: 'duplicate', path: '/api/docs/d1/duplicate', method: 'POST', run: (api: ReturnType<typeof createBridge>) => api[WORKSPACE].duplicate('d1') },
    { name: 'rename', path: '/api/docs/d1', method: 'PATCH', run: (api: ReturnType<typeof createBridge>) => api.notes.update('d1', { title: 'Renamed' }) },
  ];

  it.each(mutations)('the bridge sends $name once; a leave cuts it off as a handled cancellation, and the listing is read again once the page stays', async ({ path, method, run }) => {
    const { leaving, leave, stay } = page();
    const listings: string[] = [];
    const { fetch, sent } = fetcher(how, (p, init) => p === path && init?.method === method, (p) => {
      if (p.startsWith('/api/workspace')) listings.push(p);
      return Response.json(LISTING);
    });
    const api = createBridge({ pathname: () => '/', fetch, leaving });
    await api.notes.getAll();
    const settled = vi.fn();
    const change: Promise<unknown> = run(api);
    void change.then(settled, settled);
    await vi.waitFor(() => expect(sent, 'the change is in flight').toHaveLength(1));
    await tick();
    expect(sent[0].signal, 'it carries the leave').toBeDefined();
    const before = listings.length;
    leave();
    await vi.waitFor(() => expect(sent[0].signal?.aborted, 'the leave aborts it').toBe(true));
    await tick();
    expect(settled, 'nothing settles while the page leaves').not.toHaveBeenCalled();
    stay();
    const error = await change.then(() => null, (reason: unknown) => reason);
    expect(isLeaveCancelled(error), 'a handled cancellation').toBe(true);
    expect(sent, 'never sent twice').toHaveLength(1);
    expect(listings.length, 'the listing is read again to see whether it landed').toBeGreaterThan(before);
  });

  it("the bridge's content read is held while the page leaves and read again once it stays", async () => {
    const { leaving, leave, stay } = page();
    const { fetch, sent } = fetcher(how, (p) => p === '/api/docs/d1/content', (p) => (p.endsWith('/content') ? new Response('# Plans') : Response.json(LISTING)));
    const api = createBridge({ pathname: () => '/', fetch, leaving });
    const read = api.notes.getContent('d1');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await tick();
    leave();
    await vi.waitFor(() => expect(sent[0].signal?.aborted, 'the leave aborts it').toBe(true));
    stay();
    expect(await read).toEqual(expect.objectContaining({ content: '# Plans' }));
    expect(sent, 'sent again after the stay').toHaveLength(2);
  });

  it("the route's access read is held while the page leaves and read again once it stays, never concluding unavailable", async () => {
    const { leaving, leave, stay } = page();
    setLeaving(leaving);
    const id = `doc-${how}`;
    const { fetch, sent } = fetcher(how, (p) => p === `/api/docs/${id}`, () => Response.json({ role: 'editor', doc: { id, folderId: 'v1', title: 'Plans', createdAt: 1, updatedAt: 1 } }));
    const answer = askDocAccess(id, fetch);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await tick();
    leave();
    await vi.waitFor(() => expect(sent[0].signal?.aborted, 'the leave aborts it').toBe(true));
    stay();
    expect((await answer).kind).toBe('open');
    expect(sent).toHaveLength(2);
  });

  it("a doc session's access ask is held while the page leaves and asked again once it stays", async () => {
    const { leaving, leave, stay } = page();
    setLeaving(leaving);
    const { fetch, sent } = fetcher(how, (p) => p.startsWith('/api/docs/doc/access'), () => Response.json({ role: 'viewer' }));
    vi.stubGlobal('fetch', fetch);
    const answer = askAccess('doc');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await tick();
    leave();
    await vi.waitFor(() => expect(sent[0].signal?.aborted, 'the leave aborts it').toBe(true));
    stay();
    expect(await answer).toEqual(expect.objectContaining({ kind: 'role', role: 'viewer' }));
    expect(sent).toHaveLength(2);
  });

  it("the Share dialog's reads are held and read again; its changes are sent once and settle as a handled cancellation", async () => {
    const { leaving, leave, stay } = page();
    setLeaving(leaving);
    const reads = fetcher(how, (_p, init) => (init?.method ?? 'GET') === 'GET', () => Response.json({ members: [] }));
    vi.stubGlobal('fetch', reads.fetch);
    const listed = call<{ members: unknown[] }>('/api/docs/d1/members');
    await vi.waitFor(() => expect(reads.sent).toHaveLength(1));
    await tick();
    leave();
    await vi.waitFor(() => expect(reads.sent[0].signal?.aborted, 'the leave aborts the read').toBe(true));
    stay();
    expect(await listed).toEqual(expect.objectContaining({ ok: true, body: { members: [] } }));
    expect(reads.sent).toHaveLength(2);

    const changes = fetcher(how, (_p, init) => init?.method === 'POST', () => Response.json({ shared: { email: 'ben@example.invalid' } }));
    vi.stubGlobal('fetch', changes.fetch);
    const shared = call('/api/docs/d1/members', { method: 'POST', body: JSON.stringify({ email: 'ben@example.invalid', role: 'editor' }) });
    const settled = vi.fn();
    void shared.then(settled, settled);
    await vi.waitFor(() => expect(changes.sent).toHaveLength(1));
    await tick();
    leave();
    await vi.waitFor(() => expect(changes.sent[0].signal?.aborted, 'the leave aborts the change').toBe(true));
    await tick();
    expect(settled).not.toHaveBeenCalled();
    stay();
    expect(isLeaveCancelled(await shared.then(() => null, (reason: unknown) => reason)), 'a handled cancellation').toBe(true);
    expect(changes.sent, 'never sent twice').toHaveLength(1);
  });
});

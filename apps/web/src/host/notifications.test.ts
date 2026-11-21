// The tab's notices (T2.8): read on a push, cleared on sign-out without a request, and marked read with a keepalive
// request that the page never waits for, so opening a notice can never wait on the network mid-sentence (L§4.6).
import { expect, it, vi } from 'vitest';
import { setLeaving } from './leave.ts';
import { createNotifications, groupNotices, openNotice, type Notice } from './notifications.ts';

const notice = (id: string, read = false): Notice => ({
  id, type: 'share-invite', read, createdAt: 1, by: 'Ada', target: { type: 'doc', id: `doc-${id}`, title: 'Plan', kind: 'doc' },
});

function harness(answers: Notice[][]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let signedIn = true;
  const pending: ((response: Response) => void)[] = [];
  const store = createNotifications({
    signedIn: () => signedIn,
    fetch: (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === '/api/notifications') return Promise.resolve(Response.json({ notifications: answers.shift() ?? [] }));
      return new Promise<Response>((resolve) => pending.push(resolve));
    },
  });
  return { store, calls, pending, signOut: () => { signedIn = false; } };
}

it('marks a notice read at once and sends it with keepalive, never awaited', async () => {
  const { store, calls, pending } = harness([[notice('a'), notice('b')]]);
  await store.refresh();
  expect(store.unread()).toBe(2);
  store.markRead(['a']);
  expect(store.get().find((n) => n.id === 'a')?.read, 'read before the request answers').toBe(true);
  expect(store.unread()).toBe(1);
  const sent = calls.find((c) => c.url === '/api/notifications/read');
  expect(sent?.init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'same-origin' });
  expect(JSON.parse(String(sent?.init?.body)), 'reading a notice redeems nothing; its invite is followed separately').toEqual({ ids: ['a'] });
  expect(pending).toHaveLength(1);
});

it('keeps only the newest read when pushes overlap, and forgets everything on sign-out without asking', async () => {
  const { store, calls, signOut } = harness([[notice('old')], [notice('new')]]);
  const first = store.refresh();
  const second = store.refresh();
  await Promise.all([first, second]);
  expect(store.get().map((n) => n.id)).toEqual(['new']);
  signOut();
  const before = calls.length;
  await store.refresh();
  expect(store.get()).toEqual([]);
  expect(calls.length, 'no request once signed out').toBe(before);
});

// A reader who loses access through a move hears only a meta event; the server lists notices by current access.
it('reads the notices again on a metadata push, coalesced, so a notice for a note the reader lost clears', async () => {
  vi.useFakeTimers();
  try {
    const { store, calls } = harness([[notice('a')], []]);
    await store.refresh();
    expect(store.unread()).toBe(1);
    for (let i = 0; i < 5; i += 1) store.receive({ type: 'meta', docIds: ['doc-a'], folderIds: ['f1'] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(store.get(), 'the stale notice is gone').toEqual([]);
    expect(store.unread()).toBe(0);
    expect(calls.filter((c) => c.url === '/api/notifications'), 'a burst of pushes reads once').toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('drops a read that was in flight when the session ended, and asks nothing afterwards', async () => {
  vi.useFakeTimers();
  try {
    let answer!: (response: Response) => void;
    const calls: string[] = [];
    let signedIn = true;
    const store = createNotifications({
      signedIn: () => signedIn,
      fetch: (input) => {
        calls.push(String(input));
        return new Promise<Response>((resolve) => { answer = resolve; });
      },
    });
    store.receive({ type: 'meta', docIds: ['doc-a'], folderIds: [] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls, 'the push asked').toEqual(['/api/notifications']);
    store.receive({ type: 'meta', docIds: ['doc-b'], folderIds: [] });
    signedIn = false;
    store.clear();
    answer(Response.json({ notifications: [notice('late')] }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.get(), 'the late answer never shows').toEqual([]);
    expect(calls, 'nothing asked after clear').toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

// A metadata push lands as the page reloads: the bell's read follows the page's leave, so WebKit logs no page error.
it('holds the bell read while the page leaves and reads again once it stays', async () => {
  let end = () => undefined as void;
  let controller = new AbortController();
  const stayed = new Promise<void>((resolve) => { end = resolve; });
  setLeaving(() => ({ signal: controller.signal, stayed }));
  try {
    const signals: (AbortSignal | null | undefined)[] = [];
    let answers = 0;
    const store = createNotifications({
      signedIn: () => true,
      fetch: (_input, init) => {
        signals.push(init?.signal);
        if (answers++ === 0) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(Response.json({ notifications: [notice('a')] }));
      },
    });
    const reading = store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted, 'the read carries the leave').toBe(false);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted, 'the leave aborts it').toBe(true);
    expect(signals, 'nothing sent while the page leaves').toHaveLength(1);
    controller = new AbortController();
    end();
    await reading;
    expect(signals, 'sent again once the page stays').toHaveLength(2);
    expect(store.unread()).toBe(1);
  } finally { setLeaving(null); }
});

// Sign-out while a bell read is held by a leave: the page stays, and the read must not go out for a session that ended.
it('never sends a held bell read once clear() ran', async () => {
  let end = () => undefined as void;
  let controller = new AbortController();
  const stayed = new Promise<void>((resolve) => { end = resolve; });
  setLeaving(() => ({ signal: controller.signal, stayed }));
  try {
    let signedIn = true;
    const sent: string[] = [];
    const store = createNotifications({
      signedIn: () => signedIn,
      fetch: (input, init) => {
        sent.push(String(input));
        if (sent.length === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          });
        }
        return Promise.resolve(Response.json({ notifications: [notice('a')] }));
      },
    });
    const reading = store.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    signedIn = false;
    store.clear();
    controller = new AbortController();
    end();
    await reading;
    expect(sent, 'the held read is not sent after sign-out').toHaveLength(1);
    expect(store.unread()).toBe(0);
  } finally { setLeaving(null); }
});

// T9.38: the inbox tells a first read in flight, a failed one and an empty answer apart.
it('is loading until its first answer, failed when that read fails, and ready once one lands', async () => {
  const answers: Response[] = [new Response('', { status: 500 }), Response.json({ notifications: [] })];
  let answer!: (response: Response) => void;
  const store = createNotifications({
    signedIn: () => true,
    fetch: () => new Promise<Response>((resolve) => { answer = resolve; }),
  });
  expect(store.status(), 'nothing answered yet').toBe('loading');
  const first = store.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.status()).toBe('loading');
  answer(answers.shift()!);
  await first;
  expect(store.status(), 'the first read failed').toBe('error');
  expect(store.get()).toEqual([]);
  const retried = store.refresh();
  expect(store.status(), 'a retry is loading again').toBe('loading');
  await new Promise((resolve) => setTimeout(resolve, 0));
  answer(answers.shift()!);
  await retried;
  expect(store.status(), 'an empty answer is ready, not failed').toBe('ready');
  store.clear();
});

it('keeps what it showed, and stays ready, when a later read fails', async () => {
  let fail = false;
  const store = createNotifications({
    signedIn: () => true,
    fetch: () => Promise.resolve(fail ? new Response('', { status: 503 }) : Response.json({ notifications: [notice('a')] })),
  });
  await store.refresh();
  fail = true;
  await store.refresh();
  expect(store.status()).toBe('ready');
  expect(store.get().map((n) => n.id)).toEqual(['a']);
  store.clear();
});

it('groups a note\'s notices under it by their existing target ids, newest group first, each notice kept whole', () => {
  const at = (id: string, docId: string, createdAt: number, read = false): Notice => ({
    id, type: 'mention', read, createdAt, by: 'Ada', target: { type: 'doc', id: docId, title: docId, kind: 'doc' },
  });
  const folder: Notice = { id: 'f', type: 'share-invite', read: false, createdAt: 5, by: 'Ben', target: { type: 'folder', id: 'plan', title: 'Plan', kind: 'folder' } };
  const groups = groupNotices([at('n4', 'b', 4), folder, at('n3', 'a', 3, true), at('n2', 'b', 2), at('n1', 'a', 1)]);
  expect(groups.map((g) => g.key)).toEqual(['doc:b', 'folder:plan', 'doc:a']);
  expect(groups.map((g) => g.notices.map((n) => n.id))).toEqual([['n4', 'n2'], ['f'], ['n3', 'n1']]);
  expect(groups[2].notices[0].read, 'each notice keeps its own read state').toBe(true);
  // A folder and a note never share a group, even with the same id.
  expect(groupNotices([at('x', 'same', 2), { ...folder, target: { ...folder.target, id: 'same' } }])).toHaveLength(2);
});

it('opens a notice\'s target first and marks it read only once the target is reached', async () => {
  const order: string[] = [];
  let reach!: (ok: boolean) => void;
  const marked: string[][] = [];
  const opened = openNotice(notice('a'), {
    open: () => { order.push('open'); return new Promise<boolean>((resolve) => { reach = resolve; }); },
    markRead: (ids) => { order.push('read'); marked.push(ids); },
    unreachable: (id) => order.push(`unreachable:${id}`),
  });
  expect(order, 'nothing is read while the note opens').toEqual(['open']);
  reach(true);
  expect(await opened).toBe(true);
  expect(marked).toEqual([['a']]);

  const refused = openNotice(notice('b'), {
    open: () => Promise.resolve(false),
    markRead: (ids) => marked.push(ids),
    unreachable: (id) => order.push(`unreachable:${id}`),
  });
  expect(await refused).toBe(false);
  expect(marked, 'a target that never opened stays unread').toEqual([['a']]);
  expect(order.at(-1), 'and its row says so').toBe('unreachable:b');
});

it('remembers which notices could not be opened, and forgets them on sign-out', () => {
  const store = createNotifications({ signedIn: () => true, fetch: () => Promise.resolve(Response.json({ notifications: [] })) });
  expect(store.unreachable().has('a')).toBe(false);
  store.markUnreachable('a');
  expect(store.unreachable().has('a')).toBe(true);
  store.clear();
  expect(store.unreachable().size).toBe(0);
});

// The tab's notices (T2.8): read on a push, cleared on sign-out without a request, and marked read with a keepalive
// request that the page never waits for, so opening a notice can never wait on the network mid-sentence (L§4.6).
import { expect, it, vi } from 'vitest';
import { createNotifications, type Notice } from './notifications.ts';

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

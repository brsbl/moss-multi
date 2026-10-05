import { afterEach, expect, it, vi } from 'vitest';
import { createBridge, WORKSPACE, type BridgeOptions } from './index.ts';

type Event = { type: 'meta'; docIds: string[]; folderIds: string[] };
afterEach(() => vi.useRealTimers());

it('workspace pushes create, rename, trash and updated_at as targeted metadata, never content or unchanged vault notifications', async () => {
  vi.useFakeTimers();
  let receive: (event: Event) => void = () => undefined;
  let rows = [{ id: 'bound', title: 'Open elsewhere', createdAt: 1000, updatedAt: 1000 }];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const ids = new URL(String(input), 'http://localhost').searchParams.getAll('ids');
    return Response.json({ vault: { id: 'home', name: 'Home' }, docs: ids.length ? rows.filter((row) => ids.includes(row.id)) : rows });
  });
  const options: BridgeOptions & { subscribeWorkspace: (cb: typeof receive) => () => void } = {
    pathname: () => '/d/bound', fetch,
    subscribeWorkspace: (cb) => { receive = cb; return () => undefined; },
  };
  const bridge = createBridge(options);
  const changed = vi.fn();
  const vaultChanged = vi.fn();
  const off = bridge.notes.onDiskChange(changed);
  await bridge.notes.getAll();
  bridge[WORKSPACE].subscribe(vaultChanged);
  try {
    rows = [...rows, { id: 'new', title: 'Created', createdAt: 2000, updatedAt: 2000 }];
    receive({ type: 'meta', docIds: ['new'], folderIds: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenLastCalledWith(['new'], []);
    expect(await bridge.notes.getMetadataByIds(['new'])).toEqual([expect.objectContaining({ title: 'Created' })]);
    rows = rows.map((row) => row.id === 'bound' ? { ...row, title: 'Renamed', updatedAt: 9000 } : row);
    receive({ type: 'meta', docIds: ['bound'], folderIds: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenLastCalledWith(['bound'], []);
    expect(await bridge.notes.getMetadataByIds(['bound'])).toEqual([expect.objectContaining({ title: 'Renamed', updatedAt: 9 })]);
    expect((await bridge.notes.getAll()).map((row) => row.id)).toEqual(['bound', 'new']);
    rows = rows.filter((row) => row.id !== 'new');
    receive({ type: 'meta', docIds: ['new'], folderIds: [] });
    await vi.advanceTimersByTimeAsync(100);
    expect(await bridge.notes.getMetadataByIds(['new'])).toEqual([]);
    expect(changed).toHaveBeenLastCalledWith(['new'], []);
    expect(vaultChanged).not.toHaveBeenCalled();
    const count = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(count);
  } finally { off(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('does not restart a metadata refresh when sign-out interrupts a vault-switch wait', async () => {
  vi.useFakeTimers();
  const refresh = deferred<Response>();
  const switched = deferred<Response>();
  const home = () => Response.json({ vault: { id: 'home', name: 'Home' }, docs: [] });
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(home())
    .mockReturnValueOnce(refresh.promise).mockReturnValueOnce(switched.promise)
    .mockResolvedValue(new Response(null, { status: 503 }));
  let receive!: Parameters<NonNullable<BridgeOptions['subscribeWorkspace']>>[0];
  let pause!: () => void;
  const bridge = createBridge({ pathname: () => '/', fetch,
    subscribeWorkspace: (cb, stop) => { receive = cb; pause = stop; return () => undefined; } });
  const changed = vi.fn();
  const off = bridge.notes.onDiskChange(changed);
  try {
    await bridge.notes.getAll();
    receive({ type: 'meta', docIds: ['new'], folderIds: [] });
    await vi.advanceTimersByTimeAsync(0);
    const switching = bridge[WORKSPACE].switchVault('other');
    refresh.resolve(home());
    await vi.advanceTimersByTimeAsync(0);
    pause();
    switched.resolve(Response.json({ vault: { id: 'other', name: 'Other' }, docs: [] }));
    await switching;
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(changed).not.toHaveBeenCalled();
  } finally { off(); }
});

it('retries metadata received during a failed initial listing without another event', async () => {
  vi.useFakeTimers();
  const first = deferred<Response>();
  const rows = [{ id: 'new', title: 'Created', createdAt: 2000, updatedAt: 2000 }];
  const fetch = vi.fn<typeof globalThis.fetch>().mockReturnValueOnce(first.promise)
    .mockImplementation(async () => Response.json({ vault: { id: 'home', name: 'Home' }, docs: rows }));
  let receive!: Parameters<NonNullable<BridgeOptions['subscribeWorkspace']>>[0];
  const bridge = createBridge({ pathname: () => '/', fetch,
    subscribeWorkspace: (cb) => { receive = cb; return () => undefined; } });
  const changed = vi.fn();
  const off = bridge.notes.onDiskChange(changed);
  try {
    const initial = bridge.notes.getAll().catch(() => undefined);
    receive({ type: 'meta', docIds: ['new'], folderIds: [] });
    first.resolve(new Response(null, { status: 503 }));
    await initial;
    await vi.advanceTimersByTimeAsync(1500);
    expect(changed).toHaveBeenCalledWith(['new'], []);
    expect(await bridge.notes.getMetadataByIds(['new'])).toEqual([expect.objectContaining({ title: 'Created' })]);
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(calls);
  } finally { off(); }
});

it('hands the doc ids of every metadata push to the reopen hook, so a doc left terminal on a live note can recover', async () => {
  let receive: (event: Event) => void = () => undefined;
  const reopenDocs = vi.fn();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ vault: { id: 'home', name: 'Home' }, docs: [] }));
  const bridge = createBridge({ pathname: () => '/', fetch, subscribeWorkspace: (cb) => { receive = cb; return () => undefined; }, reopenDocs } as BridgeOptions);
  const off = bridge.notes.onDiskChange(() => undefined);
  await bridge.notes.getAll();
  try {
    receive({ type: 'meta', docIds: ['kept'], folderIds: [] });
    expect(reopenDocs).toHaveBeenCalledWith(['kept']);
  } finally { off(); }
});

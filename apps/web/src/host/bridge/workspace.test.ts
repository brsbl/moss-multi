import { afterEach, expect, it, vi } from 'vitest';
import { createBridge, WORKSPACE, type BridgeOptions } from './index.ts';

type Event = { type: 'meta'; docIds: string[]; folderIds: string[] };
afterEach(() => vi.useRealTimers());

it('workspace pushes create, rename, trash and updated_at as targeted metadata, never content or unchanged vault notifications', async () => {
  vi.useFakeTimers();
  let receive: (event: Event) => void = () => undefined;
  let rows = [{ id: 'bound', title: 'Open elsewhere', createdAt: 1000, updatedAt: 1000 }];
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ vault: { id: 'home', name: 'Home' }, docs: rows }));
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

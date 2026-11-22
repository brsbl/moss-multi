// Backlinks on the bridge (A§15): a note opened by its URL outside the listing gets its incomingLinks (B238), and a
// note whose session ended as deleted or revoked sends no backlinks read and ignores one in flight (B178, j05's 404).
import { expect, it, onTestFinished, vi } from 'vitest';
import { clearTerminal, setTerminal } from '../collab/terminal.ts';
import { createBridge } from './index.ts';

const NOW = 1_700_000_000_000;
const doc = (id: string, title: string) => ({ id, title, createdAt: NOW, updatedAt: NOW, folderId: 'home', folderPath: 'Notes', role: 'owner', trashedAt: null });

type Receive = Parameters<NonNullable<Parameters<typeof createBridge>[0]['subscribeWorkspace']>>[0];

function fakeServer() {
  const calls: { path: string; signal: AbortSignal | null | undefined }[] = [];
  const state = {
    linking: { x: [doc('d2', 'Two')], d1: [doc('d2', 'Two')] } as Record<string, ReturnType<typeof doc>[]>,
    denied: new Set<string>(),
    /** Backlinks reads answered by the test, by doc id. */
    held: new Map<string, (response: Response) => void>(),
    hold: new Set<string>(),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    calls.push({ path, signal: init.signal });
    if (path === '/api/workspace') {
      return Response.json({ vault: { id: 'home', name: 'Home', role: 'owner', owned: true }, docs: [doc('d1', 'One'), doc('d2', 'Two')], folders: [] });
    }
    if (path === '/api/docs/x') return Response.json({ role: 'viewer', doc: doc('x', 'Shared with me') });
    const backlinks = /^\/api\/docs\/([^/]+)\/backlinks$/.exec(path);
    if (backlinks) {
      const id = backlinks[1];
      if (state.hold.has(id)) return new Promise<Response>((resolve) => state.held.set(id, resolve));
      if (state.denied.has(id)) return Response.json({ error: 'not-found' }, { status: 404 });
      return Response.json({ backlinks: state.linking[id] ?? [] });
    }
    return Response.json({ error: 'not-found' }, { status: 404 });
  });
  const reads = (id: string) => calls.filter((call) => call.path === `/api/docs/${id}/backlinks`).length;
  return { calls, state, fetch, reads };
}

function open(server: ReturnType<typeof fakeServer>, leaving?: Parameters<typeof createBridge>[0]['leaving']) {
  let receive!: Receive;
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, leaving, subscribeWorkspace: (cb) => { receive = cb; return () => undefined; } });
  const changed = vi.fn();
  onTestFinished(bridge.notes.onDiskChange(changed));
  const listings = () => server.calls.filter((call) => call.path === '/api/workspace').length;
  const event = async (docIds: string[]) => {
    const before = listings();
    receive({ type: 'meta', docIds, folderIds: [] });
    await vi.waitFor(() => expect(listings()).toBe(before + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  return { bridge, changed, event };
}

it('carries backlinks for a note opened by its URL outside the listing, refreshes them on a workspace event and drops them once revoked', async () => {
  const server = fakeServer();
  const { bridge, event } = open(server);
  await bridge.notes.getAll();
  expect((await bridge.notes.getById('x'))?.title).toBe('Shared with me');
  await vi.waitFor(async () => expect((await bridge.notes.getById('x'))?.incomingLinks?.map((link) => link.noteId)).toEqual(['d2']));

  server.state.linking.x = [doc('d1', 'One'), doc('d2', 'Two')];
  await event(['d1']);
  await vi.waitFor(async () => expect((await bridge.notes.getById('x'))?.incomingLinks?.map((link) => link.noteId)).toEqual(['d1', 'd2']));

  server.state.denied.add('x');
  const before = server.reads('x');
  await event(['d2']);
  await vi.waitFor(() => expect(server.reads('x'), 'the revoked read').toBe(before + 1));
  await event(['d1']);
  await bridge.system.setFocusedNoteId('x').catch(() => undefined);
  expect(server.reads('x'), 'denied: no longer watched').toBe(before + 1);
  expect((await bridge.notes.getById('x'))?.incomingLinks, 'and its backlinks are dropped').toBeUndefined();
});

it('sends no held backlinks read once the note’s session ended as deleted, from a stay or a workspace event', async () => {
  const server = fakeServer();
  server.state.hold.add('d1');
  const leaving = new AbortController();
  let stay = () => undefined as void;
  let leave = { signal: leaving.signal, stayed: new Promise<void>((resolve) => { stay = resolve; }) };
  const { bridge, event } = open(server, () => leave);
  await bridge.notes.getAll();
  await bridge.notes.getById('d1');
  await vi.waitFor(() => expect(server.reads('d1')).toBe(1));
  // The page leaves: the read is held, to be sent again if the page stays.
  leaving.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  setTerminal('d1', 'deleted');
  onTestFinished(() => clearTerminal('d1'));
  leave = { signal: new AbortController().signal, stayed: new Promise<void>(() => undefined) };
  stay();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await event(['d2']);
  expect(server.reads('d1'), 'the trashed note is read no more').toBe(1);
});

it('ignores a backlinks read in flight when the note’s session ends as revoked, and aborts it', async () => {
  const server = fakeServer();
  server.state.hold.add('d1');
  const { bridge, changed } = open(server);
  await bridge.notes.getAll();
  await bridge.notes.getById('d1');
  await vi.waitFor(() => expect(server.state.held.has('d1')).toBe(true));
  setTerminal('d1', 'revoked');
  onTestFinished(() => clearTerminal('d1'));
  const inFlight = server.calls.find((call) => call.path === '/api/docs/d1/backlinks');
  expect(inFlight?.signal?.aborted, 'the read is aborted').toBe(true);
  server.state.held.get('d1')!(Response.json({ backlinks: [doc('d2', 'Two')] }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(changed, 'its answer is ignored').not.toHaveBeenCalledWith(['d1'], []);
  expect((await bridge.notes.getById('d1'))?.incomingLinks).toBeUndefined();
  expect(server.reads('d1')).toBe(1);
});

it('reads an opened note’s backlinks once when it is focused before the read answers, and again after a failed read', async () => {
  const server = fakeServer();
  server.state.hold.add('d1');
  const { bridge } = open(server);
  await bridge.notes.getAll();
  await bridge.notes.getById('d1');
  await bridge.system.setFocusedNoteId('d1').catch(() => undefined);
  await vi.waitFor(() => expect(server.state.held.has('d1')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.reads('d1'), 'open then focus: one read').toBe(1);
  const first = server.calls.find((call) => call.path === '/api/docs/d1/backlinks');
  expect(first?.signal?.aborted, 'and it is not aborted').toBe(false);

  // The read fails (an answer that is not JSON): the next focus reads again.
  server.state.hold.delete('d1');
  server.state.held.get('d1')!(new Response('not json', { status: 200 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.system.setFocusedNoteId('d1').catch(() => undefined);
  // Counted before any getById, which could start a read of its own.
  await vi.waitFor(() => expect(server.reads('d1'), 'the failed read is read again on focus').toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect((await bridge.notes.getById('d1'))?.incomingLinks?.map((link) => link.noteId)).toEqual(['d2']);
  expect(server.reads('d1')).toBe(2);
});

it('lets a workspace event replace an opened note’s backlinks read in flight', async () => {
  const server = fakeServer();
  server.state.hold.add('d1');
  const { bridge, event } = open(server);
  await bridge.notes.getAll();
  await bridge.notes.getById('d1');
  await vi.waitFor(() => expect(server.state.held.has('d1')).toBe(true));
  const first = server.calls.find((call) => call.path === '/api/docs/d1/backlinks');
  await event(['d2']);
  await vi.waitFor(() => expect(server.reads('d1')).toBe(2));
  expect(first?.signal?.aborted, 'the links may have changed: the event replaces the read').toBe(true);
});

it('leaves a backlinks read sent after the channel opened to cover its reconcile, and rereads one sent before', async () => {
  const server = fakeServer();
  server.state.hold.add('d1');
  let receive!: Receive;
  // The reconcile's listing answers when the test says.
  let release = () => undefined as void;
  const listed = new Promise<void>((resolve) => { release = resolve; });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const reply = server.fetch(input, init);
    const listings = server.calls.filter((call) => call.path === '/api/workspace').length;
    if (new URL(String(input), 'http://localhost').pathname === '/api/workspace' && listings === 2) await listed;
    return reply;
  };
  const bridge = createBridge({ pathname: () => '/', fetch, subscribeWorkspace: (cb) => { receive = cb; return () => undefined; } });
  const changed = vi.fn();
  onTestFinished(bridge.notes.onDiskChange(changed));
  const listings = () => server.calls.filter((call) => call.path === '/api/workspace').length;
  await bridge.notes.getAll();
  // A first load: the channel opens (its reconcile), then the note opens before the reconcile's listing answers.
  receive({ type: 'vaults' });
  await vi.waitFor(() => expect(listings()).toBe(2));
  await bridge.notes.getById('d1');
  await vi.waitFor(() => expect(server.state.held.has('d1')).toBe(true));
  release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith([], []));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.reads('d1'), 'the open’s read covers the reconcile').toBe(1);
  const first = server.calls.find((call) => call.path === '/api/docs/d1/backlinks');
  expect(first?.signal?.aborted, 'and it is not aborted').toBe(false);

  // A reconcile after the read was sent may carry a change the read missed: it replaces the read.
  receive({ type: 'vaults' });
  await vi.waitFor(() => expect(server.reads('d1')).toBe(2));
  expect(first?.signal?.aborted).toBe(true);
});

it('leaves a note opened while the channel’s socket opens to its reconcile, and reads it at once when the socket fails', async () => {
  const server = fakeServer();
  let receive!: Receive;
  let connecting: (value: boolean) => void = () => undefined;
  const subscribeWorkspace = (cb: Receive, _pause: () => void, onConnecting?: (value: boolean) => void) => {
    receive = cb;
    if (onConnecting) connecting = onConnecting;
    return () => undefined;
  };
  const bridge = createBridge({ pathname: () => '/', fetch: server.fetch, subscribeWorkspace });
  onTestFinished(bridge.notes.onDiskChange(vi.fn()));
  await bridge.notes.getAll();
  connecting(true);
  await bridge.notes.getById('d1');
  await bridge.system.setFocusedNoteId('d1').catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.reads('d1'), 'the socket is opening: its reconcile will read the note').toBe(0);
  // The socket opens: the channel asks its reconcile, then the opening ends.
  receive({ type: 'vaults' });
  connecting(false);
  await vi.waitFor(() => expect(server.reads('d1')).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.reads('d1'), 'one read for the open and the reconcile').toBe(1);

  // A reconnect that fails: the note opened meanwhile is read when the opening ends.
  connecting(true);
  await bridge.notes.getById('d2');
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(server.reads('d2')).toBe(0);
  connecting(false);
  await vi.waitFor(() => expect(server.reads('d2'), 'read once the socket failed').toBe(1));
});

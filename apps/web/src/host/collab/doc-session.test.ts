// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
  // y-partyserver sends an update only while `ws.readyState === ws.OPEN`.
  readonly OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  closes: number[] = [];
  constructor(readonly url: string) { super(); sockets.push(this); }
  send(frame: unknown) { this.sent.push(frame); }
  close(code = 1000) { this.closes.push(code); this.readyState = 2; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  ended(code: number) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
}
vi.stubGlobal('WebSocket', FakeSocket);
const { DocSession, severDocSessions } = await import('./doc-session.ts');
const { terminalOf, clearTerminal } = await import('./terminal.ts');
const { hasUnacked } = await import('./unacked.ts');
let session: InstanceType<typeof DocSession>;
const latest = () => sockets[sockets.length - 1];
beforeEach(async () => {
  vi.useFakeTimers();
  sockets.length = 0;
  clearTerminal('doc');
  session = new DocSession('doc');
  await session.provider.connect();
});
afterEach(() => { session.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
it('detaches a half-open socket without its close event and ignores its late close', async () => {
  const old = latest(); old.open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'kept');
  await vi.advanceTimersByTimeAsync(13_500);
  expect(old.closes).toContain(4408);
  expect(sockets).toHaveLength(2);
  expect(session.state.connection).toBe('offline');
  const fresh = latest(); fresh.open(); session.provider.synced = true;
  old.ended(1006);
  expect(session.provider.ws).toBe(fresh);
  expect(session.state.connection).toBe('online');
  expect(session.doc.getText('title').toString()).toBe('kept');
  expect(hasUnacked()).toBe(true);
});
it.each([[4402, 'session-ended'], [4404, 'unavailable'], [4410, 'deleted'], [4429, 'conn-limit']] as const)(
  'stops reconnecting synchronously on %s', async (code, reason) => {
    latest().open(); latest().ended(code);
    expect(terminalOf('doc')).toBe(reason);
    expect(session.provider.shouldConnect).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(1);
  },
);
it('a rate close keeps the doc and reconnects', async () => {
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'pending');
  latest().ended(4420);
  await vi.advanceTimersByTimeAsync(300);
  expect(sockets).toHaveLength(2);
  expect(session.doc.getText('title').toString()).toBe('pending');
  expect(session.state.unacked).toBe(true);
});
it('three failed handshakes stop the ladder and ask REST before retrying', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  for (let i = 0; i < 3; i++) { latest().ended(1006); await vi.advanceTimersByTimeAsync(1000); }
  expect(request).toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBe('unavailable');
  expect(session.provider.shouldConnect).toBe(false);
});
it('a demotion requests a fresh read-only binding', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'viewer' }));
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'refused');
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(300);
  expect(session.state).toMatchObject({ canWrite: false, resync: true });
  expect(sockets).toHaveLength(1);
});
it('a refused write requests a fresh binding without retrying the rejected state', async () => {
  latest().open(); session.provider.synced = true;
  latest().ended(4409);
  await vi.advanceTimersByTimeAsync(1000);
  expect(session.state.resync).toBe(true);
  expect(session.provider.shouldConnect).toBe(false);
});
it('the first-sync deadline leaves the doc closed and sign-out stops every socket', async () => {
  latest().open();
  await vi.advanceTimersByTimeAsync(8000);
  expect(session.state).toMatchObject({ synced: false, retrying: true });
  severDocSessions();
  expect(terminalOf('doc')).toBe('session-ended');
  expect(session.provider.shouldConnect).toBe(false);
});

it('a connect requested after a terminal close cannot reopen it', async () => {
  latest().open(); latest().ended(4410);
  await session.provider.connect();
  expect(session.provider.shouldConnect).toBe(false);
  expect(sockets).toHaveLength(1);
});

it('a connection limit preserves a lingering unacked document for Retry', async () => {
  latest().open(); session.provider.synced = true;
  session.doc.getText('title').insert(0, 'pending');
  session.release();
  latest().ended(4429);
  expect(hasUnacked()).toBe(true);
  expect(session.doc.isDestroyed).toBe(false);
  session.retry();
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  expect(session.doc.getText('title').toString()).toBe('pending');
});
it('a repeated 4403 with editor REST access backs off instead of looping immediately', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'editor' }));
  latest().open(); latest().ended(4403);
  await vi.advanceTimersByTimeAsync(999);
  expect(sockets).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(2);
  latest().open(); latest().ended(4403);
  await vi.advanceTimersByTimeAsync(1999);
  expect(sockets).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(sockets).toHaveLength(3);
});

it('re-announces unchanged presence every four seconds without changing the caret', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: { tname: 'root', index: 2 }, focusPos: null, focusing: true };
  session.provider.awareness.setLocalState(state);
  const clock = () => session.provider.awareness.meta.get(session.doc.clientID)?.clock ?? 0;
  const before = clock();
  await vi.advanceTimersByTimeAsync(4_000);
  expect(clock()).toBeGreaterThan(before);
  expect(session.provider.awareness.getLocalState()).toEqual(state);
});

it('a hidden idle tab sends no frames or reconnects and immediately re-announces on return', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: null, focusPos: null, focusing: false };
  session.provider.awareness.setLocalState(state);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  document.dispatchEvent(new Event('visibilitychange'));
  const socket = latest();
  const sent = socket.sent.length;
  const clock = () => session.provider.awareness.meta.get(session.doc.clientID)?.clock ?? 0;
  const before = clock();
  await vi.advanceTimersByTimeAsync(100_000);
  expect(socket.sent).toHaveLength(sent);
  expect(sockets).toHaveLength(1);
  expect(socket.closes).toEqual([]);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(clock()).toBeGreaterThan(before);
  expect(session.provider.awareness.getLocalState()).toEqual(state);
  expect(socket.sent.length).toBeGreaterThan(sent);
});

it('a persisted pageshow restores the presence and caret saved before pagehide', async () => {
  latest().open(); session.provider.synced = true;
  const state = { name: 'Ada', anchorPos: { tname: 'root', index: 2 }, focusPos: null, focusing: true };
  session.provider.awareness.setLocalState(state);
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toBeNull();
  const sent = latest().sent.length;
  await vi.advanceTimersByTimeAsync(100_000);
  expect(latest().sent).toHaveLength(sent);
  expect(sockets).toHaveLength(1);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toEqual(state);
  expect(latest().sent.length).toBeGreaterThan(sent);
});

it('an ended session sends nothing on its closing socket: no reply to a late server frame, no presence, no edit', async () => {
  latest().open(); session.provider.synced = true;
  session.provider.awareness.setLocalState({ name: 'Ada' });
  session.end('deleted');
  const socket = latest();
  expect(socket.readyState).toBe(FakeSocket.CLOSING);
  const sent = socket.sent.length;
  // A server sync step 1 still in flight when the close began: y-partyserver answers it with a step 2.
  const vector = Y.encodeStateVector(new Y.Doc());
  socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([0, 0, vector.length, ...vector]).buffer }));
  session.provider.awareness.setLocalStateField('focusing', false);
  session.doc.getText('title').insert(0, 'late');
  await vi.advanceTimersByTimeAsync(5_000);
  expect(socket.sent).toHaveLength(sent);
});

it.each(['cleared', 'ended', 'released'] as const)('pageshow never revives %s presence', (reason) => {
  latest().open(); session.provider.synced = true;
  session.provider.awareness.setLocalState(reason === 'cleared' ? null : { name: 'Ada' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  if (reason === 'ended') session.end('session-ended');
  if (reason === 'released') { session.doc.getText('title').insert(0, 'pending'); session.release(); }
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toBeNull();
});

/** The Yjs updates a socket sent after its first `from` frames: sync updates (step 2) and step 2 replies (step 1). */
function syncSent(socket: FakeSocket, from = 0): { step: number; update: Uint8Array }[] {
  const out: { step: number; update: Uint8Array }[] = [];
  for (const sent of socket.sent.slice(from)) {
    if (!ArrayBuffer.isView(sent)) continue;
    const frame = new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength);
    if (frame[0] !== 0 || frame[1] === 0) continue;
    let pos = 2;
    let length = 0;
    for (let scale = 1; ; scale *= 128) {
      const byte = frame[pos++];
      length += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
    }
    out.push({ step: frame[1], update: frame.subarray(pos, pos + length) });
  }
  return out;
}
const serverStep1 = (socket: FakeSocket, vector: Uint8Array) =>
  socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([0, 0, vector.length, ...vector]).buffer }));

it('after a reconnect, a write made before the server\'s step 1 waits behind the backlog, also after a cut-off replay', async () => {
  // The DocDO: it refuses a frame whose structs Yjs would park (comments.md §6), so none may arrive ahead of its origin.
  const server = new Y.Doc();
  const deliver = (socket: FakeSocket) => {
    for (const { update } of syncSent(socket)) {
      Y.applyUpdate(server, update);
      expect(server.store.pendingStructs, 'an honest frame never parks').toBeNull();
    }
  };
  const title = session.doc.getText('title');
  const first = latest();
  first.open(); session.provider.synced = true;
  title.insert(0, 'quick brown');
  title.delete(0, 6);
  title.insert(0, 'slow ');
  // Lost in flight: the server never got the first socket's frames.
  first.ended(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  const second = latest();
  expect(second).not.toBe(first);
  second.open();
  // Typed between the socket's open and the server's step 1.
  title.insert(title.length, '!');
  expect(syncSent(second), 'nothing goes ahead of the backlog').toEqual([]);
  serverStep1(second, Y.encodeStateVector(server));
  deliver(second);
  // The replay is cut off after its first frame; the next socket starts over.
  second.ended(1006);
  await vi.advanceTimersByTimeAsync(1_000);
  const third = latest();
  expect(third).not.toBe(second);
  third.open();
  title.insert(0, '>');
  expect(syncSent(third), 'nothing goes ahead of the backlog').toEqual([]);
  serverStep1(third, Y.encodeStateVector(server));
  await vi.advanceTimersByTimeAsync(1_000);
  deliver(third);
  expect(server.getText('title').toString()).toBe(title.toString());
  expect(syncSent(third).at(-1)?.step, 'the step 2 comes after the backlog').toBe(1);
  // Released: a write now goes live.
  const sent = syncSent(third).length;
  title.insert(0, '#');
  expect(syncSent(third)).toHaveLength(sent + 1);
});

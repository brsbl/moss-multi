// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodeSyncFrame } from '@moss-multi/protocol/sync';

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
const sessionModule = await import('./doc-session.ts');
const { DocSession, severDocSessions } = sessionModule;
/** T2.5's recovery hook, looked up so the rest of the file runs while it is missing. */
const reopenDocs = (docIds: string[]) => (sessionModule as { reopenDocs?: (ids: string[]) => void }).reopenDocs?.(docIds);
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
it('keeps the socket while a busy main thread holds the heartbeat back, then detaches once it is idle and still silent', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  // A collaborator's large paste applied here: every 1 s tick runs about 2.5 s late, and no frame is read for 30 s.
  for (let i = 0; i < 12; i += 1) {
    vi.setSystemTime(Date.now() + 1_500);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(socket.closes, 'a busy tab is not a silent socket').not.toContain(4408);
  await vi.advanceTimersByTimeAsync(13_500);
  expect(socket.closes, 'idle and still silent: half-open').toContain(4408);
});
it('sends no step 1 while the last is unanswered and frames still arrive, and keeps the 4 s step 1 once answered or silent', async () => {
  const socket = latest(); socket.open(); session.provider.synced = true;
  const step1s = () => socket.sent.filter((frame) => frame instanceof Uint8Array && frame[0] === 0 && frame[1] === 0).length;
  let n = 0;
  const receive = (step: number) => {
    const peer = new Y.Doc();
    peer.getText('peer').insert(0, `${n++}`);
    socket.dispatchEvent(new MessageEvent('message', { data: encodeSyncFrame(step, Y.encodeStateAsUpdate(peer)).slice().buffer }));
    // lib0 read Date.now before the fake clock replaced it: stamp the frame on the fake clock, as the provider would.
    session.provider.wsLastMessageReceived = Date.now();
  };
  expect(step1s(), 'the step 1 on open').toBe(1);
  // A peer behind a large paste: its pieces arrive about once a second, and the answer is queued behind them.
  for (let i = 0; i < 10; i += 1) {
    receive(2);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(step1s(), 'no second step 1 while its answer is on its way').toBe(1);
  receive(1);
  for (let i = 0; i < 5; i += 1) {
    receive(2);
    await vi.advanceTimersByTimeAsync(1_000);
  }
  expect(step1s(), 'answered: the 4 s step 1 resumes').toBe(2);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(step1s(), 'nothing arriving: the step 1 keeps frames flowing').toBeGreaterThanOrEqual(3);
  expect(socket.closes).toEqual([]);
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
it('a reconnect sends the note\'s unacked writes before any payload frame, so blocks made offline are named first', async () => {
  const first = latest(); first.open(); session.provider.synced = true;
  first.ended(1006);
  // Offline: a note write (a new block's element) and its payload's first text.
  session.doc.getText('title').insert(0, 'offline');
  session.payloads.hold('minted', true).getText('payload').insert(0, 'code');
  await vi.advanceTimersByTimeAsync(300);
  const socket = latest();
  expect(socket).not.toBe(first);
  socket.open();
  // The server speaks first (comments.md §6): the backlog is replayed on its step 1, then the payloads resend.
  serverStep1(socket, Y.encodeStateVector(new Y.Doc()));
  await vi.advanceTimersByTimeAsync(1_000);
  const kinds = socket.sent.map((frame) => {
    const bytes = frame as Uint8Array;
    return bytes[0] === 7 ? 'payload' : bytes[0] === 0 && bytes[1] !== 0 ? 'note write' : 'other';
  });
  const payload = kinds.indexOf('payload');
  expect(payload, 'the payload is resent').toBeGreaterThan(-1);
  expect(kinds.slice(0, payload), 'the note write goes first').toContain('note write');
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
it('a demotion alone keeps the view-only notice; a removal right after it leaves only the ended notice (T3.S20)', async () => {
  const { refusalMessage } = await import('../refusal.ts');
  const VIEW_ONLY = 'You can view this note but can no longer edit it.';
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'viewer' }));
  latest().open(); session.provider.synced = true;
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(refusalMessage(), 'the demotion says the note is view-only').toBe(VIEW_ONLY);
  // The pane rebinds read-only, then the owner removes him within the notice's 4 s.
  session.dispose();
  session = new DocSession('doc', false);
  await session.provider.connect();
  access.mockResolvedValue(new Response('{}', { status: 404 }));
  latest().open(); session.provider.synced = true;
  latest().ended(4403);
  await vi.advanceTimersByTimeAsync(300);
  expect(terminalOf('doc')).toBe('revoked');
  expect(refusalMessage(), 'the ended note no longer says it can be viewed').not.toBe(VIEW_ONLY);
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

it('a doc left terminal deleted by a trash that never committed reopens editable when its workspace says it changed', async () => {
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ role: 'editor' }));
  latest().open(); session.provider.synced = true;
  latest().ended(4410);
  expect(terminalOf('doc')).toBe('deleted');
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(300);
  expect(access, 'it asks REST whether the note is live').toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBeNull();
  expect(session.provider.shouldConnect).toBe(true);
  expect(sockets).toHaveLength(2);
  latest().open();
  session.doc.getText('title').insert(0, 'typed after');
  expect(session.state).toMatchObject({ canWrite: true, unacked: true });
});

it('a doc REST still has in Trash stays terminal, and a live session is left alone', async () => {
  const access = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ deleted: true }));
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(300);
  expect(access, 'a live session asks nothing').not.toHaveBeenCalled();
  latest().open(); latest().ended(4410);
  reopenDocs(['doc']);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(access).toHaveBeenCalledTimes(1);
  expect(terminalOf('doc')).toBe('deleted');
  expect(sockets).toHaveLength(1);
});

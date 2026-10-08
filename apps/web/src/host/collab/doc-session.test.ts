// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const sockets: FakeSocket[] = [];
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;
  static CLOSING = 2;
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

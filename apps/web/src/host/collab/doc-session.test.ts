// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

it('pagehide suspends automatic traffic and never resurrects cleared presence', async () => {
  latest().open(); session.provider.synced = true;
  session.provider.awareness.setLocalState({ name: 'Ada' });
  window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  const sent = latest().sent.length;
  await vi.advanceTimersByTimeAsync(100_000);
  expect(latest().sent).toHaveLength(sent);
  expect(sockets).toHaveLength(1);
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  expect(session.provider.awareness.getLocalState()).toBeNull();
});

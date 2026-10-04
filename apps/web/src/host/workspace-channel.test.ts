import { afterEach, expect, it, vi } from 'vitest';
import { createAuthStore } from './auth-state.ts';
import { subscribeWorkspace } from './workspace-channel.ts';

class Socket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  close = vi.fn();
  send = vi.fn();
}
afterEach(() => vi.useRealTimers());

it('stops synchronously before sign-out awaits confirmation or HTTP, ignores queued events and resumes a cancelled gesture', async () => {
  vi.useFakeTimers();
  let answer: (ok: boolean) => void = () => undefined;
  const confirm = new Promise<boolean>((resolve) => { answer = resolve; });
  const auth = createAuthStore({
    lookup: async () => ({ kind: 'signed-in', user: { id: 'ada', name: 'Ada', email: 'ada@example.invalid' } }),
    beforeSignOut: () => confirm, fetch: vi.fn(), leave: vi.fn(), setAppState: vi.fn(),
  });
  await auth.resolve();
  const sockets: Socket[] = [];
  const receive = vi.fn();
  const off = subscribeWorkspace({ auth, socket: () => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; },
    visible: () => true, onVisible: () => () => undefined }, receive);
  sockets[0].onopen?.();
  const queued = sockets[0].onmessage!;
  receive.mockClear();
  const signingOut = auth.signOut();
  expect(sockets[0].close).toHaveBeenCalledOnce();
  queued({ data: JSON.stringify({ type: 'meta', docIds: ['bound'], folderIds: [] }) });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(receive).not.toHaveBeenCalled();
  expect(sockets).toHaveLength(1);
  expect(sockets[0].send).not.toHaveBeenCalled();
  answer(false);
  await signingOut;
  expect(sockets).toHaveLength(2);
  sockets[1].onopen?.();
  expect(receive).toHaveBeenCalledWith({ type: 'vaults' });
  off();
});

it('pings only while visible and refreshes missed metadata on reconnect; terminal closes never retry', async () => {
  vi.useFakeTimers();
  const auth = createAuthStore({ lookup: async () => ({ kind: 'signed-in', user: { id: 'ada', name: 'Ada', email: 'ada@example.invalid' } }),
    fetch: vi.fn(), leave: vi.fn(), setAppState: vi.fn() });
  await auth.resolve();
  let visible = true;
  const sockets: Socket[] = [];
  const receive = vi.fn();
  const off = subscribeWorkspace({ auth, socket: () => { const s = new Socket(); sockets.push(s); return s as unknown as WebSocket; },
    visible: () => visible, onVisible: () => () => undefined }, receive);
  sockets[0].onopen?.();
  await vi.advanceTimersByTimeAsync(25_000);
  expect(sockets[0].send).toHaveBeenCalledWith('ping');
  sockets[0].onmessage?.({ data: 'pong' });
  visible = false;
  await vi.advanceTimersByTimeAsync(25_000);
  expect(sockets[0].send).toHaveBeenCalledTimes(1);
  sockets[0].onclose?.({ code: 1006 });
  await vi.advanceTimersByTimeAsync(1000);
  sockets[1].onopen?.();
  expect(receive).toHaveBeenCalledTimes(2);
  sockets[1].onclose?.({ code: 4402 });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sockets).toHaveLength(2);
  off();
});

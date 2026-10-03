import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import { connect, openDoc, start, wake } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const state = (name = 'Ada') => ({ name, color: '#abcdef', user: { principalId: 'ada', name, isAgent: false, color: '#abcdef', colorSettled: true } });
function frame(id: number, value: unknown, clock = 1) {
  const body = encoding.createEncoder();
  encoding.writeVarUint(body, 1); encoding.writeVarUint(body, id); encoding.writeVarUint(body, clock);
  encoding.writeVarString(body, JSON.stringify(value));
  const out = encoding.createEncoder(); encoding.writeVarUint(out, 1);
  encoding.writeVarUint8Array(out, encoding.toUint8Array(body)); return encoding.toUint8Array(out);
}
it('drops spoofed identity, top-level aliases, other-client updates and oversized awareness', async () => {
  const opened = await start(openDoc());
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  const ben = await connect(opened, { id: 'ben', name: 'Ben' });
  await ada.deliver(frame(42, state()));
  expect(opened.dobj.document.awareness.getStates().get(42)?.user.name).toBe('Ada');
  await ada.deliver(frame(42, state('Owner'), 2));
  await ada.deliver(frame(42, { ...state(), user: { ...state().user, principalId: 'ben' } }, 2));
  await ada.deliver(frame(42, { ...state(), user: { ...state().user, isAgent: true } }, 2));
  await ada.deliver(frame(42, { ...state(), name: 'Owner' }, 3));
  await ben.deliver(frame(42, null, 4));
  await ada.deliver(frame(43, state(), 5));
  await ada.deliver(frame(42, { ...state(), junk: 'x'.repeat(100_000) }, 6));
  expect(opened.dobj.document.awareness.getStates().get(42)?.name).toBe('Ada');
  expect(opened.dobj.document.awareness.getStates().has(43)).toBe(false);
  const woken = await start(wake(opened));
  ben.opened = woken;
  await ben.deliver(frame(42, null, 7));
  ada.opened = woken;
  await ada.deliver(frame(42, state(), 8));
  expect(woken.dobj.document.awareness.getStates().get(42)?.name).toBe('Ada');
});
it('link-only recipients receive no identities in initial snapshots or live frames', async () => {
  const opened = await start(openDoc());
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  await ada.deliver(frame(42, state()));
  const anonymous = await connect(opened, { id: 'link', kind: 'anonymous', share: 'token' });
  const signedIn = await connect(opened, { id: 'stranger', share: 'token' });
  await ada.deliver(frame(42, state(), 2));
  for (const client of [anonymous, signedIn]) {
    expect(client.socket.sent.filter(f => typeof f !== 'string' && f[0] === 1)).toHaveLength(0);
  }
  await ada.drop();
  expect(opened.dobj.document.awareness.getStates().has(42)).toBe(false);
});

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { connect, openDoc, start, wake } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
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
  const member = await connect(opened, { id: 'ben', name: 'Ben' });
  await ada.deliver(frame(42, state(), 2));
  for (const client of [anonymous, signedIn]) {
    expect(client.socket.sent.filter(f => typeof f !== 'string' && f[0] === 1)).toHaveLength(0);
  }
  await ada.drop();
  expect(opened.dobj.document.awareness.getStates().has(42)).toBe(false);
  for (const client of [anonymous, signedIn]) {
    expect(client.socket.sent.filter(f => typeof f !== 'string' && f[0] === 1)).toHaveLength(0);
  }
  const departure = member.socket.sent.filter(f => typeof f !== 'string' && f[0] === 1).at(-1) as Uint8Array;
  const outer = decoding.createDecoder(departure);
  expect(decoding.readVarUint(outer)).toBe(1);
  const payload = decoding.createDecoder(decoding.readVarUint8Array(outer));
  expect(decoding.readVarUint(payload)).toBe(1);
  expect(decoding.readVarUint(payload)).toBe(42);
  decoding.readVarUint(payload);
  expect(JSON.parse(decoding.readVarString(payload))).toBeNull();
});

it.each([false, true])('a replacement socket takes over half-open presence, including across wake=%s', async (hibernate) => {
  let opened = await start(openDoc());
  const first = await connect(opened, { id: 'ada', name: 'Ada' }, undefined, 'old-provider');
  const peer = await connect(opened, { id: 'ben', name: 'Ben' });
  await first.deliver(frame(42, { ...state(), tag: 'first' }));
  if (hibernate) opened = await start(wake(opened));
  first.opened = opened;
  // No close event reaches the server; the provider keeps its Y.Doc clientID on reconnect.
  const replacement = await connect(opened, { id: 'ada', name: 'Ada' }, undefined, hibernate ? 'old-provider' : 'new-provider');
  await replacement.deliver(frame(42, { ...state(), tag: 'reconnected' }, 2));
  expect(first.socket.readyState).toBe(1);
  expect(opened.dobj.document.awareness.getStates().get(42)?.tag).toBe('reconnected');
  if (hibernate) {
    opened = await start(wake(opened));
    first.opened = replacement.opened = opened;
    await replacement.deliver(frame(42, { ...state(), tag: 'reconnected' }, 3));
  }
  const delivered = peer.socket.sent.length;
  await first.deliver(frame(42, { ...state(), tag: 'late-old-frame' }, 3));
  await first.deliver(frame(42, null, 4));
  await first.drop();
  expect(peer.socket.sent).toHaveLength(delivered);
  expect(opened.dobj.document.awareness.getStates().get(42)?.tag).toBe('reconnected');
  await replacement.deliver(frame(42, { ...state(), tag: 'still-here' }, 5));
  expect(opened.dobj.document.awareness.getStates().get(42)?.tag).toBe('still-here');
  await replacement.drop();
  expect(opened.dobj.document.awareness.getStates().has(42)).toBe(false);
});

it("a second window relaying the first window's state keeps both presences", async () => {
  const opened = await start(openDoc());
  const first = await connect(opened, { id: 'ada', name: 'Ada' }, undefined, 'first-window');
  const second = await connect(opened, { id: 'ada', name: 'Ada' }, undefined, 'second-window');
  const peer = await connect(opened, { id: 'ben', name: 'Ben' });
  await first.deliver(frame(42, { ...state(), tag: 'first' }, 3));
  // y-partyserver rebroadcasts remote changes: the second window echoes the first's state at its clock.
  await second.deliver(frame(42, { ...state(), tag: 'first' }, 3));
  await second.deliver(frame(43, { ...state(), tag: 'second' }));
  const states = opened.dobj.document.awareness.getStates();
  expect(states.get(43)?.tag).toBe('second');
  await first.deliver(frame(42, { ...state(), tag: 'first-moved' }, 4));
  expect(states.get(42)?.tag).toBe('first-moved');
  expect(peer.socket.readyState).toBe(1);
});

it('a different principal cannot take over an occupied presence id with its own valid identity', async () => {
  const opened = await start(openDoc());
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  const ben = await connect(opened, { id: 'ben', name: 'Ben' });
  await ada.deliver(frame(42, state()));
  await ben.deliver(frame(42, { ...state('Ben'), user: { ...state('Ben').user, principalId: 'ben' } }, 2));
  expect(opened.dobj.document.awareness.getStates().get(42)?.name).toBe('Ada');
});

it('closing just after wake does not encode missing awareness metadata', async () => {
  const opened = await start(openDoc());
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  await ada.deliver(frame(42, state()));
  ada.opened = await start(wake(opened));
  expect(ada.opened.dobj.document.awareness.meta.has(42)).toBe(false);
  // partyserver catches onClose errors, so assert its callback directly rather than its swallowing wrapper.
  expect(() => ada.opened.dobj.onClose(ada.socket as never)).not.toThrow();
});

it('SP6 validates 1000 repeated awareness frames within a bounded CPU budget', async () => {
  const opened = await start(openDoc());
  const ada = await connect(opened, { id: 'ada', name: 'Ada' });
  const began = process.hrtime.bigint();
  for (let clock = 1; clock <= 1000; clock++) await ada.deliver(frame(42, state(), clock));
  const elapsedMs = Number(process.hrtime.bigint() - began) / 1e6;
  console.info(`SP6: ${elapsedMs.toFixed(2)} ms / 1000 awareness frames (Node harness, includes socket dispatch)`);
  expect(elapsedMs).toBeLessThan(5000);
  expect(opened.dobj.document.awareness.getStates().get(42)?.name).toBe('Ada');
});

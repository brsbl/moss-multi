// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import YProvider from 'y-partyserver/provider';
import { applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { startPresence } from './presence.ts';
import { colorOf } from './presence-colors.ts';

afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); });

it('a slow first sync cannot settle a newcomer before it sees the incumbent roster', async () => {
  vi.useFakeTimers();
  const make = (id: number, name: string) => {
    const doc = new Y.Doc(); doc.clientID = id;
    const provider = new YProvider('localhost', 'colors', doc, { connect: false, disableBc: true });
    provider.awareness.setLocalState({ name, color: colorOf(0), user: { principalId: name, name, slot: 0, color: colorOf(0), colorSettled: false, isAgent: false } });
    return { doc, provider, stop: startPresence(`colors-${id}`, provider) };
  };
  const incumbent = make(20, 'Ada');
  const newcomer = make(10, 'Ben');
  try {
    incumbent.provider.synced = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(incumbent.provider.awareness.getLocalState()?.user.colorSettled).toBe(true);
    expect(newcomer.provider.awareness.getLocalState()?.user.colorSettled).toBe(false);
    const exchange = (from: typeof incumbent, to: typeof incumbent) => applyAwarenessUpdate(to.provider.awareness, encodeAwarenessUpdate(from.provider.awareness, [from.doc.clientID]), to.provider);
    exchange(incumbent, newcomer);
    newcomer.provider.synced = true;
    exchange(newcomer, incumbent);
    await vi.advanceTimersByTimeAsync(500);
    expect(incumbent.provider.awareness.getLocalState()?.user.slot).toBe(0);
    expect(newcomer.provider.awareness.getLocalState()?.user.slot).not.toBe(0);
    expect(newcomer.provider.awareness.getLocalState()?.user.colorSettled).toBe(true);
  } finally {
    for (const peer of [incumbent, newcomer]) { peer.stop(); peer.provider.destroy(); peer.doc.destroy(); }
  }
});

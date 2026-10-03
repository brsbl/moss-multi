import { expect, it } from 'vitest';
import fc from 'fast-check';
import { claimColor, type Claim } from './presence-colors.ts';

it('claims distinct colors and never recolors incumbents through joins and leaves', () => {
  fc.assert(fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 10 }), fc.integer({ min: 0, max: 9 }), (ids, seed) => {
    const peers: Claim[] = [];
    for (const id of ids) {
      const next = { id, slot: seed, settled: false };
      next.slot = claimColor(next, peers);
      next.settled = true;
      peers.push(next);
      expect(new Set(peers.map(p => p.slot)).size).toBe(peers.length);
      for (const peer of peers) expect(claimColor(peer, peers)).toBe(peer.slot);
    }
    peers.splice(0, 1);
    for (const peer of peers) expect(claimColor(peer, peers)).toBe(peer.slot);
  }));
});
it('settled claims beat provisional ones; ties use UTF-16 order', () => {
  expect(claimColor({ id: 'a', slot: 0, settled: false }, [{ id: 'z', slot: 0, settled: true }])).not.toBe(0);
  expect(claimColor({ id: 'z', slot: 0, settled: false }, [{ id: 'a', slot: 0, settled: false }])).not.toBe(0);
});

import { PALETTE } from '@moss-multi/protocol/presence';

export { colorOf, PALETTE, seedColor } from '@moss-multi/protocol/presence';
export interface Claim { id: string; slot: number; settled: boolean }
export function claimColor(self: Claim, peers: Claim[]): number {
  const others = peers.filter(peer => peer.id !== self.id);
  const stronger = others.some(peer => peer.slot === self.slot && (peer.settled !== self.settled ? peer.settled : peer.id < self.id));
  if (!stronger) return self.slot;
  const used = new Set(others.map(peer => peer.slot));
  for (let step = 1; step < PALETTE.length; step++) {
    const slot = (self.slot + step) % PALETTE.length;
    if (!used.has(slot)) return slot;
  }
  return self.slot;
}

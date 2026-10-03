export interface Claim { id: string; slot: number; settled: boolean }
export const PALETTE = ['chart-blue', 'chart-terra', 'chart-sage', 'chart-lavender', 'chart-wheat', 'sketch-plum', 'sketch-teal', 'sketch-coral', 'sketch-rose', 'sketch-charcoal'];
export const colorOf = (slot: number): string => `var(--${PALETTE[slot % PALETTE.length]})`;
export function seedColor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % PALETTE.length;
}
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

export interface Claim { id: string; slot: number; settled: boolean }
export function claimColor(self: Claim, _peers: Claim[]): number { return self.slot; }

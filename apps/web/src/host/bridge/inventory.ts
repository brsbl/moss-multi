// The bridge inventory (A§9): every ElectronAPI method and how the web treats it. T0.5b tests first: empty.

export type Treatment = 'real' | 'stub' | 'hidden' | 'staged' | 'absent';

export interface Routing {
  treatment: Treatment;
  milestone?: number;
  note: string;
}

export interface InventoryEntry extends Routing {
  affordance?: string;
  fields?: Record<string, Routing>;
}

export const INVENTORY: Record<string, InventoryEntry> = {};

export function unlistedMethods(_methods: readonly string[], _inventory: Record<string, InventoryEntry> = INVENTORY): string[] {
  return [];
}

export function expiredStaged(_inventory: Record<string, InventoryEntry>, _closedThrough: number | null): string[] {
  return [];
}

export function closedMilestone(_value: string | undefined): number | null {
  return null;
}

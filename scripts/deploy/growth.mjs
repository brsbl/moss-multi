#!/usr/bin/env node
// Staging growth cap (A§21, T8.2): not implemented yet.
export const GROWTH_CAP = { docs: 0, users: 0, d1Bytes: 0 };
export const PER_FULL_RUN = { docs: 0, users: 0, d1Bytes: 0 };

export function readGrowth() {
  throw new Error('not implemented');
}

export function growthProblems() {
  return [];
}

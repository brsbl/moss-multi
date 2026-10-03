// The doc-level terminal store (A§10.6): one reason per doc id, which every editable surface of that doc subscribes
// to and goes inert on, in place. Close-code dispatch in the doc session writes it; a retry (conn-limit) clears it.
import type { TerminalReason } from '@moss-multi/protocol/dom-contract';
import { useSyncExternalStore } from 'react';

const reasons = new Map<string, TerminalReason>();
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of [...listeners]) listener();
}

export function setTerminal(docId: string, reason: TerminalReason): void {
  if (reasons.get(docId) === reason) return;
  reasons.set(docId, reason);
  changed();
}

export function clearTerminal(docId: string): void {
  if (reasons.delete(docId)) changed();
}

export function terminalOf(docId: string): TerminalReason | null {
  return reasons.get(docId) ?? null;
}

/** Calls `listener` on every change to any doc's reason; returns the unsubscriber. */
export function subscribeTerminal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminal(docId: string | null): TerminalReason | null {
  return useSyncExternalStore(subscribeTerminal, () => (docId ? terminalOf(docId) : null), () => null);
}

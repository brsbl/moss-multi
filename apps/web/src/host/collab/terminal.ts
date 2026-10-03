// The doc-level terminal store (A§10.6): one reason per doc id, which every editable surface of that doc subscribes
// to and goes inert on. Close-code dispatch writes it (T1.3).
import type { TerminalReason } from '@moss-multi/protocol/dom-contract';
import { useSyncExternalStore } from 'react';

const reasons = new Map<string, TerminalReason>();
const listeners = new Set<() => void>();

export function setTerminal(docId: string, reason: TerminalReason): void {
  if (reasons.get(docId) === reason) return;
  reasons.set(docId, reason);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminal(docId: string | null): TerminalReason | null {
  return useSyncExternalStore(subscribe, () => (docId ? (reasons.get(docId) ?? null) : null));
}

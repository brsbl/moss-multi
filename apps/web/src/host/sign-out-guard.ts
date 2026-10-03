// The auth writer pauses doc input before this wait. Cancel preserves every live and lingering session.
import { hasUnacked, waitForAllAcked } from './collab/unacked.ts';

let confirm: ((discard: boolean) => void) | null = null;
const listeners = new Set<() => void>();
export const needsSignOutConfirmation = () => confirm !== null;
export function subscribeSignOutConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const publish = () => { for (const listener of listeners) listener(); };
export function answerSignOut(discard: boolean): void {
  const answer = confirm;
  confirm = null;
  publish();
  answer?.(discard);
}
export async function prepareSignOut(): Promise<boolean> {
  if (!hasUnacked() || await waitForAllAcked(5_000)) return true;
  return new Promise<boolean>((resolve) => { confirm = resolve; publish(); });
}

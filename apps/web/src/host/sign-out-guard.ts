// The auth writer pauses doc input before this wait. Cancel preserves every live and lingering session.
import { releaseKept, unsavedHere, waitForAllAcked } from './collab/unacked.ts';

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
  // Discard covers the text kept now: the sign-out's leave does not ask about it again, but does about any later.
  releaseKept(discard);
  publish();
  answer?.(discard);
}
export async function prepareSignOut(): Promise<boolean> {
  releaseKept(false);
  if (unsavedHere() === 'unacked') await waitForAllAcked(5_000);
  // Decided after the wait: a suggestion refused during it offers its text back.
  if (unsavedHere() === null) return true;
  return new Promise<boolean>((resolve) => { confirm = resolve; publish(); });
}

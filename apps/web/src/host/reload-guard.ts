// The outdated banner's Reload (A§10.6): an outdated session can never sync, so while the tab holds unacked edits the
// shell asks before the reload discards them, and Cancel leaves the window and its edits as they are.
import { hasUnacked } from './collab/unacked.ts';
import { reloadDocument } from './navigation.ts';

let asking = false;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

export const needsReloadConfirmation = (): boolean => asking;
export function subscribeReloadConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reloads now, or asks first while any edit in the tab is unacked. */
export function reloadUnlessUnacked(): void {
  if (!hasUnacked()) {
    reloadDocument();
    return;
  }
  asking = true;
  publish();
}

export function answerReload(discard: boolean): void {
  asking = false;
  publish();
  if (discard) reloadDocument();
}

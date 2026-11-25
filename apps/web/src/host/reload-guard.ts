// The outdated banner's Reload (A§10.6): an outdated session can never sync, so while the tab holds unacked edits or
// offered-back text the shell asks before the reload discards them, and Cancel leaves the window and its edits as they are.
import { releaseKept, unsavedHere } from './collab/unacked.ts';
import { reloadDocument } from './navigation.ts';

let asking = false;
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };

export const needsReloadConfirmation = (): boolean => asking;
export function subscribeReloadConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reloads now, or asks first while anything in the tab is unsaved (the one decision, `unsavedHere`). */
export function reloadUnlessUnacked(): void {
  releaseKept(false);
  if (unsavedHere() === null) {
    reloadDocument();
    return;
  }
  asking = true;
  publish();
}

export function answerReload(discard: boolean): void {
  // The dialog closes itself after either button: that close answers nothing and must not undo the choice.
  if (!asking) return;
  asking = false;
  // "Reload anyway" covers the text kept now: the reload does not ask about it again, but does about any later.
  releaseKept(discard);
  publish();
  if (discard) reloadDocument();
}

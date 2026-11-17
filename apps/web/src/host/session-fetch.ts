// The host's API fetch and whether this tab's session ended under it, which auth.ts arms (auth-state.ts sessionAware).
// Kept free of the auth module, so the editor and viewer bundles that reach one of its callers build without Start.
import { useSyncExternalStore } from 'react';
import { disarmOpeningGuard } from './opening-guard.ts';

export const SESSION_ENDED_COPY = 'Your session has ended. Sign in again to continue.';

let current: typeof fetch = (input, init) => fetch(input, init);
let ended = false;
let endedSignal: (() => void) | null = null;
let endedPromise = new Promise<void>((resolve) => { endedSignal = resolve; });
const listeners = new Set<() => void>();

/** fetch for the host's API callers: a 401 that means the session ended ends this tab in place and never settles. */
export const sessionFetch: typeof fetch = (input, init) => current(input, init);

export function armSessionFetch(next: typeof fetch): void {
  current = next;
}

export function setSessionEnded(next: boolean): void {
  if (next === ended) return;
  ended = next;
  if (next) {
    // A pending "+ Note" can no longer finish: the keyboard goes back to the page, and to the banner's "Sign in".
    disarmOpeningGuard();
    endedSignal?.();
  } else {
    endedPromise = new Promise<void>((resolve) => { endedSignal = resolve; });
  }
  for (const listener of [...listeners]) listener();
}

/** Settles once the session has ended under this tab (at once if it already has). */
export function whenSessionEnded(): Promise<void> {
  return endedPromise;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** A tab whose session ended while it was open (not a link visitor, who was never signed in). */
export function useSessionEnded(): boolean {
  return useSyncExternalStore(subscribe, () => ended, () => false);
}

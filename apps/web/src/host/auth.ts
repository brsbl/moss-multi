// This tab's auth store (host/auth-state.ts) wired to the page, and the guard for routes that need a session
// (A§4.2): no session redirects to /login?next=, a failed lookup degrades in place and retries (R10). The store is
// written only in the browser; SSR asks the session server function directly.
import { redirect, type ParsedLocation } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { lookupSession } from '../auth/session-fn.ts';
import { setAppState } from './app-state.ts';
import { createAuthStore, type AuthState, type SessionUser } from './auth-state.ts';
import { leaveTo } from './navigation.ts';

export const auth = createAuthStore({
  lookup: () => lookupSession(),
  fetch: (input, init) => fetch(input, init),
  leave: leaveTo,
  setAppState,
});

if (typeof window !== 'undefined') {
  // A degraded tab retries at once when the network or the tab comes back.
  window.addEventListener('online', () => auth.retryNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') auth.retryNow();
  });
}

const UNKNOWN: AuthState = { status: 'unknown' };

export function useAuthState(): AuthState {
  return useSyncExternalStore(auth.subscribe, auth.get, () => UNKNOWN);
}

/** `beforeLoad` for routes that render the moss shell; they run with `ssr: false`, so this runs in the browser. */
export async function requireSession({ location }: { location: ParsedLocation }): Promise<{ user: SessionUser }> {
  const user = await auth.resolve();
  if (!user) throw redirect({ to: '/login', search: { next: location.href }, replace: true });
  return { user };
}

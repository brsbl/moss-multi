// The phone shell (T2.7, deviation 11): below 640 px, Tailwind's `sm` breakpoint, the notes panel overlays the
// canvas instead of sharing the row with it. CSS-only yields use `sm:` classes; this is the same line for code.
import { useSyncExternalStore } from 'react';

export const NARROW_QUERY = '(max-width: 639.98px)';

const query = (): MediaQueryList | null => (typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia(NARROW_QUERY));

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/** True while the viewport is narrower than 640 px. */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribe, () => query()?.matches ?? false, () => false);
}

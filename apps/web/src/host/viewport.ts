// The phone shell (T2.7, deviation 11): below 640 px, Tailwind's `sm` breakpoint, the notes panel overlays the
// canvas instead of sharing the row with it. CSS-only yields use `sm:` classes; this is the same line for code.
import { useSyncExternalStore } from 'react';

export const NARROW_QUERY = '(max-width: 639.98px)';
/** Below Tailwind's `md`, where moss's actions panel has no room in the row (ActionsPanelWrapper). */
export const BELOW_MD_QUERY = '(max-width: 767.98px)';

/**
 * The actions panel below `md` (T9.30): it overlays the note from the right edge, as the notes panel does from the
 * left below 640 px, so its top-bar toggle stays at every width.
 */
export const COMPACT_ACTIONS_PANEL_CLASS =
  'max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:flex max-md:max-w-[calc(100vw-2rem)] max-md:border-l max-md:border-border-subtle/50 max-md:shadow-[0_8px_24px_var(--ink-shadow-soft)]';

const query = (media: string): MediaQueryList | null => (typeof window === 'undefined' || !window.matchMedia ? null : window.matchMedia(media));

function useMedia(media: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = query(media);
      list?.addEventListener('change', onChange);
      return () => list?.removeEventListener('change', onChange);
    },
    () => query(media)?.matches ?? false,
    () => false,
  );
}

/** True while the viewport is narrower than 640 px. */
export function useNarrow(): boolean {
  return useMedia(NARROW_QUERY);
}

/** True while the viewport is narrower than 768 px. */
export function useBelowMd(): boolean {
  return useMedia(BELOW_MD_QUERY);
}

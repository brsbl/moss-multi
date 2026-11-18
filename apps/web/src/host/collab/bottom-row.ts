// The pane's one bottom region (T9.30): the mode or capability row sits where Moss's docked editing toolbar does
// (bottom 24 px, centred, 16 px side margins), quiet like Moss's own status line: small muted text on the canvas, no
// card, border or shadow. While the toolbar shows, the Suggesting row joins it (ToolbarCollab) instead.
import { useLayoutEffect, useSyncExternalStore } from 'react';

/** The row's position in its pane, at the docked toolbar's place. */
export const BOTTOM_ROW_SLOT = 'pointer-events-none absolute bottom-6 left-1/2 z-40 w-max max-w-[calc(100%-2rem)] -translate-x-1/2';
/** The row itself: text on a canvas-coloured backing so the note scrolling under it stays out of the words. */
export const BOTTOM_ROW = 'pointer-events-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md bg-surface-canvas/90 px-2 py-1 text-xs text-ink-muted';
/** A row's exit or action: a plain text button in Moss's default ink. */
export const BOTTOM_ROW_ACTION = 'shrink-0 text-xs text-ink-default transition-colors hover:text-ink-muted';

// Docs whose Suggesting row is in Moss's docked toolbar right now.
const attached = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Marks `docId`'s row as attached to the docked toolbar while the calling component is mounted. */
export function useAttachedRow(docId: string | null): void {
  useLayoutEffect(() => {
    if (!docId) return;
    attached.set(docId, (attached.get(docId) ?? 0) + 1);
    emit();
    return () => {
      const left = (attached.get(docId) ?? 1) - 1;
      if (left > 0) attached.set(docId, left);
      else attached.delete(docId);
      emit();
    };
  }, [docId]);
}

/** Whether `docId`'s row is in the docked toolbar, so the pane's own slot stays empty. */
export function useRowAttached(docId: string): boolean {
  return useSyncExternalStore(subscribe, () => attached.has(docId), () => false);
}

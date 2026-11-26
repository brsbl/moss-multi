// The pane's one bottom region (T9.30): the mode or capability row sits where Moss's docked editing toolbar does
// (bottom 24 px, centred, 16 px side margins), quiet like Moss's own status line: small muted text on the canvas, no
// card, border or shadow. While the toolbar shows, the Suggesting row joins it (ToolbarCollab) instead. A connection
// notice or cue (T9.40) stands 8 px above the row, and above the toolbar while it shows, so neither covers the other.
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

/** The region in its pane, at the docked toolbar's place: its items stack upwards from there, 8 px apart. */
export const BOTTOM_REGION = 'pointer-events-none absolute bottom-6 left-1/2 z-40 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col items-center gap-2';
/** The region's bottom (Tailwind bottom-6) and the gap it keeps above the docked toolbar. */
export const REGION_BOTTOM_PX = 24;
export const REGION_GAP_PX = 8;
/** The row's place in the region. */
export const BOTTOM_ROW_SLOT = 'pointer-events-none flex max-w-full justify-center';
/** The row itself: text on a canvas-coloured backing so the note scrolling under it stays out of the words. */
export const BOTTOM_ROW = 'pointer-events-auto flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-md bg-surface-canvas/90 px-2 py-1 text-xs text-ink-muted';
/** A row's exit or action: a plain text button in Moss's default ink. */
export const BOTTOM_ROW_ACTION = 'shrink-0 text-xs text-ink-default transition-colors hover:text-ink-muted';

/** The region's mousedown: a press on a notice's action leaves the caret in the note, as Moss's own toolbar buttons do. */
export function keepCaretInNote(event: { target: unknown; preventDefault(): void }): void {
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (target?.closest?.('button')) event.preventDefault();
}

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

// The height of the docked toolbar showing for a doc, so the region's notices stand above it.
const toolbars = new Map<string, number>();

/** A probe for inside Moss's docked toolbar: while mounted it reports the toolbar's height for `docId`. */
export function useToolbarProbe(docId: string): RefObject<HTMLSpanElement | null> {
  const probe = useRef<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    const bar = probe.current?.parentElement;
    if (!bar) return;
    const report = (height: number) => {
      if (toolbars.get(docId) === height) return;
      toolbars.set(docId, height);
      emit();
    };
    report(bar.getBoundingClientRect().height);
    const observer = new ResizeObserver(([entry]) => report(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height));
    observer.observe(bar);
    return () => {
      observer.disconnect();
      toolbars.delete(docId);
      emit();
    };
  }, [docId]);
  return probe;
}

/** The docked toolbar's height while it shows for `docId`, else 0. */
export function useToolbarHeight(docId: string): number {
  return useSyncExternalStore(subscribe, () => toolbars.get(docId) ?? 0, () => 0);
}

// ported-from: packages/shared/src/components/ui/use-note-pane-dialog-position.ts @ 762abb777
import { useLayoutEffect, useState } from 'react';
import type { CSSProperties } from 'react';

const NOTE_PANE_DIALOG_ANCHOR_SELECTOR = '[data-command-palette-note-pane="true"]';
const CANVAS_BOUNDARY_SELECTOR = '.canvas-scroll';
const DEFAULT_TOTAL_HORIZONTAL_MARGIN_PX = 32;

const findFallbackBoundary = (): Element | null => {
  const activeElement = document.activeElement;
  const activeCanvas = activeElement instanceof Element
    ? activeElement.closest(CANVAS_BOUNDARY_SELECTOR)
    : null;
  if (activeCanvas) return activeCanvas;

  const notePane = document.querySelector<HTMLElement>(NOTE_PANE_DIALOG_ANCHOR_SELECTOR);
  const notePaneCanvas = notePane?.querySelector(CANVAS_BOUNDARY_SELECTOR);
  if (notePaneCanvas) return notePaneCanvas;

  const visibleCanvases = Array.from(document.querySelectorAll<HTMLElement>(CANVAS_BOUNDARY_SELECTOR))
    .filter((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  if (visibleCanvases.length === 1) return visibleCanvases[0];

  return notePane;
};

interface NotePaneDialogPositionOptions {
  open: boolean;
  maxWidthPx?: number;
  boundaryElement?: Element | null;
  totalHorizontalMarginPx?: number;
}

export function useNotePaneDialogPosition({
  open,
  maxWidthPx,
  boundaryElement,
  totalHorizontalMarginPx = DEFAULT_TOTAL_HORIZONTAL_MARGIN_PX
}: NotePaneDialogPositionOptions) {
  const [style, setStyle] = useState<CSSProperties | undefined>();

  useLayoutEffect(() => {
    if (!open || typeof document === 'undefined') {
      setStyle(undefined);
      return;
    }

    const requestedMaxWidth = typeof maxWidthPx === 'number' && Number.isFinite(maxWidthPx)
      ? maxWidthPx
      : undefined;
    const boundary = boundaryElement ?? findFallbackBoundary();

    if (!boundary) {
      setStyle(requestedMaxWidth === undefined ? undefined : { maxWidth: requestedMaxWidth });
      return;
    }

    const update = () => {
      const rect = boundary.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        setStyle(requestedMaxWidth === undefined ? undefined : { maxWidth: requestedMaxWidth });
        return;
      }

      const availableWidth = Math.max(0, rect.width - totalHorizontalMarginPx);
      setStyle({
        left: rect.left + rect.width / 2,
        top: rect.top + rect.height / 2,
        ...(availableWidth > 0
          ? { maxWidth: requestedMaxWidth === undefined ? availableWidth : Math.min(requestedMaxWidth, availableWidth) }
          : requestedMaxWidth === undefined ? {} : { maxWidth: requestedMaxWidth })
      });
    };

    update();

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    resizeObserver?.observe(boundary);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [boundaryElement, maxWidthPx, open, totalHorizontalMarginPx]);

  return style;
}

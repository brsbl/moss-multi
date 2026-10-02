// ported-from: packages/desktop/src/renderer/editor/hooks/useScrollDismiss.ts @ 762abb777
import { useEffect } from 'react';

const SCROLL_CONTAINER_SELECTOR = '.canvas-scroll';

/**
 * Dismisses a floating element when the user scrolls the editor canvas.
 *
 * Ignores sub-pixel layout-induced scroll events (from Lexical reconciliation,
 * focus changes, toolbar switches) via a scroll-delta threshold. A startup
 * delay prevents flash-dismiss during mount-time reflow.
 */
export function useScrollDismiss(
  open: boolean,
  onDismiss: () => void,
  { delayMs = 150, thresholdPx = 15 } = {}
): void {
  useEffect(() => {
    if (!open) return;
    const scroller = document.querySelector(SCROLL_CONTAINER_SELECTOR);
    if (!scroller) return;

    let baseScrollTop = scroller.scrollTop;

    const handleScroll = () => {
      if (Math.abs(scroller.scrollTop - baseScrollTop) > thresholdPx) {
        onDismiss();
      }
    };

    const timerId = setTimeout(() => {
      baseScrollTop = scroller.scrollTop; // re-snapshot after layout settles
      scroller.addEventListener('scroll', handleScroll, { passive: true });
    }, delayMs);

    return () => {
      clearTimeout(timerId);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, [open, onDismiss, delayMs, thresholdPx]);
}

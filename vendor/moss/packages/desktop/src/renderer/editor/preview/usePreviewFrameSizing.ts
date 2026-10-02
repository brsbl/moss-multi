// ported-from: packages/desktop/src/renderer/editor/preview/usePreviewFrameSizing.ts @ 762abb777
/**
 * Shared layout-measurement hooks for media-family preview frames.
 *
 * `moss-html` previews and webpage embeds both resolve their note-frame size
 * against the available canvas width and their fullscreen size against the
 * anchored canvas viewport. These hooks own that measurement so neither node
 * forks its own ResizeObserver/viewport plumbing.
 */
import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

/** Tracks the rounded content width of `ref`'s element (ResizeObserver-backed). */
export function useObservedElementWidth(
  ref: RefObject<HTMLElement | null>
): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const updateWidth = (nextWidth: number) => {
      if (!Number.isFinite(nextWidth) || nextWidth <= 0) {
        return;
      }
      const roundedWidth = Math.round(nextWidth);
      setWidth((previousWidth) => (
        previousWidth === roundedWidth ? previousWidth : roundedWidth
      ));
    };

    updateWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      updateWidth(entry.contentRect.width);
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

/**
 * Tracks the size of the `.canvas-scroll` viewport that contains `ref` (falling
 * back to the window). Used to size fullscreen previews against the visible
 * canvas rather than the raw window.
 */
export function useAnchoredViewportSize(
  ref: RefObject<HTMLElement | null>
): { width: number; height: number } {
  const readViewportSize = () => ({
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight
  });
  const [viewportSize, setViewportSize] = useState(readViewportSize);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const resolveAnchorElement = () => (
      ref.current?.closest('.canvas-scroll') as HTMLElement | null
    ) ?? null;
    const updateViewportSize = () => {
      const anchorElement = resolveAnchorElement();
      const rect = anchorElement?.getBoundingClientRect();
      if (
        rect &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        setViewportSize({
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
        return;
      }

      setViewportSize(readViewportSize());
    };

    updateViewportSize();
    const anchorElement = resolveAnchorElement();
    const resizeObserver = anchorElement && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateViewportSize)
      : null;
    if (resizeObserver && anchorElement) {
      resizeObserver.observe(anchorElement);
    }

    window.addEventListener('resize', updateViewportSize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateViewportSize);
    };
  }, [ref]);

  return viewportSize;
}

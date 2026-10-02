// ported-from: packages/desktop/src/renderer/hooks/useFloatingBarWidth.ts @ 762abb777
import { useCallback, useEffect, useState, useRef, type RefObject } from 'react';

export const DEFAULT_NAV_BAR_WIDTH = 176;

export interface FloatingBarDimensions {
  /** Maximum width for the title bar in pixels */
  titleMaxWidth: number;
  /** Current container width in pixels */
  containerWidth: number;
  /** Container is narrow (<640px) - consider stacking */
  isNarrow: boolean;
  /** Container is medium width (640-1024px) */
  isMedium: boolean;
  /** Container is wide (>1024px) */
  isWide: boolean;
}

export interface UseFloatingBarWidthOptions {
  /** Fixed width of the nav bar in pixels (default: 176) */
  navBarWidth?: number;
  /** Gap between title and nav bars in pixels (default: 16) */
  gap?: number;
  /** Minimum title bar width in pixels (default: 280) */
  minTitleWidth?: number;
  /** Maximum title bar width in pixels (default: 640) */
  maxTitleWidth?: number;
  /** Horizontal padding around the bars in pixels (default: 48) */
  padding?: number;
}

/**
 * Calculates responsive width for floating title bar based on actual container size.
 * Uses ResizeObserver to track canvas container width changes in real-time,
 * ensuring the title bar adapts smoothly when the right panel expands/collapses.
 *
 * @param containerRef - Ref to the scroll container element
 * @param options - Width constraints configuration
 * @returns Calculated dimensions for responsive layout
 *
 * @example
 * ```tsx
 * const scrollRef = useRef<HTMLDivElement>(null);
 * const { titleMaxWidth, isNarrow } = useFloatingBarWidth(scrollRef, {
 *   navBarWidth: 140,
 *   gap: 16,
 *   minTitleWidth: 280
 * });
 * ```
 */
export function useFloatingBarWidth(
  containerRef: RefObject<HTMLElement | null>,
  options: UseFloatingBarWidthOptions = {}
): FloatingBarDimensions {
  const {
    navBarWidth = DEFAULT_NAV_BAR_WIDTH,
    gap = 16,
    minTitleWidth = 280,
    maxTitleWidth = 640,
    padding = 48
  } = options;

  // Helper to calculate dimensions from a container width
  const calculateDimensions = useCallback((containerWidth: number): FloatingBarDimensions => {
    const totalReserved = navBarWidth + gap + padding;
    const availableWidth = containerWidth - totalReserved;
    const clampedWidth = Math.max(
      minTitleWidth,
      Math.min(maxTitleWidth, availableWidth)
    );

    return {
      titleMaxWidth: clampedWidth,
      containerWidth,
      isNarrow: containerWidth < 640,
      isMedium: containerWidth >= 640 && containerWidth < 1024,
      isWide: containerWidth >= 1024
    };
  }, [navBarWidth, gap, padding, minTitleWidth, maxTitleWidth]);

  const [dimensions, setDimensions] = useState<FloatingBarDimensions>(() => {
    // Initial calculation inline (can't use useCallback in initializer)
    const totalReserved = navBarWidth + gap + padding;
    const container = containerRef.current;
    const containerWidth = container?.getBoundingClientRect().width ?? 1024;
    const availableWidth = containerWidth - totalReserved;
    const clampedWidth = Math.max(
      minTitleWidth,
      Math.min(maxTitleWidth, availableWidth)
    );

    return {
      titleMaxWidth: clampedWidth,
      containerWidth,
      isNarrow: containerWidth < 640,
      isMedium: containerWidth >= 640 && containerWidth < 1024,
      isWide: containerWidth >= 1024
    };
  });

  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const latestWidthRef = useRef<number>(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') {
      return;
    }

    // Measure immediately when effect runs (ref now attached)
    const initialWidth = container.getBoundingClientRect().width;
    latestWidthRef.current = initialWidth;
    setDimensions(calculateDimensions(initialWidth));

    // Then observe for future changes, batching with rAF to avoid per-pixel re-renders.
    // Store latest width in ref so the rAF callback always uses the most recent value,
    // even when multiple resize events fire before the frame callback executes.
    resizeObserverRef.current = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width === undefined) return;
      latestWidthRef.current = width;
      if (rafIdRef.current !== null) return;
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        setDimensions(calculateDimensions(latestWidthRef.current));
      });
    });

    resizeObserverRef.current.observe(container);

    return () => {
      resizeObserverRef.current?.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [containerRef, calculateDimensions]);

  // Re-calculate when options change (e.g., panel collapse toggle)
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      setDimensions(calculateDimensions(container.getBoundingClientRect().width));
    }
  }, [containerRef, calculateDimensions]);

  return dimensions;
}

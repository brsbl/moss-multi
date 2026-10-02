// ported-from: packages/desktop/src/renderer/editor/typeahead/useFloatingPosition.ts @ 762abb777
/**
 * Hook for positioning floating UI elements using Floating UI
 *
 * Provides automatic flip/shift behavior for typeahead menus, hover cards,
 * and other floating elements in the editor.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computePosition,
  flip,
  shift,
  size,
  offset as offsetMiddleware,
  autoUpdate,
  type Placement
} from '@floating-ui/react';

export interface VirtualAnchor {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface UseFloatingPositionOptions {
  /** Whether the floating element is currently visible */
  isOpen: boolean;
  /** Preferred placement relative to anchor */
  placement?: Placement;
  /** Offset from anchor in pixels */
  offset?: number;
  /** Virtual anchor for cursor-based positioning (alternative to anchorRef) */
  virtualAnchor?: VirtualAnchor;
}

export interface FloatingPosition {
  x: number;
  y: number;
}

export interface UseFloatingPositionReturn {
  /** Ref to attach to the anchor/reference element */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Ref to attach to the floating element */
  floatingRef: React.RefObject<HTMLDivElement | null>;
  /** Calculated position for the floating element */
  position: FloatingPosition;
  /** True after Floating UI has computed an initial position for the open element. */
  isPositioned: boolean;
  /** Available height for the floating element within the viewport (set by size() middleware) */
  availableHeight: number | undefined;
  /** Manually trigger a position recalculation (useful for virtual anchors where autoUpdate doesn't work) */
  updatePosition: () => void;
  /** @deprecated Use virtualAnchor option instead. Set a virtual anchor position (for cursor-based positioning) */
  setVirtualAnchor: (rect: { x: number; y: number; width?: number; height?: number }) => void;
}

/**
 * Hook that handles positioning of floating UI elements with automatic
 * flip and shift behavior using Floating UI.
 *
 * Supports both element-based anchoring (via anchorRef) and virtual
 * anchoring (via virtualAnchor option for cursor-based positioning).
 */
export function useFloatingPosition({
  isOpen,
  placement = 'bottom-start',
  offset = 8,
  virtualAnchor
}: UseFloatingPositionOptions): UseFloatingPositionReturn {
  const anchorRef = useRef<HTMLElement | null>(null);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<FloatingPosition>({ x: 0, y: 0 });
  const [isPositioned, setIsPositioned] = useState(false);
  const [availableHeight, setAvailableHeight] = useState<number | undefined>(undefined);
  // Legacy ref for setVirtualAnchor (deprecated) - prefer virtualAnchor option
  const virtualAnchorRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const virtualAnchorKey = virtualAnchor
    ? `${virtualAnchor.x}:${virtualAnchor.y}:${virtualAnchor.width ?? 0}:${virtualAnchor.height ?? 0}`
    : null;

  const updatePosition = useCallback(async () => {
    const floating = floatingRef.current;
    if (!floating) return;

    // Priority: virtualAnchor prop > legacy virtualAnchorRef > element anchorRef
    const anchorData = virtualAnchor ?? virtualAnchorRef.current;
    const reference = anchorData
      ? {
          getBoundingClientRect: () => ({
            x: anchorData.x,
            y: anchorData.y,
            top: anchorData.y,
            left: anchorData.x,
            bottom: anchorData.y + (anchorData.height ?? 0),
            right: anchorData.x + (anchorData.width ?? 0),
            width: anchorData.width ?? 0,
            height: anchorData.height ?? 0
          })
        }
      : anchorRef.current;

    if (!reference) return;

    const { x, y } = await computePosition(reference, floating, {
      placement,
      middleware: [
        offsetMiddleware(offset),
        flip({
          fallbackAxisSideDirection: 'start',
          padding: 8
        }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight: ah }) {
            setAvailableHeight(ah);
          }
        })
      ]
    });

    setPosition({ x, y });
    setIsPositioned(true);
  }, [placement, offset, virtualAnchor]);

  // Set up auto-update when open
  useEffect(() => {
    if (!isOpen) {
      setIsPositioned(false);
      return;
    }

    setIsPositioned(false);
    const floating = floatingRef.current;
    // Use element anchor only if no virtual anchor is provided
    const hasVirtualAnchor = virtualAnchor || virtualAnchorRef.current;
    const reference = hasVirtualAnchor ? null : anchorRef.current;

    // Initial position update
    updatePosition();

    // For element-based anchors, set up auto-update for scroll/resize
    if (reference && floating) {
      const cleanup = autoUpdate(reference, floating, updatePosition);
      return cleanup;
    }
  }, [isOpen, updatePosition, virtualAnchor, virtualAnchorKey]);

  const setVirtualAnchor = useCallback(
    (rect: { x: number; y: number; width?: number; height?: number }) => {
      virtualAnchorRef.current = {
        x: rect.x,
        y: rect.y,
        width: rect.width ?? 0,
        height: rect.height ?? 0
      };
      if (isOpen) {
        updatePosition();
      }
    },
    [isOpen, updatePosition]
  );

  return {
    anchorRef,
    floatingRef,
    position,
    isPositioned,
    availableHeight,
    updatePosition,
    setVirtualAnchor
  };
}

export default useFloatingPosition;

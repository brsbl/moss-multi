// ported-from: packages/desktop/src/renderer/editor/typeahead/HoverCard.tsx @ 762abb777
/**
 * Shared hover card component with automatic flip positioning
 *
 * Used for preview cards that appear on hover (file link previews, etc.)
 * Uses Floating UI for automatic flip/shift behavior.
 */
import { useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from './useFloatingPosition';

export interface HoverCardPosition {
  /** X coordinate (left edge of anchor element) */
  x: number;
  /** Y coordinate (bottom edge of anchor element) */
  y: number;
  /** Height of the anchor element */
  anchorHeight?: number;
}

export interface HoverCardProps {
  /** Whether the card is visible */
  isVisible: boolean;
  /** Position of the anchor element */
  position: HoverCardPosition;
  /** Content to render inside the card */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
  /** Gap between anchor and card */
  gap?: number;
  /** Max width of the card */
  maxWidth?: number;
  /** Inline styles for the floating card */
  style?: React.CSSProperties;
}

/**
 * A floating hover card that positions itself relative to an anchor element.
 * Uses Floating UI for automatic flip/shift behavior.
 */
export function HoverCard({
  isVisible,
  position,
  children,
  className,
  gap = 8,
  maxWidth = 320,
  style
}: HoverCardProps) {
  // Compute virtual anchor from position prop - derived state, no effect needed
  // Only compute when visible to avoid unnecessary work
  const virtualAnchor = useMemo(
    () => isVisible ? {
      x: position.x,
      y: position.y - (position.anchorHeight ?? 0),
      width: 0,
      height: position.anchorHeight ?? 0
    } : undefined,
    [isVisible, position.x, position.y, position.anchorHeight]
  );

  const { floatingRef, position: floatingPosition, isPositioned } = useFloatingPosition({
    isOpen: isVisible,
    placement: 'bottom-start',
    offset: gap,
    virtualAnchor
  });

  // Use callback ref to directly assign to floatingRef - no useEffect needed
  // Refs are stable across renders, so no deps needed
  const setFloatingRef = useCallback(
    (node: HTMLDivElement | null) => {
      (floatingRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- floatingRef is a stable ref
    []
  );

  if (!isVisible) {
    return null;
  }

  const baseClasses = 'fixed z-50 rounded-lg border border-border-subtle bg-surface-canvas shadow-lg animate-in fade-in-0 zoom-in-95';
  const cardClasses = className ? `${baseClasses} ${className}` : baseClasses;

  return createPortal(
    <div
      ref={setFloatingRef}
      className={cardClasses}
      style={{
        ...style,
        left: floatingPosition.x,
        top: floatingPosition.y,
        maxWidth,
        visibility: isPositioned ? style?.visibility : 'hidden',
        pointerEvents: isPositioned ? style?.pointerEvents : 'none'
      }}
    >
      {children}
    </div>,
    document.body
  );
}

export default HoverCard;

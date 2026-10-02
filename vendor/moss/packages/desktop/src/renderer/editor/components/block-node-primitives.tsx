// ported-from: packages/desktop/src/renderer/editor/components/block-node-primitives.tsx @ 762abb777
import React from 'react';
import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';

export const BLOCK_SELECTED_FRAME_CLASSNAME = 'editor-block-selection-outline';
export const BLOCK_SELECTION_WRAPPER_CLASSNAME = 'editor-block-selection-frame';
export const BLOCK_SELECTION_WRAPPER_SELECTED_CLASSNAME = 'editor-block-wrapper-selected';
export const BLOCK_SURFACE_CLASSNAME = 'editor-block-surface';
export const BLOCK_HEADER_CLASSNAME = 'editor-block-header';
export const BLOCK_GAP_CURSOR_CLASSNAME = 'editor-block-gap-cursor';
export const BLOCK_GAP_CURSOR_HIT_AREA_CLASSNAME = 'h-4';
export const BLOCK_GAP_CURSOR_LINE_CLASSNAME =
  'editor-block-gap-cursor-line w-16 rounded-full opacity-0 transition-opacity group-hover/gap:opacity-100';

type SelectionOutlineProps = {
  selected: boolean;
  className?: string;
};

function renderSelectionOutline({ selected, className }: SelectionOutlineProps): JSX.Element | null {
  if (!selected) return null;

  return (
    <div
      className={`${BLOCK_SELECTED_FRAME_CLASSNAME} ${className ?? ''}`}
      aria-hidden="true"
    />
  );
}

type GapCursorProps = {
  position: 'before' | 'after';
  label: string;
  onClick: (e: React.MouseEvent) => void;
  heightClassName?: string;
};

export function GapCursor({
  position,
  label,
  onClick,
  heightClassName = BLOCK_GAP_CURSOR_HIT_AREA_CLASSNAME,
}: GapCursorProps): JSX.Element {
  return (
    <div
      className={`${BLOCK_GAP_CURSOR_CLASSNAME} group/gap absolute left-0 right-0 z-20 flex ${heightClassName} cursor-text items-center justify-center ${
        position === 'before' ? '-top-2' : '-bottom-2'
      }`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onClick}
      role="button"
      tabIndex={-1}
      aria-label={label}
    >
      <div className={BLOCK_GAP_CURSOR_LINE_CLASSNAME} />
    </div>
  );
}

type BlockNodeShellProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  selected: boolean;
  beforeLabel: string;
  afterLabel: string;
  /**
   * Gap-cursor click handler (inserts an adjacent paragraph). When omitted —
   * e.g. a read-only render where paragraph insertion is disallowed — the gap
   * cursors are not rendered at all, so no mutating affordance is exposed.
   */
  onGapClick?: (position: 'before' | 'after') => (e: React.MouseEvent) => void;
  children: ReactNode;
  className?: string;
  selectionClassName?: string;
};

export const BlockNodeShell = React.forwardRef<HTMLDivElement, BlockNodeShellProps>(function BlockNodeShell({
  selected,
  beforeLabel,
  afterLabel,
  onGapClick,
  children,
  className,
  selectionClassName,
  ...props
}, ref): JSX.Element {
  return (
    <div {...props} ref={ref} className={`group/decorator relative box-border rounded-lg p-0.5 ${className ?? ''}`}>
      {onGapClick && (
        <GapCursor
          position="before"
          label={beforeLabel}
          onClick={onGapClick('before')}
        />
      )}
      {renderSelectionOutline({ selected, className: selectionClassName })}
      {children}
      {onGapClick && (
        <GapCursor
          position="after"
          label={afterLabel}
          onClick={onGapClick('after')}
        />
      )}
    </div>
  );
});

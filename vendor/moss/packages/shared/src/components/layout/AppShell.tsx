// ported-from: packages/shared/src/components/layout/AppShell.tsx @ 762abb777
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

export interface AppShellProps {
  className?: string;
  notesPanel?: ReactNode;
  canvasArea?: ReactNode;
  actionsPanel?: ReactNode;
  showFocusModeLeftDragZone?: boolean;
  focusModeLeftDragWidthPx?: number;
}

/**
 * Root layout shell with three-column flex layout.
 * Each panel (notes, canvas, actions) sits as a sibling without overlapping.
 * Overflow is handled internally by each panel, not at the shell level.
 */
export function AppShell({
  className,
  notesPanel,
  canvasArea,
  actionsPanel,
  showFocusModeLeftDragZone = false,
  focusModeLeftDragWidthPx = 0
}: AppShellProps) {
  return (
    <div
      data-moss-app-shell="true"
      className="relative flex h-full min-h-screen w-full overflow-hidden rounded-xl bg-surface-canvas-bg"
    >
      {showFocusModeLeftDragZone ? (
        <div
          className="pointer-events-none absolute left-0 top-0 z-40 h-20"
          style={{ width: `${focusModeLeftDragWidthPx}px` } as CSSProperties}
        >
          <div
            className="pointer-events-auto h-full w-full"
            style={{ WebkitAppRegion: 'drag' } as CSSProperties}
            aria-hidden
          />
        </div>
      ) : null}
      <div
        className={cn(
          'flex h-full w-full rounded-xl bg-surface-canvas-bg text-ink-default',
          className
        )}
      >
        {/* Notes panel - fixed width, handles its own scroll */}
        {notesPanel}
        {/* Canvas area - fills remaining space, handles its own scroll */}
        <main
          className={cn(
            'relative z-10 -ml-3 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border-l border-r border-border-subtle bg-surface-canvas pl-3'
          )}
        >
          {canvasArea}
        </main>
        {/* Actions panel - fixed width, handles its own scroll */}
        {actionsPanel}
      </div>
    </div>
  );
}

export default AppShell;

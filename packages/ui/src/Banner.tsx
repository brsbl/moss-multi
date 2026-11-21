import type { HTMLAttributes, ReactNode } from 'react';

/** A floating bottom notice in the recipe of moss's own Trash notice (CanvasAreaContent): card material, muted text. */
export function Banner({ children, action, icon, ...props }: HTMLAttributes<HTMLDivElement> & { action?: ReactNode; icon?: ReactNode }) {
  return (
    <div role="status" {...props} className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
      {icon}
      <span className="min-w-0 text-xs text-ink-muted">{children}</span>
      {action ? <span className="shrink-0 text-xs">{action}</span> : null}
    </div>
  );
}

import type { HTMLAttributes, ReactNode } from 'react';

/**
 * A floating bottom notice in the recipe of moss's own Trash notice (CanvasAreaContent): card material, muted text.
 * Where the words and actions do not fit on one line, the actions wrap below the words; `detail` takes a line of its own.
 */
export function Banner({ children, action, icon, detail, ...props }: HTMLAttributes<HTMLDivElement> & { action?: ReactNode; icon?: ReactNode; detail?: ReactNode }) {
  return (
    <div role="status" {...props} className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
      <span className="flex min-w-0 flex-[1_1_auto] items-center gap-2">
        {icon}
        <span className="min-w-0 text-xs text-ink-muted">{children}</span>
      </span>
      {action ? <span className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">{action}</span> : null}
      {detail ? <div className="min-w-0 basis-full">{detail}</div> : null}
    </div>
  );
}

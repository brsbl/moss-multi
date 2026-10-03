import type { HTMLAttributes, ReactNode } from 'react';

/** Notice-band primitive, using moss's status and surface tokens. */
export function Banner({ children, action, ...props }: HTMLAttributes<HTMLDivElement> & { action?: ReactNode }) {
  return (
    <div role="status" {...props} className="flex min-w-0 items-center justify-between gap-3 border-b border-border-subtle bg-surface-raised-card px-4 py-2 text-xs text-ink-muted">
      <span className="min-w-0">{children}</span>
      {action ? <span className="shrink-0">{action}</span> : null}
    </div>
  );
}

// ported-from: packages/shared/src/components/notes/VersionHistoryEmptyState.tsx @ 762abb777
import { GitBranch } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface VersionHistoryEmptyStateProps {
  className?: string;
  heading?: string;
  description?: string;
}

export function VersionHistoryEmptyState({
  className,
  heading = 'No checkpoints',
  description = 'Version history will appear once you save your first checkpoint.'
}: VersionHistoryEmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border-default bg-surface-canvas px-6 py-8 text-center',
        className
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border-subtle bg-surface-raised-card text-accent-brand shadow-sm">
        <GitBranch aria-hidden className="h-6 w-6" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-ink-default">{heading}</h3>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
    </div>
  );
}

export default VersionHistoryEmptyState;

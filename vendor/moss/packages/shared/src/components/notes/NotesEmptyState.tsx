// ported-from: packages/shared/src/components/notes/NotesEmptyState.tsx @ 762abb777
import type { ReactNode } from 'react';
import { NotebookPen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NotesEmptyStateProps {
  className?: string;
  heading?: string;
  description?: string;
  ctaLabel?: string;
  onCreateNote?: () => void;
  footer?: ReactNode;
  showPrimaryAction?: boolean;
}

export function NotesEmptyState({
  className,
  heading = 'No notes yet',
  description = 'Create your first note to get started.',
  ctaLabel = 'New Note',
  onCreateNote,
  footer,
  showPrimaryAction = true
}: NotesEmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border-default bg-surface-canvas px-6 py-8 text-center',
        className
      )}
    >
      <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border-subtle bg-surface-raised-card text-accent-brand shadow-sm">
        <NotebookPen aria-hidden className="h-6 w-6" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-semibold text-ink-default">{heading}</h3>
        <p className="text-sm text-ink-muted">{description}</p>
      </div>
      <div className="flex flex-col items-center gap-3">
        {showPrimaryAction ? (
          <Button variant="default" size="sm" onClick={onCreateNote}>
            {ctaLabel}
          </Button>
        ) : null}
        {footer}
      </div>
    </div>
  );
}

export default NotesEmptyState;

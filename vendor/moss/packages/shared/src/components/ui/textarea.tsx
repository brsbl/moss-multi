// ported-from: packages/shared/src/components/ui/textarea.tsx @ 762abb777
import * as React from 'react';
import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<'textarea'>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex w-full rounded-md border border-border-clear bg-surface-raised-control px-2 py-1.5 text-xs leading-relaxed text-ink-default transition-colors',
          'placeholder:text-ink-faint/50',
          'focus-visible:outline-none focus-visible:border-border-default focus-visible:bg-surface-raised-control-hover',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };

// ported-from: packages/shared/src/components/ui/input.tsx @ 762abb777
import * as React from 'react';
import { cn } from '@/lib/utils';

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<'input'>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-border-clear bg-surface-raised-control px-3 py-2 text-sm text-ink-default transition-colors',
          'file:border-0 file:bg-surface-transparent file:text-sm file:font-medium',
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
Input.displayName = 'Input';

export { Input };

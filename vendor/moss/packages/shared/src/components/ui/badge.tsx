// ported-from: packages/shared/src/components/ui/badge.tsx @ 762abb777
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-normal transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-badge text-ink-default',
        secondary: 'bg-surface-badge-muted text-ink-default',
        outline: 'border border-border-subtle/60 text-ink-muted',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
    );
  }
);
Badge.displayName = 'Badge';

export { Badge, badgeVariants };

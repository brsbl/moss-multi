// ported-from: packages/shared/src/components/ui/button.tsx @ 762abb777
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { Slot } from '@/components/primitives';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent-brand text-ink-on-accent shadow hover:bg-accent-brand-pressed focus-visible:ring-ink-default/20',
        danger: 'bg-accent-terracotta text-ink-on-accent shadow hover:bg-accent-terracotta/90 focus-visible:ring-accent-terracotta',
        secondary: 'bg-border-subtle text-ink-default shadow-sm hover:bg-border-default focus-visible:ring-ink-default/20',
        outline: 'border border-accent-brand text-accent-brand hover:bg-accent-brand/10 focus-visible:ring-ink-default/20',
        ghost: 'text-accent-brand hover:bg-surface-sidebar focus-visible:ring-ink-default/20',
        link: 'text-accent-brand underline-offset-4 hover:underline focus-visible:ring-ink-default/20',
        stop: 'border border-border-default bg-surface-panel text-ink-muted shadow-sm hover:bg-border-subtle hover:text-ink-default focus-visible:ring-border-default'
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };

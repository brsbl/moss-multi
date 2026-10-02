// ported-from: packages/shared/src/components/ui/label.tsx @ 762abb777
import * as React from 'react';
import { cn } from '@/lib/utils';

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn('font-mono text-xs font-medium text-ink-faint', className)}
      {...props}
    />
  )
);
Label.displayName = 'Label';

export { Label };

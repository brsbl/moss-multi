// ported-from: packages/desktop/src/renderer/editor/components/ToolbarTextInput.tsx @ 762abb777
import { forwardRef } from 'react';
import type { ComponentProps } from 'react';
import { CornerDownLeft } from 'lucide-react';

import { Input } from '@moss/shared/components/ui/input';
import { cn } from '@moss/shared/lib/utils';

type ToolbarTextInputProps = ComponentProps<'input'> & {
  inputClassName?: string;
  onSubmit?: () => void;
  submitAriaLabel?: string;
  submitDisabled?: boolean;
};

const actionButtonClassName =
  'flex shrink-0 items-center justify-center rounded px-1 py-1.5 text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-default disabled:opacity-30';
const actionIconClassName = 'h-3 w-3';

export const ToolbarTextInput = forwardRef<HTMLInputElement, ToolbarTextInputProps>(
  (
    {
      className,
      inputClassName,
      onKeyDown,
      onSubmit,
      submitAriaLabel = 'Apply',
      submitDisabled = false,
      ...props
    },
    ref
  ) => (
    <div className={cn(className, 'flex min-w-0 flex-nowrap items-center gap-1')}>
      <Input
        ref={ref}
        {...props}
        className={cn(
          'h-8 min-w-0 flex-1 border-border-default bg-surface-raised-control px-2.5 py-1 text-sm focus-visible:border-border-default focus-visible:bg-surface-raised-control-hover',
          inputClassName
        )}
        onKeyDown={(event) => {
          event.stopPropagation();
          onKeyDown?.(event);
        }}
      />
      {onSubmit ? (
        <button
          type="button"
          aria-label={submitAriaLabel}
          disabled={submitDisabled}
          onClick={onSubmit}
          className={cn(actionButtonClassName, 'disabled:cursor-not-allowed')}
        >
          <CornerDownLeft className={actionIconClassName} aria-hidden />
        </button>
      ) : null}
    </div>
  )
);

ToolbarTextInput.displayName = 'ToolbarTextInput';

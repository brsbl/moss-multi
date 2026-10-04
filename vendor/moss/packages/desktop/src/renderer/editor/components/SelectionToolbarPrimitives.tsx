// ported-from: packages/desktop/src/renderer/editor/components/SelectionToolbarPrimitives.tsx @ 762abb777
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, JSX } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@moss/shared/lib/utils';

export const SELECTION_TOOLBAR_BUTTON_BASE_CLASS =
  'flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border-clear text-ink-default transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-default/15';
export const SELECTION_TOOLBAR_BUTTON_PRESS_CLASS = 'active:scale-90';
export const SELECTION_TOOLBAR_BUTTON_IDLE_CLASS = 'hover:border-border-subtle hover:bg-surface-sidebar';
export const SELECTION_TOOLBAR_BUTTON_ACCENT_CLASS =
  'border-accent-brand bg-surface-note-selected/70 text-accent-brand-pressed shadow-[inset_0_1px_2px_var(--ink-shadow-soft)]';

export const SELECTION_TOOLBAR_ESTIMATED_HEIGHT = 40;
export const SELECTION_TOOLBAR_ANCHOR_GAP = 8;
export const SELECTION_TOOLBAR_VIEWPORT_TOP_GUARD = 48;

export const SelectionToolbarDivider = (): JSX.Element => (
  <div className="mx-1 h-5 w-px shrink-0 bg-border-subtle/80" />
);

export const SelectionToolbarShell = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { style?: CSSProperties }>(
  function SelectionToolbarShell({ className, children, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          'pointer-events-auto inline-flex animate-[fadeIn_100ms_ease-out] rounded-lg border border-border-subtle bg-surface-panel p-0 shadow-sm',
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
);

export const SelectionToolbarInner = ({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element => (
  <div className={cn('flex items-center px-1.5 py-1', className)} {...props}>
    {children}
  </div>
);

export interface SelectionToolbarButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  accent?: boolean;
  press?: boolean;
}

export function SelectionToolbarButton({
  icon: Icon,
  accent = false,
  press = true,
  className,
  onMouseDown,
  children,
  ...props
}: SelectionToolbarButtonProps): JSX.Element {
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onMouseDown?.(event);
      }}
      className={cn(
        SELECTION_TOOLBAR_BUTTON_BASE_CLASS,
        press && SELECTION_TOOLBAR_BUTTON_PRESS_CLASS,
        accent ? SELECTION_TOOLBAR_BUTTON_ACCENT_CLASS : SELECTION_TOOLBAR_BUTTON_IDLE_CLASS,
        className
      )}
      {...props}
    >
      <Icon aria-hidden className="h-4 w-4" />
      {children}
    </button>
  );
}

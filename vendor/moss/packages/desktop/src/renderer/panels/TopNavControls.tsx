// ported-from: packages/desktop/src/renderer/panels/TopNavControls.tsx @ 762abb777
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type JSX
} from 'react';

import { cn } from '@moss/shared/lib/utils';

export type TopNavIconTone = 'default' | 'muted';
export type TopNavIconSize = 'sm' | 'md';

export const TOP_NAV_ICON_BUTTON_BASE_CLASSNAME =
  'flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded transition-colors focus-visible:outline-none disabled:cursor-default disabled:opacity-30';

export const TOP_NAV_ICON_BUTTON_TONE_CLASSNAMES: Record<TopNavIconTone, string> = {
  default: 'text-ink-default hover:bg-surface-note-hover/40',
  muted: 'text-ink-faint hover:text-ink-muted hover:bg-surface-note-hover/40'
};

export const TOP_NAV_ICON_SIZE_CLASSNAMES: Record<TopNavIconSize, string> = {
  sm: 'h-3.5 w-3.5',
  md: 'h-4 w-4'
};

export type TopNavBarTone = 'primary' | 'focusedSplit' | 'inactiveSplit';

export const TOP_NAV_BAR_BASE_CLASSNAME =
  'relative z-10 shrink-0 border-b border-border-subtle/30 px-panel-inset pt-panel-drag-top pb-1';

export const TOP_NAV_BAR_TONE_CLASSNAMES: Record<TopNavBarTone, string> = {
  primary: 'bg-ink-inverse/95',
  focusedSplit: 'bg-ink-inverse/95',
  inactiveSplit: 'cursor-pointer bg-ink-inverse/95'
};

export interface TopNavIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tone?: TopNavIconTone;
}

export const TopNavIconButton = forwardRef<HTMLButtonElement, TopNavIconButtonProps>(
  ({ className, tone = 'muted', type = 'button', ...props }, ref): JSX.Element => (
    <button
      ref={ref}
      type={type}
      className={cn(
        TOP_NAV_ICON_BUTTON_BASE_CLASSNAME,
        TOP_NAV_ICON_BUTTON_TONE_CLASSNAMES[tone],
        className
      )}
      {...props}
    />
  )
);

TopNavIconButton.displayName = 'TopNavIconButton';

export interface TopNavBarProps extends HTMLAttributes<HTMLDivElement> {
  tone: TopNavBarTone;
  appRegion?: 'drag' | 'no-drag';
}

export function TopNavBar({
  className,
  tone,
  appRegion,
  style,
  ...props
}: TopNavBarProps): JSX.Element {
  return (
    <div
      className={cn(TOP_NAV_BAR_BASE_CLASSNAME, TOP_NAV_BAR_TONE_CLASSNAMES[tone], className)}
      style={{ ...style, WebkitAppRegion: appRegion } as CSSProperties}
      {...props}
    />
  );
}

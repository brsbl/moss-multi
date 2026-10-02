// ported-from: packages/desktop/src/renderer/editor/preview/SharedLivePreviewControls.tsx @ 762abb777
import type React from 'react';
import type { JSX, ReactNode } from 'react';
import { ExternalLink, TvMinimalPlay } from 'lucide-react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';

export interface SharedLivePreviewBadgeProps {
  onActivate: (event: React.MouseEvent) => void;
  onDoubleClick?: (event: React.MouseEvent) => void;
  dataAttributes?: Record<string, string>;
}

export function SharedLivePreviewBadge({
  onActivate,
  onDoubleClick,
  dataAttributes
}: SharedLivePreviewBadgeProps): JSX.Element {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="moss-live-preview-badge pointer-events-auto inline-flex cursor-pointer items-center gap-1 rounded border border-highlight-chalk-grey bg-highlight-chalk-grey-light px-1.5 py-0.5 text-[10px] font-medium text-ink-muted shadow-sm"
            onClick={onActivate}
            onDoubleClick={onDoubleClick}
            {...dataAttributes}
          >
            <TvMinimalPlay className="h-3 w-3" />
            Live
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" sideOffset={6}>
          Click for live preview
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface SharedLivePreviewActivationOverlayProps extends SharedLivePreviewBadgeProps {
  ariaLabel: string;
  badgePositionClassName?: string;
}

export function SharedLivePreviewActivationOverlay({
  ariaLabel,
  badgePositionClassName = 'bottom-2 left-2',
  onActivate,
  onDoubleClick,
  dataAttributes
}: SharedLivePreviewActivationOverlayProps): JSX.Element {
  return (
    <>
      <button
        type="button"
        onClick={onActivate}
        onDoubleClick={onDoubleClick}
        className="absolute inset-x-0 bottom-0 top-9 z-10 cursor-pointer bg-surface-transparent"
        aria-label={ariaLabel}
        {...dataAttributes}
      />
      <div className={`pointer-events-none absolute z-20 ${badgePositionClassName}`}>
        <SharedLivePreviewBadge
          onActivate={onActivate}
          onDoubleClick={onDoubleClick}
          dataAttributes={dataAttributes}
        />
      </div>
    </>
  );
}

export interface SharedPreviewFallbackProps {
  title?: string;
  message: string;
  action?: ReactNode;
  dataAttributes?: Record<string, string>;
}

export function SharedPreviewFallback({
  title,
  message,
  action,
  dataAttributes
}: SharedPreviewFallbackProps): JSX.Element {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-surface-canvas px-6 text-center"
      {...dataAttributes}
    >
      <div className="space-y-1">
        {title ? (
          <p className="text-sm font-semibold text-ink-default">{title}</p>
        ) : null}
        <p className="text-xs text-ink-muted">{message}</p>
      </div>
      {action}
    </div>
  );
}

export function SharedOpenInBrowserButton({
  onClick
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised-card px-3 py-1.5 text-xs font-medium text-ink-default transition-colors hover:bg-surface-canvas"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      Open in browser
    </button>
  );
}

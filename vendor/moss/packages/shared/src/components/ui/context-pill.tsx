// ported-from: packages/shared/src/components/ui/context-pill.tsx @ 762abb777
import { X } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

interface ContextPillProps {
  /** The full text to display (truncated if over 50 chars) */
  text: string;
  /** Optional icon to show before the text, for browser-selected context. */
  iconUrl?: string | null;
  /** Accessible label for the optional icon. */
  iconAlt?: string;
  /** Called when the remove button is clicked */
  onRemove: () => void;
  /** Optional custom truncation length (default: 50) */
  maxLength?: number;
}

/**
 * ContextPill displays a truncated text snippet with a tooltip showing the full text.
 * Used to show selected text context in the prompt box.
 */
export function ContextPill({ text, iconUrl = null, iconAlt = 'Context source', onRemove, maxLength = 50 }: ContextPillProps) {
  const needsTruncation = text.length > maxLength;
  const displayText = needsTruncation ? `${text.slice(0, maxLength)}...` : text;

  const pillContent = (
    <div className="inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-md bg-ink-default/5 px-1.5 py-0.5 text-ink-default transition-colors hover:bg-ink-default/10 sm:max-w-xs">
      {iconUrl ? (
        <img
          src={iconUrl}
          alt={iconAlt}
          className="h-2.5 w-2.5 shrink-0 rounded-sm"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : null}
      <span className="min-w-0 truncate text-xs text-ink-default">{displayText}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-ink-default/10 hover:text-ink-default focus:outline-none focus:ring-2 focus:ring-ink-default/15 focus:ring-offset-1"
        aria-label="Remove selected text context"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );

  // Only wrap in tooltip if text is truncated
  if (needsTruncation) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{pillContent}</TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return pillContent;
}

export default ContextPill;

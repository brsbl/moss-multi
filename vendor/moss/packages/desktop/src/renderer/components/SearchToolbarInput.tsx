// ported-from: packages/desktop/src/renderer/components/SearchToolbarInput.tsx @ 762abb777
import { useCallback, useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, JSX, RefObject } from 'react';
import { ChevronDown, ChevronUp, X, Search } from 'lucide-react';

export interface SearchToolbarInputProps {
  value: string;
  onValueChange: (value: string) => void;
  matchCount: number;
  currentMatchIndex: number;
  onPreviousMatch: () => void;
  onNextMatch: () => void;
  onClose: () => void;
  placeholder: string;
  ariaLabel: string;
  inputDataAttributes?: Record<string, string | boolean>;
  inputRef?: RefObject<HTMLInputElement | null>;
  autoFocus?: boolean;
  fullWidth?: boolean;
  canNavigateEmptyResults?: boolean;
}

/**
 * Shared Moss search toolbar control.
 *
 * Used by in-note search and browser-page search so both surfaces share the same
 * input, match counter, previous/next controls, close affordance, spacing, and
 * typography tokens. Search target logic stays with each caller.
 */
export function SearchToolbarInput({
  value,
  onValueChange,
  matchCount,
  currentMatchIndex,
  onPreviousMatch,
  onNextMatch,
  onClose,
  placeholder,
  ariaLabel,
  inputDataAttributes,
  inputRef: externalInputRef,
  autoFocus = true,
  fullWidth = false,
  canNavigateEmptyResults = false
}: SearchToolbarInputProps): JSX.Element {
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;

  useEffect(() => {
    if (!autoFocus) return;
    const timeout = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => clearTimeout(timeout);
  }, [autoFocus]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          onPreviousMatch();
        } else {
          onNextMatch();
        }
      }
    },
    [onClose, onNextMatch, onPreviousMatch]
  );

  const counterText =
    matchCount > 0 ? `${currentMatchIndex + 1} of ${matchCount}` : value ? '0 results' : '';
  const canNavigate = matchCount > 0 || (canNavigateEmptyResults && value.trim().length > 0);

  return (
    <div className={`pointer-events-auto flex ${fullWidth ? 'min-w-0 flex-1' : 'shrink-0'}`}>
      <div
        className={`flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-surface-raised-control px-2 shadow-sm${fullWidth ? ' w-full' : ''}`}
        style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
      >
        <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <input
          ref={inputRef}
          type="text"
          role="searchbox"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="min-w-0 flex-1 bg-surface-transparent text-xs text-ink-default outline-none placeholder:text-ink-faint"
          aria-label={ariaLabel}
          {...inputDataAttributes}
        />
        {counterText ? <span className="shrink-0 text-micro text-ink-muted">{counterText}</span> : null}
        <div className="mx-0.5 h-4 w-px bg-border-subtle" />
        <button
          type="button"
          onClick={onPreviousMatch}
          disabled={!canNavigate}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-default transition-colors hover:bg-surface-note-hover/40 disabled:opacity-30"
          aria-label="Previous match"
        >
          <ChevronUp aria-hidden className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onNextMatch}
          disabled={!canNavigate}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-default transition-colors hover:bg-surface-note-hover/40 disabled:opacity-30"
          aria-label="Next match"
        >
          <ChevronDown aria-hidden className="h-4 w-4" />
        </button>
        <div className="mx-0.5 h-4 w-px bg-border-subtle" />
        <button
          type="button"
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-muted"
          aria-label="Close search"
        >
          <X aria-hidden className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export default SearchToolbarInput;

// ported-from: packages/shared/src/components/layout/NotesListPanel.tsx @ 762abb777
import * as React from 'react';
import { Search, X, PanelLeft, Plus } from 'lucide-react';
import { KeyboardShortcut } from '@/components/ui/keyboard-shortcut';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';

export interface NotesListPanelProps {
  className?: string;
  title?: string;
  showTitle?: boolean;
  titleAlign?: 'left' | 'center';
  headerContent?: React.ReactNode;
  onCreateNote?: () => void;
  /** Called when the collapse button is clicked */
  onCollapse?: () => void;
  showSearch?: boolean;
  /** Keep search bar always expanded (no collapse to button) */
  alwaysExpandSearch?: boolean;
  /** Panel variant - affects focus colors */
  variant?: 'default' | 'trash';
  searchValue?: string;
  searchPlaceholder?: string;
  onSearchChange?: (value: string) => void;
  onSearchClear?: () => void;
  /** Called when search bar expands/collapses (focus state) */
  onSearchExpandedChange?: (expanded: boolean) => void;
  /** Called when search input gains or loses focus */
  onSearchFocusChange?: (focused: boolean) => void;
  /** Called when arrow down is pressed in search */
  onSearchArrowDown?: () => void;
  /** Called when arrow up is pressed in search */
  onSearchArrowUp?: () => void;
  /** Called when enter is pressed in search */
  onSearchEnter?: () => void;
  /** Content rendered above the action row (e.g. folder actions) */
  topContent?: React.ReactNode;
  /** Sort dropdown rendered in the top bar between + Note and search */
  sortContent?: React.ReactNode;
  /** Footer content rendered at the bottom of the panel (e.g. Trash, Settings buttons) */
  footerContent?: React.ReactNode;
  children?: React.ReactNode;
}

export interface NotesListPanelHandle {
  focusSearch: () => void;
  blurSearch: () => void;
  /** Expand the search bar without focusing the input */
  expandSearch: () => void;
}

export const NotesListPanel = React.forwardRef<NotesListPanelHandle, NotesListPanelProps>(
  function NotesListPanel(
    {
      className,
      title = 'Notes',
      showTitle = true,
      titleAlign = 'left',
      headerContent,
      onCreateNote,
      onCollapse,
      showSearch = true,
      alwaysExpandSearch = false,
      topContent,
      sortContent,
      variant: _variant = 'default',
      searchValue,
      searchPlaceholder = 'Search notes...',
      onSearchChange,
      onSearchClear,
      onSearchExpandedChange,
      onSearchFocusChange,
      onSearchArrowDown,
      onSearchArrowUp,
      onSearchEnter,
      footerContent,
      children
    },
    ref
  ) {
    const searchInputRef = React.useRef<HTMLInputElement>(null);
    const pendingSearchFocusRef = React.useRef(false);
    const [isSearchExpanded, setIsSearchExpanded] = React.useState(false);

    // Compute effective expanded state for rendering and callbacks
    const effectivelyExpanded = alwaysExpandSearch || isSearchExpanded;

    // Notify parent of initial expanded state on mount (when alwaysExpandSearch is true)
    React.useEffect(() => {
      if (alwaysExpandSearch) {
        onSearchExpandedChange?.(true);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Only run on mount
    }, []);

    const expandSearch = React.useCallback(() => {
      setIsSearchExpanded(true);
      // Notify parent - when expanding, effectivelyExpanded will be true
      onSearchExpandedChange?.(true);
      if (searchInputRef.current) {
        searchInputRef.current.focus();
      } else {
        // Input isn't mounted yet (search was collapsed) — a timer here races
        // React's commit and loses intermittently, so defer to the effect that
        // runs after the expanded input is in the DOM.
        pendingSearchFocusRef.current = true;
      }
    }, [onSearchExpandedChange]);

    React.useEffect(() => {
      if (effectivelyExpanded && pendingSearchFocusRef.current) {
        pendingSearchFocusRef.current = false;
        searchInputRef.current?.focus();
      }
    }, [effectivelyExpanded]);

    const blurSearch = React.useCallback(() => {
      searchInputRef.current?.blur();
      onSearchClear?.();
      onSearchChange?.('');
      setIsSearchExpanded(false);
      // Notify parent - when collapsing, only alwaysExpandSearch keeps it expanded
      onSearchExpandedChange?.(alwaysExpandSearch);
    }, [onSearchClear, onSearchChange, onSearchExpandedChange, alwaysExpandSearch]);

    const expandSearchOnly = React.useCallback(() => {
      setIsSearchExpanded(true);
      onSearchExpandedChange?.(true);
    }, [onSearchExpandedChange]);

    React.useImperativeHandle(ref, () => ({
      focusSearch: expandSearch,
      blurSearch,
      expandSearch: expandSearchOnly
    }), [expandSearch, blurSearch, expandSearchOnly]);

    const handleSearchInput = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        onSearchChange?.(event.target.value);
      },
      [onSearchChange]
    );

    const handleSearchFocus = React.useCallback(() => {
      onSearchFocusChange?.(true);
    }, [onSearchFocusChange]);

    const handleSearchBlur = React.useCallback(() => {
      onSearchFocusChange?.(false);
      // Only collapse if search is empty
      if (!searchValue?.trim()) {
        setIsSearchExpanded(false);
        // Notify parent - when collapsing, only alwaysExpandSearch keeps it expanded
        onSearchExpandedChange?.(alwaysExpandSearch);
      }
    }, [onSearchFocusChange, searchValue, onSearchExpandedChange, alwaysExpandSearch]);

    const handleSearchKeyDown = React.useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault();
            onSearchArrowDown?.();
            break;
          case 'ArrowUp':
            event.preventDefault();
            onSearchArrowUp?.();
            break;
          case 'Enter':
            event.preventDefault();
            onSearchEnter?.();
            break;
          case 'Escape':
            event.preventDefault();
            blurSearch();
            break;
        }
      },
      [onSearchArrowDown, onSearchArrowUp, onSearchEnter, blurSearch]
    );

    const handleClearSearch = React.useCallback(() => {
      onSearchClear?.();
      onSearchChange?.('');
      setIsSearchExpanded(false);
      // Notify parent - when collapsing, only alwaysExpandSearch keeps it expanded
      onSearchExpandedChange?.(alwaysExpandSearch);
    }, [onSearchClear, onSearchChange, onSearchExpandedChange, alwaysExpandSearch]);

  return (
    <section
      data-notes-panel
      className={cn(
        'group flex h-full min-w-0 w-full flex-col overflow-hidden rounded-l-xl border-r border-border-subtle/50 bg-surface-notes-list shadow-surface',
        className
      )}
    >
      {/* Row 1: drag region + collapse icon */}
      <div
        className="shrink-0 border-b border-border-subtle/30 px-panel-inset pt-panel-drag-top pb-1"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex h-8 items-center justify-end">
          {onCollapse && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onCollapse}
                    className="flex h-7 w-7 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
                    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                    aria-label="Hide notes panel"
                  >
                    <PanelLeft className="h-4 w-4 -translate-y-px" strokeWidth={1.5} aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <KeyboardShortcut keys={['⌘', '\\']} size="compact" />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>

      {/* Content area — overflow-hidden so flex-1 children are height-constrained */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-notes-list">
        {showTitle && !headerContent ? (
          <div className="shrink-0 bg-surface-notes-list px-panel-inset pt-4">
            <div
              className={cn(
                'flex items-center text-sm font-light text-ink-muted',
                titleAlign === 'center' ? 'justify-center text-center' : 'justify-start',
                titleAlign === 'center' ? 'w-full' : ''
              )}
            >
              <span className="text-sm">{title}</span>
            </div>
          </div>
        ) : null}

        {/* Action row: search bar OR +Note buttons */}
        <div className="shrink-0 bg-surface-notes-list px-panel-inset pt-panel-section-gap">
          {effectivelyExpanded || searchValue ? (
            /* Expanded search bar */
            <div className="relative">
              <Search aria-hidden strokeWidth={1.5} className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchValue ?? ''}
                onChange={handleSearchInput}
                onFocus={handleSearchFocus}
                onBlur={handleSearchBlur}
                onKeyDown={handleSearchKeyDown}
                placeholder={searchPlaceholder}
                aria-label="Search notes"
                className={cn(
                  "h-9 w-full rounded-lg border border-surface-glass-border bg-surface-glass pl-9 pr-8 text-caption text-ink-default placeholder:text-caption placeholder:text-ink-faint focus:outline-none focus:border-surface-glass-border"
                )}
              />
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink-muted"
                aria-label="Close search"
              >
                <X aria-hidden strokeWidth={1.5} className="h-3 w-3" />
              </button>
            </div>
          ) : (
            /* Collapsed: Action button + Search icon side by side */
            <TooltipProvider>
              <div className="flex min-w-0 items-center gap-3">
                {headerContent}
                {onCreateNote ? (
                  <button
                    type="button"
                    onClick={onCreateNote}
                    className="flex h-9 min-w-0 flex-1 items-center justify-between overflow-hidden rounded-lg border border-surface-glass-border bg-surface-raised-control px-2.5 text-ink-faint shadow-none transition-colors hover:bg-surface-raised-control-hover hover:text-ink-muted focus-visible:outline-none"
                    aria-label="Create new note"
                  >
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium">
                      <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      Note
                    </span>
                    {/* moss-multi seam: hide-registry (A§9) */}
                    {hidden('create-note-shortcut-label') ? null : (
                      <span className="min-w-0 shrink overflow-hidden">
                        <KeyboardShortcut keys={['⌘', 'N']} variant="on-light" size="compact" />
                      </span>
                    )}
                  </button>
                ) : null}
                <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-lg border border-surface-glass-border bg-surface-raised-control px-1 shadow-none">
                  {topContent}
                  {sortContent}
                  {showSearch ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={expandSearch}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none"
                          aria-label="Search notes"
                        >
                          <Search className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <KeyboardShortcut keys={['⌘', 'G']} size="compact" />
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </div>
            </TooltipProvider>
          )}
          <div className="mt-panel-section-gap h-px w-full bg-border-subtle/50" />
        </div>

        <div className="relative min-h-0 flex-1 flex flex-col overflow-hidden bg-surface-notes-list">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pt-panel-section-gap">{children}</div>
          {/* Frosted bottom fade */}
          <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-surface-notes-list to-surface-transparent z-10" />
        </div>
      </div>

      {/* Footer: Trash, Settings, etc. */}
      {footerContent && (
        <div className="shrink-0 border-t border-border-default/40 bg-surface-notes-list px-panel-inset py-2">
          {footerContent}
        </div>
      )}
    </section>
  );
  }
);

export default NotesListPanel;

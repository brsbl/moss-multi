// ported-from: packages/shared/src/components/notes/NoteCard.tsx @ 762abb777
import { Children, cloneElement, isValidElement, type MouseEventHandler, type DragEventHandler, type ReactNode } from 'react';
import { Merge, Pin, PinOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { parseInlineTokens } from '../../lib/markdown-inline';

export interface NoteCardProps {
  id: string;
  title?: string;
  updatedAt: Date | string | number;
  /** Formatted time string (overrides updatedAt formatting) */
  formattedTime?: string;
  isActive?: boolean;
  isSelected?: boolean;
  hasActiveAgent?: boolean;
  isDragging?: boolean;
  /** Hold hover styling while a context menu opened from this card is visible */
  isContextMenuOpen?: boolean;
  draggable?: boolean;
  /** Visual variant */
  variant?: 'default' | 'compact' | 'trash';
  /** Content snippet to display below title (search results) */
  snippet?: string;
  /** Query string to highlight in title and snippet */
  highlightQuery?: string;
  /** Whether to show metadata (time) in compact variant (default true) */
  showMeta?: boolean;
  /** Whether this note is pinned */
  pinned?: boolean;
  /** Callback when pin icon is clicked */
  onTogglePin?: (id: string) => void;
  /** Folder breadcrumb displayed after title (e.g. "Specs /") */
  breadcrumb?: string;
  onSelect?: (id: string) => void;
  onContextMenu?: MouseEventHandler<HTMLElement>;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
}

/**
 * Splits text at case-insensitive query matches and wraps matches in <mark>.
 */
function highlightText(text: string, query: string): ReactNode {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="rounded-sm bg-highlight-search px-0.5 text-ink-default">{part}</mark>
    ) : (
      part
    )
  );
}

/**
 * Recursively walk a React tree and apply highlightText to every string leaf.
 */
function highlightInNodes(nodes: ReactNode[], query: string): ReactNode[] {
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      return <span key={`h${i}`}>{highlightText(node, query)}</span>;
    }
    if (isValidElement<{ children?: ReactNode }>(node) && node.props.children != null) {
      const children = Children.toArray(node.props.children);
      const highlighted = highlightInNodes(children, query);
      return cloneElement(node, { key: `h${i}` }, ...highlighted);
    }
    return node;
  });
}

/**
 * Render a snippet as inline markdown with optional search-term highlighting.
 */
function renderSnippet(text: string, query?: string): ReactNode {
  const tokens = parseInlineTokens(text);
  if (!query) return tokens;
  return highlightInNodes(tokens, query);
}

const formatDate = (date: Date) => {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

export function NoteCard({
  id,
  title,
  updatedAt,
  formattedTime,
  isActive = false,
  isSelected = false,
  hasActiveAgent = false,
  isDragging = false,
  isContextMenuOpen = false,
  draggable = false,
  variant = 'default',
  snippet,
  highlightQuery,
  showMeta = true,
  pinned = false,
  onTogglePin,
  breadcrumb,
  onSelect,
  onContextMenu,
  onDragStart,
  onDragEnd
}: NoteCardProps) {
  const handleClick: MouseEventHandler<HTMLElement> = () => onSelect?.(id);
  const safeTitle = title ?? '';

  const isCompact = variant !== 'default';
  const backgroundClass = (() => {
    if (isActive || isSelected) {
      return variant === 'trash'
        ? 'bg-surface-trash-selected-light'
        : isCompact
          ? 'bg-surface-note-selected/70 opacity-100'
          : 'bg-surface-panel';
    }

    if (isContextMenuOpen) {
      return isCompact ? 'bg-surface-note-hover opacity-100' : 'bg-surface-raised-card';
    }

    return isCompact
      ? 'bg-surface-transparent opacity-80 hover:bg-surface-note-hover hover:opacity-100'
      : 'bg-surface-transparent hover:bg-surface-raised-card';
  })();

  // When searching, if the match is far into the title (would be truncated by CSS),
  // show the title starting near the match so the highlight is always visible
  const displayTitle = (() => {
    if (!highlightQuery || !safeTitle) return safeTitle;
    const matchIdx = safeTitle.toLowerCase().indexOf(highlightQuery.toLowerCase());
    if (matchIdx === -1 || matchIdx < 25) return safeTitle;
    const start = Math.max(0, matchIdx - 10);
    return '...' + safeTitle.slice(start);
  })();

  // Format time: use formattedTime if provided, otherwise format updatedAt
  const displayTime = formattedTime ?? formatDate(
    typeof updatedAt === 'number'
      ? new Date(updatedAt * 1000)
      : typeof updatedAt === 'string'
        ? new Date(updatedAt)
        : updatedAt
  );
  const shouldShowBreadcrumb = Boolean(breadcrumb) && !pinned;

  return (
    <button
      type="button"
      draggable={draggable}
      data-note-active={isActive || undefined}
      data-note-context-menu-open={isContextMenuOpen || undefined}
      data-note-selected={isSelected || undefined}
      onClick={handleClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(id);
        }
      }}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={cn(
        'group/card relative flex w-full cursor-pointer select-none items-start text-left transition-colors',
        isCompact ? `gap-sidebar-row-gap rounded-md px-sidebar-row-x ${!showMeta ? 'py-0.5' : 'py-sidebar-row-y'}` : 'gap-3 rounded-lg px-4 py-3',
        'focus:outline-none',
        backgroundClass,
        isDragging && 'opacity-50'
      )}
    >
      <div className={cn('flex min-w-0 flex-1 flex-col', isCompact ? 'gap-0.5' : 'gap-1')}>
        {isCompact ? (
          /* Compact: simple structure matching original inline rendering */
          <>
            <div className="flex items-center gap-2">
              <span className="truncate text-caption font-book text-ink-default" title={safeTitle}>
                {highlightQuery ? highlightText(displayTitle, highlightQuery) : safeTitle}
              </span>
            </div>
            {snippet && !hasActiveAgent && (
              <span className="line-clamp-2 text-micro text-ink-muted">
                {renderSnippet(snippet, highlightQuery)}
              </span>
            )}
            {hasActiveAgent ? (
              <div className="mb-1 h-3 w-24 animate-pulse rounded bg-accent-brand/15" />
            ) : (
              <>
                {shouldShowBreadcrumb && (
                  <span className="truncate text-micro text-ink-faint" title={breadcrumb}>
                    {breadcrumb}
                  </span>
                )}
                {showMeta && <span className="text-micro font-light text-ink-muted/70">{displayTime}</span>}
              </>
            )}
          </>
        ) : (
          /* Default: richer structure with merge icon support */
          <>
            <div className="flex items-center gap-2 text-base font-normal leading-tight text-ink-default">
              <span className="truncate" title={safeTitle}>
                {safeTitle.includes(' + ') ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {safeTitle.split(' + ').map((part, index, arr) => (
                      <span key={index} className="flex items-center gap-1.5">
                        <span>{part}</span>
                        {index < arr.length - 1 && (
                          <Merge className="h-3 w-3 flex-shrink-0 text-ink-subtle" aria-hidden />
                        )}
                      </span>
                    ))}
                  </span>
                ) : (
                  safeTitle
                )}
              </span>
            </div>
            {hasActiveAgent
              ? <div className="h-3 w-24 animate-pulse rounded bg-accent-brand/15" />
              : <span className="text-xs text-ink-subtle">{displayTime}</span>
            }
          </>
        )}
      </div>
      {/* Right-side pin/unpin — appears on hover */}
      {onTogglePin && (
        <div
          aria-label={pinned ? 'Unpin note' : 'Pin note'}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin(id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onTogglePin(id);
            }
          }}
          className={cn(
            'flex-shrink-0 self-center transition-opacity cursor-pointer p-0.5 opacity-0 group-hover/card:opacity-100',
            'text-ink-muted',
            pinned && 'hover:text-status-error-text',
            isContextMenuOpen && 'opacity-100'
          )}
        >
          {pinned ? <PinOff className="h-3 w-3" aria-hidden /> : <Pin className="h-3 w-3" aria-hidden />}
        </div>
      )}
    </button>
  );
}

export default NoteCard;

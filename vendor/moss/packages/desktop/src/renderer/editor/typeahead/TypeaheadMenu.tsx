// ported-from: packages/desktop/src/renderer/editor/typeahead/TypeaheadMenu.tsx @ 762abb777
/**
 * Shared typeahead menu component for @ mentions, [[ file links, / commands
 */
import { useCallback, useEffect, useRef, forwardRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { TypeaheadItem, TypeaheadPosition } from './types';
import { TYPEAHEAD_DEFAULTS } from './types';

export interface TypeaheadMenuProps<T extends TypeaheadItem> {
  items: T[];
  selectedIndex: number;
  position: TypeaheadPosition;
  onSelect: (item: T) => void;
  onClose: () => void;
  /** Custom item renderer - receives item and selection state */
  renderItem?: (item: T, isSelected: boolean, index: number) => React.ReactNode;
  /** Message shown when query is empty */
  emptyQueryMessage?: string;
  /** Message shown when no results match */
  noResultsMessage?: string;
  /** Menu width in pixels */
  width?: number;
  /** Max menu height in pixels */
  maxHeight?: number;
  /** Approximate height of each item for position calculations */
  itemHeight?: number;
  /** Whether query is empty (for choosing which message to show) */
  isQueryEmpty?: boolean;
  /** Additional class names for the menu container */
  className?: string;
  /** Render in normal document flow instead of a fixed-position portal */
  inline?: boolean;
  /** Custom footer content rendered below results (e.g. connected folders) */
  footer?: React.ReactNode;
}

type TypeaheadMenuComponent = <T extends TypeaheadItem>(
  props: TypeaheadMenuProps<T> & { ref?: React.Ref<HTMLDivElement> }
) => React.ReactElement | null;

function TypeaheadMenuInner<T extends TypeaheadItem>(
  {
    items,
    selectedIndex,
    position,
    onSelect,
    onClose,
    renderItem,
    emptyQueryMessage = 'Type to search...',
    noResultsMessage = 'No results found',
    width = TYPEAHEAD_DEFAULTS.width,
    maxHeight = TYPEAHEAD_DEFAULTS.maxHeight,
    itemHeight = TYPEAHEAD_DEFAULTS.itemHeight,
    isQueryEmpty = false,
    className,
    inline = false,
    footer
  }: TypeaheadMenuProps<T>,
  ref: React.ForwardedRef<HTMLDivElement>
) {
  const localRef = useRef<HTMLDivElement>(null);
  const menuRef = ref || localRef;

  // Scroll selected item into view when selection changes
  useEffect(() => {
    const menu = typeof menuRef === 'function' ? null : menuRef?.current;
    if (!menu) return;
    const selectedItem = menu.querySelector(`[data-index="${selectedIndex}"]`);
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex, menuRef]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const menu = typeof menuRef === 'function' ? null : menuRef?.current;
      if (menu && !menu.contains(event.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, menuRef]);

  // Calculate position with flip-up logic
  // Accounts for floating toolbar at bottom of editor
  const adjustedPosition = useMemo(() => {
    const menuHeight =
      items.length > 0
        ? Math.min(items.length * itemHeight + 8, maxHeight)
        : TYPEAHEAD_DEFAULTS.emptyHeight;

    // Account for floating toolbar at bottom (bottom-6 = 24px + ~32px toolbar height)
    const availableHeight = window.innerHeight - TYPEAHEAD_DEFAULTS.bottomToolbarHeight;
    const spaceBelow = availableHeight - position.top;
    const shouldFlipUp = spaceBelow < menuHeight + 16;

    return {
      top: shouldFlipUp ? position.top - menuHeight - TYPEAHEAD_DEFAULTS.menuOffsetY * 2 : position.top,
      left: Math.max(8, Math.min(position.left, window.innerWidth - width - 8))
    };
  }, [position, items.length, itemHeight, maxHeight, width]);

  const handleItemClick = useCallback(
    (item: T) => {
      onSelect(item);
    },
    [onSelect]
  );

  const menuStyle = useMemo(
    () => inline
      ? {}
      : {
        top: adjustedPosition.top,
        left: adjustedPosition.left,
        width
      },
    [inline, adjustedPosition, width]
  );

  // Default item renderer
  const defaultRenderItem = useCallback(
    (item: T, isSelected: boolean, index: number) => {
      const Icon = item.icon;
      return (
        <button
          key={item.id}
          type="button"
          data-index={index}
          className={[
            'flex w-full items-center gap-2 px-2.5 py-1 text-left text-xs transition-colors',
            isSelected ? 'bg-accent-brand/10 text-accent-brand-pressed' : 'text-ink-default hover:bg-surface-canvas'
          ].join(' ')}
          onClick={() => handleItemClick(item)}
          onMouseDown={(e) => e.preventDefault()}
        >
          {Icon && <Icon className="h-3 w-3 flex-shrink-0 text-ink-muted" />}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate font-medium">{item.label}</span>
            {item.description && (
              <span className="truncate text-micro text-ink-muted">{item.description}</span>
            )}
          </div>
        </button>
      );
    },
    [handleItemClick]
  );

  // Group items by category when multiple distinct categories exist
  const groupedSections = useMemo(() => {
    const categories = new Set(items.map((item) => item.category).filter(Boolean));
    if (categories.size <= 1) return null;

    const groups: { category: string; items: { item: T; flatIndex: number }[] }[] = [];
    const seen = new Map<string, { category: string; items: { item: T; flatIndex: number }[] }>();

    items.forEach((item, flatIndex) => {
      const cat = item.category || '';
      let group = seen.get(cat);
      if (!group) {
        group = { category: cat, items: [] };
        seen.set(cat, group);
        groups.push(group);
      }
      group.items.push({ item, flatIndex });
    });

    return groups;
  }, [items]);

  const baseClasses = inline
    ? 'flex flex-col rounded-lg border border-border-subtle bg-surface-canvas shadow-sm mt-2'
    : 'fixed z-typeahead flex flex-col rounded-lg border border-border-subtle bg-surface-canvas shadow-lg';
  const menuClasses = className ? `${baseClasses} ${className}` : baseClasses;

  const renderItemElement = useCallback(
    (item: T, isSelected: boolean, index: number) => (
      <li key={item.id} data-index={index}>
        {renderItem ? renderItem(item, isSelected, index) : defaultRenderItem(item, isSelected, index)}
      </li>
    ),
    [renderItem, defaultRenderItem]
  );

  const content = (
    <div
      ref={menuRef as React.RefObject<HTMLDivElement>}
      className={menuClasses}
      style={menuStyle}
    >
      <div className="overflow-y-auto typeahead-scroll" style={{ maxHeight }}>
        {items.length === 0 ? (
          <div className="px-3 py-2 text-small text-ink-muted">
            {isQueryEmpty ? emptyQueryMessage : noResultsMessage}
          </div>
        ) : groupedSections ? (
          <ul className="py-1">
            {groupedSections.map((section) => {
              const headingId = `typeahead-group-${section.category}`;
              return (
                <li key={section.category} role="presentation">
                  <div
                    id={headingId}
                    className="px-3 pb-0.5 pt-1.5 text-micro font-medium uppercase tracking-wide text-ink-faint"
                  >
                    {section.category}
                  </div>
                  <ul role="group" aria-labelledby={headingId}>
                    {section.items.map(({ item, flatIndex }) =>
                      renderItemElement(item, flatIndex === selectedIndex, flatIndex)
                    )}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <ul className="py-1">
            {items.map((item, index) => renderItemElement(item, index === selectedIndex, index))}
          </ul>
        )}
      </div>
      {footer}
    </div>
  );

  if (inline) return content;
  return createPortal(content, document.body);
}

// Use type assertion for forwardRef with generics
export const TypeaheadMenu = forwardRef(TypeaheadMenuInner) as TypeaheadMenuComponent;

export default TypeaheadMenu;

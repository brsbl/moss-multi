// ported-from: packages/desktop/src/renderer/editor/slash-commands/SlashCommandPlugin.tsx @ 762abb777
import { useCallback, useMemo } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, TextNode } from 'lexical';

import { useTypeahead, TypeaheadMenu, type TypeaheadItem } from '../typeahead';
import { DEFAULT_SLASH_COMMANDS, filterCommands, groupCommandsByCategory } from './registry';
import type { SlashCommand, SlashCommandCategory } from './types';
import { CATEGORY_LABELS } from './types';
import { $filterSlashCommandsForNestedContent } from './nested-content';

const TRIGGER_CHAR = '/';

// Height of each command item for position calculations
const MENU_ITEM_HEIGHT = 56;
// Extra height for category headers
const CATEGORY_HEADER_HEIGHT = 28;

// Extend TypeaheadItem for slash commands
interface SlashCommandTypeaheadItem extends TypeaheadItem {
  command: SlashCommand;
  isFirstInCategory?: boolean;
  categoryLabel?: string;
}

function commandToTypeaheadItem(
  command: SlashCommand,
  isFirstInCategory: boolean,
  categoryLabel?: string
): SlashCommandTypeaheadItem {
  return {
    id: command.id,
    label: command.label,
    description: command.description,
    icon: command.icon,
    command,
    isFirstInCategory,
    categoryLabel
  };
}

type SlashCommandPluginProps = {
  commands?: SlashCommand[];
  noteId?: string;
};

export function SlashCommandPlugin({ commands = DEFAULT_SLASH_COMMANDS, noteId }: SlashCommandPluginProps) {
  const [editor] = useLexicalComposerContext();

  // Search handler - filter commands and convert to typeahead items with category info
  const handleSearch = useCallback(
    (query: string): SlashCommandTypeaheadItem[] => {
      let available = commands;
      editor.getEditorState().read(() => {
        available = $filterSlashCommandsForNestedContent(commands);
      });
      const filtered = filterCommands(available, query);
      const grouped = groupCommandsByCategory(filtered);

      const items: SlashCommandTypeaheadItem[] = [];
      for (const [category, categoryCommands] of grouped) {
        categoryCommands.forEach((cmd, index) => {
          items.push(
            commandToTypeaheadItem(
              cmd,
              index === 0,
              index === 0 ? CATEGORY_LABELS[category as SlashCommandCategory] : undefined
            )
          );
        });
      }

      return items;
    },
    [commands, editor]
  );

  // Selection handler - remove trigger text and execute command
  const handleSelect = useCallback(
    (item: SlashCommandTypeaheadItem, triggerOffset: number) => {
      const command = item.command;

      // First, remove the slash and query text
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const node = anchor.getNode();

        if (!(node instanceof TextNode)) return;

        const offset = anchor.offset;

        // Select and delete the slash command text (from trigger to cursor)
        selection.anchor.set(node.getKey(), triggerOffset, 'text');
        selection.focus.set(node.getKey(), offset, 'text');
        selection.removeText();
      });

      // Then execute the command
      command.execute(editor, { noteId });
    },
    [editor, noteId]
  );

  const {
    isOpen,
    query,
    results,
    selectedIndex,
    position,
    closeMenu,
    selectItem,
    menuRef
  } = useTypeahead<SlashCommandTypeaheadItem>({
    trigger: {
      trigger: TRIGGER_CHAR,
      requireWordBoundary: true,
      closingChars: [' '] // Dismiss menu when space is typed after slash
    },
    onSearch: handleSearch,
    onSelect: handleSelect,
    debounceMs: 0 // Synchronous filtering, no debounce needed
  });

  // Calculate approximate menu height for positioning
  // This accounts for category headers
  const estimatedItemHeight = useMemo(() => {
    if (results.length === 0) return MENU_ITEM_HEIGHT;

    // Count category headers
    const categoryCount = results.filter((r) => r.isFirstInCategory).length;
    const totalHeight = results.length * MENU_ITEM_HEIGHT + categoryCount * CATEGORY_HEADER_HEIGHT;
    return totalHeight / results.length; // Average height per item
  }, [results]);

  if (!isOpen || !position) return null;

  return (
    <TypeaheadMenu
      ref={menuRef}
      items={results}
      selectedIndex={selectedIndex}
      position={position}
      onSelect={selectItem}
      onClose={closeMenu}
      emptyQueryMessage="Type to filter commands..."
      noResultsMessage="No matching commands"
      isQueryEmpty={query.length === 0}
      width={240}
      maxHeight={320}
      itemHeight={estimatedItemHeight}
      renderItem={(item, isSelected, index) => {
        const Icon = item.icon;
        return (
          <>
            {item.isFirstInCategory && item.categoryLabel && (
              <div className="sticky top-0 bg-surface-canvas px-3 py-1.5">
                <span className="text-xs font-medium uppercase tracking-wider text-ink-faint">
                  {item.categoryLabel}
                </span>
              </div>
            )}
            <button
              type="button"
              data-index={index}
              onClick={() => selectItem(item)}
              onMouseDown={(e) => e.preventDefault()}
              className={[
                'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                isSelected ? 'bg-accent-brand/10 text-accent-brand-pressed' : 'text-ink-default hover:bg-surface-panel'
              ].join(' ')}
            >
              <div
                className={[
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
                  isSelected ? 'border-accent-brand/30 bg-accent-brand/10' : 'border-border-subtle bg-surface-canvas'
                ].join(' ')}
              >
                {Icon && (
                  <Icon
                    size={16}
                    className={isSelected ? 'text-accent-brand-pressed' : 'text-ink-muted'}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{item.label}</div>
                {item.description && (
                  <div className="text-xs text-ink-muted">{item.description}</div>
                )}
              </div>
            </button>
          </>
        );
      }}
    />
  );
}

export default SlashCommandPlugin;

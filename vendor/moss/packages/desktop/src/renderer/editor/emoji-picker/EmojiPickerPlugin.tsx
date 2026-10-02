// ported-from: packages/desktop/src/renderer/editor/emoji-picker/EmojiPickerPlugin.tsx @ 762abb777
import { useCallback } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, $createTextNode, TextNode } from 'lexical';

import { useTypeahead, TypeaheadMenu, type TypeaheadItem } from '../typeahead';
import { filterEmojis } from './emoji-data';

const TRIGGER_CHAR = ':';

interface EmojiTypeaheadItem extends TypeaheadItem {
  emoji: string;
}

export function EmojiPickerPlugin() {
  const [editor] = useLexicalComposerContext();

  const handleSearch = useCallback((query: string): EmojiTypeaheadItem[] => {
    const matches = filterEmojis(query);
    return matches.map((entry) => ({
      id: entry.shortcode,
      label: entry.shortcode,
      emoji: entry.emoji
    }));
  }, []);

  const handleSelect = useCallback(
    (item: EmojiTypeaheadItem, triggerOffset: number) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const node = anchor.getNode();

        if (!(node instanceof TextNode)) return;

        const offset = anchor.offset;

        // Select and delete the trigger text (from : to cursor)
        selection.anchor.set(node.getKey(), triggerOffset, 'text');
        selection.focus.set(node.getKey(), offset, 'text');
        selection.removeText();

        // Insert the emoji character
        const emojiNode = $createTextNode(item.emoji);
        selection.insertNodes([emojiNode]);
      });
    },
    [editor]
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
  } = useTypeahead<EmojiTypeaheadItem>({
    trigger: {
      trigger: TRIGGER_CHAR,
      requireWordBoundary: true,
      closingChars: [' ']
    },
    onSearch: handleSearch,
    onSelect: handleSelect,
    debounceMs: 0
  });

  if (!isOpen || !position) return null;

  return (
    <TypeaheadMenu
      ref={menuRef}
      items={results}
      selectedIndex={selectedIndex}
      position={position}
      onSelect={selectItem}
      onClose={closeMenu}
      emptyQueryMessage="Type to search emojis..."
      noResultsMessage="No matching emojis"
      isQueryEmpty={query.length === 0}
      width={220}
      maxHeight={280}
      itemHeight={36}
      renderItem={(item, isSelected, index) => (
        <button
          type="button"
          data-index={index}
          onClick={() => selectItem(item)}
          onMouseDown={(e) => e.preventDefault()}
          className={[
            'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors',
            isSelected ? 'bg-accent-brand/10 text-accent-brand-pressed' : 'text-ink-default hover:bg-surface-panel'
          ].join(' ')}
        >
          <span className="text-lg leading-none">{item.emoji}</span>
          <span className="truncate text-sm">{item.label}</span>
        </button>
      )}
    />
  );
}

export default EmojiPickerPlugin;

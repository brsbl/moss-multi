// ported-from: packages/desktop/src/renderer/panels/useTitleEmojiTypeahead.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { filterEmojis } from '../editor/emoji-picker/emoji-data';
import { TypeaheadMenu, type TypeaheadItem, type TypeaheadPosition } from '../editor/typeahead';

interface TitleEmojiTypeaheadItem extends TypeaheadItem {
  emoji: string;
}

interface TitleEmojiMenuState {
  caretOffset: number;
  position: TypeaheadPosition;
  query: string;
  selectedIndex: number;
  triggerStart: number;
}

interface UseTitleEmojiTypeaheadOptions {
  disabled?: boolean;
  noteId?: string;
  onTitleValueChange: (nextValue: string) => void;
  titleInputRef: { current: HTMLDivElement | null };
}

interface UseTitleEmojiTypeaheadResult {
  closeTitleEmojiMenu: () => void;
  handleTitleEmojiKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => boolean;
  syncTitleEmojiTypeaheadFromSelection: () => void;
  titleEmojiMenu: ReactNode;
}

const TRIGGER_CHAR = ':';
const TITLE_EMOJI_MENU_OFFSET_Y = 4;

const findEmojiTrigger = (
  text: string,
  caretOffset: number
): { query: string; triggerStart: number } | null => {
  const beforeCaret = text.slice(0, caretOffset);
  const match = /(^|\s):([^\s:]*)$/.exec(beforeCaret);
  if (!match) {
    return null;
  }

  const query = match[2] ?? '';
  return {
    query,
    triggerStart: caretOffset - query.length - TRIGGER_CHAR.length
  };
};

const getCollapsedSelectionRange = (container: HTMLDivElement): Range | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentNode;

  if (!commonAncestor || !container.contains(commonAncestor)) {
    return null;
  }

  return range;
};

const getCaretOffsetInContainer = (container: HTMLDivElement, range: Range): number => {
  const caretRange = range.cloneRange();
  caretRange.selectNodeContents(container);
  caretRange.setEnd(range.endContainer, range.endOffset);
  return caretRange.toString().length;
};

const getRangePosition = (range: Range, container: HTMLDivElement): TypeaheadPosition => {
  try {
    if (typeof range.getBoundingClientRect === 'function') {
      const rect = range.getBoundingClientRect();
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return {
          top: rect.bottom + TITLE_EMOJI_MENU_OFFSET_Y,
          left: rect.left
        };
      }
    }
  } catch {
    // JSDOM and some browsers can fail for collapsed ranges; fall back below.
  }

  try {
    if (typeof range.getClientRects === 'function') {
      const rects = range.getClientRects();
      const rect = rects.length > 0 ? rects[0] : null;
      if (rect) {
        return {
          top: rect.bottom + TITLE_EMOJI_MENU_OFFSET_Y,
          left: rect.left
        };
      }
    }
  } catch {
    // Ignore and fall back to container bounds.
  }

  const fallback = container.getBoundingClientRect();
  return {
    top: fallback.bottom + TITLE_EMOJI_MENU_OFFSET_Y,
    left: fallback.left
  };
};

const placeCaretAtOffset = (container: HTMLDivElement, offset: number): void => {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let currentTextNode = walker.nextNode() as Text | null;

  while (currentTextNode) {
    const textLength = currentTextNode.textContent?.length ?? 0;
    if (offset <= traversed + textLength) {
      range.setStart(currentTextNode, Math.max(0, offset - traversed));
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    traversed += textLength;
    currentTextNode = walker.nextNode() as Text | null;
  }

  range.selectNodeContents(container);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
};

export function useTitleEmojiTypeahead({
  disabled = false,
  noteId,
  onTitleValueChange,
  titleInputRef
}: UseTitleEmojiTypeaheadOptions): UseTitleEmojiTypeaheadResult {
  const [menuState, setMenuState] = useState<TitleEmojiMenuState | null>(null);

  const closeTitleEmojiMenu = useCallback(() => {
    setMenuState(null);
  }, []);

  useEffect(() => {
    closeTitleEmojiMenu();
  }, [closeTitleEmojiMenu, noteId]);

  const results = useMemo<TitleEmojiTypeaheadItem[]>(() => {
    if (!menuState) {
      return [];
    }

    return filterEmojis(menuState.query).map((entry) => ({
      id: entry.shortcode,
      label: entry.shortcode,
      emoji: entry.emoji
    }));
  }, [menuState]);

  useEffect(() => {
    if (!menuState || results.length === 0 || menuState.selectedIndex < results.length) {
      return;
    }

    setMenuState((current) =>
      current
        ? {
            ...current,
            selectedIndex: Math.max(0, results.length - 1)
          }
        : current
    );
  }, [menuState, results.length]);

  const insertEmoji = useCallback((item: TitleEmojiTypeaheadItem) => {
    const container = titleInputRef.current;
    const currentMenuState = menuState;
    if (!container || !currentMenuState) {
      return;
    }

    const text = container.textContent ?? '';
    const beforeTrigger = text.slice(0, currentMenuState.triggerStart);
    const afterTrigger = text.slice(currentMenuState.caretOffset);
    const nextText = `${beforeTrigger}${item.emoji}${afterTrigger}`;

    container.textContent = nextText;
    container.focus();
    placeCaretAtOffset(container, beforeTrigger.length + item.emoji.length);
    onTitleValueChange(nextText);
    closeTitleEmojiMenu();
  }, [closeTitleEmojiMenu, menuState, onTitleValueChange, titleInputRef]);

  const syncTitleEmojiTypeaheadFromSelection = useCallback(() => {
    if (disabled) {
      closeTitleEmojiMenu();
      return;
    }

    const container = titleInputRef.current;
    if (!container) {
      closeTitleEmojiMenu();
      return;
    }

    const range = getCollapsedSelectionRange(container);
    if (!range) {
      closeTitleEmojiMenu();
      return;
    }

    const text = container.textContent ?? '';
    const caretOffset = getCaretOffsetInContainer(container, range);
    const trigger = findEmojiTrigger(text, caretOffset);
    if (!trigger) {
      closeTitleEmojiMenu();
      return;
    }

    const position = getRangePosition(range, container);

    setMenuState((current) => ({
      caretOffset,
      position,
      query: trigger.query,
      selectedIndex:
        current &&
        current.query === trigger.query &&
        current.triggerStart === trigger.triggerStart
          ? current.selectedIndex
          : 0,
      triggerStart: trigger.triggerStart
    }));
  }, [closeTitleEmojiMenu, disabled, titleInputRef]);

  const handleTitleEmojiKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    if (!menuState) {
      return false;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeTitleEmojiMenu();
      return true;
    }

    if (results.length === 0) {
      return false;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setMenuState((current) =>
        current
          ? {
              ...current,
              selectedIndex: (current.selectedIndex + 1) % results.length
            }
          : current
      );
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setMenuState((current) =>
        current
          ? {
              ...current,
              selectedIndex:
                (current.selectedIndex - 1 + results.length) % results.length
            }
          : current
      );
      return true;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      insertEmoji(results[menuState.selectedIndex] ?? results[0]);
      return true;
    }

    return false;
  }, [closeTitleEmojiMenu, insertEmoji, menuState, results]);

  const titleEmojiMenu = menuState ? (
    <TypeaheadMenu
      items={results}
      selectedIndex={menuState.selectedIndex}
      position={menuState.position}
      onSelect={insertEmoji}
      onClose={closeTitleEmojiMenu}
      emptyQueryMessage="Type to search emojis..."
      noResultsMessage="No matching emojis"
      isQueryEmpty={menuState.query.length === 0}
      width={220}
      maxHeight={280}
      itemHeight={36}
      renderItem={(item, isSelected, index) => (
        <button
          type="button"
          data-index={index}
          onClick={() => insertEmoji(item)}
          onMouseDown={(event) => event.preventDefault()}
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
  ) : null;

  return {
    closeTitleEmojiMenu,
    handleTitleEmojiKeyDown,
    syncTitleEmojiTypeaheadFromSelection,
    titleEmojiMenu
  };
}

export default useTitleEmojiTypeahead;

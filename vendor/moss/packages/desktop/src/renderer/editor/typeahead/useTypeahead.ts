// ported-from: packages/desktop/src/renderer/editor/typeahead/useTypeahead.ts @ 762abb777
/**
 * Shared hook for typeahead trigger detection and keyboard handling
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type CommandListenerPriority
} from 'lexical';

import type {
  TypeaheadPosition,
  TypeaheadState,
  TypeaheadTriggerConfig,
  TypeaheadItem
} from './types';
import { TYPEAHEAD_DEFAULTS } from './types';

export interface UseTypeaheadOptions<T extends TypeaheadItem> {
  /** Trigger configuration */
  trigger: TypeaheadTriggerConfig;
  /** Search function - called with debouncing */
  onSearch: (query: string) => Promise<T[]> | T[];
  /** Called when an item is selected */
  onSelect: (item: T, triggerOffset: number) => void;
  /**
   * Called on Tab to attempt drilling into a folder/directory.
   * Return a new query string (e.g. "Projects/") to continue searching,
   * or null to fall through to normal select behavior.
   * Receives the current query so consumers can build relative drill paths.
   */
  onDrill?: (item: T, currentQuery: string) => string | null;
  /**
   * Called on Shift+Tab to compute the undrill query.
   * Return the new query string, or null to use the default segment-stripping logic.
   * Useful for absolute-path drills where stripping one segment would traverse
   * above the connected folder root.
   */
  onUndrill?: (currentQuery: string) => string | null;
  /** Debounce delay for search in ms (default: 100) */
  debounceMs?: number;
  /** Command priority for keyboard handlers (default: HIGH) */
  commandPriority?: CommandListenerPriority;
}

export interface UseTypeaheadReturn<T extends TypeaheadItem> {
  /** Whether the menu is currently open */
  isOpen: boolean;
  /** Current search query */
  query: string;
  /** Search results */
  results: T[];
  /** Currently selected index */
  selectedIndex: number;
  /** Menu position (viewport-relative for fixed positioning) */
  position: TypeaheadPosition | null;
  /** Close the menu */
  closeMenu: () => void;
  /** Select an item programmatically */
  selectItem: (item: T) => void;
  /** Ref for the menu element (for scroll management) */
  menuRef: React.RefObject<HTMLDivElement | null>;
}

function getInitialState(): TypeaheadState {
  return {
    isOpen: false,
    query: '',
    selectedIndex: 0,
    position: null,
    triggerOffset: null
  };
}

export function useTypeahead<T extends TypeaheadItem>({
  trigger,
  onSearch,
  onSelect,
  onDrill,
  onUndrill,
  debounceMs = TYPEAHEAD_DEFAULTS.debounceMs,
  commandPriority = COMMAND_PRIORITY_HIGH
}: UseTypeaheadOptions<T>): UseTypeaheadReturn<T> {
  const [editor] = useLexicalComposerContext();
  const [state, setState] = useState<TypeaheadState>(getInitialState);
  const [results, setResults] = useState<T[]>([]);

  const menuRef = useRef<HTMLDivElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRequestIdRef = useRef(0);
  const isMenuInteractingRef = useRef(false);
  // moss-multi seam: live-query-select (T3.F2): the query `results` were searched for.
  const resultsQueryRef = useRef<string | null>(null);

  const closeMenu = useCallback(() => {
    resultsQueryRef.current = null;
    setState(getInitialState());
    setResults([]);
  }, []);

  const selectItem = useCallback(
    (item: T) => {
      if (state.triggerOffset !== null) {
        onSelect(item, state.triggerOffset);
      }
      closeMenu();
    },
    [state.triggerOffset, onSelect, closeMenu]
  );

  // moss-multi seam: live-query-select (T3.F2): a synchronous search (debounce 0) that has not caught up with the
  // text typed after the trigger (its timer waits behind a busy main thread) is run now, so Enter or Tab picks
  // the first match for everything typed, never a row of the previous query's list.
  const liveResults = useCallback((): T[] | null => {
    const start = state.triggerOffset;
    if (debounceMs !== 0 || start === null) return null;
    const live = editor.getEditorState().read((): string | null => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
      const node = selection.anchor.getNode();
      if (!$isTextNode(node)) return null;
      const text = node.getTextContent().slice(0, selection.anchor.offset);
      if (text.lastIndexOf(trigger.trigger) !== start) return null;
      return text.slice(start + trigger.trigger.length);
    });
    if (live === null || live === resultsQueryRef.current) return null;
    if (trigger.closingChars?.some((char) => live.includes(char))) return null;
    const fresh = onSearch(live);
    return Array.isArray(fresh) ? fresh : null;
  }, [debounceMs, editor, onSearch, state.triggerOffset, trigger]);

  const handleSelect = useCallback(() => {
    const fresh = liveResults();
    if (fresh) {
      if (fresh.length === 0) return false;
      selectItem(fresh[0]);
      return true;
    }
    if (results.length > 0 && state.selectedIndex < results.length) {
      selectItem(results[state.selectedIndex]);
      return true;
    }
    return false;
  }, [liveResults, results, state.selectedIndex, selectItem]);

  // Keyboard navigation
  useEffect(() => {
    if (!state.isOpen) return;

    const removeArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        event?.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex: (prev.selectedIndex + 1) % Math.max(1, results.length)
        }));
        return true;
      },
      commandPriority
    );

    const removeArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        event?.preventDefault();
        setState((prev) => ({
          ...prev,
          selectedIndex:
            (prev.selectedIndex - 1 + results.length) % Math.max(1, results.length)
        }));
        return true;
      },
      commandPriority
    );

    const removeEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (handleSelect()) {
          event?.preventDefault();
          return true;
        }
        return false;
      },
      commandPriority
    );

    const removeTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        // Shift+Tab: undrill — use onUndrill callback if provided,
        // otherwise fall back to stripping the last path segment.
        if (event?.shiftKey && state.query.includes('/') && state.triggerOffset !== null) {
          event.preventDefault();
          let newQuery: string;
          const undrillResult = onUndrill?.(state.query);
          if (undrillResult !== undefined && undrillResult !== null) {
            newQuery = undrillResult;
          } else {
            const segments = state.query.split('/').filter(Boolean);
            segments.pop();
            newQuery = segments.length > 0 ? segments.join('/') + '/' : '';
          }
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;
            const anchor = selection.anchor;
            const anchorNode = anchor.getNode();
            if (!$isTextNode(anchorNode)) return;
            const text = anchorNode.getTextContent();
            const beforeTrigger = text.slice(0, state.triggerOffset! + trigger.trigger.length);
            const afterCursor = text.slice(anchor.offset);
            anchorNode.setTextContent(beforeTrigger + newQuery + afterCursor);
            anchorNode.select(
              beforeTrigger.length + newQuery.length,
              beforeTrigger.length + newQuery.length
            );
          });
          return true;
        }

        // Try drilling first: if onDrill returns a new query, replace the
        // text after the trigger character and let the update listener
        // re-detect the query — the menu stays open for further navigation.
        if (onDrill && results.length > 0 && state.selectedIndex < results.length) {
          const item = results[state.selectedIndex];
          const drillQuery = onDrill(item, state.query);
          if (drillQuery !== null && state.triggerOffset !== null) {
            event?.preventDefault();
            editor.update(() => {
              const selection = $getSelection();
              if (!$isRangeSelection(selection)) return;
              const anchor = selection.anchor;
              const anchorNode = anchor.getNode();
              if (!$isTextNode(anchorNode)) return;
              const text = anchorNode.getTextContent();
              const beforeTrigger = text.slice(0, state.triggerOffset! + trigger.trigger.length);
              const afterCursor = text.slice(anchor.offset);
              anchorNode.setTextContent(beforeTrigger + drillQuery + afterCursor);
              anchorNode.select(
                beforeTrigger.length + drillQuery.length,
                beforeTrigger.length + drillQuery.length
              );
            });
            return true;
          }
        }
        // Fall through: select normally (same as Enter)
        if (handleSelect()) {
          event?.preventDefault();
          return true;
        }
        return false;
      },
      commandPriority
    );

    const removeEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        closeMenu();
        return true;
      },
      commandPriority
    );

    return () => {
      removeArrowDown();
      removeArrowUp();
      removeEnter();
      removeTab();
      removeEscape();
    };
  }, [editor, state.isOpen, state.triggerOffset, results, state.selectedIndex, handleSelect, closeMenu, onDrill, onUndrill, trigger, commandPriority]);

  // Listen for text changes to detect trigger.
  // Dirty-gated: trigger detection only matters when content changes (typing),
  // not on selection-only changes (click-to-focus, arrow keys).
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, dirtyLeaves, dirtyElements }) => {
      if (dirtyLeaves.size === 0 && dirtyElements.size === 0) {
        // Selection-only change — close menu if open and selection is invalid
        if (state.isOpen) {
          editorState.read(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
              closeMenu();
            }
          });
        }
        return;
      }

      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          if (state.isOpen) closeMenu();
          return;
        }

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();

        if (!$isTextNode(anchorNode)) {
          if (state.isOpen) closeMenu();
          return;
        }

        // Don't trigger inside inline code (backtick-formatted text)
        if (anchorNode.hasFormat('code')) {
          if (state.isOpen) closeMenu();
          return;
        }

        const textContent = anchorNode.getTextContent();
        const cursorPosition = anchor.offset;
        const textBeforeCursor = textContent.slice(0, cursorPosition);

        // Find trigger
        const triggerIndex = textBeforeCursor.lastIndexOf(trigger.trigger);

        if (triggerIndex === -1) {
          // Hover over menu items can cause transient selection loss — keep
          // menu open if user is actively interacting with it.
          if (state.isOpen && !isMenuInteractingRef.current) closeMenu();
          return;
        }

        // Check word boundary requirement
        const requireBoundary = trigger.requireWordBoundary ?? trigger.trigger.length === 1;
        if (requireBoundary) {
          const charBefore = textBeforeCursor[triggerIndex - 1];
          const hasValidBoundary =
            triggerIndex === 0 || charBefore === ' ' || charBefore === '\t' || charBefore === '\n';
          if (!hasValidBoundary) {
            if (state.isOpen) closeMenu();
            return;
          }
        }

        const textAfterTrigger = textBeforeCursor.slice(triggerIndex + trigger.trigger.length);

        // Check for completion chars (e.g., ]] for file links)
        if (trigger.completionChars && textAfterTrigger.includes(trigger.completionChars)) {
          if (state.isOpen) closeMenu();
          return;
        }

        // Check for closing chars (e.g., space)
        if (trigger.closingChars?.some((char) => textAfterTrigger.includes(char))) {
          if (state.isOpen) closeMenu();
          return;
        }

        // Calculate position (viewport-relative for fixed positioning)
        const nativeSelection = window.getSelection();
        if (!nativeSelection || nativeSelection.rangeCount === 0) {
          return;
        }

        const range = nativeSelection.getRangeAt(0);
        const cursorRect = range.getBoundingClientRect();

        // We'll calculate final position in the menu component based on available space
        setState({
          isOpen: true,
          query: textAfterTrigger,
          selectedIndex: 0,
          position: {
            top: cursorRect.bottom + TYPEAHEAD_DEFAULTS.menuOffsetY,
            left: cursorRect.left
          },
          triggerOffset: triggerIndex
        });
      });
    });
  }, [editor, trigger, state.isOpen, closeMenu]);

  // Debounced search
  useEffect(() => {
    if (!state.isOpen) return;

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // In visual-snapshot mode the debounce is suppressed so typeahead results
    // appear deterministically (no race between keystroke + timer + IPC).
    const effectiveDebounce =
      typeof document !== 'undefined' &&
      document.documentElement.getAttribute('data-moss-snapshot') === 'true'
        ? 0
        : debounceMs;

    searchTimeoutRef.current = setTimeout(async () => {
      const requestId = ++searchRequestIdRef.current;
      try {
        const searchResults = await onSearch(state.query);
        if (requestId !== searchRequestIdRef.current) return;
        resultsQueryRef.current = state.query;
        setResults(searchResults);
        setState((prev) => ({ ...prev, selectedIndex: 0 }));
      } catch {
        setResults([]);
      }
    }, effectiveDebounce);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      searchRequestIdRef.current += 1;
    };
  }, [state.isOpen, state.query, onSearch, debounceMs]);

  // Track mouse interaction with the menu to prevent premature closing
  useEffect(() => {
    const menu = menuRef.current;
    if (!state.isOpen || !menu) return;

    const onEnter = () => { isMenuInteractingRef.current = true; };
    const onLeave = () => { isMenuInteractingRef.current = false; };

    menu.addEventListener('pointerenter', onEnter);
    menu.addEventListener('pointerleave', onLeave);
    return () => {
      menu.removeEventListener('pointerenter', onEnter);
      menu.removeEventListener('pointerleave', onLeave);
      isMenuInteractingRef.current = false;
    };
  }, [state.isOpen]);

  return {
    isOpen: state.isOpen,
    query: state.query,
    results,
    selectedIndex: state.selectedIndex,
    position: state.position,
    closeMenu,
    selectItem,
    menuRef
  };
}

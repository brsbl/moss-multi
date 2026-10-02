// ported-from: packages/desktop/src/renderer/editor/plugins/TableActionMenuPlugin.tsx @ 762abb777
/**
 * TableActionMenuPlugin - Floating action button for table operations
 *
 * Displays a chevron button at the top-right corner of the selected table
 * cell. Clicking opens a dropdown menu with row/column operations.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { commentInputStateAtom } from './CommentPlugin';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $deleteTableColumn__EXPERIMENTAL,
  $deleteTableRow__EXPERIMENTAL,
  $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $insertTableColumn__EXPERIMENTAL,
  $insertTableRow__EXPERIMENTAL,
  $isTableNode,
  $isTableSelection
} from '@lexical/table';
import {
  $getNodeByKey,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isRangeSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND
} from 'lexical';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Plus
} from 'lucide-react';
import {
  getTableResizeHandlesVisible,
  subscribeTableResizeHandlesVisible
} from './tableUiState';
import { getTableUiOwnerId } from './tableUiOwner';

const TABLE_ACTION_BUTTON_SIZE_PX = 20;
const TABLE_ACTION_BUTTON_MARGIN_PX = 4;
const TABLE_ACTION_BUTTON_RESIZE_MARGIN_PX = 16;
const TABLE_ACTION_MENU_WIDTH_PX = 192;
const TABLE_ACTION_MENU_MAX_HEIGHT_PX = 320;
const TABLE_ACTION_MENU_VIEWPORT_MARGIN_PX = 8;

type MenuPosition = { top: number; left: number };
type MenuOpener = 'button' | 'editor';

export const getVisibleCellActionButtonPosition = (
  cellRect: DOMRect,
  editorRect: DOMRect,
  rightMargin = TABLE_ACTION_BUTTON_MARGIN_PX
): { top: number; left: number } | null => {
  const visibleTop = Math.max(cellRect.top, editorRect.top);
  const visibleBottom = Math.min(cellRect.bottom, editorRect.bottom);
  const visibleLeft = Math.max(cellRect.left, editorRect.left);
  const visibleRight = Math.min(cellRect.right, editorRect.right);

  if (
    visibleBottom - visibleTop < TABLE_ACTION_BUTTON_SIZE_PX ||
    visibleRight - visibleLeft < TABLE_ACTION_BUTTON_SIZE_PX
  ) {
    return null;
  }

  return {
    top: visibleTop + TABLE_ACTION_BUTTON_MARGIN_PX,
    left: visibleRight - TABLE_ACTION_BUTTON_SIZE_PX - rightMargin
  };
};

export const getTableContextMenuPosition = (
  clientX: number,
  clientY: number,
  viewportWidth: number,
  viewportHeight = window.innerHeight
): MenuPosition => ({
  top: Math.max(
    TABLE_ACTION_MENU_VIEWPORT_MARGIN_PX,
    Math.min(
      clientY,
      viewportHeight - TABLE_ACTION_MENU_MAX_HEIGHT_PX - TABLE_ACTION_MENU_VIEWPORT_MARGIN_PX
    )
  ),
  left: Math.max(
    TABLE_ACTION_MENU_VIEWPORT_MARGIN_PX,
    Math.min(
      clientX,
      viewportWidth - TABLE_ACTION_MENU_WIDTH_PX - TABLE_ACTION_MENU_VIEWPORT_MARGIN_PX
    )
  )
});

type TableActionMenuProps = {
  tableNodeKey: string;
  onClose: (restoreFocus?: boolean) => void;
  ownerId: string;
  position: MenuPosition;
  anchorRef?: React.RefObject<HTMLButtonElement | null>;
};

function TableActionMenu({
  tableNodeKey,
  onClose,
  ownerId,
  position,
  anchorRef
}: TableActionMenuProps): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dropdownRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        (!anchorRef?.current || !anchorRef.current.contains(event.target as Node))
      ) {
        onClose(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, anchorRef]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose(true);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const insertRowAbove = useCallback(() => {
    editor.update(() => {
      $insertTableRow__EXPERIMENTAL(false);
    });
    onClose(true);
  }, [editor, onClose]);

  const insertRowBelow = useCallback(() => {
    editor.update(() => {
      $insertTableRow__EXPERIMENTAL(true);
    });
    onClose(true);
  }, [editor, onClose]);

  const insertColumnLeft = useCallback(() => {
    editor.update(() => {
      $insertTableColumn__EXPERIMENTAL(false);
    });
    onClose(true);
  }, [editor, onClose]);

  const insertColumnRight = useCallback(() => {
    editor.update(() => {
      $insertTableColumn__EXPERIMENTAL(true);
    });
    onClose(true);
  }, [editor, onClose]);

  const deleteRow = useCallback(() => {
    editor.update(() => {
      $deleteTableRow__EXPERIMENTAL();
    });
    onClose(true);
  }, [editor, onClose]);

  const deleteColumn = useCallback(() => {
    editor.update(() => {
      $deleteTableColumn__EXPERIMENTAL();
    });
    onClose(true);
  }, [editor, onClose]);

  const deleteTable = useCallback(() => {
    editor.update(() => {
      const tableNode = $getNodeByKey(tableNodeKey);
      if ($isTableNode(tableNode)) {
        tableNode.remove();
      }
    });
    onClose(true);
  }, [editor, onClose, tableNodeKey]);

  const menuContent = (
    <div
      ref={dropdownRef}
      role="menu"
      aria-label="Table controls"
      data-table-action-menu-owner={ownerId}
      data-moss-table-ui-owner={ownerId}
      className="fixed z-50 w-48 rounded-lg border border-border-subtle bg-surface-canvas py-1 shadow-lg"
      style={{ top: position.top, left: position.left }}
      onKeyDown={(event) => {
        const items = Array.from(
          dropdownRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []
        );
        if (items.length === 0) {
          return;
        }
        const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
        let nextIndex: number | null = null;

        if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
        if (event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = items.length - 1;
        if (event.key === 'Tab') {
          event.preventDefault();
          onClose(true);
        }

        if (nextIndex !== null && items[nextIndex]) {
          event.preventDefault();
          items[nextIndex].focus();
        }
      }}
    >
      <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
        Row
      </div>
      <button
        type="button"
        role="menuitem"
        onClick={insertRowAbove}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-ink-default hover:bg-surface-panel"
      >
        <Plus size={14} className="text-ink-muted" />
        <ChevronUp size={14} className="text-ink-muted" />
        Insert above
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={insertRowBelow}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-ink-default hover:bg-surface-panel"
      >
        <Plus size={14} className="text-ink-muted" />
        <ChevronDown size={14} className="text-ink-muted" />
        Insert below
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={deleteRow}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-status-error-text-submitted hover:bg-status-error-surface"
      >
        <Trash2 size={14} />
        Delete row
      </button>

      <div className="my-1 border-t border-border-subtle" />

      <div className="px-2 py-1 text-xs font-medium uppercase tracking-wider text-ink-faint">
        Column
      </div>
      <button
        type="button"
        role="menuitem"
        onClick={insertColumnLeft}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-ink-default hover:bg-surface-panel"
      >
        <Plus size={14} className="text-ink-muted" />
        <ChevronLeft size={14} className="text-ink-muted" />
        Insert left
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={insertColumnRight}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-ink-default hover:bg-surface-panel"
      >
        <Plus size={14} className="text-ink-muted" />
        <ChevronRight size={14} className="text-ink-muted" />
        Insert right
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={deleteColumn}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-status-error-text-submitted hover:bg-status-error-surface"
      >
        <Trash2 size={14} />
        Delete column
      </button>

      <div className="my-1 border-t border-border-subtle" />

      <button
        type="button"
        role="menuitem"
        onClick={deleteTable}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-status-error-text-submitted hover:bg-status-error-surface"
      >
        <Trash2 size={14} />
        Delete table
      </button>
    </div>
  );

  return createPortal(menuContent, document.body);
}

/**
 * Plugin that provides a floating action button for table row/column operations.
 * The button appears at the top-right corner of the selected table cell.
 */
export function TableActionMenuPlugin({ noteId }: { noteId: string }): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const ownerId = getTableUiOwnerId(editor);
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [tableNodeKey, setTableNodeKey] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const commentInputState = useAtomValue(commentInputStateAtom(noteId));
  const [buttonPosition, setButtonPosition] = useState<{ top: number; left: number } | null>(null);
  const subscribeResizeHandlesVisible = useCallback(
    (listener: () => void) => subscribeTableResizeHandlesVisible(ownerId, listener),
    [ownerId]
  );
  const getResizeHandlesVisible = useCallback(
    () => getTableResizeHandlesVisible(ownerId),
    [ownerId]
  );
  const resizeHandlesVisible = useSyncExternalStore(
    subscribeResizeHandlesVisible,
    getResizeHandlesVisible,
    getResizeHandlesVisible
  );

  const buttonRef = useRef<HTMLButtonElement>(null);
  const dismissedCellKeyRef = useRef<string | null>(null);
  const menuOpenerRef = useRef<MenuOpener>('editor');
  const selectedCellKeyRef = useRef<string | null>(null);
  const selectionSyncRafRef = useRef<number | null>(null);

  const closeMenu = useCallback((restoreFocus = false) => {
    setMenuPosition(null);
    if (!restoreFocus) {
      return;
    }

    requestAnimationFrame(() => {
      if (menuOpenerRef.current === 'button' && buttonRef.current) {
        buttonRef.current.focus();
        return;
      }
      editor.focus();
    });
  }, [editor]);

  const clearButton = useCallback(() => {
    selectedCellKeyRef.current = null;
    setSelectedCellKey(null);
    setTableNodeKey(null);
    setButtonPosition(null);
  }, []);

  const cancelScheduledSelectionSync = useCallback(() => {
    if (selectionSyncRafRef.current !== null) {
      cancelAnimationFrame(selectionSyncRafRef.current);
      selectionSyncRafRef.current = null;
    }
  }, []);

  // Update button position when selection changes
  const moveButton = useCallback(() => {
    const selection = $getSelection();

    if (!$isRangeSelection(selection) || $isTableSelection(selection)) {
      clearButton();
      closeMenu();
      return;
    }

    const anchorCellNode = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
    const focusCellNode = $getTableCellNodeFromLexicalNode(selection.focus.getNode());

    if (!anchorCellNode || !focusCellNode) {
      clearButton();
      closeMenu();
      return;
    }

    if (anchorCellNode.getKey() !== focusCellNode.getKey()) {
      clearButton();
      closeMenu();
      return;
    }

    const activeCellKey = anchorCellNode.getKey();
    if (dismissedCellKeyRef.current === activeCellKey) {
      clearButton();
      closeMenu();
      return;
    }
    dismissedCellKeyRef.current = null;

    try {
      const activeTableNode = $getTableNodeFromLexicalNodeOrThrow(anchorCellNode);
      const cellElement = editor.getElementByKey(anchorCellNode.getKey());
      const editorRoot = editor.getRootElement();
      if (!(cellElement instanceof HTMLElement) || !editorRoot) {
        clearButton();
        closeMenu();
        return;
      }

      const nextPosition = getVisibleCellActionButtonPosition(
        cellElement.getBoundingClientRect(),
        editorRoot.getBoundingClientRect(),
        resizeHandlesVisible
          ? TABLE_ACTION_BUTTON_RESIZE_MARGIN_PX
          : TABLE_ACTION_BUTTON_MARGIN_PX
      );
      if (!nextPosition) {
        clearButton();
        closeMenu();
        return;
      }

      if (
        selectedCellKeyRef.current &&
        selectedCellKeyRef.current !== anchorCellNode.getKey()
      ) {
        closeMenu();
      }
      selectedCellKeyRef.current = activeCellKey;
      setSelectedCellKey(activeCellKey);
      setTableNodeKey(activeTableNode.getKey());
      setButtonPosition(nextPosition);
    } catch {
      clearButton();
      closeMenu();
    }
  }, [clearButton, closeMenu, editor, resizeHandlesVisible]);

  const scheduleButtonSyncFromSelection = useCallback(() => {
    cancelScheduledSelectionSync();
    selectionSyncRafRef.current = requestAnimationFrame(() => {
      selectionSyncRafRef.current = null;
      editor.getEditorState().read(() => {
        moveButton();
      });
    });
  }, [cancelScheduledSelectionSync, editor, moveButton]);

  // Listen for selection changes — LOW priority so click processing isn't blocked.
  // Defer the actual read to the next frame so table clicks settle first.
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        scheduleButtonSyncFromSelection();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, scheduleButtonSyncFromSelection]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      const activeCellKey = selectedCellKeyRef.current;
      if (!(target instanceof Element) || !activeCellKey) {
        return;
      }

      if (
        buttonRef.current?.contains(target) ||
        target.closest(`[data-moss-table-ui-owner="${ownerId}"]`)
      ) {
        return;
      }

      const activeCellElement = editor.getElementByKey(activeCellKey);
      const activeTableElement = activeCellElement?.closest('table.moss-table');
      if (activeTableElement?.contains(target)) {
        return;
      }

      dismissedCellKeyRef.current = activeCellKey;
      cancelScheduledSelectionSync();
      closeMenu();
      clearButton();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => document.removeEventListener('pointerdown', handlePointerDown, true);
  }, [cancelScheduledSelectionSync, clearButton, closeMenu, editor, ownerId]);

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent) => {
      const target = event.target;
      const editorRoot = editor.getRootElement();
      if (!(target instanceof Element) || !editorRoot || !editorRoot.contains(target)) {
        return;
      }

      const cellElement = target.closest('td, th');
      if (
        !(cellElement instanceof HTMLTableCellElement) ||
        !cellElement.closest('table.moss-table')
      ) {
        return;
      }

      dismissedCellKeyRef.current = null;

      let nextCellKey: string | null = null;
      let nextTableKey: string | null = null;
      editor.update(() => {
        const nearestNode = $getNearestNodeFromDOMNode(cellElement);
        const cellNode = nearestNode
          ? $getTableCellNodeFromLexicalNode(nearestNode)
          : null;
        if (!cellNode) {
          return;
        }

        try {
          const tableNode = $getTableNodeFromLexicalNodeOrThrow(cellNode);
          selectedCellKeyRef.current = cellNode.getKey();
          cellNode.selectStart();
          nextCellKey = cellNode.getKey();
          nextTableKey = tableNode.getKey();
        } catch {
          nextCellKey = null;
          nextTableKey = null;
        }
      });

      if (!nextCellKey || !nextTableKey) {
        return;
      }

      event.preventDefault();
      menuOpenerRef.current = 'editor';
      setSelectedCellKey(nextCellKey);
      setTableNodeKey(nextTableKey);
      setMenuPosition(
        getTableContextMenuPosition(
          event.clientX,
          event.clientY,
          window.innerWidth,
          window.innerHeight
        )
      );
    };

    document.addEventListener('contextmenu', handleContextMenu);
    return () => document.removeEventListener('contextmenu', handleContextMenu);
  }, [editor]);

  useEffect(() => {
    return editor.registerCommand(
      CLICK_COMMAND,
      (event) => {
        const target = event?.target;
        const editorRoot = editor.getRootElement();
        if (
          target instanceof Element &&
          editorRoot?.contains(target) &&
          target.closest('table.moss-table')
        ) {
          dismissedCellKeyRef.current = null;
        }
        scheduleButtonSyncFromSelection();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, scheduleButtonSyncFromSelection]);

  // Teardown table cell UI on scroll. The user can re-open it by clicking/selecting again.
  useEffect(() => {
    const handleScroll = () => {
      if (!selectedCellKey && !menuPosition && !buttonPosition) {
        return;
      }

      closeMenu();
      clearButton();
    };

    // Use capture to catch scroll events from nested scroll containers
    // (canvas scroller, table wrapper, window/document, etc).
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });

    return () => {
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [
    buttonPosition,
    closeMenu,
    clearButton,
    menuPosition,
    selectedCellKey
  ]);

  // Close menu when comment box opens
  useEffect(() => {
    if (commentInputState.open && menuPosition) {
      closeMenu();
    }
  }, [closeMenu, commentInputState.open, menuPosition]);

  useEffect(() => {
    if (resizeHandlesVisible) {
      scheduleButtonSyncFromSelection();
    }
  }, [resizeHandlesVisible, scheduleButtonSyncFromSelection]);

  useEffect(() => {
    if (!selectedCellKey) {
      return;
    }

    const cellElement = editor.getElementByKey(selectedCellKey);
    if (!(cellElement instanceof HTMLElement)) {
      return;
    }

    const syncButtonPosition = () => {
      editor.getEditorState().read(() => {
        moveButton();
      });
    };
    const resizeObserver = new ResizeObserver(syncButtonPosition);
    resizeObserver.observe(cellElement);
    const editorRoot = editor.getRootElement();
    if (editorRoot && editorRoot !== cellElement) {
      resizeObserver.observe(editorRoot);
    }

    const tableElement = cellElement.closest('table.moss-table');
    let mutationObserver: MutationObserver | null = null;
    if (tableElement instanceof HTMLTableElement) {
      mutationObserver = new MutationObserver(syncButtonPosition);
      mutationObserver.observe(tableElement, {
        attributes: true,
        attributeFilter: ['style'],
        subtree: true
      });
    }

    return () => {
      resizeObserver.disconnect();
      mutationObserver?.disconnect();
    };
  }, [editor, moveButton, selectedCellKey]);

  useEffect(() => {
    return () => {
      cancelScheduledSelectionSync();
    };
  }, [cancelScheduledSelectionSync]);

  if (
    (!buttonPosition && !menuPosition) ||
    !selectedCellKey ||
    !tableNodeKey ||
    commentInputState.open
  ) {
    return null;
  }

  return (
    <>
      {buttonPosition && createPortal(
        <button
          ref={buttonRef}
          type="button"
          onClick={() => {
            if (menuPosition) {
              closeMenu();
              return;
            }
            const rect = buttonRef.current?.getBoundingClientRect();
            if (!rect) {
              return;
            }
            menuOpenerRef.current = 'button';
            setMenuPosition({
              top: rect.bottom + 4,
              left: rect.right - TABLE_ACTION_MENU_WIDTH_PX
            });
          }}
          className="fixed z-40 flex h-5 w-5 items-center justify-center rounded border border-border-default bg-surface-canvas text-ink-muted shadow-sm transition-colors hover:bg-surface-panel hover:text-ink-default"
          style={{ top: buttonPosition.top, left: buttonPosition.left }}
          aria-label="Table actions"
          aria-expanded={menuPosition !== null}
          aria-haspopup="menu"
          data-moss-table-ui-owner={ownerId}
        >
          <ChevronDown size={12} />
        </button>,
        document.body
      )}
      {menuPosition && tableNodeKey && (
        <TableActionMenu
          tableNodeKey={tableNodeKey}
          onClose={closeMenu}
          ownerId={ownerId}
          position={menuPosition}
          anchorRef={buttonRef}
        />
      )}
    </>
  );
}

export default TableActionMenuPlugin;

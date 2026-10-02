// ported-from: packages/desktop/src/renderer/editor/plugins/TableColumnResizePlugin.tsx @ 762abb777
import type { JSX } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $isTableSelection,
  $isTableNode,
  TableNode
} from '@lexical/table';
import {
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND
} from 'lexical';
import {
  removeTableResizeHandlesVisibility,
  setTableResizeHandlesVisible
} from './tableUiState';
import { getTableUiOwnerId } from './tableUiOwner';
import { TABLE_MIN_COLUMN_WIDTH_PX } from './TableColumnLayoutPlugin';

const HANDLE_HITBOX_WIDTH_PX = 24;
const HANDLE_GRIP_HEIGHT_PX = 48;
const KEYBOARD_RESIZE_STEP_PX = 10;
const TABLE_MAX_COLUMN_WIDTH_PX = 1280;
const TABLE_SCROLL_VIEWPORT_CLASS = 'moss-table-scroll-viewport';

type ResizeHandle = {
  edge: 'between' | 'end';
  columnIndex: number;
  left: number;
  top: number;
  height: number;
  valueMax: number;
  valueMin: number;
  valueNow: number;
};

type DragState = {
  edge: ResizeHandle['edge'];
  columnIndex: number;
  currentWidths: number[];
  deltaX: number;
  pointerId: number;
  startWidths: number[];
  startX: number;
  tableElement: HTMLTableElement;
  tableKey: string;
};

type ResizeSource = Pick<
  ResizeHandle,
  'edge' | 'columnIndex' | 'left' | 'top' | 'height'
> & {
  tableElement: HTMLTableElement;
  tableKey: string;
};

const resizeColumns = (
  widths: readonly number[],
  edge: ResizeHandle['edge'],
  columnIndex: number,
  deltaX: number
): number[] => {
  if (edge === 'between') {
    return clampColumnPair(widths, columnIndex, deltaX);
  }

  const nextWidths = [...widths];
  const currentWidth = widths[columnIndex];
  if (currentWidth == null) {
    return nextWidths;
  }

  nextWidths[columnIndex] = Math.min(
    TABLE_MAX_COLUMN_WIDTH_PX,
    Math.max(TABLE_MIN_COLUMN_WIDTH_PX, Math.round(currentWidth + deltaX))
  );
  return nextWidths;
};

const clampColumnPair = (
  widths: readonly number[],
  columnIndex: number,
  deltaX: number
): number[] => {
  const nextWidths = [...widths];
  const leftWidth = widths[columnIndex];
  const rightWidth = widths[columnIndex + 1];
  if (leftWidth == null || rightWidth == null) {
    return nextWidths;
  }

  const pairWidth = leftWidth + rightWidth;
  const maxLeftWidth = pairWidth - TABLE_MIN_COLUMN_WIDTH_PX;
  const nextLeftWidth = Math.min(
    maxLeftWidth,
    Math.max(TABLE_MIN_COLUMN_WIDTH_PX, Math.round(leftWidth + deltaX))
  );
  const nextRightWidth = pairWidth - nextLeftWidth;

  nextWidths[columnIndex] = nextLeftWidth;
  nextWidths[columnIndex + 1] = nextRightWidth;

  return nextWidths;
};

const ensureColGroup = (
  table: HTMLTableElement,
  columnCount: number
): HTMLTableColElement[] => {
  let colGroup = table.querySelector('colgroup');
  if (!colGroup) {
    colGroup = document.createElement('colgroup');
    table.insertBefore(colGroup, table.firstChild);
  }

  while (colGroup.children.length < columnCount) {
    colGroup.appendChild(document.createElement('col'));
  }

  while (colGroup.children.length > columnCount) {
    colGroup.lastElementChild?.remove();
  }

  return Array.from(colGroup.children).filter(
    (child): child is HTMLTableColElement => child instanceof HTMLTableColElement
  );
};

const getMeasuredColumnWidths = (table: HTMLTableElement): number[] => {
  const firstRow = Array.from(table.rows).find((row) => row.cells.length > 0);
  if (!firstRow) {
    return [];
  }

  return Array.from(firstRow.cells).map((cell) => Math.round(cell.getBoundingClientRect().width));
};

const applyPixelColumnWidths = (
  table: HTMLTableElement,
  widths: readonly number[]
): void => {
  const columns = ensureColGroup(table, widths.length);
  const tableWidth = Math.round(widths.reduce((sum, width) => sum + width, 0));
  table.style.width = `${tableWidth}px`;
  table.style.minWidth = `${tableWidth}px`;
  table.style.tableLayout = 'fixed';

  columns.forEach((column, index) => {
    const width = widths[index];
    if (width == null) {
      return;
    }
    column.style.width = `${Math.round(width)}px`;
  });
};

const previewResizeHandles = (
  startHandles: readonly ResizeHandle[],
  edge: ResizeHandle['edge'],
  columnIndex: number,
  startWidths: readonly number[],
  currentWidths: readonly number[]
): ResizeHandle[] => {
  const startWidth = startWidths[columnIndex];
  const currentWidth = currentWidths[columnIndex];
  const deltaX = startWidth == null || currentWidth == null ? 0 : currentWidth - startWidth;

  return startHandles.map((handle) =>
    handle.edge === edge && handle.columnIndex === columnIndex
      ? { ...handle, left: handle.left + deltaX }
      : handle
  );
};

const resolveTableElement = (element: HTMLElement | null): HTMLTableElement | null => {
  if (element instanceof HTMLTableElement) {
    return element;
  }

  const table = element?.querySelector('table.moss-table');
  return table instanceof HTMLTableElement ? table : null;
};

const buildResizeHandles = (
  tableRect: DOMRect,
  widths: readonly number[],
  viewportRect: DOMRect | null = null
): ResizeHandle[] => {
  const handles: ResizeHandle[] = [];
  let offsetLeft = tableRect.left;

  for (let index = 0; index < widths.length - 1; index += 1) {
    offsetLeft += widths[index] ?? 0;
    handles.push({
      edge: 'between',
      columnIndex: index,
      left: offsetLeft,
      top: tableRect.top,
      height: tableRect.height,
      valueMax:
        (widths[index] ?? TABLE_MIN_COLUMN_WIDTH_PX) +
        (widths[index + 1] ?? TABLE_MIN_COLUMN_WIDTH_PX) -
        TABLE_MIN_COLUMN_WIDTH_PX,
      valueMin: TABLE_MIN_COLUMN_WIDTH_PX,
      valueNow: widths[index] ?? TABLE_MIN_COLUMN_WIDTH_PX
    });
  }

  const lastColumnWidth = widths[widths.length - 1] ?? TABLE_MIN_COLUMN_WIDTH_PX;
  handles.push({
    edge: 'end',
    columnIndex: widths.length - 1,
    left: tableRect.right,
    top: tableRect.top,
    height: tableRect.height,
    valueMax: TABLE_MAX_COLUMN_WIDTH_PX,
    valueMin: TABLE_MIN_COLUMN_WIDTH_PX,
    valueNow: lastColumnWidth
  });

  if (!viewportRect) {
    return handles;
  }

  return handles.filter(
    (handle) => handle.left >= viewportRect.left && handle.left <= viewportRect.right
  );
};

const getTableViewportRect = (table: HTMLTableElement): DOMRect | null => {
  const viewport = table.closest(`.${TABLE_SCROLL_VIEWPORT_CLASS}`);
  if (!(viewport instanceof HTMLElement)) {
    return null;
  }

  const viewportRect = viewport.getBoundingClientRect();
  return viewportRect.width > 0 && viewportRect.height > 0 ? viewportRect : null;
};

const buildDragPreviewHandles = (dragState: DragState): ResizeHandle[] => {
  const viewportRect = getTableViewportRect(dragState.tableElement);
  const baseHandles = buildResizeHandles(
    dragState.tableElement.getBoundingClientRect(),
    dragState.startWidths,
    null
  );
  const previewHandles = previewResizeHandles(
    baseHandles,
    dragState.edge,
    dragState.columnIndex,
    dragState.startWidths,
    dragState.currentWidths
  );
  if (!viewportRect) {
    return previewHandles;
  }

  return previewHandles.filter(
    (handle) => handle.left >= viewportRect.left && handle.left <= viewportRect.right
  );
};

export function TableColumnResizePlugin(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const ownerId = getTableUiOwnerId(editor);
  const [handles, setHandles] = useState<ResizeHandle[]>([]);
  const activeTableKeyRef = useRef<string | null>(null);
  const dismissedTableKeyRef = useRef<string | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const mutationRefreshRafRef = useRef<number | null>(null);
  const selectionSyncRafRef = useRef<number | null>(null);

  const clearVisibleHandles = useCallback(() => {
    activeTableKeyRef.current = null;
    setHandles([]);
  }, []);

  const showHandlesForTable = useCallback(
    (tableKey: string | null) => {
      if (!tableKey) {
        clearVisibleHandles();
        return;
      }

      if (
        activeTableKeyRef.current !== tableKey ||
        dismissedTableKeyRef.current === tableKey
      ) {
        if (activeTableKeyRef.current === tableKey) {
          clearVisibleHandles();
        }
        return;
      }

      const tableElement = resolveTableElement(editor.getElementByKey(tableKey));
      if (!tableElement) {
        clearVisibleHandles();
        return;
      }

      const tableRect = tableElement.getBoundingClientRect();
      if (tableRect.width <= 0 || tableRect.height <= 0) {
        setHandles([]);
        return;
      }

      const widths = getMeasuredColumnWidths(tableElement);
      if (widths.length < 1) {
        setHandles([]);
        return;
      }

      activeTableKeyRef.current = tableKey;
      setHandles(buildResizeHandles(tableRect, widths, getTableViewportRect(tableElement)));
    },
    [clearVisibleHandles, editor]
  );

  const refreshActiveTableHandles = useCallback(() => {
    showHandlesForTable(activeTableKeyRef.current);
  }, [showHandlesForTable]);

  const cancelScheduledSelectionSync = useCallback(() => {
    if (selectionSyncRafRef.current !== null) {
      cancelAnimationFrame(selectionSyncRafRef.current);
      selectionSyncRafRef.current = null;
    }
  }, []);

  const cancelScheduledMutationRefresh = useCallback(() => {
    if (mutationRefreshRafRef.current !== null) {
      cancelAnimationFrame(mutationRefreshRafRef.current);
      mutationRefreshRafRef.current = null;
    }
  }, []);

  const syncHandlesFromSelection = useCallback(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || $isTableSelection(selection)) {
      clearVisibleHandles();
      return;
    }

    const anchorCellNode = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
    const focusCellNode = $getTableCellNodeFromLexicalNode(selection.focus.getNode());
    if (!anchorCellNode || !focusCellNode || anchorCellNode.getKey() !== focusCellNode.getKey()) {
      clearVisibleHandles();
      return;
    }

    try {
      const tableKey = $getTableNodeFromLexicalNodeOrThrow(anchorCellNode).getKey();
      if (dismissedTableKeyRef.current === tableKey) {
        clearVisibleHandles();
        return;
      }
      dismissedTableKeyRef.current = null;
      activeTableKeyRef.current = tableKey;
      showHandlesForTable(tableKey);
    } catch {
      clearVisibleHandles();
    }
  }, [clearVisibleHandles, editor, showHandlesForTable]);

  const scheduleHandleSyncFromSelection = useCallback(() => {
    cancelScheduledSelectionSync();
    selectionSyncRafRef.current = requestAnimationFrame(() => {
      selectionSyncRafRef.current = null;
      editor.getEditorState().read(() => {
        syncHandlesFromSelection();
      });
    });
  }, [cancelScheduledSelectionSync, editor, syncHandlesFromSelection]);

  const beginDrag = useCallback(
    (
      source: ResizeSource,
      event: ReactPointerEvent<HTMLElement>
    ) => {
      event.preventDefault();
      event.stopPropagation();

      const widths = getMeasuredColumnWidths(source.tableElement);
      if (source.columnIndex < 0 || source.columnIndex >= widths.length) {
        return;
      }
      if (source.edge === 'between' && source.columnIndex + 1 >= widths.length) {
        return;
      }

      const startHandles = buildResizeHandles(
        source.tableElement.getBoundingClientRect(),
        widths,
        getTableViewportRect(source.tableElement)
      );
      dragStateRef.current = {
        edge: source.edge,
        columnIndex: source.columnIndex,
        currentWidths: widths,
        deltaX: 0,
        pointerId: event.pointerId,
        startWidths: widths,
        startX: event.clientX,
        tableElement: source.tableElement,
        tableKey: source.tableKey
      };

      activeTableKeyRef.current = source.tableKey;
      setHandles(startHandles);
      document.body.style.cursor = 'col-resize';
    },
    []
  );

  const commitColumnWidths = useCallback(
    (tableElement: HTMLTableElement, tableKey: string, widths: readonly number[]) => {
      applyPixelColumnWidths(tableElement, widths);

      editor.update(() => {
        const tableNode = $getNodeByKey(tableKey);
        if ($isTableNode(tableNode)) {
          tableNode.setColWidths(widths.map((width) => Math.round(width)));
        }
      }, { tag: 'table-column-resize' });
    },
    [editor]
  );

  const handleKeyboardResize = useCallback(
    (handle: ResizeHandle, event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const tableKey = activeTableKeyRef.current;
      if (!tableKey) {
        return;
      }

      const tableElement = resolveTableElement(editor.getElementByKey(tableKey));
      if (!tableElement) {
        return;
      }

      const widths = getMeasuredColumnWidths(tableElement);
      if (handle.columnIndex < 0 || handle.columnIndex >= widths.length) {
        return;
      }
      if (handle.edge === 'between' && handle.columnIndex + 1 >= widths.length) {
        return;
      }

      const deltaX = event.key === 'ArrowRight'
        ? KEYBOARD_RESIZE_STEP_PX
        : -KEYBOARD_RESIZE_STEP_PX;
      const nextWidths = resizeColumns(widths, handle.edge, handle.columnIndex, deltaX);
      const handleLabel = event.currentTarget.getAttribute('aria-label');
      commitColumnWidths(tableElement, tableKey, nextWidths);
      setHandles(
        buildResizeHandles(
          tableElement.getBoundingClientRect(),
          nextWidths,
          getTableViewportRect(tableElement)
        )
      );
      requestAnimationFrame(() => {
        showHandlesForTable(tableKey);
        requestAnimationFrame(() => {
          const matchingHandle = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-moss-table-ui-owner="${ownerId}"]` +
              '[data-moss-table-resize-visible-handle="true"]'
            )
          ).find((element) => element.getAttribute('aria-label') === handleLabel);
          matchingHandle?.focus();
        });
      });
    },
    [commitColumnWidths, editor, ownerId, showHandlesForTable]
  );

  useEffect(() => {
    setTableResizeHandlesVisible(ownerId, handles.length > 0);
  }, [handles.length, ownerId]);

  useEffect(() => {
    return () => {
      removeTableResizeHandlesVisibility(ownerId);
    };
  }, [ownerId]);

  useEffect(() => {
    return editor.registerMutationListener(TableNode, (mutations) => {
      const activeTableKey = activeTableKeyRef.current;
      if (!activeTableKey || !mutations.has(activeTableKey)) {
        return;
      }

      cancelScheduledMutationRefresh();
      mutationRefreshRafRef.current = requestAnimationFrame(() => {
        mutationRefreshRafRef.current = null;
        if (
          activeTableKeyRef.current !== activeTableKey ||
          dismissedTableKeyRef.current === activeTableKey
        ) {
          return;
        }
        showHandlesForTable(activeTableKey);
      });
    });
  }, [cancelScheduledMutationRefresh, editor, showHandlesForTable]);

  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        scheduleHandleSyncFromSelection();
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, scheduleHandleSyncFromSelection]);

  useEffect(() => {
    return () => {
      cancelScheduledMutationRefresh();
      cancelScheduledSelectionSync();
    };
  }, [cancelScheduledMutationRefresh, cancelScheduledSelectionSync]);

  useEffect(() => {
    const refreshHandles = () => {
      const dragState = dragStateRef.current;
      if (dragState) {
        const measuredWidths = getMeasuredColumnWidths(dragState.tableElement);
        if (measuredWidths.length === dragState.startWidths.length) {
          dragState.startWidths = measuredWidths;
          dragState.currentWidths = resizeColumns(
            measuredWidths,
            dragState.edge,
            dragState.columnIndex,
            dragState.deltaX
          );
        }
        setHandles(buildDragPreviewHandles(dragState));
        return;
      }

      if (activeTableKeyRef.current) {
        refreshActiveTableHandles();
      }
    };

    const handleResize = () => {
      refreshHandles();
    };

    const handleScroll = () => {
      refreshHandles();
    };

    window.addEventListener('resize', handleResize, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });

    return () => {
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, [refreshActiveTableHandles]);

  useEffect(() => {
    const handlePointerDownCapture = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (
        target.closest(`[data-moss-table-ui-owner="${ownerId}"]`) ||
        dragStateRef.current
      ) {
        return;
      }

      const editorRoot = editor.getRootElement();
      const clickedTable = target.closest('table.moss-table');
      const clickedOwnedTable =
        clickedTable instanceof HTMLTableElement && editorRoot?.contains(clickedTable)
          ? clickedTable
          : null;
      const activeTableKey = activeTableKeyRef.current;
      if (activeTableKey) {
        const activeTableElement = resolveTableElement(editor.getElementByKey(activeTableKey));
        const clickedInsideActiveTable =
          activeTableElement !== null &&
          clickedOwnedTable !== null &&
          activeTableElement === clickedOwnedTable;

        if (!clickedInsideActiveTable) {
          dismissedTableKeyRef.current = activeTableKey;
          cancelScheduledMutationRefresh();
          clearVisibleHandles();
        }
      }

      if (clickedOwnedTable) {
        dismissedTableKeyRef.current = null;
        scheduleHandleSyncFromSelection();
      }
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, {
      passive: true,
      capture: true
    });

    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
    };
  }, [
    cancelScheduledMutationRefresh,
    clearVisibleHandles,
    editor,
    ownerId,
    scheduleHandleSyncFromSelection
  ]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState || event.pointerId !== dragState.pointerId) {
        return;
      }

      event.preventDefault();
      dragState.deltaX = event.clientX - dragState.startX;
      const nextWidths = resizeColumns(
        dragState.startWidths,
        dragState.edge,
        dragState.columnIndex,
        dragState.deltaX
      );
      dragState.currentWidths = nextWidths;
      setHandles(buildDragPreviewHandles(dragState));
    };

    const finishDrag = (pointerId: number, commit: boolean) => {
      const dragState = dragStateRef.current;
      if (!dragState || pointerId !== dragState.pointerId) {
        return;
      }

      dragStateRef.current = null;
      document.body.style.cursor = '';
      if (commit) {
        commitColumnWidths(
          dragState.tableElement,
          dragState.tableKey,
          dragState.currentWidths
        );
      }

      requestAnimationFrame(() => {
        showHandlesForTable(dragState.tableKey);
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      finishDrag(event.pointerId, true);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      finishDrag(event.pointerId, false);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [commitColumnWidths, showHandlesForTable]);

  useEffect(() => {
    return () => {
      dragStateRef.current = null;
      document.body.style.cursor = '';
      cancelScheduledSelectionSync();
    };
  }, [cancelScheduledSelectionSync]);

  if (handles.length === 0) {
    return null;
  }

  return createPortal(
    <>
      {handles.map((handle) => (
        <div
          key={`${handle.edge}:${handle.columnIndex}`}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={
            handle.edge === 'end'
                ? 'Resize table right edge'
                : `Resize table columns ${handle.columnIndex + 1} and ${handle.columnIndex + 2}`
          }
          aria-valuemin={handle.valueMin}
          aria-valuemax={handle.valueMax}
          aria-valuenow={handle.valueNow}
          aria-valuetext={`${handle.valueNow} pixels`}
          data-moss-table-resize-visible-handle="true"
          data-moss-table-ui-owner={ownerId}
          className="fixed z-40 -translate-x-1/2 cursor-col-resize touch-none select-none"
          style={{
            left: handle.left,
            top: handle.top,
            height: handle.height,
            width: HANDLE_HITBOX_WIDTH_PX
          }}
          onPointerDown={(event) => {
            const tableKey = activeTableKeyRef.current;
            if (!tableKey) {
              return;
            }

            const tableElement = resolveTableElement(editor.getElementByKey(tableKey));
            if (!tableElement) {
              return;
            }

            beginDrag(
              {
                edge: handle.edge,
                columnIndex: handle.columnIndex,
                left: handle.left,
                top: handle.top,
                height: handle.height,
                tableElement,
                tableKey
              },
              event
            );
          }}
          onKeyDown={(event) => handleKeyboardResize(handle, event)}
        >
          <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-brand/20" />
          <span
            className="pointer-events-none absolute left-1/2 top-1/2 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border-default bg-surface-canvas shadow-sm"
            style={{ height: HANDLE_GRIP_HEIGHT_PX }}
          />
        </div>
      ))}
    </>,
    document.body
  );
}

export default TableColumnResizePlugin;

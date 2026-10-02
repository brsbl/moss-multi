// ported-from: packages/desktop/src/renderer/editor/plugins/TableExitPlugin.tsx @ 762abb777
/**
 * TableExitPlugin - Exit tables with arrow keys at edges
 *
 * Based on Lexical's table handling pattern:
 * - Arrow up at first row → insert/select paragraph above
 * - Arrow down at last row → insert/select paragraph below
 * - Enter at last row → add row (empty last row exits table)
 * - Shift+Enter → insert line break within cell
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND
} from 'lexical';
import {
  $getTableCellNodeFromLexicalNode,
  $getTableNodeFromLexicalNodeOrThrow,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode
} from '@lexical/table';
import {
  $insertParagraphAfterBlock,
  $isSelectionInEmptyParagraph,
  $isSelectionAtNodeEnd,
  $removeEmptyParagraphAtSelection,
  createBlockEndEnterTracker,
  isPlainEnterEvent
} from '../utils/block-node-double-enter';

/**
 * Check if cursor is in the first row of a table
 */
function $isInFirstRow(tableNode: ReturnType<typeof $getTableNodeFromLexicalNodeOrThrow>, cellNode: ReturnType<typeof $getTableCellNodeFromLexicalNode>): boolean {
  if (!cellNode) return false;
  const rows = tableNode.getChildren();
  const firstRow = rows[0];
  if (!firstRow || !$isTableRowNode(firstRow)) return false;

  const cellParent = cellNode.getParent();
  return cellParent === firstRow;
}

/**
 * Check if cursor is in the last row of a table
 */
function $isInLastRow(tableNode: ReturnType<typeof $getTableNodeFromLexicalNodeOrThrow>, cellNode: ReturnType<typeof $getTableCellNodeFromLexicalNode>): boolean {
  if (!cellNode) return false;
  const rows = tableNode.getChildren();
  const lastRow = rows[rows.length - 1];
  if (!lastRow || !$isTableRowNode(lastRow)) return false;

  const cellParent = cellNode.getParent();
  return cellParent === lastRow;
}

/**
 * Insert a paragraph before or after a table and select it
 */
function $insertParagraphAtTableEdge(
  position: 'before' | 'after',
  tableNode: ReturnType<typeof $getTableNodeFromLexicalNodeOrThrow>
): void {
  const paragraph = $createParagraphNode();

  if (position === 'before') {
    tableNode.insertBefore(paragraph);
  } else {
    tableNode.insertAfter(paragraph);
  }

  paragraph.select();
}

/**
 * Get the sibling element (paragraph) if it exists, or create one
 */
function $getOrCreateSiblingParagraph(
  tableNode: ReturnType<typeof $getTableNodeFromLexicalNodeOrThrow>,
  position: 'before' | 'after'
): void {
  const sibling = position === 'before'
    ? tableNode.getPreviousSibling()
    : tableNode.getNextSibling();

  if (sibling && !$isTableNode(sibling)) {
    // There's a sibling that's not a table, select it
    if ('selectEnd' in sibling && typeof sibling.selectEnd === 'function') {
      if (position === 'before') {
        sibling.selectEnd();
      } else {
        sibling.selectStart();
      }
    }
  } else {
    // No sibling or sibling is another table, create paragraph
    $insertParagraphAtTableEdge(position, tableNode);
  }
}

/**
 * Plugin that allows exiting tables with arrow keys and Enter.
 */
export function TableExitPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const enterTrackerRef = useRef(createBlockEndEnterTracker());

  useEffect(() => {
    // Handle arrow up at first row
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const cellNode = $getTableCellNodeFromLexicalNode(anchorNode);
        if (!cellNode || !$isTableCellNode(cellNode)) {
          return false;
        }

        let tableNode;
        try {
          tableNode = $getTableNodeFromLexicalNodeOrThrow(cellNode);
        } catch {
          return false;
        }

        if (!$isTableNode(tableNode) || !$isInFirstRow(tableNode, cellNode)) {
          return false;
        }

        event?.preventDefault();
        $getOrCreateSiblingParagraph(tableNode, 'before');
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    // Handle arrow down at last row
    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const cellNode = $getTableCellNodeFromLexicalNode(anchorNode);
        if (!cellNode || !$isTableCellNode(cellNode)) {
          return false;
        }

        let tableNode;
        try {
          tableNode = $getTableNodeFromLexicalNodeOrThrow(cellNode);
        } catch {
          return false;
        }

        if (!$isTableNode(tableNode) || !$isInLastRow(tableNode, cellNode)) {
          return false;
        }

        event?.preventDefault();
        $getOrCreateSiblingParagraph(tableNode, 'after');
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!isPlainEnterEvent(event)) {
          enterTrackerRef.current.clear();
          return false;
        }

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          enterTrackerRef.current.clear();
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const cellNode = $getTableCellNodeFromLexicalNode(anchorNode);
        if (!cellNode || !$isTableCellNode(cellNode)) {
          enterTrackerRef.current.clear();
          return false;
        }

        let tableNode;
        try {
          tableNode = $getTableNodeFromLexicalNodeOrThrow(cellNode);
        } catch {
          enterTrackerRef.current.clear();
          return false;
        }

        if (
          !$isTableNode(tableNode) ||
          !$isInLastRow(tableNode, cellNode) ||
          !$isSelectionAtNodeEnd(anchorNode, selection.anchor.offset, cellNode)
        ) {
          enterTrackerRef.current.clear();
          return false;
        }

        const isSecondEnter =
          enterTrackerRef.current.isSecondEnter(tableNode.getKey()) &&
          $isSelectionInEmptyParagraph(anchorNode, cellNode);

        if (!isSecondEnter) {
          enterTrackerRef.current.mark(tableNode.getKey());
          return false;
        }

        event?.preventDefault();
        enterTrackerRef.current.clear();
        $removeEmptyParagraphAtSelection(anchorNode, cellNode);
        $insertParagraphAfterBlock(tableNode);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      unregisterArrowUp();
      unregisterArrowDown();
      unregisterEnter();
    };
  }, [editor]);

  return null;
}

export default TableExitPlugin;

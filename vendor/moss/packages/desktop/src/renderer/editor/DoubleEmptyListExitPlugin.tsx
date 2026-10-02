// ported-from: packages/desktop/src/renderer/editor/DoubleEmptyListExitPlugin.tsx @ 762abb777
import { useEffect } from 'react';

import {
  $createListNode,
  $handleListInsertParagraph,
  $isListItemNode,
  $isListNode
} from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { mergeRegister } from '@lexical/utils';
import type { LexicalNode } from 'lexical';
import {
  $getSelection,
  $createParagraphNode,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
} from 'lexical';

function findContainingListItem(node: LexicalNode | null) {
  let current: LexicalNode | null = node;
  while (current) {
    if ($isListItemNode(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

function isEmptyListItemText(node: LexicalNode): boolean {
  if (!$isListItemNode(node)) {
    return false;
  }
  return node.getTextContent().trim().length === 0;
}

function isSelectionAtListItemStart(listItem: LexicalNode): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.offset !== 0) {
    return false;
  }

  let current: LexicalNode | null = selection.anchor.getNode();
  while (current && !current.is(listItem)) {
    if (current.getPreviousSibling() !== null) {
      return false;
    }
    current = current.getParent();
  }
  return current?.is(listItem) ?? false;
}

function splitTopLevelListItemToParagraph(listItem: LexicalNode): boolean {
  if (!$isListItemNode(listItem)) {
    return false;
  }

  const list = listItem.getParent();
  if (!$isListNode(list)) {
    return false;
  }
  if (!$isRootOrShadowRoot(list.getParent())) {
    return false;
  }

  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }

  const paragraph = $createParagraphNode()
    .setTextStyle(selection.style)
    .setTextFormat(selection.format);
  const nextSiblings = listItem.getNextSiblings();
  const nestedLists = listItem.getChildren().filter($isListNode);
  paragraph.append(...listItem.getChildren().filter((child) => !$isListNode(child)));

  list.insertAfter(paragraph);
  let insertionPoint: LexicalNode = paragraph;
  for (const nestedList of nestedLists) {
    insertionPoint.insertAfter(nestedList);
    insertionPoint = nestedList;
  }
  if (nextSiblings.length > 0) {
    const nextList = $createListNode(list.getListType(), listItem.getValue() + 1);
    nextList.append(...nextSiblings);
    insertionPoint.insertAfter(nextList);
  }

  listItem.remove();
  if (list.getChildrenSize() === 0) {
    list.remove();
  }
  paragraph.selectStart();
  return true;
}

export function DoubleEmptyListExitPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      editor.registerCommand(
        KEY_ENTER_COMMAND,
        (event) => {
          if (event?.shiftKey || event?.metaKey || event?.ctrlKey || event?.altKey) {
            return false;
          }

          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return false;
          }

          const currentListItem = findContainingListItem(selection.anchor.getNode());
          if (!currentListItem || !isEmptyListItemText(currentListItem)) {
            return false;
          }

          const previousSibling = currentListItem.getPreviousSibling();
          if (!previousSibling || !isEmptyListItemText(previousSibling)) {
            return false;
          }

          event?.preventDefault();
          event?.stopPropagation();
          return $handleListInsertParagraph();
        },
        COMMAND_PRIORITY_HIGH
      ),
      editor.registerCommand(
        KEY_BACKSPACE_COMMAND,
        (event) => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
            return false;
          }

          const currentListItem = findContainingListItem(selection.anchor.getNode());
          if (!currentListItem || !isSelectionAtListItemStart(currentListItem)) {
            return false;
          }

          const handled = isEmptyListItemText(currentListItem)
            ? $handleListInsertParagraph()
            : splitTopLevelListItemToParagraph(currentListItem);
          if (handled) {
            event?.preventDefault();
            event?.stopPropagation();
          }
          return handled;
        },
        COMMAND_PRIORITY_HIGH
      )
    );
  }, [editor]);

  return null;
}

export default DoubleEmptyListExitPlugin;

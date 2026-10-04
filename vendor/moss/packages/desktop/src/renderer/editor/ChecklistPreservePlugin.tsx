// ported-from: packages/desktop/src/renderer/editor/ChecklistPreservePlugin.tsx @ 762abb777
/**
 * ChecklistPreservePlugin - manages list type behavior during indent/outdent.
 *
 * Behaviors:
 * 1. Outdent checklist: Preserve 'check' type (Lexical may convert to bullet)
 * 2. Indent numbered list: Convert to bullet (nested numbered lists look odd)
 *
 * Solution: Register high-priority handlers to capture list type before command,
 * then low-priority handlers to apply the correct type after command completes.
 */
import { useEffect, useRef } from 'react';

import { $isListItemNode, $isListNode, ListType } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  INDENT_CONTENT_COMMAND,
  LexicalNode,
  OUTDENT_CONTENT_COMMAND
} from 'lexical';

const getSelectionListType = (): ListType | null => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return null;
  }

  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    if ($isListItemNode(node)) {
      const parent = node.getParent();
      return $isListNode(parent) ? parent.getListType() : null;
    }
    node = node.getParent();
  }

  return null;
};

const setListType = (targetType: ListType) => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }

  let node: LexicalNode | null = selection.anchor.getNode();
  while (node) {
    if ($isListItemNode(node)) {
      const parent = node.getParent();
      if ($isListNode(parent) && parent.getListType() !== targetType) {
        parent.setListType(targetType);
      }
      break;
    }
    node = node.getParent();
  }
};

export function ChecklistPreservePlugin(): null {
  const [editor] = useLexicalComposerContext();
  const pendingChecklistRestore = useRef(false);
  const pendingNumberToBullet = useRef(false);
  const outdentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const indentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // === OUTDENT: Preserve checklist type ===
    const unregisterOutdentHigh = editor.registerCommand(
      OUTDENT_CONTENT_COMMAND,
      () => {
        const listType = editor.getEditorState().read(getSelectionListType);
        pendingChecklistRestore.current = listType === 'check';
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    const unregisterOutdentLow = editor.registerCommand(
      OUTDENT_CONTENT_COMMAND,
      () => {
        if (pendingChecklistRestore.current) {
          pendingChecklistRestore.current = false;
          if (outdentTimerRef.current) {
            clearTimeout(outdentTimerRef.current);
          }
          outdentTimerRef.current = setTimeout(() => {
            outdentTimerRef.current = null;
            if (editor.getRootElement() === null) {
              return;
            }
            editor.update(() => setListType('check'));
          }, 0);
        }
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    // === INDENT: Convert numbered list to bullet ===
    const unregisterIndentHigh = editor.registerCommand(
      INDENT_CONTENT_COMMAND,
      () => {
        const listType = editor.getEditorState().read(getSelectionListType);
        pendingNumberToBullet.current = listType === 'number';
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    const unregisterIndentLow = editor.registerCommand(
      INDENT_CONTENT_COMMAND,
      () => {
        if (pendingNumberToBullet.current) {
          pendingNumberToBullet.current = false;
          if (indentTimerRef.current) {
            clearTimeout(indentTimerRef.current);
          }
          indentTimerRef.current = setTimeout(() => {
            indentTimerRef.current = null;
            if (editor.getRootElement() === null) {
              return;
            }
            editor.update(() => setListType('bullet'));
          }, 0);
        }
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    return () => {
      unregisterOutdentHigh();
      unregisterOutdentLow();
      unregisterIndentHigh();
      unregisterIndentLow();
      if (outdentTimerRef.current) {
        clearTimeout(outdentTimerRef.current);
        outdentTimerRef.current = null;
      }
      if (indentTimerRef.current) {
        clearTimeout(indentTimerRef.current);
        indentTimerRef.current = null;
      }
    };
  }, [editor]);

  return null;
}

export default ChecklistPreservePlugin;

// ported-from: packages/desktop/src/renderer/editor/plugins/CodeFormatBoundaryPlugin.tsx @ 762abb777
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
} from 'lexical';

/**
 * Clears sticky inline-code format when deleting code-formatted text.
 *
 * Lexical preserves `selection.format` after deleting formatted text so that
 * continued typing stays formatted. This is desirable for bold/italic but
 * unintuitive for inline code — users expect deleting a code span to exit
 * the format. This plugin intercepts backspace/delete and clears code format
 * when:
 * - The cursor is at the start/end boundary of a code node
 * - The last character of a code node is about to be deleted
 * - A non-collapsed selection covers code-formatted text (bulk delete)
 *
 * See: https://github.com/facebook/lexical/issues/5518
 */
export function CodeFormatBoundaryPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const clearCodeIfNeeded = (): boolean => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;

      // Non-collapsed selection — if deleting code-formatted text, clear format
      if (!selection.isCollapsed()) {
        const nodes = selection.getNodes();
        const allCode = nodes.every(
          (n) => $isTextNode(n) && n.hasFormat('code')
        );
        if (allCode && selection.hasFormat('code')) {
          selection.toggleFormat('code');
        }
        return false;
      }

      const anchor = selection.anchor;
      const node = anchor.getNode();

      if (!$isTextNode(node) || !node.hasFormat('code')) {
        return false;
      }

      // At the START of a code-formatted node
      if (anchor.offset === 0) {
        if (selection.hasFormat('code')) {
          selection.toggleFormat('code');
        }
        return false;
      }

      // About to delete the LAST character of a code node
      if (node.getTextContentSize() === 1 && anchor.offset === 1) {
        if (selection.hasFormat('code')) {
          selection.toggleFormat('code');
        }
        return false;
      }

      return false;
    };

    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      clearCodeIfNeeded,
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;

        // Non-collapsed — same as backspace
        if (!selection.isCollapsed()) {
          return clearCodeIfNeeded();
        }

        // Collapsed at the END of a code node — forward-delete exits code
        const anchor = selection.anchor;
        const node = anchor.getNode();
        if (
          $isTextNode(node) &&
          node.hasFormat('code') &&
          anchor.offset === node.getTextContentSize()
        ) {
          if (selection.hasFormat('code')) {
            selection.toggleFormat('code');
          }
        }

        // Last character — forward-delete
        else if (
          $isTextNode(node) &&
          node.hasFormat('code') &&
          node.getTextContentSize() === 1
        ) {
          if (selection.hasFormat('code')) {
            selection.toggleFormat('code');
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterBackspace();
      unregisterDelete();
    };
  }, [editor]);

  return null;
}

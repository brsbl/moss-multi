// ported-from: packages/desktop/src/renderer/editor/TabIndentPlugin.tsx @ 762abb777
import { useEffect } from 'react';

import { $isListItemNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $findMatchingParent, mergeRegister } from '@lexical/utils';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_NORMAL,
  INDENT_CONTENT_COMMAND,
  KEY_TAB_COMMAND,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';

function selectionIsInList() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return false;
  }

  const anchorNode = selection.anchor.getNode();
  if ($isListItemNode(anchorNode)) {
    return true;
  }

  return Boolean($findMatchingParent(anchorNode, (parent) => $isListItemNode(parent)));
}

export function TabIndentPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return mergeRegister(
      // Tab key: only indent/outdent when inside a list
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event) => {
          const shouldHandle = editor.getEditorState().read(selectionIsInList);
          if (!shouldHandle) {
            return false;
          }

          event?.preventDefault();
          event?.stopPropagation();

          const command = event?.shiftKey ? OUTDENT_CONTENT_COMMAND : INDENT_CONTENT_COMMAND;
          editor.dispatchCommand(command, undefined);

          return true;
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      // Block indent/outdent commands for non-list elements.
      // Lexical's built-in handler (COMMAND_PRIORITY_EDITOR) applies
      // padding-inline-start to any block element. We intercept at
      // NORMAL priority to prevent that for paragraphs and headings.
      editor.registerCommand(
        INDENT_CONTENT_COMMAND,
        () => {
          const inList = selectionIsInList();
          // Return true (handled) to block the command for non-list nodes
          return !inList;
        },
        COMMAND_PRIORITY_NORMAL
      ),
      editor.registerCommand(
        OUTDENT_CONTENT_COMMAND,
        () => {
          const inList = selectionIsInList();
          return !inList;
        },
        COMMAND_PRIORITY_NORMAL
      )
    );
  }, [editor]);

  return null;
}

export default TabIndentPlugin;

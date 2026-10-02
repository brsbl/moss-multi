// ported-from: packages/desktop/src/renderer/editor/AutoDividerPlugin.tsx @ 762abb777
import { useEffect } from 'react';

import { CodeNode } from '@lexical/code';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createHorizontalRuleNode,
  HorizontalRuleNode
} from '@lexical/react/LexicalHorizontalRuleNode';
import {
  $createParagraphNode,
  $createTextNode,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ENTER_COMMAND,
  TextNode
} from 'lexical';

// AutoArrowPlugin converts '--' to em-dash (\u2014) before the third dash is
// typed, so '---' becomes '\u2014-'. Match both the literal dashes and the
// em-dash variant so the conversion still triggers.
const HR_PATTERN = /^(-{3,}|\u2014-+)\s*$/;

/**
 * Plugin that transforms '---' at the start of a line into a horizontal rule.
 * Triggers on Enter key when the current line contains only '---'.
 */
export function AutoDividerPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Ensure HorizontalRuleNode is registered
    if (!editor.hasNodes([HorizontalRuleNode])) {
      return;
    }

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();

        // Must be a TextNode
        if (!(anchorNode instanceof TextNode)) {
          return false;
        }

        // Skip if inside code block
        const parent = anchorNode.getParent();
        if (parent instanceof CodeNode) {
          return false;
        }

        // Skip inline code spans
        if (anchorNode.hasFormat('code')) {
          return false;
        }

        // Check if text is exactly '---' (or more dashes), or em-dash + dashes
        const textContent = anchorNode.getTextContent();
        if (!HR_PATTERN.test(textContent.trim())) {
          return false;
        }

        // Only transform if this is the only child of a paragraph
        if (!$isParagraphNode(parent)) {
          return false;
        }

        const siblings = parent.getChildren();
        if (siblings.length !== 1) {
          return false;
        }

        // Prevent default Enter behavior
        event?.preventDefault();

        // Replace the paragraph with a horizontal rule
        const hrNode = $createHorizontalRuleNode();
        parent.replace(hrNode);

        // Create a new paragraph after for continued typing
        const newParagraph = $createParagraphNode();
        newParagraph.append($createTextNode(''));
        hrNode.insertAfter(newParagraph);
        newParagraph.selectEnd();

        return true;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor]);

  return null;
}

export default AutoDividerPlugin;

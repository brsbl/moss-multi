// ported-from: packages/desktop/src/renderer/editor/hooks/useDecoratorBackspace.ts @ 762abb777
/**
 * Shared hook for backspace-to-edit behavior on DecoratorNodes (pills)
 *
 * When backspace is pressed on a pill node, instead of deleting it,
 * the pill is converted back to editable text so the user can modify it.
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isNodeSelection,
  $isRangeSelection,
  $isElementNode,
  $createTextNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_BACKSPACE_COMMAND,
  type LexicalNode,
  type TextNode
} from 'lexical';

export interface DecoratorBackspaceConfig<T extends LexicalNode> {
  /** Type guard to check if a node is the target DecoratorNode type */
  isTargetNode: (node: LexicalNode | null | undefined) => node is T;
  /** Extract the editable text from the node (e.g., "=formula", "[[title", "@name") */
  getEditableText: (node: T) => string;
  /** Optional hook invoked when a decorator node is converted back to text */
  onConvert?: (targetNode: T, textNode: TextNode) => void;
}

/**
 * Hook that registers a backspace command handler for a specific DecoratorNode type.
 *
 * Handles three cases:
 * 1. NodeSelection: When the pill is directly selected
 * 2. RangeSelection at offset 0: When cursor is right after the pill
 * 3. ElementNode with trailing pill: When paragraph ends with the pill
 *
 * @example
 * useDecoratorBackspace({
 *   isTargetNode: $isFormulaNode,
 *   getEditableText: (node) => `=${node.getFormula()}`
 * });
 */
export function useDecoratorBackspace<T extends LexicalNode>({
  isTargetNode,
  getEditableText,
  onConvert
}: DecoratorBackspaceConfig<T>): void {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event: KeyboardEvent) => {
        if (!editor.isEditable()) {
          return false;
        }

        const selection = $getSelection();

        // Case 1: NodeSelection (pill is directly selected)
        if ($isNodeSelection(selection)) {
          const nodes = selection.getNodes();
          if (nodes.length === 1 && isTargetNode(nodes[0])) {
            event.preventDefault();
            const targetNode = nodes[0];
            const editableText = getEditableText(targetNode);
            const textNode = $createTextNode(editableText);
            targetNode.replace(textNode);
            onConvert?.(targetNode, textNode);
            textNode.select(editableText.length, editableText.length);
            return true;
          }
        }

        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        const offset = anchor.offset;

        // Case 2: Cursor at start of text node that follows the pill
        if (offset === 0) {
          const prevSibling = anchorNode.getPreviousSibling();

          if (isTargetNode(prevSibling)) {
            event.preventDefault();
            const editableText = getEditableText(prevSibling);
            const textNode = $createTextNode(editableText);
            prevSibling.replace(textNode);
            onConvert?.(prevSibling, textNode);
            textNode.select(editableText.length, editableText.length);
            return true;
          }
        }

        // Case 3: Cursor in an element where the last child is the pill
        if ($isElementNode(anchorNode)) {
          const children = anchorNode.getChildren();
          for (let i = children.length - 1; i >= 0; i--) {
            const child = children[i];
            if (isTargetNode(child)) {
              event.preventDefault();
              const editableText = getEditableText(child);
              const textNode = $createTextNode(editableText);
              child.replace(textNode);
              onConvert?.(child, textNode);
              textNode.select(editableText.length, editableText.length);
              return true;
            }
            // Stop at first non-target node
            break;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor, getEditableText, isTargetNode, onConvert]);
}

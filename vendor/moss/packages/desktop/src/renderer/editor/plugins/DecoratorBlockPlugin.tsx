// ported-from: packages/desktop/src/renderer/editor/plugins/DecoratorBlockPlugin.tsx @ 762abb777
/**
 * DecoratorBlockPlugin - Shared navigation for block-level DecoratorNodes
 *
 * Handles keyboard navigation and click-to-insert for block-level decorator nodes
 * like ChartNode and ImageNode that don't have internal text content to navigate within.
 *
 * - Arrow up when node is selected → select existing block/text above
 * - Arrow down when node is selected → select existing block/text below
 * - Enter when node is selected → insert paragraph below
 * - Backspace/Delete when node is selected → delete the node
 * - Click in margin areas → create insertion point
 *
 * All block decorator nodes should use `data-block-decorator-key` attribute
 * on their container for consistent click handling.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createNodeSelection,
  $createParagraphNode,
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  CLICK_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
  type LexicalNode
} from 'lexical';
import {
  $isHorizontalRuleNode
} from '@lexical/react/LexicalHorizontalRuleNode';
import { $isTableNode } from '@lexical/table';
import { $isCalloutNode } from '../nodes/CalloutNode';
import { $isChartNode } from '../nodes/ChartNode';
import { $isCodeBlockNode } from '../nodes/CodeBlockNode';
import { $isImageNode } from '../nodes/ImageNode';
import { $isHtmlBlockquoteNode } from '../nodes/HtmlBlockquoteNode';
import { $isSketchNode } from '../nodes/SketchNode';
import { $isTabGroupNode } from '../nodes/TabGroupNode';
import { $isVideoNode } from '../nodes/VideoNode';
import { $isWebEmbedNode } from '../nodes/WebEmbedNode';
import { insertParagraphAdjacentToBlock } from '../utils/block-node-insertion';
import { isCommentUiOpen } from '../utils/comment-ui-open-flag';

/**
 * Check if a node is a block-level decorator we should handle.
 * Also includes TabGroupNode (ElementNode) which uses data-block-decorator-key
 * for consistent click-to-select and keyboard navigation.
 */
function $isBlockDecoratorNode(node: LexicalNode | null): boolean {
  if (!node) return false;
  return $isCalloutNode(node)
    || $isChartNode(node)
    || $isCodeBlockNode(node)
    || $isImageNode(node)
    || $isSketchNode(node)
    || $isHtmlBlockquoteNode(node)
    || $isTabGroupNode(node)
    || $isTableNode(node)
    || $isVideoNode(node)
    || $isWebEmbedNode(node);
}

/**
 * Check if a node is any block-level decorator, including HorizontalRuleNode.
 * Used for backspace-to-select behavior where we also want to select HR nodes.
 */
function $isAnyBlockDecorator(node: LexicalNode | null): boolean {
  return $isBlockDecoratorNode(node) || $isHorizontalRuleNode(node);
}

/**
 * Get the top-level block containing the given node.
 * Walks up until the parent is root.
 */
function $getTopLevelBlock(node: LexicalNode): LexicalNode {
  let current = node;
  while (current.getParent() && current.getParent() !== $getRoot()) {
    current = current.getParent()!;
  }
  return current;
}

function $getFirstDescendant(node: LexicalNode): LexicalNode {
  let current = node;
  while ($isElementNode(current) && current.getFirstChild()) {
    current = current.getFirstChild()!;
  }
  return current;
}

function $getLastDescendant(node: LexicalNode): LexicalNode {
  let current = node;
  while ($isElementNode(current) && current.getLastChild()) {
    current = current.getLastChild()!;
  }
  return current;
}

function $getDirectChildOfBlock(node: LexicalNode, block: LexicalNode): LexicalNode | null {
  let current: LexicalNode | null = node;
  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (parent === block) return current;
    current = parent;
  }
  return null;
}

function $isSelectionAtBlockStart(block: LexicalNode): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

  const anchor = selection.anchor;
  if ($isElementNode(block) && anchor.key === block.getKey() && anchor.offset === 0) {
    return true;
  }

  if (!$isElementNode(block)) return false;
  const firstChild = block.getFirstChild();
  if (!firstChild) return true;

  const directChild = $getDirectChildOfBlock(anchor.getNode(), block);
  if (directChild !== firstChild) return false;

  const firstDescendant = $getFirstDescendant(firstChild);
  return anchor.key === firstDescendant.getKey() && anchor.offset === 0;
}

function $isSelectionAtBlockEnd(block: LexicalNode): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

  const anchor = selection.anchor;
  if ($isElementNode(block) && anchor.key === block.getKey() && anchor.offset === block.getChildrenSize()) {
    return true;
  }

  if (!$isElementNode(block)) return false;
  const lastChild = block.getLastChild();
  if (!lastChild) return true;

  const directChild = $getDirectChildOfBlock(anchor.getNode(), block);
  if (directChild !== lastChild) return false;

  const lastDescendant = $getLastDescendant(lastChild);
  if (anchor.key !== lastDescendant.getKey()) return false;

  if ($isTextNode(lastDescendant)) {
    return anchor.offset === lastDescendant.getTextContentSize();
  }
  if ($isElementNode(lastDescendant)) {
    return anchor.offset === lastDescendant.getChildrenSize();
  }
  return true;
}

/**
 * Select a node with a NodeSelection
 */
function scrollNodeIntoView(editor: LexicalEditor, nodeKey: string): void {
  const scroll = () => {
    const element = editor.getElementByKey(nodeKey);
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest', behavior: 'auto' });
    }
  };

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(scroll);
    return;
  }

  scroll();
}

function $selectNode(editor: LexicalEditor, node: LexicalNode): void {
  const nodeSelection = $createNodeSelection();
  const nodeKey = node.getKey();
  nodeSelection.add(nodeKey);
  $setSelection(nodeSelection);
  scrollNodeIntoView(editor, nodeKey);
}

/**
 * Get the selected block decorator node if exactly one is selected
 */
function $getSelectedBlockDecorator(): LexicalNode | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) {
    return null;
  }

  const nodes = selection.getNodes();
  if (nodes.length !== 1) {
    return null;
  }

  const node = nodes[0];
  if (!$isBlockDecoratorNode(node)) {
    return null;
  }

  return node;
}

function $getSelectedAnyBlockDecorator(): LexicalNode | null {
  const selection = $getSelection();
  if (!$isNodeSelection(selection)) {
    return null;
  }

  const nodes = selection.getNodes();
  if (nodes.length !== 1 || !$isAnyBlockDecorator(nodes[0])) {
    return null;
  }

  return nodes[0];
}

/**
 * Check if a node is an empty paragraph (no children, or a single empty TextNode)
 */
function $isEmptyParagraph(node: LexicalNode): boolean {
  if (!$isParagraphNode(node)) return false;
  const children = node.getChildren();
  if (children.length === 0) return true;
  if (children.length === 1 && $isTextNode(children[0]) && children[0].getTextContent() === '') return true;
  return false;
}

/**
 * Insert paragraph and select it
 */
function $insertParagraphAt(node: LexicalNode, position: 'before' | 'after'): void {
  const paragraph = $createParagraphNode();

  if (position === 'before') {
    node.insertBefore(paragraph);
  } else {
    node.insertAfter(paragraph);
  }

  paragraph.select();
}

/**
 * Place a collapsed caret beside a block (a "gap cursor"). Reuses an adjacent
 * text-editable block when one exists; otherwise inserts an empty paragraph to
 * host the caret. Used for nodes like the horizontal rule where a caret can't
 * land on the node itself, so clicking it would otherwise swallow the cursor.
 */
export function $placeGapCaret(node: LexicalNode, position: 'before' | 'after'): void {
  const sibling = position === 'before'
    ? node.getPreviousSibling()
    : node.getNextSibling();

  if (sibling && $isElementNode(sibling) && !$isBlockDecoratorNode(sibling)) {
    if (position === 'before') {
      sibling.selectEnd();
    } else {
      sibling.selectStart();
    }
    return;
  }

  insertParagraphAdjacentToBlock(node, position);
}

// The divider's visible target is much taller than its 1px <hr> line — the line
// sits inside a tall vertical margin. Treat the gap just above/below the line as
// part of the divider so a near-click still lands a gap caret instead of being
// swallowed.
const DIVIDER_GAP_HIT_PADDING_PX = 12;

/**
 * Resolve the horizontal rule a click targets, treating the visible gap around
 * the 1px line as part of the divider. Returns null when the click belongs to
 * real content (text blocks, inputs, other decorators), which own their caret.
 */
export function findDividerForClick(
  event: MouseEvent,
  rootElement: HTMLElement
): HTMLElement | null {
  if (isCommentUiOpen()) return null;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return null;

  const direct = target.closest('hr');
  if (direct instanceof HTMLElement && rootElement.contains(direct)) {
    return direct;
  }

  // Clicks that land on real content own their own caret/selection — never
  // reinterpret those as divider clicks.
  if (
    target.closest(
      'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, textarea, input, [data-block-decorator-key]'
    )
  ) {
    return null;
  }

  // Otherwise this is empty editor/gap space: route to a divider whose line,
  // expanded by the gap padding, contains the click point.
  for (const hr of Array.from(rootElement.querySelectorAll('hr'))) {
    if (!(hr instanceof HTMLElement)) continue;
    const rect = hr.getBoundingClientRect();
    if (
      event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top - DIVIDER_GAP_HIT_PADDING_PX &&
      event.clientY <= rect.bottom + DIVIDER_GAP_HIT_PADDING_PX
    ) {
      return hr;
    }
  }

  return null;
}

/**
 * Navigate to an existing sibling. Arrow navigation must not mutate content;
 * before/after paragraph insertion is owned by each node's explicit GapCursor.
 */
function $navigateToSibling(editor: LexicalEditor, node: LexicalNode, direction: 'before' | 'after'): void {
  const sibling = direction === 'before'
    ? node.getPreviousSibling()
    : node.getNextSibling();

  if (sibling && $isAnyBlockDecorator(sibling)) {
    $selectNode(editor, sibling);
  } else if (sibling) {
    if ('selectEnd' in sibling && typeof sibling.selectEnd === 'function') {
      if (direction === 'before') {
        sibling.selectEnd();
      } else {
        (sibling as { selectStart: () => void }).selectStart();
      }
    }
  }
}

/**
 * Plugin that enables keyboard navigation for block-level DecoratorNodes.
 */
export function DecoratorBlockPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const rootElement = editor.getRootElement();
    if (!rootElement) {
      return;
    }

    const getGapCursorTarget = (target: EventTarget | null): {
      nodeKey: string;
      position: 'before' | 'after';
    } | null => {
      if (isCommentUiOpen()) {
        return null;
      }

      if (!(target instanceof HTMLElement)) {
        return null;
      }

      const gapCursor = target.closest('[data-block-gap-cursor]') as HTMLElement | null;
      if (!gapCursor || !rootElement.contains(gapCursor)) {
        return null;
      }

      const position = gapCursor.getAttribute('data-block-gap-cursor');
      if (position !== 'before' && position !== 'after') {
        return null;
      }

      const block = gapCursor.closest('[data-block-decorator-key]') as HTMLElement | null;
      const nodeKey = block?.getAttribute('data-block-decorator-key');
      return nodeKey ? { nodeKey, position } : null;
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (!getGapCursorTarget(event.target)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const target = getGapCursorTarget(event.target);
      if (!target) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      editor.update(() => {
        const node = $getNodeByKey(target.nodeKey);
        if (node && $isBlockDecoratorNode(node)) {
          insertParagraphAdjacentToBlock(node, target.position);
        }
      });
    };

    rootElement.addEventListener('mousedown', handleMouseDown);
    rootElement.addEventListener('click', handleClick);
    return () => {
      rootElement.removeEventListener('mousedown', handleMouseDown);
      rootElement.removeEventListener('click', handleClick);
    };
  }, [editor]);

  useEffect(() => {
    // Arrow up → navigate above
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        // Let browser/Lexical handle modified arrows (Cmd+Up = start of doc, Shift = extend selection, etc.)
        if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;

        const node = $getSelectedBlockDecorator();
        if (!node) return false;

        event?.preventDefault();
        $navigateToSibling(editor, node, 'before');
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Arrow down → navigate below
    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;

        const node = $getSelectedBlockDecorator();
        if (!node) return false;

        event?.preventDefault();
        $navigateToSibling(editor, node, 'after');
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Enter → insert paragraph below
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        const node = $getSelectedBlockDecorator();
        if (!node) return false;

        event?.preventDefault();
        $insertParagraphAt(node, 'after');
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Backspace → delete node, clean up trailing empty paragraph, and select previous (when decorator is NodeSelected)
    const unregisterBackspace = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const node = $getSelectedAnyBlockDecorator();
        if (!node) return false;

        event?.preventDefault();
        const prev = node.getPreviousSibling();
        const next = node.getNextSibling();
        node.remove();

        // Remove trailing empty paragraph that was below the decorator
        if (next && $isEmptyParagraph(next)) {
          next.remove();
        }

        if (prev && 'selectEnd' in prev && typeof prev.selectEnd === 'function') {
          prev.selectEnd();
        }
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Arrow up from text after a decorator → select the decorator
    const unregisterArrowUpFromText = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        const topBlock = $getTopLevelBlock(anchorNode);
        const prevSibling = topBlock.getPreviousSibling();
        if (!prevSibling || !$isAnyBlockDecorator(prevSibling)) return false;

        // Only intercept if cursor is on the first visual line of the block.
        // Compare cursor rect to the block element's top — if within 5px, it's the first line.
        if (!$isSelectionAtBlockStart(topBlock)) {
          const anchorDOM = editor.getElementByKey(topBlock.getKey());
          if (!anchorDOM) return false;
          const domSelection = window.getSelection();
          if (domSelection && domSelection.rangeCount > 0) {
            const range = domSelection.getRangeAt(0);
            const rects = range.getClientRects();
            const cursorRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
            const blockRect = anchorDOM.getBoundingClientRect();
            if (cursorRect.top - blockRect.top > 5) return false;
          }
        }

        event?.preventDefault();
        $selectNode(editor, prevSibling);
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Arrow down from text before a decorator → select the decorator
    const unregisterArrowDownFromText = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (event && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;

        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const anchorNode = selection.anchor.getNode();
        const topBlock = $getTopLevelBlock(anchorNode);
        const nextSibling = topBlock.getNextSibling();
        if (!nextSibling || !$isAnyBlockDecorator(nextSibling)) return false;

        // Only intercept if cursor is on the last visual line of the block
        if (!$isSelectionAtBlockEnd(topBlock)) {
          const anchorDOM = editor.getElementByKey(topBlock.getKey());
          if (!anchorDOM) return false;
          const domSelection = window.getSelection();
          if (domSelection && domSelection.rangeCount > 0) {
            const range = domSelection.getRangeAt(0);
            const rects = range.getClientRects();
            const cursorRect = rects.length > 0 ? rects[0] : range.getBoundingClientRect();
            const blockRect = anchorDOM.getBoundingClientRect();
            if (blockRect.bottom - cursorRect.bottom > 5) return false;
          }
        }

        event?.preventDefault();
        $selectNode(editor, nextSibling);
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Backspace at offset 0 after a decorator → select the decorator
    const unregisterBackspaceFromText = editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

        const { anchor } = selection;
        if (anchor.offset !== 0) return false;

        // Get the anchor node and walk up to the top-level block
        const anchorNode = anchor.getNode();
        const topBlock = $getTopLevelBlock(anchorNode);

        // Check if cursor is at the very start of this top-level block. Use
        // the shared helper so list/checklist first items below a divider are
        // treated like paragraphs instead of falling through as nested nodes.
        if (!$isSelectionAtBlockStart(topBlock)) return false;

        const prevSibling = topBlock.getPreviousSibling();
        if (!prevSibling || !$isAnyBlockDecorator(prevSibling)) return false;

        event?.preventDefault();
        // If the paragraph is empty, remove it before selecting the decorator
        if ($isEmptyParagraph(topBlock)) {
          topBlock.remove();
        }
        $selectNode(editor, prevSibling);
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    // Delete → delete node and select next
    const unregisterDelete = editor.registerCommand(
      KEY_DELETE_COMMAND,
      (event) => {
        const node = $getSelectedAnyBlockDecorator();
        if (!node) return false;

        event?.preventDefault();
        const next = node.getNextSibling();
        node.remove();

        if (next && 'selectStart' in next && typeof next.selectStart === 'function') {
          (next as { selectStart: () => void }).selectStart();
        }
        return true;
      },
      COMMAND_PRIORITY_LOW
    );

    return () => {
      unregisterArrowUp();
      unregisterArrowDown();
      unregisterArrowUpFromText();
      unregisterArrowDownFromText();
      unregisterEnter();
      unregisterBackspace();
      unregisterBackspaceFromText();
      unregisterDelete();
    };
  }, [editor]);

  // Clicking a horizontal rule (divider) — or the visible gap just above/below
  // its 1px line — places a usable caret beside it (a gap cursor) instead of
  // selecting the node and swallowing the caret. Registered above the
  // HorizontalRuleNode's own CLICK_COMMAND (COMMAND_PRIORITY_LOW) so it wins.
  // Shift+click falls through to Lexical's node selection for multi-select.
  useEffect(() => {
    return editor.registerCommand(
      CLICK_COMMAND,
      (event) => {
        if (event.shiftKey) return false;

        const rootElement = editor.getRootElement();
        if (!rootElement) return false;

        const hrElement = findDividerForClick(event, rootElement);
        if (!hrElement) return false;

        const rect = hrElement.getBoundingClientRect();
        const placeBefore = event.clientY < rect.top + rect.height / 2;

        // Claim the click synchronously from the DOM hit (findDividerForClick
        // only resolves <hr> elements, never real content) and run the caret
        // placement in the update below. CLICK_COMMAND is dispatched from inside
        // Lexical's own onClick update, so this editor.update() is DEFERRED — a
        // `handled` flag set inside it would still be false at return time, we'd
        // return false, and the HorizontalRuleNode's own LOW-priority click
        // handler would select the node and swallow the caret. So the return
        // value must not depend on the deferred update.
        event.preventDefault();
        editor.update(() => {
          const node = $getNearestNodeFromDOMNode(hrElement);
          if ($isHorizontalRuleNode(node)) {
            $placeGapCaret(node, placeBefore ? 'before' : 'after');
          }
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor]);

  return null;
}

export default DecoratorBlockPlugin;

// ported-from: packages/desktop/src/renderer/editor/plugins/TabExitPlugin.tsx @ 762abb777
/**
 * TabExitPlugin - Keyboard navigation for entering/exiting tab groups
 *
 * Since all TabPanelNodes exist in the Lexical tree (inactive ones have
 * display:none), arrow keys could navigate into invisible content.
 * This plugin intercepts navigation at panel boundaries:
 * - Arrow up at panel start → exit to node above tab group
 * - Arrow down at panel end → exit to node below tab group
 * - Arrow left at panel start → exit to node before tab group
 * - Arrow right at panel end → exit to node after tab group
 */

import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isListItemNode } from '@lexical/list';
import {
  $createParagraphNode,
  $getSelection,
  $getNearestRootOrShadowRoot,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalNode
} from 'lexical';
import { $isTabPanelNode, type TabPanelNode } from '../nodes/TabPanelNode';
import { $isTabGroupNode, type TabGroupNode } from '../nodes/TabGroupNode';
import {
  $insertParagraphAfterBlock,
  $isSelectionInEmptyParagraph,
  $removeEmptyParagraphAtSelection,
  createBlockEndEnterTracker,
  isPlainEnterEvent
} from '../utils/block-node-double-enter';

type PanelContext = { panel: TabPanelNode; tabGroup: TabGroupNode };

/** Walk up from a node to find the direct child of the panel */
function $getDirectPanelChild(node: LexicalNode, panel: TabPanelNode): LexicalNode | null {
  let current: LexicalNode | null = node;
  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (parent === panel) return current;
    current = parent;
  }
  return null;
}

function $hasListItemAncestorBeforePanel(node: LexicalNode, panel: TabPanelNode): boolean {
  let current: LexicalNode | null = node;
  while (current && current !== panel) {
    if ($isListItemNode(current)) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

/** Get the deepest first descendant of a node */
function $getFirstDescendant(node: LexicalNode): LexicalNode {
  let current = node;
  while ($isElementNode(current) && current.getFirstChild()) {
    current = current.getFirstChild()!;
  }
  return current;
}

/** Get the deepest last descendant of a node */
function $getLastDescendant(node: LexicalNode): LexicalNode {
  let current = node;
  while ($isElementNode(current) && current.getLastChild()) {
    current = current.getLastChild()!;
  }
  return current;
}

/** Check if selection is at the very start of a TabPanelNode */
function $isAtPanelStart(): PanelContext | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  const nearestRoot = $getNearestRootOrShadowRoot(anchor.getNode());
  if (!$isTabPanelNode(nearestRoot)) return null;

  const tabGroup = nearestRoot.getParent();
  if (!$isTabGroupNode(tabGroup)) return null;

  // Cursor on the panel element itself at offset 0
  if (anchor.key === nearestRoot.getKey() && anchor.offset === 0) {
    return { panel: nearestRoot, tabGroup };
  }

  // Walk up from anchor to find the direct child of the panel
  const directChild = $getDirectPanelChild(anchor.getNode(), nearestRoot);
  if (!directChild) return null;

  // Must be the first child of the panel
  if (directChild !== nearestRoot.getFirstChild()) return null;

  // The deepest first descendant must be at offset 0
  const firstDesc = $getFirstDescendant(nearestRoot.getFirstChild()!);
  if (anchor.key === firstDesc.getKey() && anchor.offset === 0) {
    if ($hasListItemAncestorBeforePanel(anchor.getNode(), nearestRoot)) return null;
    return { panel: nearestRoot, tabGroup };
  }

  return null;
}

/** Check if selection is at the very end of a TabPanelNode */
function $isAtPanelEnd(): PanelContext | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;

  const anchor = selection.anchor;
  const nearestRoot = $getNearestRootOrShadowRoot(anchor.getNode());
  if (!$isTabPanelNode(nearestRoot)) return null;

  const tabGroup = nearestRoot.getParent();
  if (!$isTabGroupNode(tabGroup)) return null;

  // Cursor on the panel element at last offset
  if (anchor.key === nearestRoot.getKey() && anchor.offset === nearestRoot.getChildrenSize()) {
    return { panel: nearestRoot, tabGroup };
  }

  // Walk up from anchor to find the direct child of the panel
  const directChild = $getDirectPanelChild(anchor.getNode(), nearestRoot);
  if (!directChild) return null;

  // Must be the last child of the panel
  if (directChild !== nearestRoot.getLastChild()) return null;

  // The deepest last descendant must be at its end
  const lastDesc = $getLastDescendant(nearestRoot.getLastChild()!);
  if (anchor.key === lastDesc.getKey()) {
    if ($hasListItemAncestorBeforePanel(anchor.getNode(), nearestRoot)) return null;
    if ($isTextNode(lastDesc)) {
      if (anchor.offset === lastDesc.getTextContentSize()) {
        return { panel: nearestRoot, tabGroup };
      }
    } else if ($isElementNode(lastDesc)) {
      if (anchor.offset === lastDesc.getChildrenSize()) {
        return { panel: nearestRoot, tabGroup };
      }
    } else {
      // Leaf node (not text) — at any offset means at the end
      return { panel: nearestRoot, tabGroup };
    }
  }

  return null;
}

/** Check if this panel is the currently active (visible) one */
function $isActivePanel(panel: TabPanelNode, tabGroup: TabGroupNode): boolean {
  const panels = tabGroup.getTabPanels();
  const myIndex = panels.indexOf(panel);
  return myIndex === tabGroup.getActiveIndex();
}

/** Select the end of a sibling node, or insert a paragraph before the tab group */
function $exitBefore(tabGroup: TabGroupNode): void {
  const prev = tabGroup.getPreviousSibling();
  if (prev && 'selectEnd' in prev && typeof prev.selectEnd === 'function') {
    prev.selectEnd();
  } else if (prev) {
    prev.selectPrevious();
  } else {
    const paragraph = $createParagraphNode();
    tabGroup.insertBefore(paragraph);
    paragraph.select();
  }
}

/** Select the start of a sibling node, or insert a paragraph after the tab group */
function $exitAfter(tabGroup: TabGroupNode): void {
  const next = tabGroup.getNextSibling();
  if (next && 'selectStart' in next && typeof next.selectStart === 'function') {
    next.selectStart();
  } else if (next) {
    next.selectNext();
  } else {
    const paragraph = $createParagraphNode();
    tabGroup.insertAfter(paragraph);
    paragraph.select();
  }
}

export function TabExitPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const enterTrackerRef = useRef(createBlockEndEnterTracker());

  useEffect(() => {
    // Arrow Up: at start of active panel, exit to node above tab group
    const unregUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        const ctx = $isAtPanelStart();
        if (!ctx || !$isActivePanel(ctx.panel, ctx.tabGroup)) return false;
        event?.preventDefault();
        $exitBefore(ctx.tabGroup);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    // Arrow Down: at end of active panel, exit to node below tab group
    const unregDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        const ctx = $isAtPanelEnd();
        if (!ctx || !$isActivePanel(ctx.panel, ctx.tabGroup)) return false;
        event?.preventDefault();
        $exitAfter(ctx.tabGroup);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    // Arrow Left: at start of active panel, prevent moving into hidden panel
    const unregLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        const ctx = $isAtPanelStart();
        if (!ctx || !$isActivePanel(ctx.panel, ctx.tabGroup)) return false;
        event?.preventDefault();
        $exitBefore(ctx.tabGroup);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    // Arrow Right: at end of active panel, prevent moving into hidden panel
    const unregRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        const ctx = $isAtPanelEnd();
        if (!ctx || !$isActivePanel(ctx.panel, ctx.tabGroup)) return false;
        event?.preventDefault();
        $exitAfter(ctx.tabGroup);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    const unregEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!isPlainEnterEvent(event)) {
          enterTrackerRef.current.clear();
          return false;
        }

        const ctx = $isAtPanelEnd();
        if (!ctx || !$isActivePanel(ctx.panel, ctx.tabGroup)) {
          enterTrackerRef.current.clear();
          return false;
        }

        const selection = $getSelection();
        const isSecondEnter =
          $isRangeSelection(selection) &&
          enterTrackerRef.current.isSecondEnter(ctx.tabGroup.getKey()) &&
          $isSelectionInEmptyParagraph(selection.anchor.getNode(), ctx.panel);

        if (!isSecondEnter) {
          enterTrackerRef.current.mark(ctx.tabGroup.getKey());
          return false;
        }

        event?.preventDefault();
        enterTrackerRef.current.clear();
        if ($isRangeSelection(selection)) {
          $removeEmptyParagraphAtSelection(selection.anchor.getNode(), ctx.panel);
        }
        $insertParagraphAfterBlock(ctx.tabGroup);
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      unregUp();
      unregDown();
      unregLeft();
      unregRight();
      unregEnter();
    };
  }, [editor]);

  return null;
}

export default TabExitPlugin;

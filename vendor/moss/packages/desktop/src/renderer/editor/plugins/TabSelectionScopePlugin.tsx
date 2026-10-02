// ported-from: packages/desktop/src/renderer/editor/plugins/TabSelectionScopePlugin.tsx @ 762abb777
/**
 * TabSelectionScopePlugin - Keeps a selection that starts inside a tab panel
 * from reaching across the rest of the tab group.
 *
 * Inactive TabPanelNodes stay in the document, hidden with `display: none`
 * (see TabBarPlugin's `updatePanelVisibility`). They are still ordinary
 * ElementNodes, so a selection anchored in the visible panel silently spans
 * every hidden sibling panel: select-all inside a tab selects the whole note,
 * and a drag that leaves the group's visible box lands its focus after the
 * group. Anything that consumes that selection then over-reaches --
 * cut deletes the sibling tabs, copy puts the entire group on the clipboard,
 * and pasting over it replaces the note with a duplicated group.
 *
 * The fix is to scope the selection itself, so every consumer (cut, copy,
 * delete, typing, paste-over-selection) inherits the correct bounds:
 * - SELECT_ALL inside a panel selects that panel only.
 * - Any selection straddling a panel boundary is clamped back to the panel
 *   the anchor sits in. When the anchor is outside and the focus reached into
 *   a panel, the focus snaps out to the tab group's own boundary so the group
 *   is taken as a whole unit instead of being partially gutted.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $selectAll,
  COMMAND_PRIORITY_CRITICAL,
  COPY_COMMAND,
  CUT_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_LINE_COMMAND,
  DELETE_WORD_COMMAND,
  SELECT_ALL_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalCommand,
  type LexicalNode,
  type RangeSelection
} from 'lexical';
import { $isTabGroupNode } from '../nodes/TabGroupNode';
import { $isTabPanelNode, type TabPanelNode } from '../nodes/TabPanelNode';

/** Nearest enclosing tab panel, or null when the node sits outside every panel. */
function $getTabPanelAncestor(node: LexicalNode | null): TabPanelNode | null {
  let current: LexicalNode | null = node;
  while (current !== null) {
    if ($isTabPanelNode(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Find the outermost nested tab group between `panel` and a descendant panel.
 * Returning the group whose parent is `panel` lets the caller clamp around the
 * nested group without extending to the end of the outer panel.
 */
function $getNestedTabGroupWithinPanel(
  panel: TabPanelNode,
  descendantPanel: TabPanelNode
): LexicalNode | null {
  let current: LexicalNode | null = descendantPanel;
  let nestedTabGroup: LexicalNode | null = null;

  while (current !== null && !current.is(panel)) {
    if ($isTabGroupNode(current)) {
      nestedTabGroup = current;
    }
    current = current.getParent();
  }

  return current?.is(panel) === true ? nestedTabGroup : null;
}

/**
 * Clamp a selection that straddles a tab panel boundary.
 *
 * @returns true when the selection was narrowed.
 */
export function $scopeSelectionToTabPanel(selection: RangeSelection): boolean {
  const anchorPanel = $getTabPanelAncestor(selection.anchor.getNode());
  const focusPanel = $getTabPanelAncestor(selection.focus.getNode());
  if (anchorPanel === focusPanel) {
    return false;
  }

  const isBackward = selection.isBackward();

  if (anchorPanel !== null) {
    if (focusPanel !== null) {
      const nestedTabGroup = $getNestedTabGroupWithinPanel(anchorPanel, focusPanel);
      if (nestedTabGroup?.getParent()?.is(anchorPanel)) {
        const groupIndex = nestedTabGroup.getIndexWithinParent();
        selection.focus.set(
          anchorPanel.getKey(),
          isBackward ? groupIndex : groupIndex + 1,
          'element'
        );
        return true;
      }
    }

    // Selection started inside a panel: it may not leave it.
    selection.focus.set(
      anchorPanel.getKey(),
      isBackward ? 0 : anchorPanel.getChildrenSize(),
      'element'
    );
    return true;
  }

  // Selection started outside and reached into a panel. Snap the focus to the
  // tab group's own boundary: the group is selected whole, never half.
  const tabGroup = focusPanel === null ? null : focusPanel.getParent();
  if (!$isTabGroupNode(tabGroup)) {
    return false;
  }
  const groupParent = tabGroup.getParent();
  if (groupParent === null) {
    return false;
  }
  const groupIndex = tabGroup.getIndexWithinParent();
  selection.focus.set(
    groupParent.getKey(),
    isBackward ? groupIndex : groupIndex + 1,
    'element'
  );
  return true;
}

/** Commands whose payload or edit must never outgrow the active tab panel. */
const SCOPED_COMMANDS: LexicalCommand<unknown>[] = [
  SELECTION_CHANGE_COMMAND,
  CUT_COMMAND,
  COPY_COMMAND,
  DELETE_CHARACTER_COMMAND,
  DELETE_WORD_COMMAND,
  DELETE_LINE_COMMAND
];

export function TabSelectionScopePlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterSelectAll = editor.registerCommand(
      SELECT_ALL_COMMAND,
      () => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          return false;
        }
        const anchorNode = selection.anchor.getNode();
        const panel = $getTabPanelAncestor(anchorNode);
        if (panel === null) {
          return false;
        }
        if (anchorNode.is(panel)) {
          // The anchor is the panel element itself, so $selectAll would climb
          // past it to the tab group. Select the panel's children directly.
          selection.anchor.set(panel.getKey(), 0, 'element');
          selection.focus.set(panel.getKey(), panel.getChildrenSize(), 'element');
          return true;
        }
        // TabPanelNode.isShadowRoot() is true, so Lexical's own $selectAll
        // stops at the panel and normalizes the resulting points.
        $selectAll(selection);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL
    );

    const unregisterScoped = SCOPED_COMMANDS.map((command) =>
      editor.registerCommand(
        command,
        () => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $scopeSelectionToTabPanel(selection);
          }
          // Never consume the command -- only correct the selection it runs on.
          return false;
        },
        COMMAND_PRIORITY_CRITICAL
      )
    );

    return () => {
      unregisterSelectAll();
      for (const unregister of unregisterScoped) {
        unregister();
      }
    };
  }, [editor]);

  return null;
}

export default TabSelectionScopePlugin;

// ported-from: packages/desktop/src/renderer/editor/ChecklistSortPlugin.tsx @ 762abb777
/**
 * ChecklistSortPlugin - auto-sorts checked items to the top of their parent list.
 *
 * When a checkbox is toggled, all siblings in the same ListNode are reordered
 * after a short delay: checked items first (preserving relative order), then
 * unchecked items (preserving relative order). The reorder runs inside
 * editor.update() so undo/redo fully restores the previous order.
 */
import { useEffect, useRef } from 'react';

import { $isListItemNode, $isListNode, ListItemNode } from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getNodeByKey } from 'lexical';
// moss-multi seam: whole-paste (T3.S6): a large paste or its redo lands in batches.
import { isLanding } from '@moss-multi/host/collab/landing';

import { EDITOR_UPDATE_TAGS } from './utils/editorUpdateTags';

const SORT_DELAY_MS = 50;
const CHECKLIST_SORT_IGNORED_TAGS = new Set<string>([
  'history-merge',
  // moss-multi seam: local-view (A§10): never sort a peer's update a second time.
  'collaboration',
  EDITOR_UPDATE_TAGS.ignored.agentContentUpdate,
]);

const hasIgnoredSortTag = (updateTags: Set<string>): boolean => {
  for (const tag of CHECKLIST_SORT_IGNORED_TAGS) {
    if (updateTags.has(tag)) {
      return true;
    }
  }
  return false;
};

export function ChecklistSortPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reorderRafRef = useRef<number | null>(null);

  useEffect(() => {
    const unregister = editor.registerMutationListener(ListItemNode, (mutations, { updateTags }) => {
      // A batch of a large paste or its redo adds items to a list placed earlier: not a toggle, never sorted.
      if (!editor.isEditable() || hasIgnoredSortTag(updateTags) || isLanding(editor)) {
        return;
      }

      // Only act on "updated" mutations (checkbox toggles)
      const updatedKeys: string[] = [];
      for (const [key, type] of mutations) {
        if (type === 'updated') {
          updatedKeys.push(key);
        }
      }

      if (updatedKeys.length === 0) return;

      // Clear any pending sort so rapid toggles only sort once
      if (timerRef.current) clearTimeout(timerRef.current);
      if (reorderRafRef.current !== null) {
        cancelAnimationFrame(reorderRafRef.current);
        reorderRafRef.current = null;
      }

      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        reorderRafRef.current = requestAnimationFrame(() => {
          reorderRafRef.current = null;
          if (!editor.isEditable() || editor.getRootElement() === null) {
            return;
          }
          editor.update(() => {
          // Collect unique parent ListNodes that need reordering
          const processedParents = new Set<string>();

          for (const key of updatedKeys) {
            const node = $getNodeByKey(key);
            if (!node || !$isListItemNode(node)) continue;

            const parent = node.getParent();
            if (!parent || !$isListNode(parent) || parent.getListType() !== 'check') continue;

            // Skip if already processed
            const parentKey = parent.getKey();
            if (processedParents.has(parentKey)) continue;
            processedParents.add(parentKey);

            // Gather all direct children (ListItemNodes), grouping wrappers with their owners.
            // A wrapper ListItemNode (children are all ListNodes) belongs to its previous
            // text-bearing sibling — they must move together during reorder.
            const children = parent.getChildren();
            const unchecked: ListItemNode[][] = [];
            const checked: ListItemNode[][] = [];
            let currentGroup: ListItemNode[] | null = null;
            let currentGroupChecked = false;

            for (const child of children) {
              if (!$isListItemNode(child)) continue;
              const childChildren = child.getChildren();
              const isWrapper = childChildren.length > 0 && childChildren.every((n) => $isListNode(n));
              if (isWrapper && currentGroup) {
                // Wrapper follows its owner — append to current group
                currentGroup.push(child);
              } else {
                // Flush previous group
                if (currentGroup) {
                  (currentGroupChecked ? checked : unchecked).push(currentGroup);
                }
                currentGroup = [child];
                currentGroupChecked = child.getChecked() === true;
              }
            }
            if (currentGroup) {
              (currentGroupChecked ? checked : unchecked).push(currentGroup);
            }

            // Check if reorder is needed
            const desired = [...checked, ...unchecked].flat();
            const current = children.filter((c): c is ListItemNode => $isListItemNode(c));
            let needsReorder = false;
            for (let i = 0; i < desired.length; i++) {
              if (desired[i].getKey() !== current[i].getKey()) {
                needsReorder = true;
                break;
              }
            }

            if (!needsReorder) continue;

            // Move checked groups before the first unchecked item.
            // Uses insertBefore (which calls removeFromParent) instead of
            // remove()+append() to avoid ListItemNode.remove()'s merge logic
            // that corrupts nested sub-lists when wrapper nodes become adjacent.
            const firstUncheckedItem = unchecked.length > 0 ? unchecked[0][0] : null;
            if (!firstUncheckedItem) continue; // all checked, nothing to do

            for (const group of checked) {
              for (const item of group) {
                firstUncheckedItem.insertBefore(item);
              }
            }
          }
          }, { tag: 'history-merge' });
        });
      }, SORT_DELAY_MS);
    });

    return () => {
      unregister();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (reorderRafRef.current !== null) {
        cancelAnimationFrame(reorderRafRef.current);
        reorderRafRef.current = null;
      }
    };
  }, [editor]);

  return null;
}

export default ChecklistSortPlugin;

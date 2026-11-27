// ported-from: packages/desktop/src/renderer/prompt/MentionPlugin.tsx @ 762abb777
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useAtomValue, useStore } from 'jotai';
import {
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $createTextNode
} from 'lexical';
import { Plus } from 'lucide-react';

import { useDecoratorBackspace } from '../editor/hooks';
import { useTypeahead } from '../editor/typeahead/useTypeahead';
import type { TypeaheadTriggerConfig, TypeaheadItem } from '../editor/typeahead/types';
import { TypeaheadMenu } from '../editor/typeahead/TypeaheadMenu';
import { mentionSearch } from '../editor/typeahead/mentionSearch';
import {
  connectedFolderEntriesAtom,
  grantNewDirectoryAtom,
  grantedDirsAtom,
  refreshGrantedDirsAtom,
  refreshConnectedFolderEntriesAtom
} from '../state/granted-dirs-atoms';
import { $createMentionNode, $isMentionNode } from './MentionNode';
// moss-multi seam: comments (comments.md §12): a comment's @ menu offers its note's people first
import { PERSON, peopleMatching, useMentionDoc, withPeople } from '@moss-multi/host/comments/mentions';

const DEFAULT_MENTION_TRIGGER: TypeaheadTriggerConfig = {
  trigger: '@',
  requireWordBoundary: true
};

/**
 * MentionPlugin -- Provides @-mention autocomplete for notes and directories
 * inside the PromptInput Lexical editor.
 *
 * Renders a TypeaheadMenu with sectioned results: directories first, then
 * notes grouped by folder name.
 */
export interface MentionState {
  isOpen: boolean;
  selectedIsDrillable: boolean;
}

export function MentionPlugin({
  inline,
  requireWordBoundary = true,
  onMentionStateChange
}: {
  inline?: boolean;
  requireWordBoundary?: boolean;
  onMentionStateChange?: (state: MentionState | null) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const grantedDirs = useAtomValue(grantedDirsAtom);
  const connectedFolderEntries = useAtomValue(connectedFolderEntriesAtom);

  const cacheRefreshedRef = useRef(false);
  const mentionDoc = useMentionDoc(); // moss-multi seam: comments

  // "Connect a folder..." footer — self-contained, available in all mention contexts
  const handleConnectFolder = useCallback(async () => {
    await store.set(grantNewDirectoryAtom);
    // Defer focus to avoid flushSync during React render triggered by atom updates
    queueMicrotask(() => editor.focus());
  }, [store, editor]);

  const connectFolderFooter = useMemo(() => (
    <div className="border-t border-border-default/50 bg-surface-panel/80 rounded-b-lg">
      <button
        type="button"
        onClick={handleConnectFolder}
        onMouseDown={(e) => e.preventDefault()}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-border-subtle/50 rounded-b-lg"
      >
        <Plus className="h-3.5 w-3.5 text-ink-faint" />
        <div>
          <div className="text-xs text-ink-muted">Connect a folder...</div>
          <div className="text-nano text-ink-faint">Grant Moss read access to files outside your workspace</div>
        </div>
      </button>
    </div>
  ), [handleConnectFolder]);

  const onSearch = useCallback(
    (query: string): TypeaheadItem[] | Promise<TypeaheadItem[]> => {
      // Stale-while-revalidate: fire background cache refresh on first search
      // per typeahead open. Cached results show immediately; Jotai reactivity
      // updates the menu if new entries arrive while open.
      if (!cacheRefreshedRef.current) {
        cacheRefreshedRef.current = true;
        return withPeople(peopleMatching(mentionDoc, query, true), (async () => { // moss-multi seam: comments
          const refreshedDirs = await store.set(refreshGrantedDirsAtom);
          void store.set(refreshConnectedFolderEntriesAtom);
          return mentionSearch(query, store, {
            grantedDirs: refreshedDirs ?? grantedDirs,
            connectedFolderEntries
          });
        })());
      }
      return withPeople(peopleMatching(mentionDoc, query), mentionSearch(query, store, { grantedDirs, connectedFolderEntries })); // moss-multi seam: comments
    },
    [connectedFolderEntries, grantedDirs, mentionDoc, store]
  );

  const onSelect = useCallback(
    (item: TypeaheadItem, triggerOffset: number) => {
      editor.update(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return;

        const anchor = selection.anchor;
        const anchorNode = anchor.getNode();
        if (!$isTextNode(anchorNode)) return;

        const textContent = anchorNode.getTextContent();
        const before = textContent.slice(0, triggerOffset);
        const after = textContent.slice(anchor.offset);

        anchorNode.setTextContent(before);

        const dataStr = typeof item.data === 'string' ? item.data : '';
        const mentionType = dataStr === PERSON ? 'person' /* moss-multi seam: comments */ : dataStr === 'directory' || dataStr === 'connected-file' || dataStr.startsWith('connected-subdir:')
          ? 'directory'
          : dataStr === 'folder' ? 'folder'
          : 'note';
        const mentionNode = $createMentionNode(
          item.id,
          item.label,
          mentionType,
          item.description
        );
        anchorNode.insertAfter(mentionNode);

        const trailingText = after || ' ';
        const spaceNode = $createTextNode(trailingText);
        mentionNode.insertAfter(spaceNode);
        spaceNode.select(after ? 0 : 1, after ? 0 : 1);
      });
    },
    [editor]
  );

  const onDrill = useCallback(
    (item: TypeaheadItem): string | null => {
      if (item.data === 'folder') {
        // Moss folder — use the relative path (stored in id) as drill prefix
        return `${item.id}/`;
      }
      const dataStr = typeof item.data === 'string' ? item.data : '';
      if (dataStr === 'directory' || dataStr.startsWith('connected-subdir:')) {
        // Connected folder / external root / cached sub-entry — use the full
        // filesystem path (stored in id) so handleDrillSearch can bypass the
        // Moss folder scan and go directly to the IPC filesystem drill.
        return `${item.id}/`;
      }
      return null;
    },
    []
  );

  const onUndrill = useCallback(
    (currentQuery: string): string | null => {
      // Only handle absolute-path queries (filesystem drills).
      // Relative queries (Moss folders) use the default segment-stripping.
      if (!currentQuery.startsWith('/')) return null;

      // Find which connected folder root this path belongs to.
      // If stripping one segment would go above the root, jump to top-level.
      const roots = [...grantedDirs];

      // Also check external root paths — they may not be in grantedDirs
      const queryWithoutTrailingSlash = currentQuery.replace(/\/$/, '');

      for (const root of roots) {
        const normalizedRoot = root.replace(/\/$/, '');
        if (queryWithoutTrailingSlash === normalizedRoot || queryWithoutTrailingSlash.startsWith(normalizedRoot + '/')) {
          // Strip last segment
          const segments = queryWithoutTrailingSlash.split('/').filter(Boolean);
          segments.pop();
          const parent = '/' + segments.join('/');
          // If parent is above (or at) the root, jump to top-level
          if (parent.length < normalizedRoot.length) {
            return '';
          }
          return parent + '/';
        }
      }

      // No matching root found — jump to top-level to avoid browsing random fs paths
      return '';
    },
    [grantedDirs]
  );

  const mentionTrigger = useMemo<TypeaheadTriggerConfig>(
    () => ({
      ...DEFAULT_MENTION_TRIGGER,
      requireWordBoundary
    }),
    [requireWordBoundary]
  );

  const typeahead = useTypeahead({
    trigger: mentionTrigger,
    onSearch,
    onSelect,
    onDrill,
    onUndrill
  });

  useDecoratorBackspace({
    isTargetNode: $isMentionNode,
    getEditableText: (node) => `@${node.getMentionTitle()}`
  });

  const selectedData = typeof typeahead.results[typeahead.selectedIndex]?.data === 'string'
    ? typeahead.results[typeahead.selectedIndex]?.data as string : '';
  const selectedIsDrillable = selectedData === 'folder'
    || selectedData === 'directory'
    || selectedData.startsWith('connected-subdir:');

  const onMentionStateChangeRef = useRef(onMentionStateChange);
  onMentionStateChangeRef.current = onMentionStateChange;

  useEffect(() => {
    onMentionStateChangeRef.current?.(typeahead.isOpen
      ? { isOpen: true, selectedIsDrillable }
      : null);
    if (!typeahead.isOpen) {
      cacheRefreshedRef.current = false;
    }
    return () => onMentionStateChangeRef.current?.(null);
  }, [typeahead.isOpen, selectedIsDrillable]);

  if (!typeahead.isOpen || !typeahead.position) return null;

  return (
    <TypeaheadMenu
      ref={typeahead.menuRef}
      items={typeahead.results}
      selectedIndex={typeahead.selectedIndex}
      position={typeahead.position}
      onSelect={typeahead.selectItem}
      onClose={typeahead.closeMenu}
      inline={inline}
      footer={undefined /* moss-multi seam: the web has no connected folders (PRODUCT: Connected Folders hidden) */}
    />
  );
}

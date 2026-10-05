// ported-from: packages/desktop/src/renderer/editor/plugins/CommentPlugin.tsx @ 762abb777
/**
 * CommentPlugin - Manages comment annotations on editor text
 *
 * Architecture (markdown-first):
 * - Comments are persisted as inline anchors in note.md (%%m:ID:start%%...%%m:ID:end%%)
 * - Metadata (comment text, timestamps) lives in comments.json beside the note
 * - MarkNodes in the editor tree are the runtime representation
 * - The renderer saves markdown + structured metadata through the note update path
 * - Keyboard shortcut: Cmd+Shift+A to annotate (add comment)
 */
import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { atom, useStore } from 'jotai';
import { atomFamily } from 'jotai-family';
import { $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, $isElementNode, COMMAND_PRIORITY_NORMAL, type LexicalEditor, type LexicalNode } from 'lexical';
import { $isCommentableDecorator } from '../utils/commentable-node';
import { $wrapSelectionInMarkNode, $isMarkNode, MarkNode } from '@lexical/mark';
import { TabGroupNode } from '../nodes/TabGroupNode';
import { USER_COMMENT_COLOR } from '../utils/comment-import';

import {
  commentDirtySignalAtom,
  commentThreadFilterAtom,
  noteCommentAnchorIdsAtom,
  noteCommentsMapAtom,
  type NoteComment
} from '@moss/shared/state/note-atoms';
import { isCommentVisibleForStatus } from '../utils/comment-thread-count';
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { CREATE_COMMENT_COMMAND } from '../commands';
export { CREATE_COMMENT_COMMAND, OPEN_BLOCK_COMMENT_COMMAND } from '../commands';
// moss-multi seam: comments (comments.md §12)
import { createFromCommand } from '@moss-multi/host/comments/adapter';

// ---------------------------------------------------------------------------
// Draft Comment Persistence
// ---------------------------------------------------------------------------

export interface CommentDraft {
  text: string;
  imageUrls?: string[];
  savedAt: number;
}

/** In-memory storage for comment drafts, keyed by target identifier. */
export const commentDraftAtom = atom<Map<string, CommentDraft>>(new Map());

export const DRAFT_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Derives a draft key from the comment input state. */
export function getDraftKey(state: CommentInputState): string | null {
  if (state.targetNodeKey) return `node:${state.targetNodeKey}`;
  if (state.selectedText) return `text:${state.selectedText.slice(0, 50)}`;
  return null;
}

// ---------------------------------------------------------------------------
// Comment Input State Atom
// ---------------------------------------------------------------------------

/**
 * Shared state for the comment input popover.
 * Used by both FloatingSelectionTools (button click) and keyboard shortcut (Cmd+Shift+A).
 */
export interface CommentInputState {
  /** Whether the popover is open */
  open: boolean;
  /** Virtual anchor position for the popover */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Node key when commenting on a block-level decorator (for draft persistence) */
  targetNodeKey?: string;
  /** First ~50 chars of selected text (for draft persistence) */
  selectedText?: string;
  /** Popover placement side — 'top' for decorator nodes, 'bottom' (default) for text selections */
  anchorSide?: 'bottom' | 'top';
  /** Popover alignment — 'end' for decorator nodes (right-aligned), 'start' (default) for text */
  anchorAlign?: 'start' | 'end';
}

/**
 * Atom holding the comment input popover state.
 * Set by FloatingSelectionTools button or keyboard shortcut.
 * Read by the popover component to position and show itself.
 */
export const commentInputStateAtom = atomFamily((_noteId: string) =>
  atom<CommentInputState>({
    open: false,
    anchorRect: null,
  })
);

/**
 * State for the comment viewing/editing popover.
 * Set when clicking a gutter icon or a MarkNode.
 */
export interface ActiveCommentState {
  /** The comment being viewed/edited */
  comment: NoteComment | null;
  /** Static rect snapshot for popover positioning (taken at click time) */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Preferred popover placement for this anchor. */
  anchorPlacement?: 'bottom-end' | 'right-start';
}

/**
 * Atom holding the active comment popover state.
 * When comment is set, CommentPopover is displayed.
 */
export const activeCommentAtom = atomFamily((_noteId: string) =>
  atom<ActiveCommentState>({
    comment: null,
    anchorRect: null,
    anchorPlacement: 'bottom-end',
  })
);

/**
 * Payload for CREATE_COMMENT_COMMAND
 */
export interface CreateCommentPayload {
  /** Comment text content */
  text: string;
  /** When set, attaches the comment to a block-level decorator node instead of the current text selection */
  nodeKey?: string;
  /** Multiple attached image paths. */
  imageUrls?: string[];
}

interface CommentPluginProps {
  /** Note ID for loading comments from atoms */
  noteId: string;
}

/**
 * Traverses all MarkNodes with the given comment ID and calls the callback
 * with each corresponding DOM element. Useful for toggling highlight classes.
 */
export function forEachCommentElement(
  editor: LexicalEditor,
  commentId: string,
  callback: (el: HTMLElement) => void
): void {
  const rootElement = editor.getRootElement();
  editor.getEditorState().read(() => {
    const root = $getRoot();
    const visit = (node: LexicalNode) => {
      if ($isMarkNode(node) && node.getIDs().includes(commentId)) {
        const el = editor.getElementByKey(node.getKey());
        if (el) callback(el);
      }
      if ($isCommentableDecorator(node) && node.getCommentIds().includes(commentId)) {
        const wrapper = rootElement?.querySelector(`[data-block-decorator-key="${node.getKey()}"]`) as HTMLElement | null;
        if (wrapper) callback(wrapper);
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) visit(child);
      }
    };
    for (const child of root.getChildren()) visit(child);
  });
}

/**
 * Finds all MarkNodes that contain a specific comment ID.
 * Exported for use in CommentUIWrapper for delete and apply suggestion.
 */
export function $getMarkNodesWithId(commentId: string): MarkNode[] {
  const nodes: MarkNode[] = [];
  const root = $getRoot();

  const traverse = (node: LexicalNode) => {
    if ($isMarkNode(node) && node.getIDs().includes(commentId)) {
      nodes.push(node);
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        traverse(child);
      }
    }
  };

  for (const child of root.getChildren()) {
    traverse(child);
  }

  return nodes;
}

export function CommentPlugin({ noteId }: CommentPluginProps) {
  const [editor] = useLexicalComposerContext();
  const store = useStore();

  // Clear comment UI state when noteId changes
  useEffect(() => {
    store.set(commentInputStateAtom(noteId), { open: false, anchorRect: null });
    store.set(activeCommentAtom(noteId), { comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
    if (typeof CSS !== 'undefined') {
      CSS.highlights?.delete('comment-selection');
    }
  }, [noteId, store]);

  // Register CREATE_COMMENT_COMMAND handler
  useEffect(() => {
    return editor.registerCommand(
      CREATE_COMMENT_COMMAND,
      (payload) => {
        // moss-multi seam: comments (comments.md §12): on a bound note a comment is a server record, never a mark
        const sent = createFromCommand(editor, payload);
        if (sent !== null) return sent;
        if (!editor.isEditable()) return false;

        const commentId = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);

        // Block-level decorator path: attach comment via commentIds array
        if (payload.nodeKey) {
          const node = $getNodeByKey(payload.nodeKey);
          if (!node || !$isCommentableDecorator(node)) {
            console.warn('[CommentPlugin] Cannot create block comment: node not found or not commentable');
            return false;
          }
          node.setCommentIds([...node.getCommentIds(), commentId]);

          const currentComments = store.get(noteCommentsMapAtom(noteId));
          const newComment: NoteComment = {
            id: commentId,
            text: payload.text,
            createdAt: now,
            updatedAt: now,
            source: 'user' as const,
            color: USER_COMMENT_COLOR,
            ...(payload.imageUrls?.length ? { imageUrls: payload.imageUrls, imageUrl: payload.imageUrls[0] } : {}),
          };
          store.set(noteCommentsMapAtom(noteId), { ...currentComments, [commentId]: newComment });
          store.set(noteCommentAnchorIdsAtom(noteId), (ids) => ids.includes(commentId) ? ids : [...ids, commentId]);
          store.set(commentDirtySignalAtom(noteId), (count) => count + 1);
          return true;
        }

        // Text selection path: wrap with MarkNode
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || selection.isCollapsed()) {
          console.warn('[CommentPlugin] Cannot create comment: no text selected');
          return false;
        }

        const selectedText = selection.getTextContent();
        if (!selectedText.trim()) {
          console.warn('[CommentPlugin] Cannot create comment: selection is empty');
          return false;
        }

        // Wrap the selection with a MarkNode for visual highlighting
        $wrapSelectionInMarkNode(selection, selection.isBackward(), commentId);

        // Create comment in atom — content save will persist to markdown
        const currentComments = store.get(noteCommentsMapAtom(noteId));
        const newComment: NoteComment = {
          id: commentId,
          text: payload.text,
          createdAt: now,
          updatedAt: now,
          source: 'user' as const,
          color: USER_COMMENT_COLOR,
          ...(payload.imageUrls?.length ? { imageUrls: payload.imageUrls, imageUrl: payload.imageUrls[0] } : {}),
        };
        store.set(noteCommentsMapAtom(noteId), { ...currentComments, [commentId]: newComment });
        store.set(noteCommentAnchorIdsAtom(noteId), (ids) => ids.includes(commentId) ? ids : [...ids, commentId]);
        store.set(commentDirtySignalAtom(noteId), (count) => count + 1);

        return true;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [editor, noteId, store]);

  // MarkNode mutation listener: apply data-comment-color to comment highlights
  useEffect(() => {
    let rafId: number | null = null;

    const applyCommentColors = () => {
      const commentsMap = store.get(noteCommentsMapAtom(noteId));
      const commentThreadFilter = store.get(commentThreadFilterAtom(noteId));
      editor.getEditorState().read(() => {
        const root = $getRoot();
        const visit = (node: LexicalNode) => {
          if ($isMarkNode(node)) {
            const el = editor.getElementByKey(node.getKey());
            if (el) {
              const visibleComment = node
                .getIDs()
                .map(id => commentsMap[id] ? { id, comment: commentsMap[id] } : null)
                .find((entry): entry is { id: string; comment: NoteComment } =>
                  Boolean(entry && isCommentVisibleForStatus(commentsMap, entry.id, commentThreadFilter))
                );
              if (visibleComment) {
                el.classList.remove('comment-mark-filter-hidden');
                el.setAttribute('data-comment-color', String(visibleComment.comment.color));
              } else {
                el.classList.add('comment-mark-filter-hidden');
                el.removeAttribute('data-comment-color');
              }
            }
          }
          if ($isElementNode(node)) for (const child of node.getChildren()) visit(child);
        };
        for (const child of root.getChildren()) visit(child);
      });
    };

    const scheduleApply = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        applyCommentColors();
      });
    };

    const unregMark = editor.registerMutationListener(MarkNode, scheduleApply);
    // When undo re-inserts a TabGroupNode, descendant MarkNodes may not get
    // individual mutations. Listen for TabGroupNode mutations too so we
    // recolor comments that reappear inside a restored tab group.
    const unregTabGroup = editor.registerMutationListener(TabGroupNode, scheduleApply);
    const unregComments = store.sub(noteCommentsMapAtom(noteId), scheduleApply);
    const unregFilter = store.sub(commentThreadFilterAtom(noteId), scheduleApply);

    // Initial color application after mount
    const initRaf = requestAnimationFrame(applyCommentColors);

    return () => {
      unregMark();
      unregTabGroup();
      unregComments();
      unregFilter();
      if (rafId !== null) cancelAnimationFrame(rafId);
      cancelAnimationFrame(initRaf);
    };
  }, [editor, noteId, store]);

  return null;
}

export default CommentPlugin;

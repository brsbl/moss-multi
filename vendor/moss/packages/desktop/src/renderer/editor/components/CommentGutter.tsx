// ported-from: packages/desktop/src/renderer/editor/components/CommentGutter.tsx @ 762abb777
/**
 * CommentGutter - Renders comment icons in the right margin aligned with
 * commented lines. Uses MarkNode mutation + rAF-debounced update listener +
 * ResizeObserver on editor root to track positions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import { $isMarkNode, MarkNode } from '@lexical/mark';
import { $isCommentableDecorator } from '../utils/commentable-node';
import { StickyNote } from 'lucide-react';
import { commentThreadFilterAtom, noteCommentsMapAtom } from '@moss/shared/state/note-atoms';
import { COMMENT_COLORS } from './media-primitives';
import { isCommentResolved, isCommentVisibleForStatus } from '../utils/comment-thread-count';
import { applyCommentHoverState, clearCommentHoverState } from '../utils/comment-hover-state';
// moss-multi seam: comments (comments.md §12)
import { subscribePaint, targets } from '@moss-multi/host/comments/adapter';

const ICON_HEIGHT = 32;

export interface CommentGutterEntry {
  commentId: string;
  top: number;
}

export interface CommentGutterProps {
  noteId: string;
  onIconClick: (commentId: string, anchorRect: DOMRect) => void;
  activeCommentId?: string | null;
  className?: string;
}

/** Skip elements inside collapsed headings or with zero height. */
function shouldSkipElement(element: HTMLElement): boolean {
  if (element.closest('.heading-collapsed-content')) return true;
  return element.getBoundingClientRect().height === 0;
}

function getCommentPositions(
  editor: ReturnType<typeof useLexicalComposerContext>[0]
): CommentGutterEntry[] {
  // moss-multi seam: comments (comments.md §12): rows come from the painted anchors, not MarkNodes
  const entries: CommentGutterEntry[] = targets(editor);
  if (entries) {
    entries.sort((a, b) => a.top - b.top);
    for (let i = 1; i < entries.length; i++) {
      const minTop = entries[i - 1].top + ICON_HEIGHT;
      if (entries[i].top < minTop) entries[i] = { ...entries[i], top: minTop };
    }
    return entries;
  }
  const rootElement = editor.getRootElement();
  if (!rootElement) return [];
  const containerRect = rootElement.getBoundingClientRect();
  const seenIds = new Set<string>();

  editor.getEditorState().read(() => {
    const traverse = (node: LexicalNode): void => {
      const ids = $isMarkNode(node)
        ? node.getIDs()
        : $isCommentableDecorator(node) ? node.getCommentIds() : null;

      if (ids) {
        for (const id of ids) {
          if (seenIds.has(id)) continue;
          let el: HTMLElement | null = null;
          if ($isCommentableDecorator(node)) {
            // Lexical's wrapper span may have zero dimensions; find the visual element
            el = rootElement.querySelector(`[data-block-decorator-key="${node.getKey()}"]`);
          } else {
            el = editor.getElementByKey(node.getKey());
          }
          if (!el || shouldSkipElement(el)) continue;
          const r = el.getBoundingClientRect();
          seenIds.add(id);
          entries.push({
            commentId: id,
            top: r.top - containerRect.top,
          });
        }
      }
      if ($isElementNode(node)) {
        for (const child of node.getChildren()) traverse(child);
      }
    };
    for (const child of $getRoot().getChildren()) traverse(child);
  });

  entries.sort((a, b) => a.top - b.top);
  // De-overlap: cascade icons that would overlap
  for (let i = 1; i < entries.length; i++) {
    const minTop = entries[i - 1].top + ICON_HEIGHT;
    if (entries[i].top < minTop) {
      entries[i] = { ...entries[i], top: minTop };
    }
  }
  return entries;
}

export function CommentGutter({ noteId, onIconClick, activeCommentId, className }: CommentGutterProps) {
  const [editor] = useLexicalComposerContext();
  const commentsMap = useAtomValue(noteCommentsMapAtom(noteId));
  const commentThreadFilter = useAtomValue(commentThreadFilterAtom(noteId));
  const [entries, setEntries] = useState<CommentGutterEntry[]>([]);

  const updatePositions = useCallback(() => {
    const nextEntries = getCommentPositions(editor);
    setEntries(
      nextEntries.filter((entry) => {
        const comment = commentsMap[entry.commentId];
        if (!comment) return false;
        return isCommentVisibleForStatus(commentsMap, entry.commentId, commentThreadFilter);
      })
    );
  }, [editor, commentsMap, commentThreadFilter]);

  const rafRef = useRef<number | null>(null);
  const scheduleUpdate = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updatePositions();
    });
  }, [updatePositions]);

  useEffect(() => {
    // Skip registration when note has no comments — no positions to track.
    // When comments are added, commentsMap changes → updatePositions changes →
    // effect re-runs → listeners register.
    const hasComments = Object.keys(commentsMap).length > 0;
    if (!hasComments) {
      setEntries([]);
      return;
    }

    const initialRaf = requestAnimationFrame(updatePositions);
    const unregMutation = subscribePaint(editor, scheduleUpdate); // moss-multi seam: comments
    // Dirty-gated: only reposition when content changes (e.g. lines added above
    // a comment), not on selection-only changes (click-to-focus, arrow keys).
    const unregUpdate = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      scheduleUpdate();
    });

    const rootEl = editor.getRootElement();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined' && rootEl) {
      ro = new ResizeObserver(scheduleUpdate);
      ro.observe(rootEl);
    }

    return () => {
      cancelAnimationFrame(initialRaf);
      unregMutation();
      unregUpdate();
      ro?.disconnect();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [editor, commentsMap, updatePositions, scheduleUpdate]);

  const handleIconClick = useCallback(
    (commentId: string, e: React.MouseEvent<HTMLButtonElement>) => {
      onIconClick(commentId, e.currentTarget.getBoundingClientRect());
    },
    [onIconClick]
  );

  const handleIconMouseEnter = useCallback(
    (commentId: string, colorIndex: number) => {
      applyCommentHoverState(editor, commentId, colorIndex);
    },
    [editor]
  );

  const handleIconMouseLeave = useCallback(() => {
    clearCommentHoverState(editor);
  }, [editor]);

  if (entries.length === 0) return null;

  return (
    <div
      className={['absolute right-0 top-0 h-full w-8 translate-x-comment-gutter pointer-events-none', className].filter(Boolean).join(' ')}
    >
      {entries.map((entry) => {
        const isActive = entry.commentId === activeCommentId;
        const comment = commentsMap[entry.commentId];
        const resolved = isCommentResolved(comment);
        const colorIndex = (comment?.color ?? 0) % COMMENT_COLORS.length;
        const color = COMMENT_COLORS[colorIndex];
        return (
          <button
            key={entry.commentId}
            type="button"
            onClick={(e) => handleIconClick(entry.commentId, e)}
            onMouseEnter={() => handleIconMouseEnter(entry.commentId, colorIndex)}
            onMouseLeave={handleIconMouseLeave}
            className={[
              'absolute right-0 pointer-events-auto flex h-8 w-comment-gutter-target items-center justify-center rounded-full transition-colors focus:outline-none',
              isActive ? 'z-10' : 'hover:bg-surface-paper',
            ].join(' ')}
            style={{ top: entry.top }}
            data-comment-gutter-id={entry.commentId}
            aria-label="View comment"
            aria-pressed={isActive}
          >
            <span className="relative isolate flex h-8 w-8 items-center justify-center rounded-full">
              {isActive && (
                <span aria-hidden className="absolute inset-0 z-0 rounded-full bg-comment-gutter-active-fill" />
              )}
              <StickyNote
                data-comment-color={colorIndex}
                strokeWidth={1.5}
                strokeDasharray={resolved ? '1 3' : undefined}
                className={`comment-gutter-icon relative z-10 h-5 w-5 ${color}`}
              />
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default CommentGutter;

export const commentGutterTestUtils = { shouldSkipElement };

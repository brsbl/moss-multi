// ported-from: packages/desktop/src/renderer/editor/components/CommentUIWrapper.tsx @ 762abb777
import { useCallback, useEffect, useRef } from 'react';
import { useAtomValue, useSetAtom, useStore } from 'jotai';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isMarkNode } from '@lexical/mark';

import { showCommandPaletteAtom, commandPaletteOriginAtom, promptDraftAtom, pendingAgentCommentIdAtom, pendingAgentCommentContextAtom, pendingAgentContextAtom, pendingAgentContextIconUrlAtom, pendingAgentContextSourceUrlAtom, pendingAgentImageUrlsAtom, actionsPanelHiddenAtom } from '@moss/shared/state/atoms';
import {
  activeNotesAtom,
  noteCommentsMapAtom,
  commentDirtySignalAtom,
  applyCommentDeletion,
  setCommentSubtreeResolvedState,
  commentThreadFilterAtom,
  type CommentDeletionScope,
  type NoteComment
} from '@moss/shared/state/note-atoms';

import { $getNearestNodeFromDOMNode, $getNodeByKey, $getRoot, $isElementNode, SKIP_DOM_SELECTION_TAG, type LexicalNode } from 'lexical';
import { activeCommentAtom, forEachCommentElement } from '../plugins/CommentPlugin';
import { $isCommentableDecorator } from '../utils/commentable-node';
import { $isImageNode } from '../nodes/ImageNode';
import { $isVideoNode } from '../nodes/VideoNode';
import { $isChartNode } from '../nodes/ChartNode';
import { $isSketchNode, buildSketchMarkdown } from '../nodes/SketchNode';
import { $isHtmlBlockquoteNode } from '../nodes/HtmlBlockquoteNode';
import { clearCommentAnchors } from '../utils/comment-cleanup';
import {
  buildPendingCommentContext,
  clearPendingCommentAgentContext,
  getCommentImageUrls,
  orderCommentThreadForAgent
} from '../utils/comment-agent-context';
import {
  OPEN_COMMENT_THREAD_EVENT,
  type OpenCommentThreadEventDetail
} from '../utils/comment-entry-point';
import { isCommentVisibleForStatus } from '../utils/comment-thread-count';
import { applyCommentHoverState, clearCommentHoverState } from '../utils/comment-hover-state';
import { CommentGutter } from './CommentGutter';
import { CommentPopover } from './CommentPopover';
import { COMMENT_CHALK_COLORS } from '../colors';
import { REVEAL_COLLAPSED_HEADING_COMMAND } from '../plugins/CollapsibleHeadingPlugin';
import { updatePanelVisibility } from '../plugins/TabBarPlugin';
import { $isTabGroupNode } from '../nodes/TabGroupNode';
import { $isTabPanelNode } from '../nodes/TabPanelNode';
import { EDITOR_UPDATE_TAGS } from '../utils/editorUpdateTags';
// moss-multi seam: comments (comments.md §12): anchors, hits and writes go through the adapter
// on a bound note only; an unbound editor (file-backed) keeps moss's own path below each seam
import { anchorTarget, bound, commentsOnDecorator, detachedRect, mutate, setActive, trackCommentHover, useCanComment } from '@moss-multi/host/comments/adapter';
import { hidden } from '@moss-multi/host/affordances';

interface CommentUIWrapperProps {
  noteId: string;
  paneId?: 'left' | 'right';
  onNavigateToNote?: (noteId: string) => void;
}

/**
 * Find the gutter icon button for a comment within the editor root's own pane.
 * Walks up from the contenteditable root and returns the match from the lowest
 * ancestor that contains it — so a duplicate gutter id in another split pane is
 * never selected.
 */
function findPaneGutterButton(rootElement: HTMLElement | null, commentId: string): HTMLElement | null {
  if (!rootElement) return null;
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(commentId)
    : commentId.replace(/["\\]/g, '\\$&');
  const selector = `[data-comment-gutter-id="${escaped}"]`;
  let scope: HTMLElement | null = rootElement.parentElement;
  while (scope) {
    const match = scope.querySelector<HTMLElement>(selector);
    if (match) return match;
    scope = scope.parentElement;
  }
  return null;
}

function findCommentHoverAnchor(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest<HTMLElement>('.comment-mark, [data-block-decorator-key]');
}

function scrollCommentAnchorIntoViewIfNeeded(anchor: HTMLElement): void {
  const scrollContainer = anchor.closest<HTMLElement>('.canvas-scroll');
  if (scrollContainer) {
    const anchorRect = anchor.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    if (anchorRect.top >= containerRect.top && anchorRect.bottom <= containerRect.bottom) {
      return;
    }
  }

  anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/**
 * CommentUIWrapper - Renders CommentGutter and CommentPopover with proper state management.
 * Uses Jotai atoms as single source of truth for comments (no useState, no IPC fetching).
 */
export const CommentUIWrapper = ({ noteId, paneId, onNavigateToNote }: CommentUIWrapperProps) => {
  const [editor] = useLexicalComposerContext();
  const store = useStore();
  const commentable = useCanComment(noteId); // moss-multi seam: comments
  const activeCommentState = useAtomValue(activeCommentAtom(noteId));
  const setActiveComment = useSetAtom(activeCommentAtom(noteId));
  // Subscribe so the popover re-derives its thread live when replies/edits land.
  const commentsMap = useAtomValue(noteCommentsMapAtom(noteId));
  const commentThreadFilter = useAtomValue(commentThreadFilterAtom(noteId));
  const hoveredEditorCommentIdRef = useRef<string | null>(null);
  const openThreadRafRef = useRef<number | null>(null);

  // Highlight mark nodes for a comment in the editor
  const highlightComment = useCallback((commentId: string) => {
    setActive(editor, commentId); // moss-multi seam: comments
    forEachCommentElement(editor, commentId, (el) => el.classList.add('comment-highlight-active'));
    editor.read(() => {
      const visit = (node: LexicalNode) => {
        if ($isCommentableDecorator(node) && node.getCommentIds().includes(commentId)) {
          const rootElement = editor.getRootElement();
          const elements = [
            editor.getElementByKey(node.getKey()),
            rootElement?.querySelector<HTMLElement>(`[data-block-decorator-key="${node.getKey()}"]`) ?? null
          ].filter((el, index, all): el is HTMLElement => Boolean(el) && all.indexOf(el) === index);

          if (elements.length > 0) {
            // Look up the comment's color index from the comments map
            const commentsMap = store.get(noteCommentsMapAtom(noteId));
            const comment = commentsMap[commentId];
            for (const el of elements) {
              el.classList.add('comment-highlight-active');
            }
            if (comment) {
              const colorIndex = comment.color ?? 0;
              for (const el of elements) {
                el.style.setProperty(
                  '--comment-color',
                  COMMENT_CHALK_COLORS[colorIndex] ?? COMMENT_CHALK_COLORS[0]
                );
              }
            }
          }
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) {
            visit(child);
          }
        }
      };

      const root = $getRoot();
      for (const child of root.getChildren()) {
        visit(child);
      }
    });
  }, [editor, store, noteId]);

  // Remove all comment highlights
  const clearCommentHighlight = useCallback(() => {
    setActive(editor, null); // moss-multi seam: comments
    const rootElement = editor.getRootElement();
    if (rootElement) {
      rootElement.querySelectorAll('.comment-highlight-active')
        .forEach(el => {
          el.classList.remove('comment-highlight-active');
          (el as HTMLElement).style.removeProperty('--comment-color');
        });
    }
  }, [editor]);

  const getNewestRootComment = useCallback((comments: NoteComment[]): NoteComment | null => {
    const liveCommentsMap = store.get(noteCommentsMapAtom(noteId));
    const roots = new Map<string, NoteComment>();

    for (const comment of comments) {
      let current = liveCommentsMap[comment.id] ?? comment;
      let rootId = current.id;
      const seen = new Set<string>([current.id]);
      while (current.parentId) {
        const parent = liveCommentsMap[current.parentId];
        if (!parent || seen.has(parent.id)) break;
        seen.add(parent.id);
        current = parent;
        rootId = parent.id;
      }
      if (isCommentVisibleForStatus(
        liveCommentsMap,
        rootId,
        store.get(commentThreadFilterAtom(noteId))
      )) {
        roots.set(rootId, current);
      }
    }

    return Array.from(roots.values()).reduce<NoteComment | null>(
      (latest, comment) => (latest === null || comment.createdAt > latest.createdAt ? comment : latest),
      null
    );
  }, [noteId, store]);

  const openCommentsAtRect = useCallback((
    comments: NoteComment[],
    anchorRect: DOMRect | { x: number; y: number; width: number; height: number },
    placement: 'bottom-end' | 'right-start' = 'bottom-end'
  ) => {
    const comment = getNewestRootComment(comments);
    if (!comment) {
      return false;
    }

    const rect = anchorRect;
    clearCommentHighlight();
    highlightComment(comment.id);
    setActiveComment({
      comment,
      anchorRect: rect,
      anchorPlacement: placement,
    });

    return true;
  }, [clearCommentHighlight, getNewestRootComment, highlightComment, setActiveComment]);

  const getHoveredRootComment = useCallback((anchor: HTMLElement): NoteComment | null => {
    let comments: NoteComment[] = [];

    editor.read(() => {
      let node: LexicalNode | null = $getNearestNodeFromDOMNode(anchor);
      while (node && !$isMarkNode(node) && !$isCommentableDecorator(node)) {
        node = node.getParent();
      }
      if (!node) return;

      const ids = $isMarkNode(node)
        ? node.getIDs()
        : $isCommentableDecorator(node)
          ? node.getCommentIds()
          : [];
      const liveCommentsMap = store.get(noteCommentsMapAtom(noteId));
      comments = ids
        .map((id) => liveCommentsMap[id])
        .filter((comment): comment is NoteComment => Boolean(comment));
    });

    return getNewestRootComment(comments);
  }, [editor, getNewestRootComment, noteId, store]);

  const handleEditorCommentMouseOver = useCallback((event: MouseEvent) => {
    if (bound(editor)) return; // moss-multi seam: comments: a bound note hit-tests on mousemove
    const anchor = findCommentHoverAnchor(event.target);
    if (!anchor) return;

    const comment = getHoveredRootComment(anchor);
    if (!comment) return;
    if (hoveredEditorCommentIdRef.current === comment.id) return;

    clearCommentHoverState(editor);
    applyCommentHoverState(editor, comment.id, comment.color ?? 0);
    hoveredEditorCommentIdRef.current = comment.id;
  }, [editor, getHoveredRootComment]);

  // moss-multi seam: comments (comments.md §11): a bound note's highlight has no element, so the pointer is hit-tested,
  // once per animation frame at its latest position (trackCommentHover)
  const handleBoundCommentHit = useCallback((ids: string[]) => {
    if (!bound(editor)) return;
    {
      const liveCommentsMap = store.get(noteCommentsMapAtom(noteId));
      const hit = getNewestRootComment(
        ids
          .map((id) => liveCommentsMap[id])
          .filter((comment): comment is NoteComment => Boolean(comment))
      );
      if (!hit) {
        if (hoveredEditorCommentIdRef.current) clearCommentHoverState(editor);
        hoveredEditorCommentIdRef.current = null;
        return;
      }
      if (hoveredEditorCommentIdRef.current === hit.id) return;
      clearCommentHoverState(editor);
      applyCommentHoverState(editor, hit.id, hit.color ?? 0);
      hoveredEditorCommentIdRef.current = hit.id;
    }
  }, [editor, getNewestRootComment, noteId, store]);

  const handleEditorCommentMouseOut = useCallback((event: MouseEvent) => {
    // moss-multi seam: comments: on a bound note, leaving the body ends a hover
    if (bound(editor) && !(event.relatedTarget instanceof Node && editor.getRootElement()?.contains(event.relatedTarget))) {
      if (hoveredEditorCommentIdRef.current) clearCommentHoverState(editor);
      hoveredEditorCommentIdRef.current = null;
      return;
    }
    const anchor = findCommentHoverAnchor(event.target);
    if (!anchor) return;
    const related = event.relatedTarget;
    if (related instanceof Node && anchor.contains(related)) return;

    clearCommentHoverState(editor);
    hoveredEditorCommentIdRef.current = null;
  }, [editor]);

  const findInlineCommentAnchor = useCallback((commentId: string) => {
    if (bound(editor)) return anchorTarget(editor, commentId); // moss-multi seam: comments
    let anchor: { element: HTMLElement; nodeKey: string } | null = null;

    editor.read(() => {
      const visit = (node: LexicalNode) => {
        if (anchor) return;
        const ids = $isMarkNode(node)
          ? node.getIDs()
          : $isCommentableDecorator(node)
            ? node.getCommentIds()
            : [];
        if (ids.includes(commentId)) {
          const nodeKey = node.getKey();
          const rootElement = editor.getRootElement();
          const element = $isCommentableDecorator(node)
            ? rootElement?.querySelector<HTMLElement>(`[data-block-decorator-key="${nodeKey}"]`) ?? editor.getElementByKey(nodeKey)
            : editor.getElementByKey(nodeKey);
          if (element) anchor = { element, nodeKey };
          return;
        }
        if ($isElementNode(node)) {
          for (const child of node.getChildren()) visit(child);
        }
      };

      for (const child of $getRoot().getChildren()) visit(child);
    });

    return anchor as { element: HTMLElement; nodeKey: string } | null;
  }, [editor]);

  const revealTabContainingNode = useCallback((nodeKey: string) => {
    let foundTabPanel = false;
    const panelsToReveal: Array<{ groupKey: string; panelIndex: number }> = [];

    editor.update(() => {
      let node = $getNodeByKey(nodeKey);
      while (node) {
        if ($isTabPanelNode(node)) {
          const group = node.getParent();
          if ($isTabGroupNode(group)) {
            const panelKey = node.getKey();
            const panelIndex = group.getTabPanels()
              .findIndex((panel) => panel.getKey() === panelKey);
            if (panelIndex >= 0) {
              foundTabPanel = true;
              panelsToReveal.push({ groupKey: group.getKey(), panelIndex });
              if (group.getActiveIndex() !== panelIndex) {
                group.setActiveIndex(panelIndex);
              }
            }
          }
        }
        node = node.getParent();
      }
      // skip-dom-selection: setActiveIndex dirties the group, so without it the
      // commit re-applies the pre-reveal selection — which by then can point
      // into the panel this reveal just hid. Matches SearchPlugin's tab reveal.
    }, { tag: [EDITOR_UPDATE_TAGS.ignored.skipDirty, SKIP_DOM_SELECTION_TAG] });

    for (const { groupKey, panelIndex } of panelsToReveal) {
      updatePanelVisibility(editor, groupKey, panelIndex);
    }

    return foundTabPanel;
  }, [editor]);

  const openCommentThreadById = useCallback((commentId: string) => {
    if (openThreadRafRef.current !== null) {
      cancelAnimationFrame(openThreadRafRef.current);
      openThreadRafRef.current = null;
    }

    const attemptOpen = (
      remainingRevealFrames: number,
      revealRequested: { tab?: boolean; heading?: boolean } = {}
    ) => {
      const currentCommentsMap = store.get(noteCommentsMapAtom(noteId));
      const comment = currentCommentsMap[commentId];
      if (!comment) return;
      if (!isCommentVisibleForStatus(
        currentCommentsMap,
        comment.id,
        store.get(commentThreadFilterAtom(noteId))
      )) return;

      const gutterButton = findPaneGutterButton(editor.getRootElement(), comment.id);
      if (gutterButton) {
        scrollCommentAnchorIntoViewIfNeeded(gutterButton);
        openCommentsAtRect([comment], gutterButton.getBoundingClientRect());
        return;
      }

      const inlineAnchor = findInlineCommentAnchor(comment.id);
      if (!inlineAnchor) {
        // moss-multi seam: comments (comments.md §6): a bound note's detached thread opens beside the text column
        const rect = bound(editor) ? detachedRect(editor) : null;
        if (rect) openCommentsAtRect([comment], rect);
        return;
      }
      const hiddenTabPanel = inlineAnchor.element.closest('[data-tab-panel]:not([data-active])');
      if (hiddenTabPanel) {
        if (!revealRequested.tab && !revealTabContainingNode(inlineAnchor.nodeKey)) return;
        if (remainingRevealFrames === 0) return;
        openThreadRafRef.current = requestAnimationFrame(() => {
          openThreadRafRef.current = null;
          attemptOpen(remainingRevealFrames - 1, { ...revealRequested, tab: true });
        });
        return;
      }
      const collapsedContainer = inlineAnchor.element.closest(
        '.heading-collapsed-content, .heading-semi-collapsed-checked'
      );
      if (collapsedContainer) {
        if (!revealRequested.heading) {
          const revealDispatched = editor.dispatchCommand(REVEAL_COLLAPSED_HEADING_COMMAND, {
            targetNodeKey: inlineAnchor.nodeKey
          });
          if (!revealDispatched) return;
        }
        if (remainingRevealFrames === 0) return;
        openThreadRafRef.current = requestAnimationFrame(() => {
          openThreadRafRef.current = null;
          attemptOpen(remainingRevealFrames - 1, { ...revealRequested, heading: true });
        });
        return;
      }

      // A revealed anchor has no gutter icon yet: the reveal dirties the tab
      // group, so CommentGutter re-measures on its own frame, which lands after
      // this retry. Without waiting the popover falls back to the inline mark
      // and opens mid-paragraph, where every other comment opens beside its
      // gutter icon. Spend one more frame before accepting that fallback.
      if ((revealRequested.tab || revealRequested.heading) && remainingRevealFrames > 0) {
        openThreadRafRef.current = requestAnimationFrame(() => {
          openThreadRafRef.current = null;
          attemptOpen(remainingRevealFrames - 1, revealRequested);
        });
        return;
      }

      scrollCommentAnchorIntoViewIfNeeded(inlineAnchor.element);
      openCommentsAtRect([comment], inlineAnchor.element.getBoundingClientRect());
    };

    attemptOpen(3);
  }, [
    editor,
    findInlineCommentAnchor,
    noteId,
    openCommentsAtRect,
    revealTabContainingNode,
    store
  ]);

  useEffect(() => () => {
    if (openThreadRafRef.current !== null) {
      cancelAnimationFrame(openThreadRafRef.current);
      openThreadRafRef.current = null;
    }
  }, [noteId]);

  // Handle gutter icon click - use the button rect as the popover anchor
  const handleGutterIconClick = useCallback((commentId: string, anchorRect: DOMRect) => {
    const currentCommentsMap = store.get(noteCommentsMapAtom(noteId));
    const comment = currentCommentsMap[commentId];
    if (!comment) {
      console.warn('[CommentUIWrapper] Comment not found:', commentId);
      return;
    }
    if (!isCommentVisibleForStatus(currentCommentsMap, comment.id, commentThreadFilter)) {
      return;
    }

    openCommentsAtRect([comment], anchorRect);
  }, [commentThreadFilter, noteId, openCommentsAtRect, store]);

  // Open comment popover when clicking directly on a commented block decorator.
  // If multiple root comments share the decorator, open the newest one; gutter
  // icons are the disambiguation surface for older comments.
  const handleDecoratorCommentClick = useCallback((event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    let validComments: NoteComment[] = [];
    let anchorRect: DOMRect | null = null;

    editor.read(() => {
      let node: LexicalNode | null = $getNearestNodeFromDOMNode(target);
      while (node && !$isCommentableDecorator(node)) {
        node = node.getParent();
      }
      if (!node || !$isCommentableDecorator(node)) {
        return;
      }

      const commentsMap = store.get(noteCommentsMapAtom(noteId));
      validComments = (bound(editor) ? commentsOnDecorator(editor, node.getKey()) : node.getCommentIds()) // moss-multi seam: comments
        .map((id) => commentsMap[id])
        .filter((c): c is NoteComment => !!c)
        .filter((comment) => isCommentVisibleForStatus(commentsMap, comment.id, commentThreadFilter));

      if (validComments.length === 0) {
        return;
      }

      const element = editor.getElementByKey(node.getKey());
      if (!element) {
        return;
      }
      anchorRect = element.getBoundingClientRect();
    });

    if (validComments.length === 0 || !anchorRect) {
      return;
    }

    openCommentsAtRect(validComments, anchorRect as DOMRect);
  }, [commentThreadFilter, editor, noteId, openCommentsAtRect, store]);

  useEffect(() => {
    return editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener('click', handleDecoratorCommentClick);
      rootElement?.addEventListener('click', handleDecoratorCommentClick);
    });
  }, [editor, handleDecoratorCommentClick]);

  useEffect(() => {
    let untrack = () => {}; // moss-multi seam: comments
    const unregister = editor.registerRootListener((rootElement, previousRootElement) => {
      previousRootElement?.removeEventListener('mouseover', handleEditorCommentMouseOver);
      untrack(); // moss-multi seam: comments
      untrack = () => {};
      previousRootElement?.removeEventListener('mouseout', handleEditorCommentMouseOut);
      rootElement?.addEventListener('mouseover', handleEditorCommentMouseOver);
      if (rootElement) untrack = trackCommentHover(editor, rootElement, handleBoundCommentHit); // moss-multi seam: comments
      rootElement?.addEventListener('mouseout', handleEditorCommentMouseOut);
    });
    return () => {
      unregister();
      untrack(); // moss-multi seam: comments: no hit-test fires after unmount
    };
  }, [editor, handleBoundCommentHit, handleEditorCommentMouseOut, handleEditorCommentMouseOver]);

  useEffect(() => {
    const handleOpenThread = (event: Event) => {
      const detail = (event as CustomEvent<OpenCommentThreadEventDetail>).detail;
      if (!detail || detail.noteId !== noteId) return;
      if (detail.paneId && detail.paneId !== paneId) return;
      openCommentThreadById(detail.commentId);
    };

    window.addEventListener(OPEN_COMMENT_THREAD_EVENT, handleOpenThread);
    return () => window.removeEventListener(OPEN_COMMENT_THREAD_EVENT, handleOpenThread);
  }, [noteId, openCommentThreadById, paneId]);

  // Handle popover open/close
  const handlePopoverOpenChange = useCallback((open: boolean) => {
    if (!open) {
      clearCommentHighlight();
      setActiveComment({ comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
    }
  }, [setActiveComment, clearCommentHighlight]);

  // Close comment popover when actions panel toggles (anchorRect becomes stale)
  const actionsPanelHidden = useAtomValue(actionsPanelHiddenAtom);
  const prevPanelRef = useRef(actionsPanelHidden);
  useEffect(() => {
    if (prevPanelRef.current !== actionsPanelHidden) {
      prevPanelRef.current = actionsPanelHidden;
      handlePopoverOpenChange(false);
    }
  }, [actionsPanelHidden, handlePopoverOpenChange]);

  useEffect(() => {
    const active = activeCommentState.comment;
    if (!active) return;
    if (!getNewestRootComment([active])) {
      handlePopoverOpenChange(false);
    }
  }, [activeCommentState.comment, commentThreadFilter, getNewestRootComment, handlePopoverOpenChange]);

  // moss-multi seam: comments: the DocDO's write order (`seq` on the projected record) breaks a same-second tie
  const writeOrder = (c: NoteComment) => (c as NoteComment & { seq?: number }).seq ?? 0;
  // moss-multi seam: comments (comments.md §12): a peer's delete arrives as records; an open thread whose comment is
  // gone follows its promoted reply (the oldest that is still here) or its root, and closes when the thread is gone.
  const previousCommentsMapRef = useRef(commentsMap);
  useEffect(() => {
    const previous = previousCommentsMapRef.current;
    previousCommentsMapRef.current = commentsMap;
    const active = activeCommentState.comment;
    if (!bound(editor) || !active || commentsMap[active.id] || !previous[active.id]) return;
    const next = Object.values(previous)
      .filter((c) => c.parentId === active.id && commentsMap[c.id])
      .sort((a, b) => a.createdAt - b.createdAt || writeOrder(a) - writeOrder(b))
      .map((c) => commentsMap[c.id])[0] ?? (active.parentId ? commentsMap[active.parentId] : undefined);
    if (next) setActiveComment((state) => ({ ...state, comment: next }));
    else handlePopoverOpenChange(false);
  }, [activeCommentState.comment, commentsMap, editor, handlePopoverOpenChange, setActiveComment]);

  // Handle comment update - update atom (persists on next content save)
  const handleUpdate = useCallback((commentId: string, text: string, imageUrls?: string[]) => {
    // moss-multi seam: comments: on a bound note the record arrives from the server
    if (bound(editor)) {
      mutate(editor, { type: 'edit', id: commentId, text });
      return;
    }
    const currentMap = store.get(noteCommentsMapAtom(noteId));
    const existingComment = currentMap[commentId];
    if (!existingComment) return;

    const updatedComment: NoteComment = {
      ...existingComment,
      text,
      updatedAt: Math.floor(Date.now() / 1000)
    };
    if (imageUrls !== undefined) {
      if (imageUrls.length > 0) {
        updatedComment.imageUrls = imageUrls;
        updatedComment.imageUrl = imageUrls[0];
      } else {
        delete updatedComment.imageUrls;
        delete updatedComment.imageUrl;
      }
    }

    const newCommentsMap = { ...currentMap, [commentId]: updatedComment };

    // Update atom directly — content save will persist to markdown
    store.set(noteCommentsMapAtom(noteId), newCommentsMap);
    store.set(commentDirtySignalAtom(noteId), (c) => c + 1);

    // Update active comment if it's the one being edited
    if (store.get(activeCommentAtom(noteId)).comment?.id === commentId) {
      setActiveComment(prev => ({ ...prev, comment: updatedComment }));
    }
  }, [editor, noteId, setActiveComment, store]);

  // Row deletion removes one message and preserves the remaining thread. The
  // header's explicit thread action still cascades the root plus descendants.
  const handleDelete = useCallback((commentId: string, scope: CommentDeletionScope) => {
    const currentMap = store.get(noteCommentsMapAtom(noteId));
    // moss-multi seam: comments (comments.md §12): the server deletes, and a root delete promotes the oldest reply
    // under its own id, so an open thread follows that reply; the records arrive over the doc socket.
    if (bound(editor)) {
      if (!mutate(editor, { type: 'delete', id: commentId, scope })) return;
      const activeId = store.get(activeCommentAtom(noteId)).comment?.id;
      if (activeId !== commentId) return;
      const promoted = scope === 'comment' && !currentMap[commentId]?.parentId
        ? Object.values(currentMap).filter((c) => c.parentId === commentId).sort((a, b) => a.createdAt - b.createdAt || writeOrder(a) - writeOrder(b))[0]
        : undefined;
      const parent = currentMap[commentId]?.parentId ? currentMap[currentMap[commentId].parentId!] : undefined;
      const next = promoted ?? parent;
      if (next) setActiveComment((previous) => ({ ...previous, comment: next }));
      else setActiveComment({ comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
      return;
    }
    const deletion = applyCommentDeletion(currentMap, commentId, scope);
    if (!deletion.changed) return;

    clearCommentAnchors(editor, deletion.removedAnchorIds);

    store.set(noteCommentsMapAtom(noteId), deletion.map);
    store.set(commentDirtySignalAtom(noteId), (c) => c + 1);

    const activeId = store.get(activeCommentAtom(noteId)).comment?.id;
    const nextActiveComment = activeId ? deletion.map[activeId] : undefined;
    if (activeId && !nextActiveComment) {
      setActiveComment({ comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
    } else if (nextActiveComment) {
      setActiveComment((previous) => ({ ...previous, comment: nextActiveComment }));
    }
  }, [noteId, editor, setActiveComment, store]);

  // Handle reply - adds a sidecar-only reply under the root. No marker, no
  // highlight, no gutter icon. Returns true on success so the composer clears.
  const handleReply = useCallback((parentId: string, text: string, imageUrls?: string[]): boolean => {
    const trimmed = text.trim();
    const normalizedImageUrls = imageUrls?.filter((url) => url.trim().length > 0) ?? [];
    if (!trimmed && normalizedImageUrls.length === 0) return false;
    if (bound(editor)) return mutate(editor, { type: 'reply', parentId, text: trimmed }); // moss-multi seam: comments
    const currentMap = store.get(noteCommentsMapAtom(noteId));
    const parent = currentMap[parentId];
    if (!parent) return false;

    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    const reply: NoteComment = {
      id,
      text: trimmed,
      createdAt: now,
      updatedAt: now,
      color: parent.color ?? 0,
      source: 'user',
      parentId,
      ...(normalizedImageUrls.length > 0
        ? { imageUrls: normalizedImageUrls, imageUrl: normalizedImageUrls[0] }
        : {})
    };

    store.set(noteCommentsMapAtom(noteId), { ...currentMap, [id]: reply });
    store.set(commentDirtySignalAtom(noteId), (c) => c + 1);
    return true;
  }, [noteId, store]);

  const handleSetThreadResolved = useCallback((rootId: string, resolved: boolean) => {
    // moss-multi seam: comments
    if (bound(editor)) {
      mutate(editor, { type: 'resolve', rootId, resolved });
      return;
    }
    const currentMap = store.get(noteCommentsMapAtom(noteId));
    const result = setCommentSubtreeResolvedState(currentMap, rootId, {
      resolved,
      timestamp: Math.floor(Date.now() / 1000),
      resolvedBy: 'user'
    });
    if (!result.changed) return;

    store.set(noteCommentsMapAtom(noteId), result.map);
    store.set(commentDirtySignalAtom(noteId), (c) => c + 1);

    const active = store.get(activeCommentAtom(noteId)).comment;
    if (active && result.subtreeIds.includes(active.id)) {
      setActiveComment((prev) => ({
        ...prev,
        comment: result.map[active.id] ?? active
      }));
    }
  }, [noteId, setActiveComment, store]);

  const handleNavigateToMention = useCallback((title: string, mentionId?: string) => {
    if (!onNavigateToNote) return;
    const notes = store.get(activeNotesAtom);
    const target =
      (mentionId ? notes.find((note) => note.id === mentionId) : undefined) ??
      notes.find((note) => note.title === title);
    if (!target) return;

    setActiveComment({ comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
    onNavigateToNote(target.id);
  }, [onNavigateToNote, setActiveComment, store]);

  // Handle send to agent - opens command palette with visible comment preview and ID-only agent context.
  const handleSendToAgent = useCallback((comment: NoteComment, thread: NoteComment[] = [comment]) => {
    const orderedThread = orderCommentThreadForAgent(thread.length > 0 ? thread : [comment]);
    const pendingCommentContext = buildPendingCommentContext({
      scope: orderedThread.length > 1 ? 'thread' : 'comment',
      threads: [orderedThread],
      promptText: orderedThread.length > 1 ? 'Address this comment thread' : 'Address this comment'
    });
    clearPendingCommentAgentContext(store);
    // Extract image/decorator context from the comment. The annotated text is
    // already in <current_note>; the agent receives compact comment IDs and can
    // locate the range through body markers plus comments.json.
    editor.read(() => {
      const contextParts: string[] = [];

      // Collect image paths: (a) from annotated decorator nodes, (b) from comment attachments
      const imagePaths: string[] = [];
      const decoratorContexts: string[] = [];

      // (a) Walk tree for block-level decorator comments on supported decorator nodes
      const visit = (node: LexicalNode) => {
        if ($isCommentableDecorator(node) && node.getCommentIds().includes(comment.id)) {
          if ($isImageNode(node)) {
            imagePaths.push(node.getSrc());
            decoratorContexts.push(
              `[Image]\nsrc: ${node.getSrc()}\nalt: ${node.getAltText() || '(none)'}`
            );
          } else if ($isVideoNode(node)) {
            decoratorContexts.push(
              `[Video]\nsrc: ${node.getSrc()}\nkind: ${node.getVideoKind()}\nalt: ${node.getAltText() || '(none)'}`
            );
          } else if ($isChartNode(node)) {
            decoratorContexts.push(
              `[Chart]\n${JSON.stringify(node.getConfig(), null, 2)}`
            );
          } else if ($isSketchNode(node)) {
            decoratorContexts.push(
              `[Sketch]\n${buildSketchMarkdown(node.getGrid(), node.getLabels())}`
            );
          } else if ($isHtmlBlockquoteNode(node)) {
            decoratorContexts.push(
              `[Interactive HTML]\nrawHtml:\n${node.getRawHtml()}`
            );
          }
        }
        if ($isElementNode(node)) {
          node.getChildren().forEach(visit);
        }
      };
      $getRoot().getChildren().forEach(visit);

      // (b) Comment attachment images
      const attachmentUrls = orderedThread.flatMap(getCommentImageUrls);
      imagePaths.push(...attachmentUrls);

      if (attachmentUrls.length > 0) {
        decoratorContexts.push(
          `[Comment attachments]\n${attachmentUrls.join('\n')}`
        );
      }

      if (decoratorContexts.length > 0) {
        contextParts.push(decoratorContexts.join('\n\n'));
      }

      if (contextParts.length > 0) {
        store.set(pendingAgentContextAtom, contextParts.join('\n\n'));
        store.set(pendingAgentContextIconUrlAtom, null);
        store.set(pendingAgentContextSourceUrlAtom, null);
      } else {
        store.set(pendingAgentContextAtom, null);
        store.set(pendingAgentContextIconUrlAtom, null);
        store.set(pendingAgentContextSourceUrlAtom, null);
      }

      if (imagePaths.length > 0) {
        store.set(pendingAgentImageUrlsAtom, [...new Set(imagePaths)]);
      } else {
        store.set(pendingAgentImageUrlsAtom, null);
      }
    });

    store.set(pendingAgentCommentIdAtom, comment.id);
    store.set(pendingAgentCommentContextAtom, pendingCommentContext);
    store.set(promptDraftAtom, pendingCommentContext?.promptText ?? 'Address this comment');
    store.set(commandPaletteOriginAtom, 'context');
    store.set(showCommandPaletteAtom, true);
    setActiveComment({ comment: null, anchorRect: null, anchorPlacement: 'bottom-end' });
  }, [editor, store, setActiveComment]);

  return (
    <>
      <CommentGutter
        noteId={noteId}
        onIconClick={handleGutterIconClick}
        activeCommentId={activeCommentState.comment?.id}
      />
      {activeCommentState.comment && (
          <CommentPopover
            open={!!activeCommentState.comment}
            onOpenChange={handlePopoverOpenChange}
            anchorRect={activeCommentState.anchorRect}
            placement={activeCommentState.anchorPlacement ?? 'bottom-end'}
            comment={activeCommentState.comment}
            commentsMap={commentsMap}
            noteId={noteId}
            paneId={paneId}
            collisionBoundary={editor.getRootElement()?.closest('.canvas-scroll') ?? null}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onReply={commentable ? handleReply : undefined /* moss-multi seam: comments: a viewer, or a terminal note, only reads */}
            onSendToAgent={hidden('ai-run-action') ? undefined : handleSendToAgent /* moss-multi seam: hide-registry (A§9) */}
            onResolveThread={commentable ? (rootId) => handleSetThreadResolved(rootId, true) : undefined}
            onUnresolveThread={commentable ? (rootId) => handleSetThreadResolved(rootId, false) : undefined}
            onNavigateToMention={handleNavigateToMention}
          />
      )}
    </>
  );
};

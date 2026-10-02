// ported-from: packages/desktop/src/renderer/editor/components/CommentPopover.tsx @ 762abb777
/**
 * CommentPopover - threaded comment popover.
 *
 * Renders a comment thread: the root comment plus its child comments and a
 * composer. Child comments are sidecar-only and derived by flattening the
 * root's `parentId` subtree into one chronological list. Every item uses the
 * same CommentMessage row so attribution (Me / Moss / External) and
 * controls are symmetric. Minimal, Moss-native styling on the existing light
 * popover surface.
 *
 * Uses Popover with virtualRef anchor, preserving main's collision boundary,
 * focus lock, lightbox dismiss guard, and scroll/escape handling.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Popover } from '@moss/shared/primitives';
import {
  CheckCheck,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Send,
  Trash2,
  X
} from 'lucide-react';
import MossSproutIcon from '../../../../../../logos/moss-sprout-icon.png';

import { cn } from '@moss/shared/lib/utils';
import { ConfirmationDialog } from '@moss/shared/components/ui/confirmation-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@moss/shared/components/ui/tooltip';
import type { NoteComment } from '@moss/shared/state/note-atoms';
import type { CommentDeletionScope } from '@moss/shared/state/note-atoms';
import { collectCommentSubtreeIds } from '@moss/shared/state/note-atoms';
import { COMMENT_CANCEL_BUTTON_CLASS, CommentTextInput } from './CommentTextInput';
import { CommentTextContent } from './CommentTextContent';
import { getCommentAuthorDisplay } from '../utils/comment-author-display';
import { stripCommentMentionMarkers } from '../utils/comment-mentions';
import { acquireExternalEditorFocusLock } from '../../utils/external-editor-focus-lock';
import { formatRelativeTime } from '../../panels/notesPanelUtils';
import { useAtomValue, useSetAtom } from 'jotai';
import { imagesApi } from '../../api/electron';
import { toDisplaySrc } from '../utils/asset-url';
import { lightboxSrcAtom, resolveCanvasLightboxScope } from './ImageLightbox';
import { acquireCommentUiOpenFlag } from '../utils/comment-ui-open-flag';
import { dispatchCommentThreadPlaced } from '../utils/comment-entry-point';
import { resolveCanvasCollisionBoundary } from '../utils/canvas-collision-boundary';

const TOOLBAR_HEIGHT = 72;
const COMMENT_THREAD_MAX_CANVAS_RATIO = 0.82;
const COMMENT_THREAD_MAX_VIEWPORT_RATIO = 0.64;
const COMMENT_THREAD_MAX_HEIGHT_PX = 520;

export interface CommentPopoverProps {
  /** Whether the popover is open */
  open: boolean;
  /** Callback when open state changes */
  onOpenChange: (open: boolean) => void;
  /** Static rect snapshot for popover positioning (taken at click time) */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Preferred placement for the popover relative to anchorRect */
  placement?: 'bottom-end' | 'right-start';
  /** The comment that was activated (root or child — the thread root is derived) */
  comment: NoteComment;
  /** Full per-note comments map, used to derive the thread. */
  commentsMap: Record<string, NoteComment>;
  /** The note ID, used for image path resolution */
  noteId: string;
  /** Owning split pane, carried on the thread-placed announcement. */
  paneId?: 'left' | 'right';
  /** Canvas viewport that the popover must remain inside */
  collisionBoundary?: Element | null;
  /** Callback when comment text is updated */
  onUpdate: (commentId: string, text: string, imageUrls?: string[]) => void;
  /** Callback when comment is deleted (cascades the subtree for a root) */
  onDelete: (commentId: string, scope: CommentDeletionScope) => void;
  /**
   * Callback to add a child comment under the root; returns true on success.
   * `imageUrls` carries any attachments composed in the footer box — the
   * handler owner (CommentUIWrapper) persists them on the comment sidecar.
   */
  onReply?: (parentId: string, text: string, imageUrls?: string[]) => boolean;
  /** Callback when a comment thread is sent to agent */
  onSendToAgent?: (comment: NoteComment, thread: NoteComment[]) => void;
  /** Marks the whole thread resolved in comment metadata. */
  onResolveThread?: (rootId: string) => void;
  /** Clears resolved state from the whole thread. */
  onUnresolveThread?: (rootId: string) => void;
  /** Opens a note referenced by an encoded comment mention. */
  onNavigateToMention?: (title: string, mentionId?: string) => void;
}

/** Formats a Unix timestamp (seconds) into an absolute date/time string for tooltip display. */
function formatAbsoluteTime(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000);
  const now = new Date();
  const monthName = date.toLocaleString('en-US', { month: 'short' });
  const day = date.getDate();
  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  if (date.getFullYear() !== now.getFullYear()) {
    const shortYear = `'${String(date.getFullYear()).slice(2)}`;
    return `${monthName} ${day} ${shortYear}, ${timeStr}`;
  }
  return `${monthName} ${day}, ${timeStr}`;
}

/** Resolve the thread root for an activated comment by walking parentId upward. */
function resolveThreadRoot(
  comment: NoteComment,
  commentsMap: Record<string, NoteComment>
): NoteComment {
  // Start from the live map entry (the activated `comment` may be a stale
  // snapshot) so the rendered root reflects the latest edits.
  let current = commentsMap[comment.id] ?? comment;
  const seen = new Set<string>([current.id]);
  while (current.parentId) {
    const parent = commentsMap[current.parentId];
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

interface CommentMessageProps {
  comment: NoteComment;
  showTopSeparator?: boolean;
  noteId: string;
  isEditing: boolean;
  editText: string;
  editImageUrls: string[];
  editDisplaySrcs: (string | null)[];
  editFooterPortalTarget?: HTMLElement | null;
  onEditTextChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: (currentText?: string) => void;
  onEditTransitionRunnerChange: (
    commentId: string,
    runner: ((update: () => void) => void) | null
  ) => void;
  onEditImageAttach: () => void;
  onEditImageRemove: (index: number) => void;
  onOpenEditImage: (index: number) => void;
  onDelete: () => void;
  onSendToAgent?: () => void;
  onNavigateToMention?: (title: string, mentionId?: string) => void;
  resolved?: boolean;
  openViewLightbox: (sources: string[], startIndex: number) => void;
}

/** A single thread comment row. Symmetric layout + attribution. */
function CommentMessage({
  comment,
  showTopSeparator = false,
  noteId,
  isEditing,
  editText,
  editImageUrls,
  editDisplaySrcs,
  editFooterPortalTarget,
  onEditTextChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onEditTransitionRunnerChange,
  onEditImageAttach,
  onEditImageRemove,
  onOpenEditImage,
  onDelete,
  onSendToAgent,
  onNavigateToMention,
  resolved = false,
  openViewLightbox
}: CommentMessageProps) {
  const author = getCommentAuthorDisplay(comment);
  const canEdit = author.source === 'user';
  const timestampSeconds = comment.updatedAt ?? comment.createdAt;
  const relativeTime = formatRelativeTime(timestampSeconds);
  const absoluteTime = formatAbsoluteTime(timestampSeconds);
  const actionContext = useMemo(() => {
    const plainText = stripCommentMentionMarkers(comment.text).replace(/\s+/g, ' ').trim();
    const snippet = plainText.length > 48 ? `${plainText.slice(0, 48)}...` : plainText;
    return snippet
      ? `comment by ${author.label} at ${absoluteTime}: ${snippet}`
      : `comment by ${author.label} at ${absoluteTime}`;
  }, [absoluteTime, author.label, comment.text]);

  const viewImageUrls = useMemo(
    () => comment.imageUrls ?? (comment.imageUrl ? [comment.imageUrl] : []),
    [comment.imageUrl, comment.imageUrls]
  );
  const viewDisplaySrcs = useMemo(
    () => viewImageUrls.map(url => toDisplaySrc(url, noteId)),
    [noteId, viewImageUrls]
  );
  const messageRef = useRef<HTMLDivElement | null>(null);
  const modeTransitionStartHeightRef = useRef<number | null>(null);
  const modeTransitionAnimationRef = useRef<Animation | null>(null);
  const modeTransitionCleanupTimerRef = useRef<number | null>(null);

  const runModeTransition = useCallback((update: () => void) => {
    const element = messageRef.current;
    if (
      !element ||
      typeof element.animate !== 'function' ||
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    ) {
      update();
      return;
    }

    const startHeight = element.getBoundingClientRect().height;
    if (modeTransitionCleanupTimerRef.current !== null) {
      window.clearTimeout(modeTransitionCleanupTimerRef.current);
      modeTransitionCleanupTimerRef.current = null;
    }
    const previousAnimation = modeTransitionAnimationRef.current;
    modeTransitionAnimationRef.current = null;
    previousAnimation?.cancel();
    element.style.removeProperty('overflow');
    modeTransitionStartHeightRef.current = startHeight;
    update();
  }, []);

  useLayoutEffect(() => {
    if (!isEditing) return;
    onEditTransitionRunnerChange(comment.id, runModeTransition);
    return () => onEditTransitionRunnerChange(comment.id, null);
  }, [comment.id, isEditing, onEditTransitionRunnerChange, runModeTransition]);

  useLayoutEffect(() => {
    const startHeight = modeTransitionStartHeightRef.current;
    modeTransitionStartHeightRef.current = null;
    const element = messageRef.current;
    if (startHeight === null || !element) return;

    const endHeight = element.getBoundingClientRect().height;
    if (Math.abs(endHeight - startHeight) < 0.5) return;

    element.style.overflow = 'hidden';
    const animation = element.animate(
      [{ height: `${startHeight}px` }, { height: `${endHeight}px` }],
      { duration: 150, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
    );
    modeTransitionAnimationRef.current = animation;
    const finishTransition = () => {
      if (modeTransitionAnimationRef.current !== animation) return;
      modeTransitionAnimationRef.current = null;
      if (modeTransitionCleanupTimerRef.current !== null) {
        window.clearTimeout(modeTransitionCleanupTimerRef.current);
        modeTransitionCleanupTimerRef.current = null;
      }
      element.style.removeProperty('overflow');
    };
    animation.addEventListener('finish', finishTransition, { once: true });
    modeTransitionCleanupTimerRef.current = window.setTimeout(() => {
      if (modeTransitionAnimationRef.current === animation) {
        modeTransitionAnimationRef.current = null;
        animation.cancel();
        element.style.removeProperty('overflow');
      }
      modeTransitionCleanupTimerRef.current = null;
    }, 200);
  }, [isEditing]);

  useEffect(
    () => () => {
      modeTransitionStartHeightRef.current = null;
      if (modeTransitionCleanupTimerRef.current !== null) {
        window.clearTimeout(modeTransitionCleanupTimerRef.current);
        modeTransitionCleanupTimerRef.current = null;
      }
      const animation = modeTransitionAnimationRef.current;
      modeTransitionAnimationRef.current = null;
      animation?.cancel();
      messageRef.current?.style.removeProperty('overflow');
    },
    []
  );

  return (
    <div
      ref={messageRef}
      data-comment-message
      data-comment-editing={isEditing ? 'true' : undefined}
      className={cn(
        'comment-edit-surface group/msg',
        isEditing && 'comment-draft-surface',
        isEditing && 'border-border-draft-edge',
        isEditing && showTopSeparator && 'border-t',
        isEditing && !editFooterPortalTarget && 'border-b',
        !isEditing && showTopSeparator && 'border-t border-border-subtle/30',
        !isEditing &&
          showTopSeparator &&
          resolved &&
          'border-t-2 border-dotted border-border-subtle/30'
      )}
    >
      <div>
        <TooltipProvider>
          <div
            data-comment-message-header
            className="flex items-center justify-between gap-2 px-3 pt-2"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              {author.source === 'agent' && (
                <span
                  className="moss-agent-indicator flex h-3.5 w-3.5 shrink-0 items-center text-ink-muted"
                  aria-hidden
                >
                  <img
                    src={MossSproutIcon}
                    alt=""
                    className="moss-agent-sprout-image h-3.5 w-auto shrink-0"
                  />
                  <span className="moss-agent-sprout-mark h-3.5 w-3.5 shrink-0" />
                </span>
              )}
              <span className={cn('truncate text-caption font-medium', author.textClass)}>
                {author.label}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    data-comment-timestamp
                    className="shrink-0 cursor-default text-caption font-extralight text-ink-faint"
                  >
                    {relativeTime}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}>
                  {absoluteTime}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              {isEditing ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(COMMENT_CANCEL_BUTTON_CLASS, '-mr-1')}
                      aria-label="Cancel comment edit"
                      onClick={() => runModeTransition(onCancelEdit)}
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}>
                    Cancel edit
                  </TooltipContent>
                </Tooltip>
              ) : !resolved ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus:outline-none focus-visible:ring-0"
                      aria-label={`Comment actions for ${actionContext}`}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" sideOffset={4} className="min-w-32">
                    {canEdit && (
                      <DropdownMenuItem
                        className="gap-2 text-xs"
                        aria-label={`Edit ${actionContext}`}
                        onSelect={() => runModeTransition(onStartEdit)}
                      >
                        <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        Edit
                      </DropdownMenuItem>
                    )}
                    {onSendToAgent && (
                      <DropdownMenuItem
                        className="gap-2 text-xs"
                        aria-label={`Send ${actionContext} to agent`}
                        onSelect={onSendToAgent}
                      >
                        <Send className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        Send to Agent
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      className="gap-2 text-xs text-accent-terracotta focus:text-accent-terracotta data-[highlighted]:text-accent-terracotta"
                      aria-label={`Delete ${actionContext}`}
                      onSelect={onDelete}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span data-comment-actions-placeholder className="h-6 w-6 shrink-0" aria-hidden />
              )}
            </div>
          </div>

          <div
            data-comment-edit-composer={isEditing ? true : undefined}
            data-comment-view-content={isEditing ? undefined : true}
            className={cn('min-w-0', !isEditing && 'px-3 pb-2')}
          >
            {isEditing ? (
              <CommentTextInput
                value={editText}
                ariaLabel={`Editing comment by ${author.label} from ${absoluteTime}`}
                onChange={onEditTextChange}
                onSubmit={currentText => runModeTransition(() => onSaveEdit(currentText))}
                submitDisabled={!editText.trim() && editImageUrls.length === 0}
                autoFocus
                persistentFooter
                footerPortalTarget={editFooterPortalTarget}
                imageAttachments={{
                  imageUrls: editImageUrls,
                  onAttach: onEditImageAttach,
                  onRemove: onEditImageRemove,
                  onOpen: onOpenEditImage,
                  displaySrcs: editDisplaySrcs
                }}
              />
            ) : (
              <>
                <p className="mt-1 whitespace-pre-wrap break-words text-left text-small leading-relaxed text-ink-default">
                  <CommentTextContent
                    text={comment.text}
                    onNavigateToMention={onNavigateToMention}
                  />
                </p>
                {viewDisplaySrcs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {viewDisplaySrcs.map((src, index) => {
                      if (!src) return null;
                      return (
                        <button
                          key={`${viewImageUrls[index]}-${index}`}
                          type="button"
                          className="cursor-zoom-in"
                          onClick={() =>
                            openViewLightbox(
                              viewDisplaySrcs.filter((s): s is string => Boolean(s)),
                              index
                            )
                          }
                          aria-label={`View attachment ${index + 1} of ${viewDisplaySrcs.length}`}
                        >
                          <img
                            src={src}
                            alt="Comment attachment"
                            className="h-20 w-20 rounded border border-ink-default/5 object-cover object-left-top transition-opacity hover:opacity-80"
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}

export function CommentPopover({
  open,
  onOpenChange,
  anchorRect,
  placement = 'bottom-end',
  comment,
  commentsMap,
  noteId,
  paneId,
  collisionBoundary = null,
  onUpdate,
  onDelete,
  onReply,
  onSendToAgent,
  onResolveThread,
  onUnresolveThread,
  onNavigateToMention
}: CommentPopoverProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [editImageUrls, setEditImageUrls] = useState<string[]>([]);
  const [replyText, setReplyText] = useState('');
  const [replyImageUrls, setReplyImageUrls] = useState<string[]>([]);
  const [replyResetSignal, setReplyResetSignal] = useState(0);
  const [editFooterHost, setEditFooterHost] = useState<HTMLDivElement | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    scope: CommentDeletionScope;
  } | null>(null);
  const [showBottomFade, setShowBottomFade] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const [threadContent, setThreadContent] = useState<HTMLDivElement | null>(null);
  const scrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [threadMaxHeightPx, setThreadMaxHeightPx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollResizeObserverRef = useRef<ResizeObserver | null>(null);
  const pendingEditScrollTopRef = useRef<number | null>(null);
  const activeEditTransitionRunnerRef = useRef<{
    commentId: string;
    run: (update: () => void) => void;
  } | null>(null);
  const focusLockReleaseRef = useRef<(() => void) | null>(null);
  const setLightboxSrc = useSetAtom(lightboxSrcAtom);
  const lightboxState = useAtomValue(lightboxSrcAtom);
  const lightboxDismissGuardRef = useRef(false);
  const resolvedCollisionBoundary = useMemo(
    () => resolveCanvasCollisionBoundary(collisionBoundary, anchorRect),
    [anchorRect, collisionBoundary]
  );

  // Derive the thread: root + chronological child comments (flattened subtree).
  const root = useMemo(() => resolveThreadRoot(comment, commentsMap), [comment, commentsMap]);
  const replies = useMemo(() => {
    return collectCommentSubtreeIds(commentsMap, root.id)
      .filter(id => id !== root.id)
      .map(id => commentsMap[id])
      .filter((c): c is NoteComment => Boolean(c))
      .sort((a, b) => a.createdAt - b.createdAt);
  }, [commentsMap, root.id]);

  const isResolvedThread = typeof root.resolvedAt === 'number';
  const lastCommentId = replies.at(-1)?.id ?? root.id;
  const isEditingLastComment = editingId === lastCommentId;

  // Announce this thread's final geometry to whoever asked for it (the comment
  // list uses it to decide whether it now sits under this popover). Only this
  // component can know when Base UI has finished positioning, so it reports
  // rather than letting callers guess a frame count.
  useEffect(() => {
    if (!open || !threadContent) return;
    let frame = 0;
    let attempts = 0;
    let previous: { left: number; right: number; top: number; bottom: number } | null = null;
    const announce = () => {
      // Measure the positioner, not the popup: the popup runs a zoom-in
      // entrance animation, so its own rect changes every frame and never
      // settles. The positioner carries the resolved placement.
      const positioner = threadContent.parentElement ?? threadContent;
      const { left, right, top, bottom } = positioner.getBoundingClientRect();
      // Report only once the rect holds still for two consecutive frames. A
      // fresh popover starts at 0x0, and switching threads leaves this element
      // mounted at the previous thread's position for a frame — announcing
      // either would hand the listener a rect that is about to move.
      const settled = previous !== null
        && previous.left === left && previous.right === right
        && previous.top === top && previous.bottom === bottom;
      if (settled && right > left && bottom > top) {
        dispatchCommentThreadPlaced({
          noteId,
          paneId,
          commentId: root.id,
          rect: { left, right, top, bottom }
        });
        return;
      }
      previous = { left, right, top, bottom };
      if (attempts < 8) {
        attempts += 1;
        frame = requestAnimationFrame(announce);
      }
    };
    frame = requestAnimationFrame(announce);
    return () => cancelAnimationFrame(frame);
  }, [noteId, open, paneId, root.id, threadContent]);

  // Virtual anchor ref for Popover positioning
  const virtualRef = useRef({
    getBoundingClientRect: () => new DOMRect(0, 0, 0, 0)
  });
  virtualRef.current = anchorRect
    ? {
        getBoundingClientRect: () =>
          new DOMRect(anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height)
      }
    : { getBoundingClientRect: () => new DOMRect(0, 0, 0, 0) };

  useEffect(() => {
    const updateThreadMaxHeight = () => {
      const boundary = resolvedCollisionBoundary as HTMLElement | null;
      if (!boundary) {
        setThreadMaxHeightPx(null);
        return;
      }
      const canvasHeight = boundary.clientHeight || boundary.getBoundingClientRect().height;
      const viewportMaxHeight = Math.floor(window.innerHeight * COMMENT_THREAD_MAX_VIEWPORT_RATIO);
      const maxHeightCandidates = [
        viewportMaxHeight,
        COMMENT_THREAD_MAX_HEIGHT_PX,
        ...(canvasHeight > 0 ? [Math.floor(canvasHeight * COMMENT_THREAD_MAX_CANVAS_RATIO)] : [])
      ].filter(value => value > 0);
      const nextMaxHeight =
        maxHeightCandidates.length > 0 ? Math.min(...maxHeightCandidates) : null;
      setThreadMaxHeightPx(previous => (previous === nextMaxHeight ? previous : nextMaxHeight));
    };

    updateThreadMaxHeight();
    if (!resolvedCollisionBoundary) return;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updateThreadMaxHeight);
      resizeObserver.observe(resolvedCollisionBoundary);
    }
    window.addEventListener('resize', updateThreadMaxHeight);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateThreadMaxHeight);
    };
  }, [resolvedCollisionBoundary]);

  const acquireFocusLock = useCallback(() => {
    if (!focusLockReleaseRef.current) {
      focusLockReleaseRef.current = acquireExternalEditorFocusLock();
    }
  }, []);

  const releaseFocusLock = useCallback(() => {
    if (!focusLockReleaseRef.current) return;
    focusLockReleaseRef.current();
    focusLockReleaseRef.current = null;
  }, []);

  const resetReplyComposer = useCallback(() => {
    setReplyText('');
    setReplyImageUrls([]);
    setReplyResetSignal(s => s + 1);
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) {
        releaseFocusLock();
        setEditingId(null);
        setEditText('');
        setEditImageUrls([]);
        resetReplyComposer();
        setDeleteTarget(null);
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange, releaseFocusLock, resetReplyComposer]
  );

  useEffect(() => {
    return () => releaseFocusLock();
  }, [releaseFocusLock]);

  useEffect(() => {
    setEditingId(null);
    setEditText('');
    setEditImageUrls([]);
    resetReplyComposer();
    setDeleteTarget(null);
  }, [resetReplyComposer, root.id]);

  const startEdit = useCallback(
    (target: NoteComment) => {
      pendingEditScrollTopRef.current = scrollRef.current?.scrollTop ?? null;
      setEditText(target.text);
      setEditImageUrls(target.imageUrls ?? (target.imageUrl ? [target.imageUrl] : []));
      setEditingId(target.id);
    },
    []
  );

  useLayoutEffect(() => {
    const expectedScrollTop = pendingEditScrollTopRef.current;
    const scrollElement = scrollRef.current;
    if (!editingId || expectedScrollTop === null || !scrollElement) return;

    let active = true;
    let secondFrame: number | null = null;
    const restoreScrollPosition = () => {
      if (active && scrollElement.scrollTop !== expectedScrollTop) {
        scrollElement.scrollTop = expectedScrollTop;
      }
    };
    const handleScroll = () => restoreScrollPosition();

    scrollElement.addEventListener('scroll', handleScroll);
    restoreScrollPosition();
    const firstFrame = window.requestAnimationFrame(() => {
      restoreScrollPosition();
      secondFrame = window.requestAnimationFrame(() => {
        restoreScrollPosition();
        active = false;
        pendingEditScrollTopRef.current = null;
        scrollElement.removeEventListener('scroll', handleScroll);
      });
    });

    return () => {
      active = false;
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      scrollElement.removeEventListener('scroll', handleScroll);
    };
  }, [editingId]);

  const handleSave = useCallback(
    (target: NoteComment, currentText?: string) => {
      const nextText = typeof currentText === 'string' ? currentText : editText;
      const trimmedText = nextText.trim();
      const existingUrls = target.imageUrls ?? (target.imageUrl ? [target.imageUrl] : []);
      const urlsChanged = JSON.stringify(editImageUrls) !== JSON.stringify(existingUrls);
      const hasContent = trimmedText.length > 0 || editImageUrls.length > 0;
      if (hasContent && (trimmedText !== target.text || urlsChanged)) {
        onUpdate(target.id, trimmedText, urlsChanged ? editImageUrls : undefined);
      }
      setEditingId(null);
    },
    [editText, editImageUrls, onUpdate]
  );

  const handleCancelEdit = useCallback(() => {
    setEditingId(null);
    setEditText('');
    setEditImageUrls([]);
  }, []);

  const handleEditTransitionRunnerChange = useCallback(
    (commentId: string, runner: ((update: () => void) => void) | null) => {
      if (runner) {
        activeEditTransitionRunnerRef.current = { commentId, run: runner };
        return;
      }
      if (activeEditTransitionRunnerRef.current?.commentId === commentId) {
        activeEditTransitionRunnerRef.current = null;
      }
    },
    []
  );

  const handleEditImageAttach = useCallback(async () => {
    const results = await imagesApi.pick.invoke({ noteId });
    if (results.length > 0) {
      setEditImageUrls(prev => [...prev, ...results.map(r => r.relativePath)]);
    }
  }, [noteId]);

  const handleEditImageRemove = useCallback((index: number) => {
    setEditImageUrls(prev => prev.filter((_, i) => i !== index));
  }, []);

  const editDisplaySrcs = useMemo(
    () => editImageUrls.map(url => toDisplaySrc(url, noteId)),
    [editImageUrls, noteId]
  );

  const openLightbox = useCallback(
    (sources: string[], startIndex: number) => {
      const clean = sources.filter((src): src is string => Boolean(src));
      if (clean.length === 0) return;
      const index = Math.min(Math.max(startIndex, 0), clean.length - 1);
      lightboxDismissGuardRef.current = true;
      setLightboxSrc({
        kind: 'carousel',
        sources: clean,
        index,
        scope: resolveCanvasLightboxScope(anchorRect)
      });
    },
    [anchorRect, setLightboxSrc]
  );

  const openEditLightbox = useCallback(
    (startIndex: number) =>
      openLightbox(
        editDisplaySrcs.filter((s): s is string => Boolean(s)),
        startIndex
      ),
    [editDisplaySrcs, openLightbox]
  );

  const handleReplyImageAttach = useCallback(async () => {
    const results = await imagesApi.pick.invoke({ noteId });
    if (results.length > 0) {
      setReplyImageUrls(prev => [...prev, ...results.map(r => r.relativePath)]);
    }
  }, [noteId]);

  const handleReplyImageRemove = useCallback((index: number) => {
    setReplyImageUrls(prev => prev.filter((_, i) => i !== index));
  }, []);

  const replyDisplaySrcs = useMemo(
    () => replyImageUrls.map(url => toDisplaySrc(url, noteId)),
    [noteId, replyImageUrls]
  );

  const openReplyLightbox = useCallback(
    (startIndex: number) =>
      openLightbox(
        replyDisplaySrcs.filter((s): s is string => Boolean(s)),
        startIndex
      ),
    [openLightbox, replyDisplaySrcs]
  );

  const handleReplySubmit = useCallback(
    (currentText?: string) => {
      const text = (typeof currentText === 'string' ? currentText : replyText).trim();
      if (!onReply) return;
      if (!text && replyImageUrls.length === 0) return;
      const created = onReply(
        root.id,
        text,
        replyImageUrls.length > 0 ? replyImageUrls : undefined
      );
      if (!created) return;
      // Force-clear the still-mounted composer (the anti-echo guard would
      // otherwise keep the just-typed text) and keep focus for the next comment.
      resetReplyComposer();
    },
    [onReply, replyText, replyImageUrls, resetReplyComposer, root.id]
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    const closesThread =
      deleteTarget.scope === 'thread' || (deleteTarget.id === root.id && replies.length === 0);
    onDelete(deleteTarget.id, deleteTarget.scope);
    setDeleteTarget(null);
    if (closesThread) {
      handleOpenChange(false);
    }
  }, [deleteTarget, handleOpenChange, onDelete, replies.length, root.id]);

  const side = placement === 'right-start' ? ('right' as const) : ('bottom' as const);
  const align = placement === 'right-start' ? ('start' as const) : ('end' as const);
  const isVisible = open && !!anchorRect;

  useEffect(() => {
    if (!isVisible) return;
    return acquireCommentUiOpenFlag();
  }, [isVisible]);

  useEffect(() => {
    if (lightboxState) {
      lightboxDismissGuardRef.current = true;
      return;
    }
    if (!lightboxDismissGuardRef.current) return;
    const releaseGuard = window.setTimeout(() => {
      lightboxDismissGuardRef.current = false;
    }, 0);
    return () => window.clearTimeout(releaseGuard);
  }, [lightboxState]);

  const shouldKeepOpenForLightbox = useCallback(() => {
    return lightboxDismissGuardRef.current || lightboxState !== null;
  }, [lightboxState]);

  // Show a bottom fade above the footer when the thread body overflows and is
  // not scrolled to the end, signalling there is more thread to read.
  const updateScrollFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const overflowing = el.scrollHeight - el.clientHeight > 1;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1;
    setShowBottomFade(overflowing && !atBottom);
  }, []);

  // Callback ref: the popover content is portaled and mounts a frame after the
  // wrapper, so a plain effect would measure before the scroll node exists.
  // Wiring the observer here runs exactly when the node attaches — measuring
  // once layout has settled — so an overflowing thread shows the fade on open,
  // not only after the first user scroll.
  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      scrollResizeObserverRef.current?.disconnect();
      scrollResizeObserverRef.current = null;
      if (!node) return;
      updateScrollFade();
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => updateScrollFade());
        ro.observe(node);
        scrollResizeObserverRef.current = ro;
      }
    },
    [updateScrollFade]
  );

  // Re-measure when thread content changes (comments added, expanded, edited).
  useEffect(() => {
    updateScrollFade();
  }, [updateScrollFade, root.id, replies.length, editingId, isResolvedThread]);

  // Reveal the scrollbar only while the thread is actually scrolling, matching
  // CanvasArea. A permanently visible bar reads as chrome on a surface whose
  // whole design goal is to stay secondary to note content.
  const handleThreadScroll = useCallback(() => {
    updateScrollFade();
    setIsScrolling(true);
    if (scrollIdleTimerRef.current) clearTimeout(scrollIdleTimerRef.current);
    scrollIdleTimerRef.current = setTimeout(() => {
      scrollIdleTimerRef.current = null;
      setIsScrolling(false);
    }, 400);
  }, [updateScrollFade]);

  useEffect(
    () => () => {
      if (scrollIdleTimerRef.current) {
        clearTimeout(scrollIdleTimerRef.current);
        scrollIdleTimerRef.current = null;
      }
    },
    []
  );

  if (!anchorRect) return null;

  return (
    <>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Popover.Anchor virtualRef={virtualRef} />
        <Popover.Portal>
          <Popover.Content
            ref={setThreadContent}
            side={side}
            align={align}
            sideOffset={8}
            collisionBoundary={resolvedCollisionBoundary ? [resolvedCollisionBoundary] : undefined}
            collisionPadding={{
              top: 16,
              right: 16,
              bottom: TOOLBAR_HEIGHT,
              left: 16
            }}
            avoidCollisions
            onOpenAutoFocus={e => e.preventDefault()}
            onCloseAutoFocus={e => e.preventDefault()}
            onPointerDownOutside={e => {
              const target = e.target as HTMLElement | null;
              if (shouldKeepOpenForLightbox() || target?.closest?.('[data-moss-media-lightbox]')) {
                e.preventDefault();
                return;
              }
              if (target?.closest?.('.comment-mark')) {
                e.preventDefault();
              }
              const dialog = target?.closest?.('[role="dialog"]');
              if (dialog && !dialog.closest('[data-radix-popper-content-wrapper]')) {
                e.preventDefault();
              }
              if (deleteTarget) {
                e.preventDefault();
              }
            }}
            onFocusOutside={e => {
              if (deleteTarget || shouldKeepOpenForLightbox()) {
                e.preventDefault();
              }
            }}
            onEscapeKeyDown={e => {
              if (editingId) {
                e.preventDefault();
                const activeTransition = activeEditTransitionRunnerRef.current;
                if (activeTransition?.commentId === editingId) {
                  activeTransition.run(handleCancelEdit);
                } else {
                  handleCancelEdit();
                }
              }
              if (deleteTarget || shouldKeepOpenForLightbox()) {
                e.preventDefault();
              }
            }}
            onFocusCapture={() => acquireFocusLock()}
            style={{
              maxHeight: threadMaxHeightPx ? `${threadMaxHeightPx}px` : undefined
            }}
            className={cn(
              'moss-comment-popover z-50 flex max-h-comment-thread-viewport w-comment-thread-popover max-w-floating-popover-viewport flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-floating shadow-sm data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
              isEditingLastComment && 'border-b-border-draft-edge',
              isResolvedThread && 'border-2 border-dotted border-border-subtle'
            )}
            onMouseDown={event => event.stopPropagation()}
            onClick={event => event.stopPropagation()}
          >
            <TooltipProvider>
              <div
                data-comment-thread-header
                className={cn(
                  // Flush with the card so the border-bottom carries the separation.
                  // surface-raised-control composites to the card in light but reads
                  // as a distinct band in dark, colliding with the draft tint.
                  'flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle/30 bg-surface-floating px-2 py-1.5',
                  editingId === root.id && 'border-border-draft-edge',
                  isResolvedThread && 'border-b-2 border-dotted border-border-subtle/30'
                )}
              >
                <span className="sr-only">
                  {isResolvedThread ? 'Resolved comment thread' : 'Comment thread'}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <MessageSquareText
                    aria-hidden
                    className="ml-1 mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint"
                    strokeWidth={1.5}
                  />
                  <span className="truncate text-caption font-normal text-ink-faint">
                    Comment
                  </span>
                </div>
                <div data-comment-thread-actions className="flex items-center gap-0.5">
                  {(onResolveThread || onUnresolveThread) && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-surface-panel focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15',
                            isResolvedThread
                              ? 'text-accent-brand hover:text-accent-brand-pressed'
                              : 'text-ink-faint hover:text-ink-muted'
                          )}
                          aria-label="Resolve thread"
                          aria-pressed={isResolvedThread}
                          onClick={() => {
                            if (isResolvedThread) {
                              onUnresolveThread?.(root.id);
                              return;
                            }
                            onResolveThread?.(root.id);
                          }}
                        >
                          <CheckCheck className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        {isResolvedThread ? 'Resolved' : 'Resolve thread'}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  {onSendToAgent && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={isResolvedThread}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-surface-transparent disabled:hover:text-ink-faint focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                          aria-label="Send thread to agent"
                          onClick={() => onSendToAgent(root, [root, ...replies])}
                        >
                          <Send className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>
                        Send thread to agent
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-accent-terracotta focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15"
                        aria-label="Delete thread"
                        onClick={() => setDeleteTarget({ id: root.id, scope: 'thread' })}
                      >
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>
                      Delete thread
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>
            </TooltipProvider>

            <div
              ref={setScrollNode}
              onScroll={handleThreadScroll}
              data-scrolling={isScrolling ? 'true' : 'false'}
              className="comment-thread-scroll min-h-0 flex-1 overflow-y-auto"
            >
              <CommentMessage
                comment={root}
                noteId={noteId}
                isEditing={editingId === root.id}
                editText={editText}
                editImageUrls={editImageUrls}
                editDisplaySrcs={editDisplaySrcs}
                editFooterPortalTarget={
                  editingId === root.id && isEditingLastComment ? editFooterHost : null
                }
                onEditTextChange={setEditText}
                onStartEdit={() => startEdit(root)}
                onCancelEdit={handleCancelEdit}
                onSaveEdit={text => handleSave(root, text)}
                onEditTransitionRunnerChange={handleEditTransitionRunnerChange}
                onEditImageAttach={handleEditImageAttach}
                onEditImageRemove={handleEditImageRemove}
                onOpenEditImage={openEditLightbox}
                onDelete={() => setDeleteTarget({ id: root.id, scope: 'comment' })}
                onSendToAgent={
                  onSendToAgent ? () => onSendToAgent(root, [root, ...replies]) : undefined
                }
                onNavigateToMention={onNavigateToMention}
                resolved={isResolvedThread}
                openViewLightbox={openLightbox}
              />

              {replies.map((reply, index) => (
                <CommentMessage
                  key={reply.id}
                  comment={reply}
                  showTopSeparator={
                    editingId !== (index === 0 ? root.id : replies[index - 1]?.id)
                  }
                  noteId={noteId}
                  isEditing={editingId === reply.id}
                  editText={editText}
                  editImageUrls={editImageUrls}
                  editDisplaySrcs={editDisplaySrcs}
                  editFooterPortalTarget={
                    editingId === reply.id && isEditingLastComment ? editFooterHost : null
                  }
                  onEditTextChange={setEditText}
                  onStartEdit={() => startEdit(reply)}
                  onCancelEdit={handleCancelEdit}
                  onSaveEdit={text => handleSave(reply, text)}
                  onEditTransitionRunnerChange={handleEditTransitionRunnerChange}
                  onEditImageAttach={handleEditImageAttach}
                  onEditImageRemove={handleEditImageRemove}
                  onOpenEditImage={openEditLightbox}
                  onDelete={() => setDeleteTarget({ id: reply.id, scope: 'comment' })}
                  onSendToAgent={
                    onSendToAgent ? () => onSendToAgent(reply, [root, ...replies]) : undefined
                  }
                  onNavigateToMention={onNavigateToMention}
                  resolved={isResolvedThread}
                  openViewLightbox={openLightbox}
                />
              ))}
            </div>
            {showBottomFade && (
              <div className="pointer-events-none relative h-0" aria-hidden>
                <div className="absolute inset-x-0 -top-8 z-10 h-8 bg-gradient-to-t from-surface-floating to-surface-transparent" />
              </div>
            )}

            {onReply && !isResolvedThread && (
              <div
                data-comment-reply-region
                data-editing={editingId && !isEditingLastComment ? 'true' : 'false'}
                data-last-editing={isEditingLastComment ? 'true' : 'false'}
                aria-hidden={editingId && !isEditingLastComment ? true : undefined}
                inert={editingId && !isEditingLastComment ? true : undefined}
                className="comment-reply-region shrink-0"
              >
                <div className="comment-reply-region-inner relative">
                  <div
                    data-comment-reply-composer="true"
                    aria-hidden={editingId ? true : undefined}
                    inert={editingId ? true : undefined}
                    className={cn(
                      'comment-draft-surface border-t border-border-draft-edge transition-opacity duration-150 ease-out motion-reduce:transition-none',
                      editingId && 'pointer-events-none opacity-0'
                    )}
                  >
                    <CommentTextInput
                      value={replyText}
                      onChange={setReplyText}
                      onSubmit={handleReplySubmit}
                      submitDisabled={!replyText.trim() && replyImageUrls.length === 0}
                      placeholder="Reply..."
                      autoFocus
                      externalFocusLock
                      resetSignal={replyResetSignal}
                      imageAttachments={{
                        imageUrls: replyImageUrls,
                        onAttach: handleReplyImageAttach,
                        onRemove: handleReplyImageRemove,
                        onOpen: openReplyLightbox,
                        displaySrcs: replyDisplaySrcs
                      }}
                    />
                  </div>
                  <div
                    ref={setEditFooterHost}
                    data-comment-edit-footer-host="true"
                    className={cn(
                      'comment-draft-surface pointer-events-none absolute inset-x-0 bottom-0 opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none',
                      isEditingLastComment &&
                        'pointer-events-auto opacity-100 after:pointer-events-none after:absolute after:inset-x-0 after:top-0 after:h-px after:bg-border-control-divider'
                    )}
                  />
                </div>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <ConfirmationDialog
        open={deleteTarget !== null}
        onOpenChange={next => {
          if (!next) setDeleteTarget(null);
        }}
        collisionBoundary={resolvedCollisionBoundary}
        title={deleteTarget?.scope === 'thread' ? 'Delete comment thread?' : 'Delete comment?'}
        description={
          deleteTarget?.scope === 'thread'
            ? 'This deletes every comment in the thread. This action cannot be undone.'
            : 'This action cannot be undone.'
        }
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
      />
    </>
  );
}

export default CommentPopover;

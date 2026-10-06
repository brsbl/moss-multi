// ported-from: packages/desktop/src/renderer/panels/CanvasAreaContent.tsx @ 762abb777
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom, useStore } from 'jotai';
import type { EditorState, LexicalEditor } from 'lexical';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_UP_COMMAND,
  SELECTION_CHANGE_COMMAND
} from 'lexical';
import { $convertToMarkdownString } from '@lexical/markdown';
import { $isHeadingNode } from '@lexical/rich-text';

import {
  activeNoteEntityAtom,
  CanvasArea,
  cleanupLinkResolutionCache,
  noteActionTabsAtom,
  noteContentAtom,
  noteLinksAtom,
  syncNoteEntityAtom,
  hydrateNotesAtom,
  noteEntityAtom,
  focusedPaneAtom,
  setFocusPaneAtom,
  NO_NOTE_SENTINEL,
  noteCommentsMapAtom,
  noteCommentAnchorIdsAtom,
  noteCommentAnchorIdsSyncedAtom,
  commentDirtySignalAtom,
  commentThreadFilterAtom,
  noteFrontmatterAtom,
  frontmatterDirtySignalAtom,
  pendingFrontmatterMetaAtom,
  uiAgentBusyNoteIdsAtom,
  removeNoteEntityAtom,
  pendingSavePromiseAtom,
  noteCollapsedHeadingsAtom,
  setCommentSubtreeResolvedState,
  placeholderIndexAtom,
  workspaceFrontmatterSuggestionsAtom,
  KeyboardShortcut,
  useNotePaneDialogPosition,
  type NoteComment,
} from '@moss/shared';
// Import the command-palette atoms from the SAME subpath the palette + other
// openers (App.tsx, CommandPaletteOverlay, CommentUIWrapper) use. The '@moss/shared'
// barrel can resolve to a separate module instance of atoms.ts, which would make
// store.set target a different atom than App's useAtom reads (palette never opens).
import { showCommandPaletteAtom, commandPaletteOriginAtom, pendingAgentCommentContextAtom, promptDraftAtom } from '@moss/shared/state/atoms';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@moss/shared/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@moss/shared/components/ui/dropdown-menu';
import { Popover } from '@moss/shared/primitives';
import { AlertTriangle, ArrowLeft, ArrowRight, EllipsisVertical, FileCode, FileDigit, FileDown, FileText, FileX, Link, Loader2, MessageSquareText, PanelLeft, PanelRight, RotateCcw, Search, Send, Trash2, Upload, X } from 'lucide-react';
import { ClaudeIcon } from '@moss/shared/components/brand/ClaudeIcon';
import { Dialog } from '@moss/shared/primitives';
import { cn } from '@moss/shared/lib/utils';
import type {
  ExportNotePdfInput,
  NoteLayoutMetadata,
  NoteWithContent
} from '../../common/noteTypes';

import { agentApi, externalNotesApi, notesApi, remoteWebSurfaceApi, shellApi, systemApi } from '../api/electron';
import {
  MarkdownEditor,
  MARKDOWN_EDITOR_TRANSFORMERS,
  $applyTableLayoutMetadata,
  $applyTabGroupLayoutMetadata,
  $collectTableLayoutMetadata,
  $collectTabGroupLayoutMetadata,
  serializeNoteLayoutMetadataForComparison,
  unescapeHtmlEntities,
  type EditorRemountReason,
  type MarkdownEditorHandle
} from '../editor/MarkdownEditor';
import { CopyForAgentDialog } from '../components/CopyForAgentDialog';
import { DialogDimOverlay } from '../components/DialogDimOverlay';
import {
  mapActionTabRecordToEntry
} from '../utils/action-tab-utils';
import { countReachableCommentsInThreads, countReachableRootCommentThreads } from '../editor/utils/comment-thread-count';
import {
  buildCommentThreadListItems,
  COMMENT_THREAD_PLACED_EVENT,
  commentPopoverRectsOverlap,
  computeScrollFadeVisible,
  dispatchOpenCommentThread,
  getCommentMenuButtonState,
  isCommentThreadFilterDisabled,
  splitCommentSearchSegments,
  windowCommentSnippetAroundMatch,
  type CommentThreadPlacedEventDetail
} from '../editor/utils/comment-entry-point';
import {
  ADDRESS_ALL_OPEN_COMMENTS_PROMPT,
  buildPendingCommentContext,
  collectReachableCommentThreadsForAgent
} from '../editor/utils/comment-agent-context';
import { CommentTextContent } from '../editor/components/CommentTextContent';
import { buildCommentMetadata } from '../editor/utils/comment-export';
import {
  assembleNote,
  buildCommentMetadataSignature,
  collectReachableCommentThreadIds,
  disassembleNote,
  extractCommentAnchorIds,
  dropUnreachableCommentMetadata,
  findExternallyChangedUnreachableCommentMetadata,
  hasLegacyCommentFooter,
  mergeCommentMetadata,
  parseCommentFooter,
  rebaseActiveUserSaveOnLatestDisk,
  rebaseNonBodySaveOnLatestDisk,
  type CommentMetadataMap
} from '../../common/markdown-layers';
import {
  assessMarkdownSafety,
  RENDERER_MARKDOWN_SAFETY_LIMITS
} from '../../common/markdown-safety';
import { hydrateComments } from '../editor/utils/comment-import';
import { flushDecoratorDrafts } from '../editor/utils/decoratorDraftRegistry';
import { splitFrontmatter, joinFrontmatter, type FrontmatterSplitResult } from '../editor/utils/noteFrontmatter';

import { NoteSearchInput } from '../components/NoteSearchInput';
import {
  CANVAS_LIGHTBOX_SCOPE_ATTR,
  ImageLightbox,
  getCanvasLightboxScope,
  lightboxSrcAtom
} from '../editor/components/ImageLightbox';
import {
  buildCopyNoteLinkClipboardData,
  buildMossNoteLinkClipboardHtml,
  resolveNoteLinkCopiedMessage,
  NOTE_LINK_COPIED_EVENT,
  type NoteLinkCopiedEventDetail
} from '../editor/utils/note-link-clipboard';
import {
  getSelectedHeadingTextForCopy,
  preserveEditorSelectionOnMouseDown
} from '../editor/utils/heading-selection';
import {
  DIRTY_TRACKER_CONTENT_TAGS,
  DIRTY_TRACKER_DERIVED_TAGS,
  DIRTY_TRACKER_IGNORED_TAGS,
  hasTrackedEditorUpdateTag
} from '../editor/utils/editorUpdateTags';
import { $isPointAtRootStart } from '../editor/utils/selection-boundaries';
import { clearPreloadedNoteRecord, takePreloadedNoteRecord } from '../utils/preloaded-note-record-cache';
import { stripMossSyntax, stripTableColumnWidthComments } from '../editor/utils/markdown-export';
import { hasActiveEditorTextSelection } from '../editor/utils/canvas-selection';
import { NoteBreadcrumb } from '../components/NoteBreadcrumb';
import { useTitleEmojiTypeahead } from './useTitleEmojiTypeahead';
import { TopNavBar, TopNavIconButton, TOP_NAV_ICON_SIZE_CLASSNAMES } from './TopNavControls';
import { isQuitProfilingEnabled } from '../utils/renderer-env';
// moss-multi seam: hide-registry (A§9)
import { hidden } from '@moss-multi/host/affordances';
// moss-multi seam: bound-pane (A§2.2, A§10.3): the one hook for the doc binding, its gate and the pane's attributes
import { useMossMultiPane } from '@moss-multi/host/collab/pane';
// moss-multi seam: trash (T2.3): only the owner trashes or restores; trash copy comes from the one module
import { TRASH_COPY } from '@moss-multi/host/retention';
import { canTrashNote } from '@moss-multi/host/trash';

const TRASH_RETENTION_DAYS = 30;
const MS_IN_DAY = 24 * 60 * 60 * 1000;
const TRASH_COUNTDOWN_REFRESH_MS = 60 * 60 * 1000;
const PERIODIC_SAVE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const EDIT_IDLE_AUTOSAVE_DELAY_MS = 1500;
const EDIT_MAX_UNSAVED_WINDOW_MS = 15000;
const ACTIVE_NOTE_DISK_REVALIDATE_DEBOUNCE_MS = 200;
const ACTION_FEEDBACK_DISMISS_MS = 2400;
const ACTION_ERROR_DISMISS_MS = 3800;
const COPY_FEEDBACK_DURATION_MS = 1600;
const profilePaneQuit = (
  phase: string,
  details?: Record<string, unknown>,
  startedAt?: number
): void => {
  if (!isQuitProfilingEnabled()) {
    return;
  }

  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  console.log('[quit-profile:pane]', JSON.stringify({
    phase,
    ...(typeof startedAt === 'number' ? { atMs: Math.max(0, Math.round(now - startedAt)) } : {}),
    ...(details ?? {})
  }));
};

const waitForPdfLoadingModalPaint = async (): Promise<void> => {
  if (typeof requestAnimationFrame !== 'function') {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return;
  }

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
};
const PLACEHOLDER_PAIRS = [
  { title: 'A spark of something', body: 'Fan the flame...' },
  { title: 'What if...', body: 'Keep pulling that thread...' },
  { title: 'The plot thickens', body: 'Chapter one begins here...' },
  { title: 'Fresh page, fresh start', body: 'Take it anywhere...' },
  { title: 'Aha!', body: 'Quick, write it down before it escapes...' },
  { title: 'One more thing...', body: 'Go on...' },
  { title: 'Untitled masterpiece', body: 'Every great work starts here...' },
  { title: 'Blank canvas', body: 'The first stroke is yours...' },
];

const isDiskConflictSaveError = (message: string): boolean =>
  message.includes('Reload and merge before saving.');

// Active-editor-wins: bounded CAS retries against a racing background writer
// before the backend resolves the final race atomically under the note lock.
const MAX_DISK_CONFLICT_SAVE_RETRIES = 3;

const buildMarkdownSafetyLoadError = (markdown: string): string | null => {
  const assessment = assessMarkdownSafety(markdown, RENDERER_MARKDOWN_SAFETY_LIMITS);
  if (!assessment.failureReason) {
    return null;
  }

  if (assessment.failureReason === 'line_length') {
    return `This note contains an extremely long line (${assessment.maxLineLength.toLocaleString()} characters). Moss skipped rich-text rendering to stay responsive.`;
  }

  return `This note is too large to open safely in rich-text mode (${assessment.charCount.toLocaleString()} characters). Moss skipped rendering to stay responsive.`;
};

const buildCommentSignature = (commentsMap: Record<string, NoteComment>): string => {
  return buildCommentMetadataSignature(buildCommentMetadata(commentsMap));
};

const formatCommentListTimestamp = (createdAt: number): string => {
  const createdMs = createdAt * 1000;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
  if (diffSeconds < 60) return 'now';
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(createdMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

type CommentsListFilter = 'open' | 'resolved' | 'all';

/**
 * Note-header button whose badge follows the selected comment-list tab and
 * hands open threads off to the command palette. Subscribes to comments itself
 * so the rest of the canvas does not re-render on comment edits.
 */
function CommentsMenuButton({
  noteId,
  paneId,
  collisionBoundaryRef
}: {
  noteId: string;
  paneId?: 'left' | 'right';
  collisionBoundaryRef: { current: HTMLElement | null };
}) {
  const store = useStore();
  const openPaletteRafRef = useRef<number | null>(null);
  const pendingOverlapCommentIdRef = useRef<string | null>(null);
  const listContentRef = useRef<HTMLDivElement | null>(null);
  const listScrollRef = useRef<HTMLDivElement | null>(null);
  const listScrollResizeObserverRef = useRef<ResizeObserver | null>(null);
  const [open, setOpen] = useState(false);
  const [listFilter, setListFilter] = useAtom(commentThreadFilterAtom(noteId));
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [showListBottomFade, setShowListBottomFade] = useState(false);
  const commentsMap = useAtomValue(noteCommentsMapAtom(noteId));
  const liveCommentAnchorIds = useAtomValue(noteCommentAnchorIdsAtom(noteId));
  const liveCommentAnchorIdsSynced = useAtomValue(noteCommentAnchorIdsSyncedAtom(noteId));
  const noteContent = useAtomValue(noteContentAtom(noteId));
  const commentAnchorOptions = useMemo(
    () => liveCommentAnchorIdsSynced
      ? { anchorIdsOverride: liveCommentAnchorIds }
      : { extraAnchorIds: liveCommentAnchorIds },
    [liveCommentAnchorIds, liveCommentAnchorIdsSynced]
  );
  const rootThreadCount = useMemo(
    () => countReachableRootCommentThreads(commentsMap, noteContent.content, commentAnchorOptions),
    [commentsMap, noteContent.content, commentAnchorOptions]
  );
  const resolvedThreadCount = useMemo(
    () => countReachableRootCommentThreads(commentsMap, noteContent.content, {
      status: 'resolved',
      ...commentAnchorOptions
    }),
    [commentsMap, noteContent.content, commentAnchorOptions]
  );
  const openCommentCount = useMemo(
    () => countReachableCommentsInThreads(commentsMap, noteContent.content, {
      status: 'open',
      ...commentAnchorOptions
    }),
    [commentsMap, noteContent.content, commentAnchorOptions]
  );
  const resolvedCommentCount = useMemo(
    () => countReachableCommentsInThreads(commentsMap, noteContent.content, {
      status: 'resolved',
      ...commentAnchorOptions
    }),
    [commentsMap, noteContent.content, commentAnchorOptions]
  );
  const allCommentCount = useMemo(
    () => countReachableCommentsInThreads(commentsMap, noteContent.content, {
      status: 'all',
      ...commentAnchorOptions
    }),
    [commentsMap, noteContent.content, commentAnchorOptions]
  );
  const commentMenuButtonState = getCommentMenuButtonState({
    filter: listFilter,
    openCount: openCommentCount,
    resolvedCount: resolvedCommentCount
  });
  useEffect(() => {
    return () => {
      if (openPaletteRafRef.current !== null) {
        cancelAnimationFrame(openPaletteRafRef.current);
        openPaletteRafRef.current = null;
      }
      pendingOverlapCommentIdRef.current = null;
      listScrollResizeObserverRef.current?.disconnect();
      listScrollResizeObserverRef.current = null;
    };
  }, [noteId]);

  const closeList = useCallback(() => {
    setOpen(false);
    setSearchQuery('');
    setSearchOpen(false);
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      closeList();
      return;
    }
    setOpen(true);
  };

  const handleFilterChange = (nextFilter: CommentsListFilter) => {
    if (isCommentThreadFilterDisabled({ filter: nextFilter, resolvedCount: resolvedThreadCount })) return;
    setListFilter(nextFilter);
  };

  const handleToggleSearch = () => {
    setSearchOpen((prev) => {
      const next = !prev;
      if (!next) setSearchQuery('');
      return next;
    });
  };

  const menuLabel = allCommentCount > 0
    ? `Comments, ${allCommentCount} ${allCommentCount === 1 ? 'comment' : 'comments'} total`
    : 'Comments';

  const listItems = buildCommentThreadListItems(commentsMap, noteContent.content, {
    filter: listFilter,
    query: searchQuery,
    ...commentAnchorOptions
  });
  const emptyLabel = listFilter === 'resolved'
    ? 'No resolved comments'
    : listFilter === 'all'
      ? 'No comments'
      : 'No open comments';

  const renderHighlighted = (text: string) =>
    splitCommentSearchSegments(text, searchQuery).map((segment, index) =>
      segment.match ? (
        <mark key={index} className="rounded-sm bg-highlight-search px-0.5 text-ink-default">{segment.text}</mark>
      ) : (
        segment.text
      )
    );

  // Bottom fade when the list overflows and is not scrolled to the end — the
  // same affordance comment threads use. The scroll node is portaled and mounts
  // a frame late, so measure via a callback ref + ResizeObserver, not an effect.
  const updateListScrollFade = useCallback(() => {
    const el = listScrollRef.current;
    if (!el) return;
    setShowListBottomFade(computeScrollFadeVisible(el));
  }, []);

  const setListScrollNode = useCallback((node: HTMLDivElement | null) => {
    listScrollRef.current = node;
    listScrollResizeObserverRef.current?.disconnect();
    listScrollResizeObserverRef.current = null;
    if (!node) return;
    updateListScrollFade();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => updateListScrollFade());
      ro.observe(node);
      listScrollResizeObserverRef.current = ro;
    }
  }, [updateListScrollFade]);

  // Re-measure when the rendered set changes (filter, search, toggle height).
  useEffect(() => {
    updateListScrollFade();
  }, [updateListScrollFade, listItems.length, searchOpen, listFilter]);

  /**
   * The thread popover anchors to its comment, so it lands anywhere down the
   * note — sometimes under this list, sometimes far from it. Close the list
   * only when the two actually collide; a thread opened well clear of the list
   * leaves it up so the reader keeps their place in the thread index.
   *
   * Driven by the popover's own placed announcement rather than a frame count:
   * the open is deferred whenever the anchor has to be revealed out of a hidden
   * tab or collapsed heading first. Matching the requested comment id means a
   * popover still animating out, one belonging to the other pane, or a stale
   * one left over from an open that bailed can never be measured instead.
   */
  useEffect(() => {
    const handlePlaced = (event: Event) => {
      const detail = (event as CustomEvent<CommentThreadPlacedEventDetail>).detail;
      if (detail.noteId !== noteId) return;
      if (detail.paneId !== paneId) return;
      if (detail.commentId !== pendingOverlapCommentIdRef.current) return;
      pendingOverlapCommentIdRef.current = null;
      const listContent = listContentRef.current;
      if (!listContent) return;
      if (commentPopoverRectsOverlap(listContent.getBoundingClientRect(), detail.rect)) {
        closeList();
      }
    };
    window.addEventListener(COMMENT_THREAD_PLACED_EVENT, handlePlaced);
    return () => window.removeEventListener(COMMENT_THREAD_PLACED_EVENT, handlePlaced);
  }, [closeList, noteId, paneId]);

  const handleThreadSelect = (commentId: string) => {
    if (paneId) store.set(setFocusPaneAtom, paneId);
    pendingOverlapCommentIdRef.current = commentId;
    dispatchOpenCommentThread({ noteId, commentId, paneId });
  };

  const handleAddressAll = () => {
    if (rootThreadCount === 0) return;
    // Focus the clicked pane so the derived promptDraftAtom targets this note,
    // then prefill the draft synchronously.
    if (paneId) store.set(setFocusPaneAtom, paneId);
    store.set(
      pendingAgentCommentContextAtom,
      buildPendingCommentContext({
        scope: 'all',
        threads: collectReachableCommentThreadsForAgent(commentsMap, noteContent.content, {
          ...commentAnchorOptions
        }),
        promptText: ADDRESS_ALL_OPEN_COMMENTS_PROMPT
      })
    );
    store.set(promptDraftAtom, ADDRESS_ALL_OPEN_COMMENTS_PROMPT);
    store.set(commandPaletteOriginAtom, 'toolbar');
    // Defer opening to the next frame: the command palette is a base-ui Dialog,
    // and opening it within this click would make the Dialog treat the trailing
    // pointer/focus events as an outside-press and close immediately. Letting the
    // click settle first keeps it open.
    if (openPaletteRafRef.current !== null) {
      cancelAnimationFrame(openPaletteRafRef.current);
    }
    openPaletteRafRef.current = requestAnimationFrame(() => {
      openPaletteRafRef.current = null;
      store.set(showCommandPaletteAtom, true);
    });
  };

  if (!commentMenuButtonState.visible) return null;

  return (
    <TooltipProvider>
      <Popover.Root open={open} onOpenChange={handleOpenChange}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Popover.Trigger asChild>
              <button
                type="button"
                onMouseDown={preserveEditorSelectionOnMouseDown}
                className="flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none"
                aria-label={menuLabel}
                aria-haspopup="dialog"
                aria-expanded={open}
              >
                <MessageSquareText aria-hidden className="h-3.5 w-3.5" />
                {commentMenuButtonState.badgeCount !== null && (
                  <span className="text-micro tabular-nums">{commentMenuButtonState.badgeCount}</span>
                )}
              </button>
            </Popover.Trigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Comments</TooltipContent>
        </Tooltip>
        <Popover.Portal>
          <Popover.Content
            ref={listContentRef}
            align="end"
            side="bottom"
            sideOffset={6}
            collisionBoundary={collisionBoundaryRef.current ? [collisionBoundaryRef.current] : undefined}
            collisionPadding={16}
            className="z-50 flex max-h-comment-list-popover w-comment-list-popover max-w-floating-popover-viewport flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-floating shadow-surface outline-none focus:outline-none focus-visible:ring-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <div className="flex shrink-0 items-center justify-between gap-1 border-b border-border-subtle bg-surface-raised-control px-2 py-1.5">
              <Popover.Title className="sr-only">Comments</Popover.Title>
              <div className="flex min-w-0 items-center gap-1">
                <MessageSquareText aria-hidden className="ml-1 mr-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted" strokeWidth={1.5} />
                {([
                  ['open', 'Open', openCommentCount],
                  ['resolved', 'Resolved', resolvedCommentCount],
                  ['all', 'All', allCommentCount]
                ] as Array<[CommentsListFilter, string, number]>).map(([filterValue, label, count]) => {
                  const disabled = isCommentThreadFilterDisabled({ filter: filterValue, resolvedCount: resolvedThreadCount });
                  const selected = listFilter === filterValue;
                  return (
                    <button
                      key={filterValue}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      className={cn(
                        'flex h-6 items-center gap-1 rounded px-1.5 text-micro transition-colors focus:outline-none focus-visible:ring-0',
                        selected
                          ? 'bg-surface-panel text-ink-default'
                          : 'text-ink-faint hover:bg-surface-panel hover:text-ink-muted',
                        disabled && 'cursor-default opacity-40 hover:bg-surface-transparent hover:text-ink-faint'
                      )}
                      onClick={() => handleFilterChange(filterValue)}
                    >
                      <span>{label}</span>
                      <span className={cn('tabular-nums', selected ? 'text-ink-muted' : 'text-ink-faint')}>{count}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="Search comments"
                      aria-expanded={searchOpen}
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus:outline-none focus-visible:ring-0',
                        searchOpen
                          ? 'bg-surface-panel text-ink-muted'
                          : 'text-ink-faint hover:bg-surface-panel hover:text-ink-muted'
                      )}
                      onClick={handleToggleSearch}
                    >
                      <Search className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>Search comments</TooltipContent>
                </Tooltip>
                {rootThreadCount > 0 && !hidden('ai-run-action') /* moss-multi seam: hide-registry (A§9) */ && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-panel hover:text-ink-muted focus:outline-none focus-visible:ring-0"
                        aria-label="Address open comments"
                        onClick={() => {
                          setOpen(false);
                          handleAddressAll();
                        }}
                      >
                        <Send className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>Address open comments</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>
            {searchOpen && (
              <div className="relative shrink-0 border-b border-border-subtle">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" strokeWidth={1.5} aria-hidden />
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search comments"
                  aria-label="Search comments"
                  className="h-9 w-full bg-surface-transparent pl-9 pr-3 text-caption text-ink-default outline-none placeholder:text-ink-faint"
                />
              </div>
            )}
            <div
              ref={setListScrollNode}
              onScroll={updateListScrollFade}
              className="max-h-comment-list min-h-0 shrink overflow-y-auto py-1"
            >
              {listItems.length > 0 ? (
                listItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="group flex min-h-12 w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-panel focus:outline-none focus-visible:ring-0"
                    aria-label={item.ariaLabel}
                    onClick={() => handleThreadSelect(item.rootId)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={cn('truncate text-micro font-medium', item.authorTextClass)}>
                          {renderHighlighted(item.authorLabel)}
                        </span>
                        <span className="shrink-0 text-micro font-extralight text-ink-faint">
                          {formatCommentListTimestamp(item.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-caption text-ink-muted">
                        {item.snippet
                          ? searchQuery.trim()
                            ? renderHighlighted(windowCommentSnippetAroundMatch(item.snippet, searchQuery))
                            : <CommentTextContent text={item.text} mentionMaxLength={24} />
                          : 'No text'}
                      </p>
                      {/* moss-multi seam: comments (comments.md §6): a detached thread shows the text it was left on */}
                      {(commentsMap[item.rootId] as { detached?: boolean } | undefined)?.detached ? (
                        <p className="mt-0.5 truncate text-micro text-ink-faint" data-comment-detached>
                          Detached · “{(commentsMap[item.rootId] as { quote?: string }).quote ?? ''}”
                        </p>
                      ) : null}
                    </div>
                  </button>
                ))
              ) : (
                <div className="px-3 py-6 text-center text-caption text-ink-faint">{emptyLabel}</div>
              )}
            </div>
            {showListBottomFade && (
              <div className="pointer-events-none relative h-0" aria-hidden>
                <div className="absolute inset-x-0 -top-8 z-10 h-8 bg-gradient-to-t from-surface-floating to-surface-transparent" />
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </TooltipProvider>
  );
}

interface RetryToastState {
  type: 'content';
  noteId: string;
  message: string;
}

type DirtySource = 'user' | 'derived';

export function shouldCaptureEditorSettlingBaseline({
  settlingContentRevision,
  currentContentRevision,
  settlingDirtyRevision,
  currentDirtyRevision,
  dirty,
  dirtySource
}: {
  settlingContentRevision: number;
  currentContentRevision: number;
  settlingDirtyRevision: number;
  currentDirtyRevision: number;
  dirty: boolean;
  dirtySource: DirtySource | null;
}): boolean {
  return settlingContentRevision === currentContentRevision
    && settlingDirtyRevision === currentDirtyRevision
    && !(dirty && dirtySource === 'user');
}

type EditorBodyMarkdownCache = {
  noteId: string;
  contentRevision: number;
  markdownBody: string;
  layoutMetadata: NoteLayoutMetadata;
  survivingCommentIds: Set<string> | undefined;
};

type ResolveCommentThreadOptions = {
  markDirty?: boolean;
  resolvedAt?: number;
  resolvedBy?: 'user' | 'agent' | 'external';
};

type SaveMarkdownBuildOptions = {
  cache?: EditorBodyMarkdownCache | null;
};

type FrontmatterSnapshot = {
  signature: string | null;
  rawBlock: string | null;
  preserveWhenDataNull: boolean;
};

const stableStringifyUnknown = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyUnknown(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringifyUnknown(record[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
};

const buildFrontmatterSignature = (data: Record<string, unknown> | null): string | null => {
  if (!data) {
    return null;
  }
  return stableStringifyUnknown(data);
};

const extractFrontmatterRawBlock = (
  rawMarkdown: string,
  splitResult: FrontmatterSplitResult
): string | null => {
  if (!splitResult.hasFrontmatter) {
    return null;
  }
  const rawBlockLength = rawMarkdown.length - splitResult.body.length;
  if (rawBlockLength <= 0) {
    return null;
  }
  const rawBlock = rawMarkdown.slice(0, rawBlockLength);
  return rawBlock.startsWith('---') ? rawBlock : null;
};

const normalizeTitleDisplayValue = (rawTitle: string | null | undefined): string => {
  const trimmed = (rawTitle ?? '').trim();
  return trimmed === 'Untitled' ? '' : trimmed;
};

const getLastRangeRect = (range: Range): DOMRect | null => {
  if (typeof range.getClientRects !== 'function') {
    return null;
  }
  const rects = range.getClientRects();
  return rects.length > 0 ? rects[rects.length - 1] : null;
};

const isSelectionOnLastTitleLine = (
  container: HTMLDivElement,
  selection: Selection | null
): boolean => {
  if (!selection?.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const range = selection.getRangeAt(0);
  if (range.endContainer !== container && !container.contains(range.endContainer)) {
    return false;
  }

  const prefixRange = document.createRange();
  prefixRange.selectNodeContents(container);
  prefixRange.setEnd(range.endContainer, range.endOffset);
  const caretOffset = prefixRange.toString().length;
  const titleLength = container.textContent?.length ?? 0;
  if (caretOffset >= titleLength) {
    return true;
  }

  try {
    const fullRange = document.createRange();
    fullRange.selectNodeContents(container);
    const fullRects = typeof fullRange.getClientRects === 'function'
      ? fullRange.getClientRects()
      : null;
    const lastLineRect = fullRects && fullRects.length > 0
      ? fullRects[fullRects.length - 1]
      : null;
    const caretLineRect = getLastRangeRect(prefixRange) ?? getLastRangeRect(range);
    if (caretLineRect && lastLineRect) {
      return Math.abs(caretLineRect.bottom - lastLineRect.bottom) <= 5;
    }
    if (caretOffset === 0 && fullRects && fullRects.length > 0) {
      return Math.abs(fullRects[0].bottom - fullRects[fullRects.length - 1].bottom) <= 5;
    }
  } catch {
    // Fall through to native title navigation when line geometry is unavailable.
  }

  return false;
};


type CanvasAreaContentProps = {
  /** Override which note this pane displays. When set, reads noteEntityAtom(noteIdOverride) instead of activeNoteEntityAtom. Used by SplitPaneContainer for the right (split) pane. */
  noteIdOverride?: string;
  /** Hide the top navigation bar. Used for the split right pane. */
  hideTopBar?: boolean;
  /** Hide the right-side toolbar icons (properties, search, link, share, more, panel toggle). Used when another pane owns the icons. */
  hideRightControls?: boolean;
  /** Hide back/forward nav buttons. Used for the split right pane. */
  hideNavButtons?: boolean;
  /** Which pane this instance is in. Used for tab-style focus styling. */
  paneId?: 'left' | 'right';
  /** Called when the user clicks a split-view pane close button. */
  onCloseSplit?: (paneId: 'left' | 'right') => void;
  autoFocusTitle?: boolean;
  onTitleFocusComplete?: () => void;
  autoFocusBody?: boolean;
  onBodyFocusComplete?: () => void;
  onDeleteNote?: (noteId: string) => void;
  onRestoreNote?: (noteId: string) => void;
  onNavigateToNote?: (noteId: string, heading?: string | null) => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  /** Whether the actions panel is hidden - affects title bar max width */
  isActionsPanelHidden?: boolean;
  /** Whether the notes panel is hidden */
  isNotesPanelHidden?: boolean;
  /** Expand the notes panel */
  onExpandNotesPanel?: () => void;
  /** Expand the actions panel */
  onExpandActionsPanel?: () => void;
  /** Check if agent is currently streaming - used to guard hydration */
  isAgentStreaming?: () => boolean;
  /** Called when canvas area is clicked (for dismissing overlays) */
  onCanvasClick?: () => void;
  /** Whether the in-note search bar is visible */
  showSearchBar?: boolean;
  /** Whether the in-note search bar should auto-focus when shown */
  searchBarAutoFocus?: boolean;
  /** Called when the in-note search bar is closed */
  onCloseSearch?: () => void;
  /** Called to open the in-note search bar */
  onOpenSearch?: () => void;
  /** Controls visibility of floating title/navigation bar (zen mode hover reveal) */
  showFloatingTitleBar?: boolean;
  /** True when focus/zen mode is active (used to widen canvas content) */
  isFocusMode?: boolean;
  /** Callback to open the command palette (cmd+K) */
  onActionClick?: () => void;
  /** Allow the primary left pane to show the actions-panel expand control when a browser owns the right split. */
  showActionsPanelToggleOnLeft?: boolean;
};

export type CanvasAreaContentHandle = {
  flushAndWait: () => Promise<void>;
  createPdfExportSession: () => Promise<string | null>;
  selectTab: (label: string) => Promise<boolean>;
  setHeadingCollapsed: (heading: string, collapsed: boolean) => Promise<boolean>;
  focusTitle: () => void;
  focusBody: () => void;
  /** Returns the note id currently mounted in this canvas handle (or null if none). */
  getMountedNoteId: () => string | null;
  /** Skip hydration/remount for a known sticky-tab metadata-only timestamp update. */
  expectStickyTabMetadataUpdate: (updatedAt: number) => void;
  /** Returns the currently selected text in the editor, or empty string if no selection */
  getSelectedText: () => string;
  /** Marks the current selection with a background highlight and returns the selected text.
   * The highlight persists when the editor loses focus. */
  markSelectionAsContext: () => string;
  /** Clears any context selection highlighting from the editor */
  clearContextMark: () => void;
  /** Opens the inline alt-text editor for the currently selected image node. */
  openSelectedImageAltTextEditor: () => boolean;
  /** Marks a comment thread resolved in metadata. Anchors remain until user deletion. */
  resolveCommentThread: (commentId: string, options?: ResolveCommentThreadOptions) => void;
  /** Backward-compatible alias for resolveCommentThread. */
  unwrapComment: (commentId: string) => void;
  /** Captures full raw markdown (frontmatter + body + inline comment anchors) from in-memory state */
  captureMarkdownForSave: () => string;
  scrollToHeading: (heading: string) => boolean;
  forceReloadFromDisk: () => Promise<boolean>;
};

export const CanvasAreaContent = forwardRef<CanvasAreaContentHandle, CanvasAreaContentProps>(function CanvasAreaContent({
  noteIdOverride,
  hideTopBar = false,
  hideRightControls = false,
  hideNavButtons = false,
  paneId,
  onCloseSplit,
  autoFocusTitle = false,
  onTitleFocusComplete,
  autoFocusBody = false,
  onBodyFocusComplete,
  onDeleteNote,
  onRestoreNote,
  onNavigateToNote,
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  isActionsPanelHidden = false,
  isNotesPanelHidden = false,
  onExpandNotesPanel,
  onExpandActionsPanel,
  isAgentStreaming,
  onCanvasClick,
  showSearchBar = false,
  searchBarAutoFocus = true,
  onCloseSearch,
  onOpenSearch,
  // showFloatingTitleBar — reserved for zen mode hover reveal (not yet wired)
  isFocusMode = false,
  onActionClick,
  showActionsPanelToggleOnLeft = false,
}, ref) {
  // Note: right pane (noteIdOverride) subscribes to activeNoteEntityAtom but doesn't use it.
  // This causes a wasted re-render on note switch, but the frequency is low enough to accept.
  // Avoiding the extra subscription would require splitting into two components or a wrapper.
  const activeNote = useAtomValue(activeNoteEntityAtom);
  const overrideNote = useAtomValue(noteEntityAtom(noteIdOverride ?? NO_NOTE_SENTINEL));
  const note = noteIdOverride ? overrideNote : activeNote;
  const store = useStore();
  const mossMultiPane = useMossMultiPane(note); // moss-multi seam: bound-pane (A§2.2)
  const titleInputRef = useRef<HTMLDivElement>(null);
  const editorInstanceRef = useRef<LexicalEditor | null>(null);
  const markdownEditorRef = useRef<MarkdownEditorHandle>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const windowDragPointerIdRef = useRef<number | null>(null);
  // Pending scroll position to restore after editor remount (agent updates)
  const pendingScrollRestoreRef = useRef<number | null>(null);
  // Track rAF ID for scroll restoration cleanup
  const scrollRestoreRafRef = useRef<number | null>(null);
  // Per-note scroll positions (session-only, not persisted to disk)
  const scrollPositionMapRef = useRef<Map<string, number>>(new Map());
  const isAgentStreamingRef = useRef(isAgentStreaming);
  isAgentStreamingRef.current = isAgentStreaming;

  const hasElectronBridge =
    typeof window !== 'undefined' && Boolean(window.electronAPI?.notes?.getById);
  const shouldDeferEditorMount =
    hasElectronBridge &&
    !(typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent));

  const [titleValue, setTitleValueState] = useState('');
  // moss-multi seam: all authored title paths write the shared field.
  const setTitleValue = useCallback((text: string) => {
    setTitleValueState(text);
    mossMultiPane.title.write(text);
  }, [mossMultiPane.title]);
  const titleValueRef = useRef(titleValue);
  titleValueRef.current = titleValue;
  const commitTitleChangeRef = useRef<() => void>(() => {});


  // =========================================================================
  // Content State: Single sync atom, hydrated imperatively in init effect
  // =========================================================================
  // NOTE: Atom hooks must be called unconditionally (React Rules of Hooks).
  // Use NO_NOTE_SENTINEL when note is null. Atoms guard against this sentinel.
  const noteIdForAtoms = note?.id ?? NO_NOTE_SENTINEL;

  // Read/write content via simple sync atom (no loadable, no async)
  const noteContent = useAtomValue(noteContentAtom(noteIdForAtoms));
  const setNoteContent = useSetAtom(noteContentAtom(noteIdForAtoms));
  const content = noteContent.content;

  const agentBusyNoteIds = useAtomValue(uiAgentBusyNoteIdsAtom);
  const isAgentActive = note?.id ? agentBusyNoteIds.has(note.id) : false;

  // Split pane focus (only used when paneId is set)
  const focusedPane = useAtomValue(focusedPaneAtom);
  const setFocusPane = useSetAtom(setFocusPaneAtom);
  const isPaneFocused = paneId ? focusedPane === paneId : true;
  const showFocusedSearchBar = showSearchBar && isPaneFocused;
  const lightboxScope = getCanvasLightboxScope(paneId);

  // Hydration gate: editor only mounts after real content is in the atom.
  // Without this, Lexical's initialConfig would run with content='' (the atom default)
  // and later atom updates wouldn't retroactively update the mounted editor.
  const [contentHydratedForNoteId, setContentHydratedForNoteId] = useState<string | null>(null);
  const contentHydratedForNoteIdRef = useRef(contentHydratedForNoteId);
  contentHydratedForNoteIdRef.current = contentHydratedForNoteId;
  const [editorMountReadyForNoteId, setEditorMountReadyForNoteId] = useState<string | null>(null);
  const [editorReadyForFocusNoteId, setEditorReadyForFocusNoteId] = useState<string | null>(null);
  const [contentLoadError, setContentLoadError] = useState<string | null>(null);
  const [canEditSelectedImageAltText, setCanEditSelectedImageAltText] = useState(false);



  const [saveError, setSaveError] = useState<string | null>(null);
  // Tracks unsaved renderer-side note changes. dirtySourceRef distinguishes
  // local user edits from derived programmatic updates so only real local work
  // blocks live reloads from disk.
  const dirtyRef = useRef(false);
  const dirtyRevisionRef = useRef(0);
  const localUserChangeRevisionRef = useRef(0);
  const dirtySourceRef = useRef<DirtySource | null>(null);
  const markDirty = useCallback((source: DirtySource) => {
    dirtyRevisionRef.current += 1;
    if (source === 'user') {
      localUserChangeRevisionRef.current += 1;
    }
    dirtyRef.current = true;
    if (dirtySourceRef.current !== 'user') {
      dirtySourceRef.current = source;
    }
  }, []);
  const clearDirtyState = useCallback(() => {
    dirtyRef.current = false;
    dirtySourceRef.current = null;
  }, []);
  // pendingFrontmatterMetaUpdates are shared via pendingFrontmatterMetaAtom
  // so both CanvasAreaContent and PropertiesTabContent can write to them.
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const saveContentByNoteIdRef = useRef<Record<string, () => Promise<void>>>({});
  const editorUpdateUnregisterRef = useRef<(() => void) | null>(null);
  const editorCommandsUnregisterRef = useRef<(() => void) | null>(null);
  // rAF ID for scroll-to-cursor coalescing
  const scrollCursorRafRef = useRef<number | null>(null);
  // Debounce timer for content autosave after dirty edits.
  const contentSerializeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsavedEditStartedAtRef = useRef<number | null>(null);
  const editorContentRevisionRef = useRef(0);
  const editorBodyCacheRef = useRef<EditorBodyMarkdownCache | null>(null);

  // Skip-rehydrate guards: track timestamps to avoid re-fetching when our own
  // saves echo back through the note entity subscription
  const lastLocalSaveAtRef = useRef<Record<string, { updatedAt: number }>>({});
  const lastSavedCommentSignatureRef = useRef<Record<string, string>>({});
  const lastSavedCommentDirtySignalRef = useRef<Record<string, number>>({});
  const expectedStickyTabTimestampRef = useRef<number | null>(null);
  const lastKnownDiskContentRef = useRef<Record<string, string | undefined>>({});
  const lastKnownDiskCommentMetadataRef = useRef<Record<string, CommentMetadataMap | undefined>>({});
  const lastKnownDiskCommentSignatureRef = useRef<Record<string, string>>({});
  const lastKnownDiskLayoutMetadataRef = useRef<Record<string, NoteLayoutMetadata | undefined>>({});
  const lastKnownDiskLayoutComparisonRef = useRef<Record<string, string>>({});
  // Editor's post-transform output — used for the dirty comparison in the disk
  // watcher so that round-trip differences (from AutoArrow, FormatWhitespaceBoundary
  // transforms) don't block external updates.
  const lastEditorOutputRef = useRef<Record<string, string | undefined>>({});
  const editorSettlingRafRef = useRef<number | null>(null);
  const diskChangedWhileDirtyRef = useRef<Record<string, boolean>>({});
  // Active user edits are authoritative: disk hydration must not replace them.
  const shouldPreserveDirtyEditor = useCallback(
    (noteId: string): boolean =>
      contentHydratedForNoteIdRef.current === noteId
      && dirtyRef.current
      && dirtySourceRef.current === 'user',
    []
  );
  const pendingDiskRevalidateOnFocusRef = useRef(false);
  const frontmatterSnapshotRef = useRef<Record<string, FrontmatterSnapshot>>({});
  // All disk-backed content reads share one token so a response started before
  // a newer watcher/hydration read cannot overwrite the newer editor state.
  const latestNoteContentFetchTokenRef = useRef<symbol | null>(null);
  useEffect(() => () => {
    latestNoteContentFetchTokenRef.current = null;
  }, []);
  const diskRevalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Echo guard: when force-reload runs after agent completion, this flag
  // prevents the init effect from doing a redundant IPC fetch + editor remount
  // when applyExecuteResult echoes the updatedAt change.
  const lastAgentReloadedAtRef = useRef<Record<string, boolean>>({});
  const [showCopyForAgentDialog, setShowCopyForAgentDialog] = useState(false);
  const [agentMessage, setAgentMessage] = useState('');
  // Visual bell: shows inline "Working in Actions Panel" for ~3s after agent starts
  const [agentVisualBell, setAgentVisualBell] = useState(false);
  const agentVisualBellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Badge state derived from isAgentActive atom (not stream events).
  // Detects active→inactive transition to show green "done" badge for 5s.
  const agentBadgeDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevAgentActiveRef = useRef(isAgentActive);
  const [showDoneBadge, setShowDoneBadge] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [isSavingMarkdown, setIsSavingMarkdown] = useState(false);
  const [showNoteStats, setShowNoteStats] = useState(false);
  const compactDialogPositionStyle = useNotePaneDialogPosition({
    open: isExportingPdf || showNoteStats,
    maxWidthPx: 288,
    boundaryElement: scrollContainerRef.current
  });
  const [actionFeedback, setActionFeedback] = useState<{ type: 'success' | 'error'; message: string; position?: 'top' | 'bottom'; action?: { label: string; onClick: () => void } } | null>(null);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const actionFeedbackTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleFocusCompletedRef = useRef(false);
  const bodyFocusCompletedRef = useRef(false);
  const isTitleFocusedRef = useRef(false);
  const latestOnTitleFocusCompleteRef = useRef(onTitleFocusComplete);
  const latestOnBodyFocusCompleteRef = useRef(onBodyFocusComplete);
  const [retryToast, setRetryToast] = useState<RetryToastState | null>(null);
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [editorVersion, setEditorVersion] = useState(0);
  const editorRemountReasonRef = useRef<Record<string, { version: number; reason: EditorRemountReason }>>({});
  const remountEditorPreservingScroll = useCallback((reason: EditorRemountReason) => {
    const currentNoteId = note?.id;
    pendingScrollRestoreRef.current = scrollContainerRef.current?.scrollTop ?? null;
    setEditorVersion((previousVersion) => {
      const nextVersion = previousVersion + 1;
      if (currentNoteId) {
        editorRemountReasonRef.current[currentNoteId] = { version: nextVersion, reason };
      }
      return nextVersion;
    });
  }, [note?.id]);
  // Consume-once: after the MarkdownEditor mount effect has observed the
  // reason for this (noteId, editorVersion) pair, clear the ref so a later
  // navigation-driven remount doesn't re-fire the same reason.
  useEffect(() => {
    const currentNoteId = note?.id;
    if (!currentNoteId) return;
    const entry = editorRemountReasonRef.current[currentNoteId];
    if (entry && entry.version === editorVersion) {
      delete editorRemountReasonRef.current[currentNoteId];
    }
  }, [editorVersion, note?.id]);
  // Skeleton loading: starts at 1, grows by 2 lines every second + on tool_start.
  const [skeletonLines, setSkeletonLines] = useState(0);
  const skeletonIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearAgentCanvasLoading = useCallback(() => {
    if (skeletonIntervalRef.current) {
      clearInterval(skeletonIntervalRef.current);
      skeletonIntervalRef.current = null;
    }
    setSkeletonLines(0);
  }, []);
  const clearAgentVisualBell = useCallback(() => {
    setAgentVisualBell(false);
    if (agentVisualBellTimerRef.current) {
      clearTimeout(agentVisualBellTimerRef.current);
      agentVisualBellTimerRef.current = null;
    }
  }, []);
  const isTrashed = note?.trashedAt != null;
  // External notes are identified by having an externalFilePath.
  // Keep the folder-path fallback for legacy metadata.
  const isExternal = Boolean(note?.externalFilePath) || note?.folderPath === 'Notes/External';

  // Agent badge: reset on note switch
  useEffect(() => {
    setShowDoneBadge(false);
    prevAgentActiveRef.current = isAgentActive;
    if (agentBadgeDoneTimerRef.current) { clearTimeout(agentBadgeDoneTimerRef.current); agentBadgeDoneTimerRef.current = null; }
  }, [note?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAgentActive) {
      clearAgentCanvasLoading();
    }
  }, [clearAgentCanvasLoading, isAgentActive, note?.id]);

  // Agent badge: detect completion (active → inactive) on same note
  useEffect(() => {
    if (prevAgentActiveRef.current && !isAgentActive) {
      setShowDoneBadge(true);
      if (agentBadgeDoneTimerRef.current) clearTimeout(agentBadgeDoneTimerRef.current);
      agentBadgeDoneTimerRef.current = setTimeout(() => setShowDoneBadge(false), 5000);
    }
    prevAgentActiveRef.current = isAgentActive;
  }, [isAgentActive]);

  const agentBadgeState = isAgentActive ? 'streaming' : showDoneBadge ? 'done' : 'idle';
  const canShowActionsPanelToggle =
    isActionsPanelHidden &&
    (paneId !== 'left' || showActionsPanelToggleOnLeft) &&
    onExpandActionsPanel;

  // Playful rotating placeholders for new notes
  const [placeholderIdx, setPlaceholderIdx] = useAtom(placeholderIndexAtom);
  const currentPlaceholder = PLACEHOLDER_PAIRS[placeholderIdx % PLACEHOLDER_PAIRS.length];

  useEffect(() => {
    latestOnTitleFocusCompleteRef.current = onTitleFocusComplete;
  }, [onTitleFocusComplete]);

  useEffect(() => {
    latestOnBodyFocusCompleteRef.current = onBodyFocusComplete;
  }, [onBodyFocusComplete]);

  mossMultiPane.title.connect(titleInputRef, setTitleValueState); // moss-multi seam: render shared title

  const getLiveTitleText = useCallback((): string => {
    return titleInputRef.current?.textContent ?? titleValueRef.current;
  }, []);

  const setTitleDisplayValue = useCallback((rawTitle: string | null | undefined) => {
    const display = normalizeTitleDisplayValue(rawTitle);
    const el = titleInputRef.current;

    if (el && el.textContent !== display) {
      el.textContent = display;
    }

    if (titleValueRef.current !== display) {
      setTitleValueState(display); // moss-multi seam: title-display (T2.3): an unbound pane shows the title, never writes it
    }
  }, []);

  const syncTitleValueFromDom = useCallback(() => {
    const nextTitle = getLiveTitleText();
    if (titleValueRef.current !== nextTitle) {
      setTitleValue(nextTitle);
    }
  }, [getLiveTitleText]);

  const {
    closeTitleEmojiMenu,
    handleTitleEmojiKeyDown,
    syncTitleEmojiTypeaheadFromSelection,
    titleEmojiMenu
  } = useTitleEmojiTypeahead({
    disabled: isTrashed,
    noteId: note?.id,
    onTitleValueChange: setTitleValue,
    titleInputRef
  });

  const clearPendingAutosaveTimer = useCallback(() => {
    if (contentSerializeDebounceRef.current) {
      clearTimeout(contentSerializeDebounceRef.current);
      contentSerializeDebounceRef.current = null;
    }
  }, []);

  const resetPendingAutosaveWindow = useCallback(() => {
    unsavedEditStartedAtRef.current = null;
    clearPendingAutosaveTimer();
  }, [clearPendingAutosaveTimer]);

  const bumpEditorContentRevision = useCallback(() => {
    editorContentRevisionRef.current += 1;
    editorBodyCacheRef.current = null;
  }, []);

  const cacheFrontmatterSnapshot = useCallback((
    noteId: string,
    rawMarkdown: string,
    splitResult: FrontmatterSplitResult
  ) => {
    frontmatterSnapshotRef.current[noteId] = {
      signature: buildFrontmatterSignature(splitResult.data),
      rawBlock: extractFrontmatterRawBlock(rawMarkdown, splitResult),
      preserveWhenDataNull: splitResult.hasFrontmatter && splitResult.data === null
    };
  }, []);

  const runAutosaveNow = useCallback(() => {
    void saveContentRef.current?.().catch(() => {});
  }, []);

  const scheduleDebouncedAutosave = useCallback(() => {
    if (!note?.id) {
      return;
    }

    const now = Date.now();
    if (unsavedEditStartedAtRef.current === null) {
      unsavedEditStartedAtRef.current = now;
    }

    clearPendingAutosaveTimer();

    // Keep unsaved window bounded even during long uninterrupted typing.
    if (now - unsavedEditStartedAtRef.current >= EDIT_MAX_UNSAVED_WINDOW_MS) {
      unsavedEditStartedAtRef.current = now;
      runAutosaveNow();
      return;
    }

    contentSerializeDebounceRef.current = setTimeout(() => {
      contentSerializeDebounceRef.current = null;
      runAutosaveNow();
    }, EDIT_IDLE_AUTOSAVE_DELAY_MS);
  }, [clearPendingAutosaveTimer, note?.id, runAutosaveNow]);

  // Cleanup on unmount: timers, listeners, rAFs
  useEffect(() => {
    return () => {
      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current);
      }
      clearPendingAutosaveTimer();
      if (editorUpdateUnregisterRef.current) {
        editorUpdateUnregisterRef.current();
        editorUpdateUnregisterRef.current = null;
      }
      if (editorCommandsUnregisterRef.current) {
        editorCommandsUnregisterRef.current();
        editorCommandsUnregisterRef.current = null;
      }
      if (scrollRestoreRafRef.current !== null) {
        cancelAnimationFrame(scrollRestoreRafRef.current);
      }
      if (editorSettlingRafRef.current !== null) {
        cancelAnimationFrame(editorSettlingRafRef.current);
        editorSettlingRafRef.current = null;
      }
      clearAgentCanvasLoading();
      clearAgentVisualBell();
      if (agentBadgeDoneTimerRef.current) clearTimeout(agentBadgeDoneTimerRef.current);
    };
  }, [clearAgentCanvasLoading, clearAgentVisualBell, clearPendingAutosaveTimer]);

  // Track which note ID the scroll listener should save for. Synchronized via
  // useLayoutEffect so the ref is nulled synchronously during note transitions
  // (prevents stale saves from browser scroll-clamp events during skeleton swap).
  const scrollTrackNoteIdRef = useRef<string | null>(note?.id ?? null);
  useLayoutEffect(() => {
    scrollTrackNoteIdRef.current = note?.id ?? null;
    return () => {
      scrollTrackNoteIdRef.current = null;
    };
  }, [note?.id]);

  // Passive scroll listener continuously tracks position per note (cheap ref write).
  // Mounted once — the scroll container (CanvasArea) is stable across note switches.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const id = scrollTrackNoteIdRef.current;
      if (id) scrollPositionMapRef.current.set(id, el.scrollTop);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Reset title focus tracking and scroll position when note changes
  useEffect(() => {
    titleFocusCompletedRef.current = false;
    bodyFocusCompletedRef.current = false;
    isTitleFocusedRef.current = false;
    setEditorReadyForFocusNoteId(null);
    pendingScrollRestoreRef.current = null;
  }, [note?.id]);

  useLayoutEffect(() => {
    if (mossMultiPane.bound || !note?.id || contentHydratedForNoteId !== noteIdForAtoms) {
      return;
    }

    setTitleDisplayValue(note.title);
  }, [contentHydratedForNoteId, note?.id, noteIdForAtoms, setTitleDisplayValue]);

  const focusEditorStart = useCallback((): boolean => {
    return markdownEditorRef.current?.focusStart() ?? false;
  }, []);

  useEffect(() => {
    if (!note?.id || contentHydratedForNoteId !== noteIdForAtoms) {
      setEditorMountReadyForNoteId(null);
      return;
    }

    setEditorMountReadyForNoteId(null);
    if (!shouldDeferEditorMount) {
      setEditorMountReadyForNoteId(note.id);
      return;
    }

    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0);
    const cancel = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : (handle: number) => window.clearTimeout(handle);
    const frameId = schedule(() => {
      setEditorMountReadyForNoteId(note.id);
    });

    return () => {
      cancel(frameId);
    };
  }, [contentHydratedForNoteId, note?.id, noteIdForAtoms, shouldDeferEditorMount]);

  useLayoutEffect(() => {
    const el = titleInputRef.current;
    if (!el || !autoFocusTitle || (!mossMultiPane.bound && titleFocusCompletedRef.current) || contentHydratedForNoteId !== noteIdForAtoms) {
      return;
    }
    if (!mossMultiPane.titleLive) return; // moss-multi seam: bound-pane (A§2.2): the title takes focus once bound (R2)

    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    isTitleFocusedRef.current = true;
    titleFocusCompletedRef.current = true;
    latestOnTitleFocusCompleteRef.current?.();
    setPlaceholderIdx((i) => (i + 1) % PLACEHOLDER_PAIRS.length);
  }, [autoFocusTitle, contentHydratedForNoteId, mossMultiPane.titleLive, note?.id, noteIdForAtoms, setPlaceholderIdx]);

  useLayoutEffect(() => {
    if (
      !autoFocusBody ||
      bodyFocusCompletedRef.current ||
      contentHydratedForNoteId !== noteIdForAtoms ||
      editorReadyForFocusNoteId !== noteIdForAtoms ||
      !mossMultiPane.bodyLive // moss-multi seam: bound-pane (A§2.2): the body takes focus once bound (R2)
    ) {
      return;
    }

    if (focusEditorStart()) {
      bodyFocusCompletedRef.current = true;
      latestOnBodyFocusCompleteRef.current?.();
      setPlaceholderIdx((i) => (i + 1) % PLACEHOLDER_PAIRS.length);
    }
  }, [
    autoFocusBody,
    contentHydratedForNoteId,
    editorReadyForFocusNoteId,
    focusEditorStart,
    mossMultiPane.bodyLive,
    noteIdForAtoms,
    setPlaceholderIdx
  ]);

  // Restore per-note scroll position after content hydrates.
  // useLayoutEffect runs after DOM commit but before paint — Lexical populates
  // DOM synchronously via editorState callback, so content is ready here.
  useLayoutEffect(() => {
    if (!contentHydratedForNoteId) return;
    // Agent scroll restore takes priority
    if (pendingScrollRestoreRef.current !== null) return;
    const saved = scrollPositionMapRef.current.get(contentHydratedForNoteId);
    if (saved == null) return;
    const el = scrollContainerRef.current;
    if (el) el.scrollTop = saved;
  }, [contentHydratedForNoteId]);

  // Helper to show action feedback with auto-clear timeout
  const showActionFeedback = useCallback((feedback: { type: 'success' | 'error'; message: string; position?: 'top' | 'bottom'; action?: { label: string; onClick: () => void } }) => {
    // Clear any existing timeout
    if (actionFeedbackTimeoutRef.current) {
      clearTimeout(actionFeedbackTimeoutRef.current);
    }
    setActionFeedback(feedback);
    const duration = feedback.type === 'success' ? ACTION_FEEDBACK_DISMISS_MS : ACTION_ERROR_DISMISS_MS;
    actionFeedbackTimeoutRef.current = setTimeout(() => {
      setActionFeedback(null);
      actionFeedbackTimeoutRef.current = null;
    }, duration);
  }, []);

  // Show a copy toast when a note/anchor link is copied from inside the editor
  // (e.g. the collapsible-heading context menu). The event bubbles from the
  // editor root up to this pane's scroll container, so the toast stays scoped
  // to the originating pane in split view.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleNoteLinkCopied = (event: Event) => {
      const detail = (event as CustomEvent<NoteLinkCopiedEventDetail>).detail;
      if (!detail?.message) return;
      showActionFeedback({ type: 'success', message: detail.message });
    };

    container.addEventListener(NOTE_LINK_COPIED_EVENT, handleNoteLinkCopied);
    return () => {
      container.removeEventListener(NOTE_LINK_COPIED_EVENT, handleNoteLinkCopied);
    };
    // Re-run when a note (and thus the scroll container) mounts so the listener
    // attaches once the container ref is populated.
  }, [showActionFeedback, note?.id]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.setAttribute(CANVAS_LIGHTBOX_SCOPE_ATTR, lightboxScope);
    return () => {
      if (container.getAttribute(CANVAS_LIGHTBOX_SCOPE_ATTR) === lightboxScope) {
        container.removeAttribute(CANVAS_LIGHTBOX_SCOPE_ATTR);
      }
    };
  }, [lightboxScope]);

  const syncH1ToTitle = useCallback((
    noteId: string,
    h1Title: string | null,
    opts?: { skipIfTitleFocused?: boolean }
  ): void => {
    if (!h1Title || mossMultiPane.bound) return; // moss-multi seam: bound-pane (A§2.2): the title is its doc's field (A§10.4)
    if (opts?.skipIfTitleFocused && document.activeElement === titleInputRef.current) return;
    const currentTitle = store.get(noteEntityAtom(noteId))?.title;
    if (h1Title === currentTitle) return;
    store.set(syncNoteEntityAtom, { noteId, updates: { title: h1Title } });
    if (hasElectronBridge) {
      // Don't send updatedAt — title derivation on load shouldn't change the note's timestamp
      void notesApi.update.invoke(noteId, { title: h1Title })
        .then((updated) => {
          if (!updated?.contentPath) {
            return;
          }

          store.set(syncNoteEntityAtom, {
            noteId,
            updates: { contentPath: updated.contentPath }
          });
        })
        .catch(() => {});
    }
  }, [hasElectronBridge, store]);

  const hydrateFetchedNoteRecord = useCallback((
    noteId: string,
    result: NoteWithContent,
    options?: {
      noteIdChanged?: boolean;
      previousDiskContent?: string;
      forceEditorRemount?: boolean;
    }
  ): boolean => {
    if (shouldPreserveDirtyEditor(noteId)) {
      diskChangedWhileDirtyRef.current[noteId] = true;
      return false;
    }

    const rawContent = result.content ?? '';
    const previousDiskContent = options?.previousDiskContent;
    const { strippedContent } = rawContent.includes('<!--moss:comments')
      ? parseCommentFooter(rawContent)
      : { strippedContent: rawContent };
    lastKnownDiskContentRef.current[noteId] = strippedContent;
    diskChangedWhileDirtyRef.current[noteId] = false;

    const markdownSafetyLoadError = buildMarkdownSafetyLoadError(rawContent);
    if (markdownSafetyLoadError) {
      store.set(noteContentAtom(noteId), { content: '' });
      store.set(noteFrontmatterAtom(noteId), null);
      setContentHydratedForNoteId(noteId);
      setContentLoadError(markdownSafetyLoadError);
      return true;
    }

    // moss-multi seam: body-h1 (T2.3): the title is its own field, so a leading H1 is body, never the title
    const disassembled = disassembleNote(rawContent);
    const layers = { ...disassembled, h1Title: null, body: parseCommentFooter(disassembled.bodyAfterFrontmatter).strippedContent };
    const diskCommentMetadata = result.commentMetadata ?? layers.comments;
    lastKnownDiskCommentMetadataRef.current[noteId] = diskCommentMetadata;
    lastKnownDiskCommentSignatureRef.current[noteId] = buildCommentMetadataSignature(diskCommentMetadata);
    lastKnownDiskLayoutMetadataRef.current[noteId] = result.layoutMetadata;
    lastKnownDiskLayoutComparisonRef.current[noteId] =
      serializeNoteLayoutMetadataForComparison(result.layoutMetadata);
    cacheFrontmatterSnapshot(noteId, rawContent, {
      data: layers.frontmatter,
      body: layers.bodyAfterFrontmatter,
      rawYaml: layers.rawYaml,
      hasFrontmatter: layers.rawYaml !== undefined,
    });
    store.set(noteFrontmatterAtom(noteId), layers.frontmatter);

    syncH1ToTitle(noteId, layers.h1Title);

    store.set(noteContentAtom(noteId), {
      content: layers.body
    });
    setContentHydratedForNoteId(noteId);

    const bodyChangedSincePreviousDiskContent =
      rawContent !== previousDiskContent &&
      (previousDiskContent == null || layers.bodyAfterFrontmatter !== splitFrontmatter(previousDiskContent).body);
    if (options?.noteIdChanged === false && (options.forceEditorRemount || bodyChangedSincePreviousDiskContent)) {
      remountEditorPreservingScroll('disk_content_changed');
    }

    store.set(syncNoteEntityAtom, {
      noteId,
      updates: {
        updatedAt: result.updatedAt,
        trashedAt: result.trashedAt ?? null,
        ...(typeof result.contentPath === 'string' ? { contentPath: result.contentPath } : {})
      }
    });

    const diskRecords = result.stickyTabs ?? [];
    const noteTabsAtom = noteActionTabsAtom(noteId);
    const currentTabs = store.get(noteTabsAtom);

    if (!isAgentStreamingRef.current?.()) {
      const diskTabs = diskRecords.map(mapActionTabRecordToEntry);
      const augmented = diskTabs.map((diskTab) => {
        const memTab = currentTabs.find((t) => t.id === diskTab.id);
        if (memTab && memTab.messages.length > diskTab.messages.length) {
          return { ...diskTab, messages: memTab.messages };
        }
        return diskTab;
      });
      const memOnly = currentTabs.filter(
        (t) => !diskTabs.some((d) => d.id === t.id)
      );
      store.set(noteTabsAtom, [...augmented, ...memOnly]);
    }

    const hydratedComments = hydrateComments(diskCommentMetadata, result.commentColors);
    store.set(noteCommentsMapAtom(noteId), hydratedComments);
    lastSavedCommentSignatureRef.current[noteId] =
      Object.keys(hydratedComments).length > 0 ? buildCommentSignature(hydratedComments) : '';
    lastSavedCommentDirtySignalRef.current[noteId] = store.get(commentDirtySignalAtom(noteId));

    store.set(
      noteCollapsedHeadingsAtom(noteId),
      result.collapsedHeadings ?? []
    );
    return true;
  }, [cacheFrontmatterSnapshot, remountEditorPreservingScroll, shouldPreserveDirtyEditor, store]);

  const trashCountdownDays = useMemo(() => {
    if (typeof note?.trashedAt !== 'number' || !Number.isFinite(note.trashedAt)) {
      return TRASH_RETENTION_DAYS;
    }

    // trashedAt is Unix seconds, convert to milliseconds
    const trashedTimestampMs = note.trashedAt * 1000;

    const expiresAt = trashedTimestampMs + TRASH_RETENTION_DAYS * MS_IN_DAY;
    const diffDays = Math.floor((expiresAt - currentTime) / MS_IN_DAY);
    return diffDays > 0 ? diffDays : 0;
  }, [currentTime, note?.trashedAt]);

  useEffect(() => {
    if (!retryToast) {
      return;
    }

    if (!note?.id || retryToast.noteId !== note.id) {
      setRetryToast(null);
      return;
    }

    const timer = setTimeout(() => setRetryToast(null), 4000);
    return () => clearTimeout(timer);
  }, [note?.id, retryToast]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
      return;
    }

    const intervalId = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, TRASH_COUNTDOWN_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const previousNoteIdRef = useRef<string | null>(null);

  // =========================================================================
  // Note Initialization Effect
  // =========================================================================
  // Fetches note data from IPC and hydrates all atoms (content, tabs, comments).
  //
  // Runs on note?.id AND note?.updatedAt changes. Every note switch triggers
  // a fresh IPC fetch from disk to guarantee the editor sees the latest content
  // (including agent writes that happened while viewing another note).
  //
  // Own-write echo guards skip re-fetches when updatedAt changed because of a
  // save, agent update, or sticky-tab persist that WE initiated.
  useEffect(() => {
    if (!note) {
      latestNoteContentFetchTokenRef.current = null;
      setSaveError(null);
      setContentLoadError(null);
      clearDirtyState();
      resetPendingAutosaveWindow();
      editorContentRevisionRef.current = 0;
      editorBodyCacheRef.current = null;
      previousNoteIdRef.current = null;
      lastKnownDiskContentRef.current = {};
      lastKnownDiskCommentMetadataRef.current = {};
      lastKnownDiskCommentSignatureRef.current = {};
      lastKnownDiskLayoutMetadataRef.current = {};
      lastKnownDiskLayoutComparisonRef.current = {};
      diskChangedWhileDirtyRef.current = {};
      frontmatterSnapshotRef.current = {};
      return;
    }

    const prevNoteId = previousNoteIdRef.current;
    const noteIdChanged = prevNoteId !== note.id;
    previousNoteIdRef.current = note.id;

    // moss-multi seam: bound-pane (A§2.2): a bound note's content is its doc. No REST read and no remount on updatedAt; the editor
    // mounts at once and its binding opens it at first sync (A§10.3).
    if (mossMultiPane.bound) {
      if (noteIdChanged) {
        // moss-multi seam: local heading identities must precede the first-sync restore.
        try { store.set(noteCollapsedHeadingsAtom(note.id), JSON.parse(localStorage.getItem(`moss-multi:collapsed-headings:${note.id}`) ?? '[]')); } catch { /* unavailable storage */ }
        setContentHydratedForNoteId(note.id);
      }
      return;
    }

    // Force a fresh hydration gate on note switches so the editor never mounts
    // with stale atom content from a previous visit while the new disk fetch is in flight.
    if (noteIdChanged) {
      setContentHydratedForNoteId(null);
    }

    // ── Own-write echo guards (same note, updatedAt changed) ────────────
    if (!noteIdChanged) {
      const lastLocalSave = lastLocalSaveAtRef.current[note.id];
      if (lastLocalSave && note.updatedAt === lastLocalSave.updatedAt) {
        return;
      }

      if (expectedStickyTabTimestampRef.current === note.updatedAt) {
        expectedStickyTabTimestampRef.current = null;
        return;
      }

      // Agent completion already force-reloaded — skip the redundant fetch.
      if (lastAgentReloadedAtRef.current[note.id]) {
        delete lastAgentReloadedAtRef.current[note.id];
        return;
      }

      const currentCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));
      const lastSavedCommentDirtySignal = lastSavedCommentDirtySignalRef.current[note.id];
      const hasPendingCommentSignal =
        lastSavedCommentDirtySignal === undefined
          ? currentCommentDirtySignal > 0
          : lastSavedCommentDirtySignal !== currentCommentDirtySignal;

      // User edits win over external file reloads — derived updates should not.
      if ((dirtyRef.current && dirtySourceRef.current === 'user') || hasPendingCommentSignal) {
        return;
      }

    }

    // ── Full IPC fetch (first visit or external content change) ─────────

    if (!hasElectronBridge) {
      // Story/mock case: hydrate content atom directly
      setNoteContent({ content: '' });
      store.set(noteActionTabsAtom(note.id), []);
      store.set(noteFrontmatterAtom(note.id), null);
      diskChangedWhileDirtyRef.current[note.id] = false;
      lastKnownDiskCommentMetadataRef.current[note.id] = {};
      lastKnownDiskCommentSignatureRef.current[note.id] = '';
      lastKnownDiskLayoutMetadataRef.current[note.id] = undefined;
      lastKnownDiskLayoutComparisonRef.current[note.id] = '';
      frontmatterSnapshotRef.current[note.id] = {
        signature: null,
        rawBlock: null,
        preserveWhenDataNull: false
      };

      lastSavedCommentSignatureRef.current[note.id] = buildCommentSignature(
        store.get(noteCommentsMapAtom(note.id))
      );
      lastSavedCommentDirtySignalRef.current[note.id] = store.get(commentDirtySignalAtom(note.id));
      clearDirtyState();
      resetPendingAutosaveWindow();
      editorContentRevisionRef.current = 0;
      editorBodyCacheRef.current = null;
      store.set(pendingFrontmatterMetaAtom(note.id), {});
      setContentHydratedForNoteId(note.id);
      return;
    }

    // Clear agent echo flag for the PREVIOUS note on switch so it doesn't
    // leak across notes. note.id is already the new note here.
    if (noteIdChanged && prevNoteId) {
      delete lastAgentReloadedAtRef.current[prevNoteId];
    }

    clearDirtyState();
    resetPendingAutosaveWindow();
    editorContentRevisionRef.current = 0;
    editorBodyCacheRef.current = null;
    store.set(pendingFrontmatterMetaAtom(note.id), {});
    setSaveError(null);
    setContentLoadError(null);

    const preloadedRecord = takePreloadedNoteRecord(note.id);
    if (preloadedRecord) {
      hydrateFetchedNoteRecord(note.id, preloadedRecord, {
        noteIdChanged,
        previousDiskContent: lastKnownDiskContentRef.current[note.id]
      });
      const verificationUserRevision = localUserChangeRevisionRef.current;
      const verificationCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));

      // Prefetch cache is an optimization only — always verify from disk once so
      // missed disk-change events can't leave a stale note after switching.
      let cancelled = false;
      const verificationFetchToken = Symbol('preloaded-note-verification-fetch');
      latestNoteContentFetchTokenRef.current = verificationFetchToken;
      notesApi.getById.reset();
      notesApi.getById
        .invoke(note.id, { skipAnalytics: true })
        .then((freshRecord) => {
          if (
            cancelled
            || latestNoteContentFetchTokenRef.current !== verificationFetchToken
            || !freshRecord
          ) {
            return;
          }
          if (
            localUserChangeRevisionRef.current !== verificationUserRevision
            || store.get(commentDirtySignalAtom(note.id)) !== verificationCommentDirtySignal
          ) {
            diskChangedWhileDirtyRef.current[note.id] = true;
            return;
          }

          const freshContent = freshRecord.content ?? '';
          const preloadedContent = preloadedRecord.content ?? '';
          const freshTrashedAt = freshRecord.trashedAt ?? null;
          const preloadedTrashedAt = preloadedRecord.trashedAt ?? null;
          const freshCommentSignature = buildCommentMetadataSignature(freshRecord.commentMetadata ?? {});
          const preloadedCommentSignature = buildCommentMetadataSignature(preloadedRecord.commentMetadata ?? {});
          const freshLayoutComparison = serializeNoteLayoutMetadataForComparison(freshRecord.layoutMetadata);
          const preloadedLayoutComparison = serializeNoteLayoutMetadataForComparison(preloadedRecord.layoutMetadata);
          const layoutChanged = freshLayoutComparison !== preloadedLayoutComparison;

          if (
            freshRecord.updatedAt === preloadedRecord.updatedAt
            && freshContent === preloadedContent
            && freshTrashedAt === preloadedTrashedAt
            && freshCommentSignature === preloadedCommentSignature
            && !layoutChanged
          ) {
            return;
          }

          // Layout-only divergence: when only the persisted column/tab widths
          // differ and the table/tab-group structure matches, prefer applying
          // the fresh layout in place over a full editor remount. Remount only
          // when a count diverges (structural mismatch — apply would no-op).
          const onlyLayoutDiverged =
            layoutChanged
            && freshRecord.updatedAt === preloadedRecord.updatedAt
            && freshContent === preloadedContent
            && freshTrashedAt === preloadedTrashedAt
            && freshCommentSignature === preloadedCommentSignature;
          const sameLayoutCounts =
            (freshRecord.layoutMetadata?.tableCount ?? 0)
              === (preloadedRecord.layoutMetadata?.tableCount ?? 0)
            && (freshRecord.layoutMetadata?.tabGroupCount ?? 0)
              === (preloadedRecord.layoutMetadata?.tabGroupCount ?? 0);
          let appliedLayoutInPlace = false;
          if (onlyLayoutDiverged && sameLayoutCounts && editorInstanceRef.current) {
            const editor = editorInstanceRef.current;
            editor.update(() => {
              const appliedTables = $applyTableLayoutMetadata(
                freshRecord.layoutMetadata ?? null
              );
              const appliedTabGroups = $applyTabGroupLayoutMetadata(
                freshRecord.layoutMetadata ?? null
              );
              appliedLayoutInPlace = appliedTables && appliedTabGroups;
            }, { discrete: true });
          }

          hydrateFetchedNoteRecord(note.id, freshRecord, {
            noteIdChanged: false,
            previousDiskContent: lastKnownDiskContentRef.current[note.id],
            forceEditorRemount: layoutChanged && !appliedLayoutInPlace
          });
        })
        .catch(() => {
          // Best-effort verification only. Keep preloaded hydration if disk read fails.
        });

      return () => {
        cancelled = true;
      };
    }

    // Single IPC call: fetches metadata, content, tabs, and comments
    let cancelled = false;
    const hydrationUserRevision = localUserChangeRevisionRef.current;
    const hydrationCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));
    const hydrationFetchToken = Symbol('note-hydration-fetch');
    latestNoteContentFetchTokenRef.current = hydrationFetchToken;
    notesApi.getById.reset();
    notesApi.getById
      .invoke(note.id)
      .then((result) => {
        if (cancelled || latestNoteContentFetchTokenRef.current !== hydrationFetchToken) return;
        if (
          !noteIdChanged
          && (
            localUserChangeRevisionRef.current !== hydrationUserRevision
            || store.get(commentDirtySignalAtom(note.id)) !== hydrationCommentDirtySignal
          )
        ) {
          diskChangedWhileDirtyRef.current[note.id] = true;
          return;
        }

        if (result) {
          hydrateFetchedNoteRecord(note.id, result, {
            noteIdChanged,
            previousDiskContent: lastKnownDiskContentRef.current[note.id]
          });
        } else {
          // Surface missing content as an explicit load error instead of a silent blank canvas.
          store.set(noteContentAtom(note.id), {
            content: ''
          });
          store.set(noteFrontmatterAtom(note.id), null);
          diskChangedWhileDirtyRef.current[note.id] = false;
          lastKnownDiskCommentMetadataRef.current[note.id] = {};
          lastKnownDiskCommentSignatureRef.current[note.id] = '';
          lastKnownDiskLayoutMetadataRef.current[note.id] = undefined;
          lastKnownDiskLayoutComparisonRef.current[note.id] = '';
          frontmatterSnapshotRef.current[note.id] = {
            signature: null,
            rawBlock: null,
            preserveWhenDataNull: false
          };

          setContentHydratedForNoteId(note.id);
          setContentLoadError('File was moved or deleted.');
          console.warn('[note-integrity] Active note metadata exists but note content is missing on disk', {
            noteId: note.id
          });
          void store.set(hydrateNotesAtom).catch((error) => {
            console.warn('[note-integrity] Failed to reconcile notes after missing content load', {
              noteId: note.id,
              error
            });
          });
        }
      })
      .catch((error) => {
        if (cancelled || latestNoteContentFetchTokenRef.current !== hydrationFetchToken) return;
        setContentHydratedForNoteId(note.id);
        setContentLoadError(error instanceof Error ? error.message : 'Failed to load note');
      });

    return () => {
      cancelled = true;
    };
    // note?.updatedAt is included so external content changes (e.g. agent
    // writing to a non-active note) trigger a re-fetch when we switch back.
    // Own-write echoes are filtered by the guard refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearDirtyState,
    hasElectronBridge,
    hydrateFetchedNoteRecord,
    note?.id,
    note?.updatedAt,
    resetPendingAutosaveWindow,
    store
  ]);

  const getEditorBodyMarkdown = useCallback((forceFresh = false): EditorBodyMarkdownCache | null => {
    if (!editorInstanceRef.current || !note?.id) {
      return null;
    }

    const currentRevision = editorContentRevisionRef.current;
    const cached = editorBodyCacheRef.current;
    if (
      !forceFresh &&
      cached?.noteId === note.id &&
      cached.contentRevision === currentRevision
    ) {
      return cached;
    }

    let markdownBody = content;
    let layoutMetadata: NoteLayoutMetadata = {
      version: 1,
      tableCount: 0,
      tables: []
    };
    editorInstanceRef.current.getEditorState().read(() => {
      markdownBody = unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS));
      layoutMetadata = {
        ...$collectTableLayoutMetadata(),
        ...$collectTabGroupLayoutMetadata()
      };
    });

    // Defensive strip: stale footer should never be in serialized body.
    if (hasLegacyCommentFooter(markdownBody)) {
      markdownBody = parseCommentFooter(markdownBody).strippedContent;
    }
    markdownBody = stripTableColumnWidthComments(markdownBody);

    const nextCache: EditorBodyMarkdownCache = {
      noteId: note.id,
      contentRevision: currentRevision,
      markdownBody,
      layoutMetadata,
      survivingCommentIds: undefined
    };
    editorBodyCacheRef.current = nextCache;
    return nextCache;
  }, [content, note?.id]);

  const getSurvivingCommentIds = useCallback((cache: EditorBodyMarkdownCache): Set<string> => {
    if (cache.survivingCommentIds !== undefined) {
      return cache.survivingCommentIds;
    }

    const survivingIds = extractCommentAnchorIds(cache.markdownBody);
    if (survivingIds.size === 0) {
      cache.survivingCommentIds = new Set();
      return cache.survivingCommentIds;
    }
    cache.survivingCommentIds = survivingIds;
    return survivingIds;
  }, []);

  const pruneCommentsWithoutAnchors = useCallback(
    (cache?: EditorBodyMarkdownCache | null): Record<string, NoteComment> => {
      if (!note?.id) {
        return {};
      }

      const commentsMap = store.get(noteCommentsMapAtom(note.id));
      const commentIds = Object.keys(commentsMap);
      if (commentIds.length === 0) {
        return commentsMap;
      }

      const bodyCache = cache ?? getEditorBodyMarkdown();
      if (!bodyCache) {
        return commentsMap; // Editor unavailable — don't destroy data
      }
      const anchorIds = getSurvivingCommentIds(bodyCache);

      if (anchorIds.size === 0) {
        return {};
      }

      // Replies are sidecar-only (no body anchor). A reply survives when its
      // parentId chain leads back to a root whose marker is present in the body;
      // an orphaned reply (root anchor removed) is pruned with its subtree.
      const survivingIds = collectReachableCommentThreadIds(anchorIds, commentsMap);

      const filteredMap: typeof commentsMap = {};
      for (const id of commentIds) {
        if (survivingIds.has(id)) {
          filteredMap[id] = commentsMap[id];
        }
      }

      // Return filtered map for disk serialization only — don't mutate the atom.
      // Keeping stale entries in the atom is harmless (no MarkNode = no render)
      // and allows undo to restore comments whose MarkNodes reappear.
      return filteredMap;
    },
    [getEditorBodyMarkdown, getSurvivingCommentIds, note?.id, store]
  );

  // Capture clean markdown from the editor (no frontmatter/footer).
  const captureMarkdownFromEditor = useCallback((): string => {
    const cached = getEditorBodyMarkdown();
    if (!cached) {
      return content;
    }
    return cached.markdownBody;
  }, [content, getEditorBodyMarkdown]);

  const captureTabGroupActiveIndicesForPdf = useCallback((): number[] => {
    if (typeof window === 'undefined') {
      return [];
    }

    const editableRoot = scrollContainerRef.current?.querySelector('[data-moss-note-editor-root="true"]');
    if (!(editableRoot instanceof HTMLElement)) {
      return [];
    }

    return Array.from(editableRoot.querySelectorAll<HTMLElement>('.moss-tab-group')).map((group) => {
      const panels = Array.from(group.querySelectorAll<HTMLElement>('[data-tab-panel]'));
      const activeIndex = panels.findIndex((panel) => {
        if (panel.hasAttribute('data-active')) {
          return true;
        }

        const computedStyle = window.getComputedStyle(panel);
        return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden';
      });
      return activeIndex >= 0 ? activeIndex : 0;
    });
  }, []);

  const flushFocusedDecoratorDraft = useCallback(() => {
    flushDecoratorDrafts();

    if (typeof document === 'undefined') {
      return;
    }

    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
      return;
    }

    const isFocusedTitleInput = activeElement === titleInputRef.current;
    const isBlurSupportedEditable =
      isFocusedTitleInput ||
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement instanceof HTMLSelectElement ||
      activeElement.isContentEditable;

    if (!isBlurSupportedEditable) {
      return;
    }

    if (!isFocusedTitleInput && !activeElement.closest('[data-moss-note-editor-root="true"]')) {
      return;
    }

    if (isFocusedTitleInput) {
      commitTitleChangeRef.current();
    }

    activeElement.blur();
  }, []);

  const captureRenderedHtmlForPdf = useCallback((): string => {
    if (typeof window === 'undefined') {
      return '';
    }

    const editableRoot = scrollContainerRef.current?.querySelector('[data-moss-note-editor-root="true"]');
    if (!(editableRoot instanceof HTMLElement)) {
      return '';
    }

    // ── Step A: Snapshot canvas elements BEFORE cloning (pixel data doesn't survive cloneNode) ──
    const sourceCanvases = Array.from(editableRoot.querySelectorAll('canvas'));
    const canvasDataUrls: string[] = sourceCanvases.map((canvas) => {
      try {
        return canvas.toDataURL('image/png');
      } catch {
        return '';
      }
    });

    // ── Step B: Clone the DOM tree and build stable source→clone mapping ──
    const cloneRoot = editableRoot.cloneNode(true) as HTMLElement;
    // Build Map immediately after cloneNode when trees are structurally identical.
    // This survives all subsequent clone mutations (canvas replacement, element removal).
    const sourceAll = editableRoot.querySelectorAll<HTMLElement>('*');
    const cloneAll = cloneRoot.querySelectorAll<HTMLElement>('*');
    const sourceToClone = new Map<HTMLElement, HTMLElement>();
    sourceToClone.set(editableRoot, cloneRoot);
    for (let i = 0; i < sourceAll.length; i += 1) {
      const s = sourceAll[i];
      const c = cloneAll[i];
      if (s && c) sourceToClone.set(s, c);
    }

    // ── Step C: Replace cloned canvas elements with img tags ──
    const clonedCanvases = Array.from(cloneRoot.querySelectorAll('canvas'));
    for (let i = 0; i < clonedCanvases.length; i += 1) {
      const clonedCanvas = clonedCanvases[i];
      const dataUrl = canvasDataUrls[i];
      if (!clonedCanvas || !dataUrl) continue;
      const img = document.createElement('img');
      img.src = dataUrl;
      img.style.width = `${clonedCanvas.width}px`;
      img.style.height = `${clonedCanvas.height}px`;
      clonedCanvas.replaceWith(img);
    }

    // ── Step D: Strip interactive elements & expand collapsed sections ──
    for (const el of Array.from(cloneRoot.querySelectorAll('[data-block-decorator-key] button, [data-block-decorator-key] input, [data-block-decorator-key] textarea'))) {
      el.remove();
    }
    for (const el of Array.from(cloneRoot.querySelectorAll('[data-code-toolbar]'))) {
      el.remove();
    }
    for (const el of Array.from(cloneRoot.querySelectorAll('[data-radix-portal], [data-radix-popper-content-wrapper]'))) {
      el.remove();
    }
    // Track collapsed elements so we can override their inlined display:none later
    const uncollapsedCloneElements = new Set<HTMLElement>();
    for (const el of Array.from(cloneRoot.querySelectorAll('.heading-collapsed-content'))) {
      el.classList.remove('heading-collapsed-content');
      if (el instanceof HTMLElement) uncollapsedCloneElements.add(el);
    }

    // ── Step E: Remove opacity:0 elements inside block decorators ──
    // Uses the stable source→clone map — immune to index shifts from Step C/D mutations
    for (const [sourceEl, cloneEl] of sourceToClone) {
      const decoratorParent = sourceEl.closest('[data-block-decorator-key]');
      if (decoratorParent && window.getComputedStyle(sourceEl).opacity === '0') {
        cloneEl.remove();
      }
    }

    // ── Step F: Apply whitelisted inline styles using stable source→clone map ──
    const mediaTagNames = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO']);
    const pdfStyleWhitelist = new Set([
      // Typography
      'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
      'letter-spacing', 'text-align', 'text-decoration', 'text-decoration-color',
      'text-decoration-line', 'text-decoration-style', 'text-transform',
      'white-space', 'word-break', 'overflow-wrap',
      // Layout
      'display', 'flex-direction', 'align-items', 'justify-content', 'gap',
      'flex-wrap', 'flex-grow', 'flex-shrink',
      // Box model
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      // Background
      'background-color', 'background-image',
      // Border
      'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
      'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
      'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
      'border-top-left-radius', 'border-top-right-radius',
      'border-bottom-left-radius', 'border-bottom-right-radius',
      'border-collapse', 'border-spacing',
      // Clipping
      'overflow', 'overflow-x', 'overflow-y',
      // Other
      'list-style-type', 'vertical-align', 'opacity', 'visibility', 'tab-size',
      'aspect-ratio', 'table-layout'
    ]);
    const mediaDimensionProperties = new Set([
      'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height'
    ]);

    for (const [sourceElement, cloneElement] of sourceToClone) {
      // Skip elements that were removed from the clone in earlier steps
      if (!cloneElement.isConnected) continue;

      const computedStyle = window.getComputedStyle(sourceElement);
      const isMediaElement = mediaTagNames.has(sourceElement.tagName);
      const forceDisplayBlock = uncollapsedCloneElements.has(cloneElement);
      const styleParts: string[] = [];
      for (let styleIndex = 0; styleIndex < computedStyle.length; styleIndex += 1) {
        const property = computedStyle.item(styleIndex);
        // Skip display for un-collapsed elements — source has display:none but clone should be visible
        if (forceDisplayBlock && property === 'display') continue;
        if (pdfStyleWhitelist.has(property)) {
          styleParts.push(`${property}:${computedStyle.getPropertyValue(property)};`);
        } else if (isMediaElement && mediaDimensionProperties.has(property)) {
          styleParts.push(`${property}:${computedStyle.getPropertyValue(property)};`);
        }
      }
      if (forceDisplayBlock) {
        styleParts.push('display:block;');
      }
      cloneElement.setAttribute('style', styleParts.join(''));
      cloneElement.removeAttribute('contenteditable');
      cloneElement.removeAttribute('spellcheck');
      cloneElement.removeAttribute('data-lexical-text');
      cloneElement.removeAttribute('data-lexical-editor');
    }

    return cloneRoot.outerHTML;
  }, []);

  const buildMarkdownForSave = useCallback((options?: SaveMarkdownBuildOptions): string => {
    if (!editorInstanceRef.current || !note?.id) {
      return content;
    }

    const cached = options && 'cache' in options
      ? options.cache ?? null
      : getEditorBodyMarkdown();
    if (!cached) {
      // Editor unavailable — return last known disk content (has markers + footer).
      const diskContent = lastKnownDiskContentRef.current[note.id];
      if (diskContent) return diskContent;
      const fmData = store.get(noteFrontmatterAtom(note.id));
      return joinFrontmatter(content, fmData);
    }
    const titleForH1 = getLiveTitleText().trim() || 'Untitled';

    const fmData = store.get(noteFrontmatterAtom(note.id));
    const snapshot = frontmatterSnapshotRef.current[note.id];
    const currentSignature = buildFrontmatterSignature(fmData);

    return assembleNote({
      frontmatter: fmData,
      rawFrontmatterBlock:
        snapshot?.rawBlock &&
          (
            (fmData !== null && snapshot.signature === currentSignature) ||
            (fmData === null && snapshot.preserveWhenDataNull)
          )
          ? snapshot.rawBlock
          : null,
      h1Title: titleForH1,
      body: cached.markdownBody
    });
  }, [content, getEditorBodyMarkdown, getLiveTitleText, note?.id, store]);

  // Capture persisted markdown body (frontmatter + H1 + inline anchors).
  const captureMarkdownForSave = useCallback((): string => {
    return buildMarkdownForSave();
  }, [buildMarkdownForSave]);

  const scheduleEditorSettlingBaselineCapture = useCallback((settlingNoteId: string | null | undefined) => {
    if (editorSettlingRafRef.current !== null) {
      cancelAnimationFrame(editorSettlingRafRef.current);
    }

    const settlingRevision = editorContentRevisionRef.current;
    const settlingDirtyRevision = dirtyRevisionRef.current;
    editorSettlingRafRef.current = requestAnimationFrame(() => {
      editorSettlingRafRef.current = requestAnimationFrame(() => {
        editorSettlingRafRef.current = null;
        if (!settlingNoteId || !editorInstanceRef.current) {
          return;
        }
        if (!shouldCaptureEditorSettlingBaseline({
          settlingContentRevision: settlingRevision,
          currentContentRevision: editorContentRevisionRef.current,
          settlingDirtyRevision,
          currentDirtyRevision: dirtyRevisionRef.current,
          dirty: dirtyRef.current,
          dirtySource: dirtySourceRef.current
        })) {
          return;
        }

        lastEditorOutputRef.current[settlingNoteId] = buildMarkdownForSave();
        clearDirtyState();
      });
    });
  }, [buildMarkdownForSave, clearDirtyState]);


  const applyDiskUpdate = useCallback((
    markdown: string,
    commentMetadata?: CommentMetadataMap,
    layoutMetadata?: NoteLayoutMetadata
  ): boolean => {
    if (note?.id && shouldPreserveDirtyEditor(note.id)) {
      diskChangedWhileDirtyRef.current[note.id] = true;
      return false;
    }

    const editor = editorInstanceRef.current;
    if (!note?.id || !markdownEditorRef.current || !editor) {
      return false;
    }
    const markdownSafetyLoadError = buildMarkdownSafetyLoadError(markdown);
    if (markdownSafetyLoadError) {
      store.set(noteContentAtom(note.id), { content: '' });
      setContentLoadError(markdownSafetyLoadError);
      lastKnownDiskContentRef.current[note.id] = markdown;
      lastKnownDiskCommentMetadataRef.current[note.id] = commentMetadata ?? {};
      lastKnownDiskCommentSignatureRef.current[note.id] = buildCommentMetadataSignature(commentMetadata ?? {});
      lastKnownDiskLayoutMetadataRef.current[note.id] = layoutMetadata;
      lastKnownDiskLayoutComparisonRef.current[note.id] =
        serializeNoteLayoutMetadataForComparison(layoutMetadata);
      clearDirtyState();
      resetPendingAutosaveWindow();
      editorContentRevisionRef.current = 0;
      editorBodyCacheRef.current = null;
      return false;
    }

    const fmResult = splitFrontmatter(markdown);

    const result = markdownEditorRef.current.updateContentFromMarkdown(
      markdown,
      {
        clearHistory: true,
        scrollContainer: scrollContainerRef.current,
        commentMetadata,
        layoutMetadata
      }
    );
    if (!result) {
      return false;
    }
    setContentLoadError(null);

    syncH1ToTitle(note.id, result.h1Title, { skipIfTitleFocused: true });

    store.set(noteFrontmatterAtom(note.id), result.frontmatter);
    cacheFrontmatterSnapshot(note.id, markdown, fmResult);
    const diskCommentMetadata = commentMetadata ?? result.comments;
    const existingComments = store.get(noteCommentsMapAtom(note.id));
    const existingColors = Object.keys(existingComments).length > 0
      ? Object.fromEntries(Object.entries(existingComments).map(([id, c]) => [id, c.color]))
      : undefined;
    const hydratedComments = hydrateComments(diskCommentMetadata, existingColors);
    store.set(noteCommentsMapAtom(note.id), hydratedComments);
    store.set(noteContentAtom(note.id), { content: result.body });
    lastSavedCommentSignatureRef.current[note.id] =
      Object.keys(hydratedComments).length > 0 ? buildCommentSignature(hydratedComments) : '';
    lastSavedCommentDirtySignalRef.current[note.id] = store.get(commentDirtySignalAtom(note.id));

    clearDirtyState();
    resetPendingAutosaveWindow();
    editorContentRevisionRef.current = 0;
    editorBodyCacheRef.current = null;
    lastKnownDiskContentRef.current[note.id] = markdown;
    lastKnownDiskCommentMetadataRef.current[note.id] = diskCommentMetadata;
    lastKnownDiskCommentSignatureRef.current[note.id] = buildCommentMetadataSignature(diskCommentMetadata);
    lastKnownDiskLayoutMetadataRef.current[note.id] = layoutMetadata;
    lastKnownDiskLayoutComparisonRef.current[note.id] =
      serializeNoteLayoutMetadataForComparison(layoutMetadata);
    diskChangedWhileDirtyRef.current[note.id] = false;

    // Schedule editor output baseline sync after transforms settle on reimported content.
    scheduleEditorSettlingBaselineCapture(note.id);

    if (!result.success) {
      remountEditorPreservingScroll('in_place_import_failed');
    }

    return true;
  }, [cacheFrontmatterSnapshot, clearDirtyState, note?.id, remountEditorPreservingScroll, resetPendingAutosaveWindow, scheduleEditorSettlingBaselineCapture, shouldPreserveDirtyEditor, store]);

  const clearDiskRevalidateTimer = useCallback(() => {
    if (diskRevalidateTimerRef.current !== null) {
      clearTimeout(diskRevalidateTimerRef.current);
      diskRevalidateTimerRef.current = null;
    }
  }, []);

  const revalidateActiveNoteFromDisk = useCallback(async () => {
    if (!note?.id) {
      return;
    }

    clearPreloadedNoteRecord(note.id);
    const currentCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));
    const lastSavedCommentDirtySignal = lastSavedCommentDirtySignalRef.current[note.id];
    const hasPendingCommentSignal =
      lastSavedCommentDirtySignal === undefined
        ? currentCommentDirtySignal > 0
        : lastSavedCommentDirtySignal !== currentCommentDirtySignal;

    if (dirtyRef.current || hasPendingCommentSignal) {
      if (dirtySourceRef.current !== 'user' && !hasPendingCommentSignal) {
        clearDirtyState();
      } else {
        // Check if "dirty" is just from transforms (content matches post-transform
        // baseline). Compare against lastEditorOutputRef (not lastKnownDiskContentRef)
        // to avoid round-trip mismatches from AutoArrow/FormatWhitespaceBoundary
        // transforms falsely blocking the update.
        const currentBodyCache = getEditorBodyMarkdown();
        const currentContent = buildMarkdownForSave({ cache: currentBodyCache });
        const currentCommentSignature = buildCommentSignature(pruneCommentsWithoutAnchors(currentBodyCache));
        const currentLayoutComparison = serializeNoteLayoutMetadataForComparison(
          currentBodyCache?.layoutMetadata
        );
        if (
          currentContent !== lastEditorOutputRef.current[note.id] ||
          currentCommentSignature !== (lastKnownDiskCommentSignatureRef.current[note.id] ?? '') ||
          currentLayoutComparison !== (lastKnownDiskLayoutComparisonRef.current[note.id] ?? '')
        ) {
          diskChangedWhileDirtyRef.current[note.id] = true;
          return; // user has real unsaved edits — user wins
        }
        clearDirtyState();
        lastSavedCommentDirtySignalRef.current[note.id] = currentCommentDirtySignal;
      }
    }

    try {
      const fetchToken = Symbol('disk-watcher-fetch');
      const fetchUserRevision = localUserChangeRevisionRef.current;
      const fetchCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));
      latestNoteContentFetchTokenRef.current = fetchToken;
      const result = await notesApi.getContent.invoke(note.id);
      if (latestNoteContentFetchTokenRef.current !== fetchToken) {
        return;
      }
      if (!result) {
        return;
      }
      if (
        localUserChangeRevisionRef.current !== fetchUserRevision
        || store.get(commentDirtySignalAtom(note.id)) !== fetchCommentDirtySignal
      ) {
        diskChangedWhileDirtyRef.current[note.id] = true;
        return;
      }
      const diskContent = result.content ?? '';
      // Strip legacy comment footer to match hydrateFetchedNoteRecord,
      // which also stores stripped content in lastKnownDiskContentRef.
      const normalizedDiskContent = diskContent.includes('<!--moss:comments')
        ? parseCommentFooter(diskContent).strippedContent
        : diskContent;
      const diskCommentMetadata = result.commentMetadata ?? {};
      const diskCommentSignature = buildCommentMetadataSignature(diskCommentMetadata);
      const diskLayoutMetadata = result.layoutMetadata;
      const diskLayoutComparison = serializeNoteLayoutMetadataForComparison(diskLayoutMetadata);
      const previousDisk = lastKnownDiskContentRef.current[note.id];
      const previousCommentSignature = lastKnownDiskCommentSignatureRef.current[note.id] ?? '';
      const previousLayoutComparison = lastKnownDiskLayoutComparisonRef.current[note.id] ?? '';
      if (
        normalizedDiskContent === previousDisk &&
        diskCommentSignature === previousCommentSignature &&
        diskLayoutComparison === previousLayoutComparison
      ) {
        return;
      }

      // Frontmatter-only change (e.g. intelligence job inference) — update
      // the ref and hydrate the frontmatter atom, but skip editor reimport
      // to preserve collapse state.
      const diskFmResult = splitFrontmatter(normalizedDiskContent);
      if (
        previousDisk != null &&
        diskFmResult.body === splitFrontmatter(previousDisk).body &&
        diskCommentSignature === previousCommentSignature &&
        diskLayoutComparison === previousLayoutComparison
      ) {
        lastKnownDiskContentRef.current[note.id] = normalizedDiskContent;
        lastKnownDiskCommentMetadataRef.current[note.id] = diskCommentMetadata;
        lastKnownDiskCommentSignatureRef.current[note.id] = diskCommentSignature;
        lastKnownDiskLayoutMetadataRef.current[note.id] = diskLayoutMetadata;
        lastKnownDiskLayoutComparisonRef.current[note.id] = diskLayoutComparison;
        store.set(noteFrontmatterAtom(note.id), diskFmResult.data);
        cacheFrontmatterSnapshot(note.id, normalizedDiskContent, diskFmResult);
        return;
      }
      lastKnownDiskContentRef.current[note.id] = normalizedDiskContent;
      lastKnownDiskCommentMetadataRef.current[note.id] = diskCommentMetadata;
      lastKnownDiskCommentSignatureRef.current[note.id] = diskCommentSignature;
      lastKnownDiskLayoutMetadataRef.current[note.id] = diskLayoutMetadata;
      lastKnownDiskLayoutComparisonRef.current[note.id] = diskLayoutComparison;
      applyDiskUpdate(diskContent, diskCommentMetadata, diskLayoutMetadata);
    } catch {
      // Non-critical: watcher will fire again on next change
    }
  }, [applyDiskUpdate, buildMarkdownForSave, cacheFrontmatterSnapshot, clearDirtyState, getEditorBodyMarkdown, note?.id, pruneCommentsWithoutAnchors, store]);

  // Save both markdown (for export) and JSON state (canonical format)
  const saveContent = useCallback((options?: { force?: boolean; updatedAt?: number }): Promise<void> => {
    if (!note?.id || !hasElectronBridge || isTrashed || mossMultiPane.bound /* moss-multi seam: bound-pane (A§2.2): the binding persists */) {
      return Promise.resolve();
    }
    const noteId = note.id;
    const doSave = (priorSave?: Promise<void>): Promise<void> => {
      const saveStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const saveDirtyRevision = dirtyRevisionRef.current;
      const currentCommentDirtySignal = store.get(commentDirtySignalAtom(noteId));
      const lastSavedCommentDirtySignal = lastSavedCommentDirtySignalRef.current[noteId];
      const hasPendingCommentSignal =
        lastSavedCommentDirtySignal === undefined
          ? currentCommentDirtySignal > 0
          : lastSavedCommentDirtySignal !== currentCommentDirtySignal;
      profilePaneQuit('save-start', {
        noteId,
        force: options?.force === true,
        dirty: dirtyRef.current,
        dirtySource: dirtySourceRef.current,
        hasPendingCommentSignal,
        hasEditor: Boolean(editorInstanceRef.current)
      }, saveStart);

      if (!editorInstanceRef.current) {
        profilePaneQuit('save-skip-no-editor', { noteId }, saveStart);
        return priorSave ?? Promise.resolve();
      }

      if (!options?.force && !dirtyRef.current && !hasPendingCommentSignal) {
        resetPendingAutosaveWindow();
        profilePaneQuit('save-skip-clean', { noteId }, saveStart);
        return priorSave ?? Promise.resolve();
      }

      // A save is a data-integrity boundary, so serialize the current Lexical
      // state even when the revision-keyed cache appears valid. An ignored
      // programmatic update can be batched with a keystroke without advancing
      // that revision; persisting the cache would silently omit the user text.
      const bodyCache = getEditorBodyMarkdown(true);
      const currentCommentsMap = pruneCommentsWithoutAnchors(bodyCache);
      const currentCommentMetadata = buildCommentMetadata(currentCommentsMap);
      const currentCommentSignature = buildCommentMetadataSignature(currentCommentMetadata);
      const currentLayoutMetadata: NoteLayoutMetadata = bodyCache?.layoutMetadata ?? {
        version: 1,
        tableCount: 0,
        tables: []
      };
      const currentLayoutComparison = serializeNoteLayoutMetadataForComparison(currentLayoutMetadata);
      const baselineLayoutMetadata = lastKnownDiskLayoutMetadataRef.current[noteId];
      const baselineLayoutComparison = lastKnownDiskLayoutComparisonRef.current[noteId] ?? '';
      const hasLocalLayoutChanges = currentLayoutComparison !== baselineLayoutComparison;
      let layoutMetadataForWrite: NoteLayoutMetadata | undefined =
        hasLocalLayoutChanges ? currentLayoutMetadata : undefined;
      let expectedLayoutMetadataForWrite: NoteLayoutMetadata | null | undefined =
        hasLocalLayoutChanges
          ? baselineLayoutMetadata ?? null
          : baselineLayoutComparison !== ''
            ? baselineLayoutMetadata ?? null
            : undefined;
      profilePaneQuit('save-body-and-comments-built', {
        noteId,
        hasBodyCache: Boolean(bodyCache),
        commentCount: Object.keys(currentCommentsMap).length
      }, saveStart);

      // Fallback integrity check: if only the comment dirty signal changed but the
      // normalized comment payload is identical to the last persisted one, skip write.
      if (!priorSave && !options?.force && !dirtyRef.current && hasPendingCommentSignal) {
        const lastSavedCommentSignature = lastSavedCommentSignatureRef.current[noteId];
        const hasPendingCommentChanges =
          lastSavedCommentSignature === undefined
            ? Object.keys(currentCommentsMap).length > 0
            : lastSavedCommentSignature !== currentCommentSignature;

        if (!hasPendingCommentChanges) {
          lastSavedCommentDirtySignalRef.current[noteId] = currentCommentDirtySignal;
          resetPendingAutosaveWindow();
          profilePaneQuit('save-skip-comment-signal-only', { noteId }, saveStart);
          return Promise.resolve();
        }
      }

      clearPendingAutosaveTimer();
      setSaveError(null);
      const liveBody = captureMarkdownFromEditor();
      if (liveBody !== content) {
        setNoteContent({ content: liveBody });
      }
      const pendingContent = buildMarkdownForSave({ cache: bodyCache });
      const localBaselineContent =
        lastEditorOutputRef.current[noteId] ?? lastKnownDiskContentRef.current[noteId];
      const hasLocalBodyChanges =
        localBaselineContent !== undefined
        && disassembleNote(pendingContent).body !== disassembleNote(localBaselineContent).body;
      let contentForWrite = pendingContent;
      let commentMetadataForWrite = currentCommentMetadata;
      let commentSignatureForWrite = currentCommentSignature;
      let saveRebasedFromLatestDisk = false;
      let shouldReconcileEditorLayoutFromLatestDisk = false;
      profilePaneQuit('save-markdown-built', {
        noteId,
        liveBodyLength: liveBody.length,
        pendingContentLength: pendingContent.length,
        atomContentLength: content.length
      }, saveStart);
      let expectedDiskContent = lastKnownDiskContentRef.current[noteId];
      let expectedCommentMetadata = lastKnownDiskCommentMetadataRef.current[noteId] ?? {};
      let rollbackLayoutMetadata = baselineLayoutMetadata;
      let rollbackLayoutComparison = baselineLayoutComparison;
      const diskChangedWhileDirty = diskChangedWhileDirtyRef.current[noteId] === true;

      // Content-level idempotency: if serialized output matches what's on disk,
      // there's nothing to write. Prevents stale overwrites even if dirtyRef was
      // incorrectly set (e.g. transform-triggered update without user edits).
      if (
        !priorSave &&
        !options?.force &&
        pendingContent === lastKnownDiskContentRef.current[noteId] &&
        currentCommentSignature === (lastKnownDiskCommentSignatureRef.current[noteId] ?? '') &&
        currentLayoutComparison === (lastKnownDiskLayoutComparisonRef.current[noteId] ?? '')
      ) {
        clearDirtyState();
        lastSavedCommentSignatureRef.current[noteId] = currentCommentSignature;
        lastSavedCommentDirtySignalRef.current[noteId] = currentCommentDirtySignal;
        resetPendingAutosaveWindow();
        profilePaneQuit('save-skip-idempotent', { noteId }, saveStart);
        return Promise.resolve();
      }
      const timestamp = options?.updatedAt ?? Math.floor(Date.now() / 1000);
      const frontmatterMetaUpdatesSnapshot = { ...store.get(pendingFrontmatterMetaAtom(noteId)) };
      const hasFrontmatterMetaUpdates = Object.keys(frontmatterMetaUpdatesSnapshot).length > 0;
      const commentColorsSnapshot = Object.fromEntries(
        Object.entries(currentCommentsMap)
          .filter(([, c]) => c.color !== undefined)
          .map(([id, c]) => [id, c.color])
      );
      const maybeRebaseNonBodySave = (
        latestContent: string,
        latestCommentMetadata: CommentMetadataMap,
        baselineDiskContent: string | undefined,
        baselineCommentMetadata: CommentMetadataMap
      ): void => {
        const rebased = rebaseNonBodySaveOnLatestDisk({
          pendingContent,
          localBaselineContent,
          previousDiskContent: baselineDiskContent,
          latestDiskContent: latestContent,
          pendingCommentMetadata: commentMetadataForWrite,
          baselineCommentMetadata,
          latestCommentMetadata
        });

        if (!rebased.rebased) {
          return;
        }

        contentForWrite = rebased.content;
        commentMetadataForWrite = rebased.commentMetadata;
        commentSignatureForWrite = buildCommentMetadataSignature(rebased.commentMetadata);
        saveRebasedFromLatestDisk = true;
        profilePaneQuit('save-rebased-non-body-change', { noteId }, saveStart);
      };
      const maybeRebaseContentSave = (
        latestContent: string,
        latestCommentMetadata: CommentMetadataMap,
        baselineDiskContent: string | undefined,
        baselineCommentMetadata: CommentMetadataMap
      ): void => {
        if (!hasLocalBodyChanges) {
          maybeRebaseNonBodySave(
            latestContent,
            latestCommentMetadata,
            baselineDiskContent,
            baselineCommentMetadata
          );
          return;
        }

        const rebased = rebaseActiveUserSaveOnLatestDisk({
          pendingContent,
          previousDiskContent: localBaselineContent,
          latestDiskContent: latestContent
        });
        if (!rebased.rebased) {
          return;
        }

        contentForWrite = rebased.content;
        saveRebasedFromLatestDisk = true;
        profilePaneQuit('save-rebased-active-user-change', { noteId }, saveStart);
      };
      // Reconcile comment sidecar metadata against the latest disk state before a
      // write that will set expectedCommentMetadata=latest. A blind retry would
      // pass the backend CAS check and overwrite external comment changes with our
      // stale local metadata. Comment sidecar churn must not block markdown saves:
      // three-way merge the sidecar and persist the merged metadata with the save.
      const reconcileCommentMetadataOnLatestDisk = (
        latestCommentMetadata: CommentMetadataMap,
        baselineCommentMetadata: CommentMetadataMap
      ): void => {
        const { merged, conflictIds } = mergeCommentMetadata(
          baselineCommentMetadata,
          currentCommentMetadata,
          latestCommentMetadata
        );
        if (conflictIds.length > 0) {
          profilePaneQuit('save-merged-comment-conflicts', {
            noteId,
            conflictCount: conflictIds.length
          }, saveStart);
        }
        const externallyChangedUnreachableIds = findExternallyChangedUnreachableCommentMetadata({
          markdown: contentForWrite,
          mergedMetadata: merged,
          currentMetadata: currentCommentMetadata,
          latestMetadata: latestCommentMetadata
        });
        if (externallyChangedUnreachableIds.length > 0) {
          // Active-editor-wins: the user's body no longer contains these
          // anchors, so external edits to them cannot survive this save.
          // Blocking the user's save here would surface a conflict error for
          // a normal multi-writer race; log the drop and continue.
          profilePaneQuit('save-dropped-externally-changed-unreachable-comments', {
            noteId,
            commentCount: externallyChangedUnreachableIds.length
          }, saveStart);
        }
        const { metadata: reachableMerged, droppedIds: unreachableCommentIds } =
          dropUnreachableCommentMetadata(contentForWrite, merged);
        if (unreachableCommentIds.length > 0) {
          profilePaneQuit('save-dropped-unreachable-comment-metadata', {
            noteId,
            commentCount: unreachableCommentIds.length
          }, saveStart);
        }
        const mergedSignature = buildCommentMetadataSignature(reachableMerged);
        if (mergedSignature === commentSignatureForWrite) {
          return;
        }
        commentMetadataForWrite = reachableMerged;
        commentSignatureForWrite = mergedSignature;
        if (mergedSignature !== currentCommentSignature) {
          // External comment changes were merged in — re-hydrate the editor from
          // the written state after save so the merged comments are reflected.
          saveRebasedFromLatestDisk = true;
        }
      };
      let skippedQueuedIdempotentSave = false;
      const savePromise = (priorSave ?? Promise.resolve())
        .then(async () => {
          if (
            priorSave &&
            pendingContent === lastKnownDiskContentRef.current[noteId] &&
            currentCommentSignature === (lastKnownDiskCommentSignatureRef.current[noteId] ?? '') &&
            currentLayoutComparison === (lastKnownDiskLayoutComparisonRef.current[noteId] ?? '')
          ) {
            skippedQueuedIdempotentSave = true;
            profilePaneQuit('save-skip-queued-idempotent', { noteId }, saveStart);
            return undefined;
          }

          const applyLatestDiskExpectations = (latest: {
            content: string;
            commentMetadata?: CommentMetadataMap;
            layoutMetadata?: NoteLayoutMetadata;
          }) => {
            const baselineDiskContent = expectedDiskContent;
            const baselineCommentMetadata = expectedCommentMetadata;
            const latestCommentMetadata = latest.commentMetadata ?? {};
            const latestLayoutMetadata = latest.layoutMetadata;
            const latestLayoutComparison = serializeNoteLayoutMetadataForComparison(latestLayoutMetadata);
            maybeRebaseContentSave(
              latest.content,
              latestCommentMetadata,
              baselineDiskContent,
              baselineCommentMetadata
            );
            reconcileCommentMetadataOnLatestDisk(latestCommentMetadata, baselineCommentMetadata);

            diskChangedWhileDirtyRef.current[noteId] = false;
            lastKnownDiskContentRef.current[noteId] = latest.content;
            lastKnownDiskCommentMetadataRef.current[noteId] = latestCommentMetadata;
            lastKnownDiskCommentSignatureRef.current[noteId] = buildCommentMetadataSignature(latestCommentMetadata);
            lastKnownDiskLayoutMetadataRef.current[noteId] = latestLayoutMetadata;
            lastKnownDiskLayoutComparisonRef.current[noteId] = latestLayoutComparison;
            expectedDiskContent = latest.content;
            expectedCommentMetadata = latestCommentMetadata;
            rollbackLayoutMetadata = latestLayoutMetadata;
            rollbackLayoutComparison = latestLayoutComparison;
            if (!hasLocalLayoutChanges) {
              shouldReconcileEditorLayoutFromLatestDisk =
                shouldReconcileEditorLayoutFromLatestDisk ||
                latestLayoutComparison !== baselineLayoutComparison;
              layoutMetadataForWrite = undefined;
              expectedLayoutMetadataForWrite =
                latestLayoutComparison !== ''
                  ? latestLayoutMetadata ?? null
                  : undefined;
            }
          };

          // If a watcher event arrived while dirty, re-check disk content right
          // before writing to avoid silently overwriting unseen external changes.
          if (diskChangedWhileDirty) {
            profilePaneQuit('save-refresh-disk-start', { noteId }, saveStart);
            const latest = await notesApi.getContent.invoke(noteId);
            if (!latest) {
              throw new Error('Unable to verify note content on disk before saving.');
            }
            profilePaneQuit('save-refresh-disk-complete', { noteId }, saveStart);
            applyLatestDiskExpectations(latest);
          }

          const saveWithExpectedContent = (
            expectedContent: string | undefined,
            expectedComments: CommentMetadataMap
          ) =>
            notesApi.update.invoke(noteId, {
              content: contentForWrite,
              expectedDiskContent: expectedContent,
              commentMetadata: commentMetadataForWrite,
              expectedCommentMetadata: expectedComments,
              ...(layoutMetadataForWrite !== undefined
                ? {
                    layoutMetadata: layoutMetadataForWrite,
                    expectedLayoutMetadata: expectedLayoutMetadataForWrite ?? null
                  }
                : expectedLayoutMetadataForWrite !== undefined
                ? {
                    expectedLayoutMetadata: expectedLayoutMetadataForWrite
                  }
                : {}),
              updatedAt: timestamp,
              ...(hasFrontmatterMetaUpdates
                ? { frontmatterMetaUpdates: frontmatterMetaUpdatesSnapshot }
                : {}),
              commentColors: commentColorsSnapshot
            });

          // Active-editor-wins escape hatch: after repeated CAS conflicts, ask
          // the backend to resolve the final race under its per-note lock. It
          // keeps the user's body while merging the latest compatible
          // title/frontmatter/comment layers and preserving layout metadata
          // unless this editor changed it.
          const saveUserWinsUnderNoteLock = async () => {
            const updated = await notesApi.update.invoke(noteId, {
              content: contentForWrite,
              expectedDiskContent,
              commentMetadata: commentMetadataForWrite,
              expectedCommentMetadata,
              ...(layoutMetadataForWrite !== undefined
                ? {
                    layoutMetadata: layoutMetadataForWrite,
                    expectedLayoutMetadata: expectedLayoutMetadataForWrite ?? null
                  }
                : expectedLayoutMetadataForWrite !== undefined
                ? { expectedLayoutMetadata: expectedLayoutMetadataForWrite }
                : {}),
              activeUserWins: true,
              updatedAt: timestamp,
              ...(hasFrontmatterMetaUpdates
                ? { frontmatterMetaUpdates: frontmatterMetaUpdatesSnapshot }
                : {}),
              commentColors: commentColorsSnapshot
            });

            // The locked write may have incorporated newer non-body layers.
            // Re-read the exact persisted result so renderer baselines and the
            // editor hydration path agree with disk.
            const persisted = await notesApi.getContent.invoke(noteId);
            if (persisted) {
              if (persisted.content !== contentForWrite) {
                saveRebasedFromLatestDisk = true;
              }
              contentForWrite = persisted.content;
              commentMetadataForWrite = persisted.commentMetadata ?? {};
              commentSignatureForWrite = buildCommentMetadataSignature(commentMetadataForWrite);
              if (!hasLocalLayoutChanges) {
                layoutMetadataForWrite = undefined;
                rollbackLayoutMetadata = persisted.layoutMetadata;
                rollbackLayoutComparison = serializeNoteLayoutMetadataForComparison(
                  persisted.layoutMetadata
                );
                lastKnownDiskLayoutMetadataRef.current[noteId] = persisted.layoutMetadata;
                lastKnownDiskLayoutComparisonRef.current[noteId] = rollbackLayoutComparison;
              }
            }
            return updated;
          };

          profilePaneQuit('save-ipc-update-start', { noteId }, saveStart);
          for (let attempt = 0; attempt < MAX_DISK_CONFLICT_SAVE_RETRIES; attempt += 1) {
            const expectedForWrite =
              typeof expectedDiskContent === 'string' ? expectedDiskContent : undefined;
            try {
              return await saveWithExpectedContent(expectedForWrite, expectedCommentMetadata);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : '';
              if (!isDiskConflictSaveError(errorMessage)) {
                throw error;
              }

              // Graceful auto-recovery: rebase our pending editor save onto the
              // latest disk content and try again instead of surfacing a merge
              // error for a normal multi-writer race.
              const latest = await notesApi.getContent.invoke(noteId);
              if (!latest) {
                throw error;
              }
              applyLatestDiskExpectations(latest);
              profilePaneQuit('save-conflict-refreshed', { noteId, attempt }, saveStart);
            }
          }

          // Disk kept changing between refresh and retry — persist the user's
          // body anyway rather than surfacing a save error for an expected
          // concurrency condition.
          profilePaneQuit('save-user-wins-forced-write', { noteId }, saveStart);
          return await saveUserWinsUnderNoteLock();
        })
        .then((updated) => {
          profilePaneQuit('save-ipc-update-complete', { noteId }, saveStart);
          const saveCompletedForActiveEditor =
            contentHydratedForNoteIdRef.current === noteId;
          const hasTrackedNewLocalChanges =
            saveCompletedForActiveEditor
            && (
              dirtyRevisionRef.current !== saveDirtyRevision ||
              store.get(commentDirtySignalAtom(noteId)) !== currentCommentDirtySignal
            );
          let hasUntrackedEditableLayerChanges = false;
          if (
            !hasTrackedNewLocalChanges
            && saveCompletedForActiveEditor
          ) {
            const liveBody = getEditorBodyMarkdown(true);
            if (liveBody) {
              const live = disassembleNote(buildMarkdownForSave({ cache: liveBody }));
              const persisted = disassembleNote(contentForWrite);
              hasUntrackedEditableLayerChanges =
                live.h1Title !== persisted.h1Title || live.body !== persisted.body;
            }
            if (hasUntrackedEditableLayerChanges) {
              const persistedFrontmatter = splitFrontmatter(contentForWrite);
              store.set(noteFrontmatterAtom(noteId), persistedFrontmatter.data);
              // A real editor/title change was coalesced with an ignored update.
              // Keep the live editor mounted and queue a follow-up save instead
              // of reconciling the stale just-persisted snapshot back into it.
              // Hydrate only the persisted frontmatter layer so the follow-up
              // body save retains background inference without reloading text.
              markDirty('user');
              scheduleDebouncedAutosave();
              profilePaneQuit('save-detected-untracked-live-edit', { noteId }, saveStart);
            }
          }
          const hasNewLocalChanges =
            hasTrackedNewLocalChanges || hasUntrackedEditableLayerChanges;
          if (skippedQueuedIdempotentSave) {
            if (saveCompletedForActiveEditor && !hasNewLocalChanges) {
              clearDirtyState();
              resetPendingAutosaveWindow();
            }
            lastSavedCommentSignatureRef.current[noteId] = currentCommentSignature;
            lastSavedCommentDirtySignalRef.current[noteId] = currentCommentDirtySignal;
            return;
          }
          if (!updated) {
            throw new Error('Unable to save changes for this note.');
          }
          const revalidateAfterSave =
            !diskChangedWhileDirty &&
            diskChangedWhileDirtyRef.current[noteId] === true;

          // noteContentAtom may be stale (no debounce serialization during typing).
          // This is fine — nothing reads the atom while the editor is mounted.
          // The editor is the source of truth; the atom updates on save/rehydrate.
          if (saveCompletedForActiveEditor && !hasNewLocalChanges) {
            clearDirtyState();
            resetPendingAutosaveWindow();
            diskChangedWhileDirtyRef.current[noteId] = false;
          }
          lastKnownDiskContentRef.current[noteId] = contentForWrite;
          lastKnownDiskCommentMetadataRef.current[noteId] = commentMetadataForWrite;
          lastKnownDiskCommentSignatureRef.current[noteId] = commentSignatureForWrite;
          const layoutMetadataAfterSave =
            layoutMetadataForWrite ?? lastKnownDiskLayoutMetadataRef.current[noteId];
          lastKnownDiskLayoutMetadataRef.current[noteId] = layoutMetadataAfterSave;
          lastKnownDiskLayoutComparisonRef.current[noteId] =
            layoutMetadataForWrite !== undefined
              ? serializeNoteLayoutMetadataForComparison(layoutMetadataForWrite)
              : lastKnownDiskLayoutComparisonRef.current[noteId] ?? '';
          lastEditorOutputRef.current[noteId] = contentForWrite;
          lastSavedCommentSignatureRef.current[noteId] = commentSignatureForWrite;
          lastSavedCommentDirtySignalRef.current[noteId] = currentCommentDirtySignal;
          if (hasFrontmatterMetaUpdates) {
            store.set(pendingFrontmatterMetaAtom(noteId), (prev) => {
              const next = { ...prev };
              for (const field of Object.keys(frontmatterMetaUpdatesSnapshot)) {
                if (next[field] === frontmatterMetaUpdatesSnapshot[field]) {
                  delete next[field];
                }
              }
              return next;
            });
          }
          cacheFrontmatterSnapshot(noteId, contentForWrite, splitFrontmatter(contentForWrite));
          if (hasFrontmatterMetaUpdates) {
            void notesApi.getFrontmatterSuggestions.invoke()
              .then((suggestions) => {
                store.set(workspaceFrontmatterSuggestionsAtom, suggestions);
              })
              .catch(() => undefined);
          }
          const nextUpdatedAt = updated?.updatedAt ?? timestamp;

          // Record save timestamp to skip rehydrate when it echoes back
          lastLocalSaveAtRef.current[noteId] = { updatedAt: nextUpdatedAt };

          // Update the NoteEntity atom for metadata
          store.set(syncNoteEntityAtom, {
            noteId,
            updates: {
              updatedAt: nextUpdatedAt,
              ...(typeof updated?.title === 'string' ? { title: updated.title } : {}),
              ...(typeof updated?.contentPath === 'string' ? { contentPath: updated.contentPath } : {})
            }
          });

          if (
            saveCompletedForActiveEditor &&
            !hasNewLocalChanges &&
            (saveRebasedFromLatestDisk || shouldReconcileEditorLayoutFromLatestDisk)
          ) {
            const rebaseChangedBody =
              disassembleNote(contentForWrite).body !== disassembleNote(pendingContent).body;
            if (!rebaseChangedBody && !shouldReconcileEditorLayoutFromLatestDisk) {
              // The rebase only absorbed non-body layers (frontmatter and/or
              // comment metadata — e.g. a note-intelligence write that landed
              // while the user was typing). The editor already holds this exact
              // body; hydrate the affected atoms directly. A full reimport here
              // rebuilds every node and destroys the user's selection.
              store.set(noteFrontmatterAtom(noteId), splitFrontmatter(contentForWrite).data);
              const hydrated = hydrateComments(commentMetadataForWrite);
              store.set(noteCommentsMapAtom(noteId), hydrated);
              lastSavedCommentSignatureRef.current[noteId] =
                Object.keys(hydrated).length > 0 ? buildCommentSignature(hydrated) : '';
            } else {
              applyDiskUpdate(
                contentForWrite,
                commentMetadataForWrite,
                layoutMetadataAfterSave
              );
            }
          }

          if (saveCompletedForActiveEditor && revalidateAfterSave) {
            void revalidateActiveNoteFromDisk();
          }

          // Update link atoms for all affected notes (when links changed)
          if (updated.affectedLinks) {
            for (const [affectedId, links] of Object.entries(updated.affectedLinks)) {
              store.set(noteLinksAtom(affectedId), {
                outgoing: links.outgoing,
                incoming: links.incoming
              });
            }
          }

          setRetryToast((current) =>
            current && current.type === 'content' && current.noteId === noteId
              ? null
              : current
          );
        })
        .catch((error) => {
          lastKnownDiskContentRef.current[noteId] = expectedDiskContent;
          lastKnownDiskCommentMetadataRef.current[noteId] = expectedCommentMetadata;
          lastKnownDiskCommentSignatureRef.current[noteId] = buildCommentMetadataSignature(expectedCommentMetadata);
          lastKnownDiskLayoutMetadataRef.current[noteId] = rollbackLayoutMetadata;
          lastKnownDiskLayoutComparisonRef.current[noteId] = rollbackLayoutComparison;
          const normalizedError = error instanceof Error ? error : new Error('Failed to save changes.');
          const message = normalizedError.message;
          setSaveError(message);
          setRetryToast({ type: 'content', noteId, message });
          throw normalizedError;
        })
        .finally(() => {
          profilePaneQuit('save-finished', { noteId }, saveStart);
          if (savePromiseRef.current === savePromise) {
            savePromiseRef.current = null;
          }
          // Clear global tracker so agent handler knows no save is pending
          if (store.get(pendingSavePromiseAtom(noteId)) === savePromise) {
            store.set(pendingSavePromiseAtom(noteId), null);
          }
        });

      savePromiseRef.current = savePromise;
      // Publish to global atom so agent handler can await this save
      store.set(pendingSavePromiseAtom(noteId), savePromise);
      return savePromise;
    };

    const inFlightSave = savePromiseRef.current;
    if (inFlightSave) {
      profilePaneQuit('save-wait-in-flight', { noteId });
      return doSave(inFlightSave);
    }

    return doSave();
  }, [
    applyDiskUpdate,
    cacheFrontmatterSnapshot,
    clearDirtyState,
    clearPendingAutosaveTimer,
    content,
    buildMarkdownForSave,
    captureMarkdownFromEditor,
    getEditorBodyMarkdown,
    hasElectronBridge,
    isTrashed,
    note?.id,
    pruneCommentsWithoutAnchors,
    resetPendingAutosaveWindow,
    revalidateActiveNoteFromDisk,
    markDirty,
    scheduleDebouncedAutosave,
    setNoteContent,
    store
  ]);

  // Keep a stable ref to saveContent for use in cleanup functions
  const saveContentRef = useRef(saveContent);
  useEffect(() => {
    saveContentRef.current = saveContent;
    if (note?.id) {
      saveContentByNoteIdRef.current[note.id] = saveContent;
    }
  }, [note?.id, saveContent]);

  // Flush pending saves when the note changes or component unmounts.
  // This ensures edits aren't lost when switching notes within the app.
  useLayoutEffect(() => {
    const currentNoteId = note?.id;
    return () => {
      flushFocusedDecoratorDraft();
      // Cancel any pending debounced autosave BEFORE flushing.
      // Without this, the debounce timer fires after the note switch and
      // captureMarkdownFromEditor() reads the NEW note's editor content,
      // but setNoteContent still targets the OLD note's atom — corrupting it.
      clearPendingAutosaveTimer();
      if (editorSettlingRafRef.current !== null) {
        cancelAnimationFrame(editorSettlingRafRef.current);
        editorSettlingRafRef.current = null;
      }
      clearDiskRevalidateTimer();
      if (scrollCursorRafRef.current) {
        cancelAnimationFrame(scrollCursorRafRef.current);
        scrollCursorRafRef.current = null;
      }
      setShowNoteStats(false);
      clearAgentCanvasLoading();
      clearAgentVisualBell();
      store.set(lightboxSrcAtom, null);
      // Only save if we had a note loaded
      if (currentNoteId) {
        if (hasElectronBridge && window.electronAPI?.remoteWebSurface) {
          void remoteWebSurfaceApi.destroyForNote.invoke({ noteId: currentNoteId }).catch(() => {});
        }
        const saveForCurrentNote = saveContentByNoteIdRef.current[currentNoteId];
        if (saveForCurrentNote) {
          // Cleanup should never throw unhandled promise rejections.
          void saveForCurrentNote().catch(() => {});
        }
        delete saveContentByNoteIdRef.current[currentNoteId];
      }
    };
  }, [clearAgentCanvasLoading, clearAgentVisualBell, clearPendingAutosaveTimer, flushFocusedDecoratorDraft, hasElectronBridge, note?.id]);


  const flushPendingSave = useCallback(async (): Promise<void> => {
    flushFocusedDecoratorDraft();
    await saveContent();
  }, [flushFocusedDecoratorDraft, saveContent]);

  // Autosave triggers: 30-min periodic safety net + comment dirty signal subscription
  useEffect(() => {
    if (!note?.id || !hasElectronBridge || isTrashed || mossMultiPane.bound /* moss-multi seam: bound-pane (A§2.2) */) {
      return;
    }

    const intervalId = setInterval(() => {
      runAutosaveNow();
    }, PERIODIC_SAVE_INTERVAL_MS);

    const unsubComments = store.sub(commentDirtySignalAtom(note.id), () => {
      scheduleDebouncedAutosave();
    });

    const unsubFrontmatter = store.sub(frontmatterDirtySignalAtom(note.id), () => {
      markDirty('user');
      scheduleDebouncedAutosave();
    });

    return () => {
      clearInterval(intervalId);
      unsubComments();
      unsubFrontmatter();
    };
  }, [hasElectronBridge, isTrashed, markDirty, note?.id, runAutosaveNow, store, scheduleDebouncedAutosave]);

  // =========================================================================
  // Disk watcher: detect external writes (agent, other apps) and apply them.
  // If the user has unsaved edits (dirty), skip — user wins.
  // =========================================================================
  useEffect(() => {
    if (!hasElectronBridge || !note?.id || isTrashed || mossMultiPane.bound /* moss-multi seam: bound-pane (A§2.2) */) return;

    const runPendingDiskRevalidation = () => {
      pendingDiskRevalidateOnFocusRef.current = false;
      clearDiskRevalidateTimer();
      void revalidateActiveNoteFromDisk();
    };

    const handleWindowBecameVisible = () => {
      if (!pendingDiskRevalidateOnFocusRef.current) {
        return;
      }
      if (document.visibilityState !== 'visible') {
        return;
      }
      if (dirtyRef.current && dirtySourceRef.current === 'user') {
        diskChangedWhileDirtyRef.current[note.id] = true;
        clearDiskRevalidateTimer();
        return;
      }
      runPendingDiskRevalidation();
    };

    const cleanup = window.electronAPI.notes.onDiskChange((noteIds, contentNoteIds = []) => {
      // Main process now emits targeted note IDs when it can. Only fall back
      // to a full active-note revalidation when the change could not be resolved.
      if (noteIds.length > 0 && contentNoteIds.length === 0) {
        return;
      }

      if (contentNoteIds.length > 0 && !contentNoteIds.includes(note.id)) {
        return;
      }

      if (dirtyRef.current && dirtySourceRef.current === 'user') {
        diskChangedWhileDirtyRef.current[note.id] = true;
        clearDiskRevalidateTimer();
        return;
      }

      pendingDiskRevalidateOnFocusRef.current = true;
      clearDiskRevalidateTimer();
      diskRevalidateTimerRef.current = setTimeout(() => {
        diskRevalidateTimerRef.current = null;
        runPendingDiskRevalidation();
      }, ACTIVE_NOTE_DISK_REVALIDATE_DEBOUNCE_MS);
    });

    window.addEventListener('focus', handleWindowBecameVisible);
    document.addEventListener('visibilitychange', handleWindowBecameVisible);

    return () => {
      clearDiskRevalidateTimer();
      pendingDiskRevalidateOnFocusRef.current = false;
      window.removeEventListener('focus', handleWindowBecameVisible);
      document.removeEventListener('visibilitychange', handleWindowBecameVisible);
      cleanup();
    };
  }, [clearDiskRevalidateTimer, hasElectronBridge, isTrashed, note?.id, revalidateActiveNoteFromDisk]);

  // Flushes any pending/debounced save AND waits for in-flight saves to complete
  const flushAndWait = useCallback(async (): Promise<void> => {
    const flushStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    profilePaneQuit('flush-start', {
      noteId: note?.id ?? null
    }, flushStart);
    await flushPendingSave();
    profilePaneQuit('flush-finished', {
      noteId: note?.id ?? null
    }, flushStart);
  }, [flushPendingSave, note?.id]);

  // Quit-flush: handled at the App level via a single window-wide
  // onRequestFlush listener that fans out to every pane's flushAndWait and
  // emits one aggregated flushComplete. Both panes in a split window share
  // the same webContents.id, so per-pane listeners would race and one
  // pane's failure could be overwritten by the other's success.

  // Focus the title field and select all text
  const focusTitle = useCallback(() => {
    if (mossMultiPane.title.deferFocus()) return; // moss-multi seam: focus only after bind
    if (titleInputRef.current) {
      titleInputRef.current.focus();
      const range = document.createRange();
      range.selectNodeContents(titleInputRef.current);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      isTitleFocusedRef.current = true;
    }
  }, []);

  const expectStickyTabMetadataUpdate = useCallback((updatedAt: number) => {
    expectedStickyTabTimestampRef.current = updatedAt;
  }, []);

  const getMountedNoteId = useCallback((): string | null => {
    return note?.id ?? null;
  }, [note?.id]);

  const getSelectedText = useCallback((): string => {
    return markdownEditorRef.current?.getSelectedText() ?? '';
  }, []);

  const markSelectionAsContext = useCallback((): string => {
    return markdownEditorRef.current?.markSelectionAsContext() ?? '';
  }, []);

  const clearContextMark = useCallback((): void => {
    markdownEditorRef.current?.clearContextMark();
  }, []);

  const openSelectedImageAltTextEditor = useCallback((): boolean => {
    return markdownEditorRef.current?.openSelectedImageAltTextEditor() ?? false;
  }, []);

  const resolveCommentThread = useCallback((commentId: string, options?: ResolveCommentThreadOptions): void => {
    if (!note?.id) return;

    const commentsMap = store.get(noteCommentsMapAtom(note.id));
    const result = setCommentSubtreeResolvedState(commentsMap, commentId, {
      resolved: true,
      timestamp: options?.resolvedAt ?? Math.floor(Date.now() / 1000),
      resolvedBy: options?.resolvedBy ?? 'agent'
    });
    if (result.changed) {
      store.set(noteCommentsMapAtom(note.id), result.map);
    }

    if ((options?.markDirty ?? true) && result.changed) {
      store.set(commentDirtySignalAtom(note.id), (c) => c + 1);
    }
  }, [note?.id, store]);

  const unwrapComment = useCallback((commentId: string): void => {
    resolveCommentThread(commentId);
  }, [resolveCommentThread]);

  const scrollToHeading = useCallback((heading: string): boolean => {
    const editor = editorInstanceRef.current;
    if (!editor) return false;
    let found = false;
    editor.getEditorState().read(() => {
      const root = $getRoot();
      const target = heading.trim().toLocaleLowerCase();
      let partialMatch: HTMLElement | null = null;
      for (const child of root.getChildren()) {
        if ($isHeadingNode(child)) {
          const text = child.getTextContent().trim();
          if (text.toLocaleLowerCase() === target) {
            const dom = editor.getElementByKey(child.getKey());
            if (dom) {
              dom.scrollIntoView({ behavior: 'smooth', block: 'start' });
              found = true;
            }
            break;
          }
          if (!partialMatch && text.toLocaleLowerCase().includes(target)) {
            const dom = editor.getElementByKey(child.getKey());
            if (dom) partialMatch = dom;
          }
        }
      }
      if (!found && partialMatch) {
        partialMatch.scrollIntoView({ behavior: 'smooth', block: 'start' });
        found = true;
      }
    });
    return found;
  }, []);

  const selectTab = useCallback(async (label: string): Promise<boolean> => {
    const targetLabel = label.trim().toLocaleLowerCase();
    if (!targetLabel) {
      return false;
    }

    const editableRoot = scrollContainerRef.current?.querySelector('[data-moss-note-editor-root="true"]');
    if (!(editableRoot instanceof HTMLElement)) {
      return false;
    }

    const tabElement = Array.from(
      editableRoot.querySelectorAll<HTMLElement>('[role="tab"]')
    ).find((element) => element.textContent?.trim().toLocaleLowerCase() === targetLabel);

    if (!(tabElement instanceof HTMLElement)) {
      return false;
    }

    tabElement.click();

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    return tabElement.getAttribute('aria-selected') === 'true';
  }, []);

  const setHeadingCollapsed = useCallback(async (heading: string, collapsed: boolean): Promise<boolean> => {
    const targetHeading = heading.trim().toLocaleLowerCase();
    if (!targetHeading) {
      return false;
    }

    const editableRoot = scrollContainerRef.current?.querySelector('[data-moss-note-editor-root="true"]');
    if (!(editableRoot instanceof HTMLElement)) {
      return false;
    }

    const headingElement = Array.from(
      editableRoot.querySelectorAll<HTMLElement>('h1, h2, h3, h4')
    ).find((element) => element.textContent?.trim().toLocaleLowerCase() === targetHeading);

    if (!(headingElement instanceof HTMLElement)) {
      return false;
    }

    const waitForFrame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => resolve());
        });
      });
    };

    const interactWithChevron = (): HTMLButtonElement | null => {
      const rect = headingElement.getBoundingClientRect();
      const mouseInit = {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + 8,
        clientY: rect.top + rect.height / 2,
      };

      headingElement.dispatchEvent(new MouseEvent('mouseover', mouseInit));
      headingElement.dispatchEvent(new MouseEvent('mousemove', mouseInit));

      return Array.from(
        scrollContainerRef.current?.querySelectorAll<HTMLButtonElement>('.collapsible-heading-chevron') ?? []
      ).find((button) => {
        const buttonRect = button.getBoundingClientRect();
        return Math.abs(buttonRect.top - rect.top) <= 4;
      }) ?? null;
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const chevronButton = interactWithChevron();
      if (!(chevronButton instanceof HTMLButtonElement)) {
        await waitForFrame();
        continue;
      }

      const ariaLabel = chevronButton.getAttribute('aria-label');
      const isFullyCollapsed = ariaLabel === 'Expand section';
      const isExpanded = ariaLabel === 'Collapse section';

      if (collapsed ? isFullyCollapsed : isExpanded) {
        return true;
      }

      chevronButton.click();
      await waitForFrame();
    }

    const finalChevron = interactWithChevron();
    const finalLabel = finalChevron?.getAttribute('aria-label');
    return collapsed ? finalLabel === 'Expand section' : finalLabel === 'Collapse section';
  }, []);

  const forceReloadFromDisk = useCallback(async (): Promise<boolean> => {
    const noteId = note?.id;
    if (!noteId || mossMultiPane.bound /* moss-multi seam: bound-pane (A§2.2) */) return false;
    try {
      const result = await notesApi.getById.invoke(noteId, { skipAnalytics: true });
      if (!result) return false;
      return hydrateFetchedNoteRecord(noteId, result);
    } catch {
      return false;
    }
  }, [note?.id, hydrateFetchedNoteRecord]);

  useEffect(() => {
    setCanEditSelectedImageAltText(false);
  }, [note?.id]);

  useEffect(() => {
    if (!hasElectronBridge) {
      return;
    }

    if (paneId && !isPaneFocused) {
      return;
    }

    void systemApi.setImageAltTextMenuEnabled.invoke(
      !isTrashed && canEditSelectedImageAltText
    );
  }, [
    canEditSelectedImageAltText,
    hasElectronBridge,
    isPaneFocused,
    isTrashed,
    paneId
  ]);

  useEffect(() => {
    if (!hasElectronBridge) {
      return;
    }

    return systemApi.onNativeMenuCommand((command) => {
      if (command !== 'edit-image-alt-text') {
        return;
      }

      if (paneId && !isPaneFocused) {
        return;
      }

      if (isTrashed) {
        return;
      }

      openSelectedImageAltTextEditor();
    });
  }, [
    hasElectronBridge,
    isPaneFocused,
    isTrashed,
    openSelectedImageAltTextEditor,
    paneId
  ]);

  // Only flush on real unload. Focus and visibility changes are noisy in a
  // desktop app because native pickers and Finder activation trigger them too.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleBeforeUnload = () => {
      void flushPendingSave().catch(() => {});
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushPendingSave]);

  const titleRefCallback = useCallback((el: HTMLDivElement | null) => {
    titleInputRef.current = el;
  }, []);

  // Sync title contentEditable with external title changes (agent rename, file watcher)
  useEffect(() => {
    const el = titleInputRef.current;
    if (!el || !note || mossMultiPane.bound) return; // moss-multi seam: the binding renders remote titles
    if (shouldPreserveDirtyEditor(note.id)) return;
    // Don't overwrite while user is actively editing the title
    if (isTitleFocusedRef.current || document.activeElement === el) return;
    const display = normalizeTitleDisplayValue(note.title);
    if (el.textContent !== display) {
      el.textContent = display;
    }
    if (titleValueRef.current !== display) {
      setTitleValueState(display); // moss-multi seam: title-display (T2.3): an unbound pane shows the title, never writes it
    }
  }, [note, note?.title, shouldPreserveDirtyEditor]);


  // =========================================================================
  // Agent streaming: skeleton lines + hydration cache invalidation.
  // Agent writes go to disk via SDK tools; the disk watcher picks them up.
  // =========================================================================
  useEffect(() => {
    if (!hasElectronBridge || !note?.id || mossMultiPane.bound /* moss-multi seam: bound-pane (A§2.2) */) return;

    const unsub = agentApi.onStream((event) => {
      if (event.type === 'editor_update') {
        clearPreloadedNoteRecord(event.noteId);
        if (event.noteId !== note.id) {
          return;
        }

        if (dirtyRef.current && dirtySourceRef.current === 'user') {
          diskChangedWhileDirtyRef.current[note.id] = true;
          return;
        }

        const applied = applyDiskUpdate(
          event.content,
          lastKnownDiskCommentMetadataRef.current[note.id],
          lastKnownDiskLayoutMetadataRef.current[note.id]
        );
        if (applied) {
          lastAgentReloadedAtRef.current[note.id] = true;
        }
        return;
      }

      if (event.type === 'complete' || event.type === 'error') {
        if (event.noteId === note.id) {
          clearAgentCanvasLoading();

          // Set echo guard SYNCHRONOUSLY so the init effect skips the
          // redundant IPC fetch when applyExecuteResult echoes updatedAt.
          // Must be set before the async IIFE below — otherwise the init
          // effect fires first and wipes in-memory agent messages.
          lastAgentReloadedAtRef.current[note.id] = true;

          // f0a: Force-reload from disk after agent completes on the active note.
          // The agent writes to disk via SDK tools. If the user typed during agent
          // execution, their edits win — skip the reload (disk watcher also respects dirtyRef).
          if (!dirtyRef.current || dirtySourceRef.current !== 'user') {
            clearPendingAutosaveTimer();
            clearDirtyState();
            const reloadUserRevision = localUserChangeRevisionRef.current;
            const reloadCommentDirtySignal = store.get(commentDirtySignalAtom(note.id));
            const reloadWasSupersededByLocalChanges = () =>
              localUserChangeRevisionRef.current !== reloadUserRevision
              || store.get(commentDirtySignalAtom(note.id)) !== reloadCommentDirtySignal;
            void (async () => {
              try {
                // Wait for any in-flight save to complete before reading disk.
                // A stale save could overwrite agent content between write and read.
                if (savePromiseRef.current) {
                  await savePromiseRef.current;
                }
                if (reloadWasSupersededByLocalChanges()) {
                  diskChangedWhileDirtyRef.current[note.id] = true;
                  return;
                }
                const fetchToken = Symbol('agent-force-reload-fetch');
                latestNoteContentFetchTokenRef.current = fetchToken;
                const result = await notesApi.getContent.invoke(note.id);
                if (latestNoteContentFetchTokenRef.current !== fetchToken) {
                  return;
                }
                if (!result) return;
                if (reloadWasSupersededByLocalChanges()) {
                  diskChangedWhileDirtyRef.current[note.id] = true;
                  return;
                }
                const diskContent = result.content ?? '';
                const diskCommentMetadata = result.commentMetadata ?? {};
                const diskCommentSignature = buildCommentMetadataSignature(diskCommentMetadata);
                const diskLayoutMetadata = result.layoutMetadata;
                const diskLayoutComparison = serializeNoteLayoutMetadataForComparison(diskLayoutMetadata);
                if (
                  diskContent === lastKnownDiskContentRef.current[note.id] &&
                  diskCommentSignature === (lastKnownDiskCommentSignatureRef.current[note.id] ?? '') &&
                  diskLayoutComparison === (lastKnownDiskLayoutComparisonRef.current[note.id] ?? '')
                ) {
                  return;
                }
                lastKnownDiskContentRef.current[note.id] = diskContent;
                lastKnownDiskCommentMetadataRef.current[note.id] = diskCommentMetadata;
                lastKnownDiskCommentSignatureRef.current[note.id] = diskCommentSignature;
                lastKnownDiskLayoutMetadataRef.current[note.id] = diskLayoutMetadata;
                lastKnownDiskLayoutComparisonRef.current[note.id] = diskLayoutComparison;
                applyDiskUpdate(diskContent, diskCommentMetadata, diskLayoutMetadata);
                // Set echo guard so init effect skips the redundant fetch
                // when applyExecuteResult echoes the updatedAt change.
                lastAgentReloadedAtRef.current[note.id] = true;
              } catch {
                // Non-critical: disk watcher will eventually pick up changes
              }
            })();
          }
        }
      }

      if (event.noteId !== note.id) {
        return;
      }

      if (
        (event.type === 'start' || event.type === 'tool_start') &&
        !store.get(uiAgentBusyNoteIdsAtom).has(event.noteId)
      ) {
        return;
      }

      // Show initial skeleton line on stream start, then grow by 1 every 2s
      if (event.type === 'start') {
        setSkeletonLines(1);
        if (skeletonIntervalRef.current) clearInterval(skeletonIntervalRef.current);
        skeletonIntervalRef.current = setInterval(() => {
          setSkeletonLines(prev => prev + 2);
        }, 1000);

        // Visual bell: only show when actions panel is collapsed
        if (isActionsPanelHidden) {
          setAgentVisualBell(true);
          if (agentVisualBellTimerRef.current) clearTimeout(agentVisualBellTimerRef.current);
          agentVisualBellTimerRef.current = setTimeout(() => setAgentVisualBell(false), 3000);
        }
        return;
      }

      if (event.type === 'tool_start') {
        if (event.toolName === 'Edit') {
          // Scroll to target
          const rootEl = editorInstanceRef.current?.getRootElement();
          const scrollEl = scrollContainerRef.current;
          if (rootEl && scrollEl && event.editTarget) {
            for (const child of rootEl.children) {
              if (child.textContent?.includes(event.editTarget)) {
                const cr = scrollEl.getBoundingClientRect();
                const ar = child.getBoundingClientRect();
                if (ar.top < cr.top || ar.bottom > cr.bottom) {
                  scrollEl.scrollTo({
                    top: scrollEl.scrollTop + ar.top - cr.top - cr.height / 3,
                    behavior: 'smooth',
                  });
                }
                break;
              }
            }
          }
        }
        // Add a skeleton line for each tool call
        setSkeletonLines(prev => prev + 1);
        return;
      }
    });

    return () => {
      unsub();
      clearAgentCanvasLoading();
      clearAgentVisualBell();
    };
  }, [applyDiskUpdate, clearAgentCanvasLoading, clearAgentVisualBell, clearPendingAutosaveTimer, hasElectronBridge, isActionsPanelHidden, note?.id, store]);

  const statusLabel = useMemo(() => {
    if (contentLoadError) {
      return contentLoadError;
    }

    if (saveError) {
      return saveError;
    }

    return '';
  }, [contentLoadError, saveError]);

  // Dirty tracking is handled exclusively by registerUpdateListener in
  // handleEditorReady (ignores the clean bootstrap update and only reacts to
  // real dirty element/leaf mutations).
  // This onChange callback is kept as a no-op because MarkdownEditor's
  // OnChangePlugin requires a function, but it intentionally does nothing
  // to avoid the false-dirty-on-mount path.
  const handleEditorChange = useCallback(
    (_editorState: EditorState, _tags: Set<string>) => {
      // no-op — see registerUpdateListener in handleEditorReady
    },
    []
  );

  const handleCopyMarkdown = useCallback(() => {
    const markdown = captureMarkdownForSave();
    navigator.clipboard.writeText(markdown).then(() => {
      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current);
        actionFeedbackTimeoutRef.current = null;
      }
      setActionFeedback({ type: 'success', message: 'Copied to clipboard' });
      actionFeedbackTimeoutRef.current = setTimeout(() => {
        setActionFeedback(null);
        actionFeedbackTimeoutRef.current = null;
      }, COPY_FEEDBACK_DURATION_MS);
    }).catch(() => {
      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current);
        actionFeedbackTimeoutRef.current = null;
      }
      setActionFeedback({ type: 'error', message: 'Failed to copy' });
      actionFeedbackTimeoutRef.current = setTimeout(() => {
        setActionFeedback(null);
        actionFeedbackTimeoutRef.current = null;
      }, COPY_FEEDBACK_DURATION_MS);
    });
  }, [captureMarkdownForSave]);

  const handleCopyNoteLink = useCallback(async () => {
    if (!note) return;
    const selectedHeadingText = editorInstanceRef.current
      ? getSelectedHeadingTextForCopy(editorInstanceRef.current)
      : null;
    await flushAndWait();

    const currentNote = store.get(noteEntityAtom(note.id)) ?? note;
    const noteTitle = currentNote.title || 'Untitled';
    let filesystemPath = currentNote.contentPath?.trim() || currentNote.externalFilePath?.trim();
    if (!selectedHeadingText && !filesystemPath && hasElectronBridge) {
      const resolved = await notesApi.getFilesystemPath.invoke(note.id);
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        filesystemPath = resolved.trim();
      }
    }
    const { payload, plainText } = buildCopyNoteLinkClipboardData({
      noteId: note.id,
      noteTitle,
      folderPath: currentNote.folderPath,
      filesystemPath,
      headingText: selectedHeadingText
    });
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
          'text/html': new Blob([buildMossNoteLinkClipboardHtml(payload)], { type: 'text/html' }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(plainText);
    }
    showActionFeedback({
      type: 'success',
      message: resolveNoteLinkCopiedMessage(payload.wikiLink)
    });
  }, [flushAndWait, hasElectronBridge, note, showActionFeedback, store]);

  const handleCopyForAgent = useCallback(async () => {
    if (!note) return;
    await flushAndWait();

    const currentNote = store.get(noteEntityAtom(note.id)) ?? note;
    const activeNoteTitle = currentNote.title || titleValue.trim() || 'Untitled';
    const shareSessionId = crypto.randomUUID();
    const wikiLink = `[[${activeNoteTitle}|${note.id}]]`;
    let filesystemPath = currentNote.contentPath?.trim() || currentNote.externalFilePath?.trim();
    if (!filesystemPath && hasElectronBridge) {
      const resolved = await notesApi.getFilesystemPath.invoke(note.id);
      if (typeof resolved === 'string' && resolved.trim().length > 0) {
        filesystemPath = resolved.trim();
      }
    }
    const notePath = filesystemPath?.replace(/^\/Users\/[^/]+/, '~') ?? `~/Moss/Notes/${activeNoteTitle}/${activeNoteTitle}.md`;
    const message = [
      '! Moss is shared memory between you and the user. It\u2019s a local markdown notes app where you both read and write.',
      '',
      '## Active note',
      `! The active note is \`${activeNoteTitle}\`.`,
      `! Edit the note at \`${notePath}\`.`,
      `! Reference the note as \`${wikiLink}\` when you need a Moss note link.`,
      '',
      '---',
      '',
      '## How notes work',
      'Notes live at `~/Moss/Notes/`. Each note is a folder with a markdown file named after the note title. To create a note, write `~/Moss/Notes/<Note Title>/<Note Title>.md`. Moss detects new directories automatically.',
      '',
      'Read `~/Moss/.moss/skills/writing-guidelines.md` and `notes.md` first for note quality, structure, and core syntax, then the focused modules (frontmatter, comments, links, formulas, canvas, html) in `~/Moss/.moss/skills/` as needed.',
      '',
      '---',
      '',
      '## Your workspace',
      'Create a workspace folder named after yourself for plans, research, and logs. Add subfolders however you see fit to stay organized.',
      '',
      'Save this to your `CLAUDE.md` or `AGENTS.md` so you remember across sessions.',
    ].join('\n');
    setAgentMessage(message);
    setShowCopyForAgentDialog(true);
    void window.electronAPI?.analytics?.capture('share_with_agent_opened', {
      surface: 'canvas_more_actions',
      share_session_id: shareSessionId,
    });
  }, [flushAndWait, hasElectronBridge, note, store, titleValue]);

  const buildPdfExportInput = useCallback(async (): Promise<ExportNotePdfInput | null> => {
    if (!note || !hasElectronBridge) {
      return null;
    }

    await flushAndWait();

    const serialized = markdownEditorRef.current?.serializeCurrent();
    const bodyCache = getEditorBodyMarkdown();

    return {
      title: titleValue.trim() || note.title || 'Untitled',
      markdown: serialized?.markdown ?? bodyCache?.markdownBody ?? captureMarkdownFromEditor(),
      renderedHtml: captureRenderedHtmlForPdf(),
      serializedEditorState: serialized?.serializedState ?? null,
      commentsMap: pruneCommentsWithoutAnchors(bodyCache),
      collapsedHeadingIdentities: store.get(noteCollapsedHeadingsAtom(note.id)),
      tabGroupActiveIndices: captureTabGroupActiveIndicesForPdf(),
    };
  }, [
    captureMarkdownFromEditor,
    captureRenderedHtmlForPdf,
    captureTabGroupActiveIndicesForPdf,
    flushAndWait,
    getEditorBodyMarkdown,
    hasElectronBridge,
    note,
    pruneCommentsWithoutAnchors,
    store,
    titleValue,
  ]);

  const createPdfExportSession = useCallback(async (): Promise<string | null> => {
    if (!note || !hasElectronBridge) {
      return null;
    }

    const input = await buildPdfExportInput();
    if (!input) {
      return null;
    }

    try {
      return await notesApi.createPdfExportSession.invoke(note.id, input);
    } catch {
      return null;
    }
  }, [buildPdfExportInput, hasElectronBridge, note]);

  const handleSaveAsPdf = useCallback(async () => {
    if (!note || !hasElectronBridge) {
      return;
    }

    try {
      setMoreActionsOpen(false);
      setIsExportingPdf(true);
      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current);
        actionFeedbackTimeoutRef.current = null;
      }
      setActionFeedback(null);
      await waitForPdfLoadingModalPaint();

      const sessionId = await createPdfExportSession();
      if (!sessionId) {
        throw new Error('Failed to prepare PDF export');
      }

      const previewWindowId = await notesApi.openPdfExportPreview.invoke(sessionId);
      if (previewWindowId === null) {
        throw new Error('Failed to open PDF preview');
      }

      showActionFeedback({
        type: 'success',
        message: 'Opened PDF preview'
      });
    } catch (error) {
      showActionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Save as PDF failed'
      });
    } finally {
      setIsExportingPdf(false);
    }
  }, [createPdfExportSession, hasElectronBridge, note, showActionFeedback]);

  const handleSaveAsMarkdown = useCallback(async () => {
    if (!note || !hasElectronBridge) {
      return;
    }

    try {
      setIsSavingMarkdown(true);
      if (actionFeedbackTimeoutRef.current) {
        clearTimeout(actionFeedbackTimeoutRef.current);
        actionFeedbackTimeoutRef.current = null;
      }
      setActionFeedback(null);

      const markdown = captureMarkdownForSave();
      const cleaned = stripMossSyntax(markdown);
      const result = await notesApi.exportMarkdown.invoke(note.id, {
        title: titleValue.trim() || note.title || 'Untitled',
        markdown: cleaned
      });

      if (result.canceled) {
        return;
      }

      showActionFeedback({
        type: 'success',
        message: 'Saved Markdown',
        action: result.filePath ? {
          label: 'Reveal in Finder',
          onClick: () => void shellApi.revealPath.invoke(result.filePath!)
        } : undefined
      });
    } catch (error) {
      showActionFeedback({
        type: 'error',
        message: error instanceof Error ? error.message : 'Save as Markdown failed'
      });
    } finally {
      setIsSavingMarkdown(false);
    }
  }, [captureMarkdownForSave, hasElectronBridge, note, showActionFeedback, titleValue]);

  useImperativeHandle(
    ref,
    () => ({
      flushAndWait,
      createPdfExportSession,
      selectTab,
      setHeadingCollapsed,
      focusTitle,
      focusBody: focusEditorStart,
      getMountedNoteId,
      expectStickyTabMetadataUpdate,
      getSelectedText,
      markSelectionAsContext,
      clearContextMark,
      openSelectedImageAltTextEditor,
      resolveCommentThread,
      unwrapComment,
      captureMarkdownForSave,
      scrollToHeading,
      forceReloadFromDisk,
    }),
    [
      flushAndWait,
      createPdfExportSession,
      selectTab,
      setHeadingCollapsed,
      focusTitle,
      focusEditorStart,
      getMountedNoteId,
      expectStickyTabMetadataUpdate,
      getSelectedText,
      markSelectionAsContext,
      clearContextMark,
      openSelectedImageAltTextEditor,
      resolveCommentThread,
      unwrapComment,
      captureMarkdownForSave,
      scrollToHeading,
      forceReloadFromDisk
    ]
  );

  const handleEditorReady = useCallback((editor: LexicalEditor) => {
    if (editorUpdateUnregisterRef.current) {
      editorUpdateUnregisterRef.current();
      editorUpdateUnregisterRef.current = null;
    }

    editorInstanceRef.current = editor;
    setEditorReadyForFocusNoteId(note?.id ?? null);

    let skippedBootstrapUpdate = false;
    editorUpdateUnregisterRef.current = editor.registerUpdateListener(
      ({ dirtyElements, dirtyLeaves, tags }) => {
        // moss-multi seam: bound-pane (A§2.2): the binding persists a bound note, so no dirty state and no autosave;
        // every update, local or a peer's, still clears the body cache that Copy markdown and Note stats read.
        if (mossMultiPane.bound) {
          bumpEditorContentRevision();
          return;
        }
        const hasDirtyMutations = dirtyElements.size > 0 || dirtyLeaves.size > 0;
        const hasContentUpdateTag = hasTrackedEditorUpdateTag(tags, DIRTY_TRACKER_CONTENT_TAGS);

        if (!skippedBootstrapUpdate) {
          skippedBootstrapUpdate = true;
          if (!hasDirtyMutations && !hasContentUpdateTag) {
            return;
          }
        }
        if (hasTrackedEditorUpdateTag(tags, DIRTY_TRACKER_IGNORED_TAGS)) {
          return;
        }
        if (isTrashed) {
          return;
        }
        if (hasDirtyMutations || hasContentUpdateTag) {
          markDirty(
            hasTrackedEditorUpdateTag(tags, DIRTY_TRACKER_DERIVED_TAGS) ? 'derived' : 'user'
          );
          bumpEditorContentRevision();
          scheduleDebouncedAutosave();
        }
      }
    );

    // After post-mount transforms (AutoArrow, FormatWhitespaceBoundary) settle,
    // sync lastEditorOutputRef and clear false dirty. Double rAF ensures all
    // Lexical reconciliation is complete before capturing the baseline.
    if (!mossMultiPane.bound) scheduleEditorSettlingBaselineCapture(note?.id); // moss-multi seam: bound-pane (A§2.2)

    // Restore scroll position if pending (from agent update)
    const pendingScrollTop = pendingScrollRestoreRef.current;
    if (pendingScrollTop !== null && scrollContainerRef.current) {
      pendingScrollRestoreRef.current = null;
      // Cancel any previous scroll restore to handle rapid updates
      if (scrollRestoreRafRef.current !== null) {
        cancelAnimationFrame(scrollRestoreRafRef.current);
      }
      // Use requestAnimationFrame to ensure content is painted before scrolling
      scrollRestoreRafRef.current = requestAnimationFrame(() => {
        scrollRestoreRafRef.current = null;
        scrollContainerRef.current?.scrollTo({ top: pendingScrollTop });
      });
    }

    // --- Editor command registrations (ArrowUp to title, scroll-to-cursor) ---
    if (editorCommandsUnregisterRef.current) {
      editorCommandsUnregisterRef.current();
      editorCommandsUnregisterRef.current = null;
    }

    // Guard: test mocks may not provide registerCommand
    if (typeof editor.registerCommand !== 'function') return;

    // ArrowUp from the start of the body focuses the title field.
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
        const anchor = selection.anchor;
        const root = $getRoot();
        if ($isPointAtRootStart(anchor.getNode(), anchor.offset, root)) {
          event?.preventDefault();
          titleInputRef.current?.focus();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    // Scroll-to-cursor: keep cursor visible above the floating toolbar.
    // Uses rAF coalescing to avoid layout thrash -- only one getBoundingClientRect
    // per frame, and only scrolls when the cursor is actually occluded.
    const TOOLBAR_CLEARANCE = 72 + 16; // toolbar height + buffer
    const unregisterSelectionChange = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        if (scrollCursorRafRef.current !== null) return false;
        scrollCursorRafRef.current = requestAnimationFrame(() => {
          scrollCursorRafRef.current = null;
          const scrollEl = scrollContainerRef.current;
          if (!scrollEl) return;
          const nativeSel = window.getSelection();
          if (!nativeSel || nativeSel.rangeCount === 0) return;
          const range = nativeSel.getRangeAt(0);
          const cursorRect = range.getBoundingClientRect();
          const containerRect = scrollEl.getBoundingClientRect();
          const maxVisibleBottom = containerRect.bottom - TOOLBAR_CLEARANCE;
          if (cursorRect.bottom > maxVisibleBottom) {
            scrollEl.scrollBy({ top: cursorRect.bottom - maxVisibleBottom, behavior: 'smooth' });
          }
        });
        return false;
      },
      COMMAND_PRIORITY_LOW
    );

    editorCommandsUnregisterRef.current = () => {
      unregisterArrowUp();
      unregisterSelectionChange();
      if (scrollCursorRafRef.current !== null) {
        cancelAnimationFrame(scrollCursorRafRef.current);
        scrollCursorRafRef.current = null;
      }
    };

  }, [bumpEditorContentRevision, isTrashed, markDirty, note?.id, scheduleDebouncedAutosave, scheduleEditorSettlingBaselineCapture]);

  const commitTitleChange = useCallback(() => {
    if (!note || isTrashed || mossMultiPane.bound) return; // moss-multi seam: no second title writer

    const nextTitleRaw = getLiveTitleText();
    if (titleValueRef.current !== nextTitleRaw) {
      setTitleValue(nextTitleRaw);
    }
    const nextTitle = nextTitleRaw.trim() || 'Untitled';
    const currentTitle = store.get(noteEntityAtom(note.id))?.title;
    if (nextTitle === currentTitle) return;
    const oldTitle = note.title;

    store.set(syncNoteEntityAtom, { noteId: note.id, updates: { title: nextTitle } });
    if (oldTitle !== nextTitle) {
      cleanupLinkResolutionCache(oldTitle);
    }
    markDirty('user');
    scheduleDebouncedAutosave();
  }, [getLiveTitleText, isTrashed, markDirty, note, scheduleDebouncedAutosave, store]);
  commitTitleChangeRef.current = commitTitleChange;

  const handleDeleteClick = useCallback(() => {
    if (!note || isTrashed) {
      return;
    }
    onDeleteNote?.(note.id);
  }, [isTrashed, note, onDeleteNote]);

  const handleRestoreClick = useCallback(() => {
    if (!note) {
      return;
    }
    onRestoreNote?.(note.id);
  }, [note, onRestoreNote]);

  const removeNoteEntity = useSetAtom(removeNoteEntityAtom);

  const handleCloseExternalNote = useCallback(async () => {
    if (!note) return;
    try {
      await externalNotesApi.close.invoke(note.id);
      removeNoteEntity(note.id);
    } catch (err) {
      console.warn('[CanvasArea] Failed to close external note:', err);
    }
  }, [note, removeNoteEntity]);

  const endProgrammaticWindowDrag = useCallback(() => {
    windowDragPointerIdRef.current = null;
    void systemApi.endWindowDrag.invoke();
  }, []);

  const handleCanvasDragStripPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    windowDragPointerIdRef.current = event.pointerId;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    void systemApi.startWindowDrag.invoke(event.screenX, event.screenY);
  }, []);

  const handleCanvasDragStripPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (windowDragPointerIdRef.current !== event.pointerId) {
      return;
    }
    void systemApi.moveWindowDrag.invoke(event.screenX, event.screenY);
  }, []);

  const handleCanvasDragStripPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (windowDragPointerIdRef.current !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    endProgrammaticWindowDrag();
  }, [endProgrammaticWindowDrag]);

  const handleCanvasDragStripPointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (windowDragPointerIdRef.current !== event.pointerId) {
      return;
    }
    endProgrammaticWindowDrag();
  }, [endProgrammaticWindowDrag]);

  const handleCanvasDragStripLostPointerCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (windowDragPointerIdRef.current !== event.pointerId) {
      return;
    }
    endProgrammaticWindowDrag();
  }, [endProgrammaticWindowDrag]);

  useEffect(() => {
    return () => {
      if (windowDragPointerIdRef.current !== null) {
        endProgrammaticWindowDrag();
      }
    };
  }, [endProgrammaticWindowDrag]);

  const canvasTopDragStrip = (
    <div
      className="app-region-drag absolute left-0 right-0 top-0 z-20 h-10 cursor-default select-none"
      onPointerDown={handleCanvasDragStripPointerDown}
      onPointerMove={handleCanvasDragStripPointerMove}
      onPointerUp={handleCanvasDragStripPointerUp}
      onPointerCancel={handleCanvasDragStripPointerCancel}
      onLostPointerCapture={handleCanvasDragStripLostPointerCapture}
      onClick={(event) => event.stopPropagation()}
      aria-hidden
    />
  );

  // moss-multi seam: bound-pane (A§2.2): a bound note never fills `content`, so its stats read the editor's body while
  // the dialog is open and keep that read through its close animation
  const boundStatsMarkdownRef = useRef('');
  if (mossMultiPane.bound && showNoteStats) boundStatsMarkdownRef.current = getEditorBodyMarkdown()?.markdownBody ?? '';
  const statsMarkdown = mossMultiPane.bound ? boundStatsMarkdownRef.current : content;
  // Note stats computed from body markdown content
  const noteStats = useMemo(() => {
    const text = statsMarkdown.replace(/```[\s\S]*?```/g, '').replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    const words = text.split(/\s+/).filter((w) => w.length > 0).length;
    const characters = statsMarkdown.length;
    const readingTime = Math.max(1, Math.ceil(words / 200));
    const images = (statsMarkdown.match(/!\[.*?\]\(.*?\)/g) ?? []).length;
    return { words, characters, readingTime, images };
  }, [statsMarkdown]);
  const hasBodyContent = mossMultiPane.bound ? mossMultiPane.hasBodyText : content.trim().length > 0; // moss-multi seam: bound-pane (A§2.2)

  const canvasMouseDownFocusedEditorRef = useRef(false);

  const getCanvasWhitespaceEditorRoot = useCallback((target: Node | null): HTMLElement | null => {
    const scrollContainer = scrollContainerRef.current;
    if (!target || !scrollContainer || !scrollContainer.contains(target)) {
      return null;
    }

    const editorRoot = editorInstanceRef.current?.getRootElement();
    const titleRoot = titleInputRef.current;
    const clickedInsideTitle = Boolean(titleRoot?.contains(target));
    const clickedInsideEditorContent = Boolean(editorRoot && editorRoot.contains(target) && target !== editorRoot);

    if (clickedInsideTitle || clickedInsideEditorContent) {
      return null;
    }

    return editorRoot ?? null;
  }, []);

  const handleCanvasAreaMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    canvasMouseDownFocusedEditorRef.current = false;
    if (event.button !== 0 || isTrashed) {
      return;
    }

    const editorRoot = getCanvasWhitespaceEditorRoot(event.target as Node | null);
    if (!editorRoot) {
      return;
    }

    if (hasActiveEditorTextSelection(editorRoot, window.getSelection())) {
      return;
    }

    const focusedEditor = hasBodyContent
      ? markdownEditorRef.current?.focusAtPoint(event.clientX, event.clientY) ?? false
      : focusEditorStart();
    if (focusedEditor) {
      canvasMouseDownFocusedEditorRef.current = true;
      event.preventDefault();
    }
  }, [focusEditorStart, getCanvasWhitespaceEditorRoot, hasBodyContent, isTrashed]);

  const handleCanvasAreaClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    onCanvasClick?.();

    const editorRoot = getCanvasWhitespaceEditorRoot(event.target as Node | null);
    if (!editorRoot) {
      return;
    }

    // A mouse drag-selection finalizes with a trailing click whose target can
    // resolve to the editor root (e.g. selecting across top-level blocks). Don't
    // collapse the selection the user just made — only a plain click on empty
    // canvas (collapsed selection) should deselect. Keyboard selections never
    // reach here, so their behavior is unchanged.
    if (hasActiveEditorTextSelection(editorRoot, window.getSelection())) {
      return;
    }

    if (canvasMouseDownFocusedEditorRef.current) {
      canvasMouseDownFocusedEditorRef.current = false;
      if (document.activeElement === editorRoot) {
        return;
      }
    }

    if (
      !isTrashed &&
      hasBodyContent &&
      markdownEditorRef.current?.focusAtPoint(event.clientX, event.clientY)
    ) {
      return;
    }

    if (!isTrashed && !hasBodyContent && focusEditorStart()) {
      return;
    }

    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement !== document.body) {
      activeElement.blur();
    }
    window.getSelection()?.removeAllRanges();
    editorInstanceRef.current?.update(() => {
      $setSelection(null);
    });
  }, [focusEditorStart, getCanvasWhitespaceEditorRoot, hasBodyContent, isTrashed, onCanvasClick]);

  // Early return when no note is selected.
  // IMPORTANT: This MUST be after ALL hooks to satisfy React Rules of Hooks.
  // Hooks must be called unconditionally in the same order every render.
  if (!note) {
    return (
      <div className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-canvas">
        {canvasTopDragStrip}
        {mossMultiPane.noticeBand /* moss-multi seam: input refusals before the first note opens */}
        <CanvasArea className="min-w-0 flex-1" fullWidth innerClassName="flex h-full items-center justify-center">
          <p className="text-sm text-ink-muted">Create a new note to get started</p>
        </CanvasArea>
      </div>
    );
  }

  // Static top bar: nav left, actions right — like Notion/Craft

  // moss-multi seam: phone-shell (T2.7): below 640 px an open search takes the whole row
  const offWhileSearching = showFocusedSearchBar ? 'max-sm:hidden' : undefined;
  const staticTopBar = (
      <TopNavBar
        tone={paneId ? (isPaneFocused ? 'focusedSplit' : 'inactiveSplit') : 'primary'}
        onClick={paneId && !isPaneFocused ? () => setFocusPane(paneId) : undefined}
        appRegion={paneId && !isPaneFocused ? 'no-drag' : 'drag'}
        data-top-bar="" // moss-multi seam: bound-pane (A§2.2): web chrome lives inside the top bar (A§19)
      >
      <div className="relative flex h-8 min-w-0 items-center justify-between">
      {/* Left: traffic light clearance + panel toggle + nav */}
      {isNotesPanelHidden && paneId !== 'right' && <div className="hidden w-[60px] shrink-0 sm:block" /* moss-multi seam: phone-shell (T2.7): no traffic lights to clear */ />}
      <div className={cn('flex shrink-0 items-center gap-1', offWhileSearching)} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {isNotesPanelHidden && paneId !== 'right' && onExpandNotesPanel ? (
          <>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onExpandNotesPanel}
                    className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none"
                    aria-label="Show notes panel"
                  >
                    <PanelLeft className="h-4 w-4 -translate-y-px" strokeWidth={1.5} aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <KeyboardShortcut keys={['⌘', '\\']} size="compact" />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="mx-1 h-5 w-px bg-border-subtle" />
          </>
        ) : null}
        {!hideNavButtons && (
          <div
            className="flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-surface-raised-control/50 px-0.5"
            data-note-nav-controls="true"
          >
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <TopNavIconButton
                    onClick={onGoBack}
                    disabled={!canGoBack}
                    tone="muted"
                    aria-label="Go back"
                  >
                    <ArrowLeft aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.md, 'shrink-0')} />
                  </TopNavIconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <KeyboardShortcut keys={['⌘', '⌥', '←']} size="compact" />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <TopNavIconButton
                    onClick={onGoForward}
                    disabled={!canGoForward}
                    tone="muted"
                    aria-label="Go forward"
                  >
                    <ArrowRight aria-hidden className={cn(TOP_NAV_ICON_SIZE_CLASSNAMES.md, 'shrink-0')} />
                  </TopNavIconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <KeyboardShortcut keys={['⌘', '⌥', '→']} size="compact" />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        )}
      </div>
        {!hideNavButtons && <div className={cn('w-3 shrink-0', offWhileSearching)} />}
        {paneId ? (
            <div
              className={cn(
                'group/tab flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-caption text-ink-faint transition-colors hover:bg-surface-note-hover/40 hover:text-ink-muted focus-visible:outline-none',
                isPaneFocused ? 'cursor-default' : 'cursor-pointer',
                offWhileSearching
              )}
              onClick={isPaneFocused ? undefined : () => setFocusPane(paneId)}
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              data-note-tab-title="true"
            >
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                <NoteBreadcrumb note={note} onNavigate={isNotesPanelHidden ? onExpandNotesPanel : undefined} />
                {(note.folderPath === 'Notes' || !note.folderPath) && (
                  <span
                    className={cn(
                      'min-w-0 flex-1 cursor-default truncate',
                      isPaneFocused ? 'text-ink-default' : 'text-ink-faint'
                    )}
                    title={note.title || 'Untitled'}
                  >
                    {note.title || 'Untitled'}
                  </span>
                )}
              </div>
              {onCloseSplit && (
                <button
                  type="button"
                  aria-label={paneId === 'left' ? 'Close left split tab' : 'Close right split tab'}
                  onClick={(e) => { e.stopPropagation(); onCloseSplit(paneId); }}
                  className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint opacity-0 transition-colors hover:bg-border-subtle/60 hover:text-ink-default group-hover/tab:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ) : (
            <div className={cn('flex min-w-0 items-center overflow-hidden', offWhileSearching)} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <NoteBreadcrumb note={note} onNavigate={isNotesPanelHidden ? onExpandNotesPanel : undefined} />
              {note.folderPath === 'Notes' && note.title !== 'Untitled' && (
                <span className="cursor-default truncate text-xs text-ink-faint opacity-50">{note.title}</span>
              )}
            </div>
          )}

      <div className={cn(paneId ? 'w-2 shrink-0' : 'flex-1', offWhileSearching)} />

      {/* Right: metadata toggle + find bar + copy + more + panel toggle */}
      {hideRightControls ? <div className="flex-1" /> : (
      <div className={cn('flex shrink-0 items-center gap-1.5', showFocusedSearchBar && 'max-sm:min-w-0 max-sm:flex-1')} style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className={cn('contents', offWhileSearching)}>{mossMultiPane.topBarCollab /* moss-multi seam: bound-pane (A§2.2): Share, connection, face pile, bell */}</div>
        {!showFocusedSearchBar && onOpenSearch ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenSearch}
                  className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none sm:flex" // moss-multi seam: phone-shell (T2.7): folds into More actions below 640 px
                  aria-label="Search in note"
                >
                  <Search aria-hidden className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <KeyboardShortcut keys={['⌘', 'F']} size="compact" />
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : null}
        {showFocusedSearchBar && onCloseSearch ? (
          <>
            <div className="min-w-56 max-w-xs max-sm:flex max-sm:min-w-0 max-sm:max-w-none max-sm:flex-1" /* moss-multi seam: phone-shell (T2.7) */>
              <NoteSearchInput onClose={onCloseSearch} autoFocus={searchBarAutoFocus} fullWidth={true} />
            </div>
            <div className="mx-0.5 hidden h-5 w-px bg-border-subtle sm:block" />
          </>
        ) : null}
        {!showFocusedSearchBar && <div className="mx-0.5 hidden h-5 w-px bg-border-subtle sm:block" /* moss-multi seam: phone-shell (T2.7) */ />}
        {/* Copy note link */}
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onMouseDown={preserveEditorSelectionOnMouseDown}
                onClick={() => { void handleCopyNoteLink(); }}
                className="hidden h-7 w-7 cursor-pointer items-center justify-center rounded-md text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none sm:flex" // moss-multi seam: phone-shell (T2.7): folds into More actions below 640 px
                aria-label="Copy note link"
              >
                <Link aria-hidden className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Copy note link</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <div className={cn('contents', offWhileSearching)} /* moss-multi seam: phone-shell (T2.7) */>
        {/* Comments */}
        {note?.id && (
          <CommentsMenuButton
            noteId={note.id}
            paneId={paneId}
            collisionBoundaryRef={scrollContainerRef}
          />
        )}
        {/* Share with Agent */}
        {/* moss-multi seam: hide-registry (A§9) */}
        {hidden('share-with-agent') ? null : (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => { void handleCopyForAgent(); }}
                className={cn(
                  'flex h-7 cursor-pointer items-center rounded-md transition-colors focus-visible:outline-none',
                  paneId
                    ? 'w-7 justify-center text-ink-faint hover:text-ink-muted hover:bg-surface-note-hover/40'
                    : 'gap-1.5 border border-surface-glass-border bg-surface-raised-control px-3 text-ink-faint shadow-none hover:bg-surface-raised-control-hover hover:text-ink-muted'
                )}
                aria-label="Share with Agent"
              >
                <Upload aria-hidden className="h-3.5 w-3.5" />
                {!paneId && <span className="text-xs">Share with Agent</span>}
              </button>
            </TooltipTrigger>
            {paneId && (
              <TooltipContent side="bottom">Share with Agent</TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
        )}
        {/* Overflow menu */}
        <DropdownMenu open={moreActionsOpen} onOpenChange={setMoreActionsOpen}>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none"
                    aria-label="More actions"
                  >
                    <EllipsisVertical aria-hidden className="h-4 w-4" />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              {!moreActionsOpen && !actionFeedback && (
                <TooltipContent side="bottom">
                  <p>More actions</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="min-w-0 w-max">
            {/* moss-multi seam: phone-shell (T2.7): below 640 px, search and copy link live here */}
            {!showFocusedSearchBar && onOpenSearch ? (
              <DropdownMenuItem className="gap-2 text-xs sm:hidden" onSelect={onOpenSearch}>
                <Search aria-hidden className="h-3.5 w-3.5" />
                Search in note
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="gap-2 text-xs sm:hidden" onSelect={() => { void handleCopyNoteLink(); }}>
              <Link aria-hidden className="h-3.5 w-3.5" />
              Copy note link
            </DropdownMenuItem>
            <DropdownMenuSeparator className="sm:hidden" />
            {/* Copy */}
            <DropdownMenuItem className="gap-2 text-xs" onSelect={handleCopyMarkdown}>
              <FileText aria-hidden className="h-3.5 w-3.5" />
              Copy markdown
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Export group */}
            <DropdownMenuItem
              className="gap-2 text-xs"
              onSelect={handleSaveAsPdf}
              disabled={isExportingPdf || !hasElectronBridge}
            >
              <FileDown aria-hidden className="h-3.5 w-3.5" />
              Save as PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2 text-xs"
              onSelect={handleSaveAsMarkdown}
              disabled={isSavingMarkdown || !hasElectronBridge}
            >
              <FileCode aria-hidden className="h-3.5 w-3.5" />
              {isSavingMarkdown ? 'Saving...' : 'Save as Markdown'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {/* Stats */}
            <DropdownMenuItem className="gap-2 text-xs" onSelect={() => { requestAnimationFrame(() => setShowNoteStats(true)); }}>
              <FileDigit aria-hidden className="h-3.5 w-3.5" />
              Note stats
            </DropdownMenuItem>
            {/* moss-multi seam: trash (T2.3): Trash and Restore note are the owner's (A§8) */}
            {!isExternal && !canTrashNote(note?.id ?? '') ? null : (<>
            <DropdownMenuSeparator />
            {/* Danger group */}
            <DropdownMenuItem
              className={cn('gap-2 text-xs', isExternal || isTrashed ? '' : 'text-accent-terracotta focus:text-accent-terracotta')}
              onSelect={isExternal ? handleCloseExternalNote : isTrashed ? handleRestoreClick : handleDeleteClick}
            >
              {isExternal ? (
                <><FileX aria-hidden className="h-3.5 w-3.5" />Close</>
              ) : isTrashed ? (
                <><RotateCcw aria-hidden className="h-3.5 w-3.5" />Restore note</>
              ) : (
                <><Trash2 aria-hidden className="h-3.5 w-3.5" />Trash</>
              )}
            </DropdownMenuItem>
            </>)}
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
        <CopyForAgentDialog
          open={showCopyForAgentDialog}
          onOpenChange={setShowCopyForAgentDialog}
          message={agentMessage}
        />
        <Dialog.Root open={isExportingPdf}>
          <Dialog.Portal>
            <DialogDimOverlay />
            <Dialog.Content
              data-remote-web-surface-blocking-dialog="true"
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              style={compactDialogPositionStyle}
              className="fixed left-1/2 top-1/2 z-dialog-content w-72 -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border-subtle/80 bg-surface-floating px-4 py-3.5 shadow-surface outline-none focus:outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
            >
              <div className="flex items-start gap-3">
                <Loader2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-accent-brand" />
                <div className="min-w-0">
                  <Dialog.Title className="text-sm font-medium text-ink-default">
                    Preparing PDF
                  </Dialog.Title>
                  <Dialog.Description className="mt-1 text-xs leading-5 text-ink-muted">
                    Generating the PDF from the current note.
                  </Dialog.Description>
                </div>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Dialog.Root open={showNoteStats} onOpenChange={setShowNoteStats}>
          <Dialog.Portal>
            <DialogDimOverlay />
            <Dialog.Content
              data-remote-web-surface-blocking-dialog="true"
              style={compactDialogPositionStyle}
              className="fixed left-1/2 top-1/2 z-dialog-content w-80 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border-subtle bg-surface-linen shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
            >
              <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-4">
                <Dialog.Title className="flex items-center gap-2 text-micro font-medium uppercase tracking-wider text-ink-faint">
                  <FileDigit aria-hidden className="h-3.5 w-3.5 text-ink-faint" />
                  Note stats
                </Dialog.Title>
                <Dialog.Close className="rounded-full p-1 text-ink-faint/60 transition-colors hover:bg-border-subtle hover:text-ink-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ink-default/15">
                  <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span className="sr-only">Close</span>
                </Dialog.Close>
              </div>
              <Dialog.Description className="sr-only">Statistics for the current note</Dialog.Description>
              <div className="grid grid-cols-2 gap-2 px-6 pb-6 pt-2 text-xs">
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2">
                  <span className="block text-micro font-medium uppercase tracking-wider text-ink-faint">Words</span>
                  <span className="mt-1 block font-mono text-xs font-normal text-ink-muted">{noteStats.words.toLocaleString()}</span>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2">
                  <span className="block text-micro font-medium uppercase tracking-wider text-ink-faint">Characters</span>
                  <span className="mt-1 block font-mono text-xs font-normal text-ink-muted">{noteStats.characters.toLocaleString()}</span>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2">
                  <span className="block text-micro font-medium uppercase tracking-wider text-ink-faint">Reading time</span>
                  <span className="mt-1 block font-mono text-xs font-normal text-ink-muted">{noteStats.readingTime} min</span>
                </div>
                <div className="rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2">
                  <span className="block text-micro font-medium uppercase tracking-wider text-ink-faint">Images</span>
                  <span className="mt-1 block font-mono text-xs font-normal text-ink-muted">{noteStats.images}</span>
                </div>
                {note.updatedAt ? (
                  <div className="col-span-2 rounded-lg border border-border-subtle bg-surface-raised-card px-3 py-2">
                    <span className="block text-micro font-medium uppercase tracking-wider text-ink-faint">Last edited</span>
                    <span className="mt-1 block font-mono text-xs font-normal text-ink-muted">{new Date(note.updatedAt * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                  </div>
                ) : null}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {canShowActionsPanelToggle ? (
          <>
            {/* moss-multi seam: phone-shell (T2.7): ActionsPanelWrapper renders only from md up, so neither does its toggle */}
            <div className="mx-0.5 hidden h-5 w-px bg-border-subtle md:block" />
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onExpandActionsPanel}
                    className="relative hidden h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded text-ink-faint transition-colors hover:text-ink-muted hover:bg-surface-note-hover/40 focus-visible:outline-none md:flex"
                    aria-label="Show actions panel"
                  >
                    <PanelRight className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    {agentBadgeState !== 'idle' && (
                      <span className={cn(
                        'absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full',
                        agentBadgeState === 'streaming' ? 'bg-accent-terracotta animate-pulse' : 'bg-chalk-green'
                      )} />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <KeyboardShortcut keys={['⌘', '⌥', '\\']} size="compact" />
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        ) : null}
      </div>
      )}
      </div>
      </TopNavBar>
  );

  // moss-multi seam: trash-copy (T2.3): a trash is restorable, never counted down
  const trashCountdownMessage = TRASH_COPY.trashedNote;
  const showContentSkeleton = skeletonLines > 0 && hasBodyContent;
  const showEmptySkeleton = skeletonLines > 0 && !hasBodyContent;
  const emptySkeletonLines = Math.max(3, Math.min(24, skeletonLines));
  const shouldMountEditor =
    contentHydratedForNoteId === noteIdForAtoms &&
    (!shouldDeferEditorMount || editorMountReadyForNoteId === noteIdForAtoms);
  const showTitlePlaceholderHint = titleValue.trim().length === 0 && !isTrashed;

  return (
    <div
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface-canvas"
      onMouseDown={handleCanvasAreaMouseDown}
      onClick={handleCanvasAreaClick}
      {...mossMultiPane.paneProps /* moss-multi seam: bound-pane (A§2.2): data-editor-pane, data-doc-id, data-doc-state (A§19) */}
    >
      {!hideTopBar && staticTopBar}
      {mossMultiPane.noticeBand /* moss-multi seam: connection notices in flow below the top bar */}
      <CanvasArea
        className="relative min-w-0 flex-1"
        responsiveLayout
        wideContent={isFocusMode}
        innerClassName="flex w-full flex-col gap-1"
        contentClassName={cn('mx-auto max-w-canvas-blocks', paneId ? 'pt-canvas-body-top-split' : undefined)}
        scrollContainerRef={scrollContainerRef}
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        {contentHydratedForNoteId !== noteIdForAtoms ? (
          <div className="agent-skeleton agent-skeleton--empty">
            {[80, 100, 60, 90, 45].map((width, i) => (
              <div
                key={`hydration-skeleton-${i}`}
                className="agent-skeleton-line agent-skeleton-line--empty"
                style={{ width: `${width}%` }}
              />
            ))}
          </div>
        ) : contentLoadError ? (
          <div className="rounded-md border border-status-error-border bg-status-error-surface p-4 text-sm text-status-error-text">
            {contentLoadError}
          </div>
        ) : (
          <div className={cn('relative', isAgentActive && 'agent-active')}>
              <div className="relative mx-auto w-full max-w-canvas-prose">
              {/* Contenteditable H1 title field */}
              <div
                ref={titleRefCallback}
                contentEditable={!isTrashed && mossMultiPane.titleLive /* moss-multi seam: bound-pane (A§2.2): closed until bound (R2) */}
                data-title-binding={mossMultiPane.titleBinding}
                aria-disabled={mossMultiPane.titleLive ? undefined : true}
                suppressContentEditableWarning
                role="textbox"
                aria-label="Note title"
                data-placeholder={currentPlaceholder.title}
                className={cn(
                  'mb-1 min-h-12 w-full text-left text-h1 font-semibold tracking-title text-ink-default outline-none',
                  !showTitlePlaceholderHint && 'empty:before:block empty:before:text-ink-faint/40 empty:before:content-[attr(data-placeholder)]',
                  isTrashed && 'cursor-default'
                )}
                onFocus={() => {
                  isTitleFocusedRef.current = true;
                  syncTitleEmojiTypeaheadFromSelection();
                }}
                onInput={(event) => {
                  const text = (event.target as HTMLDivElement).textContent ?? '';
                  setTitleValue(text);
                  syncTitleEmojiTypeaheadFromSelection();
                }}
                onBlur={() => {
                  isTitleFocusedRef.current = false;
                  closeTitleEmojiMenu();
                  void commitTitleChange();
                }}
                onKeyDown={(event) => {
                  if (handleTitleEmojiKeyDown(event)) {
                    return;
                  }

                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void commitTitleChange();
                    focusEditorStart();
                  }
                  if (event.key === 'Tab') {
                    event.preventDefault();
                    void commitTitleChange();
                    focusEditorStart();
                  }
                  if (event.key === 'ArrowDown') {
                    const container = titleInputRef.current;
                    if (container && isSelectionOnLastTitleLine(container, window.getSelection())) {
                      event.preventDefault();
                      focusEditorStart();
                    }
                  }
                }}
                onKeyUp={() => {
                  syncTitleEmojiTypeaheadFromSelection();
                }}
                onMouseUp={() => {
                  syncTitleEmojiTypeaheadFromSelection();
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const text = event.dataTransfer.getData('text/plain').replace(/\n/g, ' ');
                  if (!text) return;
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(text));
                    range.collapse(false);
                  }
                  syncTitleValueFromDom();
                  syncTitleEmojiTypeaheadFromSelection();
                }}
                onPaste={(event) => {
                  event.preventDefault();
                  const text = event.clipboardData.getData('text/plain').replace(/\n/g, ' ');
                  const sel = window.getSelection();
                  if (sel && sel.rangeCount > 0) {
                    const range = sel.getRangeAt(0);
                    range.deleteContents();
                    range.insertNode(document.createTextNode(text));
                    range.collapse(false);
                  }
                  syncTitleValueFromDom();
                  syncTitleEmojiTypeaheadFromSelection();
                }}
              />
              {showTitlePlaceholderHint ? (
                <div
                  className="pointer-events-none absolute left-0 top-0 flex min-h-12 max-w-full select-none items-center gap-3 text-h1 font-semibold tracking-title text-ink-faint/35"
                  aria-hidden
                >
                  <span className="min-w-0 truncate">{currentPlaceholder.title}</span>
                  {/* moss-multi seam: hide-registry (A§9) */}
                  {hidden('title-shortcut-label') ? null : (
                  <KeyboardShortcut
                    keys={['⌘', 'T']}
                    size="compact"
                    variant="placeholder"
                    className="shrink-0 opacity-60"
                  />
                  )}
                </div>
              ) : null}
              </div>
              {titleEmojiMenu}
              {showContentSkeleton ? (
                <div className="agent-skeleton agent-skeleton--content">
                  {Array.from({ length: skeletonLines }, (_, i) => (
                    <div key={`content-skeleton-${i}`} className="agent-skeleton-line" />
                  ))}
                </div>
              ) : null}
              {showEmptySkeleton ? (
                <div className="agent-skeleton agent-skeleton--empty">
                  {Array.from({ length: emptySkeletonLines }, (_, i) => (
                    <div
                      key={`empty-skeleton-${i}`}
                      className="agent-skeleton-line agent-skeleton-line--empty"
                      style={{ width: `${100 - (i % 3) * 10}%` }}
                    />
                  ))}
                </div>
              ) : null}
              {/* moss-multi seam: bound-pane (A§2.2): the editor mounts at once and binds behind the skeleton until first sync (A§10.3) */}
              {shouldMountEditor ? (
                <div className={mossMultiPane.bodyVisible ? 'contents' : 'hidden'}>
                <MarkdownEditor
                  ref={markdownEditorRef}
                  key={`${note.id}-${editorVersion}`}
                  noteId={note.id}
                  value={content}
                  layoutMetadata={lastKnownDiskLayoutMetadataRef.current[note.id]}
                  onChange={handleEditorChange}
                  readOnly={isTrashed || mossMultiPane.readOnly}
                  placeholder={isAgentActive && content === '' ? '' : currentPlaceholder.body}
                  onReady={handleEditorReady}
                  onNavigateToNote={onNavigateToNote}
                  isTrashed={isTrashed}
                  trashedAt={note?.trashedAt}
                  onActionClick={onActionClick}
                  onSelectedImageAltTextAvailabilityChange={setCanEditSelectedImageAltText}
                  paneId={paneId}
                  enableSearchPlugin={isPaneFocused}
                  editorMountVersion={editorVersion}
                  editorRemountReason={
                    editorRemountReasonRef.current[note.id]?.version === editorVersion
                      ? editorRemountReasonRef.current[note.id]?.reason
                      : null
                  }
                  collaboration={mossMultiPane.collaboration}
                />
                </div>
              ) : null}
              {shouldMountEditor && mossMultiPane.bodyVisible ? null : (
                <div className="agent-skeleton agent-skeleton--content pt-4">
                  {[100, 94, 88, 72, 96, 64].map((width, i) => (
                    <div
                      key={`editor-mount-skeleton-${i}`}
                      className="agent-skeleton-line"
                      style={{ width: `${width}%` }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </CanvasArea>
        {agentVisualBell && canShowActionsPanelToggle ? (
          <div
            className="pointer-events-none absolute bottom-[4.25rem] left-1/2 z-50 -translate-x-1/2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border-subtle bg-surface-raised-card px-4 py-2 shadow-sm backdrop-blur-sm">
              <ClaudeIcon className="h-4 w-4 text-accent-terracotta" />
              <span className="text-xs text-ink-muted">
                Working in{' '}
                <button
                  type="button"
                  onClick={() => { onExpandActionsPanel?.(); setAgentVisualBell(false); }}
                  className="font-medium text-ink-default hover:text-ink-muted"
                >
                  Actions Panel
                </button>
                {' \u2192'}
              </span>
            </div>
          </div>
        ) : null}
        {isTrashed && contentHydratedForNoteId === noteIdForAtoms && !contentLoadError ? (
          <div
            className="pointer-events-none absolute bottom-8 left-1/2 z-40 -translate-x-1/2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div data-retention-notice="" /* moss-multi seam: trash-copy (T2.3) */ className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border-subtle/50 bg-surface-raised-card px-4 py-2.5 shadow-floating backdrop-blur-sm">
              <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-accent-terracotta/80" />
              <span className="text-xs text-ink-muted">{trashCountdownMessage}</span>
            </div>
          </div>
        ) : null}
        {statusLabel ? (
          <div
            className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <p className="text-xs text-ink-faint">{statusLabel}</p>
          </div>
        ) : null}
        {actionFeedback ? (
          <div
            className={cn(
              'absolute left-1/2 -translate-x-1/2 z-50',
              actionFeedback.position === 'bottom' ? 'bottom-8' : 'top-14',
              actionFeedback.action ? 'pointer-events-auto' : 'pointer-events-none'
            )}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span
              className={[
                'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs',
                actionFeedback.type === 'error'
                  ? 'border border-status-error-border bg-status-error-surface text-status-error-text shadow-sm'
                  : 'border border-border-subtle bg-surface-raised-card text-ink-muted shadow-sm backdrop-blur-sm'
              ].join(' ')}
            >
              {actionFeedback.message}
              {actionFeedback.action ? (
                <button
                  type="button"
                  onClick={actionFeedback.action.onClick}
                  className="underline underline-offset-2 opacity-70 hover:opacity-100"
                >
                  {actionFeedback.action.label}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        {retryToast ? (
          <div
            className="pointer-events-none fixed top-8 left-1/2 z-50 -translate-x-1/2"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-status-error-border/50 bg-status-error-surface/95 px-4 py-2.5 shadow-floating backdrop-blur-sm">
              <AlertTriangle aria-hidden className="h-4 w-4 shrink-0 text-status-error-text/80" />
              <span className="text-xs text-status-error-text">{retryToast.message}</span>
            </div>
          </div>
        ) : null}
        <ImageLightbox scope={lightboxScope} anchorRef={scrollContainerRef} />
      </div>
  );
});

export default CanvasAreaContent;

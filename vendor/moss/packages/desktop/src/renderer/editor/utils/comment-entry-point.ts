// ported-from: packages/desktop/src/renderer/editor/utils/comment-entry-point.ts @ 762abb777
import type { NoteComment } from '@moss/shared/state/note-atoms';
import { collectCommentSubtreeIds } from '@moss/shared/state/note-atoms';
import { getCommentAuthorDisplay } from './comment-author-display';
import { stripCommentMentionMarkers } from './comment-mentions';
import {
  getReachableRootCommentIds,
  isCommentResolved,
  type CommentAnchorIdOptions,
  type CommentThreadStatusFilter
} from './comment-thread-count';

export const OPEN_COMMENT_THREAD_EVENT = 'moss:open-comment-thread';

export interface OpenCommentThreadEventDetail {
  noteId: string;
  commentId: string;
  paneId?: 'left' | 'right';
}

/**
 * Return path for OPEN_COMMENT_THREAD_EVENT: the thread popover announces
 * itself once mounted and positioned, carrying its own rect and identity.
 * Openers that need the popover's geometry wait for this rather than guessing
 * a frame count — the open is deferred whenever an anchor has to be revealed
 * out of a hidden tab or a collapsed heading first.
 */
export const COMMENT_THREAD_PLACED_EVENT = 'moss:comment-thread-placed';

export interface CommentThreadPlacedEventDetail {
  noteId: string;
  commentId: string;
  paneId?: 'left' | 'right';
  rect: PopoverEdges;
}

export interface PopoverEdges {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Two floating surfaces overlap when their rects intersect on both axes.
 * Strict comparisons mean touching edges do not count. A degenerate rect is
 * rejected up front: an unmounted or unpositioned popover reports 0×0, and
 * without this a zero-area rect sitting inside the other would read as an
 * overlap.
 */
export function commentPopoverRectsOverlap(list: PopoverEdges, thread: PopoverEdges): boolean {
  if (list.right <= list.left || list.bottom <= list.top) return false;
  if (thread.right <= thread.left || thread.bottom <= thread.top) return false;
  return (
    list.left < thread.right &&
    thread.left < list.right &&
    list.top < thread.bottom &&
    thread.top < list.bottom
  );
}

export interface CommentThreadListItem {
  id: string;
  rootId: string;
  authorLabel: string;
  authorTextClass: string;
  createdAt: number;
  resolved: boolean;
  text: string;
  snippet: string;
  totalComments: number;
  ariaLabel: string;
}

export function getCommentThreadCountForFilter({
  filter,
  openCount,
  resolvedCount
}: {
  filter: CommentThreadStatusFilter;
  openCount: number;
  resolvedCount: number;
}): number {
  if (filter === 'resolved') return resolvedCount;
  if (filter === 'all') return openCount + resolvedCount;
  return openCount;
}

export function getCommentMenuButtonState({
  filter,
  openCount,
  resolvedCount
}: {
  filter: CommentThreadStatusFilter;
  openCount: number;
  resolvedCount: number;
}): { visible: boolean; badgeCount: number | null } {
  const selectedCount = getCommentThreadCountForFilter({ filter, openCount, resolvedCount });
  return {
    visible: openCount + resolvedCount > 0,
    badgeCount: selectedCount > 0 ? selectedCount : null
  };
}

export function isCommentThreadFilterDisabled({
  filter,
  resolvedCount
}: {
  filter: CommentThreadStatusFilter;
  resolvedCount: number;
}): boolean {
  return filter === 'resolved' && resolvedCount === 0;
}

export function dispatchOpenCommentThread(detail: OpenCommentThreadEventDetail): void {
  window.dispatchEvent(new CustomEvent<OpenCommentThreadEventDetail>(OPEN_COMMENT_THREAD_EVENT, { detail }));
}

export function dispatchCommentThreadPlaced(detail: CommentThreadPlacedEventDetail): void {
  window.dispatchEvent(new CustomEvent<CommentThreadPlacedEventDetail>(COMMENT_THREAD_PLACED_EVENT, { detail }));
}

/**
 * Whether a scroll region should show its bottom fade: visible only when the
 * content overflows AND is not scrolled to the end. Mirrors the comment-thread
 * fade rule; extracted so it is testable without live layout.
 */
export function computeScrollFadeVisible(metrics: {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}): boolean {
  const overflowing = metrics.scrollHeight - metrics.clientHeight > 1;
  const atBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= 1;
  return overflowing && !atBottom;
}

export interface CommentSearchSegment {
  text: string;
  match: boolean;
}

/**
 * Split text into matched/unmatched segments for the comment-list search,
 * mirroring the note-list `highlightText` pattern (case-insensitive, literal).
 * Returns a single unmatched segment when there is no query.
 */
export function splitCommentSearchSegments(text: string, query: string): CommentSearchSegment[] {
  const trimmed = query.trim();
  if (!trimmed) return text ? [{ text, match: false }] : [];
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lower = trimmed.toLowerCase();
  return text
    .split(new RegExp(`(${escaped})`, 'gi'))
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, match: part.toLowerCase() === lower }));
}

/**
 * When the match sits far enough into a single-line snippet that CSS truncation
 * would hide it, re-window the snippet to start just before the match — same
 * orientation rule the note-list title uses so the highlight stays visible.
 */
export function windowCommentSnippetAroundMatch(snippet: string, query: string): string {
  const trimmed = query.trim();
  if (!trimmed || !snippet) return snippet;
  const matchIdx = snippet.toLowerCase().indexOf(trimmed.toLowerCase());
  if (matchIdx === -1 || matchIdx < 25) return snippet;
  return `...${snippet.slice(Math.max(0, matchIdx - 10))}`;
}

function normalizeSnippet(text: string): string {
  return stripCommentMentionMarkers(text).trim().replace(/\s+/g, ' ');
}

function includeThreadByFilter(comment: NoteComment, filter: CommentThreadStatusFilter): boolean {
  if (filter === 'all') return true;
  const resolved = isCommentResolved(comment);
  return filter === 'resolved' ? resolved : !resolved;
}

function getCommentSearchRank(item: CommentThreadListItem, query: string): number {
  if (!query) return 0;
  return `${item.authorLabel} ${item.snippet}`.toLowerCase().includes(query) ? 0 : 1;
}

function orderCommentThreadRows(
  commentsMap: Record<string, NoteComment>,
  rootId: string
): NoteComment[] {
  const root = commentsMap[rootId];
  if (!root) return [];
  const replies = collectCommentSubtreeIds(commentsMap, rootId)
    .filter((id) => id !== rootId)
    .map((id) => commentsMap[id])
    .filter((comment): comment is NoteComment => Boolean(comment))
    .sort((left, right) => left.createdAt - right.createdAt);
  return [root, ...replies];
}

export function getReachableRootCommentIdsInDocumentOrder(
  commentsMap: Record<string, NoteComment>,
  markdownBody: string,
  options?: Iterable<string> | CommentAnchorIdOptions
): string[] {
  return getReachableRootCommentIds(commentsMap, markdownBody, options);
}

export function buildCommentThreadListItems(
  commentsMap: Record<string, NoteComment>,
  markdownBody: string,
  options?: {
    filter?: CommentThreadStatusFilter;
    query?: string;
    extraAnchorIds?: Iterable<string>;
    anchorIdsOverride?: Iterable<string>;
  }
): CommentThreadListItem[] {
  const filter = options?.filter ?? 'open';
  const query = options?.query?.trim().toLowerCase() ?? '';

  const rows: Array<{ item: CommentThreadListItem; documentIndex: number }> = [];
  let documentIndex = 0;

  getReachableRootCommentIdsInDocumentOrder(commentsMap, markdownBody, {
    extraAnchorIds: options?.extraAnchorIds,
    anchorIdsOverride: options?.anchorIdsOverride
  })
    .forEach((rootId) => {
      const root = commentsMap[rootId];
      if (!root || !includeThreadByFilter(root, filter)) return;
      const threadRows = orderCommentThreadRows(commentsMap, rootId);
      const threadCommentCount = threadRows.length;
      const resolved = isCommentResolved(root);
      threadRows.forEach((comment, threadIndex) => {
        const author = getCommentAuthorDisplay(comment);
        const snippet = normalizeSnippet(comment.text);
        rows.push({
          item: {
            id: comment.id,
            rootId,
            authorLabel: author.label,
            authorTextClass: author.textClass,
            createdAt: comment.createdAt,
            resolved,
            text: comment.text,
            snippet,
            totalComments: threadCommentCount,
            ariaLabel: `${resolved ? 'Resolved' : 'Open'} ${threadIndex === 0 ? 'comment' : 'reply'} by ${author.label}: ${snippet || 'No text'}`
          },
          documentIndex
        });
        documentIndex += 1;
      });
    });

  return rows
    .sort((left, right) => {
      const rankDiff = getCommentSearchRank(left.item, query) - getCommentSearchRank(right.item, query);
      return rankDiff || left.documentIndex - right.documentIndex;
    })
    .map(({ item }) => item);
}

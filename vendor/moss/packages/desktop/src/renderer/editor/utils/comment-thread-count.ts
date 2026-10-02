// ported-from: packages/desktop/src/renderer/editor/utils/comment-thread-count.ts @ 762abb777
import type { CommentMetadataMap } from '../../../common/markdown-layers';
import {
  collectReachableCommentThreadIds,
  extractCommentAnchorIds
} from '../../../common/markdown-layers';

export type CommentThreadStatusFilter = 'open' | 'resolved' | 'all';
export type CountableComment = {
  text: string;
  createdAt: number;
  updatedAt: number;
  parentId?: string;
  resolvedAt?: number;
};
export type CountableCommentMap = Record<string, CountableComment>;
export type CommentAnchorIdOptions = {
  extraAnchorIds?: Iterable<string>;
  anchorIdsOverride?: Iterable<string>;
};

function isCommentAnchorIdOptions(value: unknown): value is CommentAnchorIdOptions {
  return Boolean(value)
    && typeof value === 'object'
    && !(Symbol.iterator in (value as object));
}

export function isCommentResolved(comment: { resolvedAt?: number } | null | undefined): boolean {
  return typeof comment?.resolvedAt === 'number' && Number.isFinite(comment.resolvedAt);
}

export function isCommentThreadResolved(
  commentsMap: CommentMetadataMap,
  rootId: string
): boolean {
  return isCommentResolved(commentsMap[rootId]);
}

function includeThreadByStatus(
  commentsMap: CommentMetadataMap,
  rootId: string,
  status: CommentThreadStatusFilter
): boolean {
  if (status === 'all') return true;
  const resolved = isCommentThreadResolved(commentsMap, rootId);
  return status === 'resolved' ? resolved : !resolved;
}

export function isCommentVisibleForStatus(
  commentsMap: CommentMetadataMap,
  commentId: string,
  status: CommentThreadStatusFilter
): boolean {
  let current = commentsMap[commentId];
  if (!current) return false;
  const seen = new Set<string>([commentId]);
  let rootId = commentId;

  while (current.parentId) {
    const parent = commentsMap[current.parentId];
    if (!parent || seen.has(current.parentId)) break;
    seen.add(current.parentId);
    rootId = current.parentId;
    current = parent;
  }

  return includeThreadByStatus(commentsMap, rootId, status);
}

export function getReachableRootCommentIds(
  commentsMap: CountableCommentMap,
  markdownBody: string,
  options?: Iterable<string> | CommentAnchorIdOptions
): string[] {
  const anchorOptions = isCommentAnchorIdOptions(options) ? options : { extraAnchorIds: options };
  const anchorIds = anchorOptions.anchorIdsOverride
    ? new Set<string>()
    : extractCommentAnchorIds(markdownBody);
  for (const id of anchorOptions.anchorIdsOverride ?? []) {
    if (id.length > 0) {
      anchorIds.add(id);
    }
  }
  for (const id of anchorOptions.extraAnchorIds ?? []) {
    if (id.length > 0) {
      anchorIds.add(id);
    }
  }
  const reachableIds = collectReachableCommentThreadIds(anchorIds, commentsMap);
  const result: string[] = [];
  const seen = new Set<string>();

  for (const id of anchorIds) {
    if (seen.has(id) || !reachableIds.has(id)) continue;
    const comment = commentsMap[id];
    if (!comment) continue;
    if (comment.parentId && commentsMap[comment.parentId]) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
}

export function countReachableRootCommentThreads(
  commentsMap: CountableCommentMap,
  markdownBody: string,
  options?: { status?: CommentThreadStatusFilter } & CommentAnchorIdOptions
): number {
  const status = options?.status ?? 'open';
  let count = 0;
  for (const id of getReachableRootCommentIds(commentsMap, markdownBody, options)) {
    const comment = commentsMap[id];
    if (!comment) continue;
    if (!comment.parentId || !commentsMap[comment.parentId]) {
      if (!includeThreadByStatus(commentsMap, id, status)) continue;
      count += 1;
    }
  }
  return count;
}

function buildChildrenByParent(commentsMap: CountableCommentMap): Map<string, string[]> {
  const childrenByParent = new Map<string, string[]>();
  for (const [id, comment] of Object.entries(commentsMap)) {
    if (!comment.parentId || comment.parentId === id) continue;
    const children = childrenByParent.get(comment.parentId);
    if (children) {
      children.push(id);
    } else {
      childrenByParent.set(comment.parentId, [id]);
    }
  }
  return childrenByParent;
}

function countCommentSubtree(
  commentsMap: CountableCommentMap,
  childrenByParent: Map<string, string[]>,
  rootId: string
): number {
  if (!commentsMap[rootId]) return 0;

  let count = 0;
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (!commentsMap[id]) continue;
    count += 1;
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!seen.has(childId)) queue.push(childId);
    }
  }

  return count;
}

export function countReachableCommentsInThreads(
  commentsMap: CountableCommentMap,
  markdownBody: string,
  options?: { status?: CommentThreadStatusFilter } & CommentAnchorIdOptions
): number {
  const status = options?.status ?? 'open';
  const childrenByParent = buildChildrenByParent(commentsMap);
  let count = 0;

  for (const id of getReachableRootCommentIds(commentsMap, markdownBody, options)) {
    const comment = commentsMap[id];
    if (!comment) continue;
    if (!includeThreadByStatus(commentsMap, id, status)) continue;
    count += countCommentSubtree(commentsMap, childrenByParent, id);
  }

  return count;
}

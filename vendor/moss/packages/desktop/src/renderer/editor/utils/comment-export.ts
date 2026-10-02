// ported-from: packages/desktop/src/renderer/editor/utils/comment-export.ts @ 762abb777
/**
 * Utilities for comment-aware markdown serialization.
 *
 * The COMMENT_MARKER_TRANSFORMER in MarkdownEditor.tsx handles injecting
 * modern inline markers (%%m:ID:start%% ... %%m:ID:end%%) around MarkNodes during export.
 * This module provides the helper to build the structured metadata payload.
 */
import { serializeCommentFooter, type CommentMetadataMap } from './comment-markdown';

// Re-export for legacy compatibility helpers and tests.
export { serializeCommentFooter, type CommentMetadataMap } from './comment-markdown';

/**
 * Builds a CommentMetadataMap from the current noteCommentsMapAtom value.
 */
export function buildCommentMetadata(
  commentsMap: Record<string, { text: string; createdAt: number; updatedAt: number; source?: 'user' | 'agent' | 'external'; parentId?: string; imageUrl?: string; imageUrls?: string[]; resolvedAt?: number; resolvedBy?: 'user' | 'agent' | 'external' }>
): CommentMetadataMap {
  const metadata: CommentMetadataMap = {};
  for (const [id, comment] of Object.entries(commentsMap)) {
    const urls = comment.imageUrls?.length
      ? comment.imageUrls
      : comment.imageUrl
        ? [comment.imageUrl]
        : undefined;
    metadata[id] = {
      text: comment.text,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      ...(comment.source ? { source: comment.source } : {}),
      ...(comment.parentId ? { parentId: comment.parentId } : {}),
      ...(urls ? { imageUrls: urls } : {}),
      ...(typeof comment.resolvedAt === 'number' ? { resolvedAt: comment.resolvedAt } : {}),
      ...(comment.resolvedBy ? { resolvedBy: comment.resolvedBy } : {})
    };
  }
  return metadata;
}

/**
 * Appends the legacy comment metadata footer to a markdown string.
 * Returns the original markdown if there are no comments.
 */
export function appendCommentFooter(
  markdown: string,
  commentsMap: Record<string, { text: string; createdAt: number; updatedAt: number; source?: 'user' | 'agent' | 'external'; imageUrl?: string; imageUrls?: string[] }>
): string {
  const metadata = buildCommentMetadata(commentsMap);
  const footer = serializeCommentFooter(metadata);
  return markdown + footer;
}

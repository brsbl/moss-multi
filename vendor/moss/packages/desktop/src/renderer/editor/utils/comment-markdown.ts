// ported-from: packages/desktop/src/renderer/editor/utils/comment-markdown.ts @ 762abb777
/**
 * Pure utility functions for comment markdown serialization.
 *
 * Legacy footer format (read-compat only):
 *   <!--moss:comments
 *   {"id":{"text":"...","createdAt":123,"updatedAt":123}}
 *   -->
 *
 * Inline marker formats:
 *   {%c:id%}annotated text{%/c%}
 *   %%m:id:start%%annotated text%%m:id:end%%
 */

export {
  LEGACY_COMMENT_CLOSE_MARKER,
  LEGACY_COMMENT_OPEN_MARKER,
  MODERN_COMMENT_CLOSE_MARKER,
  MODERN_COMMENT_OPEN_MARKER,
  buildCommentMetadataSignature,
  coerceCommentMetadataMap,
  containsCommentAnchors,
  detectCommentSyntax,
  extractCommentAnchorIds,
  hasLegacyCommentFooter,
  parseCommentFooter,
  parseCommentMetadataJson,
  parseStrictCommentMetadataJson,
  serializeCommentFooter,
  serializeCommentMetadata,
  stripCommentAnchors,
  type CommentSyntax,
  type CommentMetadata,
  type CommentMetadataMap,
  type ParsedCommentFooter
} from '../../../common/markdown-layers';

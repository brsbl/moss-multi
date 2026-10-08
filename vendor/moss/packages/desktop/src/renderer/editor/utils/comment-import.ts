// ported-from: packages/desktop/src/renderer/editor/utils/comment-import.ts @ 762abb777
/**
 * Lexical $ functions for importing comment markers from markdown.
 *
 * After $convertFromMarkdownString + $convertMossCustomCodeNodes, the editor
 * tree contains TextNodes with literal comment markers.
 * This module strips those markers and wraps the enclosed text with MarkNodes.
 */
import {
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type LexicalNode,
  type TextNode
} from 'lexical';
import { MarkNode } from '@lexical/mark';

import type { NoteComment } from '@moss/shared';
import type { CommentMetadataMap } from './comment-markdown';
import { $isCommentableDecorator, type CommentableNode } from './commentable-node';
// Single shared fence-walking implementation (skips fenced-code-block interiors).
// Imported lazily-used at call time, so the existing MarkdownEditor → comment-import
// import cycle is harmless (the binding is resolved before normalize* runs).
// moss-multi seam: converter-split (A§12; S-conv §2.3)
import { mapOutsideFencedCodeBlocksOnly } from '../markdown/normalize';
// moss-multi seam: linear-markers (A§12): the marker regexes below are scans, as pushed and imported text reaches them
import { commentMarkerIdList, replaceCommentWrappedImages, scanCommentMarkers, scanCommentWrappedAtxHeadings } from './comment-marker-scan';

// ---------------------------------------------------------------------------
// Hydration utility
// ---------------------------------------------------------------------------

// Color encodes source/purpose, not author rotation:
//   0 = yellow (user), 3 = green (agent), 4 = grey (external).
// Older sidecars may store legacy values (e.g. blue 1, orange 2) for user
// comments; those are reconciled away during hydration so the canonical
// source → color mapping always wins.
/** Canonical color index for user comments. */
export const USER_COMMENT_COLOR = 0;
/** Canonical color index for agent comments. */
export const AGENT_COMMENT_COLOR = 3;
/** Canonical color index for external-agent comments. */
export const EXTERNAL_COMMENT_COLOR = 4;

/**
 * Canonical color for a comment based on its source. The runtime palette is
 * fully source-driven now — author rotation slots no longer apply.
 */
export function colorForCommentSource(source: NoteComment['source']): number {
  if (source === 'agent') return AGENT_COMMENT_COLOR;
  if (source === 'external') return EXTERNAL_COMMENT_COLOR;
  return USER_COMMENT_COLOR;
}

/**
 * Converts a CommentMetadataMap (from the sidecar or legacy footer parser) into the
 * runtime Record<string, NoteComment> used by noteCommentsMapAtom.
 *
 * `storedColors` is accepted for backwards compatibility with old sidecars but
 * is intentionally ignored: source determines color, period. This guarantees
 * stale stored values (e.g. user comment with stored color 1, 2, or 4) hydrate
 * to the correct canonical color.
 */
export function hydrateComments(
  map: CommentMetadataMap,
  _storedColors?: Record<string, number>
): Record<string, NoteComment> {
  const result: Record<string, NoteComment> = {};
  const entries = Object.entries(map).sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [id, meta] of entries) {
    const source = meta.source;
    result[id] = {
      id,
      text: meta.text,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      ...(source ? { source } : {}),
      color: colorForCommentSource(source),
      ...(meta.parentId ? { parentId: meta.parentId } : {}),
      ...(meta.imageUrls?.length
        ? { imageUrls: meta.imageUrls, imageUrl: meta.imageUrls[0] }
        : meta.imageUrl
          ? { imageUrls: [meta.imageUrl], imageUrl: meta.imageUrl }
          : {}),
      ...(typeof meta.resolvedAt === 'number' ? { resolvedAt: meta.resolvedAt } : {}),
      ...(meta.resolvedBy ? { resolvedBy: meta.resolvedBy } : {}),
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Marker regex
// ---------------------------------------------------------------------------

// moss-multi seam: linear-markers (A§12): LEGACY_OPEN_MARKER /\{%c:\s*([A-Za-z0-9_,\-\s]+?)\s*%\}/g,
// LEGACY_CLOSE_MARKER /\{%\/c%\}/g, MODERN_OPEN_MARKER /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:start%%/g and
// MODERN_CLOSE_MARKER /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:end%%/g are scanCommentMarkers.
/**
 * Matches ATX heading lines where an inline comment marker wraps the whole
 * heading, e.g. `{%c:c1%}### Heading{%/c%}` or `%%m:c1:start%%### Heading%%m:c1:end%%`.
 */
// moss-multi seam: linear-markers (A§12): COMMENT_WRAPPED_ATX_HEADING_LINE
// /^([ \t]{0,3})((?:\{%c:\s*[A-Za-z0-9_,\-\s]+?\s*%\}|%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:start%%))(#{1,6})([ \t]+)(.*?)(?:((?:\{%\/c%\}|%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:end%%)))([ \t]*)$/gm
// is scanCommentWrappedAtxHeadings.

/**
 * Rewrites comment-wrapped ATX headings into `### ...` form so
 * markdown import still recognizes the line as a heading while preserving the
 * original comment coverage over the heading content.
 */
export function normalizeCommentWrappedAtxHeadings(markdown: string): string {
  // moss-multi seam: linear-markers (A§12): markdown.replace(COMMENT_WRAPPED_ATX_HEADING_LINE, (_line, indent, open,
  // hashes, spacing, content, close, trailing) => `${indent}${hashes}${spacing}${open}${content}${close}${trailing}`)
  return scanCommentWrappedAtxHeadings(markdown);
}

// moss-multi seam: linear-markers (A§12): COMMENT_OPEN_MARKER_SRC, COMMENT_CLOSE_MARKER_SRC and
// COMMENT_ANY_MARKER_SRC, the parts of COMMENT_WRAPPED_IMAGE below, are scanned by replaceCommentWrappedImages.
/**
 * A run of same-line characters that does NOT contain any comment marker. The
 * tempered token `(?!marker)[^\\n]` refuses to start a marker, so the lazy
 * prose groups in COMMENT_WRAPPED_IMAGE can never swallow a marker (a close
 * marker that should end the pair, an adjacent open marker for a different
 * comment, or the markers of a second commented image on the same line).
 */
// moss-multi seam: linear-markers (A§12): NON_MARKER_RUN = `(?:(?!${COMMENT_ANY_MARKER_SRC})[^\\n])*?`
/**
 * Markdown image — either standard `![alt](src)` or an Obsidian embed
 * `![[ref]]`. The standard `src` balances exactly one level of inner parens so
 * macOS screenshot paths like `dir/img (1).png` match, while the src stops at
 * the image's OWN closing paren. This prevents the src from swallowing trailing
 * text (`![a](p.png) caption (v2)`), a following close/open marker, or a second
 * image on the same line. The Obsidian alternative mirrors
 * OBSIDIAN_EMBED_TRANSFORMER.regExp. The src form
 * `\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)` balances exactly one nesting level:
 * the non-paren runs exclude BOTH parens, so the optional inner `(...)` is the
 * only nesting allowed and the quantifiers don't nest unboundedly (no ReDoS).
 */
// moss-multi seam: linear-markers (A§12): IMAGE_SRC =
// '(?:!\\[[^\\]\\n]*\\]\\([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*\\)|!\\[\\[[^\\]\\n]+\\]\\])'
/**
 * Matches an inline comment marker that wraps a markdown image. The image may
 * be the entire content (`%%m:c1:start%%![alt](src)%%m:c1:end%%`) or embedded
 * in surrounding prose (`%%m:c1:start%%hello ![alt](src) trailing%%m:c1:end%%`).
 *
 * The prose groups (pre/post) are `NON_MARKER_RUN`, so they exclude newlines AND
 * any comment marker — a pair never spans a line and never swallows another
 * comment's marker. The terminator is EITHER:
 *   - a real close marker (captured in group 5), or
 *   - a lookahead at the next open marker (group 5 empty), for the case where an
 *     open marker's coverage is truncated by a following different comment, e.g.
 *     `%%m:c1:start%%![a](1.png)%%m:c2:start%%text%%m:c2:end%%`.
 * The callback validates that, when a close marker is present, its id matches the
 * open marker's id; a mismatch is treated as a truncating terminator instead so
 * c1's coverage cannot leak onto c2's text.
 *
 * Captured groups: open marker, pre prose, image, post prose, close marker (may
 * be empty).
 */
// moss-multi seam: linear-markers (A§12): COMMENT_WRAPPED_IMAGE = new RegExp(
//   `(${COMMENT_OPEN_MARKER_SRC})(${NON_MARKER_RUN})(${IMAGE_SRC})(${NON_MARKER_RUN})` +
//     `(?:(${COMMENT_CLOSE_MARKER_SRC})|(?=${COMMENT_OPEN_MARKER_SRC}))`, 'g'), scanned by replaceCommentWrappedImages

/**
 * Extracts the comment id(s) from an open or close marker so prose split out of
 * a mixed marker pair can be re-wrapped under the same id. Falls back to the
 * raw marker if no id is found (legacy `{%/c%}` close markers carry no id).
 */
function markerIdList(open: string): string | null {
  // moss-multi seam: linear-markers (A§12): the ids of open.match(/%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:(?:start|end)%%/),
  // else of open.match(/\{%c:\s*([A-Za-z0-9_,\-\s]+?)\s*%\}/), each split on commas and trimmed
  return commentMarkerIdList(open);
}

/**
 * Rewrites the body of a single marker pair that contains an image into the
 * standalone-line block form Moss's own export produces, e.g.
 *
 *   %%m:c1:start%%![alt](src)%%m:c1:end%%
 *
 * becomes
 *
 *   %%m:c1:start%%
 *   ![alt](src)
 *   %%m:c1:end%%
 *
 * When the pair also wraps prose around the image
 * (`%%m:c1:start%%hello ![a](p.png) trailing%%m:c1:end%%`), the prose is split
 * into its own marker pair(s) with the same id and the image is given its own
 * block-form pair — mirroring what Moss's exporter emits (one marker pair per
 * node). On the marker-only lines the import recognizes the image (the
 * IMAGE_TRANSFORMER regExp is whole-line anchored) and `$processCommentMarkers`
 * scopes the surrounding markers to the image decorator node, preserving the
 * comment.
 */
function rewriteCommentWrappedImages(segment: string): string {
  return replaceCommentWrappedImages( // moss-multi seam: linear-markers (A§12): segment.replace(COMMENT_WRAPPED_IMAGE, ...)
    segment,
    (
      match,
      open: string,
      pre: string,
      image: string,
      post: string,
      // `close` is undefined when the pair was terminated by a lookahead at the
      // next open marker (truncated coverage) rather than a real close marker.
      close: string | undefined,
      offset: number,
      full: string
    ) => {
      const ids = markerIdList(open);

      // Determine whether the matched close marker actually closes THIS open
      // marker. If a real close marker was consumed but its id doesn't match the
      // open's id (e.g. `%%m:c1:start%%...%%m:c2:end%%`), treat the pair as
      // truncated — the open marker self-closes after the image, and the
      // mismatched close marker is left in place for the next pass to scope. This
      // prevents one comment's coverage from leaking onto another comment.
      const closeIds = close !== undefined ? markerIdList(close) : null;
      const closeMatches =
        close !== undefined && (closeIds === null || closeIds === ids);

      // When the matched close marker doesn't belong to this open marker, it must
      // NOT be consumed — re-emit it so it stays available in the output.
      const trailingClose = close !== undefined && !closeMatches ? close : '';

      // The marker pair we emit around the image. When closing for real, reuse
      // the captured open/close verbatim. When truncated, synthesize a close
      // marker with the open's own id so the image block is self-contained.
      let openMarker = open;
      let closeMarker: string;
      if (closeMatches) {
        closeMarker = close as string;
      } else if (ids !== null) {
        openMarker = `%%m:${ids}:start%%`;
        closeMarker = `%%m:${ids}:end%%`;
      } else {
        // No id recoverable and no matching close: leave verbatim to avoid
        // emitting an unbalanced marker. Bail out on this match.
        return match;
      }

      // When the marker is preceded by prose on the same line, break the block
      // out with a blank line so the split prose stays its own paragraph and the
      // result round-trips identically to Moss's blank-line-separated export.
      const before = full.slice(0, offset);
      const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n\n';
      // Same for trailing prose on the marker's line.
      const after = full.slice(offset + match.length);
      const trail =
        trailingClose.length > 0 || after.length === 0 || after.startsWith('\n')
          ? ''
          : '\n\n';

      // Re-wrap the prose surrounding the image under the same comment id so its
      // coverage is preserved as its own marker pair (matching the exporter's
      // one-pair-per-node shape). If the id can't be recovered, fall back to the
      // original markers verbatim.
      const wrapProse = (prose: string): string => {
        if (prose.trim().length === 0) return '';
        if (ids === null) return `${openMarker}${prose}${closeMarker}\n\n`;
        return `%%m:${ids}:start%%${prose}%%m:${ids}:end%%\n\n`;
      };

      const proseBefore = wrapProse(pre);
      const proseAfter = post.trim().length === 0 ? '' : `\n\n${wrapProse(post).replace(/\n\n$/, '')}`;

      return `${lead}${proseBefore}${openMarker}\n${image}\n${closeMarker}${proseAfter}${trailingClose}${trail}`;
    }
  );
}

/**
 * Rewrites inline comment-marker-wrapped images into standalone-line block form
 * before markdown import, skipping the interior of fenced code blocks so a
 * literal marker/image sequence inside a ``` fence is left byte-identical (line
 * count unchanged). Idempotent: block-form images (marker on its own line) no
 * longer match the single-line `COMMENT_WRAPPED_IMAGE` pattern, so re-running is
 * a no-op.
 */
export function normalizeCommentWrappedImages(markdown: string): string {
  // Apply per non-fenced segment to a fixpoint: one pass converts the first
  // image inside a marker pair to block form, so a single pair wrapping
  // multiple inline images needs a pass per remaining image. Each pass strictly
  // reduces the number of inline marker-wrapped images, so this converges; the
  // bound is a safety guard against any non-converging input.
  const rewriteToFixpoint = (segment: string): string => {
    let current = segment;
    for (let pass = 0; pass < 32; pass++) {
      const next = rewriteCommentWrappedImages(current);
      if (next === current) {
        break;
      }
      current = next;
    }
    return current;
  };
  return mapOutsideFencedCodeBlocksOnly(markdown, rewriteToFixpoint);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarkerMatch {
  type: 'open' | 'close';
  /** Index within the TextNode's text content */
  index: number;
  /** Length of the marker string */
  length: number;
  /** Comment IDs (only for 'open' type) */
  ids?: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Finds all marker matches within a single text string.
 * Returns them sorted by index (ascending).
 */
function findMarkers(text: string): MarkerMatch[] {
  // moss-multi seam: linear-markers (A§12): each of LEGACY_OPEN_MARKER, MODERN_OPEN_MARKER, LEGACY_CLOSE_MARKER and
  // MODERN_CLOSE_MARKER exec-looped from lastIndex 0, open ids split on commas, trimmed and non-empty, sorted by index
  return scanCommentMarkers(text);
}

type CommentableEntry =
  | { kind: 'text'; node: TextNode }
  | { kind: 'decorator'; node: LexicalNode & CommentableNode };

/**
 * Collects all TextNodes and CommentableNode decorators in depth-first order.
 */
function $collectCommentableNodes(root: LexicalNode): CommentableEntry[] {
  const result: CommentableEntry[] = [];
  const visit = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      result.push({ kind: 'text', node });
    } else if ($isCommentableDecorator(node)) {
      result.push({ kind: 'decorator', node });
    } else if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };
  visit(root);
  return result;
}

/**
 * Strips marker text from TextNodes and wraps enclosed ranges with MarkNodes.
 *
 * Algorithm:
 * 1. Collect all TextNodes
 * 2. For each TextNode, find markers in its text content
 * 3. Strip marker text by rebuilding the TextNode without markers
 * 4. Track active comment IDs via a stack
 * 5. After stripping, wrap text between open/close markers with MarkNodes
 *
 * We use a two-pass approach:
 * - Pass 1: Strip all markers from text, recording which comment IDs are
 *   active at each position boundary
 * - Pass 2: Use the recorded boundaries to wrap text with MarkNodes
 */
export function $processCommentMarkers(metadata: CommentMetadataMap): Set<string> {
  const root = $getRoot();
  const discoveredIds = new Set<string>();

  // Track the active comment ID stack across the entire document.
  const activeIds: string[] = [];
  // IDs opened on a marker-only line are scoped to the next decorator node.
  // This prevents malformed block wrappers from leaking comments into
  // subsequent content when a closing marker is missing.
  let pendingDecoratorScopeIds: string[] = [];

  // Segments represent pieces of text that need specific comment IDs.
  interface Segment {
    node: TextNode;
    offset: number;
    length: number;
    commentIds: string[];
  }

  const segments: Segment[] = [];

  const entries = $collectCommentableNodes(root);

  for (const entry of entries) {
    // Decorator nodes: stamp comment IDs directly
    if (entry.kind === 'decorator') {
      if (activeIds.length > 0) {
        const idsForNode = [...activeIds];
        entry.node.setCommentIds(idsForNode);
        for (const id of idsForNode) discoveredIds.add(id);

        if (pendingDecoratorScopeIds.length > 0) {
          for (const pendingId of pendingDecoratorScopeIds) {
            const index = activeIds.lastIndexOf(pendingId);
            if (index >= 0) {
              activeIds.splice(index, 1);
            }
          }
          pendingDecoratorScopeIds = [];
        }
      }
      continue;
    }

    const textNode = entry.node;
    const text = textNode.getTextContent();
    const markers = findMarkers(text);
    const hasVisibleText = text.trim().length > 0;

    if (markers.length === 0) {
      // No markers — if there are active IDs, this whole node needs wrapping
      if (activeIds.length > 0) {
        if (hasVisibleText) {
          pendingDecoratorScopeIds = [];
        }
        segments.push({
          node: textNode,
          offset: 0,
          length: text.length,
          commentIds: [...activeIds]
        });
      }
      continue;
    }

    // Build clean text (without markers) and track segments
    let cleanText = '';
    let cursor = 0;
    const nodeSegments: Array<{ start: number; end: number; commentIds: string[] }> = [];
    const openedIdsInThisNode: string[] = [];
    let sawCloseInThisNode = false;

    for (const marker of markers) {
      // Text before this marker
      if (marker.index > cursor) {
        const segStart = cleanText.length;
        const piece = text.slice(cursor, marker.index);
        cleanText += piece;
        const segEnd = cleanText.length;

        if (activeIds.length > 0) {
          nodeSegments.push({ start: segStart, end: segEnd, commentIds: [...activeIds] });
        }
      }

      // Process the marker
      if (marker.type === 'open' && marker.ids) {
        for (const id of marker.ids) {
          // Only process IDs that have corresponding metadata entries.
          // This filters out orphaned markers (deleted comments) and
          // user-typed marker-like syntax that isn't a real comment.
          if (metadata[id]) {
            activeIds.push(id);
            discoveredIds.add(id);
            openedIdsInThisNode.push(id);
          }
        }
      } else if (marker.type === 'close') {
        // {%/c%} closes all currently active IDs
        activeIds.length = 0;
        pendingDecoratorScopeIds = [];
        sawCloseInThisNode = true;
      }

      cursor = marker.index + marker.length;
    }

    // Text after the last marker
    if (cursor < text.length) {
      const segStart = cleanText.length;
      const piece = text.slice(cursor);
      cleanText += piece;
      const segEnd = cleanText.length;

      if (activeIds.length > 0) {
        nodeSegments.push({ start: segStart, end: segEnd, commentIds: [...activeIds] });
      }
    }

    const cleanHasVisibleText = cleanText.trim().length > 0;
    if (openedIdsInThisNode.length > 0 && !sawCloseInThisNode && !cleanHasVisibleText) {
      pendingDecoratorScopeIds = [...openedIdsInThisNode];
    } else if (cleanHasVisibleText || sawCloseInThisNode) {
      pendingDecoratorScopeIds = [];
    }

    // Update the TextNode content (strip markers)
    if (cleanText !== text) {
      if (cleanText.length === 0) {
        // Remove the text node and its parent paragraph if now empty
        const parent = textNode.getParent();
        textNode.remove();
        if (parent && $isParagraphNode(parent) && parent.getChildrenSize() === 0) {
          parent.remove();
        }
        continue;
      }
      textNode.setTextContent(cleanText);
    }

    // Record segments for pass 2
    for (const seg of nodeSegments) {
      segments.push({
        node: textNode,
        offset: seg.start,
        length: seg.end - seg.start,
        commentIds: seg.commentIds
      });
    }
  }

  // Pass 2: Wrap segments with MarkNodes.
  // Process in reverse to keep offsets valid.
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];

    if (!seg.node.isAttached()) continue;

    const currentText = seg.node.getTextContent();
    if (seg.offset >= currentText.length) continue;

    const effectiveLength = Math.min(seg.length, currentText.length - seg.offset);
    if (effectiveLength <= 0) continue;

    let targetNode: TextNode = seg.node;

    // Split off the part after our segment first (if needed)
    const afterEnd = seg.offset + effectiveLength;
    if (afterEnd < currentText.length) {
      targetNode.splitText(afterEnd);
    }

    // Split off the part before our segment (if needed)
    if (seg.offset > 0) {
      const [, rightNode] = targetNode.splitText(seg.offset);
      if (rightNode) {
        targetNode = rightNode;
      }
    }

    // Wrap targetNode with a MarkNode containing all comment IDs
    const markNode = new MarkNode(seg.commentIds);
    targetNode.insertBefore(markNode);
    markNode.append(targetNode);
  }

  return discoveredIds;
}

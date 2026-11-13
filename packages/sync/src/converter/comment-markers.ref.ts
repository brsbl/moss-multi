// Test-only copy of moss's code at 762abb777 (its comments trimmed): the comment-marker regexes of
// utils/comment-import.ts and the formatted-whitespace callback of markdown/format-whitespace.ts, the golden reference
// for the scans that replaced them.
import { $isCodeNode } from '@lexical/code-core';
import { $isRootOrShadowRoot, type TextNode } from 'lexical';
import { mapOutsideFencedCodeBlocksOnly } from '@moss-desktop/renderer/editor/markdown/normalize';

/** Matches opening marker: {%c:id%} or {%c:id1,id2%} (allows optional whitespace) */
const LEGACY_OPEN_MARKER = /\{%c:\s*([A-Za-z0-9_,\-\s]+?)\s*%\}/g;
/** Matches closing marker: {%/c%} */
const LEGACY_CLOSE_MARKER = /\{%\/c%\}/g;
/** Matches opening marker: %%m:id:start%% or %%m:id1,id2:start%% */
const MODERN_OPEN_MARKER = /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:start%%/g;
/** Matches closing marker: %%m:id:end%% or %%m:id1,id2:end%% */
const MODERN_CLOSE_MARKER = /%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:end%%/g;
/**
 * Matches ATX heading lines where an inline comment marker wraps the whole
 * heading, e.g. `{%c:c1%}### Heading{%/c%}` or `%%m:c1:start%%### Heading%%m:c1:end%%`.
 */
const COMMENT_WRAPPED_ATX_HEADING_LINE =
  /^([ \t]{0,3})((?:\{%c:\s*[A-Za-z0-9_,\-\s]+?\s*%\}|%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:start%%))(#{1,6})([ \t]+)(.*?)(?:((?:\{%\/c%\}|%%m:\s*[A-Za-z0-9_,\-\s]+?\s*:end%%)))([ \t]*)$/gm;

export function normalizeCommentWrappedAtxHeadings(markdown: string): string {
  return markdown.replace(
    COMMENT_WRAPPED_ATX_HEADING_LINE,
    (_line, indent: string, open: string, hashes: string, spacing: string, content: string, close: string, trailing: string) =>
      `${indent}${hashes}${spacing}${open}${content}${close}${trailing}`
  );
}

/** Opening marker (single capture group around the whole marker). */
const COMMENT_OPEN_MARKER_SRC =
  '(?:\\{%c:\\s*[A-Za-z0-9_,\\-\\s]+?\\s*%\\}|%%m:\\s*[A-Za-z0-9_,\\-\\s]+?\\s*:start%%)';
/** Closing marker (legacy {%/c%} or modern %%m:id:end%%). */
const COMMENT_CLOSE_MARKER_SRC =
  '(?:\\{%\\/c%\\}|%%m:\\s*[A-Za-z0-9_,\\-\\s]+?\\s*:end%%)';
/** Any comment marker (open OR close). Used to fence prose groups. */
const COMMENT_ANY_MARKER_SRC = `(?:${COMMENT_OPEN_MARKER_SRC}|${COMMENT_CLOSE_MARKER_SRC})`;
const NON_MARKER_RUN = `(?:(?!${COMMENT_ANY_MARKER_SRC})[^\\n])*?`;
const IMAGE_SRC =
  '(?:!\\[[^\\]\\n]*\\]\\([^()\\n]*(?:\\([^()\\n]*\\)[^()\\n]*)*\\)|!\\[\\[[^\\]\\n]+\\]\\])';
export const COMMENT_WRAPPED_IMAGE = new RegExp(
  `(${COMMENT_OPEN_MARKER_SRC})(${NON_MARKER_RUN})(${IMAGE_SRC})(${NON_MARKER_RUN})` +
    `(?:(${COMMENT_CLOSE_MARKER_SRC})|(?=${COMMENT_OPEN_MARKER_SRC}))`,
  'g'
);

export function markerIdList(open: string): string | null {
  const modern = open.match(/%%m:\s*([A-Za-z0-9_,\-\s]+?)\s*:(?:start|end)%%/);
  if (modern) return modern[1].split(',').map((id) => id.trim()).join(',');
  const legacy = open.match(/\{%c:\s*([A-Za-z0-9_,\-\s]+?)\s*%\}/);
  if (legacy) return legacy[1].split(',').map((id) => id.trim()).join(',');
  return null;
}

function rewriteCommentWrappedImages(segment: string): string {
  return segment.replace(
    COMMENT_WRAPPED_IMAGE,
    (
      match,
      open: string,
      pre: string,
      image: string,
      post: string,
      close: string | undefined,
      offset: number,
      full: string
    ) => {
      const ids = markerIdList(open);
      const closeIds = close !== undefined ? markerIdList(close) : null;
      const closeMatches =
        close !== undefined && (closeIds === null || closeIds === ids);
      const trailingClose = close !== undefined && !closeMatches ? close : '';
      let openMarker = open;
      let closeMarker: string;
      if (closeMatches) {
        closeMarker = close as string;
      } else if (ids !== null) {
        openMarker = `%%m:${ids}:start%%`;
        closeMarker = `%%m:${ids}:end%%`;
      } else {
        return match;
      }
      const before = full.slice(0, offset);
      const lead = before.length === 0 || before.endsWith('\n') ? '' : '\n\n';
      const after = full.slice(offset + match.length);
      const trail =
        trailingClose.length > 0 || after.length === 0 || after.startsWith('\n')
          ? ''
          : '\n\n';
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

export function normalizeCommentWrappedImages(markdown: string): string {
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

export interface MarkerMatch {
  type: 'open' | 'close';
  index: number;
  length: number;
  ids?: string[];
}

export function findMarkers(text: string): MarkerMatch[] {
  const matches: MarkerMatch[] = [];

  LEGACY_OPEN_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LEGACY_OPEN_MARKER.exec(text)) !== null) {
    matches.push({
      type: 'open',
      index: m.index,
      length: m[0].length,
      ids: m[1].split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    });
  }

  MODERN_OPEN_MARKER.lastIndex = 0;
  while ((m = MODERN_OPEN_MARKER.exec(text)) !== null) {
    matches.push({
      type: 'open',
      index: m.index,
      length: m[0].length,
      ids: m[1].split(',').map((id) => id.trim()).filter((id) => id.length > 0)
    });
  }

  LEGACY_CLOSE_MARKER.lastIndex = 0;
  while ((m = LEGACY_CLOSE_MARKER.exec(text)) !== null) {
    matches.push({
      type: 'close',
      index: m.index,
      length: m[0].length
    });
  }

  MODERN_CLOSE_MARKER.lastIndex = 0;
  while ((m = MODERN_CLOSE_MARKER.exec(text)) !== null) {
    matches.push({
      type: 'close',
      index: m.index,
      length: m[0].length
    });
  }

  matches.sort((a, b) => a.index - b.index);
  return matches;
}

const MARKDOWN_SHORTCUT_TRIGGER_RE =
  /^\s*(?:[-*+]|\d{1,}\.|#{1,6}|>|\[[ xX]?\]) $/;

export function $normalizeFormatWhitespace(node: TextNode): void {
  // Only formatted nodes need boundary enforcement
  if (node.getFormat() === 0) return;

  // Code content is literal — never strip whitespace
  if (node.hasFormat('code')) return;

  // Skip nodes inside fenced code blocks
  const parent = node.getParent();
  if (parent && $isCodeNode(parent)) return;

  const text = node.getTextContent();
  if (text.length === 0) return;

  // Entirely whitespace with formatting — just clear the format
  // Use [ \t] to avoid matching \u00A0 (Lexical uses it for cursor positioning)
  if (/^[ \t]+$/.test(text)) {
    node.setFormat(0);
    return;
  }

  if (
    MARKDOWN_SHORTCUT_TRIGGER_RE.test(text) &&
    parent !== null &&
    parent.getChildrenSize() === 1
  ) {
    const grandparent = parent.getParent();
    if (grandparent !== null && $isRootOrShadowRoot(grandparent)) {
      node.setFormat(0);
      return;
    }
  }

  const leadingMatch = text.match(/^[ \t]+/);
  const trailingMatch = text.match(/[ \t]+$/);

  if (!leadingMatch && !trailingMatch) return;

  const leadingEnd = leadingMatch ? leadingMatch[0].length : 0;
  const trailingStart = trailingMatch
    ? text.length - trailingMatch[0].length
    : text.length;

  const splitPoints: number[] = [];
  if (leadingEnd > 0) splitPoints.push(leadingEnd);
  if (trailingStart < text.length && trailingStart > leadingEnd) {
    splitPoints.push(trailingStart);
  }

  if (splitPoints.length === 0) return;

  const parts = node.splitText(...splitPoints);

  if (leadingEnd > 0 && parts[0]) {
    parts[0].setFormat(0);
  }
  if (trailingMatch && parts.length > 0) {
    parts[parts.length - 1].setFormat(0);
  }
}

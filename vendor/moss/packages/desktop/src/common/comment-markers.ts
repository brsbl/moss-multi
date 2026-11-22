// ported-from: packages/desktop/src/common/comment-markers.ts @ 762abb777
import { commentMarkerAt, type CommentMarkerAt, type CommentMarkerKind } from '../renderer/editor/utils/comment-marker-scan';

const COMMENT_ID_LIST_SOURCE = '[A-Za-z0-9_,\\-\\s]+?';

export const LEGACY_COMMENT_OPEN_MARKER_TOKEN_SOURCE =
  `\\{%c:\\s*(?:${COMMENT_ID_LIST_SOURCE})\\s*%\\}`;
export const LEGACY_COMMENT_OPEN_MARKER_SOURCE = `\\{%c:\\s*(${COMMENT_ID_LIST_SOURCE})\\s*%\\}`;
export const LEGACY_COMMENT_CLOSE_MARKER_SOURCE = '\\{%\\/c%\\}';
export const MODERN_COMMENT_BOUNDARY_MARKER_TOKEN_SOURCE =
  `%%m:\\s*(?:${COMMENT_ID_LIST_SOURCE})\\s*:(?:start|end)%%`;
export const MODERN_COMMENT_OPEN_MARKER_TOKEN_SOURCE =
  `%%m:\\s*(?:${COMMENT_ID_LIST_SOURCE})\\s*:start%%`;
export const MODERN_COMMENT_CLOSE_MARKER_TOKEN_SOURCE =
  `%%m:\\s*(?:${COMMENT_ID_LIST_SOURCE})\\s*:end%%`;
export const MODERN_COMMENT_BOUNDARY_MARKER_SOURCE =
  `%%m:\\s*(${COMMENT_ID_LIST_SOURCE})\\s*:(start|end)%%`;
export const MODERN_COMMENT_OPEN_MARKER_SOURCE =
  `%%m:\\s*(${COMMENT_ID_LIST_SOURCE})\\s*:start%%`;
export const MODERN_COMMENT_CLOSE_MARKER_SOURCE =
  `%%m:\\s*(${COMMENT_ID_LIST_SOURCE})\\s*:end%%`;
export const ANY_COMMENT_OPEN_MARKER_SOURCE =
  `(?:${LEGACY_COMMENT_OPEN_MARKER_TOKEN_SOURCE}|${MODERN_COMMENT_OPEN_MARKER_TOKEN_SOURCE})`;
export const ANY_COMMENT_CLOSE_MARKER_SOURCE =
  `(?:${LEGACY_COMMENT_CLOSE_MARKER_SOURCE}|${MODERN_COMMENT_CLOSE_MARKER_TOKEN_SOURCE})`;

const LEGACY_COMMENT_OPEN_MARKER_RE = new RegExp(LEGACY_COMMENT_OPEN_MARKER_SOURCE, 'g');
const MODERN_COMMENT_OPEN_MARKER_RE = new RegExp(MODERN_COMMENT_OPEN_MARKER_SOURCE, 'g');

export type CommentMarkerBoundary = 'start' | 'end';

// moss-multi seam: linear-markers (T9.48c): the marker regexes put three quantifiers over whitespace
// (`\s*[A-Za-z0-9_,\-\s]+?\s*`), so an opener followed by a run of blanks cost the cube of the run on every save. The
// functions a note's save, comment counts, paste and selection reach find the same markers with commentMarkerAt, whose
// id run ends at the first character outside the id class. Markers starting `{%` and `%%m:` never overlap, so one
// family's matches are those of moss's combined regexes.
export const commentMarkersOf = (
  text: string,
  prefix: '{%' | '%%m:',
  kinds: readonly CommentMarkerKind[]
): CommentMarkerAt[] => {
  const found: CommentMarkerAt[] = [];
  for (let at = text.indexOf(prefix); at >= 0; ) {
    const marker = commentMarkerAt(text, at);
    if (marker && kinds.includes(marker.kind)) {
      found.push(marker);
      at = text.indexOf(prefix, marker.end);
    } else {
      at = text.indexOf(prefix, at + 1);
    }
  }
  return found;
};

/** `text` without the given markers, which do not overlap. */
export const removeCommentMarkers = (text: string, markers: readonly CommentMarkerAt[]): string => {
  if (markers.length === 0) return text;
  let out = '';
  let last = 0;
  for (const marker of markers) {
    out += text.slice(last, marker.start);
    last = marker.end;
  }
  return out + text.slice(last);
};

export const parseCommentMarkerIds = (raw: string): string[] => {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',')) {
    const id = entry.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return ids;
};

export const serializeCommentBoundaryMarker = (
  ids: readonly string[],
  boundary: CommentMarkerBoundary
): string => {
  if (ids.length === 0) {
    return '';
  }
  return `%%m:${ids.join(',')}:${boundary}%%`;
};

export const migrateLegacyCommentMarkersToModern = (
  markdown: string
): { markdown: string; migrated: boolean } => {
  const activeStack: string[][] = [];
  let lastIndex = 0;
  let migrated = false;
  let output = '';

  for (const match of commentMarkersOf(markdown, '{%', ['legacy-open', 'legacy-close'])) {
    output += markdown.slice(lastIndex, match.start);
    const token = markdown.slice(match.start, match.end);

    if (match.ids !== undefined) {
      const ids = parseCommentMarkerIds(match.ids);
      if (ids.length === 0) {
        output += token;
      } else {
        activeStack.push(ids);
        output += serializeCommentBoundaryMarker(ids, 'start');
        migrated = true;
      }
    } else if (activeStack.length > 0) {
      const ids = activeStack.pop() ?? [];
      output += serializeCommentBoundaryMarker(ids, 'end');
      migrated = true;
    } else {
      output += token;
    }

    lastIndex = match.end;
  }

  if (!migrated) {
    return { markdown, migrated: false };
  }

  output += markdown.slice(lastIndex);
  return { markdown: output, migrated: true };
};

export const stripCommentMarkerTokens = (markdown: string): string =>
  removeCommentMarkers(
    markdown,
    [
      ...commentMarkersOf(markdown, '{%', ['legacy-open', 'legacy-close']),
      ...commentMarkersOf(markdown, '%%m:', ['open', 'close'])
    ].sort((a, b) => a.start - b.start)
  );

export const hasLegacyCommentMarkers = (markdown: string): boolean =>
  new RegExp(`${LEGACY_COMMENT_OPEN_MARKER_SOURCE}|${LEGACY_COMMENT_CLOSE_MARKER_SOURCE}`).test(
    markdown
  );

export const hasModernCommentMarkers = (markdown: string): boolean =>
  new RegExp(MODERN_COMMENT_BOUNDARY_MARKER_SOURCE).test(markdown);

export const findCommentMarkerIds = (markdown: string): Set<string> => {
  const ids = new Set<string>();

  LEGACY_COMMENT_OPEN_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LEGACY_COMMENT_OPEN_MARKER_RE.exec(markdown)) !== null) {
    for (const id of parseCommentMarkerIds(match[1])) {
      ids.add(id);
    }
  }

  MODERN_COMMENT_OPEN_MARKER_RE.lastIndex = 0;
  while ((match = MODERN_COMMENT_OPEN_MARKER_RE.exec(markdown)) !== null) {
    for (const id of parseCommentMarkerIds(match[1])) {
      ids.add(id);
    }
  }

  return ids;
};

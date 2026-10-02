// ported-from: packages/desktop/src/common/comment-markers.ts @ 762abb777
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
const ANY_COMMENT_MARKER_TOKEN_RE = new RegExp(
  `${LEGACY_COMMENT_OPEN_MARKER_SOURCE}|${LEGACY_COMMENT_CLOSE_MARKER_SOURCE}|${MODERN_COMMENT_BOUNDARY_MARKER_SOURCE}`,
  'g'
);

export type CommentMarkerBoundary = 'start' | 'end';

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
  const tokenRe = new RegExp(
    `${LEGACY_COMMENT_OPEN_MARKER_SOURCE}|${LEGACY_COMMENT_CLOSE_MARKER_SOURCE}`,
    'g'
  );
  const activeStack: string[][] = [];
  let lastIndex = 0;
  let migrated = false;
  let output = '';
  let match: RegExpExecArray | null;

  while ((match = tokenRe.exec(markdown)) !== null) {
    output += markdown.slice(lastIndex, match.index);

    if (match[1] !== undefined) {
      const ids = parseCommentMarkerIds(match[1]);
      if (ids.length === 0) {
        output += match[0];
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
      output += match[0];
    }

    lastIndex = match.index + match[0].length;
  }

  if (!migrated) {
    return { markdown, migrated: false };
  }

  output += markdown.slice(lastIndex);
  return { markdown: output, migrated: true };
};

export const stripCommentMarkerTokens = (markdown: string): string =>
  markdown.replace(ANY_COMMENT_MARKER_TOKEN_RE, '');

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

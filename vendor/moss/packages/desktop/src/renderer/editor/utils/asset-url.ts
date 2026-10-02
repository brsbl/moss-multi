// ported-from: packages/desktop/src/renderer/editor/utils/asset-url.ts @ 762abb777
/**
 * Shared asset URL utilities for converting between local file paths
 * and displayable moss-asset:// URLs in the Electron renderer.
 *
 * Used by ImageNode, VideoNode, and comment popovers.
 */

export const REMOTE_URL_PATTERN = /^https?:\/\//i;
const LOCAL_ASSET_INVISIBLE_RE = /[\u200B-\u200D\uFEFF]/g;
const LOCAL_ASSET_HTML_ENTITY_RE = /&(#\d+|#x[\da-fA-F]+|nbsp);/gi;
const LOCAL_ASSET_UNICODE_WHITESPACE_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

const decodeHtmlEntityInLocalAssetPath = (entityBody: string): string => {
  const normalizedEntityBody = entityBody.toLowerCase();
  if (normalizedEntityBody === 'nbsp') {
    return '\u00A0';
  }

  const parsedCodePoint = normalizedEntityBody.startsWith('#x')
    ? Number.parseInt(normalizedEntityBody.slice(2), 16)
    : normalizedEntityBody.startsWith('#')
      ? Number.parseInt(normalizedEntityBody.slice(1), 10)
      : Number.NaN;

  if (Number.isNaN(parsedCodePoint) || parsedCodePoint < 0 || parsedCodePoint > 0x10FFFF) {
    return `&${entityBody};`;
  }

  try {
    return String.fromCodePoint(parsedCodePoint);
  } catch {
    return `&${entityBody};`;
  }
};

export const normalizeLocalAssetPathForDisplay = (src: string): string =>
  src
    .replace(LOCAL_ASSET_INVISIBLE_RE, '')
    .replace(LOCAL_ASSET_HTML_ENTITY_RE, (_match, entityBody: string) =>
      decodeHtmlEntityInLocalAssetPath(entityBody)
    )
    .replace(LOCAL_ASSET_UNICODE_WHITESPACE_RE, ' ');

const normalizeMossAssetUrlForDisplay = (src: string): string => {
  const raw = src.slice('moss-asset://'.length);
  const queryIndex = raw.indexOf('?');
  const encodedPath = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  const query = queryIndex >= 0 ? raw.slice(queryIndex) : '';

  try {
    const normalizedPath = normalizeLocalAssetPathForDisplay(decodeURIComponent(encodedPath));
    return `moss-asset://${encodeURIComponent(normalizedPath)}${query}`;
  } catch {
    return src;
  }
};

const localPathFromFileUrl = (src: string): string | null => {
  try {
    const url = new URL(src);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) {
      return null;
    }
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
};

/**
 * Convert a file path to a displayable src URL.
 * - Local file paths get moss-asset:// protocol for Electron security
 * - URLs (http/https/data) pass through unchanged
 */
export function toDisplaySrc(src: string, noteId?: string | null): string {
  if (REMOTE_URL_PATTERN.test(src) || src.startsWith('data:')) {
    return src;
  }
  if (src.startsWith('moss-asset://')) {
    return normalizeMossAssetUrlForDisplay(src);
  }

  const filePath = /^file:/i.test(src) ? localPathFromFileUrl(src) : null;
  if (/^file:/i.test(src) && !filePath) {
    return src;
  }
  const normalizedSrc = normalizeLocalAssetPathForDisplay(filePath ?? src);
  const encodedPath = encodeURIComponent(normalizedSrc);
  if (noteId && !normalizedSrc.startsWith('/')) {
    return `moss-asset://${encodedPath}?noteId=${encodeURIComponent(noteId)}`;
  }

  return `moss-asset://${encodedPath}`;
}

/**
 * Recover the original relative path from a moss-asset:// URL.
 * Clipboard HTML from exportDOM() contains moss-asset:// URLs; when Lexical's
 * paste handler imports the DOM, we need to recover the clean relative path.
 *
 * When `currentNoteId` is provided and the URL is tagged with a DIFFERENT
 * note's id (a cross-note reference whose asset copy failed or was skipped),
 * the full URL is preserved instead: stripping it would produce a relative
 * path into the wrong note — a permanently broken embed. The full URL still
 * renders (toDisplaySrc passes moss-asset:// through) and resolves against
 * the source note.
 */
export function fromDisplaySrc(src: string, currentNoteId?: string | null): string {
  if (!src.startsWith('moss-asset://')) return src;
  const raw = src.slice('moss-asset://'.length);
  const queryIndex = raw.indexOf('?');
  if (queryIndex >= 0 && currentNoteId) {
    const params = new URLSearchParams(raw.slice(queryIndex + 1));
    const sourceNoteId = params.get('noteId')?.trim();
    if (sourceNoteId && sourceNoteId !== currentNoteId) {
      return src;
    }
  }
  const encodedPath = queryIndex >= 0 ? raw.slice(0, queryIndex) : raw;
  return normalizeLocalAssetPathForDisplay(decodeURIComponent(encodedPath));
}

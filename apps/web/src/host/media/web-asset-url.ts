// A note's uploaded media on the web (A§16): `assets/<file>` in moss's markdown loads from
// `/api/docs/<note>/assets/<file>`, the share link the page was opened with riding along. Only a single file under
// `assets/` is uploaded media; deeper paths (moss's `.moss-cache` previews) and video thumbnails are files moss
// desktop derives beside a note, which the web never has.

import { isDesktopDerived } from '@moss-multi/protocol/media';

export interface WebAsset {
  /** The URL as it appeared. */
  url: string;
  noteId: string;
  filename: string;
  /** moss's note-relative form, `assets/<file>`. */
  relativePath: string;
}

const UPLOADED = /^(?:\.\/)?assets\/([^/\\?#]+)$/;
const ROUTE = /^\/api\/docs\/([^/?#]+)\/assets\/([^/?#]+)(?:\?[^#]*)?$/;

/** The page's share link (A§8: the token rides every request for the doc). */
export const shareToken = (): string | null => {
  const search = (globalThis as { location?: { search?: string } }).location?.search ?? '';
  return new URLSearchParams(search).get('share');
};

/** The uploaded file a note-relative path names, or null when the web cannot have it. */
export function uploadedFilename(src: string): string | null {
  const name = UPLOADED.exec(src.trim())?.[1];
  return name && !isDesktopDerived(name) ? name : null;
}

const VERSION_PREVIEW = '#version-';

/** The editor id a version shown read-only in History renders under: distinct from the live note's, its media the note's. */
export const versionPreviewNoteId = (docId: string, versionId: string): string => `${docId}${VERSION_PREVIEW}${versionId}`;

/** The note whose files an editor id shows: a version preview's are its note's. */
const assetOwner = (noteId: string): string => {
  const at = noteId.indexOf(VERSION_PREVIEW);
  return at > 0 ? noteId.slice(0, at) : noteId;
};

/** The asset route for a note's uploaded file. */
export function webAssetUrl(noteId: string, filename: string): string {
  const share = shareToken();
  return `/api/docs/${encodeURIComponent(assetOwner(noteId))}/assets/${encodeURIComponent(filename)}${share ? `?share=${encodeURIComponent(share)}` : ''}`;
}

/** A same-origin asset route URL, absolute or root-relative, read back to its note and file. */
export function parseWebAssetUrl(url: string): WebAsset | null {
  let path = url;
  if (/^https?:\/\//i.test(url)) {
    const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
    try {
      const parsed = new URL(url);
      if (!origin || parsed.origin !== origin) return null;
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }
  const match = ROUTE.exec(path);
  if (!match) return null;
  try {
    const noteId = decodeURIComponent(match[1]);
    const filename = decodeURIComponent(match[2]);
    return { url, noteId, filename, relativePath: `assets/${filename}` };
  } catch {
    return null;
  }
}

/** Every distinct asset route URL in clipboard HTML, as moss finds `moss-asset://` URLs there. */
export function webAssetsInHtml(html: string): WebAsset[] {
  const found: WebAsset[] = [];
  const seen = new Set<string>();
  for (const [url] of html.matchAll(/(?:https?:\/\/[^\s"'<>/]+)?\/api\/docs\/[^\s"'<>/]+\/assets\/[^\s"'<>]+/gi)) {
    if (seen.has(url)) continue;
    const asset = parseWebAssetUrl(url);
    if (!asset) continue;
    seen.add(url);
    found.push(asset);
  }
  return found;
}

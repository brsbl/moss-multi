// Substituted for apps/web's host/media/web-asset-url.ts in the editor bundle (A§2.1). moss's paste plugin finds
// `moss-asset://` URLs in clipboard HTML itself and asks this module for the host's own media URLs; in an editor
// those are the URLs a mounted editor's host issued, recognised only by its `assets.parseUrl`. The plugin then copies
// each one into the destination note through `assets.copyFromNote`, as desktop does for `moss-asset://`.
import { hostAsset } from '@moss-editor/registry';
import { URL_IN_HTML } from './url-in-html';

export { shareToken, uploadedFilename, webAssetUrl } from '@moss-web-pristine/media/web-asset-url';

export interface WebAsset {
  /** The URL as it appeared. */
  url: string;
  noteId: string;
  filename: string;
  /** moss's note-relative form, `assets/<file>`. */
  relativePath: string;
}

/** Every distinct host-issued media URL in clipboard HTML, read back through the host's `parseUrl`. */
export function webAssetsInHtml(html: string): WebAsset[] {
  const found: WebAsset[] = [];
  const seen = new Set<string>();
  for (const [, url] of html.matchAll(URL_IN_HTML)) {
    if (seen.has(url) || url.startsWith('moss-asset://')) continue;
    seen.add(url);
    const asset = hostAsset(url) ?? (url.includes('&amp;') ? hostAsset(url.replace(/&amp;/g, '&')) : null);
    if (!asset) continue;
    found.push({ url, noteId: asset.noteId, filename: asset.ref.slice(asset.ref.lastIndexOf('/') + 1), relativePath: asset.ref });
  }
  return found;
}

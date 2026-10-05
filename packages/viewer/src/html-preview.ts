// HTML block previews before T3.8's sandboxed HTML: moss's view shows the screenshot moss desktop cached in the
// note's folder, named by moss's own hash (describeMossHtmlPreview, at the pin's cacheVersion), and asks
// htmlPreview.ensure when it fails to load. Here ensure reads what moss's ensure reads, the cache file and then the
// legacy asset, through the owning viewer's assetUrl; it never generates, copies or runs anything, so a block with
// no screenshot settles on moss's unavailable state.
import { describeMossHtmlPreview } from '@moss-desktop/common/moss-html-runtime';
import { NO_MEDIA, viewerAssetUrl, viewerFor } from './registry.ts';

export interface HtmlPreviewCandidate {
  relativePath: string;
  source: 'cache' | 'legacy-cache';
}

/** The places moss's ensure finds a block's screenshot, in its order. */
export function htmlPreviewCandidates(rawHtml: string): HtmlPreviewCandidate[] {
  const { relativePath, filename } = describeMossHtmlPreview(rawHtml);
  return [
    { relativePath, source: 'cache' },
    { relativePath: `assets/${filename}`, source: 'legacy-cache' },
  ];
}

/** Whether the page can load `url` as an image; false without a DOM. */
export function loadsAsImage(url: string): Promise<boolean> {
  if (typeof Image === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

/** moss's htmlPreview.ensure for a viewer's note: the first candidate whose assetUrl loads, else null. */
export async function ensureHtmlPreview(
  noteId: string,
  rawHtml: string,
  loads: (url: string) => Promise<boolean> = loadsAsImage,
): Promise<HtmlPreviewCandidate | null> {
  if (!viewerFor(noteId) || !rawHtml.trim()) return null;
  for (const candidate of htmlPreviewCandidates(rawHtml)) {
    const url = viewerAssetUrl(candidate.relativePath, noteId);
    if (url && url !== NO_MEDIA && (await loads(url))) return candidate;
  }
  return null;
}

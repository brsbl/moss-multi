// ported-from: packages/desktop/src/renderer/editor/utils/web-embed-classify.ts @ 762abb777
/**
 * Single source of truth for "is this URL an embeddable webpage?".
 *
 * A webpage embed (`WebEmbedNode` card / `EmbedPillNode` pill) is created from a
 * URL that is safe for the interactive browser surface AND is not better handled
 * by a more specific node type — image (`ImageNode`), YouTube/local video (`VideoNode`). Every
 * webpage-embed path must agree on this predicate, otherwise a URL accepted by
 * one path can reload as a different node type. The agreeing paths are the paste
 * plugin, the pill markdown round-trip (`EMBED_PILL_TRANSFORMER` in
 * `MarkdownEditor.tsx`), and the visual webpage-card branch of markdown image
 * syntax.
 *
 * Lives in the renderer (not `common/`) because it composes the renderer-side
 * image/video classifiers; `web-embed-url.ts` is imported read-only.
 */
import {
  isTwitterStatusUrl,
  normalizeWebBrowserUrl
} from '../../../common/web-embed-url';
import { isHttpsImageUrl } from './remote-image-url';
import { isLocalVideoPath, isYouTubeUrl } from './video-url';

// Re-export so every caller imports the taxonomy predicates from one classifier
// surface; tweet status URLs route to the Twitter/X tweet card, not a normal pill.
export { isTwitterStatusUrl } from '../../../common/web-embed-url';

const HAS_EXPLICIT_BROWSER_SCHEME_RE = /^\s*https?:\/\//i;

/**
 * True when a URL should become a NORMAL webpage embed (compact pill): a page
 * the interactive browser can open (public HTTPS or loopback browser HTTP(S))
 * that is not a tweet status URL, image, YouTube, or local video.
 * Tweet status URLs are excluded here so they route to the Twitter/X tweet card
 * exception instead of the generic pill; non-status x.com/twitter.com URLs (a
 * profile, search, etc.) stay normal embeddable pills. Shared by the pill
 * creation/import paths (paste plugin, `EMBED_PILL_TRANSFORMER`, visual
 * `![…](url)` webpage cards) so they all classify identically.
 * Preview metadata fetching still uses `isSafeWebEmbedUrl`, so localhost pills
 * can open in the in-app browser without being unfurled by the SSRF-guarded
 * preview fetcher.
 */
export function normalizeEmbeddableWebUrl(url: string): string | null {
  const normalized = normalizeWebBrowserUrl(url);
  if (!normalized) {
    return null;
  }
  const storageUrl = HAS_EXPLICIT_BROWSER_SCHEME_RE.test(url) ? url.trim() : normalized;
  return (
    !isTwitterStatusUrl(normalized) &&
    !isHttpsImageUrl(normalized) &&
    !isYouTubeUrl(normalized) &&
    !isLocalVideoPath(normalized)
  )
    ? storageUrl
    : null;
}

export function isEmbeddableWebUrl(url: string): boolean {
  return normalizeEmbeddableWebUrl(url) !== null;
}

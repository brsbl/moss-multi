// ported-from: packages/desktop/src/renderer/editor/nodes/web-embed/tweet-preview.ts @ 762abb777
/**
 * URL parsing for the tweet web-embed exception.
 *
 * A tweet status URL is the one webpage-embed exception that renders as a card
 * (`WebEmbedNode` → `TweetEmbedCard`) instead of a compact pill. The card loads
 * Twitter/X's OFFICIAL oEmbed iframe, so the only shaping it needs from the URL
 * is the `{handle, statusId}` pair: the status id selects the embed, and the
 * handle is the fallback label when the widget can't load. This module owns NO
 * fetching and NO classification — routing to the card is the
 * classifier/transformer owner's job, and metadata extraction is the oEmbed
 * worker's job.
 */

const TWEET_PATH_RE = /^\/([^/]+)\/status\/(\d+)/;

/** Pull `{handle, statusId}` from a `/{handle}/status/{id}` tweet URL path. */
export function parseTweetUrlParts(url: string): {
  handle: string | null;
  statusId: string | null;
} {
  try {
    const match = TWEET_PATH_RE.exec(new URL(url).pathname);
    if (!match) {
      return { handle: null, statusId: null };
    }
    return { handle: match[1], statusId: match[2] };
  } catch {
    return { handle: null, statusId: null };
  }
}

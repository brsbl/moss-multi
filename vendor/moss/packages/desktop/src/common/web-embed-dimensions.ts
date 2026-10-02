// ported-from: packages/desktop/src/common/web-embed-dimensions.ts @ 762abb777
/**
 * Named web-embed browser sizing.
 *
 * The interactive webpage lightbox is a browser surface, not a fixed-intrinsic
 * HTML preview, so it does NOT reuse the moss-html `1200 × 900` intrinsic size.
 * Instead it occupies a fraction of the *visible Moss canvas* (the
 * `.canvas-scroll` viewport, not the whole window), staying responsive and
 * inset rather than a dramatic fixed-size box. The result is still bounded by
 * the shared lightbox padding/chrome token so it can never exceed the framed
 * fullscreen area.
 */
import { MOSS_HTML_FULLSCREEN_PADDING } from './moss-html-dimensions';

/** The lightbox browser fills this fraction of the visible canvas on each axis. */
export const WEB_EMBED_LIGHTBOX_CANVAS_FRACTION = 0.75;

export interface WebEmbedLightboxSize {
  width: number;
  height: number;
}

/**
 * Resolve the browser lightbox size from the visible Moss canvas: 75% of the
 * canvas on each axis, clamped to the padding-inset canvas area so the frame
 * always sits within the shared lightbox chrome bounds.
 */
export function resolveWebEmbedLightboxSize({
  canvasWidth,
  canvasHeight
}: {
  canvasWidth: number;
  canvasHeight: number;
}): WebEmbedLightboxSize {
  const safeCanvasWidth = Number.isFinite(canvasWidth) && canvasWidth > 0 ? canvasWidth : 0;
  const safeCanvasHeight = Number.isFinite(canvasHeight) && canvasHeight > 0 ? canvasHeight : 0;

  // The framed content can never exceed the canvas minus the lightbox padding
  // on both edges — the same chrome token the shared fullscreen frame uses.
  const maxWidth = Math.max(1, safeCanvasWidth - MOSS_HTML_FULLSCREEN_PADDING * 2);
  const maxHeight = Math.max(1, safeCanvasHeight - MOSS_HTML_FULLSCREEN_PADDING * 2);

  const width = Math.min(
    maxWidth,
    Math.round(safeCanvasWidth * WEB_EMBED_LIGHTBOX_CANVAS_FRACTION)
  );
  const height = Math.min(
    maxHeight,
    Math.round(safeCanvasHeight * WEB_EMBED_LIGHTBOX_CANVAS_FRACTION)
  );

  return {
    width: Math.max(1, width),
    height: Math.max(1, height)
  };
}

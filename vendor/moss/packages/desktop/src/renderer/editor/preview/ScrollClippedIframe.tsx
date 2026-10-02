// ported-from: packages/desktop/src/renderer/editor/preview/ScrollClippedIframe.tsx @ 762abb777
/**
 * Renders a remote / sandboxed iframe whose vertical scrollbar is clipped out of
 * view, without making any of the page unreachable.
 *
 * Moss owns its same-origin `moss-html` preview content and hides scrollbars with
 * injected CSS, but a cross-origin webpage embed (or a sandboxed oEmbed preview)
 * can't be reached into the same way. Instead the iframe is oversized **on the
 * width axis only** inside an `overflow-hidden` box: it overflows the box on the
 * right by the platform scrollbar width, so the native vertical scrollbar gutter
 * falls outside the visible area. Crucially the iframe keeps `height: 100%` —
 * oversizing the height would push the bottom of the page below the clip and make
 * the last band of content/click targets unreachable. With width-only oversize
 * the page scrolls fully (wheel / trackpad / keyboard) and every row stays
 * reachable; only the vertical scrollbar chrome is hidden, matching the
 * `moss-html` "no visible scrollbar" surface.
 *
 * Both webpage embeds (live card + fullscreen) and the shared
 * `DerivedPreviewSurface` oEmbed tier render through this single component so the
 * clip behavior is defined in one place. Pass `model={null}` to render just the
 * clip box (e.g. while an off-screen preview waits to enter the viewport).
 */
import type { CSSProperties, JSX, Ref } from 'react';

import { IframeFrame } from '../iframe/IframeFrame';
import type { IframeModel } from '../iframe/iframe-model';

/** Px to oversize the width so the native vertical scrollbar lands outside the box. */
export const SCROLLBAR_CLIP_PX = 18;

/**
 * Inline size for an iframe rendered as a normal block child inside an
 * `overflow-hidden` box. Only the width overflows (by the scrollbar width), so
 * the vertical scrollbar is clipped while the height matches the box exactly —
 * nothing is pushed past the bottom clip, so the whole page stays scrollable and
 * reachable.
 */
export const SCROLLBAR_CLIP_IFRAME_STYLE: CSSProperties = {
  display: 'block',
  width: `calc(100% + ${SCROLLBAR_CLIP_PX}px)`,
  height: '100%'
};

export function ScrollClippedIframe({
  model,
  onLoad,
  className,
  wrapperRef,
  dataAttributes
}: {
  /** The iframe to render; `null` renders only the clip box (lazy/off-screen). */
  model: IframeModel | null;
  onLoad?: () => void;
  /** Positioning + sizing for the clip box (it must have a definite height). */
  className?: string;
  /** Ref to the clip box (e.g. an IntersectionObserver target). */
  wrapperRef?: Ref<HTMLDivElement>;
  dataAttributes?: Record<string, string>;
}): JSX.Element {
  return (
    <div
      ref={wrapperRef}
      className={`overflow-hidden ${className ?? ''}`.trimEnd()}
      {...dataAttributes}
    >
      {model ? (
        <IframeFrame
          model={model}
          onLoad={onLoad}
          className="border-0"
          style={SCROLLBAR_CLIP_IFRAME_STYLE}
        />
      ) : null}
    </div>
  );
}

export default ScrollClippedIframe;

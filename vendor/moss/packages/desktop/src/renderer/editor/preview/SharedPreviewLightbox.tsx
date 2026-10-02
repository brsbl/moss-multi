// ported-from: packages/desktop/src/renderer/editor/preview/SharedPreviewLightbox.tsx @ 762abb777
/**
 * Shared fullscreen lightbox for media-family preview cards.
 *
 * Owns the HTML-like fullscreen frame layout: the anchored `MediaLightbox`
 * portal (no built-in close button, unconstrained content), the rounded frame
 * sized in pixels with `MOSS_HTML_FULLSCREEN_PADDING` viewport bounds, and the
 * hover-revealed close control. The child (an `HtmlPreviewIframe`, a live
 * `IframeFrame`, or a fallback) and its resolved `frameSize` are passed in.
 *
 * `moss-html` and webpage embeds both render fullscreen through here so neither
 * owns a bespoke fullscreen layout or hard-coded `90vw` / `85vh` sizing.
 *
 * When a `header` is supplied (the webpage browser lightbox), it renders as a
 * persistent top bar above the content and the hover-revealed close control is
 * suppressed — the header owns its own close/controls. Without a header
 * (moss-html), the frame keeps its original content-fills-frame layout.
 */
import type { JSX, ReactNode, RefObject } from 'react';
import { X } from 'lucide-react';

import { MediaHeaderButton, MediaLightbox } from '../components/media-primitives';
import { MOSS_HTML_FULLSCREEN_PADDING } from '../../../common/moss-html-dimensions';

export interface SharedPreviewLightboxProps {
  open: boolean;
  onClose: () => void;
  /** Anchor element the lightbox positions over (the note-frame host). */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Resolved pixel size of the framed fullscreen content. */
  frameSize: { width: number; height: number };
  /** Data attributes for the frame (e.g. `data-web-embed-fullscreen`). */
  frameDataAttributes?: Record<string, string>;
  /** Optional persistent top header bar (e.g. URL/title + browser controls). */
  header?: ReactNode;
  children: ReactNode;
}

export function SharedPreviewLightbox({
  open,
  onClose,
  anchorRef,
  frameSize,
  frameDataAttributes,
  header,
  children
}: SharedPreviewLightboxProps): JSX.Element {
  return (
    <MediaLightbox
      open={open}
      onClose={onClose}
      constrainContent={false}
      showCloseButton={false}
      anchorRef={anchorRef}
    >
      <div
        className={`group/preview-lightbox relative flex overflow-hidden rounded-lg bg-ink-inverse shadow-xl${
          header ? ' flex-col' : ''
        }`}
        style={{
          width: `${frameSize.width}px`,
          height: `${frameSize.height}px`,
          maxWidth: `calc(100vw - ${MOSS_HTML_FULLSCREEN_PADDING * 2}px)`,
          maxHeight: `calc(100vh - ${MOSS_HTML_FULLSCREEN_PADDING * 2}px)`
        }}
        {...frameDataAttributes}
      >
        {header ? (
          header
        ) : (
          <div className="pointer-events-none absolute right-2 top-1.5 z-20 opacity-0 transition-opacity group-hover/preview-lightbox:pointer-events-auto group-hover/preview-lightbox:opacity-100 group-focus-within/preview-lightbox:pointer-events-auto group-focus-within/preview-lightbox:opacity-100">
            <MediaHeaderButton
              icon={X}
              title="Close lightbox"
              onClick={() => onClose()}
            />
          </div>
        )}
        {header ? (
          <div className="relative min-h-0 flex-1">{children}</div>
        ) : (
          children
        )}
      </div>
    </MediaLightbox>
  );
}

export default SharedPreviewLightbox;

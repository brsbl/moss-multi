// ported-from: packages/desktop/src/renderer/editor/iframe/IframeFrame.tsx @ 762abb777
/**
 * The single renderer component that writes `<iframe>` attributes. Every iframe
 * element in the editor (local HTML preview, YouTube playback, future webpage
 * embeds) renders through here so sandbox/referrer/loading/allow policy is
 * applied from one place.
 *
 * `srcDoc`-kind sources are rendered as `data:` URLs rather than the `srcDoc`
 * attribute: Electron's sandboxed renderer paints `srcDoc` iframes blank, while
 * a `data:` document keeps an opaque (cross-app) origin that still loads. This
 * preserves the existing `HtmlPreviewIframe` behavior exactly.
 */
import { forwardRef, useMemo } from 'react';
import type { CSSProperties, JSX } from 'react';

import type { IframeModel } from './iframe-model';

const toIframeDataUrl = (html: string): string =>
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

export interface IframeFrameProps {
  model: IframeModel;
  className?: string;
  style?: CSSProperties;
  width?: number | string;
  height?: number | string;
  scrolling?: 'yes' | 'no' | 'auto';
  onLoad?: () => void;
}

export const IframeFrame = forwardRef<HTMLIFrameElement, IframeFrameProps>(
  function IframeFrame(
    { model, className, style, width, height, scrolling, onLoad },
    ref
  ): JSX.Element {
    const sourceValue =
      model.source.kind === 'remote' ? model.source.src : model.source.srcDoc;
    const src = useMemo(
      () => (model.source.kind === 'remote' ? sourceValue : toIframeDataUrl(sourceValue)),
      [model.source.kind, sourceValue]
    );

    return (
      <iframe
        ref={ref}
        src={src}
        title={model.title}
        sandbox={model.sandbox}
        referrerPolicy={model.referrerPolicy}
        loading={model.loading}
        allow={model.allow}
        allowFullScreen={model.allowFullScreen}
        className={className}
        style={style}
        width={width}
        height={height}
        scrolling={scrolling}
        onLoad={onLoad}
      />
    );
  }
);

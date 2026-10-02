// ported-from: packages/desktop/src/renderer/editor/nodes/html/HtmlPreviewIframe.tsx @ 762abb777
import { useEffect, useMemo, useRef } from 'react';
import type { JSX } from 'react';

import { IframeFrame } from '../../iframe/IframeFrame';
import { createLocalHtmlPreviewIframeModel } from '../../iframe/iframe-model';

const DIMENSION_REPORT_MESSAGE_TYPE = 'moss-html-rendered-size';
const DIMENSION_REPORT_REQUEST_TYPE = 'moss-html-measure-request';

export type HtmlPreviewIframeMode = 'fit' | 'fit-scroll' | 'scroll';
export type HtmlPreviewRenderedSize = {
  width: number;
  height: number;
};

const coerceRenderedSize = (value: unknown): HtmlPreviewRenderedSize | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    type?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (candidate.type !== DIMENSION_REPORT_MESSAGE_TYPE) {
    return null;
  }

  const width = typeof candidate.width === 'number' ? Math.round(candidate.width) : 0;
  const height = typeof candidate.height === 'number' ? Math.round(candidate.height) : 0;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
};

/** Shared iframe renderer for fitted or scrollable moss-html previews. */
export function HtmlPreviewIframe({
  srcDoc,
  title,
  viewportWidth,
  viewportHeight,
  displayScale = 1,
  dimensionReportId,
  className,
  onLoad,
  onRenderedSize,
  mode = 'fit'
}: {
  srcDoc: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  displayScale?: number;
  dimensionReportId?: string;
  className?: string;
  onLoad?: () => void;
  onRenderedSize?: (size: HtmlPreviewRenderedSize) => void;
  mode?: HtmlPreviewIframeMode;
}): JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const scale = Math.max(0.001, displayScale);
  // The shared local-html-preview model owns sandbox policy and the data-URL
  // source trick (Electron's sandboxed renderer paints srcDoc iframes blank
  // unless the document keeps an opaque origin; IframeFrame renders srcDoc as a
  // data: URL to preserve that behavior).
  const iframeModel = useMemo(
    () => createLocalHtmlPreviewIframeModel({ srcDoc, title }),
    [srcDoc, title]
  );

  useEffect(() => {
    if (!dimensionReportId || !onRenderedSize) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (event.data?.reportId !== dimensionReportId) {
        return;
      }

      const size = coerceRenderedSize(event.data);
      if (size) {
        onRenderedSize(size);
      }
    };

    window.addEventListener('message', handleMessage);
    iframeRef.current?.contentWindow?.postMessage({
      type: DIMENSION_REPORT_REQUEST_TYPE,
      reportId: dimensionReportId
    }, '*');
    return () => window.removeEventListener('message', handleMessage);
  }, [dimensionReportId, onRenderedSize]);

  const handleLoad = () => {
    onLoad?.();
    if (dimensionReportId) {
      iframeRef.current?.contentWindow?.postMessage({
        type: DIMENSION_REPORT_REQUEST_TYPE,
        reportId: dimensionReportId
      }, '*');
    }
  };

  if (mode === 'scroll') {
    return (
      <div
        className={`moss-html-preview-scroll relative h-full w-full overflow-auto bg-ink-inverse ${className ?? ''}`}
      >
        <IframeFrame
          ref={iframeRef}
          model={iframeModel}
          width={viewportWidth}
          height={viewportHeight}
          onLoad={handleLoad}
          style={{
            border: 0,
            display: 'block'
          }}
        />
      </div>
    );
  }

  if (mode === 'fit-scroll') {
    const scaledWidth = Math.max(1, Math.round(viewportWidth * scale));
    const scaledHeight = Math.max(1, Math.round(viewportHeight * scale));

    return (
      <div
        className={`moss-html-preview-scroll relative h-full w-full overflow-auto bg-ink-inverse ${className ?? ''}`}
      >
        <div
          className="relative overflow-hidden bg-ink-inverse"
          style={{
            width: `${scaledWidth}px`,
            height: `${scaledHeight}px`
          }}
        >
          <IframeFrame
            ref={iframeRef}
            model={iframeModel}
            width={viewportWidth}
            height={viewportHeight}
            onLoad={handleLoad}
            style={{
              border: 0,
              display: 'block',
              transform: `scale(${scale})`,
              transformOrigin: '0 0'
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`relative w-full overflow-hidden bg-ink-inverse ${className ?? ''}`}
      style={{ aspectRatio: `${viewportWidth} / ${viewportHeight}` }}
    >
      <IframeFrame
        ref={iframeRef}
        model={iframeModel}
        width={viewportWidth}
        height={viewportHeight}
        onLoad={handleLoad}
        style={{
          border: 0,
          display: 'block',
          transform: `scale(${scale})`,
          transformOrigin: '0 0'
        }}
      />
    </div>
  );
}

// ported-from: packages/desktop/src/renderer/editor/nodes/html/htmlPreviewSizing.ts @ 762abb777
import {
  MOSS_HTML_FULLSCREEN_PADDING,
  resolveMossHtmlFullscreenDisplaySize,
  resolveMossHtmlIntrinsicSize,
  resolveMossHtmlNoteDisplaySize,
  type MossHtmlDisplaySize,
  type MossHtmlFullscreenDisplaySize,
  type MossHtmlIntrinsicSize
} from '../../../../common/moss-html-dimensions';
import type { HtmlPreviewIframeMode } from './HtmlPreviewIframe';

export interface HtmlPreviewPixelSize {
  width: number;
  height: number;
}

export interface HtmlPreviewSizing {
  htmlIntrinsicSize: MossHtmlIntrinsicSize;
  htmlDisplayIntrinsicSize: HtmlPreviewPixelSize;
  noteFrameSize: MossHtmlDisplaySize;
  noteIframeMode: HtmlPreviewIframeMode;
  fullscreenIntrinsicSize: HtmlPreviewPixelSize;
  fullscreenFrameSize: MossHtmlFullscreenDisplaySize;
}

export function resolveHtmlPreviewSizing({
  rawHtml,
  availableNoteWidth,
  viewportSize,
  previewImageIntrinsicSize,
  renderedContentSize
}: {
  rawHtml: string;
  availableNoteWidth: number | null;
  viewportSize: HtmlPreviewPixelSize;
  previewImageIntrinsicSize: HtmlPreviewPixelSize | null;
  renderedContentSize: HtmlPreviewPixelSize | null;
}): HtmlPreviewSizing {
  const htmlIntrinsicSize = resolveMossHtmlIntrinsicSize(rawHtml);
  const htmlDisplayIntrinsicSize = previewImageIntrinsicSize ?? htmlIntrinsicSize;
  const noteFrameSize = resolveMossHtmlNoteDisplaySize({
    availableWidth: availableNoteWidth,
    intrinsicSize: htmlDisplayIntrinsicSize
  });
  const scaledContentHeight = Math.round(
    htmlDisplayIntrinsicSize.height * noteFrameSize.scale
  );
  const noteIframeMode: HtmlPreviewIframeMode =
    noteFrameSize.height < scaledContentHeight ? 'fit-scroll' : 'fit';
  const fullscreenIntrinsicSize = renderedContentSize ?? htmlIntrinsicSize;
  const fullscreenFrameSize = resolveMossHtmlFullscreenDisplaySize({
    intrinsicSize: fullscreenIntrinsicSize,
    availableWidth: viewportSize.width - MOSS_HTML_FULLSCREEN_PADDING * 2,
    availableHeight: viewportSize.height - MOSS_HTML_FULLSCREEN_PADDING * 2
  });

  return {
    htmlIntrinsicSize,
    htmlDisplayIntrinsicSize,
    noteFrameSize,
    noteIframeMode,
    fullscreenIntrinsicSize,
    fullscreenFrameSize
  };
}

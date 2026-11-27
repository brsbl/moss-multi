// The export a save runs on the body (FrameSurface.snapshot, after CanvasAreaContent.tsx getEditorBodyMarkdown), which
// selection lines are counted in.
import { MARKDOWN_EDITOR_TRANSFORMERS, unescapeHtmlEntities } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { stripTableColumnWidthComments } from '@moss-desktop/renderer/editor/utils/markdown-export';
import { hasLegacyCommentFooter, parseCommentFooter } from '@moss-desktop/common/markdown-layers';
import { stripCommentMarkerTokens } from '@moss-desktop/common/comment-markers';
import type { MossExport } from '@moss-multi/host/selection.ts';

/** The body markdown moss saves for what its exporter wrote. */
export function finishBody(markdown: string): string {
  let body = unescapeHtmlEntities(markdown);
  if (hasLegacyCommentFooter(body)) body = parseCommentFooter(body).strippedContent;
  return stripTableColumnWidthComments(body);
}

export const MOSS_EXPORT: MossExport = {
  transformers: MARKDOWN_EDITOR_TRANSFORMERS,
  finish: finishBody,
  stripMarkers: stripCommentMarkerTokens,
};

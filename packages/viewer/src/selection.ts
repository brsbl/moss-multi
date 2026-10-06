// The export a save runs on a note body (CanvasAreaContent.tsx getEditorBodyMarkdown, 1967-2015 at the pin), which
// selection lines are counted in, and the line count of the loaded file before its body.
import { MARKDOWN_EDITOR_TRANSFORMERS, unescapeHtmlEntities } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { stripTableColumnWidthComments } from '@moss-desktop/renderer/editor/utils/markdown-export';
import { assembleNote, hasLegacyCommentFooter, parseCommentFooter } from '@moss-desktop/common/markdown-layers';
import { stripCommentMarkerTokens } from '@moss-desktop/common/comment-markers';
import { linesBeforeBody, type MossExport } from '@moss-multi/host/selection.ts';
import type { MossNoteContent } from './moss-file.ts';
import type { MossViewerOptions } from './types.ts';

export const MOSS_EXPORT: MossExport = {
  transformers: MARKDOWN_EDITOR_TRANSFORMERS,
  finish(markdown) {
    let body = unescapeHtmlEntities(markdown);
    if (hasLegacyCommentFooter(body)) body = parseCommentFooter(body).strippedContent;
    return stripTableColumnWidthComments(body);
  },
  stripMarkers: stripCommentMarkerTokens,
};

/** Lines before the body in the note file: the loaded markdown's own, or the file moss would write for `state`. */
export function linesBeforeLoadedBody(options: MossViewerOptions, note: MossNoteContent): number {
  if (typeof options.markdown === 'string') {
    const exact = linesBeforeBody(options.markdown, note.body);
    if (exact !== null) return exact;
    const at = note.body ? options.markdown.indexOf(note.body) : -1;
    return at < 0 ? 0 : options.markdown.slice(0, at).split('\n').length - 1;
  }
  return linesBeforeBody(assembleNote({ frontmatter: note.frontmatter, h1Title: note.title || null, body: '' }), '') ?? 0;
}

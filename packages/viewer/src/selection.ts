// The export a save runs on a note body (CanvasAreaContent.tsx getEditorBodyMarkdown, 1967-2015 at the pin), which
// selection lines are counted in, and the line count of the loaded file before its body.
import { MARKDOWN_EDITOR_TRANSFORMERS, unescapeHtmlEntities } from '@moss-desktop/renderer/editor/MarkdownEditor';
import { stripTableColumnWidthComments } from '@moss-desktop/renderer/editor/utils/markdown-export';
import { assembleNote, hasLegacyCommentFooter, parseCommentFooter } from '@moss-desktop/common/markdown-layers';
import { stripCommentMarkerTokens } from '@moss-desktop/common/comment-markers';
import { alignedLines, linesBeforeBody, offsetLines, type MossExport, type PlaceLine } from '@moss-multi/host/selection.ts';
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

/**
 * Lines of the exported body in the note file: the loaded markdown's own (which may hold block comment markers the
 * export drops), or the file moss would write for `state`.
 */
export function placeLoadedLines(options: MossViewerOptions, note: MossNoteContent): (body: string) => PlaceLine {
  if (typeof options.markdown === 'string') {
    const file = options.markdown;
    const exact = linesBeforeBody(file, note.body);
    const at = note.body ? file.indexOf(note.body) : -1;
    const before = exact ?? (at < 0 ? 0 : file.slice(0, at).split('\n').length - 1);
    const loaded = file.split('\n').slice(before).join('\n');
    return (body) => (body === loaded ? offsetLines(before) : alignedLines(body, loaded, before, stripCommentMarkerTokens));
  }
  const before = linesBeforeBody(assembleNote({ frontmatter: note.frontmatter, h1Title: note.title || null, body: '' }), '') ?? 0;
  return () => offsetLines(before);
}

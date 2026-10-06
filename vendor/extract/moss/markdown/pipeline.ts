import { $assignRegisterIds } from '@moss-multi/host/collab/registers';
import { $convertToMarkdownString } from '@lexical/markdown';
import type { NoteLayoutMetadata } from '../../../common/noteTypes';
import type { CommentMetadataMap } from '../utils/comment-markdown';
import { $withDocumentImport, withImportFormulaIds } from './fixes';
import { $convertFromMarkdownString } from './linear-import';
import { $postImportNormalize, escapeHtmlEntities, normalizeMarkdownForImport, unescapeHtmlEntities } from './normalize';
import { MARKDOWN_EDITOR_TRANSFORMERS } from './transformers';

// The one body converter for the client, the DocDO and the CLI (A§12). These are moss's own steps
// (MarkdownEditor importMarkdownValue and serializeCurrent) without the leading-H1 lift: the title is the doc's
// name, so the body's first H1 stays content (R3).

export interface NoteBodyImportOptions {
  comments?: CommentMetadataMap;
  layout?: NoteLayoutMetadata;
}

// Call inside editor.update(); replaces the root's children and leaves no selection, so import stays linear in
// blocks (fixes.ts).
export function $importNoteBody(markdown: string, options: NoteBodyImportOptions = {}): void {
  const prepared = escapeHtmlEntities(normalizeMarkdownForImport(markdown));
  $withDocumentImport(() =>
    withImportFormulaIds(prepared, () => {
      $convertFromMarkdownString(prepared, MARKDOWN_EDITOR_TRANSFORMERS);
      $postImportNormalize(options.comments, undefined, { layoutMetadata: options.layout });
      $assignRegisterIds();
    }),
  );
}

// Call inside editor.read() or editor.update().
export function $exportNoteBody(): string {
  return unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS));
}

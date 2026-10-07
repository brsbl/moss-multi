import { $assignRegisterIds } from '@moss-multi/host/collab/registers';
import { $convertToMarkdownString } from '@lexical/markdown';
import type { NoteLayoutMetadata } from '../../../common/noteTypes';
import type { CommentMetadataMap } from '../utils/comment-markdown';
import { $withDocumentImport, withImportFormulaIds } from './fixes';
import { $convertFromMarkdownString, prepareMarkdown } from './linear-import';
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
  const prepared = prepareNoteMarkdown(markdown);
  $withDocumentImport(() =>
    withImportFormulaIds(prepared, () => {
      $convertFromMarkdownString(prepared, MARKDOWN_EDITOR_TRANSFORMERS);
      $postImportNormalize(options.comments, undefined, { layoutMetadata: options.layout });
      $assignRegisterIds();
    }),
  );
}

// moss's import normalization and entity escaping, as every whole-note import runs them (the DocDO, the CLI, and the
// client's load, paste and replacement): lines longer than the inline pass converts skip the normalization, and the
// line lengths the import budgets by are recorded (linear-import.ts). Pass the result straight to the import.
export function prepareNoteMarkdown(markdown: string): string {
  return prepareMarkdown(markdown, (md) => escapeHtmlEntities(normalizeMarkdownForImport(md)), escapeHtmlEntities);
}

// Call inside editor.read() or editor.update().
export function $exportNoteBody(): string {
  return unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS));
}

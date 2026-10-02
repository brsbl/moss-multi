// The headless converter host (A§12), first cut on the unsplit tree: moss's transformers and pipeline steps
// still live in MarkdownEditor.tsx, so the converter imports the editor module.
import { createHeadlessEditor } from '@lexical/headless';
import { $convertFromMarkdownString, $convertToMarkdownString } from '@lexical/markdown';
import type { LexicalEditor, SerializedEditorState } from 'lexical';
import {
  $postImportNormalize,
  escapeHtmlEntities,
  MARKDOWN_EDITOR_NODES,
  MARKDOWN_EDITOR_TRANSFORMERS,
  normalizeMarkdownForImport,
  unescapeHtmlEntities,
} from '@moss-desktop/renderer/editor/MarkdownEditor';
import type { NoteLayoutMetadata } from '@moss-desktop/common/noteTypes';
import type { CommentMetadataMap } from '@moss-desktop/renderer/editor/utils/comment-markdown';

export { MARKDOWN_EDITOR_NODES, MARKDOWN_EDITOR_TRANSFORMERS };

export interface NoteBodyImportOptions {
  comments?: CommentMetadataMap;
  layout?: NoteLayoutMetadata;
}

export function $importNoteBody(markdown: string, options: NoteBodyImportOptions = {}): void {
  $convertFromMarkdownString(escapeHtmlEntities(normalizeMarkdownForImport(markdown)), MARKDOWN_EDITOR_TRANSFORMERS);
  $postImportNormalize(options.comments, undefined, { layoutMetadata: options.layout });
}

export function $exportNoteBody(): string {
  return unescapeHtmlEntities($convertToMarkdownString(MARKDOWN_EDITOR_TRANSFORMERS));
}

export function createConverterEditor(): LexicalEditor {
  return createHeadlessEditor({
    namespace: 'moss-multi-converter',
    nodes: MARKDOWN_EDITOR_NODES,
    onError: (error) => {
      throw error;
    },
  });
}

export function importMarkdown(markdown: string, options?: NoteBodyImportOptions): LexicalEditor {
  const editor = createConverterEditor();
  editor.update(() => $importNoteBody(markdown, options), { discrete: true });
  return editor;
}

export function exportMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $exportNoteBody());
}

export function markdownToState(markdown: string, options?: NoteBodyImportOptions): SerializedEditorState {
  return importMarkdown(markdown, options).getEditorState().toJSON();
}

export function stateToMarkdown(state: SerializedEditorState): string {
  const editor = createConverterEditor();
  editor.setEditorState(editor.parseEditorState(state));
  return exportMarkdown(editor);
}

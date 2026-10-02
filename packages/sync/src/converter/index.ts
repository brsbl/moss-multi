// The headless converter host (A§12): moss's own node classes and transformers, without a DOM, for the DocDO and
// the CLI path. Bindings that use it pass a no-op syncCursorPositionsFn and register no mutation listeners.
import { createHeadlessEditor } from '@lexical/headless';
import type { LexicalEditor, SerializedEditorState } from 'lexical';
import { $exportNoteBody, $importNoteBody, type NoteBodyImportOptions } from '@moss-desktop/renderer/editor/markdown/pipeline';
import { MARKDOWN_EDITOR_NODES, MARKDOWN_EDITOR_TRANSFORMERS } from '@moss-desktop/renderer/editor/markdown/transformers';

export { $exportNoteBody, $importNoteBody, MARKDOWN_EDITOR_NODES, MARKDOWN_EDITOR_TRANSFORMERS };
export type { NoteBodyImportOptions };

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

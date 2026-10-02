// ported-from: packages/desktop/src/renderer/editor/CurrentNoteIdContext.tsx @ 762abb777
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import type { LexicalEditor } from 'lexical';
import { createContext, useContext, useEffect } from 'react';

export const CurrentNoteIdContext = createContext<string | null>(null);

const editorNoteIds = new WeakMap<LexicalEditor, string | null>();

export const useCurrentNoteId = (): string | null => {
  return useContext(CurrentNoteIdContext);
};

export const getCurrentNoteIdForEditor = (editor: LexicalEditor | undefined): string | null =>
  editor ? editorNoteIds.get(editor) ?? null : null;

export const registerCurrentNoteIdForEditor = (
  editor: LexicalEditor,
  noteId: string | null
): (() => void) => {
  editorNoteIds.set(editor, noteId);
  return () => {
    if (editorNoteIds.get(editor) === noteId) {
      editorNoteIds.delete(editor);
    }
  };
};

export function CurrentNoteIdEditorPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const noteId = useCurrentNoteId();

  useEffect(() => registerCurrentNoteIdForEditor(editor, noteId), [editor, noteId]);

  return null;
}

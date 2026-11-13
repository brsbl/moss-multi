// Each bound editor's @lexical/yjs binding, published by the plugin's layout seam (bindLocalLayout), so host code
// can map Lexical nodes to Yjs items: suggestion paint, routed deletes and caret restore (docs/design/suggestions.md §5).
import type { Binding } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';

const bindings = new WeakMap<LexicalEditor, Binding>();

export function publishBinding(editor: LexicalEditor, binding: Binding): () => void {
  bindings.set(editor, binding);
  return () => {
    if (bindings.get(editor) !== binding) return;
    bindings.delete(editor);
  };
}

export const bindingOf = (editor: LexicalEditor): Binding | null => bindings.get(editor) ?? null;

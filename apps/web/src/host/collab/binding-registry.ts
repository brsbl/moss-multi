// Each bound editor's @lexical/yjs binding, published by the plugin's layout seam (bindLocalLayout), so host code
// can map Lexical nodes to Yjs items: suggestion paint, routed deletes and caret restore (docs/design/suggestions.md §5).
import type { Binding } from '@lexical/yjs';
import type { LexicalEditor } from 'lexical';

const bindings = new WeakMap<LexicalEditor, Binding>();
const listeners = new WeakMap<LexicalEditor, Set<(binding: Binding | null) => void>>();

export function publishBinding(editor: LexicalEditor, binding: Binding): () => void {
  bindings.set(editor, binding);
  for (const listener of [...(listeners.get(editor) ?? [])]) listener(binding);
  return () => {
    if (bindings.get(editor) !== binding) return;
    bindings.delete(editor);
    for (const listener of [...(listeners.get(editor) ?? [])]) listener(null);
  };
}

export const bindingOf = (editor: LexicalEditor): Binding | null => bindings.get(editor) ?? null;

/** Calls `listener` with the editor's binding now and on every change; returns the unsubscriber. */
export function onBinding(editor: LexicalEditor, listener: (binding: Binding | null) => void): () => void {
  const set = listeners.get(editor) ?? new Set();
  listeners.set(editor, set);
  set.add(listener);
  listener(bindingOf(editor));
  return () => set.delete(listener);
}

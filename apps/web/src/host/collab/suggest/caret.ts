// Caret restore across a mode switch (docs/design/suggestions.md §5): the caret is kept as the Yjs id of the character
// before it, which F, B and C share for body text, and put back once the remounted editor holds that character.
import { $getNodeByKey, $getSelection, $isRangeSelection, $isTextNode, type LexicalEditor } from 'lexical';
import { bindingOf } from '../binding-registry.ts';
import { charIndex, idKey, textIds } from './chars.ts';

export interface CaretMark {
  client: number;
  clock: number;
  /** After the character rather than before it. */
  after: boolean;
}

export function captureCaret(editor: LexicalEditor): CaretMark | null {
  const binding = bindingOf(editor);
  if (!binding) return null;
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || selection.anchor.type !== 'text') return null;
    const ids = textIds(binding, selection.anchor.key);
    if (!ids || ids.length === 0) return null;
    const { offset } = selection.anchor;
    const id = offset > 0 ? ids[Math.min(offset, ids.length) - 1] : ids[0];
    return { client: id.client, clock: id.clock, after: offset > 0 };
  });
}

/** Puts the caret back; false while the editor does not hold the character yet. */
export function restoreCaret(editor: LexicalEditor, mark: CaretMark): boolean {
  const binding = bindingOf(editor);
  const place = binding && charIndex(binding).get(idKey(mark));
  if (!place || place.offset < 0) return false;
  editor.update(() => {
    const node = $getNodeByKey(place.key);
    if (!$isTextNode(node)) return;
    const offset = Math.min(place.offset + (mark.after ? 1 : 0), node.getTextContentSize());
    node.select(offset, offset);
  });
  return true;
}

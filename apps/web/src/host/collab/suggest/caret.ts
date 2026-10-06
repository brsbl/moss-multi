// Caret restore across a mode switch (docs/design/suggestions.md §5): the caret is kept as the Yjs id of a body
// character beside it (never a pending insert, which another mode's doc may not hold), or of its empty block, and put
// back, focused, once the remounted editor holds that item and is editable.
import { $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, type LexicalEditor } from 'lexical';
import { bindingOf } from '../binding-registry.ts';
import { charIndex, idKey, sharedItem, textIds } from './chars.ts';

export interface CaretMark {
  client: number;
  clock: number;
  /** After the character rather than before it. */
  after: boolean;
}

/** The caret as a body item beside it; `pending` are clients whose items are not body text. */
export function captureCaret(editor: LexicalEditor, pending: ReadonlySet<number> = new Set()): CaretMark | null {
  const binding = bindingOf(editor);
  if (!binding) return null;
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    const { anchor } = selection;
    if (anchor.type === 'element') {
      const item = sharedItem(binding, anchor.key);
      return item && !pending.has(item.id.client) ? { client: item.id.client, clock: item.id.clock, after: false } : null;
    }
    const ids = textIds(binding, anchor.key);
    if (!ids) return null;
    const offset = Math.min(anchor.offset, ids.length);
    for (let i = offset - 1; i >= 0; i -= 1) if (!pending.has(ids[i].client)) return { client: ids[i].client, clock: ids[i].clock, after: true };
    for (let i = offset; i < ids.length; i += 1) if (!pending.has(ids[i].client)) return { client: ids[i].client, clock: ids[i].clock, after: false };
    const block = anchor.getNode().getTopLevelElement();
    const item = block && sharedItem(binding, block.getKey());
    return item && !pending.has(item.id.client) ? { client: item.id.client, clock: item.id.clock, after: false } : null;
  });
}

/** Focuses the editor and puts the caret back; false while the editor does not hold the item yet. */
export function restoreCaret(editor: LexicalEditor, mark: CaretMark): boolean {
  const binding = bindingOf(editor);
  const place = binding && charIndex(binding).get(idKey(mark));
  const root = editor.getRootElement();
  if (!place || !root) return false;
  root.focus({ preventScroll: true });
  editor.update(() => {
    const node = $getNodeByKey(place.key);
    if (place.offset < 0) {
      if ($isElementNode(node)) node.selectStart();
      return;
    }
    if (!$isTextNode(node)) return;
    const offset = Math.min(place.offset + (mark.after ? 1 : 0), node.getTextContentSize());
    node.select(offset, offset);
  });
  return true;
}

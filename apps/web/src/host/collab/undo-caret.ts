// The caret kept with each undo step (T9.14). Moss's history keeps the selection with every entry and restores it on
// undo and redo; the body's Cmd+Z stack keeps it as Yjs relative positions, which follow the text through peers'
// edits and, after a redo, into the restored copies. Only this editor's selection moves: a peer's caret is theirs.
import { $getAnchorAndFocusForUserState, type Binding, type UserState } from '@lexical/yjs';
import {
  $createRangeSelection, $getNodeByKey, $getSelection, $isElementNode, $isRangeSelection, $isRootNode, $isTextNode,
  $setSelection, type EditorState, type LexicalNode, type PointType,
} from 'lexical';
import { ContentType, Item, createRelativePositionFromTypeIndex, findIndexSS, getItem, type AbstractType, type RelativePosition } from 'yjs';
import type { StepCarets } from '@moss-multi/sync/payload-docs';

interface Caret { anchor: RelativePosition; focus: RelativePosition }
type Entries = Parameters<StepCarets['restore']>[1];
/** The parts of @lexical/yjs's collab nodes a position needs (CollabTextNode, CollabElementNode). */
interface CollabNode { getSharedType(): AbstractType<unknown>; getOffset?(): number; _parent?: { _xmlText?: AbstractType<unknown> } }

/** A selection point as a position in the Y.XmlText that holds it, as @lexical/yjs's own createRelativePosition. */
function $relative(binding: Binding, point: PointType, assoc: number): RelativePosition | null {
  const collab = binding.collabNodeMap.get(point.key) as unknown as CollabNode | undefined;
  if (!collab) return null;
  if (point.type === 'text') {
    const text = collab._parent?._xmlText;
    const offset = collab.getOffset?.() ?? -1;
    if (!text || offset === -1) return null;
    // A text node is its property map (one item) and then its characters.
    return createRelativePositionFromTypeIndex(text, offset + 1 + point.offset, assoc);
  }
  const parent = point.getNode();
  if (!$isElementNode(parent)) return null;
  let at = 0;
  let i = 0;
  for (let node = parent.getFirstChild(); node !== null && i++ < point.offset; node = node.getNextSibling()) {
    at += $isTextNode(node) ? node.getTextContentSize() + 1 : 1;
  }
  return createRelativePositionFromTypeIndex(collab.getSharedType(), at, assoc);
}

/** The range selection of `state`, as positions in the note's doc as it holds that state. */
function caretOf(binding: Binding, state: EditorState): Caret | null {
  try {
    return state.read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return null;
      // A range's ends stick to the characters inside it, as the binding's own awareness positions do.
      const collapsed = selection.isCollapsed();
      const backward = !collapsed && selection.isBackward();
      const anchor = $relative(binding, selection.anchor, backward ? -1 : 0);
      const focus = $relative(binding, selection.focus, !collapsed && !backward ? -1 : 0);
      return anchor && focus ? { anchor, focus } : null;
    }, { editor: binding.editor });
  } catch {
    return null;
  }
}

/** The caret as each local update began, read before the binding writes the update, while the doc still holds it. */
const pending = new WeakMap<Binding, { state: EditorState; caret: Caret | null }>();

export function noteCaretBefore(binding: Binding, update: { prevEditorState: EditorState; editorState: EditorState; dirtyLeaves: Set<string>; dirtyElements: Map<string, boolean> }): void {
  if (update.dirtyLeaves.size === 0 && update.dirtyElements.size === 0) return;
  pending.set(binding, { state: update.editorState, caret: caretOf(binding, update.prevEditorState) });
}

/** The stack's carets for `binding`'s editor. */
export function bindingCarets(binding: Binding): StepCarets {
  const now = () => caretOf(binding, binding.editor.getEditorState());
  return {
    // The update that wrote the step's first edit is the committed one; an edit outside any update keeps the caret now.
    before: () => {
      const before = pending.get(binding);
      return before && before.state === binding.editor.getEditorState() ? before.caret : now();
    },
    after: now,
    restore: (caret, entries) => {
      const { editor } = binding;
      // After the binding's own update applies the undo, in an update of its own, so the caret reaches awareness.
      editor.update(() => {}, { onUpdate: () => editor.update(() => $restoreCaret(binding, caret as Caret | null, entries)) });
    },
  };
}

function $restoreCaret(binding: Binding, caret: Caret | null, entries: Entries): void {
  if (caret) {
    const at = $getAnchorAndFocusForUserState(binding, { anchorPos: caret.anchor, focusPos: caret.focus } as UserState);
    const anchor = $point(at.anchorKey, at.anchorOffset);
    const focus = $point(at.focusKey, at.focusOffset);
    if (anchor && focus) {
      let selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        selection = $createRangeSelection();
        $setSelection(selection);
      }
      selection.anchor.set(...anchor);
      selection.focus.set(...focus);
      const node = $getNodeByKey(anchor[0]);
      selection.format = $isTextNode(node) ? node.getFormat() : 0;
      selection.style = $isTextNode(node) ? node.getStyle() : '';
      return;
    }
  }
  // It no longer resolves: the start of the first block the step touched.
  const block = $firstTouchedBlock(binding, entries);
  if ($isElementNode(block)) block.selectStart();
  else block?.selectPrevious();
}

/** A point Lexical can hold, or null: its node gone, or its offset past the node's end. */
function $point(key: string | null, offset: number): [string, number, 'text' | 'element'] | null {
  if (key === null) return null;
  let node = $getNodeByKey(key);
  if (!node || !node.isAttached()) return null;
  if (!$isElementNode(node) && !$isTextNode(node)) {
    const parent: LexicalNode | null = node.getParent();
    if (!parent) return null;
    offset = node.getIndexWithinParent();
    node = parent;
  }
  if ($isRootNode(node)) return null;
  if ($isTextNode(node)) return offset <= node.getTextContentSize() ? [node.getKey(), offset, 'text'] : null;
  return $isElementNode(node) && offset <= node.getChildrenSize() ? [node.getKey(), offset, 'element'] : null;
}

/** Items read when looking for the step's first block; a step larger than this is a paste, found within its start. */
const SCAN_LIMIT = 4_000;

function $firstTouchedBlock(binding: Binding, entries: Entries): LexicalNode | null {
  const { doc } = binding;
  const root = binding.root.getSharedType() as AbstractType<unknown>;
  const blocks = new Map<string, LexicalNode | null>();
  const best = { node: null as LexicalNode | null, index: Infinity };
  let scanned = 0;
  const visit = (item: Item) => {
    let current: Item | null = item;
    while (current) {
      while (current.redone) current = getItem(doc.store, current.redone) as Item;
      if (current.parent === root) break;
      current = (current.parent as AbstractType<unknown>)._item;
    }
    if (!current || current.deleted || !(current.content instanceof ContentType)) return;
    const key = (current.content.type as { _collabNode?: { _key: string } })._collabNode?._key;
    if (!key || blocks.has(key)) return;
    const node = $getNodeByKey(key);
    blocks.set(key, node);
    if (!node || !node.isAttached()) return;
    const index = node.getIndexWithinParent();
    if (index < best.index) { best.node = node; best.index = index; }
  };
  try {
    for (const { manager, item } of entries) {
      if (manager.doc !== doc) continue;
      for (const set of [item.insertions, item.deletions]) {
        set.clients.forEach((ranges, client) => {
          const structs = doc.store.clients.get(client);
          if (!structs?.length) return;
          const end = structs.at(-1)!.id.clock + structs.at(-1)!.length;
          for (const { clock, len } of ranges) {
            if (clock >= end) continue;
            for (let i = findIndexSS(structs, clock); i < structs.length && structs[i]!.id.clock < clock + len && scanned < SCAN_LIMIT; i++, scanned++) {
              const struct = structs[i]!;
              if (struct instanceof Item) visit(struct);
            }
          }
        });
      }
    }
  } catch {
    // A struct the doc no longer holds: whatever was found so far.
  }
  return best.node;
}

import {
  $createRangeSelection,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorState,
} from 'lexical';

/**
 * Where an awaited upload or copy lands (A§16; A§0 invariant 2). Moss saved a selection's keys and offsets at paste
 * time and replayed them after the upload: on a live doc, text typed meanwhile by a peer or this user shifts those
 * offsets, and a replayed range deletes whatever now sits there. A held point is collapsed at paste time (the
 * selected text goes then, as any paste replaces it) and follows every later change to its text, so the media lands
 * between the same characters and deletes nothing.
 */
export interface HeldInsertionPoint {
  /** Inside an update: selects the held point, or the document's end if its node is gone, and stops tracking. */
  $restore(): boolean;
  /** Stops tracking without inserting, for a refused or failed upload. */
  release(): void;
}

/** Inside an update with a range selection (a paste handler): removes the selected text and holds the caret. */
export function $holdInsertionPoint(): HeldInsertionPoint | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  if (!selection.isCollapsed()) selection.removeText();
  const { key, type } = selection.anchor;
  let offset = selection.anchor.offset;
  const anchor = $getNodeByKey(key);
  // An element point is held as the child it precedes, so children added or removed before it keep it in place.
  const before = type === 'element' && $isElementNode(anchor) ? (anchor.getChildAtIndex(offset)?.getKey() ?? null) : null;
  let text = type === 'text' && $isTextNode(anchor) ? anchor.getTextContent() : '';

  const editor = $getEditor();
  const follow = ({ editorState }: { editorState: EditorState }) => {
    if (type !== 'text') return;
    const next = editorState.read(() => {
      const node = $getNodeByKey(key);
      return $isTextNode(node) ? node.getTextContent() : null;
    });
    if (next === null || next === text) return;
    offset = shiftOffset(text, next, offset);
    text = next;
  };
  let stop: (() => void) | null = editor.registerUpdateListener(follow);
  const release = () => {
    stop?.();
    stop = null;
  };

  return {
    $restore() {
      release();
      const node = $getNodeByKey(key);
      const point = $createRangeSelection();
      if (type === 'text' && $isTextNode(node) && node.isAttached()) {
        const at = Math.min(offset, node.getTextContentSize());
        point.anchor.set(key, at, 'text');
        point.focus.set(key, at, 'text');
      } else if (type === 'element' && $isElementNode(node) && node.isAttached()) {
        const child = before ? $getNodeByKey(before) : null;
        const at = child && child.getParent()?.getKey() === key ? child.getIndexWithinParent()
          : before ? Math.min(offset, node.getChildrenSize()) : node.getChildrenSize();
        point.anchor.set(key, at, 'element');
        point.focus.set(key, at, 'element');
      } else {
        $getRoot().selectEnd();
        return true;
      }
      $setSelection(point);
      return true;
    },
    release,
  };
}

/**
 * `offset` in `before` mapped into `after`: an edit wholly before it shifts it by the edit's length, one wholly after
 * leaves it, and one spanning it puts it after the inserted text.
 */
export function shiftOffset(before: string, after: string, offset: number): number {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (offset <= prefix) return offset;
  if (offset >= before.length - suffix) return offset + after.length - before.length;
  return after.length - suffix;
}

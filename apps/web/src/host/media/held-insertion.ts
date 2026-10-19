import {
  $createRangeSelection,
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type EditorState,
  type LexicalEditor,
} from 'lexical';

/**
 * Where an awaited upload or copy lands (A§16; A§0 invariant 2). Moss saved a selection's keys and offsets at paste
 * time and replayed them after the upload: on a live doc, text typed meanwhile by a peer or this user shifts those
 * offsets, and a replayed range deletes whatever now sits there. A held insertion keeps the pasted-over text until
 * the media lands: each end of the selection follows every later change to its text, so the media replaces the same
 * characters and deletes nothing typed meanwhile, and a refused or failed upload leaves the document untouched.
 */
export interface HeldInsertionPoint {
  /**
   * Inside an update: selects the held range, removes its text and leaves the caret there, or selects the document's
   * end if both its ends are gone; stops tracking.
   */
  $restore(): boolean;
  /** Stops tracking without touching the document, for a refused or failed upload. */
  release(): void;
}

interface HeldEnd {
  follow(state: EditorState): void;
  /** The end's place now, or null when its node is gone. */
  $resolve(): { key: string; offset: number; type: 'text' | 'element' } | null;
}

/** One end of the held range, at `key`/`offset`; an element point is held as the child it precedes. */
function holdEnd(key: string, type: 'text' | 'element', start: number): HeldEnd {
  let offset = start;
  const node = $getNodeByKey(key);
  const before = type === 'element' && $isElementNode(node) ? (node.getChildAtIndex(offset)?.getKey() ?? null) : null;
  let text = type === 'text' && $isTextNode(node) ? node.getTextContent() : '';
  return {
    follow(state) {
      if (type !== 'text') return;
      const next = state.read(() => {
        const current = $getNodeByKey(key);
        return $isTextNode(current) ? current.getTextContent() : null;
      });
      if (next === null || next === text) return;
      offset = shiftOffset(text, next, offset);
      text = next;
    },
    $resolve() {
      const current = $getNodeByKey(key);
      if (type === 'text' && $isTextNode(current) && current.isAttached()) {
        return { key, offset: Math.min(offset, current.getTextContentSize()), type };
      }
      if (type === 'element' && $isElementNode(current) && current.isAttached()) {
        const child = before ? $getNodeByKey(before) : null;
        const at = child && child.getParent()?.getKey() === key ? child.getIndexWithinParent()
          : before ? Math.min(offset, current.getChildrenSize()) : current.getChildrenSize();
        return { key, offset: at, type };
      }
      return null;
    },
  };
}

// Every held insertion still waiting on its upload, per editor, so a final save can wait for them (B189).
const pending = new WeakMap<LexicalEditor, Set<Promise<void>>>();

/**
 * Inside an update (a paste handler): holds the range selection's two ends where they are, or, with a node selected
 * (an image the user clicked), the point after the last selected node. Null when the editor has no selection.
 */
export function $holdInsertionPoint(): HeldInsertionPoint | null {
  const selection = $getSelection();
  let ends: [HeldEnd, HeldEnd | null];
  if ($isRangeSelection(selection)) {
    const { anchor, focus } = selection;
    ends = [holdEnd(anchor.key, anchor.type, anchor.offset), selection.isCollapsed() ? null : holdEnd(focus.key, focus.type, focus.offset)];
  } else if ($isNodeSelection(selection)) {
    const nodes = selection.getNodes();
    const last = nodes[nodes.length - 1];
    const parent = last?.getParent();
    if (!last || !parent) return null;
    ends = [holdEnd(parent.getKey(), 'element', last.getIndexWithinParent() + 1), null];
  } else {
    return null;
  }

  const editor = $getEditor();
  let stop: (() => void) | null = editor.registerUpdateListener(({ editorState }) => {
    for (const end of ends) end?.follow(editorState);
  });
  let settle = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  const holds = pending.get(editor) ?? new Set();
  pending.set(editor, holds);
  holds.add(settled);
  const release = () => {
    stop?.();
    stop = null;
    holds.delete(settled);
    settle();
  };

  return {
    $restore() {
      release();
      const [from, to] = ends.map((end) => end?.$resolve() ?? null);
      const start = from ?? to;
      const end = ends[1] ? (to ?? from) : start;
      if (!start || !end) {
        $getRoot().selectEnd();
        return true;
      }
      const range = $createRangeSelection();
      range.anchor.set(start.key, start.offset, start.type);
      range.focus.set(end.key, end.offset, end.type);
      $setSelection(range);
      if (!range.isCollapsed()) range.removeText();
      return true;
    },
    release,
  };
}

/**
 * A file paste's insertion (B188): the selection held as $holdInsertionPoint does, or, with no selection while the
 * editor's body holds focus, the document's end. Null only when the body is not focused, so the paste is not taken.
 */
export function $holdMediaInsertion(): HeldInsertionPoint | null {
  const held = $holdInsertionPoint();
  if (held) return held;
  const body = $getEditor().getRootElement();
  const focused = body?.ownerDocument.activeElement;
  if (!body || !focused || !body.contains(focused)) return null;
  $getRoot().selectEnd();
  return $holdInsertionPoint();
}

/** Resolves once every insertion held in `editor` has landed or been released, its last update committed. */
export async function settleHeldInsertions(editor: LexicalEditor): Promise<void> {
  for (let holds = pending.get(editor); holds && holds.size > 0; holds = pending.get(editor)) await Promise.all([...holds]);
  editor.read(() => undefined);
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

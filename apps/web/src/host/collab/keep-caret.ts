// A peer's Enter, heading, list or checkbox change deletes and re-inserts the block under the local caret, and
// @lexical/yjs then falls back to the end of the block before it (or to the end of the first half of a split). Around
// each remote transaction this keeps the caret's node key and offset, and only when the binding had to recover the
// selection puts the caret back beside its words: in the block now at the same place when it reads the same, or in
// the next block when the old one was split before the caret. Local edits the peer's replacement block lacks (still on
// their way when it converted) are made again there.
import {
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type EditorState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  SKIP_SCROLL_INTO_VIEW_TAG,
} from 'lexical';

export interface HeldCaret {
  state: EditorState;
  key: string;
  offset: number;
}

const focused = (editor: LexicalEditor): boolean => {
  const root = editor.getRootElement();
  const active = root?.ownerDocument.activeElement;
  return !!root && !!active && root.contains(active);
};

/** The collapsed local caret before a remote transaction; null when there is nothing to keep. Runs per peer keystroke. */
export function holdCaret(editor: LexicalEditor, fromUndo: boolean): HeldCaret | null {
  if (fromUndo || editor._pendingEditorState !== null || editor.isComposing()) return null;
  const state = editor.getEditorState();
  const selection = state._selection;
  if (!$isRangeSelection(selection) || !selection.isCollapsed() || !focused(editor)) return null;
  return { state, key: selection.anchor.key, offset: selection.anchor.offset };
}

/** After the transaction's sync: when the held caret's node is gone (or too short for it), restores it once committed. */
export function keepCaret(editor: LexicalEditor, held: HeldCaret): void {
  const lost = editor.read('pending', () => {
    const node = $getNodeByKey(held.key);
    return !node || !node.isAttached() || ($isTextNode(node) && held.offset > node.getTextContentSize());
  });
  if (!lost) return;
  queueMicrotask(() => {
    if (!focused(editor) || editor.isComposing() || !editor.isEditable()) return;
    // The sync's update commits on its own microtask, first; commit anything still pending so this one stays separate.
    if (editor._pendingEditorState !== null) editor.read(() => undefined);
    editor.update(() => $restore(editor, held), { discrete: true, tag: SKIP_SCROLL_INTO_VIEW_TAG });
  });
}

/** A block that holds text: a paragraph, heading, list item or a table cell's paragraph; never a list or table. */
const isTextBlock = (node: LexicalNode | null): node is ElementNode => {
  if (!$isElementNode(node) || node.isInline() || node.getType() === 'root') return false;
  const first = node.getFirstChild();
  return !($isElementNode(first) && !first.isInline());
};

/** Visits the text blocks in document order until `visit` returns true. */
function $walk(parent: ElementNode, visit: (block: ElementNode) => boolean): boolean {
  for (let child = parent.getFirstChild(); child; child = child.getNextSibling()) {
    if (!$isElementNode(child) || child.isInline()) continue;
    if (isTextBlock(child) ? visit(child) : $walk(child, visit)) return true;
  }
  return false;
}

function $indexOf(block: ElementNode): number {
  let index = -1;
  let seen = 0;
  $walk($getRoot(), (candidate) => {
    if (candidate.is(block)) index = seen;
    seen += 1;
    return index >= 0;
  });
  return index;
}

function $blockAt(index: number): ElementNode | null {
  let found: ElementNode | null = null;
  let seen = 0;
  $walk($getRoot(), (block) => {
    if (seen === index) found = block;
    seen += 1;
    return found !== null;
  });
  return found;
}

/** The inline leaves of a block in order (text, line breaks, inline decorators), through links and other inline elements. */
function $leaves(parent: ElementNode, out: LexicalNode[] = []): LexicalNode[] {
  for (let child = parent.getFirstChild(); child; child = child.getNextSibling()) {
    if ($isElementNode(child)) $leaves(child, out);
    else out.push(child);
  }
  return out;
}

/** The caret's character offset in `block`, from a text point or an element point. */
function $offsetIn(block: ElementNode, node: LexicalNode, offset: number): number {
  const leaves = $leaves(block);
  let before = 0;
  if ($isTextNode(node)) {
    for (const leaf of leaves) {
      if (leaf.is(node)) return before + offset;
      before += leaf.getTextContentSize();
    }
    return before;
  }
  const target = $isElementNode(node) ? node.getChildAtIndex(offset) : null;
  const stop = target && $isElementNode(target) ? ($leaves(target)[0] ?? null) : target;
  for (const leaf of leaves) {
    if (stop && leaf.is(stop)) return before;
    before += leaf.getTextContentSize();
  }
  return before;
}

function $placeAt(block: ElementNode, offset: number): void {
  let rest = offset;
  for (const leaf of $leaves(block)) {
    const size = leaf.getTextContentSize();
    if ($isTextNode(leaf) && rest <= size) {
      leaf.select(rest, rest);
      return;
    }
    rest -= size;
  }
  if (offset === 0) block.selectStart();
  else block.selectEnd();
}

function $restore(editor: LexicalEditor, held: HeldCaret): void {
  const before = held.state.read(() => {
    const node = $getNodeByKey(held.key);
    let block: LexicalNode | null = node;
    while (block && !isTextBlock(block)) block = block.getParent();
    if (!node || !isTextBlock(block)) return null;
    return { index: $indexOf(block), offset: $offsetIn(block, node, held.offset), text: block.getTextContent() };
  }, { editor });
  if (!before || before.index < 0) return;
  const block = $blockAt(before.index);
  if (!block) return;
  // Only a block the transaction inserted can stand in for the caret's: a neighbour that moved up (after a merge) never does.
  const inserted = (node: ElementNode) => !held.state._nodeMap.has(node.getKey());
  const text = block.getTextContent();
  // Replaced (a heading, list item or checkbox now reads the same): the same offset in it.
  if (inserted(block) && text === before.text) {
    $placeAt(block, before.offset);
    return;
  }
  // Split before the caret: the rest of the offset in the second half.
  const next = before.offset > text.length ? $blockAt(before.index + 1) : null;
  if (next && inserted(next) && text + next.getTextContent() === before.text) {
    $placeAt(next, before.offset - text.length);
    return;
  }
  if (!inserted(block)) return;
  // Replaced while a few of your edits were still on their way: the peer converted the block without them, and they
  // went with the old one. Put them back beside the caret, as you made them.
  const replay = inFlight(before.text, text, before.offset);
  if (replay) {
    $placeAt(block, replay.at + replay.deleted);
    const placed = $getSelection();
    // Placing again moves the same selection, so keep the end point's values.
    const end = $isRangeSelection(placed) ? { ...placed.anchor } : null;
    $placeAt(block, replay.at);
    const selection = $getSelection();
    if (!$isRangeSelection(selection) || !end) return;
    if (replay.deleted) {
      selection.focus.set(end.key, end.offset, end.type);
      selection.removeText();
    } else {
      selection.insertText(replay.inserted);
    }
    return;
  }
  const mapped = mapOffset(before.text, text, before.offset);
  if (mapped !== null) $placeAt(block, mapped);
}

/** Local edits typed between a peer's change and its arrival that a replaced block can be missing. */
const IN_FLIGHT = 8;

/**
 * The caret's own edits the replaced block `now` lacks, when it reads as `was` without them: characters typed just
 * before the caret at `offset` (to insert again at `at`), or characters deleted right at it (to delete again).
 */
function inFlight(was: string, now: string, offset: number): { at: number; inserted: string; deleted: number } | null {
  const k = Math.abs(was.length - now.length);
  if (k === 0 || k > IN_FLIGHT) return null;
  if (was.length > now.length) {
    if (offset < k || was.slice(0, offset - k) !== now.slice(0, offset - k) || was.slice(offset) !== now.slice(offset - k)) return null;
    return { at: offset - k, inserted: was.slice(offset - k, offset), deleted: 0 };
  }
  if (was.slice(0, offset) !== now.slice(0, offset) || was.slice(offset) !== now.slice(offset + k)) return null;
  return { at: offset, inserted: '', deleted: k };
}

/** `offset` in `was` mapped into `now`, when the two differ in one short run; null when they read differently. */
function mapOffset(was: string, now: string, offset: number): number | null {
  const shorter = Math.min(was.length, now.length);
  let prefix = 0;
  while (prefix < shorter && was[prefix] === now[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix && was[was.length - 1 - suffix] === now[now.length - 1 - suffix]) suffix += 1;
  if (prefix + suffix < Math.max(was.length, now.length) - IN_FLIGHT) return null;
  if (offset <= prefix) return offset;
  return now.length - Math.min(suffix, was.length - offset);
}

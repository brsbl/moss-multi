// A co-editor's Enter or block change keeps this editor's caret on its words (T9.47). @lexical/yjs has no move: a
// block whose type changes is deleted and written again, and a split's tail is re-created in a new block, so the
// binding loses the caret and falls back to the end of the block before. After the commit that lost it, this puts the
// caret back, found by node identity: a line whose key survived the commit is an anchor and never a target; only a
// line the commit created can be one. Text only confirms that line, and every doubt leaves the binding's caret.
// The restore is a selection-only update of its own, so nothing reaches the document and the binding publishes it.
import {
  $createRangeSelection, $getNodeByKey, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode,
  $setSelection, COLLABORATION_TAG, SKIP_COLLAB_TAG, SKIP_DOM_SELECTION_TAG, SKIP_SCROLL_INTO_VIEW_TAG,
  type EditorState, type ElementNode, type LexicalEditor, type LexicalNode, type PointType, type RangeSelection,
} from 'lexical';
import { replacedOffset, splitOffset } from './peer-caret-text.ts';
import { $point } from './undo-caret.ts';

/** The restore's own commit. */
export const PEER_CARET_TAG = 'moss-multi-peer-caret';

/** Counted for the cost tests: carets placed after a loss, and the nodes the placement walks visited. */
export const peerCaretWork = { placed: 0, visits: 0 };

interface Point { key: string; offset: number }
interface Placed { point: Point; split: boolean; line: string }
interface Restore { anchor: Point; focus: Point; format: number; style: string; skipDom: boolean }

/** Registers the listener; returns its release. Edit mode only (pane.tsx). */
export function keepCaretThroughPeers(editor: LexicalEditor): () => void {
  let composing = false;
  let root: HTMLElement | null = null;
  const start = () => { composing = true; };
  const end = () => { composing = false; };
  const stopRoot = editor.registerRootListener((next, previous) => {
    composing = false;
    for (const element of [previous, root]) {
      element?.removeEventListener('compositionstart', start);
      element?.removeEventListener('compositionend', end);
      element?.removeEventListener('focusout', end);
    }
    root = next;
    next?.addEventListener('compositionstart', start);
    next?.addEventListener('compositionend', end);
    // A missed compositionend never turns this off for the session.
    next?.addEventListener('focusout', end);
  });

  let last: Restore | null = null;
  let retried = false;
  const restore = (wanted: Restore) => {
    last = wanted;
    const tag = [PEER_CARET_TAG, SKIP_SCROLL_INTO_VIEW_TAG];
    if (wanted.skipDom) tag.push(SKIP_DOM_SELECTION_TAG);
    editor.update(() => $restore(wanted), { discrete: true, tag });
  };

  const stopUpdate = editor.registerUpdateListener(({ prevEditorState, editorState, tags }) => {
    if (tags.has(PEER_CARET_TAG)) {
      // The binding publishes only an untagged commit, and the DOM selection follows only one that asks.
      const shared = tags.has(COLLABORATION_TAG) || tags.has(SKIP_COLLAB_TAG) || (tags.has(SKIP_DOM_SELECTION_TAG) && !last?.skipDom);
      if (shared && last && !retried) { retried = true; restore(last); }
      return;
    }
    if (!tags.has(COLLABORATION_TAG)) return;
    if (composing || !editor.isEditable()) return;
    const held = prevEditorState._selection;
    if (!$isRangeSelection(held)) return;
    const collapsed = held.isCollapsed();
    const lostAnchor = lost(editorState, held.anchor);
    const lostFocus = collapsed ? lostAnchor : lost(editorState, held.focus);
    if (!lostAnchor && !lostFocus) return;
    const points = place(prevEditorState, editorState, held, collapsed, lostAnchor, lostFocus);
    if (!points) return;
    const active = editor.getRootElement();
    retried = false;
    restore({ ...points, format: held.format, style: held.style, skipDom: !active || active.ownerDocument.activeElement !== active });
  });
  return () => {
    stopUpdate();
    stopRoot();
    root?.removeEventListener('compositionstart', start);
    root?.removeEventListener('compositionend', end);
    root?.removeEventListener('focusout', end);
    root = null;
  };
}

function $restore(wanted: Restore): void {
  const anchor = $point(wanted.anchor.key, wanted.anchor.offset);
  const focus = $point(wanted.focus.key, wanted.focus.offset);
  if (!anchor || !focus) return;
  const current = $getSelection();
  const selection: RangeSelection = $isRangeSelection(current) ? current : $createRangeSelection();
  if (selection !== current) $setSelection(selection);
  selection.anchor.set(...anchor);
  selection.focus.set(...focus);
  selection.format = wanted.format;
  selection.style = wanted.style;
}

/** The binding's own test, on the held point: its node gone or detached, or its offset past the node's end. */
function lost(state: EditorState, point: PointType): boolean {
  return state.read(() => {
    const node = $getNodeByKey(point.key);
    if (!node || !node.isAttached()) return true;
    if (point.type === 'text') return !$isTextNode(node) || point.offset > node.getTextContentSize();
    return !$isElementNode(node) || point.offset > node.getChildrenSize();
  });
}

/** Whether `key` is attached in `state`, read from its node map without making it the active state. */
function attachedIn(state: EditorState, key: string): boolean {
  for (let node = state._nodeMap.get(key); node; node = node.__parent === null ? undefined : state._nodeMap.get(node.__parent)) {
    if (node.__key === 'root') return true;
  }
  return false;
}

/** Both ends of the held selection placed, or null. An end that was not lost keeps its key and offset. */
function place(prev: EditorState, next: EditorState, held: RangeSelection, collapsed: boolean, lostAnchor: boolean, lostFocus: boolean): { anchor: Point; focus: Point } | null {
  const anchorKept = { key: held.anchor.key, offset: held.anchor.offset };
  const focusKept = { key: held.focus.key, offset: held.focus.offset };
  if (collapsed) {
    const placed = placeEnd(prev, next, anchorKept, false);
    return placed ? { anchor: placed.point, focus: placed.point } : null;
  }
  const backward = prev.read(() => held.isBackward());
  const [earlier, later] = backward ? [focusKept, anchorKept] : [anchorKept, focusKept];
  const [lostEarlier, lostLater] = backward ? [lostFocus, lostAnchor] : [lostAnchor, lostFocus];
  let laterAt: Point = later;
  let laterPlaced: Placed | null = null;
  if (lostLater) {
    laterPlaced = placeEnd(prev, next, later, false);
    if (!laterPlaced) return null;
    laterAt = laterPlaced.point;
  }
  let earlierAt: Point = earlier;
  if (lostEarlier) {
    const placed = placeEnd(prev, next, earlier, true);
    if (!placed) return null;
    earlierAt = placed.point;
  } else if (laterPlaced?.split) {
    // A range's start follows its first character into the new block when both ends were in the split line.
    const placed = placeEnd(prev, next, earlier, true);
    if (placed && placed.split && placed.line === laterPlaced.line) earlierAt = placed.point;
  }
  return backward ? { anchor: laterAt, focus: earlierAt } : { anchor: earlierAt, focus: laterAt };
}

/** A line: a non-inline element, not the root, whose first child is not a block (paragraph, heading, item, cell's paragraph). */
function isLine(node: LexicalNode | null): node is ElementNode {
  if (!$isElementNode(node) || node.isInline() || node.getKey() === 'root') return false;
  const first = node.getFirstChild();
  return !($isElementNode(first) && !first.isInline());
}

/** `isLine` without narrowing its argument's type. */
const lineNode = (node: LexicalNode): boolean => isLine(node);

/** The next node in document order; `over` skips the node's children. */
function after(node: LexicalNode, over: boolean): LexicalNode | null {
  if (!over && $isElementNode(node)) {
    const first = node.getFirstChild();
    if (first) return first;
  }
  for (let at: LexicalNode | null = node; at && at.getKey() !== 'root'; at = at.getParent()) {
    const sibling = at.getNextSibling();
    if (sibling) return sibling;
  }
  return null;
}

/** The previous node in document order, entering a block's last child but never a line's. */
function before(node: LexicalNode): LexicalNode | null {
  let at = node.getPreviousSibling();
  if (!at) {
    const parent = node.getParent();
    return parent && parent.getKey() !== 'root' ? parent : null;
  }
  while ($isElementNode(at) && !at.isInline() && !lineNode(at)) {
    const last: LexicalNode | null = at.getLastChild();
    if (!last) break;
    at = last;
  }
  return at;
}

function $lineAfter(from: LexicalNode | null): ElementNode | null {
  for (let node = from && after(from, isLine(from)); node; node = after(node, isLine(node) || !$isElementNode(node))) {
    peerCaretWork.visits += 1;
    if (isLine(node)) return node;
  }
  return null;
}

function $lineBefore(from: ElementNode): ElementNode | null {
  for (let node = before(from); node; node = before(node)) {
    peerCaretWork.visits += 1;
    if (isLine(node)) return node;
  }
  return null;
}

/** The first line in document order. */
function $firstLine(): ElementNode | null {
  const first = $getRoot().getFirstChild();
  if (!first) return null;
  return isLine(first) ? first : $lineAfter(first);
}

/** The inline leaves of a line in order (text, line breaks, inline decorators), through links. */
function $leaves(line: ElementNode): LexicalNode[] {
  const out: LexicalNode[] = [];
  const stack: LexicalNode[] = line.getChildren().reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if ($isElementNode(node)) stack.push(...node.getChildren().reverse());
    else out.push(node);
  }
  return out;
}

const $lineText = (line: ElementNode): string => $leaves(line).map(leaf => leaf.getTextContent()).join('');

/** The caret's character offset in its line, from a text point or an element point. */
function $offsetIn(line: ElementNode, node: LexicalNode, offset: number): number {
  const leaves = $leaves(line);
  let at = 0;
  if ($isTextNode(node)) {
    for (const leaf of leaves) {
      if (leaf.is(node)) return at + offset;
      at += leaf.getTextContentSize();
    }
    return at;
  }
  const child = $isElementNode(node) ? node.getChildAtIndex(offset) : null;
  const stop = child && $isElementNode(child) ? ($leaves(child)[0] ?? null) : child;
  for (const leaf of leaves) {
    if (stop && leaf.is(stop)) return at;
    at += leaf.getTextContentSize();
  }
  return at;
}

/** The line holding `node`, or null. */
function $lineOf(node: LexicalNode): ElementNode | null {
  for (let at: LexicalNode | null = node; at; at = at.getParent()) {
    if (isLine(at)) return at;
    if ($isElementNode(at) && !at.isInline()) return null;
  }
  return null;
}

/** An offset in a line as a point: the text leaf that holds it (the earlier at a boundary), else the line's start or end. */
function $pointAt(line: ElementNode, offset: number): Point {
  let rest = offset;
  for (const leaf of $leaves(line)) {
    const size = leaf.getTextContentSize();
    if ($isTextNode(leaf) && rest <= size) return { key: leaf.getKey(), offset: rest };
    rest -= size;
  }
  return { key: line.getKey(), offset: offset === 0 ? 0 : line.getChildrenSize() };
}

interface Before {
  line: string; left: string; right: string; kept: boolean;
  above: string | null; aboveText: string; below: string | null;
  /** The texts of the old run (the lines between the anchors), mine at `i`. */
  run: string[]; i: number; d: number;
}

/** Where one lost end of the selection goes, or null. */
function placeEnd(prev: EditorState, next: EditorState, point: Point, startOfRange: boolean): Placed | null {
  peerCaretWork.placed += 1;
  const old = prev.read((): Before | null => {
    const node = $getNodeByKey(point.key);
    const line = node && $lineOf(node);
    if (!node || !line) return null;
    const text = $lineText(line);
    const at = Math.min($offsetIn(line, node, point.offset), text.length);
    const kept = attachedIn(next, line.getKey());
    const earlier: string[] = [];
    let above: ElementNode | null = kept ? line : null;
    if (!kept) {
      for (let at2 = $lineBefore(line); at2; at2 = $lineBefore(at2)) {
        if (attachedIn(next, at2.getKey())) { above = at2; break; }
        earlier.push($lineText(at2));
      }
    }
    const later: string[] = [];
    let below: string | null = null;
    for (let at2 = $lineAfter(line); at2; at2 = $lineAfter(at2)) {
      if (attachedIn(next, at2.getKey())) { below = at2.getKey(); break; }
      // R2 needs no other old line to have gone; R1 needs my line gone.
      if (kept) return null;
      later.push($lineText(at2));
    }
    earlier.reverse();
    return {
      line: line.getKey(), left: text.slice(0, at), right: text.slice(at), kept,
      above: above?.getKey() ?? null, aboveText: above && !kept ? $lineText(above) : '', below,
      run: [...earlier, text, ...later], i: earlier.length, d: later.length,
    };
  });
  if (!old) return null;
  return next.read(() => {
    const above = old.above === null ? null : $getNodeByKey(old.above);
    const fresh: ElementNode[] = [];
    let line = above ? $lineAfter(above) : $firstLine();
    for (; line && !prev._nodeMap.has(line.getKey()); line = $lineAfter(line)) fresh.push(line);
    if ((line?.getKey() ?? null) !== old.below || fresh.length === 0) return null;
    const unchangedAbove = () => !$isElementNode(above) || $lineText(above) === old.aboveText;
    if (!old.kept && fresh.length === old.i + 1 + old.d) {
      // R1: my line was replaced, one for one.
      if (!unchangedAbove()) return null;
      const texts = fresh.map($lineText);
      const mine = texts[old.i]!;
      for (let j = 0; j < texts.length; j++) {
        // Order proven: every other line reads as it did, and none reads as mine, before or after.
        if (j !== old.i && (texts[j] !== old.run[j] || texts[j] === mine || old.run[j] === old.run[old.i])) return null;
      }
      const offset = replacedOffset(old.left, old.right, mine);
      return offset === null ? null : { point: $pointAt(fresh[old.i]!, offset), split: false, line: old.line };
    }
    const r2 = old.kept ? old.d === 0 : old.i === 0 && old.d === 0 && fresh.length >= 2;
    if (!r2) return null;
    // R2: the words on my left moved into a new block.
    if (!old.kept && !unchangedAbove()) return null;
    let keptText = '';
    if (old.kept && $isElementNode(above)) {
      keptText = $lineText(above);
      // Identity wins: the binding's own caret is in my line with exactly my right-hand words after it.
      const answer = next._selection;
      if (old.right !== '' && $isRangeSelection(answer) && answer.isCollapsed()) {
        const node = $getNodeByKey(answer.anchor.key);
        if (node && $lineOf(node)?.is(above) && keptText.slice($offsetIn(above, node, answer.anchor.offset)) === old.right) return null;
      }
    }
    const offset = splitOffset(old.left, old.right, keptText, fresh.map($lineText), startOfRange);
    return offset === null ? null : { point: $pointAt(fresh[fresh.length - 1]!, offset), split: true, line: old.line };
  });
}

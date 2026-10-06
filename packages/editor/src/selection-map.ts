// A selection carried across an in-place reload as offsets into the note's text, so the caret stays on the same
// words when the external change was elsewhere. Run inside a Lexical read or update.
import { $createRangeSelection, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $setSelection, type ElementNode, type PointType, type TextNode } from 'lexical';

interface Flat {
  text: string;
  nodes: { node: TextNode; start: number }[];
}

/** The text nodes in order, a newline between blocks so a block's start and the previous block's end differ. */
function $flatten(): Flat {
  let text = '';
  const nodes: Flat['nodes'] = [];
  let lastBlock: string | null = null;
  for (const node of $getRoot().getAllTextNodes()) {
    let block: ElementNode | null = node.getParent();
    while (block && block.isInline()) block = block.getParent();
    const key = block?.getKey() ?? null;
    if (nodes.length > 0 && key !== lastBlock) text += '\n';
    lastBlock = key;
    nodes.push({ node, start: text.length });
    text += node.getTextContent();
  }
  return { text, nodes };
}

function $offsetOf(flat: Flat, point: PointType): number | null {
  const node = point.getNode();
  if (point.type === 'text') {
    const entry = flat.nodes.find((candidate) => candidate.node.is(node));
    return entry ? entry.start + Math.min(point.offset, entry.node.getTextContentSize()) : null;
  }
  if (!$isElementNode(node)) return null;
  const child = node.getChildAtIndex(point.offset);
  if (child) {
    const after = flat.nodes.find((entry) => entry.node.is(child) || ($isElementNode(child) && child.isParentOf(entry.node)) || child.isBefore(entry.node));
    return after ? after.start : flat.text.length;
  }
  const before = flat.nodes.filter((entry) => node.isParentOf(entry.node) || entry.node.isBefore(node)).at(-1);
  return before ? before.start + before.node.getTextContentSize() : 0;
}

export interface HeldSelection {
  text: string;
  anchor: number;
  focus: number;
}

/** The current range selection as text offsets, or null. */
export function $holdSelection(): HeldSelection | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return null;
  try {
    const flat = $flatten();
    const anchor = $offsetOf(flat, selection.anchor);
    const focus = $offsetOf(flat, selection.focus);
    return anchor === null || focus === null ? null : { text: flat.text, anchor, focus };
  } catch {
    return null;
  }
}

/** An offset in `before` moved to `after`: unchanged ahead of the edit, shifted behind it, clamped inside it. */
export function mapOffset(before: string, after: string, offset: number): number {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix += 1;
  if (offset <= prefix) return offset;
  if (offset >= before.length - suffix) return offset + after.length - before.length;
  return Math.min(offset, after.length - suffix);
}

/** Selects `held` in the current content, mapped through the text that changed; false when there is no text. */
export function $restoreSelection(held: HeldSelection): boolean {
  const flat = $flatten();
  if (flat.nodes.length === 0) return false;
  const pointAt = (offset: number) => {
    const target = mapOffset(held.text, flat.text, offset);
    const entry = flat.nodes.filter((candidate) => candidate.start <= target).at(-1) ?? flat.nodes[0];
    return { key: entry.node.getKey(), offset: Math.max(0, Math.min(target - entry.start, entry.node.getTextContentSize())) };
  };
  const anchor = pointAt(held.anchor);
  const focus = pointAt(held.focus);
  const selection = $createRangeSelection();
  selection.anchor.set(anchor.key, anchor.offset, 'text');
  selection.focus.set(focus.key, focus.offset, 'text');
  $setSelection(selection);
  return true;
}

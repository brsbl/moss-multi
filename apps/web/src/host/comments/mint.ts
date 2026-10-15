// Client minting (docs/design/comments.md §4): a new comment's positions come from the live selection through the
// pane's binding. A character's index in its paragraph's Y.XmlText is `getOffset() + 1 + offset` (a text node's
// property map comes first), the start names its first unit (assoc 0) and the end its last (assoc -1). A block
// comment names the decorator's one embed. The server validates both and computes the quote itself.
import type { Binding } from '@lexical/yjs';
import { toBase64 } from '@moss-multi/core/tree-anchor';
import {
  $createRangeSelectionFromDom, $getNodeByKey, $getSelection, $isDecoratorNode, $isRangeSelection, $isTextNode,
  type LexicalEditor, type RangeSelection, type TextNode,
} from 'lexical';
import * as Y from 'yjs';

export interface Minted {
  kind: 'text' | 'block';
  start: string;
  end: string;
  /** Advisory; the server's quote is the one kept. */
  quote: string;
}

interface CollabText { _parent: { _xmlText: Y.XmlText }; getOffset(): number }
interface CollabDecorator { _xmlElem: Y.XmlElement }

const encode = (position: Y.RelativePosition) => toBase64(Y.encodeRelativePosition(position));

function index(binding: Binding, node: TextNode, offset: number): [Y.XmlText, number] | null {
  const collab = binding.collabNodeMap.get(node.getKey()) as unknown as CollabText | undefined;
  const at = collab?.getOffset() ?? -1;
  return collab && at >= 0 ? [collab._parent._xmlText, at + 1 + offset] : null;
}

/** The selected characters' first and last text nodes with offsets, skipping empty edges. */
function $edges(selection: RangeSelection): { first: [TextNode, number]; last: [TextNode, number] } | null {
  const texts = selection.getNodes().filter($isTextNode);
  const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
  let from = texts[0] && start.type === 'text' && start.key === texts[0].getKey() ? start.offset : 0;
  if (texts[0] && from >= texts[0].getTextContentSize()) {
    texts.shift();
    from = 0;
  }
  let last = texts.at(-1);
  let to = last && end.type === 'text' && end.key === last.getKey() ? end.offset : (last?.getTextContentSize() ?? 0);
  if (last && to <= 0 && texts.length > 1) {
    texts.pop();
    last = texts.at(-1);
    to = last?.getTextContentSize() ?? 0;
  }
  const first = texts[0];
  if (!first || !last || (first === last && to <= from)) return null;
  return { first: [first, from], last: [last, to] };
}

/** Mints from a range selection, read inside an editor read or update. */
export function $mintRange(binding: Binding, selection: RangeSelection): Minted | null {
  if (selection.isCollapsed()) return null;
  const edges = $edges(selection);
  if (!edges) return null;
  const start = index(binding, ...edges.first);
  const end = index(binding, ...edges.last);
  if (!start || !end) return null;
  const quote = selection.getTextContent();
  if (!quote.trim()) return null;
  return {
    kind: 'text',
    start: encode(Y.createRelativePositionFromTypeIndex(start[0], start[1], 0)),
    end: encode(Y.createRelativePositionFromTypeIndex(end[0], end[1], -1)),
    quote,
  };
}

/** Mints a block comment on a decorator, by its Lexical key. */
export function $mintNode(binding: Binding, nodeKey: string): Minted | null {
  const node = $getNodeByKey(nodeKey);
  if (!node || !$isDecoratorNode(node)) return null;
  const item = (binding.collabNodeMap.get(nodeKey) as unknown as CollabDecorator | undefined)?._xmlElem._item;
  if (!item) return null;
  const position = encode(Y.createRelativePositionFromJSON({ type: null, tname: null, item: { client: item.id.client, clock: item.id.clock }, assoc: 0 }));
  return { kind: 'block', start: position, end: position, quote: '' };
}

/**
 * Mints from what is selected now: Lexical's selection, or the DOM's in a read-only body, where Lexical may not
 * have taken it.
 */
export function mintCurrent(editor: LexicalEditor, binding: Binding): Minted | null {
  return editor.getEditorState().read(() => {
    const current = $getSelection();
    if ($isRangeSelection(current) && !current.isCollapsed()) return $mintRange(binding, current);
    const dom = typeof window === 'undefined' ? null : window.getSelection();
    const root = editor.getRootElement();
    if (!dom || dom.isCollapsed || !root || !dom.anchorNode || !root.contains(dom.anchorNode)) return null;
    const fromDom = $createRangeSelectionFromDom(dom, editor);
    return fromDom ? $mintRange(binding, fromDom) : null;
  }, { editor });
}

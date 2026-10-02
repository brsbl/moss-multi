// ported-from: packages/desktop/src/renderer/editor/utils/block-node-double-enter.ts @ 762abb777
import {
  $createParagraphNode,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  type LexicalNode
} from 'lexical';

type EnterTrackerState = {
  blockKey: string | null;
};

export function createBlockEndEnterTracker(): {
  mark: (blockKey: string) => void;
  isSecondEnter: (blockKey: string) => boolean;
  clear: () => void;
} {
  const state: EnterTrackerState = { blockKey: null };

  return {
    mark(blockKey) {
      state.blockKey = blockKey;
    },
    isSecondEnter(blockKey) {
      return state.blockKey === blockKey;
    },
    clear() {
      state.blockKey = null;
    }
  };
}

export function isPlainEnterEvent(event: KeyboardEvent | null | undefined): boolean {
  return !event || !(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey);
}

export function $isEmptyParagraph(node: LexicalNode | null | undefined): boolean {
  if (!$isParagraphNode(node)) return false;
  const children = node.getChildren();
  return children.length === 0 || (children.length === 1 && $isTextNode(children[0]) && children[0].getTextContent() === '');
}

export function $getDirectChildOfAncestor(node: LexicalNode, ancestor: LexicalNode): LexicalNode | null {
  let current: LexicalNode | null = node;
  while (current) {
    const parent: LexicalNode | null = current.getParent();
    if (parent === ancestor) return current;
    current = parent;
  }
  return null;
}

export function $getLastDescendant(node: LexicalNode): LexicalNode {
  let current = node;
  while ($isElementNode(current) && current.getLastChild()) {
    current = current.getLastChild()!;
  }
  return current;
}

export function $isSelectionAtNodeEnd(anchorNode: LexicalNode, anchorOffset: number, container: LexicalNode): boolean {
  if (!$isElementNode(container)) {
    return false;
  }

  const directChild = $getDirectChildOfAncestor(anchorNode, container);
  if (!directChild || directChild !== container.getLastChild()) {
    return false;
  }

  const lastDescendant = $getLastDescendant(directChild);
  if (anchorNode.getKey() !== lastDescendant.getKey()) {
    return false;
  }

  if ($isTextNode(lastDescendant)) {
    return anchorOffset === lastDescendant.getTextContentSize();
  }

  if ($isElementNode(lastDescendant)) {
    return anchorOffset === lastDescendant.getChildrenSize();
  }

  return true;
}

export function $removeEmptyParagraphAtSelection(anchorNode: LexicalNode, container: LexicalNode): void {
  const directChild = $getDirectChildOfAncestor(anchorNode, container);
  if (directChild && $isEmptyParagraph(directChild)) {
    directChild.remove();
  }
}

export function $isSelectionInEmptyParagraph(anchorNode: LexicalNode, container: LexicalNode): boolean {
  return $isEmptyParagraph($getDirectChildOfAncestor(anchorNode, container));
}

export function $insertParagraphAfterBlock(blockNode: LexicalNode): void {
  const paragraph = $createParagraphNode();
  blockNode.insertAfter(paragraph);
  paragraph.select();
}

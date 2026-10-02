// ported-from: packages/desktop/src/renderer/editor/utils/block-node-insertion.ts @ 762abb777
import {
  $createParagraphNode,
  type LexicalNode
} from 'lexical';

export function insertParagraphAdjacentToBlock(
  node: LexicalNode,
  position: 'before' | 'after'
): void {
  const insertionTarget = node.getTopLevelElementOrThrow();
  const paragraph = $createParagraphNode();

  if (position === 'before') {
    insertionTarget.insertBefore(paragraph);
  } else {
    insertionTarget.insertAfter(paragraph);
  }

  paragraph.selectEnd();
}

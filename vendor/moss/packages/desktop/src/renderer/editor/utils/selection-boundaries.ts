// ported-from: packages/desktop/src/renderer/editor/utils/selection-boundaries.ts @ 762abb777
import type { LexicalNode, RootNode } from 'lexical';

export function $isPointAtRootStart(
  node: LexicalNode,
  offset: number,
  root: RootNode
): boolean {
  if (offset !== 0) return false;

  let current: LexicalNode | null = node;
  while (current && current.getKey() !== root.getKey()) {
    if (current.getPreviousSibling() !== null) return false;
    current = current.getParent();
  }

  return current?.getKey() === root.getKey();
}

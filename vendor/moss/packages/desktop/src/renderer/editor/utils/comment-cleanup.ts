// ported-from: packages/desktop/src/renderer/editor/utils/comment-cleanup.ts @ 762abb777
import { $isMarkNode, $unwrapMarkNode } from '@lexical/mark';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';

import { $isCommentableDecorator } from './commentable-node';
import { $getMarkNodesWithId } from '../plugins/CommentPlugin';

export interface ClearCommentAnchorsOptions {
  tag?: string;
}

export function $clearCommentAnchors(commentIds: Iterable<string>): void {
  const ids = new Set(commentIds);
  if (ids.size === 0) {
    return;
  }

  for (const id of ids) {
    for (const markNode of $getMarkNodesWithId(id)) {
      markNode.deleteID(id);
      if (markNode.getIDs().length === 0) {
        $unwrapMarkNode(markNode);
      }
    }
  }

  const visit = (node: LexicalNode) => {
    if ($isMarkNode(node)) {
      return;
    }
    if ($isCommentableDecorator(node)) {
      const nextIds = node.getCommentIds().filter((id) => !ids.has(id));
      if (nextIds.length !== node.getCommentIds().length) {
        node.setCommentIds(nextIds);
      }
    }
    if ($isElementNode(node)) {
      for (const child of node.getChildren()) {
        visit(child);
      }
    }
  };

  for (const child of $getRoot().getChildren()) {
    visit(child);
  }
}

export function clearCommentAnchors(
  editor: LexicalEditor,
  commentIds: Iterable<string>,
  options?: ClearCommentAnchorsOptions
): void {
  const ids = Array.from(new Set(commentIds));
  if (ids.length === 0) {
    return;
  }
  editor.update(() => $clearCommentAnchors(ids), {
    discrete: true,
    ...(options?.tag ? { tag: options.tag } : {})
  });
}

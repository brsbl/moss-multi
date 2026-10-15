// ported-from: packages/desktop/src/renderer/editor/plugins/CommentAnchorTrackerPlugin.tsx @ 762abb777
import { useCallback, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $isMarkNode, MarkNode } from '@lexical/mark';
import { $getRoot, $isElementNode, type LexicalEditor, type LexicalNode } from 'lexical';
import { useAtomValue, useSetAtom } from 'jotai';

import {
  noteCommentAnchorIdsAtom,
  noteCommentAnchorIdsSyncedAtom,
  noteCommentsMapAtom
} from '@moss/shared/state/note-atoms';
import { ChartNode } from '../nodes/ChartNode';
import { CodeBlockNode } from '../nodes/CodeBlockNode';
import { EmbedPillNode } from '../nodes/EmbedPillNode';
import { FileLinkNode } from '../nodes/FileLinkNode';
import { FormulaNode } from '../nodes/FormulaNode';
import { HtmlBlockquoteNode } from '../nodes/HtmlBlockquoteNode';
import { ImageNode } from '../nodes/ImageNode';
import { SketchNode } from '../nodes/SketchNode';
import { VideoNode } from '../nodes/VideoNode';
import { WebEmbedNode } from '../nodes/WebEmbedNode';
import { $isCommentableDecorator } from '../utils/commentable-node';
// moss-multi seam: comments (comments.md §12)
import { liveAnchorIds, subscribePaint } from '@moss-multi/host/comments/adapter';

interface CommentAnchorTrackerPluginProps {
  noteId: string;
}

function areStringArraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

const COMMENTABLE_DECORATOR_NODES = [
  ChartNode,
  CodeBlockNode,
  EmbedPillNode,
  FileLinkNode,
  FormulaNode,
  HtmlBlockquoteNode,
  ImageNode,
  SketchNode,
  VideoNode,
  WebEmbedNode
] as const;

export function collectLiveCommentAnchorIds(editor: LexicalEditor): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  editor.getEditorState().read(() => {
    const visit = (node: LexicalNode): void => {
      const nodeIds = $isMarkNode(node)
        ? node.getIDs()
        : $isCommentableDecorator(node) ? node.getCommentIds() : null;

      if (nodeIds) {
        for (const id of nodeIds) {
          if (id.length === 0 || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
        }
      }

      if ($isElementNode(node)) {
        for (const child of node.getChildren()) visit(child);
      }
    };

    for (const child of $getRoot().getChildren()) visit(child);
  });

  return ids;
}

export function CommentAnchorTrackerPlugin({ noteId }: CommentAnchorTrackerPluginProps) {
  const [editor] = useLexicalComposerContext();
  const commentsMap = useAtomValue(noteCommentsMapAtom(noteId));
  const hasComments = Object.keys(commentsMap).length > 0;
  const setLiveCommentAnchorIds = useSetAtom(noteCommentAnchorIdsAtom(noteId));
  const setLiveCommentAnchorIdsSynced = useSetAtom(noteCommentAnchorIdsSyncedAtom(noteId));

  const syncAnchorIds = useCallback(() => {
    // moss-multi seam: comments (comments.md §12): a bound note's anchors are records
    const nextIds = liveAnchorIds(editor) ?? collectLiveCommentAnchorIds(editor);
    setLiveCommentAnchorIds((prevIds) =>
      areStringArraysEqual(prevIds, nextIds) ? prevIds : nextIds
    );
    setLiveCommentAnchorIdsSynced(true);
  }, [editor, setLiveCommentAnchorIds, setLiveCommentAnchorIdsSynced]);

  useEffect(() => {
    if (!hasComments) {
      setLiveCommentAnchorIds([]);
      setLiveCommentAnchorIdsSynced(true);
      return;
    }

    let rafId: number | null = null;
    const scheduleSync = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        syncAnchorIds();
      });
    };

    syncAnchorIds();
    const unregMarkMutation = editor.registerMutationListener(MarkNode, scheduleSync);
    const unregPaint = subscribePaint(editor, scheduleSync); // moss-multi seam: comments
    const unregDecoratorMutations = COMMENTABLE_DECORATOR_NODES.map((nodeClass) =>
      editor.registerMutationListener(nodeClass, scheduleSync)
    );

    return () => {
      unregMarkMutation();
      unregPaint(); // moss-multi seam: comments
      for (const unregister of unregDecoratorMutations) unregister();
      if (rafId !== null) cancelAnimationFrame(rafId);
      setLiveCommentAnchorIds([]);
      setLiveCommentAnchorIdsSynced(false);
    };
  }, [editor, hasComments, setLiveCommentAnchorIds, setLiveCommentAnchorIdsSynced, syncAnchorIds]);

  return null;
}

export default CommentAnchorTrackerPlugin;

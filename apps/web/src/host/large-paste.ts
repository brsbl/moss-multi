// T3.S6 (DEVIATIONS 22): a large markdown paste lands whole. Moss at the pin split the text into 12,000-character
// chunks and dropped every chunk after the first. Here the paste is parsed once, off the live editor, as one update
// would parse it; the note then takes its top-level blocks in batches, each a complete update of its own, so no sync
// frame outgrows what the DocDO accepts (a workerd frame is at most 1 MiB). Each batch waits for the server's ack of
// the last (paste-gate.ts), and the batches make one undo step.
import {
  $getNodeByKey, $getRoot, $getSelection, $isRangeSelection, $isRootOrShadowRoot, $parseSerializedNode, HISTORY_MERGE_TAG,
  type LexicalEditor, type LexicalNode, type SerializedLexicalNode,
} from 'lexical';
import { pasteGate } from './paste-gate.ts';

/** Serialized characters per batch: a batch's sync frame stays a few hundred KB. */
export const PASTE_BATCH_CHARS = 120_000;

/** Groups top-level blocks into batches of about PASTE_BATCH_CHARS serialized characters; a block never splits. */
export function batchPasteBlocks(blocks: SerializedLexicalNode[], limit = PASTE_BATCH_CHARS): SerializedLexicalNode[][] {
  const batches: SerializedLexicalNode[][] = [];
  let current: SerializedLexicalNode[] = [];
  let size = 0;
  for (const block of blocks) {
    const length = JSON.stringify(block).length;
    if (current.length > 0 && size + length > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

interface CollabUndo {
  stopCapturing(): void;
  captureTimeout?: number;
  /** BodyUndo (host/collab/undo.ts) keeps its capture window on the note's own UndoManager. */
  root?: { captureTimeout: number };
}

const collabUndo = (editor: LexicalEditor): CollabUndo | undefined =>
  (editor as LexicalEditor & Record<symbol, CollabUndo | undefined>)[COLLAB_UNDO_MANAGER];

const attached = (key: string | null): LexicalNode | null => {
  const node = key === null ? null : $getNodeByKey(key);
  return node && node.isAttached() ? node : null;
};

const nextTask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

export interface BatchedPaste {
  /** The paste job is still the editor's current one. */
  current(): boolean;
  /**
   * Inside the paste's own update: inserts the first batch followed by the paste's last block at the caret, as one
   * insertion of every block would place them; false when it could not.
   */
  $insertEnds(nodes: LexicalNode[]): boolean;
  /** Puts the caret after the paste once every batch is in. */
  $caretAfter(last: LexicalNode | null): void;
}

/**
 * Pastes `batches` (more than one): the first batch and the last block go in with the paste command's own update
 * (an update called from a command runs when the command's does); the blocks between follow, a batch per update,
 * before the last block.
 */
export function pasteInBatches(editor: LexicalEditor, batches: SerializedLexicalNode[][], paste: BatchedPaste): void {
  const lastBatch = batches[batches.length - 1];
  const lastBlock = lastBatch[lastBatch.length - 1];
  const middle = [...batches.slice(1, -1), lastBatch.slice(0, -1)].filter((batch) => batch.length > 0);
  const undo = collabUndo(editor);
  // The paste is its own undo step, apart from any typing just before it.
  undo?.stopCapturing();
  const at = { inserted: false, last: null as string | null, anchor: null as string | null };
  editor.update(
    () => {
      const nodes = [...batches[0], lastBlock].map((block) => $parseSerializedNode(block));
      if (!paste.$insertEnds(nodes)) return;
      at.inserted = true;
      const last = nodes[nodes.length - 1];
      at.last = last.isAttached() ? last.getKey() : null;
      at.anchor = last.getPreviousSibling()?.getKey() ?? null;
    },
    { discrete: true },
  );
  if (middle.length === 0) return;

  // Each later batch goes in after the block the last one ended with, so typing or a peer's edit meanwhile never moves
  // it; neither offsets nor the caret are tracked per block, which keeps a batch linear in its own size.
  const $place = (nodes: LexicalNode[]) => {
    let anchor = attached(at.anchor) ?? attached(at.last)?.getPreviousSibling() ?? null;
    if (!anchor) {
      const head = nodes.shift();
      if (!head) return;
      const last = attached(at.last);
      if (last) last.insertBefore(head, false);
      else $getRoot().append(head);
      anchor = head;
    }
    for (const node of nodes) anchor = anchor.insertAfter(node, false);
    at.anchor = anchor.getKey();
  };

  void (async () => {
    const timed = undo ? (undo.root ?? (undo as { captureTimeout: number })) : null;
    const saved = timed?.captureTimeout ?? 0;
    try {
      for (const [index, batch] of middle.entries()) {
        await nextTask();
        await pasteGate(editor);
        if (!at.inserted || !paste.current() || !editor.isEditable()) return;
        // Every batch joins the first one's undo step, however long the acks take.
        if (timed) timed.captureTimeout = Number.POSITIVE_INFINITY;
        editor.update(
          () => {
            $place(batch.map((block) => $parseSerializedNode(block)));
            if (index === middle.length - 1) paste.$caretAfter(attached(at.last));
          },
          { discrete: true, ...(undo ? {} : { tag: HISTORY_MERGE_TAG }) },
        );
      }
    } finally {
      if (timed) timed.captureTimeout = saved;
      undo?.stopCapturing();
    }
  })();
}

/** The caret after a pasted block that is not a text container sits on its parent; blocks inserted before it moved
 * that offset, so it is placed again. */
export function $caretAfterBlock(last: LexicalNode | null): void {
  const selection = $getSelection();
  if (last && $isRangeSelection(selection) && selection.anchor.type === 'element' && $isRootOrShadowRoot(selection.anchor.getNode())) {
    last.selectEnd();
  }
}

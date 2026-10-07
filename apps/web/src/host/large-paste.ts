// T3.S6 (DEVIATIONS 22): a large markdown paste lands whole, in one update. Moss at the pin split the text into
// 12,000-character chunks and dropped every chunk after the first. Here the paste is parsed once, off the live editor,
// and its blocks go in with one update: one undo step that redoes whole, and nothing left pending that a second paste,
// a closed pane or an undo could cut short. The doc socket sends the resulting large update in acked pieces
// (host/collab/outbox.ts).
import { $parseSerializedNode, type LexicalEditor, type LexicalNode, type SerializedLexicalNode } from 'lexical';

const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

const collabUndo = (editor: LexicalEditor): { stopCapturing(): void } | undefined =>
  (editor as LexicalEditor & Record<symbol, { stopCapturing(): void } | undefined>)[COLLAB_UNDO_MANAGER];

/**
 * Inserts the parsed `blocks` with `$insert`, inside one discrete update, as an undo step of its own: typing just
 * before or right after it never joins it.
 */
export function pasteBlocks(editor: LexicalEditor, blocks: SerializedLexicalNode[], $insert: (nodes: LexicalNode[]) => void): void {
  const undo = collabUndo(editor);
  undo?.stopCapturing();
  editor.update(() => $insert(blocks.map((block) => $parseSerializedNode(block))), { discrete: true });
  undo?.stopCapturing();
}

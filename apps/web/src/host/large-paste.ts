// T3.S6 (DEVIATIONS 22): a large markdown paste lands whole, in one update. Moss at the pin split the text into
// 12,000-character chunks and dropped every chunk after the first. Here the paste is parsed once, off the live editor,
// and its blocks go in with one update: one undo step that redoes whole, and nothing left pending that a second paste,
// a closed pane or an undo could cut short. The doc socket sends the resulting large update in acked pieces
// (host/collab/outbox.ts).
import { createBinding, syncLexicalUpdateToYjs, type Provider } from '@lexical/yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import {
  $createParagraphNode, $createTabNode, $getRoot, $getSelection, $isRangeSelection, $parseSerializedNode, $setSelection,
  createEditor, tokenizeRawText, type BaseSelection, type LexicalEditor, type LexicalNode, type RangeSelection,
  type SerializedLexicalNode,
} from 'lexical';
import * as Y from 'yjs';
import { WRITE_REFUSED } from './collab/doc-session.ts';
import { refuseInput } from './refusal.ts';

const COLLAB_UNDO_MANAGER = Symbol.for('@lexical/yjs/UndoManager');

/** Y.UndoManager, or the host's BodyUndo around one (`root`). */
type CollabUndo = { stopCapturing(): void; doc?: Y.Doc; root?: { doc: Y.Doc } };

const collabUndo = (editor: LexicalEditor): CollabUndo | undefined =>
  (editor as LexicalEditor & Record<symbol, CollabUndo | undefined>)[COLLAB_UNDO_MANAGER];

const noop = () => {};
const quiet = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** Binds the paste's parser to a scratch Y.Doc as a note's binding writes; the reader gives the bytes it then holds. */
export function measureEncoded(parser: LexicalEditor): () => number {
  const doc = new Y.Doc();
  const binding = createBinding(parser, quiet, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(parser));
  const stop = parser.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, quiet, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  return () => {
    stop();
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    doc.destroy();
    return bytes;
  };
}

/** The bytes `text` encodes to in a note when pasted as plain text, as Lexical's own paste inserts it. */
export function plainTextBytes(editor: LexicalEditor, text: string): number {
  const scratch = createEditor({
    namespace: 'moss-multi-paste-size',
    nodes: [...editor._nodes.values()].map((entry) => entry.klass),
    onError: (error) => {
      throw error;
    },
  });
  const encoded = measureEncoded(scratch);
  scratch.update(() => {
    const paragraph = $createParagraphNode();
    $getRoot().append(paragraph);
    paragraph.select();
    // Lexical's plain-text importer (@lexical/clipboard): a paragraph per line break.
    const at = (run: (selection: RangeSelection) => void) => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) run(selection);
    };
    tokenizeRawText(text, {
      linebreak: () => at((selection) => selection.insertParagraph()),
      tab: () => at((selection) => selection.insertNodes([$createTabNode()])),
      text: (part) => at((selection) => selection.insertText(part)),
    });
  }, { discrete: true });
  return encoded();
}

/**
 * A paste that would take the note past its state cap (A§5.1) is refused whole, visibly: sent, the DocDO would take
 * its first pieces and refuse the rest. A little headroom covers what the estimate leaves out.
 */
export function refusedOverCap(editor: LexicalEditor, bytes: number): boolean {
  const undo = collabUndo(editor);
  const doc = undo?.root?.doc ?? undo?.doc;
  if (!doc || Y.encodeStateAsUpdate(doc).byteLength + bytes <= STATE_CAP_BYTES * 0.97) return false;
  refuseInput(WRITE_REFUSED['doc-cap']);
  return true;
}

/**
 * Inserts the parsed `blocks` with `$insert`, inside one discrete update, as an undo step of its own: typing just
 * before or right after it never joins it.
 */
export function pasteBlocks(editor: LexicalEditor, blocks: SerializedLexicalNode[], $insert: (nodes: LexicalNode[]) => void): void {
  const undo = collabUndo(editor);
  undo?.stopCapturing();
  // From a paste command the update commits when the command's own does, so capturing stops once it has.
  editor.update(() => $insert(blocks.map((block) => $parseSerializedNode(block))), {
    discrete: true,
    onUpdate: () => undo?.stopCapturing(),
  });
}

/** An empty note's content becomes `nodes`, caret at the end. One append per block: a spread of 150,000 overflows. */
export function $replaceEmptyNote(nodes: LexicalNode[]): void {
  $setSelection(null);
  const root = $getRoot();
  root.clear();
  for (const node of nodes) root.append(node);
  root.selectEnd();
}

/**
 * Inserts the fresh top-level `nodes` at `selection` as `insert` (Lexical's) would, in time linear in the blocks.
 * Lexical moves each block after the previous one, and every move pays getIndexWithinParent(), so 100,000 short
 * paragraphs froze the tab. `insert` places the first, second and last blocks, which settles every merge with the
 * text around the caret; the blocks between follow the second, unmoved, with no selection to keep up per block.
 */
export function $insertBlocks(nodes: LexicalNode[], selection: BaseSelection, insert: (nodes: LexicalNode[], selection: BaseSelection) => void): void {
  if (nodes.length <= 3) {
    insert(nodes, selection);
    return;
  }
  const [first, second] = nodes;
  const last = nodes[nodes.length - 1];
  const middle = nodes.slice(2, -1);
  insert([first, second, last], selection);
  const parent = second.isAttached() ? second.getParent() : null;
  if (parent === null) {
    // Nothing placed the second block (a command took the insert): the rest goes before the last, or at the end.
    if (last.isAttached()) for (const node of middle) last.insertBefore(node, false);
    else for (const node of middle) $getRoot().append(node);
    return;
  }
  const index = second.getIndexWithinParent();
  let previous = second;
  for (const node of middle) previous = previous.insertAfter(node, false);
  // insertAfter(…, false) leaves element points alone; one past the second block moves down by the blocks added.
  const after = $getSelection();
  if (!$isRangeSelection(after)) return;
  for (const point of [after.anchor, after.focus]) {
    if (point.type === 'element' && point.key === parent.getKey() && point.offset > index) {
      point.set(point.key, point.offset + middle.length, 'element');
    }
  }
}

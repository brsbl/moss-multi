// T3.S6: a large paste's blocks go in as Lexical's insert puts them, in time linear in the blocks. Lexical moves each
// pasted block after the previous one, and every move pays getIndexWithinParent(), so 40,000 short paragraphs took
// half a minute to insert and 100,000 froze the tab; and an empty note took its blocks in one append() whose spread
// overflowed the stack past about 125,000 arguments.
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection,
  createEditor, type BaseSelection, type LexicalEditor, type LexicalNode,
} from 'lexical';
import { expect, it } from 'vitest';
import { $insertBlocks, $replaceEmptyNote } from './large-paste';

const lexicalInsert = (nodes: LexicalNode[], selection: BaseSelection) => selection.insertNodes(nodes);

function note(paragraphs: string[]): LexicalEditor {
  const editor = createEditor({ namespace: 'paste', onError: (error) => { throw error; } });
  editor.update(() => {
    $getRoot().append(...paragraphs.map((text) => $createParagraphNode().append(...(text ? [$createTextNode(text)] : []))));
  }, { discrete: true });
  return editor;
}

const blocks = (count: number, prefix = 'p') =>
  Array.from({ length: count }, (_, i) => $createParagraphNode().append($createTextNode(`${prefix}${i}`)));

/** The note's paragraphs and the caret as [paragraph index, text offset] for anchor and focus. */
function read(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const paragraphs = $getRoot().getChildren().map((block) => block.getTextContent());
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return { paragraphs, caret: null };
    const where = (point: typeof selection.anchor) => [point.getNode().getTopLevelElementOrThrow().getIndexWithinParent(), point.type, point.offset];
    return { paragraphs, caret: [where(selection.anchor), where(selection.focus)] };
  });
}

/** Pastes `count` paragraphs at the caret `select` makes in `paragraphs`, with `insert`; returns what results. */
function paste(paragraphs: string[], select: () => void, count: number, insert: (nodes: LexicalNode[]) => void) {
  const editor = note(paragraphs);
  editor.update(() => {
    select();
    insert(blocks(count));
  }, { discrete: true });
  return read(editor);
}

const CARETS: [string, string[], () => void][] = [
  ['mid-paragraph', ['Before.', 'After.'], () => $getRoot().getFirstChildOrThrow().getFirstDescendant()!.select(3, 3)],
  ['end of a paragraph', ['Before.', 'After.'], () => $getRoot().getFirstChildOrThrow().selectEnd()],
  ['start of a paragraph', ['Before.', 'After.'], () => $getRoot().getLastChildOrThrow().selectStart()],
  ['an empty paragraph', ['Before.', '', 'After.'], () => $getRoot().getChildAtIndex(1)!.selectStart()],
  ['the only, empty paragraph', [''], () => $getRoot().selectEnd()],
  ['a selected range', ['Before.', 'Middle.', 'After.'], () => {
    const selection = $createRangeSelection();
    selection.anchor.set($getRoot().getFirstChildOrThrow().getFirstDescendant()!.getKey(), 2, 'text');
    selection.focus.set($getRoot().getChildAtIndex(1)!.getFirstDescendant()!.getKey(), 3, 'text');
    $setSelection(selection);
  }],
];

it('puts the blocks and the caret where Lexical’s insert of all of them does', () => {
  for (const [name, paragraphs, select] of CARETS) {
    for (const count of [1, 2, 3, 4, 7]) {
      const want = paste(paragraphs, select, count, (nodes) => lexicalInsert(nodes, $getSelection()!));
      const got = paste(paragraphs, select, count, (nodes) => $insertBlocks(nodes, $getSelection()!, lexicalInsert));
      expect(got, `${count} blocks at ${name}`).toEqual(want);
    }
  }
});

it('replaces an empty note with the blocks, caret at the end', () => {
  const editor = note(['']);
  editor.update(() => $replaceEmptyNote(blocks(3)), { discrete: true });
  expect(read(editor)).toEqual({ paragraphs: ['p0', 'p1', 'p2'], caret: [[2, 'text', 2], [2, 'text', 2]] });
});

function timed(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

it('inserts 100,000 blocks mid-note and fills an empty note with 200,000, in time linear in the blocks', { timeout: 300_000 }, () => {
  const mid = (count: number) => {
    const editor = note(['Before.', 'After.']);
    let ms = 0;
    editor.update(() => {
      $getRoot().getFirstChildOrThrow().selectEnd();
      const nodes = blocks(count);
      ms = timed(() => $insertBlocks(nodes, $getSelection()!, lexicalInsert));
    }, { discrete: true });
    expect(editor.getEditorState().read(() => $getRoot().getChildrenSize())).toBe(count + 1);
    return ms;
  };
  mid(1_000);
  const small = mid(25_000);
  const large = mid(100_000);
  expect(large, `25,000 blocks took ${small.toFixed(0)} ms, 100,000 took ${large.toFixed(0)} ms`).toBeLessThanOrEqual(8 * small + 200);
  expect(large).toBeLessThan(10_000);

  const editor = note(['']);
  editor.update(() => $replaceEmptyNote(blocks(200_000)), { discrete: true });
  expect(read(editor).paragraphs.length).toBe(200_000);
});

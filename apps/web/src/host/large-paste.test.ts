// T3.S6: a large paste's blocks go in as Lexical's insert puts them, in time linear in the blocks. Lexical moves each
// pasted block after the previous one, and every move pays getIndexWithinParent(), so 40,000 short paragraphs took
// half a minute to insert and 100,000 froze the tab; and an empty note took its blocks in one append() whose spread
// overflowed the stack past about 125,000 arguments.
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection, $isRangeSelection, $setSelection,
  createEditor, type BaseSelection, type ElementNode, type LexicalEditor, type LexicalNode, type TextNode,
} from 'lexical';
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list';
import { $createTableCellNode, $createTableNode, $createTableRowNode, TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { CLIENT_FRAME_MAX_BYTES } from '@moss-multi/protocol/limits';
import { encodePayloadFrame, PAYLOAD_UPDATE } from '@moss-multi/protocol/sync';
import { seedPayload } from '@moss-multi/sync/payload-docs';
import { MAP_REGISTERS } from '@moss-multi/sync/registers';
import {
  $insertBlocks, $keepElementPoints, $planPaste, $replaceEmptyNote, measurePayloads, Placer, type PastePlan, type PayloadSeed,
} from './large-paste.ts';

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
  ['mid-paragraph', ['Before.', 'After.'], () => $getRoot().getFirstChildOrThrow<ElementNode>().getFirstDescendant<TextNode>()!.select(3, 3)],
  ['end of a paragraph', ['Before.', 'After.'], () => $getRoot().getFirstChildOrThrow().selectEnd()],
  ['start of a paragraph', ['Before.', 'After.'], () => $getRoot().getLastChildOrThrow().selectStart()],
  ['an empty paragraph', ['Before.', '', 'After.'], () => $getRoot().getChildAtIndex(1)!.selectStart()],
  ['the only, empty paragraph', [''], () => $getRoot().selectEnd()],
  ['a selected range', ['Before.', 'Middle.', 'After.'], () => {
    const selection = $createRangeSelection();
    selection.anchor.set($getRoot().getFirstChildOrThrow<ElementNode>().getFirstDescendant()!.getKey(), 2, 'text');
    selection.focus.set($getRoot().getChildAtIndex<ElementNode>(1)!.getFirstDescendant()!.getKey(), 3, 'text');
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

// A paste lands in batches (Placer): the first units and the last at the caret, then the rest, each batch its own
// update. Whatever the shape, the note must end as Lexical's insert of the whole paste at once leaves it.

const NODES = [ListNode, ListItemNode, TableNode, TableRowNode, TableCellNode];

const text = (value: string) => $createParagraphNode().append($createTextNode(value));
const item = (value: string, inner?: ListNode) => {
  const node = $createListItemNode();
  return inner ? node.append(inner) : node.append($createTextNode(value));
};
const list = (type: 'bullet' | 'number', items: ListItemNode[]) => $createListNode(type).append(...items);

/** Items, each but the deepest followed by an item holding a nested list, as Lexical models nesting. */
const nested = (prefix: string, count: number, depth: number): ListItemNode[] => {
  const items: ListItemNode[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push(item(`${prefix}${i}`));
    if (depth > 0) items.push(item('', list('bullet', nested(`${prefix}${i}.`, 3, depth - 1))));
  }
  return items;
};

const table = (rows: number) => $createTableNode().append(...Array.from({ length: rows }, (_, i) =>
  $createTableRowNode().append(...[0, 1].map((c) => $createTableCellNode().append(text(`r${i}c${c}`))))));

const SHAPES: [string, () => LexicalNode[]][] = [
  ['one long list', () => [list('bullet', Array.from({ length: 400 }, (_, i) => item(`i${i}`)))]],
  ['a nested numbered list', () => [list('number', nested('n', 40, 2))]],
  ['a long table', () => [table(150)]],
  ['blocks, then lists of one type apart', () => [
    text('lead'), list('bullet', Array.from({ length: 200 }, (_, i) => item(`a${i}`))), text('between'),
    list('bullet', Array.from({ length: 200 }, (_, i) => item(`b${i}`))),
  ]],
  ['many paragraphs ending in a list', () => [
    ...Array.from({ length: 300 }, (_, i) => text(`p${i}`)), list('number', Array.from({ length: 50 }, (_, i) => item(`e${i}`))),
  ]],
];

const editorWith = (paragraphs: string[]) => {
  const editor = createEditor({ namespace: 'paste', nodes: NODES, onError: (error) => { throw error; } });
  editor.update(() => {
    $getRoot().append(...paragraphs.map((value) => $createParagraphNode().append(...(value ? [$createTextNode(value)] : []))));
  }, { discrete: true });
  return editor;
};

/** The paste's plan, from a parser editor holding `shape`. */
function planOf(shape: () => LexicalNode[], unitCost: number): PastePlan {
  const parser = createEditor({ namespace: 'parse', nodes: NODES, onError: (error) => { throw error; } });
  parser.update(() => { $getRoot().clear().append(...shape()); }, { discrete: true });
  const state = parser.getEditorState();
  const json = state.toJSON().root.children;
  return state.read(() => $planPaste($getRoot().getChildren(), json, unitCost));
}

/** A node's position as child indices from the root. */
const pathOf = (node: LexicalNode): number[] => {
  const path: number[] = [];
  for (let at: LexicalNode | null = node; at && at.getParent(); at = at.getParent()) path.unshift(at.getIndexWithinParent());
  return path;
};

/** The note as JSON, and its caret as paths. */
function snapshot(editor: LexicalEditor) {
  return editor.getEditorState().read(() => {
    const selection = $getSelection();
    const caret = $isRangeSelection(selection)
      ? [selection.anchor, selection.focus].map((point) => [...pathOf(point.getNode()), point.type, point.offset])
      : null;
    return { note: editor.getEditorState().toJSON(), caret };
  });
}

it('lands a paste in batches as Lexical’s insert of all of it at once leaves the note, for lists, nested lists and tables', () => {
  for (const [shapeName, shape] of SHAPES) {
    for (const [caretName, paragraphs, select] of CARETS) {
      const once = editorWith(paragraphs);
      once.update(() => {
        select();
        lexicalInsert(shape(), $getSelection()!);
      }, { discrete: true });

      const plan = planOf(shape, 8);
      expect(plan.units.length, `${shapeName}: many units`).toBeGreaterThan(20);
      const batched = editorWith(paragraphs);
      const placer = new Placer(plan);
      batched.update(() => {
        select();
        placer.$first(30, (nodes) => $insertBlocks(nodes, $getSelection()!, lexicalInsert));
      }, { discrete: true });
      let batches = 1;
      while (!placer.done) {
        batched.update(() => $keepElementPoints(() => placer.$next(30)), { discrete: true });
        batches += 1;
      }
      expect(batches, `${shapeName}: several batches`).toBeGreaterThan(3);
      expect(snapshot(batched), `${shapeName} at ${caretName}`).toEqual(snapshot(once));
    }
  }
});

it('fills an empty note in batches as one replacement does', () => {
  for (const [shapeName, shape] of SHAPES) {
    const once = editorWith(['']);
    once.update(() => $replaceEmptyNote(shape()), { discrete: true });
    const batched = editorWith(['']);
    const placer = new Placer(planOf(shape, 8));
    batched.update(() => placer.$first(30, $replaceEmptyNote), { discrete: true });
    while (!placer.done) batched.update(() => placer.$next(30), { discrete: true });
    expect(snapshot(batched), shapeName).toEqual(snapshot(once));
  }
});

it('splits only lists, list items and tables, by whole rows, and counts no payloads where there are none', () => {
  const plan = planOf(() => [text('x'.repeat(5_000)), list('bullet', Array.from({ length: 100 }, (_, i) => item(`i${i}`))), table(40)], 16);
  const types = plan.units.map((unit) => unit.json.type);
  expect(types[0], 'a long paragraph stays one unit').toBe('paragraph');
  expect(types.filter((type) => type === 'listitem')).toHaveLength(100);
  expect(types.filter((type) => type === 'tablerow'), 'a table lands by whole rows').toHaveLength(40);
  expect(plan.payloads).toEqual([]);
});

const drain = <T>(steps: Generator<void, T>): T => {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
};

/** A payload's first frame, as PayloadSync sends it. */
function firstFrame(seed: PayloadSeed): number {
  const doc = new Y.Doc();
  let bytes = 0;
  doc.on('update', (update: Uint8Array) => {
    bytes = encodePayloadFrame('0'.repeat(32), PAYLOAD_UPDATE, update).byteLength;
  });
  seedPayload(doc, seed, null);
  return bytes;
}

it('measures payloads as their first frames encode them: a chart’s keys several times its JSON, past the frame cap', () => {
  const small = MAP_REGISTERS.chart.encode({ __config: { type: 'bar', data: [{ label: 'Mon', value: 12 }, { label: 'Tue', value: 18 }] } });
  const code = 'const value = 1;\n'.repeat(2_000);
  expect(drain(measurePayloads([small, code]))).toEqual({ bytes: firstFrame(small) + firstFrame(code), largest: firstFrame(code) });

  // A bar chart of 30,000 {label:'x',value:1} points: about 720 KB of JSON, under the frame cap, and over 4 MB of keys.
  const config = { type: 'bar', data: Array.from({ length: 30_000 }, () => ({ label: 'x', value: 1 })) };
  expect(JSON.stringify(config).length).toBeLessThan(CLIENT_FRAME_MAX_BYTES);
  const { largest } = drain(measurePayloads([MAP_REGISTERS.chart.encode({ __config: config })]));
  expect(largest, 'the chart cannot go in one frame').toBeGreaterThan(CLIENT_FRAME_MAX_BYTES);
});

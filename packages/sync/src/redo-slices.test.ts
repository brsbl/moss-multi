// T3.S6: a paste that landed in batches redoes in slices (BodyUndo.redoInSlices). Pasting it again as a new edit
// made items the later steps of the redo chain do not follow, so text typed after the paste never came back on redo.
// Each slice here is a Yjs redo of part of the step, within the frame cap, containers before what they hold; the
// redo chain after it still redoes, and the slices are one undo step again.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { CLIENT_FRAME_MAX_BYTES } from '@moss-multi/protocol/limits';
import { $getRoot, $isTextNode, $parseSerializedNode, type LexicalEditor } from 'lexical';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { BodyUndo } from './payload-docs.ts';
import { exportDocMarkdown } from './server-doc.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

function peer() {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  root.observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  });
  const undo = new BodyUndo(new Y.UndoManager(root, { trackedOrigins: new Set([binding]), captureTimeout: 0 }));
  editor.update(noop, { discrete: true });
  return { doc, editor, undo };
}

const commit = (editor: LexicalEditor) => editor.update(noop, { discrete: true });
const text = (editor: LexicalEditor) => editor.getEditorState().read(() => $getRoot().getTextContent());

/** Paragraphs, a long list, a nested list and a table, ending in a paragraph `Last.`. */
function pasteMarkdown(): string {
  const paragraphs = Array.from({ length: 1_500 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
  const list = Array.from({ length: 2_000 }, (_, i) => `- item ${i}`).join('\n');
  const nested = Array.from({ length: 400 }, (_, i) => `- outer ${i}\n  - inner ${i}\n    - deeper ${i}`).join('\n');
  const table = ['| A | B |', '| --- | --- |', ...Array.from({ length: 300 }, (_, i) => `| r${i} | v${i} |`)].join('\n');
  return [paragraphs, list, 'Between.', nested, 'Between again.', table, 'Last.'].join('\n\n');
}

it('redoes a batched paste in slices under the frame cap, keeps the redo chain after it, and undoes it as one step', { timeout: 300_000 }, () => {
  const ada = peer();
  const ben = peer();
  ada.doc.on('update', (update: Uint8Array) => Y.applyUpdate(ben.doc, update, 'remote'));
  ada.editor.update(() => $importNoteBody('Start.'), { discrete: true });
  ada.undo.clear();
  const empty = exportDocMarkdown(ada.doc);

  ada.editor.update(() => $importNoteBody(pasteMarkdown()), { discrete: true });
  const pasted = exportDocMarkdown(ada.doc);
  const pastedText = text(ada.editor);
  expect(pasted).toContain('Last.');
  // The paste's step, stamped as large-paste.ts stamps a paste that landed in batches.
  const paste = {};
  (ada.undo.undoStack.at(-1) as { stamp: unknown }).stamp = paste;

  // Typing after the paste, its own step, in the paste's last paragraph.
  ada.undo.stopCapturing();
  ada.editor.update(() => {
    const last = $getRoot().getLastDescendant();
    if (!$isTextNode(last)) throw new Error('the paste ends in text');
    last.spliceText(last.getTextContentSize(), 0, 'Z');
  }, { discrete: true });
  const typed = exportDocMarkdown(ada.doc);
  expect(typed).toContain('Last.Z');

  ada.undo.undo();
  commit(ada.editor);
  ada.undo.undo();
  commit(ada.editor);
  expect(exportDocMarkdown(ada.doc), 'two undos remove the typing, then the paste').toBe(empty);
  expect(ada.undo.redoInSlices({}), 'only the stamped step redoes in slices').toBeNull();

  const sizes: number[] = [];
  const onUpdate = (update: Uint8Array) => sizes.push(update.byteLength);
  ada.doc.on('update', onUpdate);
  const slices = ada.undo.redoInSlices(paste)!;
  expect(slices).not.toBeNull();
  let count = 0;
  while (!slices.done) {
    slices.next(300, 256 * 1024);
    commit(ada.editor);
    commit(ben.editor);
    count += 1;
  }
  slices.finish();
  ada.doc.off('update', onUpdate);
  commit(ada.editor);
  commit(ben.editor);
  expect(count, 'the redo went in many slices').toBeGreaterThan(10);
  expect(Math.max(...sizes), 'no slice encodes past the frame cap').toBeLessThanOrEqual(CLIENT_FRAME_MAX_BYTES);
  expect(exportDocMarkdown(ada.doc), 'the sliced redo restores the whole paste').toBe(pasted);
  expect(text(ada.editor)).toBe(pastedText);
  expect(exportDocMarkdown(ben.doc), 'a peer gets the whole paste').toBe(pasted);
  expect(text(ben.editor)).toBe(pastedText);

  ada.undo.redo();
  commit(ada.editor);
  expect(exportDocMarkdown(ada.doc), 'the next redo brings the typing back').toBe(typed);

  ada.undo.undo();
  commit(ada.editor);
  expect(exportDocMarkdown(ada.doc)).toBe(pasted);
  ada.undo.undo();
  commit(ada.editor);
  expect(exportDocMarkdown(ada.doc), 'one undo removes the slices together').toBe(empty);
  expect(ada.undo.canUndo()).toBe(false);

  // Its redo is sliced again; input meanwhile lands the rest at once (finish).
  const again = ada.undo.redoInSlices(paste)!;
  again.next(300, 256 * 1024);
  again.finish();
  commit(ada.editor);
  commit(ben.editor);
  expect(again.done).toBe(true);
  expect(exportDocMarkdown(ada.doc)).toBe(pasted);
  expect(exportDocMarkdown(ben.doc)).toBe(pasted);
  ada.undo.redo();
  commit(ada.editor);
  expect(exportDocMarkdown(ada.doc), 'the chain survives a second sliced redo').toBe(typed);
});

it('redoes a paste in slices where peers have moved it: a block a peer added above, and text a peer typed beside it', { timeout: 120_000 }, () => {
  const ada = peer();
  const ben = peer();
  ada.doc.on('update', (update: Uint8Array) => Y.applyUpdate(ben.doc, update, 'remote'));
  ben.doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(ada.doc, update, 'remote');
  });
  ada.editor.update(() => $importNoteBody('Top.\n\nHello here.\n\nTail.'), { discrete: true });
  commit(ben.editor);
  ada.undo.stopCapturing();
  ada.undo.clear();

  // Ada pastes 2,000 paragraphs after "Hello here."; a stamped step, as one that landed in batches.
  ada.editor.update(() => {
    const hello = $getRoot().getChildAtIndex(1)!;
    let previous = hello;
    const parsed = createConverterEditor();
    parsed.update(() => $importNoteBody(Array.from({ length: 2_000 }, (_, i) => `Line ${i}.`).join('\n\n')), { discrete: true });
    const json = parsed.getEditorState().toJSON().root.children;
    for (const child of json) {
      const node = $parseSerializedNode(child);
      previous = previous.insertAfter(node, false);
    }
  }, { discrete: true });
  commit(ben.editor);
  const paste = {};
  (ada.undo.undoStack.at(-1) as { stamp: unknown }).stamp = paste;
  ada.undo.undo();
  commit(ada.editor);
  commit(ben.editor);

  // Ben adds a block above and types before "Hello".
  ben.editor.update(() => {
    const top = $getRoot().getFirstChild()!;
    const hello = top.getNextSibling()!;
    const first = hello.getFirstDescendant();
    if ($isTextNode(first)) first.spliceText(0, 0, 'XY');
    const parsed = createConverterEditor();
    parsed.update(() => $importNoteBody('Ben’s line.'), { discrete: true });
    top.insertAfter($parseSerializedNode(parsed.getEditorState().toJSON().root.children[0]), false);
  }, { discrete: true });
  commit(ada.editor);

  const slices = ada.undo.redoInSlices(paste)!;
  while (!slices.done) {
    slices.next(150, 256 * 1024);
    commit(ada.editor);
  }
  slices.finish();
  commit(ada.editor);
  commit(ben.editor);
  const lines = Array.from({ length: 2_000 }, (_, i) => `Line ${i}.`).join('\n\n');
  const want = exportDocMarkdown(importDoc(`Top.\n\nBen’s line.\n\nXYHello here.\n\n${lines}\n\nTail.`));
  expect(exportDocMarkdown(ada.doc), 'the redo lands after the paragraph it followed, below the peer’s block').toBe(want);
  expect(exportDocMarkdown(ben.doc)).toBe(want);
});

/** A note imported as the server imports it, for the expected export. */
function importDoc(markdown: string): Y.Doc {
  const { doc, editor } = peer();
  editor.update(() => $importNoteBody(markdown), { discrete: true });
  return doc;
}

// Cmd+Z on a lean doc (A§10.11) with a peer still on the earlier binding: undoing the write that first stored a key
// leaves the class default in it, so the older peer, which reads a changed key as is, holds the same node.
import * as lean from '@lexical/yjs';
import type { Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, type ElementNode, type TextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindRegisters } from '@moss-multi/sync/registers';
import * as v1 from '../../../../../packages/sync/test/fixtures/lexical-yjs-v1/index.mjs';
import { isOwnOrigin, syncUnderOrigin } from './origins.ts';
import { createBindingUndoManager } from './undo.ts';

const LAYOUTS = { lean, v1: v1 as typeof lean } as const;
const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
type Nodes = { paragraph: { format: number; indent: number }; text: { format: number; style: string; mode: number } };

function peer(layout: keyof typeof LAYOUTS, seed?: Y.Doc) {
  const yjs = LAYOUTS[layout];
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding = yjs.createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncUnderOrigin(binding, tags, () => yjs.syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags));
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (!isOwnOrigin(transaction.origin, binding)) yjs.syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  };
  root.observeDeep(observer);
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  editor.update(noop, { discrete: true });
  const undo = createBindingUndoManager(binding);
  const step = (fn: () => void) => { editor.update(fn, { discrete: true }); undo.stopCapturing(); };
  /** The paragraph and its text run as the node holds them, not as an export would round them. */
  const nodes = (): Nodes => editor.read(() => {
    const paragraph = $getRoot().getFirstChild() as ElementNode; const text = paragraph.getFirstChild() as TextNode;
    return { paragraph: { format: paragraph.__format, indent: paragraph.__indent }, text: { format: text.__format, style: text.__style, mode: text.__mode } };
  });
  return { doc, undo, step, nodes, dispose: () => { undo.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}
type Peer = ReturnType<typeof peer>;

async function exchange(...peers: Peer[]) {
  for (let round = 0; round < 2; round++) {
    for (const from of peers) for (const to of peers) if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
    await settle();
  }
}
const run = (doc: Y.Doc) => {
  const block = (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0]!.insert as Y.XmlText;
  return (block.toDelta() as { insert: unknown }[]).map(op => op.insert).find((insert): insert is Y.Map<unknown> => insert instanceof Y.Map)!;
};
const text = () => ($getRoot().getFirstChild() as ElementNode).getFirstChild() as TextNode;
const paragraph = () => $getRoot().getFirstChild() as ElementNode;
const PLAIN: Nodes = { paragraph: { format: 0, indent: 0 }, text: { format: 0, style: '', mode: 0 } };

/** Ada on the lean binding, Ben on the earlier one, on a plain paragraph a third lean client wrote. */
async function mixed() {
  const seeder = peer('lean');
  seeder.step(() => $getRoot().append($createParagraphNode().append($createTextNode('Plain words.'))));
  expect([...run(seeder.doc).keys()], 'the seed stores the run\'s type alone').toEqual(['__type']);
  const ada = peer('lean', seeder.doc); const ben = peer('v1', seeder.doc);
  await settle();
  return { ada, ben, dispose: () => { ada.dispose(); ben.dispose(); seeder.dispose(); } };
}
async function expectBoth(ada: Peer, ben: Peer, expected: Nodes, step: string) {
  await exchange(ada, ben);
  expect(ada.nodes(), `${step}: Ada (lean)`).toEqual(expected);
  expect(ben.nodes(), `${step}: Ben (earlier binding) holds the same nodes`).toEqual(expected);
}

describe('T3.B31b undo across a key\'s first write keeps the default stored @p:col-1 @p:col-3', () => {
  it('undo and redo of a run\'s first bold and first color, and a paragraph\'s first alignment, read the same on an older peer', async () => {
    const { ada, ben, dispose } = await mixed();
    try {
      await expectBoth(ada, ben, PLAIN, 'opened');
      ada.step(() => { text().toggleFormat('bold'); });
      const bold = { ...PLAIN, text: { ...PLAIN.text, format: 1 } };
      await expectBoth(ada, ben, bold, 'bold');
      ada.step(() => { text().setStyle('color: red'); });
      const red = { ...bold, text: { ...bold.text, style: 'color: red' } };
      await expectBoth(ada, ben, red, 'color');
      ada.step(() => { paragraph().setFormat('center'); });
      const centered = { ...red, paragraph: { ...red.paragraph, format: 2 } };
      await expectBoth(ada, ben, centered, 'centered');
      ada.undo.undo();
      await expectBoth(ada, ben, red, 'undo the alignment');
      ada.undo.undo();
      await expectBoth(ada, ben, bold, 'undo the color');
      ada.undo.undo();
      await expectBoth(ada, ben, PLAIN, 'undo the bold');
      expect(Object.fromEntries(run(ada.doc).entries()), 'the run keeps its keys at their defaults').toEqual({ __type: 'text', __format: 0, __style: '' });
      ada.undo.redo();
      await expectBoth(ada, ben, bold, 'redo the bold');
      ada.undo.redo();
      await expectBoth(ada, ben, red, 'redo the color');
      ada.undo.redo();
      await expectBoth(ada, ben, centered, 'redo the alignment');
      ada.undo.undo(); ada.undo.undo(); ada.undo.undo();
      await expectBoth(ada, ben, PLAIN, 'undo all three again');
      ada.undo.redo(); ada.undo.redo(); ada.undo.redo();
      await expectBoth(ada, ben, centered, 'redo all three again');
    } finally { dispose(); }
  });

  it('a peer\'s concurrent change to another property of the run survives the undo of a first bold', async () => {
    const { ada, ben, dispose } = await mixed();
    try {
      ada.step(() => { text().toggleFormat('bold'); });
      ben.step(() => { text().setStyle('color: blue'); });
      const both = { ...PLAIN, text: { ...PLAIN.text, format: 1, style: 'color: blue' } };
      await expectBoth(ada, ben, both, 'bold and color at once');
      ada.undo.undo();
      await expectBoth(ada, ben, { ...both, text: { ...both.text, format: 0 } }, 'undo the bold: the color stays');
      ada.undo.redo();
      await expectBoth(ada, ben, both, 'redo the bold');
    } finally { dispose(); }
  });

  it('an undo of a first bold that a peer rewrote meanwhile leaves the peer\'s value', async () => {
    const { ada, ben, dispose } = await mixed();
    try {
      ada.step(() => { text().toggleFormat('bold'); });
      await exchange(ada, ben);
      ben.step(() => { text().toggleFormat('italic'); });
      const both = { ...PLAIN, text: { ...PLAIN.text, format: 3 } };
      await expectBoth(ada, ben, both, 'Ben adds italic');
      ada.undo.undo();
      await expectBoth(ada, ben, both, 'Ada\'s undo cannot take back what Ben rewrote');
    } finally { dispose(); }
  });
});

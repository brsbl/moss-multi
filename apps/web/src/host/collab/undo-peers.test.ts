// Two editors wired as the vendored collaboration plugin wires them (A§10.2): Cmd+Z undoes only this client's edits
// and never deletes a peer's characters, whatever container (paragraph, text node) they were typed into.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import {
  $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection, type ElementNode, type TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from '@moss-multi/sync/converter';
import { excludedPropertiesFor } from '@moss-multi/sync/excluded-properties';
import { bindRegisters } from '@moss-multi/sync/registers';
import { isOwnOrigin, syncUnderOrigin } from './origins.ts';
import { createBindingUndoManager } from './undo.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function peer(seed?: Y.Doc) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncUnderOrigin(binding, tags, () => syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags));
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (!isOwnOrigin(transaction.origin, binding)) syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  };
  root.observeDeep(observer);
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  editor.update(noop, { discrete: true });
  const undo = createBindingUndoManager(binding);
  const text = () => editor.getEditorState().read(() => $getRoot().getTextContent());
  const step = (fn: () => void) => { editor.update(fn, { discrete: true }); undo.stopCapturing(); };
  return { doc, editor, undo, text, step, dispose: () => { undo.destroy(); stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); } };
}
type Peer = ReturnType<typeof peer>;

async function exchange(...peers: Peer[]) {
  for (let round = 0; round < 3; round++) {
    for (const from of peers) for (const to of peers) if (from !== to) Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc, Y.encodeStateVector(to.doc)));
    await settle();
  }
}
/** Ada and Ben, both opened on a note seeded by a third client, so neither owns the seed. */
async function pair(build: () => void) {
  const seeder = peer();
  seeder.editor.update(build, { discrete: true });
  const ada = peer(seeder.doc); const ben = peer(seeder.doc);
  await settle();
  return { ada, ben, dispose: () => { ada.dispose(); ben.dispose(); seeder.dispose(); } };
}
const paragraph = (index: number) => $getRoot().getChildAtIndex(index) as ElementNode;
const textAt = (index: number) => paragraph(index).getFirstChild() as TextNode;
/** Inserts at an offset of a paragraph's first text node, as typing there does. */
const typeAt = (index: number, offset: number, text: string) => () => textAt(index).spliceText(offset, 0, text);
/** Enter at an offset of a paragraph's first text node. */
const enterAt = (index: number, offset: number) => () => {
  textAt(index).select(offset, offset);
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) throw new Error('no range selection');
  selection.insertParagraph();
};
/** Backspace at the start of a paragraph: its children join the previous one. */
const mergeInto = (index: number) => () => {
  const merged = paragraph(index);
  paragraph(index - 1).append(...merged.getChildren());
  merged.remove();
};
const letters = (text: string) => [...text.replace(/\s/g, '')].sort().join('');

async function expectBoth(ada: Peer, ben: Peer, check: (text: string) => void) {
  await exchange(ada, ben);
  expect(ada.text(), 'the peers converge').toBe(ben.text());
  check(ada.text());
  const reopened = peer(ben.doc);
  try { await settle(); expect(reopened.text(), 'a later reader sees the same text').toBe(ben.text()); } finally { reopened.dispose(); }
}

describe('Cmd+Z undoes only your own edits and never removes a peer\'s characters @p:col-3', () => {
  it('interleaved typing: undoing a new line the peer added to keeps the peer\'s words; redo restores both', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    try {
      ada.step(() => $getRoot().append($createParagraphNode().append($createTextNode('Alpha.'))));
      await exchange(ada, ben);
      ben.step(typeAt(1, 6, ' Beta.'));
      await exchange(ada, ben);
      ada.step(typeAt(1, 12, ' Gamma.'));
      await exchange(ada, ben);
      expect(ada.text()).toBe('Intro.\n\nAlpha. Beta. Gamma.');
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text).toBe('Intro.\n\nAlpha. Beta.'));
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text, 'Ada\'s Cmd+Z must leave Ben\'s text').toBe('Intro.\n\n Beta.'));
      ada.undo.redo(); ada.undo.redo();
      await expectBoth(ada, ben, text => expect(text).toBe('Intro.\n\nAlpha. Beta. Gamma.'));
    } finally { dispose(); }
  });

  it('a peer typing inside a word Ada is editing keeps those characters through her undo', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    try {
      ada.step(() => $getRoot().append($createParagraphNode().append($createTextNode('Alphabet'))));
      await exchange(ada, ben);
      ben.step(typeAt(1, 4, 'BEN'));
      await exchange(ada, ben);
      expect(ada.text()).toBe('Intro.\n\nAlphBENabet');
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text, 'Ada\'s Cmd+Z must leave Ben\'s text').toBe('Intro.\n\nBEN'));
      ada.undo.redo();
      await expectBoth(ada, ben, text => { expect(text).toContain('BEN'); expect(letters(text)).toBe(letters('Intro.AlphBENabet')); });
    } finally { dispose(); }
  });

  it('an older text node\'s format is still undone while it holds the peer\'s characters', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    try {
      ada.step(() => $getRoot().append($createParagraphNode().append($createTextNode('Alpha.'))));
      await exchange(ada, ben);
      ben.step(typeAt(1, 6, ' Beta.'));
      await exchange(ada, ben);
      ada.step(() => textAt(1).setFormat('bold'));
      await exchange(ada, ben);
      const bold = (actor: Peer) => actor.editor.getEditorState().read(() => textAt(1).hasFormat('bold'));
      expect(bold(ben)).toBe(true);
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text).toBe('Intro.\n\nAlpha. Beta.'));
      for (const actor of [ada, ben]) expect(bold(actor), 'the format change is Ada\'s to undo').toBe(false);
    } finally { dispose(); }
  });

  it('undoing a paragraph split keeps what the peer typed into the new paragraph', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('HelloWorld'))));
    try {
      ada.step(enterAt(0, 5));
      await exchange(ada, ben);
      expect(ben.text()).toBe('Hello\n\nWorld');
      ben.step(typeAt(1, 2, 'BEN'));
      await exchange(ada, ben);
      ada.undo.undo();
      await expectBoth(ada, ben, text => { expect(text).toContain('HelloWorld'); expect(text, 'Ada\'s Cmd+Z must leave Ben\'s text').toContain('BEN'); });
      ada.undo.redo();
      await expectBoth(ada, ben, text => expect(text).toContain('BEN'));
    } finally { dispose(); }
  });

  it('undoing a paragraph merge keeps what the peer typed into the merged paragraph', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append(
      $createParagraphNode().append($createTextNode('One.')), $createParagraphNode().append($createTextNode('Two.')),
    ));
    try {
      ada.step(mergeInto(1));
      await exchange(ada, ben);
      expect(ben.text()).toBe('One.Two.');
      ben.step(typeAt(0, 6, 'BEN'));
      await exchange(ada, ben);
      ada.undo.undo();
      await expectBoth(ada, ben, text => { expect(text).toContain('Two'); expect(text, 'Ada\'s Cmd+Z must leave Ben\'s text').toContain('BEN'); });
      ada.undo.redo();
      await expectBoth(ada, ben, text => expect(text).toContain('BEN'));
    } finally { dispose(); }
  });

  it('a peer\'s split and merge survive Ada undoing her typing in the same paragraphs', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append(
      $createParagraphNode().append($createTextNode('One.')), $createParagraphNode().append($createTextNode('Two.')),
    ));
    try {
      ada.step(typeAt(0, 4, ' Ada.'));
      await exchange(ada, ben);
      ben.step(mergeInto(1));
      await exchange(ada, ben);
      expect(ada.text()).toBe('One. Ada.Two.');
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text, 'Ben\'s merge stays').toBe('One.Two.'));
      ada.undo.redo();
      await expectBoth(ada, ben, text => expect(text).toBe('One. Ada.Two.'));
      // Ben's Enter moves the text after his caret into a new paragraph of his own.
      ben.step(enterAt(0, 9));
      await exchange(ada, ben);
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text, 'Ben\'s split stays').toBe('One.\n\nTwo.'));
    } finally { dispose(); }
  });

  it('an undo that skips a step it must keep whole still keeps the peer\'s text in the older step', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    try {
      ada.step(() => $getRoot().append($createParagraphNode()));
      ada.step(() => paragraph(1).append($createTextNode('One')));
      ada.step(() => $getRoot().append($createParagraphNode()));
      await exchange(ada, ben);
      ben.step(() => { textAt(1).setTextContent('One B1'); paragraph(2).append($createTextNode('B2')); });
      await exchange(ada, ben);
      expect(ada.text()).toBe('Intro.\n\nOne B1\n\nB2');
      // The newest step (the paragraph Ben typed B2 into) is kept whole, so Yjs moves on to Ada's 'One'.
      ada.undo.undo();
      await expectBoth(ada, ben, text => expect(text, 'Ada\'s Cmd+Z must leave Ben\'s text').toBe('Intro.\n\n B1\n\nB2'));
    } finally { dispose(); }
  });

  it('repeated Cmd+Z and Cmd+Shift+Z keep the peer\'s text and leave both peers converged', async () => {
    const { ada, ben, dispose } = await pair(() => $getRoot().append($createParagraphNode().append($createTextNode('Intro.'))));
    try {
      ada.step(enterAt(0, 6));
      ada.step(() => textAt(1) ? textAt(1).spliceText(0, 0, 'Alpha') : paragraph(1).append($createTextNode('Alpha')));
      await exchange(ada, ben);
      ben.step(typeAt(1, 5, ' BEN'));
      await exchange(ada, ben);
      ada.step(typeAt(1, 9, ' more'));
      await exchange(ada, ben);
      const full = ada.text();
      expect(full).toBe('Intro.\n\nAlpha BEN more');
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 4; i++) {
          ada.undo.undo();
          await expectBoth(ada, ben, text => expect(text, `undo ${i + 1} of round ${round + 1}`).toContain('BEN'));
        }
        for (let i = 0; i < 4; i++) {
          ada.undo.redo();
          await expectBoth(ada, ben, text => expect(text, `redo ${i + 1} of round ${round + 1}`).toContain('BEN'));
        }
        expect(letters(ada.text())).toBe(letters(full));
      }
    } finally { dispose(); }
  });
});

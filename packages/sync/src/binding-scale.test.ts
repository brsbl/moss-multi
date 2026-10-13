// T3.S6: the Yjs binding's cost is linear in the blocks a change adds or removes. A paste of 100,000 short paragraphs
// froze the tab: @lexical/yjs found each new block's offset by summing every earlier sibling (writing it, and applying
// it on a peer or on undo), and Yjs merged the deleted structs of an undo one splice at a time. Each step here, for
// 4x the blocks, must cost well under the 16x a quadratic step would (patches/@lexical__yjs@0.48.0.patch,
// patches/yjs@13.6.31.patch).
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor, type ElementNode, type LexicalNode, type TextNode } from 'lexical';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { createBinding, createUndoManager, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { exportDocMarkdown } from './server-doc.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

function peer(doc: Y.Doc): LexicalEditor & { undo: Y.UndoManager; binding: ReturnType<typeof createBinding> } {
  const editor = createEditor({ namespace: 'scale', onError: (error) => { throw error; } });
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]));
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, transaction.origin instanceof Y.UndoManager, noop);
  });
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  return Object.assign(editor, { undo: createUndoManager(binding, binding.root.getSharedType()), binding });
}

const commit = (editor: LexicalEditor) => editor.update(noop, { discrete: true });
const text = (editor: LexicalEditor) => editor.getEditorState().read(() => $getRoot().getTextContent());
const send = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'remote');

/** Milliseconds per step for a paste of `count` paragraphs between two others. */
function steps(count: number): Record<string, number> {
  const local = new Y.Doc();
  const remote = new Y.Doc();
  const ada = peer(local);
  const ben = peer(remote);
  ada.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode('Before.')), $createParagraphNode().append($createTextNode('After.')));
  }, { discrete: true });
  send(local, remote);
  commit(ben);
  ada.undo.stopCapturing();
  const ms: Record<string, number> = {};
  const time = (name: string, run: () => void) => {
    const started = performance.now();
    run();
    ms[name] = performance.now() - started;
  };
  time('paste', () => ada.update(() => {
    let previous: LexicalNode = $getRoot().getFirstChildOrThrow();
    for (let i = 0; i < count; i += 1) previous = previous.insertAfter($createParagraphNode().append($createTextNode(`p${i}`)), false);
  }, { discrete: true }));
  const pasted = text(ada);
  time('peer applies the paste', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(pasted);
  time('server export of the paste', () => exportDocMarkdown(remote));
  time('undo', () => { ada.undo.undo(); commit(ada); });
  expect(text(ada)).toBe('Before.\n\nAfter.');
  time('peer applies the undo', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe('Before.\n\nAfter.');
  time('redo', () => { ada.undo.redo(); commit(ada); });
  expect(text(ada)).toBe(pasted);
  time('peer applies the redo', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(pasted);
  time('a paste at the end', () => ada.update(() => {
    const root = $getRoot();
    for (let i = 0; i < count; i += 1) root.append($createParagraphNode().append($createTextNode(`q${i}`)));
  }, { discrete: true }));
  time('peer applies the paste at the end', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(text(ada));
  return ms;
}

it('writes, applies, exports, undoes and redoes a paste of many blocks in time linear in the blocks', { timeout: 600_000 }, () => {
  steps(2_000);
  const small = steps(10_000);
  const large = steps(40_000);
  for (const [name, ms] of Object.entries(large)) {
    expect(ms, `${name}: 10,000 blocks took ${small[name].toFixed(0)} ms, 40,000 took ${ms.toFixed(0)} ms`).toBeLessThanOrEqual(7 * small[name] + 150);
  }
});

// T3.B13 (B346): a keystroke syncs the block it edits, not every block. Each one sent all of the root's children
// through _syncChildFromLexical, most of a keystroke's time in a note of 40,000 blocks.
it('syncs a one-block edit through that block alone, and a peer converges on edits, moves and removals', () => {
  const local = new Y.Doc();
  const remote = new Y.Doc();
  const ada = peer(local);
  const ben = peer(remote);
  ada.update(() => {
    const root = $getRoot();
    for (let i = 0; i < 2_000; i += 1) root.append($createParagraphNode().append($createTextNode(`p${i}`)));
  }, { discrete: true });
  send(local, remote);
  commit(ben);
  const element = Object.getPrototypeOf(ada.binding.root) as { _syncChildFromLexical: (...args: unknown[]) => unknown };
  const original = element._syncChildFromLexical;
  let calls = 0;
  element._syncChildFromLexical = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    ada.update(() => (($getRoot().getChildAtIndex(1_000) as ElementNode).getFirstChild() as TextNode).setTextContent('p1000 edited'), { discrete: true });
  } finally {
    element._syncChildFromLexical = original;
  }
  expect(calls, 'the root and the edited paragraph each sync one child').toBeLessThanOrEqual(2);
  send(local, remote);
  commit(ben);
  expect(text(ben)).toBe(text(ada));
  expect(text(ben)).toContain('p1000 edited');
  ada.update(() => {
    const root = $getRoot();
    ((root.getChildAtIndex(5) as ElementNode).getFirstChild() as TextNode).setTextContent('five');
    ((root.getChildAtIndex(1_500) as ElementNode).getFirstChild() as TextNode).setTextContent('fifteen hundred');
    root.getChildAtIndex(10)!.insertAfter(root.getChildAtIndex(1_999)!);
    root.getChildAtIndex(20)!.remove();
  }, { discrete: true });
  send(local, remote);
  commit(ben);
  expect(text(ada)).toContain('fifteen hundred');
  expect(text(ben)).toBe(text(ada));
});

// T3.S6: the Yjs binding's cost is linear in the blocks a change adds or removes. A paste of 100,000 short paragraphs
// froze the tab: @lexical/yjs found each new block's offset by summing every earlier sibling (writing it, and applying
// it on a peer or on undo), and Yjs merged the deleted structs of an undo one splice at a time. Each step here, for
// 4x the blocks, must do well under the 16x the work a quadratic step would (patches/@lexical__yjs@0.48.0.patch,
// patches/yjs@13.6.31.patch). The work is counted, not timed: the binding's child-size reads (each offset walk over
// siblings reads them) and the array elements every splice moves (Yjs merged an undo's structs one splice at a time).
import { $createParagraphNode, $createTextNode, $getRoot, createEditor, type LexicalEditor, type LexicalNode } from 'lexical';
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
  countSizes(binding.root);
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

/** The work counted while a step runs. */
const work = { count: 0 };
const counted = new WeakSet<object>();

/** Counts every `getSize` of the binding's collab node classes (their offset walks call it once per sibling). */
function countSizes(node: object | undefined): void {
  const proto = node && Object.getPrototypeOf(node);
  if (!proto || counted.has(proto) || !Object.hasOwn(proto, 'getSize')) return;
  counted.add(proto);
  const getSize = proto.getSize as (this: unknown) => number;
  proto.getSize = function (this: unknown) {
    work.count += 1;
    return getSize.call(this);
  };
}

/** Counts the elements each splice moves or inserts, while `run` runs. */
function countingSplices<T>(run: () => T): T {
  const splice = Array.prototype.splice;
  // eslint-disable-next-line no-extend-native -- restored below: the test's own work count
  Array.prototype.splice = function (this: unknown[], ...args: [number, number?, ...unknown[]]) {
    const [start, deleteCount] = args;
    const from = start < 0 ? Math.max(0, this.length + start) : Math.min(start, this.length);
    const removed = args.length < 2 ? this.length - from : Math.min(Math.max(0, deleteCount ?? 0), this.length - from);
    work.count += this.length - from - removed + Math.max(0, args.length - 2);
    return Reflect.apply(splice, this, args) as unknown[];
  } as typeof splice;
  try {
    return run();
  } finally {
    Array.prototype.splice = splice;
  }
}

/** The work each step does for a paste of `count` paragraphs between two others, and the milliseconds they all took. */
function steps(count: number): { work: Record<string, number>; ms: number } {
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
  // The paragraph's and its text's collab node classes, so their size reads count too.
  const paragraph = (ada.binding.root as unknown as { _children: { _children: object[] }[] })._children[0];
  countSizes(paragraph);
  countSizes(paragraph._children[0]);
  const counts: Record<string, number> = {};
  const started = performance.now();
  const step = (name: string, run: () => void) => {
    work.count = 0;
    countingSplices(run);
    counts[name] = work.count;
  };
  step('paste', () => ada.update(() => {
    let previous: LexicalNode = $getRoot().getFirstChildOrThrow();
    for (let i = 0; i < count; i += 1) previous = previous.insertAfter($createParagraphNode().append($createTextNode(`p${i}`)), false);
  }, { discrete: true }));
  const pasted = text(ada);
  step('peer applies the paste', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(pasted);
  step('server export of the paste', () => exportDocMarkdown(remote));
  step('undo', () => { ada.undo.undo(); commit(ada); });
  expect(text(ada)).toBe('Before.\n\nAfter.');
  step('peer applies the undo', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe('Before.\n\nAfter.');
  step('redo', () => { ada.undo.redo(); commit(ada); });
  expect(text(ada)).toBe(pasted);
  step('peer applies the redo', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(pasted);
  step('a paste at the end', () => ada.update(() => {
    const root = $getRoot();
    for (let i = 0; i < count; i += 1) root.append($createParagraphNode().append($createTextNode(`q${i}`)));
  }, { discrete: true }));
  step('peer applies the paste at the end', () => { send(local, remote); commit(ben); });
  expect(text(ben)).toBe(text(ada));
  return { work: counts, ms: performance.now() - started };
}

it('writes, applies, exports, undoes and redoes a paste of many blocks with work linear in the blocks', { timeout: 600_000 }, () => {
  steps(2_000);
  const small = steps(10_000);
  const large = steps(40_000);
  for (const [name, count] of Object.entries(large.work)) {
    // 4x the blocks: 4x the work when linear, 16x when quadratic.
    expect(count, `${name}: 10,000 blocks did ${small.work[name]} units of work, 40,000 did ${count}`).toBeLessThanOrEqual(5 * small.work[name] + 1_000);
  }
  // A generous backstop for work the counts miss: a loaded CI runner took up to 4.5 s for one of these steps.
  expect(large.ms, `every step for 40,000 blocks took ${Math.round(large.ms)} ms`).toBeLessThan(150_000);
});

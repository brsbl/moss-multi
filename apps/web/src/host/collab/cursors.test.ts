// @vitest-environment jsdom
// Remote cursors (A§10.2): one peer's malformed awareness positions skip that peer, never the whole cursor pass.
import { createBinding, syncLexicalUpdateToYjs, type Binding, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cursorController } from './cursors.ts';

const noop = () => {};
let restore: (() => void)[] = [];
beforeEach(() => {
  // jsdom lays nothing out: give the cursor container an offset parent and each range one rect, as a browser would.
  const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', { configurable: true, get(this: HTMLElement) { return this.parentElement; } });
  const rects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = () => [{ top: 0, left: 0, width: 4, height: 16, right: 4, bottom: 16 }] as unknown as DOMRectList;
  restore = [
    () => { if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent); else delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent; },
    () => { Range.prototype.getClientRects = rects; },
  ];
});
afterEach(() => { for (const undo of restore) undo(); document.body.replaceChildren(); });

function mounted() {
  const rootElement = document.createElement('div');
  rootElement.contentEditable = 'true';
  const container = document.createElement('div');
  document.body.append(rootElement, container);
  const editor = createEditor({ namespace: 'cursors-test', onError: (error) => { throw error; } });
  editor.setRootElement(rootElement);
  const doc = new Y.Doc();
  const states = new Map<number, Record<string, unknown>>();
  const provider = {
    awareness: { getLocalState: () => null, getStates: () => states, on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
    connect: noop, disconnect: noop, on: noop, off: noop,
  } as unknown as Provider;
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]])) as Binding;
  binding.cursorsContainer = container;
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  editor.update(() => { $getRoot().clear().append($createParagraphNode().append($createTextNode('hello world'))); }, { discrete: true });
  const paragraph = (binding.root._children[0] as unknown as { getSharedType(): Y.XmlText }).getSharedType();
  // What a peer's awareness carries on the wire: Lexical's RelativePosition through JSON, nulls included.
  const at = (index: number) => JSON.parse(JSON.stringify(Y.createRelativePositionFromTypeIndex(paragraph, index))) as Record<string, unknown>;
  return { binding, provider, states, container, at };
}
const person = (name: string, color: string, isAgent = false) => ({
  name, color, user: { principalId: name.toLowerCase(), name, color, colorSettled: true, isAgent },
});
const carets = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-remote-caret]')].map(caret => Number(caret.dataset.remoteCaret)).sort((a, b) => a - b);
const paint = async (controller: ReturnType<typeof cursorController>, binding: Binding, provider: Provider) => {
  controller.sync(binding, provider);
  await Promise.resolve(); await Promise.resolve();
};

it('a peer with malformed positions is skipped; healthy peers render and a departed one is removed', async () => {
  const { binding, provider, states, container, at } = mounted();
  const controller = cursorController(binding.editor);
  states.set(11, { ...person('Ada', '#aa0000'), focusing: true, anchorPos: at(1), focusPos: at(3) });
  states.set(12, { ...person('Eve', '#00aa00'), focusing: true, anchorPos: {}, focusPos: {} });
  states.set(13, { ...person('Ben', '#0000aa'), focusing: true, anchorPos: at(5), focusPos: at(5) });
  states.set(14, { ...person('Cal', '#aaaa00'), focusing: true, anchorPos: at(2), focusPos: at(2) });
  await paint(controller, binding, provider);
  expect([...binding.cursors.keys()].sort()).toEqual([11, 13, 14]);
  expect(carets(container)).toEqual([11, 13, 14]);
  for (const bad of [{ item: { client: 'x' } }, { type: {} }, { type: null, tname: null, item: null, assoc: 0 }, { tname: 7 }, []]) {
    states.set(12, { ...person('Eve', '#00aa00'), focusing: true, anchorPos: at(1), focusPos: bad });
    states.delete(14);
    await paint(controller, binding, provider);
    expect([...binding.cursors.keys()].sort()).toEqual([11, 13]);
    expect(carets(container)).toEqual([11, 13]);
    states.set(14, { ...person('Cal', '#aaaa00'), focusing: true, anchorPos: at(2), focusPos: at(2) });
  }
});

it('valid human and agent presence render with their names, in either relative-position JSON form', async () => {
  const { binding, provider, states, container, at } = mounted();
  const controller = cursorController(binding.editor);
  states.set(21, { ...person('Ada', '#aa0000'), focusing: true, anchorPos: at(1), focusPos: at(4) });
  // Y.relativePositionToJSON omits null fields; an agent's client may send that form.
  const compact = Y.relativePositionToJSON(Y.createRelativePositionFromJSON(at(6)));
  states.set(22, { ...person('Claude', '#0000aa', true), focusing: true, anchorPos: compact, focusPos: compact });
  await paint(controller, binding, provider);
  expect(carets(container)).toEqual([21, 22]);
  const labels = [...container.querySelectorAll<HTMLElement>('[data-cursor-label]')].map(label => label.textContent).sort();
  expect(labels).toEqual(['Ada', 'Claude 🤖']);
  for (const caret of container.querySelectorAll<HTMLElement>('[data-remote-caret]')) {
    expect(caret.dataset.presenceColor).toBe(caret.dataset.remoteCaret === '21' ? '#aa0000' : '#0000aa');
  }
});

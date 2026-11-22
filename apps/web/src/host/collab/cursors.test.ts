// @vitest-environment jsdom
// Remote cursors (A§10.2): one peer's malformed awareness positions skip that peer, never the whole cursor pass.
import { createBinding, syncLexicalUpdateToYjs, type Binding, type Provider } from '@lexical/yjs';
import { $createParagraphNode, $createTextNode, $getRoot, createEditor } from 'lexical';
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as Y from 'yjs';
import { columnAt, cursorController } from './cursors.ts';

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
  document.body.appendChild(rootElement); document.body.appendChild(container);
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
  expect(labels).toEqual(['Ada', 'Claude · Bot']);
  for (const caret of container.querySelectorAll<HTMLElement>('[data-remote-caret]')) {
    expect(caret.dataset.presenceColor).toBe(caret.dataset.remoteCaret === '21' ? '#aa0000' : '#0000aa');
  }
});

it('a name label is Moss tooltip material, never a fill of the peer colour, with a swatch of their caret colour', async () => {
  const { binding, provider, states, container, at } = mounted();
  const controller = cursorController(binding.editor);
  states.set(31, { ...person('Ada', '#aa0000'), focusing: true, anchorPos: at(2), focusPos: at(2), typingAt: Date.now() });
  await paint(controller, binding, provider);
  const label = container.querySelector<HTMLElement>('[data-cursor-label]')!;
  expect(label.style.backgroundColor).toBe('');
  expect(label.style.color).toBe('');
  for (const token of ['rounded-md', 'border-border-subtle', 'bg-surface-floating', 'px-2.5', 'py-1', 'text-nano', 'font-light', 'text-ink-default', 'shadow-md']) {
    expect(label.classList.contains(token), token).toBe(true);
  }
  const swatch = label.querySelector<HTMLElement>('[data-presence-swatch]')!;
  expect(swatch.dataset.presenceColor).toBe('#aa0000');
  expect(label.textContent).toBe('Ada');
});

/**
 * Layout reads and DOM writes during a cursor pass. A read after a write forces a layout: in a long note while someone
 * types (a paste counts), each one lays the page out again (run 44262371127), so the name pass may add at most one.
 */
function layoutLog() {
  let wrote = false;
  const log = { forced: 0, nameReads: 0 };
  const undo: (() => void)[] = [];
  const wrap = (target: object, key: string, kind: 'read' | 'write', also?: (self: unknown) => void) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return;
    if (typeof descriptor.value === 'function') {
      const original = descriptor.value as (...args: unknown[]) => unknown;
      Object.defineProperty(target, key, { ...descriptor, value(this: unknown, ...args: unknown[]) {
        if (kind === 'read') { if (wrote) log.forced += 1; wrote = false; also?.(this); } else wrote = true;
        return original.apply(this, args);
      } });
    } else if (descriptor.set) {
      const set = descriptor.set;
      Object.defineProperty(target, key, { ...descriptor, set(this: unknown, value: unknown) { wrote = true; set.call(this, value); } });
    } else return;
    undo.push(() => Object.defineProperty(target, key, descriptor));
  };
  wrap(Element.prototype, 'getBoundingClientRect', 'read', (self) => { if ((self as HTMLElement).dataset?.cursorLabel !== undefined) log.nameReads += 1; });
  wrap(Element.prototype, 'getClientRects', 'read');
  wrap(Range.prototype, 'getBoundingClientRect', 'read');
  wrap(Range.prototype, 'getClientRects', 'read');
  const style = Object.getPrototypeOf(document.body.style) as object;
  for (const key of Object.getOwnPropertyNames(style)) {
    if (key === 'setProperty' || key === 'removeProperty' || Object.getOwnPropertyDescriptor(style, key)?.set) wrap(style, key, 'write');
  }
  wrap(Element.prototype, 'replaceChildren', 'write');
  wrap(Node.prototype, 'appendChild', 'write');
  // Undone before the layout stubs above are, since it wraps them.
  restore.unshift(() => { for (const step of undo.reverse()) step(); });
  return { log, reset: () => { wrote = false; log.forced = 0; log.nameReads = 0; } };
}

it('the name pass adds at most one forced layout to a repaint, however many people are typing', async () => {
  const { binding, provider, states, at } = mounted();
  const controller = cursorController(binding.editor);
  states.set(41, { ...person('Ada', '#aa0000'), focusing: true, anchorPos: at(2), focusPos: at(2) });
  states.set(42, { ...person('Ben', '#0000aa'), focusing: true, anchorPos: at(7), focusPos: at(7) });
  await paint(controller, binding, provider);
  const { log, reset } = layoutLog();
  reset();
  await paint(controller, binding, provider);
  const quiet = log.forced;
  for (const id of [41, 42]) states.set(id, { ...states.get(id), typingAt: Date.now() });
  await paint(controller, binding, provider);
  reset();
  await paint(controller, binding, provider);
  expect(log.forced - quiet, 'forced layouts the typing names add to a repaint').toBeLessThanOrEqual(1);
});

it('a typing name is measured when its text changes, not on every repaint', async () => {
  const { binding, provider, states, at } = mounted();
  const controller = cursorController(binding.editor);
  const { log, reset } = layoutLog();
  states.set(51, { ...person('Ada', '#aa0000'), focusing: true, anchorPos: at(2), focusPos: at(2), typingAt: Date.now() });
  await paint(controller, binding, provider);
  expect(log.nameReads, 'a new name is measured once').toBe(1);
  reset();
  for (let i = 0; i < 3; i += 1) await paint(controller, binding, provider);
  expect(log.nameReads, 'an unchanged name is not measured again').toBe(0);
  states.set(51, { ...person('Ada Lovelace', '#aa0000'), focusing: true, anchorPos: at(2), focusPos: at(2), typingAt: Date.now() });
  await paint(controller, binding, provider);
  expect(log.nameReads, 'a changed name is measured once').toBe(1);
});

/** A root whose top-level blocks report these rects; a zero rect is a collapsed section's block (display:none). */
function stacked(boxes: [top: number, bottom: number][]) {
  const root = document.createElement('div');
  root.getBoundingClientRect = () => ({ top: 0, bottom: 2000, left: 0, right: 1440, height: 2000, width: 1440 }) as DOMRect;
  for (const [top, bottom] of boxes) {
    const block = document.createElement('p');
    const hidden = top === 0 && bottom === 0;
    block.getBoundingClientRect = () => ({ top, bottom, height: bottom - top, left: hidden ? 0 : 300, right: hidden ? 0 : 1150, width: hidden ? 0 : 850 }) as DOMRect;
    root.appendChild(block);
  }
  return root;
}

it('the text column is found past a collapsed section, whose blocks have no rect', () => {
  const column = { left: 300, right: 1150 };
  expect(columnAt(stacked([[100, 130], [150, 170], [0, 0], [0, 0], [180, 210]]), 115), 'a line above the collapsed section').toEqual(column);
  expect(columnAt(stacked([[100, 130], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [140, 170]]), 160), 'a line below it').toEqual(column);
  expect(columnAt(stacked([[0, 0], [0, 0], [0, 0], [100, 130]]), 110), 'a line after a collapsed start').toEqual(column);
  expect(columnAt(stacked([[100, 130], [0, 0], [0, 0], [0, 0]]), 110), 'a line before a collapsed end').toEqual(column);
  expect(columnAt(stacked([[0, 0], [0, 0]]), 110), 'no visible block: the whole body').toEqual({ left: 0, right: 1440 });
});

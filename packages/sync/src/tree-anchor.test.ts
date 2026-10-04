// T4.0 anchor spike (A§13): comment anchors are RelativePositions into the V1 tree plus a quote over one projection
// that every client and the DocDO compute from Y types alone. Real headless editors bound through @lexical/yjs make
// the edits, so text-node splits happen exactly as in the browser.
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Binding, type Provider } from '@lexical/yjs';
import {
  $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $isElementNode, $setSelection, type ElementNode,
  type LexicalNode, type TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeRelPos, mintAnchor, project, refreshAnchors, resolveAnchor, similarity, validateAnchor, type TreeAnchor } from '@moss-multi/core/tree-anchor';
import { createConverterEditor } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { bindRegisters } from './registers.ts';
import { importBody } from './server-doc.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;
const REMOTE = 'remote';

/** A browser-shaped peer: a headless editor bound (V1) to its own Y.Doc. */
function peer(seed: Y.Doc) {
  const doc = new Y.Doc();
  const editor = createConverterEditor();
  const binding: Binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  const stopRegisters = bindRegisters(editor, doc);
  const stop = editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), REMOTE);
  editor.update(noop, { discrete: true });
  return {
    doc, editor, binding,
    edit: (fn: () => void) => editor.update(fn, { discrete: true }),
    dispose: () => { stop(); stopRegisters(); root.unobserveDeep(observer); doc.destroy(); },
  };
}
type Peer = ReturnType<typeof peer>;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function sync(...docs: Y.Doc[]): Promise<void> {
  for (const from of docs) for (const to of docs) {
    if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), REMOTE);
  }
  await settle();
}

const BODY = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph here, a fox too.\n\n```js\nconst x = 1;\n```';
const paragraph = (index: number) => $getRoot().getChildren()[index] as ElementNode;
const firstText = () => paragraph(0).getFirstChild() as TextNode;
function bold(from: number, to: number): void {
  const text = firstText();
  const selection = $createRangeSelection();
  selection.anchor.set(text.getKey(), from, 'text');
  selection.focus.set(text.getKey(), to, 'text');
  $setSelection(selection);
  selection.formatText('bold');
  $setSelection(null);
}
function find(type: string, node: LexicalNode = $getRoot()): LexicalNode | undefined {
  if (node.getType() === type) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = find(type, child); if (found) return found; }
}
const textOf = (doc: Y.Doc, anchor: TreeAnchor) => {
  const range = validateAnchor(doc, anchor).range;
  return range ? project(doc).text.slice(range.start, range.end) : null;
};
/** Mint over the first occurrence of `quote` after `from` in `doc`'s projection. */
function anchorOn(doc: Y.Doc, quote: string, from = 0): TreeAnchor {
  const start = project(doc).text.indexOf(quote, from);
  expect(start, `"${quote}" is in the projection`).toBeGreaterThanOrEqual(0);
  return mintAnchor(doc, start, start + quote.length);
}

async function scene(run: (seed: Y.Doc, a: Peer, b: Peer) => Promise<void>): Promise<void> {
  const seed = new Y.Doc();
  importBody(seed, BODY);
  const a = peer(seed);
  const b = peer(seed);
  try {
    await settle();
    await run(seed, a, b);
  } finally {
    a.dispose(); b.dispose(); seed.destroy();
  }
}

describe('T4.0 spike: tree anchors over the V1 binding @p:tech-3', () => {
  it('every replica and the server compute one projection, and an anchor minted on one resolves on all', () => scene(async (seed, a, b) => {
    expect(project(a.doc).text).toBe(project(seed).text);
    expect(project(seed).text.startsWith('The quick brown fox jumps over the lazy dog.\nSecond paragraph here, a fox too.\n\uFFFC')).toBe(true);
    const anchor = anchorOn(b.doc, 'brown fox');
    for (const doc of [seed, a.doc, b.doc]) expect(textOf(doc, anchor)).toBe('brown fox');
  }));

  it('a client mints the same positions from a Lexical point through its binding as from the projection', () => scene(async (_seed, a) => {
    const anchor = anchorOn(a.doc, 'brown fox');
    const [key, start] = a.editor.getEditorState().read(() => [firstText().getKey(), firstText().getTextContent().indexOf('brown')] as const);
    const collab = a.binding.collabNodeMap.get(key) as unknown as { _parent: { _xmlText: Y.XmlText }; getOffset: () => number };
    const fromPoint = (offset: number, assoc: number) =>
      Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(collab._parent._xmlText, collab.getOffset() + 1 + offset, assoc));
    expect(fromPoint(start, 0)).toEqual(Y.encodeRelativePosition(decodeRelPos(anchor.start)));
    expect(fromPoint(start + 'brown fox'.length, -1)).toEqual(Y.encodeRelativePosition(decodeRelPos(anchor.end)));
  }));

  it('concurrent typing grows the range from inside, never at its edges, and every replica agrees', () => scene(async (seed, a, b) => {
    const anchor = anchorOn(seed, 'brown fox');
    // One keystroke run per update, as typed: a single update holding several splices diffs as one replace.
    a.edit(() => { firstText().spliceText(16, 0, 'very '); });
    a.edit(() => { firstText().spliceText(10, 0, 'old '); });
    a.edit(() => { firstText().spliceText(28, 0, '!'); });
    b.edit(() => { firstText().spliceText(0, 0, 'Hey, '); });
    await sync(seed, a.doc, b.doc);
    expect(project(a.doc).text).toBe(project(b.doc).text);
    expect(project(a.doc).text.startsWith('Hey, The quick old brown very fox! jumps')).toBe(true);
    for (const doc of [seed, a.doc, b.doc]) expect(textOf(doc, anchor)).toBe('brown very fox');
  }));

  it('similarity counts the common prefix and suffix, so one typed character barely moves it', () => {
    expect(similarity('brown fox', 'bXrown fox')).toBeGreaterThan(0.9);
    expect(similarity('brown fox', 'brown foXx')).toBeGreaterThan(0.9);
    expect(similarity('abc', 'xyz')).toBe(0);
  });

  it('typing just inside the start of a commented phrase keeps it anchored', () => scene(async (seed, a, b) => {
    const anchor = anchorOn(seed, 'brown fox');
    a.edit(() => { firstText().spliceText(11, 0, 'X'); });
    await sync(seed, a.doc, b.doc);
    for (const doc of [seed, a.doc, b.doc]) {
      const checked = validateAnchor(doc, anchor);
      expect(checked.anchor.status).toBe('anchored');
      expect(textOf(doc, anchor)).toBe('bXrown fox');
    }
  }));

  it('typing inside the range refreshes the quote, so a later format collapse still finds the grown text', () => scene(async (seed, a, b) => {
    const minted = anchorOn(seed, 'brown fox');
    a.edit(() => { firstText().spliceText(16, 0, 'very '); });
    await sync(seed, a.doc, b.doc);
    // The DocDO persists what validateAnchor returns when it reports a change (comments.md §3.4).
    const typed = validateAnchor(seed, minted);
    expect(typed.changed).toBe(true);
    expect(typed.anchor.quote.exact).toBe('brown very fox');
    a.edit(() => bold(4, 9));
    await sync(seed, a.doc, b.doc);
    const formatted = validateAnchor(seed, typed.anchor);
    expect(formatted.anchor.status).toBe('anchored');
    for (const doc of [seed, a.doc, b.doc]) expect(textOf(doc, formatted.anchor)).toBe('brown very fox');
  }));

  it('a refreshed quote persists with the frame that changed it, so a restart before any save tick keeps the typing', () => scene(async (seed, a) => {
    // The DocDO's log: every update it applies is a row (doc-do.ts #persist); a wake replays the rows, or a compaction.
    const log: Uint8Array[] = [];
    seed.on('update', (update: Uint8Array) => log.push(update));
    const comments = seed.getMap<{ id: string; anchor?: TreeAnchor }>('comments');
    seed.transact(() => comments.set('c1', { id: 'c1', anchor: anchorOn(seed, 'brown fox') }), 'server-comments');
    const frameTo = (doc: Y.Doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(doc)), REMOTE);
    const wake = () => {
      const doc = new Y.Doc();
      for (const row of log) Y.applyUpdate(doc, row);
      return doc;
    };

    a.edit(() => { firstText().spliceText(16, 0, 'very '); });
    frameTo(seed);
    // Control: the refresh only in memory (or on a later tick) is lost by a restart here.
    const lost = wake();
    expect(lost.getMap<{ anchor: TreeAnchor }>('comments').get('c1')?.anchor.quote.exact).toBe('brown fox');
    // The design: refresh in the same synchronous step as the root frame, so its row lands with the frame's row.
    expect(refreshAnchors(seed, 'server-comments')).toEqual(['c1']);
    expect(refreshAnchors(seed, 'server-comments'), 'nothing changed since').toEqual([]);

    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(seed));
    a.edit(() => bold(4, 9));
    for (const woken of [wake(), compacted]) {
      frameTo(woken);
      refreshAnchors(woken, 'server-comments');
      const anchor = woken.getMap<{ anchor: TreeAnchor }>('comments').get('c1')!.anchor;
      expect(anchor.status).toBe('anchored');
      expect(textOf(woken, anchor)).toBe('brown very fox');
      woken.destroy();
    }
    lost.destroy();
  }));

  it('bolding a word before the range collapses the raw positions; the quote restores the same text and re-mints', () => scene(async (seed, a, b) => {
    const anchor = anchorOn(seed, 'brown fox');
    a.edit(() => bold(4, 9));
    await sync(seed, a.doc, b.doc);
    const raw = resolveAnchor(seed, anchor);
    expect(raw === null || raw.start === raw.end, `raw positions after a format split: ${JSON.stringify(raw)}`).toBe(true);
    const checked = validateAnchor(seed, anchor);
    expect(checked.reanchored).toBe(true);
    expect(checked.anchor.status).toBe('anchored');
    const restored = resolveAnchor(seed, checked.anchor);
    expect(restored && project(seed).text.slice(restored.start, restored.end)).toBe('brown fox');
    for (const doc of [a.doc, b.doc]) expect(textOf(doc, checked.anchor)).toBe('brown fox');
  }));

  it('a short comment re-anchors only where its context still matches, and orphans instead of jumping', () => scene(async (seed, a) => {
    const fox = anchorOn(seed, 'fox');
    a.edit(() => bold(4, 9));
    await sync(seed, a.doc);
    expect(textOf(seed, fox), 'same word, same context: kept').toBe('fox');
    const start = project(seed).text.indexOf('fox');
    expect(validateAnchor(seed, fox).range?.start).toBe(start);

    const moved = anchorOn(seed, 'fox');
    a.edit(() => {
      const text = paragraph(0).getChildren().at(-1) as TextNode;
      text.setTextContent(text.getTextContent().replace('fox ', ''));
    });
    await sync(seed, a.doc);
    expect(project(seed).text).toContain('a fox too');
    const checked = validateAnchor(seed, moved);
    expect(checked.range, 'the other "fox" has a different context').toBeNull();
    expect(checked.anchor.status).toBe('orphaned');
  }));

  it('deleting the commented paragraph orphans the anchor', () => scene(async (seed, a) => {
    const anchor = anchorOn(seed, 'lazy dog');
    a.edit(() => paragraph(0).remove());
    await sync(seed, a.doc);
    const checked = validateAnchor(seed, anchor);
    expect(checked.range).toBeNull();
    expect(checked.anchor.status).toBe('orphaned');
  }));

  it('a block comment anchors the decorator embed and survives a paragraph above and edits inside its register', () => scene(async (seed, a, b) => {
    const anchor = anchorOn(seed, '\uFFFC');
    a.edit(() => { paragraph(0).insertBefore($createParagraphNode().append($createTextNode('Intro line'))); });
    b.edit(() => { (find('code-block') as unknown as { setCode: (code: string) => void }).setCode('const x = 2;'); });
    await sync(seed, a.doc, b.doc);
    expect(project(seed).text.startsWith('Intro line\n')).toBe(true);
    for (const doc of [seed, a.doc, b.doc]) {
      const range = validateAnchor(doc, anchor).range;
      expect(range && range.end - range.start).toBe(1);
      expect(range?.start).toBe(project(doc).text.indexOf('\uFFFC'));
    }
  }));
});

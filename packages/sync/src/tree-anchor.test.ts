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
import {
  anchorsBefore, decodeRelPos, mintAnchor, project, refreshAnchors, resolveAnchor, similarity, validateAnchor, type TreeAnchor,
} from '@moss-multi/core/tree-anchor';
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
  // Cmd+Z as the CollaborationPlugin wires it: a Y.UndoManager over the root that tracks the binding's writes.
  const history = new Y.UndoManager(root, { trackedOrigins: new Set([binding]), captureTimeout: 0 });
  return {
    doc, editor, binding,
    edit: (fn: () => void) => editor.update(fn, { discrete: true }),
    undo: () => { history.undo(); },
    dispose: () => { stop(); stopRegisters(); history.destroy(); root.unobserveDeep(observer); doc.destroy(); },
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

/** Longer than the quote context, so two blocks between copies of it have identical context. */
const PAD = 'A padding sentence longer than the thirty-two characters of quote context.';
const BODY = 'The quick brown fox jumps over the lazy dog.\n\nSecond paragraph here, a fox too.\n\n```js\nconst x = 1;\n```';
const TWINS = 'TODO: fix this\n\nTODO: fix this\n\nTail.';
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
function findAll(type: string, node: LexicalNode = $getRoot(), out: LexicalNode[] = []): LexicalNode[] {
  if (node.getType() === type) out.push(node);
  if ($isElementNode(node)) for (const child of node.getChildren()) findAll(type, child, out);
  return out;
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

/** The DocDO's step for one client frame: note the anchors, apply the frame, refresh them in the same synchronous step. */
function frame(server: Y.Doc, client: Y.Doc): string[] {
  const before = anchorsBefore(server);
  Y.applyUpdate(server, Y.encodeStateAsUpdate(client, Y.encodeStateVector(server)), REMOTE);
  return refreshAnchors(server, 'server-comments', before);
}
const comments = (doc: Y.Doc) => doc.getMap<{ id: string; anchor: TreeAnchor }>('comments');
/** Stores comment `c1` on the first occurrence of `quote` after `from`, as the DocDO's create does. */
function comment(server: Y.Doc, quote: string, from = 0): TreeAnchor {
  const anchor = anchorOn(server, quote, from);
  server.transact(() => comments(server).set('c1', { id: 'c1', anchor }), 'server-comments');
  return anchor;
}
const stored = (doc: Y.Doc) => comments(doc).get('c1')!.anchor;

async function scene(run: (seed: Y.Doc, a: Peer, b: Peer) => Promise<void>, body = BODY): Promise<void> {
  const seed = new Y.Doc();
  importBody(seed, body);
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
    expect(project(seed).text.startsWith('The quick brown fox jumps over the lazy dog.\nSecond paragraph here, a fox too.\n￼')).toBe(true);
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

  it('typing inside the range refreshes the quote, and a later format split keeps the grown text', () => scene(async (seed, a) => {
    comment(seed, 'brown fox');
    a.edit(() => { firstText().spliceText(16, 0, 'very '); });
    expect(frame(seed, a.doc)).toEqual(['c1']);
    expect(stored(seed).quote.exact).toBe('brown very fox');
    a.edit(() => bold(4, 9));
    frame(seed, a.doc);
    expect(stored(seed).status).toBe('anchored');
    await sync(seed, a.doc);
    for (const doc of [seed, a.doc]) expect(textOf(doc, stored(seed))).toBe('brown very fox');
  }));

  it('a refreshed anchor persists with the frame that changed it, so a restart before any save tick keeps it', () => scene(async (seed, a) => {
    // The DocDO's log: every update it applies is a row (doc-do.ts #persist); a wake replays the rows, or a compaction.
    const log: Uint8Array[] = [Y.encodeStateAsUpdate(seed)];
    seed.on('update', (update: Uint8Array) => log.push(update));
    comment(seed, 'brown fox');
    const frameTo = (doc: Y.Doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(doc)), REMOTE);
    const wake = () => {
      const doc = new Y.Doc();
      for (const row of log) Y.applyUpdate(doc, row);
      return doc;
    };

    a.edit(() => { firstText().spliceText(16, 0, 'very '); });
    const before = anchorsBefore(seed);
    frameTo(seed);
    // Control: the refresh only in memory (or on a later tick) is lost by a restart here.
    const lost = wake();
    expect(lost.getMap<{ anchor: TreeAnchor }>('comments').get('c1')?.anchor.quote.exact).toBe('brown fox');
    // The design: refresh in the same synchronous step as the root frame, so its row lands with the frame's row.
    expect(refreshAnchors(seed, 'server-comments', before)).toEqual(['c1']);
    expect(refreshAnchors(seed, 'server-comments'), 'nothing changed since').toEqual([]);

    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(seed));
    a.edit(() => bold(4, 9));
    for (const woken of [wake(), compacted]) {
      const ahead = anchorsBefore(woken);
      frameTo(woken);
      refreshAnchors(woken, 'server-comments', ahead);
      const anchor = stored(woken);
      expect(anchor.status).toBe('anchored');
      expect(textOf(woken, anchor)).toBe('brown very fox');
      woken.destroy();
    }
    lost.destroy();
  }));

  it('a format split collapses the raw positions; the DocDO re-mints them at the same offsets in that frame', () => scene(async (seed, a, b) => {
    const minted = comment(seed, 'brown fox');
    a.edit(() => bold(4, 9));
    await sync(a.doc, b.doc);
    const before = anchorsBefore(seed);
    Y.applyUpdate(seed, Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(seed)), REMOTE);
    const raw = resolveAnchor(seed, minted);
    expect(raw === null || raw.start === raw.end, `raw positions after a format split: ${JSON.stringify(raw)}`).toBe(true);
    expect(validateAnchor(seed, minted).anchor.status, 'collapsed positions alone orphan: no quote search').toBe('orphaned');
    expect(refreshAnchors(seed, 'server-comments', before)).toEqual(['c1']);
    expect(stored(seed).status).toBe('anchored');
    expect(stored(seed).start).not.toBe(minted.start);
    await sync(seed, a.doc, b.doc);
    for (const doc of [seed, a.doc, b.doc]) expect(textOf(doc, stored(seed))).toBe('brown fox');
    expect(validateAnchor(seed, stored(seed)).range?.start).toBe(project(seed).text.indexOf('brown fox'));
  }));

  it('a short comment keeps its word through a format split and orphans when the word is deleted', () => scene(async (seed, a) => {
    comment(seed, 'fox');
    const start = project(seed).text.indexOf('fox');
    a.edit(() => bold(4, 9));
    frame(seed, a.doc);
    expect(validateAnchor(seed, stored(seed)).range?.start, 'same word, same place').toBe(start);

    a.edit(() => {
      const text = paragraph(0).getChildren().at(-1) as TextNode;
      text.setTextContent(text.getTextContent().replace('fox ', ''));
    });
    frame(seed, a.doc);
    expect(project(seed).text).toContain('a fox too');
    expect(stored(seed).status, 'never moves to the other "fox"').toBe('orphaned');
    expect(validateAnchor(seed, stored(seed)).range).toBeNull();
  }));

  it('deleting the commented paragraph orphans the anchor', () => scene(async (seed, a) => {
    const anchor = anchorOn(seed, 'lazy dog');
    a.edit(() => paragraph(0).remove());
    await sync(seed, a.doc);
    const checked = validateAnchor(seed, anchor);
    expect(checked.range).toBeNull();
    expect(checked.anchor.status).toBe('orphaned');
  }));

  it('deleting commented text and undoing it reattaches the comment in the same place, past an identical line', () => scene(async (seed, a) => {
    const minted = comment(seed, 'TODO: fix this');
    a.edit(() => { firstText().spliceText(0, 'TODO: fix this'.length, ''); });
    frame(seed, a.doc);
    expect(stored(seed).status).toBe('orphaned');
    expect([stored(seed).start, stored(seed).end], 'positions are kept').toEqual([minted.start, minted.end]);
    a.undo();
    frame(seed, a.doc);
    expect(project(seed).text.startsWith('TODO: fix this\nTODO: fix this')).toBe(true);
    expect(stored(seed).status).toBe('anchored');
    expect(validateAnchor(seed, stored(seed)).range).toEqual({ start: 0, end: 'TODO: fix this'.length });
    await sync(seed, a.doc);
    expect(textOf(a.doc, stored(seed))).toBe('TODO: fix this');
  }, TWINS));

  it('deleting a commented paragraph with an identical one elsewhere orphans it, and it never moves', () => scene(async (seed, a) => {
    const minted = comment(seed, 'TODO: fix this');
    a.edit(() => paragraph(0).remove());
    frame(seed, a.doc);
    expect(project(seed).text.startsWith('TODO: fix this\nTail.')).toBe(true);
    expect(stored(seed).status).toBe('orphaned');
    a.edit(() => { (paragraph(1).getFirstChild() as TextNode).spliceText(0, 0, 'More. '); });
    frame(seed, a.doc);
    expect(stored(seed).status, 'a later frame does not retarget it').toBe('orphaned');
    expect([stored(seed).start, stored(seed).end]).toEqual([minted.start, minted.end]);
    expect(validateAnchor(seed, stored(seed)).range).toBeNull();
  }, TWINS));

  it('deleting a commented paragraph and undoing it reattaches the comment', () => scene(async (seed, a) => {
    comment(seed, 'lazy dog');
    const start = project(seed).text.indexOf('lazy dog');
    a.edit(() => paragraph(0).remove());
    frame(seed, a.doc);
    expect(stored(seed).status).toBe('orphaned');
    a.undo();
    frame(seed, a.doc);
    expect(stored(seed).status).toBe('anchored');
    expect(validateAnchor(seed, stored(seed)).range).toEqual({ start, end: start + 'lazy dog'.length });
  }));

  it('deleting and retyping the same text leaves the comment orphaned', () => scene(async (seed, a) => {
    const minted = comment(seed, 'brown fox');
    a.edit(() => { firstText().spliceText(10, 'brown fox'.length, ''); });
    frame(seed, a.doc);
    expect(stored(seed).status).toBe('orphaned');
    a.edit(() => { firstText().spliceText(10, 0, 'brown fox'); });
    frame(seed, a.doc);
    expect(project(seed).text.startsWith('The quick brown fox jumps')).toBe(true);
    expect(stored(seed).status, 'no silent retarget').toBe('orphaned');
    expect([stored(seed).start, stored(seed).end]).toEqual([minted.start, minted.end]);
  }));

  it('deleting a commented block whose twin has the same context orphans it', () => scene(async (seed, a) => {
    const twin = project(seed).text.indexOf('￼');
    comment(seed, '￼', twin + 1);
    a.edit(() => findAll('code-block')[1].remove());
    frame(seed, a.doc);
    expect(project(seed).text.indexOf('￼')).toBe(twin);
    expect(project(seed).text.lastIndexOf('￼')).toBe(twin);
    expect(stored(seed).status).toBe('orphaned');
    expect(validateAnchor(seed, stored(seed)).range).toBeNull();
  }, `${PAD}\n\n\`\`\`js\nx\n\`\`\`\n\n${PAD}\n\n\`\`\`js\nx\n\`\`\`\n\n${PAD}`));

  it('an anchor that never had positions (an import, or a quote-only REST comment) attaches by its quote', () => scene(async (seed) => {
    const quoteOnly: TreeAnchor = { start: '', end: '', quote: { exact: 'lazy dog', prefix: 'over the ', suffix: '.' }, hint: 0, status: 'orphaned' };
    const checked = validateAnchor(seed, quoteOnly);
    expect(checked.anchor.status).toBe('anchored');
    expect(textOf(seed, checked.anchor)).toBe('lazy dog');
  }));

  it('a block comment anchors the decorator embed and survives a paragraph above and edits inside its register', () => scene(async (seed, a, b) => {
    const anchor = anchorOn(seed, '￼');
    a.edit(() => { paragraph(0).insertBefore($createParagraphNode().append($createTextNode('Intro line'))); });
    b.edit(() => { (findAll('code-block')[0] as unknown as { setCode: (code: string) => void }).setCode('const x = 2;'); });
    await sync(seed, a.doc, b.doc);
    expect(project(seed).text.startsWith('Intro line\n')).toBe(true);
    for (const doc of [seed, a.doc, b.doc]) {
      const range = validateAnchor(doc, anchor).range;
      expect(range && range.end - range.start).toBe(1);
      expect(range?.start).toBe(project(doc).text.indexOf('￼'));
    }
  }));
});

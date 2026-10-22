// MEM.lean: the @lexical/yjs patch's lean stored layout (LEAN_LAYOUT). A property at its class's default is not
// written and reads back as the default; a text node's other properties ride one `__props` entry. A plain paragraph
// costs five structs instead of fifteen, every fixture exports as it did, a doc written in the earlier layout (v1)
// reads the same, and peers converge.
import { readdirSync, readFileSync } from 'node:fs';
import { registerList } from '@lexical/list';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { $getRoot, $isElementNode, $isTextNode, TextNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor, exportMarkdown } from './converter/index.ts';
import { excludedPropertiesFor } from './excluded-properties.ts';
import { payloadDocsFor } from './payload-docs.ts';
import { bindRegisters } from './registers.ts';
import { exportDocMarkdown, importBody } from './server-doc.ts';

type Layout = 'v1' | 'lean';

/** The converter's family corpus, read as search-core.golden.test.ts reads it. */
const FIXTURES_DIR = new URL('./converter/fixtures/', import.meta.url);
const FIXTURES = readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.md')).sort().map((file) => [file, readFileSync(new URL(file, FIXTURES_DIR), 'utf8')] as const);
const layoutGlobal = globalThis as { __MOSS_YJS_LAYOUT?: string };

/** Runs `run` with every binding it creates on `layout`. */
function withLayout<T>(layout: Layout, run: () => T): T {
  const before = layoutGlobal.__MOSS_YJS_LAYOUT;
  if (layout === 'v1') layoutGlobal.__MOSS_YJS_LAYOUT = 'v1';
  else delete layoutGlobal.__MOSS_YJS_LAYOUT;
  try {
    return run();
  } finally {
    if (before === undefined) delete layoutGlobal.__MOSS_YJS_LAYOUT;
    else layoutGlobal.__MOSS_YJS_LAYOUT = before;
  }
}

const structs = (doc: Y.Doc) => [...doc.store.clients.values()].reduce((count, list) => count + list.length, 0);

/** The note as the DocDO's import writes it under `layout`. */
const written = (markdown: string, layout: Layout) =>
  withLayout(layout, () => {
    const doc = new Y.Doc();
    importBody(doc, markdown);
    return doc;
  });

const blocks = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const runs = (block: unknown) => ((block as Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).filter((insert): insert is Y.Map<unknown> => insert instanceof Y.Map);

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** A bound editor on `layout`, hydrated from `seed`, as replication.test.ts builds one. */
function peer(seed: Y.Doc, layout: Layout = 'lean') {
  return withLayout(layout, () => {
    const doc = new Y.Doc();
    const editor = createConverterEditor();
    const stops = [registerList(editor), editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace)];
    const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
    stops.push(bindRegisters(editor, doc));
    stops.push(editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
      syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
    }));
    const root = binding.root.getSharedType();
    const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
      if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, noop);
    };
    root.observeDeep(observer);
    for (const [id, payload] of payloadDocsFor(seed).docs) Y.applyUpdate(payloadDocsFor(doc).hold(id), Y.encodeStateAsUpdate(payload));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    editor.update(noop, { discrete: true });
    return { doc, editor, dispose: () => { stops.forEach((stop) => stop()); root.unobserveDeep(observer); payloadDocsFor(doc).destroy(); doc.destroy(); } };
  });
}
type Peer = ReturnType<typeof peer>;

const sync = (a: Peer, b: Peer) => {
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
};
const treeOf = (p: Peer) => JSON.stringify(p.editor.getEditorState().toJSON());
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function firstText(node: LexicalNode = $getRoot()): TextNode | undefined {
  if ($isTextNode(node)) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = firstText(child); if (found) return found; }
  return undefined;
}

function firstBlock() {
  const block = $getRoot().getFirstChild();
  if (!$isElementNode(block)) throw new Error('the note starts with no element');
  return block;
}

describe('MEM.lean stored layout', () => {
  it('stores a plain paragraph in five structs: its embed and type, its text run\'s embed and type, and the text', () => {
    const markdown = 'One.\n\nTwo.\n\nThree.';
    expect(structs(written(markdown, 'v1')), 'positive control: fifteen per paragraph in v1').toBe(45);
    const lean = written(markdown, 'lean');
    expect(structs(lean)).toBe(15);
    for (const block of blocks(lean)) {
      expect((block as Y.XmlText).getAttributes()).toEqual({ __type: 'paragraph' });
      expect(runs(block).map((run) => Object.fromEntries(run.entries()))).toEqual([{ __type: 'text' }]);
    }
  });

  it('packs a text run\'s properties off their defaults into one entry', () => {
    const [block] = blocks(written('Plain **bold** and *it*', 'lean'));
    expect(runs(block).map((run) => Object.fromEntries(run.entries()))).toEqual([
      { __type: 'text' },
      { __type: 'text', __props: { __format: 1 } },
      { __type: 'text' },
      { __type: 'text', __props: { __format: 2 } },
    ]);
  });

  it.each(FIXTURES)('%s exports the same under either layout, and its v1 doc reads the same under lean', (_name, markdown) => {
    const v1 = written(markdown, 'v1');
    const lean = written(markdown, 'lean');
    const expected = withLayout('v1', () => exportDocMarkdown(v1));
    expect(withLayout('lean', () => exportDocMarkdown(lean)), 'lean written, lean read').toBe(expected);
    expect(withLayout('lean', () => exportDocMarkdown(v1)), 'v1 written, lean read').toBe(expected);
    expect(structs(lean)).toBeLessThanOrEqual(structs(v1));
  });

  it('a v1 reader drops the packed text formats of a lean doc, so every reader must understand lean before any writer uses it', () => {
    const lean = written('Plain **bold** text.', 'lean');
    expect(withLayout('lean', () => exportDocMarkdown(lean))).toBe('Plain **bold** text.');
    expect(withLayout('v1', () => exportDocMarkdown(lean))).toBe('Plain bold text.');
  });

  it('a property set back to its default is removed from the doc, and the peer reads the default', async () => {
    const seed = written('First paragraph.', 'lean');
    const ada = peer(seed);
    const ben = peer(seed);
    try {
      ada.editor.update(() => { firstBlock().setIndent(2); firstText()!.setFormat(1); }, { discrete: true });
      sync(ada, ben);
      await settle();
      expect(treeOf(ben)).toBe(treeOf(ada));
      expect((blocks(ben.doc)[0] as Y.XmlText).getAttribute('__indent')).toBe(2);
      ada.editor.update(() => { firstBlock().setIndent(0); firstText()!.setFormat(0); }, { discrete: true });
      sync(ada, ben);
      await settle();
      expect(treeOf(ben)).toBe(treeOf(ada));
      expect(ben.editor.read(() => firstText()!.getFormat())).toBe(0);
      expect((blocks(ben.doc)[0] as Y.XmlText).getAttributes()).toEqual({ __type: 'paragraph' });
      expect(runs(blocks(ben.doc)[0]).map((run) => [...run.keys()])).toEqual([['__type']]);
    } finally { ada.dispose(); ben.dispose(); seed.destroy(); }
  });

  it('peers converge when both change one text run\'s packed properties at once', async () => {
    const seed = written('Shared run.', 'lean');
    const ada = peer(seed);
    const ben = peer(seed);
    try {
      ada.editor.update(() => firstText()!.setFormat(1), { discrete: true });
      ben.editor.update(() => firstText()!.setStyle('color: red'), { discrete: true });
      sync(ada, ben);
      await settle();
      // One packed entry per run: the concurrent writes resolve to one of them, the same on both peers.
      expect(treeOf(ben)).toBe(treeOf(ada));
      expect(exportMarkdown(ben.editor)).toBe(exportMarkdown(ada.editor));
    } finally { ada.dispose(); ben.dispose(); seed.destroy(); }
  });

  it('a lean edit folds a v1 run\'s loose keys into its packed entry', async () => {
    const seed = written('Old **bold** run.', 'v1');
    const ada = peer(seed);
    const ben = peer(seed);
    try {
      const bold = (p: Peer) => runs(blocks(p.doc)[0])[1];
      expect([...bold(ada).keys()].sort(), 'positive control: v1 wrote every key').toEqual(['__detail', '__format', '__mode', '__style', '__type']);
      ada.editor.update(() => { const run = firstBlock().getChildren()[1]; if ($isTextNode(run)) run.setFormat(3); }, { discrete: true });
      sync(ada, ben);
      await settle();
      expect(Object.fromEntries(bold(ben).entries())).toEqual({ __type: 'text', __props: { __format: 3 } });
      expect(treeOf(ben)).toBe(treeOf(ada));
      expect(exportMarkdown(ben.editor)).toBe('Old ***bold*** run.');
    } finally { ada.dispose(); ben.dispose(); seed.destroy(); }
  });
});

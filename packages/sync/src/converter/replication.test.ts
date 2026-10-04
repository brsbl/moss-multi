// L4 (S-conv §5.1, A6/A7/A8): every family replicates editor A → Y.Doc → editor B with the same tree and export, the
// wire carries no per-viewer field, and concurrent typing beside every inline decorator keeps both sides.
import { registerList } from '@lexical/list';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type Provider } from '@lexical/yjs';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { $getRoot, $isElementNode, $isTextNode, TextNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './converter/index.ts';
import { FIXTURES, stringify } from './converter/fixtures.ts';
import { EXCLUDED_FIELDS, excludedPropertiesFor } from './excluded-properties.ts';
import { bindRegisters } from './registers.ts';
import { exportDocMarkdown, importBody } from './server-doc.ts';

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** A V1-bound editor with the live editor's list and whitespace transforms, hydrated from `seed`. */
function client(seed?: Y.Doc) {
  const doc = new Y.Doc(); const editor = createConverterEditor();
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
  if (seed) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  editor.update(noop, { discrete: true });
  return { doc, editor, dispose: () => { stops.forEach(stop => stop()); root.unobserveDeep(observer); doc.destroy(); } };
}
type Peer = ReturnType<typeof client>;
const tree = (peer: Peer) => stringify(peer.editor.getEditorState().toJSON());
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** Every attribute key on every element of the shared tree, depth first. */
function wireKeys(type: Y.XmlText | Y.XmlElement, found = new Map<string, Set<string>>()): Map<string, Set<string>> {
  const attributes = type.getAttributes() as Record<string, unknown>;
  const kind = String(attributes.__type ?? type.constructor.name);
  for (const key of Object.keys(attributes)) found.set(kind, (found.get(kind) ?? new Set()).add(key));
  const children = type instanceof Y.XmlText ? type.toDelta().map((op: { insert?: unknown }) => op.insert) : type.toArray();
  for (const child of children) if (child instanceof Y.XmlText || child instanceof Y.XmlElement) wireKeys(child, found);
  return found;
}

describe('L4 every family replicates through the binding @p:tech-1 @p:col-1 @p:note-2', () => {
  it.each(FIXTURES.filter(f => !f.name.startsWith('scale')).map(f => [f.name, f] as const))('%s: A → Y.Doc → B keeps the tree, the export and the wire', async (name, { markdown, options }) => {
    const a = client();
    let b: Peer | undefined;
    try {
      a.editor.update(() => $importNoteBody(markdown, options), { discrete: true });
      await settle();
      b = client(a.doc);
      await settle();
      expect(tree(b), `${name}: B's tree`).toBe(tree(a));
      expect(exportMarkdown(b.editor), `${name}: B's export`).toBe(exportMarkdown(a.editor));
      // The DocDO recomputes executable formulas on export; elsewhere its export is the editors'.
      if (!markdown.includes('{{')) expect(exportDocMarkdown(a.doc), `${name}: the server's export`).toBe(exportMarkdown(a.editor));
      const keys = wireKeys(a.doc.get('root', Y.XmlText));
      for (const [type, fields] of Object.entries(EXCLUDED_FIELDS)) {
        for (const field of fields) expect(keys.get(type)?.has(field) ?? false, `${name}: ${type}.${field} stays off the wire`).toBe(false);
      }
      expect([...keys.values()].some(set => set.has('__type')), 'positive control: the scan reads node attributes').toBe(true);
    } finally { a.dispose(); b?.dispose(); }
  });
});

const INLINE = [
  { type: 'formula', markdown: 'Left {{2+3|5}} right' },
  { type: 'file-link', markdown: 'Left [[Launch Plan]] right' },
  { type: 'embed-pill', markdown: 'Left https://example.com/a right' },
  { type: 'color-code', markdown: 'Left #ff0000 right' },
] as const;

function find(type: string, node: LexicalNode = $getRoot()): LexicalNode | undefined {
  if (node.getType() === type) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = find(type, child); if (found) return found; }
}

describe('A8 concurrent typing beside every inline decorator keeps both sides @p:col-1 @p:note-2', () => {
  it.each(INLINE)('$type', async ({ type, markdown }) => {
    const seed = new Y.Doc(); importBody(seed, markdown);
    const a = client(seed); const b = client(seed);
    try {
      await settle();
      expect(a.editor.read(() => find(type)), `${type} imports as its node`).toBeDefined();
      a.editor.update(() => {
        const before = find(type)!.getPreviousSibling();
        if ($isTextNode(before)) before.setTextContent(`${before.getTextContent()}ADA `);
      }, { discrete: true });
      b.editor.update(() => {
        const after = find(type)!.getNextSibling();
        if ($isTextNode(after)) after.setTextContent(` BEN${after.getTextContent()}`);
      }, { discrete: true });
      Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
      Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
      await settle();
      for (const peer of [a, b]) {
        const text = exportMarkdown(peer.editor);
        expect(text, 'Ada keeps her text').toContain('ADA');
        expect(text, 'Ben keeps his text').toContain('BEN');
        expect(peer.editor.read(() => find(type)), `the ${type} stays`).toBeDefined();
      }
      expect(tree(b)).toBe(tree(a));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });
});

// T3.B31b: the binding's lean stored layout (A§10.11). A property at its class's default is not written and reads back
// as the default; a key once stored is always written, never deleted. Docs written in the earlier layout read as before,
// an older binding reads lean docs, both converge when editing one doc, and the class defaults stay pinned.
import { registerList } from '@lexical/list';
import * as lean from '@lexical/yjs';
import type { Binding, Provider } from '@lexical/yjs';
import { $normalizeFormatWhitespace } from '@moss-desktop/renderer/editor/markdown/format-whitespace';
import { $createParagraphNode, $createTextNode, $getRoot, $isElementNode, $isTextNode, TextNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { flatList, shortParagraphs, table } from '../../../../e2e/lib/large-notes.ts';
import { structsPerBlock } from '../../measure/structs-per-block.ts';
import * as v1 from '../../test/fixtures/lexical-yjs-v1/index.mjs';
import { excludedPropertiesFor } from '../excluded-properties.ts';
import { payloadDocsFor } from '../payload-docs.ts';
import { bindRegisters } from '../registers.ts';
import { exportDocMarkdown, importBody, seedEmptyParagraph } from '../server-doc.ts';
import { $importNoteBody, createConverterEditor, exportMarkdown } from './index.ts';
import { FIXTURES, stringify } from './fixtures.ts';
import DEFAULTS_GOLDEN from './fixtures/node-defaults.json';

type BindingModule = typeof lean;
const LAYOUTS = { lean, v1: v1 as BindingModule } as const;
type Layout = keyof typeof LAYOUTS;

const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop, disconnect: noop, on: noop, off: noop,
} as unknown as Provider;

/** A V1-bound editor on `layout`'s binding, as replication.test.ts builds one, hydrated from `seed`. */
function peer(layout: Layout, seed?: Y.Doc) {
  const yjs = LAYOUTS[layout];
  const doc = new Y.Doc(); const editor = createConverterEditor();
  const stops = [registerList(editor), editor.registerNodeTransform(TextNode, $normalizeFormatWhitespace)];
  const binding = yjs.createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excludedPropertiesFor(editor));
  stops.push(bindRegisters(editor, doc));
  stops.push(editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    yjs.syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  }));
  const root = binding.root.getSharedType();
  const observer: Parameters<typeof root.observeDeep>[0] = (events, transaction) => {
    if (transaction.origin !== binding) yjs.syncYjsChangesToLexical(binding, provider, events as never, false, noop);
  };
  root.observeDeep(observer);
  if (seed) {
    for (const [id, payload] of payloadDocsFor(seed).docs) Y.applyUpdate(payloadDocsFor(doc).hold(id), Y.encodeStateAsUpdate(payload));
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
  }
  editor.update(noop, { discrete: true });
  return { doc, editor, binding, dispose: () => { stops.forEach(stop => stop()); root.unobserveDeep(observer); payloadDocsFor(doc).destroy(); doc.destroy(); } };
}
type Peer = ReturnType<typeof peer>;

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const sync = async (...peers: Peer[]) => {
  for (const a of peers) for (const b of peers) if (a !== b) Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  await settle();
};

/** The tree without per-viewer fields and the list marker NodeState, as replication.test.ts compares trees. */
const PER_VIEWER = new Set(['resolutionState', 'colWidths', 'activeIndex', 'tabWidths']);
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (PER_VIEWER.has(key)) continue;
    if (key === '$') {
      const state = { ...(child as Record<string, unknown>) };
      delete state.mdListMarker;
      if (Object.keys(state).length > 0) out[key] = normalize(state);
      continue;
    }
    out[key] = normalize(child);
  }
  return out;
}
const tree = (p: Peer) => stringify(normalize(p.editor.getEditorState().toJSON()));

/** The note as the DocDO's import writes it (the server's binding). */
function serverWritten(markdown: string): Y.Doc {
  const doc = new Y.Doc();
  importBody(doc, markdown);
  return doc;
}

/** The note as a client on `layout` writes it, importing `markdown` in its editor. */
async function clientWritten(layout: Layout, markdown: string, options = {}) {
  const writer = peer(layout);
  writer.editor.update(() => $importNoteBody(markdown, options), { discrete: true });
  await settle();
  return writer;
}

const blocks = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map(op => op.insert);
const runs = (block: unknown) => ((block as Y.XmlText).toDelta() as { insert: unknown }[]).map(op => op.insert).filter((insert): insert is Y.Map<unknown> => insert instanceof Y.Map);
const firstRun = (doc: Y.Doc) => runs(blocks(doc)[0])[0]!;
const entries = (map: Y.Map<unknown>) => Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));

function firstText(node: LexicalNode = $getRoot()): TextNode | undefined {
  if ($isTextNode(node)) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = firstText(child); if (found) return found; }
  return undefined;
}
const textOf = (p: Peer) => p.editor.read(() => { const text = firstText(); return { format: text?.getFormat(), style: text?.getStyle() }; });

describe('T3.B31b the lean stored layout: structs per block @p:tech-1 @p:note-2', () => {
  it.each([
    ['plain paragraph', shortParagraphs(30), 5],
    ['list item', flatList(30), 6],
    ['two-cell table row', table(30), 16],
  ] as const)('a %s costs at most its bound in structs', async (kind, markdown, bound) => {
    const old = await clientWritten('v1', markdown);
    try {
      expect(structsPerBlock(old.doc).median, `positive control: a ${kind} written in the earlier layout costs more`).toBeGreaterThan(bound);
    } finally { old.dispose(); }
    const doc = serverWritten(markdown);
    const counted = structsPerBlock(doc);
    expect(counted.blocks, 'every block is counted').toBeGreaterThanOrEqual(30);
    expect(counted.median, `structs per ${kind}`).toBeLessThanOrEqual(bound);
    expect(counted.mean, `mean structs per ${kind}`).toBeLessThanOrEqual(bound + 0.1);
    const client = await clientWritten('lean', markdown);
    try {
      expect(structsPerBlock(client.doc).median, `structs per ${kind}, written by a client`).toBeLessThanOrEqual(bound);
    } finally { client.dispose(); }
  });

  it('stores a plain paragraph as its type and its text run as its type and characters', () => {
    const doc = serverWritten('One.\n\nTwo.');
    for (const block of blocks(doc)) {
      expect((block as Y.XmlText).getAttributes()).toEqual({ __type: 'paragraph' });
      expect(runs(block).map(entries)).toEqual([{ __type: 'text' }]);
    }
    const seeded = new Y.Doc();
    seedEmptyParagraph(seeded);
    expect((blocks(seeded)[0] as Y.XmlText).getAttributes(), 'the seed is lean too').toEqual({ __type: 'paragraph' });
  });
});

describe('T3.B31b old and lean layouts read each other @p:col-1 @p:note-2', () => {
  it.each(FIXTURES.filter(f => !f.name.startsWith('scale')).map(f => [f.name, f] as const))('%s: written in either layout, read by the other, exports the same', async (name, { markdown, options }) => {
    for (const [writerLayout, readerLayout] of [['v1', 'lean'], ['lean', 'v1']] as const) {
      const writer = await clientWritten(writerLayout, markdown, options);
      const reader = peer(readerLayout, writer.doc);
      try {
        await settle();
        expect(exportMarkdown(reader.editor), `${name}: written ${writerLayout}, read ${readerLayout}: the export`).toBe(exportMarkdown(writer.editor));
        expect(tree(reader), `${name}: written ${writerLayout}, read ${readerLayout}: the tree`).toBe(tree(writer));
      } finally { writer.dispose(); reader.dispose(); }
    }
    // The server's lean write, read by an older client and by the server's own export.
    const doc = serverWritten(markdown);
    const old = peer('v1', doc);
    const current = peer('lean', doc);
    try {
      await settle();
      expect(exportMarkdown(old.editor), `${name}: the server's lean write read by an older client`).toBe(exportMarkdown(current.editor));
      if (!markdown.includes('{{')) expect(exportDocMarkdown(doc), `${name}: the server's export`).toBe(exportMarkdown(current.editor));
    } finally { old.dispose(); current.dispose(); doc.destroy(); }
  });

  it('opens an old-layout doc without rewriting it, and edits it in place', async () => {
    const writer = await clientWritten('v1', 'First **bold** line.\n\nSecond line.\n\n- item\n- item two');
    const reader = peer('lean');
    const updates: Uint8Array[] = [];
    try {
      Y.applyUpdate(reader.doc, Y.encodeStateAsUpdate(writer.doc));
      reader.doc.on('update', (update: Uint8Array) => updates.push(update));
      reader.editor.update(noop, { discrete: true });
      await settle();
      expect(updates, 'reading writes nothing').toEqual([]);
      const before = blocks(reader.doc);
      reader.editor.update(() => { firstText()!.setTextContent('Changed '); }, { discrete: true });
      await settle();
      expect(updates.length, 'the edit writes').toBeGreaterThan(0);
      const after = blocks(reader.doc);
      expect(after.length).toBe(before.length);
      expect(after.every((block, i) => block === before[i]), 'every block keeps its item').toBe(true);
      for (const update of updates) {
        const { structs } = Y.decodeUpdate(update);
        const types = structs.filter(struct => struct instanceof Y.Item && struct.content instanceof Y.ContentType);
        expect(types, 'the edit creates no element or run').toEqual([]);
      }
      await sync(writer, reader);
      expect(exportMarkdown(writer.editor)).toBe(exportMarkdown(reader.editor));
      expect(exportMarkdown(reader.editor)).toContain('Changed');
    } finally { writer.dispose(); reader.dispose(); }
  });
});

describe('T3.B31b concurrent edits under the lean layout @p:col-1', () => {
  it.each(['v1', 'lean'] as const)('old and lean writers editing one %s-written doc converge', async (seedLayout) => {
    const writer = await clientWritten(seedLayout, 'Shared **line** here.\n\nSecond.\n\n- one\n- two');
    const old = peer('v1', writer.doc);
    const current = peer('lean', writer.doc);
    try {
      await settle();
      old.editor.update(() => {
        firstText()!.toggleFormat('italic');
        $getRoot().append($createParagraphNode().append($createTextNode('Added by the older peer.')));
      }, { discrete: true });
      current.editor.update(() => {
        firstText()!.setStyle('color: red');
        const second = $getRoot().getChildAtIndex(1);
        if ($isElementNode(second)) second.setFormat('center');
      }, { discrete: true });
      await sync(old, current);
      current.editor.update(() => { firstText()!.toggleFormat('italic'); }, { discrete: true });
      old.editor.update(() => { const second = $getRoot().getChildAtIndex(1); if ($isElementNode(second)) second.setFormat(''); }, { discrete: true });
      await sync(old, current, writer);
      expect(tree(old)).toBe(tree(current));
      expect(tree(writer)).toBe(tree(current));
      expect(exportMarkdown(old.editor)).toBe(exportMarkdown(current.editor));
      expect(textOf(current)).toEqual({ format: 0, style: 'color: red' });
      expect(current.editor.read(() => { const second = $getRoot().getChildAtIndex(1); return $isElementNode(second) ? second.getFormatType() : null; })).toBe('');
      expect(exportMarkdown(current.editor)).toContain('Added by the older peer.');
    } finally { writer.dispose(); old.dispose(); current.dispose(); }
  });

  it('two peers changing different properties of one text run at once both keep their change', async () => {
    const seed = serverWritten('Plain words.');
    expect(entries(firstRun(seed)), 'the run stores its type alone').toEqual({ __type: 'text' });
    const a = peer('lean', seed);
    const b = peer('lean', seed);
    try {
      await settle();
      a.editor.update(() => { firstText()!.toggleFormat('bold'); }, { discrete: true });
      b.editor.update(() => { firstText()!.setStyle('color: red'); }, { discrete: true });
      await sync(a, b);
      for (const p of [a, b]) expect(textOf(p)).toEqual({ format: 1, style: 'color: red' });
      expect(entries(firstRun(a.doc))).toEqual({ __format: 1, __style: 'color: red', __type: 'text' });
      expect(tree(a)).toBe(tree(b));
    } finally { a.dispose(); b.dispose(); seed.destroy(); }
  });
});

describe('T3.B31b back to a default @p:col-1', () => {
  it('writes the default once its key is stored, and undo and redo cross the default both ways', async () => {
    const seed = serverWritten('Plain words.');
    const a = peer('lean', seed);
    const b = peer('v1', seed);
    const undo = new Y.UndoManager(a.binding.root.getSharedType(), { trackedOrigins: new Set([a.binding as Binding]), captureTimeout: 0 });
    const check = async (format: number, stored: number | undefined, step: string) => {
      await sync(a, b);
      expect(textOf(a).format, `${step}: the format`).toBe(format);
      expect(firstRun(a.doc).get('__format'), `${step}: the stored format`).toBe(stored);
      expect(firstRun(a.doc).has('__format'), `${step}: whether the key is stored`).toBe(stored !== undefined);
      expect(exportMarkdown(b.editor), `${step}: an older peer's export`).toBe(exportMarkdown(a.editor));
    };
    try {
      await settle();
      await check(0, undefined, 'imported');
      a.editor.update(() => { firstText()!.toggleFormat('bold'); }, { discrete: true });
      await check(1, 1, 'bold');
      a.editor.update(() => { firstText()!.toggleFormat('bold'); }, { discrete: true });
      await check(0, 0, 'back to plain: the default is written, the key kept');
      undo.undo();
      await check(1, 1, 'undo: bold');
      undo.undo();
      expect(exportMarkdown(a.editor)).toBe('Plain words.');
      await check(0, undefined, 'undo: plain, the key gone with the write that made it');
      undo.redo();
      await check(1, 1, 'redo: bold');
      undo.redo();
      await check(0, 0, 'redo: plain');
    } finally { undo.destroy(); a.dispose(); b.dispose(); seed.destroy(); }
  });
});

/** A default as the golden records it: JSON values as they are, anything else by kind. */
function pinned(value: unknown): unknown {
  if (value === undefined) return { $: 'undefined' };
  if (value === null || typeof value !== 'object') return typeof value === 'function' ? { $: 'function' } : value;
  if (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype) return JSON.parse(JSON.stringify(value));
  return { $: (value as object).constructor?.name ?? 'object' };
}

describe('T3.B31b the class defaults are pinned', () => {
  it('every synced property of every registered node class has its golden default', () => {
    const editor = createConverterEditor();
    const binding = lean.createBinding(editor, provider, 'root', new Y.Doc(), new Map(), excludedPropertiesFor(editor)) as Binding & {
      nodeProperties: Map<string, Record<string, unknown>>;
      leanDefaults?: Map<string, Record<string, unknown>>;
    };
    const actual: Record<string, Record<string, unknown>> = {};
    editor.update(() => {
      for (const type of [...binding.nodeProperties.keys()].sort()) {
        const twin = new (editor._nodes.get(type)!.klass)() as unknown as Record<string, unknown>;
        const defaults = binding.nodeProperties.get(type)!;
        actual[type] = Object.fromEntries(Object.keys(defaults).sort().map((key) => {
          const value = pinned(defaults[key]);
          return [key, JSON.stringify(value) === JSON.stringify(pinned(twin[key])) ? value : { $: 'varies' }];
        }));
      }
    }, { discrete: true });
    expect(actual, [
      'A node class default differs from the pinned golden (fixtures/node-defaults.json). A lean doc reads a missing',
      'key as the class default, so a re-pin of vendor/moss that changes one needs a migration decision before the golden',
      `is updated. Actual: ${JSON.stringify(actual)}`,
    ].join(' ')).toEqual(DEFAULTS_GOLDEN);
    // What the binding leaves out: each primitive default the same in every fresh node, `__type` aside.
    const expected = Object.fromEntries(Object.entries(actual).map(([type, defaults]) => [type, Object.fromEntries(Object.entries(defaults)
      .filter(([key, value]) => key !== '__type' && (value === null || typeof value !== 'object' || (value as { $?: string }).$ === 'undefined'))
      .map(([key, value]) => [key, typeof value === 'object' && value !== null ? undefined : value]))]));
    expect(Object.fromEntries(binding.leanDefaults ?? []), 'the defaults the binding leaves out').toEqual(expected);
  });
});

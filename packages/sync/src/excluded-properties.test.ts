// The exclusion map's type fallback (A§10.9): Lexical asks for a node's exclusions with `node.constructor`, so a
// node whose constructor is not the class the map was built from (a duplicated module, a replaced class) must still
// keep its per-viewer fields off the wire.
import { createHeadlessEditor } from '@lexical/headless';
import { $createTableNodeWithDimensions, TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { createBinding, syncLexicalUpdateToYjs, syncYjsChangesToLexical, type ExcludedProperties, type Provider } from '@lexical/yjs';
import { $copyNode, $getRoot, $isDecoratorNode, $isElementNode, type Klass, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { $importNoteBody, createConverterEditor } from './converter/index.ts';
import { buildExcludedProperties, EXCLUDED_FIELDS, excludedPropertiesFor } from './excluded-properties.ts';

/** The same node type from another module instance: same `getType()`, another constructor. */
class DuplicatedTableNode extends TableNode {}

const TABLE_ONLY = { table: ['__colWidths'] } as const;
const noop = () => {};
const provider = {
  awareness: { getLocalState: () => null, getStates: () => new Map(), on: noop, off: noop, setLocalState: noop, setLocalStateField: noop },
  connect: noop,
  disconnect: noop,
  on: noop,
  off: noop,
} as unknown as Provider;

/** The attributes every embedded element carries in a V1 doc, depth first. */
function elementAttributes(text: Y.XmlText): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const op of text.toDelta() as { insert: unknown }[]) {
    if (op.insert instanceof Y.XmlText) found.push(op.insert.getAttributes(), ...elementAttributes(op.insert));
  }
  return found;
}

/** Writes a table with column widths through a V1 binding that uses `excluded`; returns the table's attributes. */
function tableOnTheWire(excluded: ExcludedProperties): Record<string, unknown> {
  const editor = createHeadlessEditor({
    nodes: [TableNode, TableRowNode, TableCellNode],
    onError: (error) => {
      throw error;
    },
  });
  const doc = new Y.Doc();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excluded);
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  editor.update(() => $getRoot().append($createTableNodeWithDimensions(2, 2, false).setColWidths([120, 240])), { discrete: true });
  const table = elementAttributes(doc.get('root', Y.XmlText)).find((attributes) => attributes.__type === 'table');
  if (!table) throw new Error('the table never reached the doc');
  return table;
}

describe('excluded properties', () => {
  it('falls back to the node type when the constructor is not the class the map was built from', () => {
    const excluded = buildExcludedProperties([DuplicatedTableNode], TABLE_ONLY);
    expect(excluded.get(DuplicatedTableNode)).toEqual(new Set(['__colWidths']));
    expect(excluded.get(TableNode as Klass<LexicalNode>)).toEqual(new Set(['__colWidths']));
    expect(excluded.get(TableRowNode as Klass<LexicalNode>)).toBeUndefined();
  });

  it('keeps a per-viewer field off the wire for a node of another constructor', () => {
    expect(tableOnTheWire(new Map()).__colWidths, 'positive control: with no exclusions the widths replicate').toEqual([120, 240]);
    const table = tableOnTheWire(buildExcludedProperties([DuplicatedTableNode], TABLE_ONLY));
    expect(table.__type).toBe('table');
    expect(Object.keys(table)).not.toContain('__colWidths');
  });

  it('throws when a listed type is not registered', () => {
    expect(() => buildExcludedProperties([TableNode], { 'tab-group': ['__activeIndex'] })).toThrow(/tab-group/);
  });

  it("names only node types moss's editor registers", () => {
    const excluded = excludedPropertiesFor(createConverterEditor());
    for (const [type, fields] of Object.entries(EXCLUDED_FIELDS)) {
      const klass = [...createConverterEditor()._nodes.values()].find((entry) => entry.klass.getType() === type)?.klass;
      expect(klass, `${type} is registered`).toBeDefined();
      expect(excluded.get(klass as Klass<LexicalNode>), type).toEqual(new Set(fields));
    }
  });
});

/** Every decorator type moss lets a comment sit on (a `__commentIds` field on the class). */
const COMMENTABLE = ['code-block', 'html-block', 'formula', 'chart', 'sketch', 'image', 'video', 'web-embed', 'embed-pill', 'file-link'];
const DECORATORS = [
  '```js\nconst x = 1;\n```',
  '```moss-html\n<p>Hello</p>\n```',
  'A formula {{2+3|5}}, a link [[Launch Plan]] and a pill https://example.com/a here.',
  '```moss-chart\n{"type":"bar","data":[{"label":"A","value":1}]}\n```',
  '```moss-canvas\n[moss:grid:v2]\n....####....\n```',
  '![An image](https://images.example.com/remote.jpg)',
  '![A clip](assets/clip.mp4)',
  '![Example site](https://example.com)',
].join('\n\n');

type Commentable = LexicalNode & { getCommentIds(): string[]; setCommentIds(ids: string[]): void };
function $commentables(node: LexicalNode = $getRoot(), out: Commentable[] = []): Commentable[] {
  if ($isDecoratorNode(node) && typeof (node as Partial<Commentable>).setCommentIds === 'function') out.push(node as Commentable);
  if ($isElementNode(node)) for (const child of node.getChildren()) $commentables(child, out);
  return out;
}

/** A moss editor bound to `doc` through V1 with `excluded`, and every update the binding writes. */
function bound(doc: Y.Doc, excluded: (editor: ReturnType<typeof createConverterEditor>) => ExcludedProperties) {
  const editor = createConverterEditor();
  const binding = createBinding(editor, provider, 'root', doc, new Map([['root', doc]]), excluded(editor));
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === binding) updates.push(update);
  });
  editor.registerUpdateListener(({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) => {
    syncLexicalUpdateToYjs(binding, provider, prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags);
  });
  binding.root.getSharedType().observeDeep((events, transaction) => {
    if (transaction.origin !== binding) syncYjsChangesToLexical(binding, provider, events as never, false, () => {});
  });
  return { editor, updates };
}

/** The attributes of every element and text type under `type`, decorators (XmlElements) included. */
function everyAttributes(type: Y.XmlText | Y.XmlElement, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  const children = type instanceof Y.XmlText ? (type.toDelta() as { insert: unknown }[]).map((op) => op.insert) : type.toArray();
  for (const child of children) {
    if (!(child instanceof Y.XmlText || child instanceof Y.XmlElement)) continue;
    found.push(child.getAttributes());
    everyAttributes(child, found);
  }
  return found;
}

/** The property keys the updates write, and the node types they create. */
function written(updates: Uint8Array[]): { keys: Set<string>; types: Set<string> } {
  const keys = new Set<string>();
  const types = new Set<string>();
  for (const update of updates) {
    for (const struct of Y.decodeUpdate(update).structs) {
      if (!(struct instanceof Y.Item) || struct.parentSub === null) continue;
      keys.add(struct.parentSub);
      if (struct.parentSub === '__type' && struct.content instanceof Y.ContentAny) types.add(String(struct.content.getContent()[0]));
    }
  }
  return { keys, types };
}

/** Create every commentable decorator, comment on each, then copy each (a clone with its ids) in place. */
function createCommentAndCopy(editor: ReturnType<typeof createConverterEditor>): void {
  editor.update(() => $importNoteBody(DECORATORS), { discrete: true });
  editor.update(() => {
    for (const node of $commentables()) node.setCommentIds(['c1']);
  }, { discrete: true });
  editor.update(() => {
    for (const node of $commentables()) node.insertAfter($copyNode(node));
  }, { discrete: true });
}

describe('decorator comment ids stay off the wire (comments.md §11)', () => {
  it('create, comment and copy every commentable decorator through the real binding: no __commentIds is written', () => {
    const doc = new Y.Doc();
    const { editor, updates } = bound(doc, excludedPropertiesFor);
    createCommentAndCopy(editor);
    const { keys, types } = written(updates);
    for (const type of COMMENTABLE) expect(types, `positive control: a ${type} reached the doc`).toContain(type);
    expect(editor.getEditorState().read(() => $commentables().length), 'each one and its copy').toBe(2 * COMMENTABLE.length);
    expect(editor.getEditorState().read(() => $commentables().every((node) => node.getCommentIds().length === 1)), 'the ids stay local').toBe(true);
    expect(keys.has('__type'), 'positive control: the scan reads properties').toBe(true);
    expect([...keys], 'no update writes a decorator comment id').not.toContain('__commentIds');
    for (const type of COMMENTABLE) expect(EXCLUDED_FIELDS[type], type).toContain('__commentIds');
  });

  it('hydrates an old doc whose decorators carry __commentIds, and later edits leave the field as it was', () => {
    // An old doc: written by a binding that replicated comment ids.
    const old = new Y.Doc();
    const writer = bound(old, () => new Map());
    createCommentAndCopy(writer.editor);
    expect(written(writer.updates).keys, 'positive control: the old wire carried the ids').toContain('__commentIds');
    const doc = new Y.Doc();
    const { editor, updates } = bound(doc, excludedPropertiesFor);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
    editor.update(() => {}, { discrete: true });
    const hydrated = editor.getEditorState().read(() => $commentables().map((node) => [node.getType(), node.getCommentIds()] as const));
    expect(new Set(hydrated.map(([type]) => type))).toEqual(new Set(COMMENTABLE));
    expect(hydrated.every(([, ids]) => ids.length === 0), 'a stored id is not read back into the tree').toBe(true);
    editor.update(() => {
      for (const node of $commentables()) node.setCommentIds(['c2']);
    }, { discrete: true });
    expect(written(updates).keys).not.toContain('__commentIds');
    const stored = everyAttributes(doc.get('root', Y.XmlText)).filter((attributes) => COMMENTABLE.includes(String(attributes.__type)));
    expect(stored.length).toBe(2 * COMMENTABLE.length);
    for (const attributes of stored) expect(attributes.__commentIds, String(attributes.__type)).toEqual(['c1']);
  });
});

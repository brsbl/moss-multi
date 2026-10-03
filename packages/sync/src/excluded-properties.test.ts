// The exclusion map's type fallback (A§10.9): Lexical asks for a node's exclusions with `node.constructor`, so a
// node whose constructor is not the class the map was built from (a duplicated module, a replaced class) must still
// keep its per-viewer fields off the wire.
import { createHeadlessEditor } from '@lexical/headless';
import { $createTableNodeWithDimensions, TableCellNode, TableNode, TableRowNode } from '@lexical/table';
import { createBinding, syncLexicalUpdateToYjs, type ExcludedProperties, type Provider } from '@lexical/yjs';
import { $getRoot, type Klass, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from './converter/index.ts';
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

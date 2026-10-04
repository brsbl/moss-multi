import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { exportDocMarkdown, importBody, serverWrite } from './server-doc.ts';
import { exportMarkdown, importMarkdown } from './converter/index.ts';
import { EXCLUDED_FIELDS } from './excluded-properties.ts';

const cases = [
  { type: 'code-block', field: '__code', setter: 'setCode', markdown: '```js\nseed\n```', before: 'seed', a: 'Ada seed', b: 'seed Ben', merged: 'Ada seed Ben' },
  { type: 'html-block', field: '__rawHtml', setter: 'setRawHtml', markdown: '```moss-html\n<p>seed</p>\n```', before: '<p>seed</p>', a: '<p>Ada seed</p>', b: '<p>seed Ben</p>', merged: '<p>Ada seed Ben</p>' },
  { type: 'formula', field: '__formula', setter: 'setFormula', markdown: '{{2+3|5}}', before: '2+3', a: '1+2+3', b: '2+3+4', merged: '1+2+3+4' },
] as const;

function find(type: string, node: LexicalNode = $getRoot()): LexicalNode | undefined {
  if (node.getType() === type) return node;
  if ($isElementNode(node)) for (const child of node.getChildren()) { const found = find(type, child); if (found) return found; }
}

describe('L4 decorator registers @p:col-1 @p:col-3 @p:tech-1', () => {
  it.each(cases)('$type merges concurrent setter writes through the mirror and survives persistence', (fixture) => {
    const a = new Y.Doc(); const b = new Y.Doc(); const restored = new Y.Doc();
    try {
      importBody(a, fixture.markdown);
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      for (const [doc, value] of [[a, fixture.a], [b, fixture.b]] as const) {
        serverWrite(doc, 'local', () => {
          const node = find(fixture.type) as unknown as Record<string, (text: string) => void>;
          expect(node).toBeDefined();
          node[fixture.setter](value);
        });
      }
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      expect(exportDocMarkdown(a)).toContain(fixture.merged);
      expect(exportDocMarkdown(b)).toBe(exportDocMarkdown(a));
      Y.applyUpdate(restored, Y.encodeStateAsUpdate(a));
      expect(exportDocMarkdown(restored)).toBe(exportDocMarkdown(a));
      expect([...a.getMap('registers').values()].some((value) => value instanceof Y.Text && value.toString() === fixture.merged)).toBe(true);
    } finally { a.destroy(); b.destroy(); restored.destroy(); }
  });

  it.each(cases)('$type keeps export bytes and moves its payload off whole-value attributes', (fixture) => {
    const doc = new Y.Doc();
    try {
      importBody(doc, fixture.markdown);
      expect(exportDocMarkdown(doc)).toBe(exportMarkdown(importMarkdown(fixture.markdown)));
      expect(EXCLUDED_FIELDS[fixture.type]).toContain(fixture.field);
      const registers = [...doc.getMap('registers').values()];
      expect(registers).toHaveLength(1);
      expect(registers[0]).toBeInstanceOf(Y.Text);
      expect((registers[0] as Y.Text).toString()).toBe(fixture.before);
    } finally { doc.destroy(); }
  });
});

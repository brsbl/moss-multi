// T4.0 pinned Yjs facts (docs/design/comments.md §1) on yjs 13.6.31 and @lexical/yjs at the moss pin. The anchor
// engine's rules depend on each; a dependency bump that breaks one fails here first.
import { DecoratorNode, ElementNode, LineBreakNode, TextNode, type Klass, type LexicalNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createConverterEditor } from '../../src/converter/index.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { importBody } from '../../src/server-doc.ts';

/** Root > paragraphs, as V1 writes them: a property map, then text. */
function doc(...paragraphs: string[]): { doc: Y.Doc; root: Y.XmlText; blocks: Y.XmlText[] } {
  const ydoc = new Y.Doc();
  const root = ydoc.get('root', Y.XmlText);
  const blocks = paragraphs.map((text, i) => {
    const block = new Y.XmlText();
    root.insertEmbed(i, block);
    block.insertEmbed(0, new Y.Map());
    block.insert(1, text);
    return block;
  });
  return { doc: ydoc, root, blocks };
}

/** A list's items in order: text, `~n` for a run of n deleted units, `[block]` or `[map]`. */
function order(type: Y.XmlText): string[] {
  const out: string[] = [];
  for (let item = type._start; item; item = item.right) {
    const last = out[out.length - 1];
    if (item.deleted && last?.startsWith('~')) out[out.length - 1] = `~${Number(last.slice(1)) + item.length}`;
    else if (item.deleted) out.push(`~${item.length}`);
    else if (item.content instanceof Y.ContentString) out.push(item.content.str);
    else if (item.content instanceof Y.ContentType) out.push(item.content.type instanceof Y.XmlText ? '[block]' : '[map]');
  }
  return out;
}

const same = (a: Y.ID | null, b: Y.ID | null) => a !== null && b !== null && a.client === b.client && a.clock === b.clock;

describe('T4.0 pinned Yjs facts @p:tech-3', () => {
  it('F1: afterTransaction runs before garbage collection, so a deleted block and its children are still readable', () => {
    const { doc: ydoc, root, blocks } = doc('hello');
    const item = blocks[0]._item!;
    let seen = '';
    ydoc.on('afterTransaction', (txn: Y.Transaction) => {
      if (!Y.isDeleted(txn.deleteSet, item.id)) return;
      let text = '';
      for (let child = blocks[0]._start; child; child = child.right) if (child.content instanceof Y.ContentString) text += child.content.str;
      seen = `${item.content instanceof Y.ContentType}:${text}`;
    });
    root.delete(0, 1);
    expect(seen).toBe('true:hello');
    expect(item.content, 'collected after the hook').toBeInstanceOf(Y.ContentDeleted);
  });

  it("F2: an insert at a deleted span's index lands after the whole tombstone run (insert and insertEmbed)", () => {
    const { blocks } = doc('abcdef');
    const [block] = blocks;
    block.delete(3, 2);
    block.insert(3, 'X');
    expect(order(block)).toEqual(['[map]', 'ab', '~2', 'X', 'ef']);
    block.delete(1, 2);
    block.insertEmbed(1, new Y.Map());
    expect(order(block)).toEqual(['[map]', '~4', '[map]', 'X', 'ef']);
  });

  it('F3: an undo copy lands just before its original, for text', () => {
    const { root, blocks } = doc('The quick brown fox');
    const undo = new Y.UndoManager(root, { captureTimeout: 0 });
    const [block] = blocks;
    block.delete(11, 5);
    const original = block._start!.right!.right!;
    expect(original.deleted).toBe(true);
    const before = original.left!.lastId;
    undo.undo();
    expect(order(block)).toEqual(['[map]', 'The quick ', 'brown', '~5', ' fox']);
    const copy = block._start!.right!.right!;
    expect(same(copy.rightOrigin, original.id)).toBe(true);
    expect(same(copy.origin, before)).toBe(true);
    expect(original.left).toBe(copy);
  });

  it('F3: a block copy lands before its original with its children inside it, also across blocks', () => {
    const { root, blocks } = doc('first block', 'second block');
    const undo = new Y.UndoManager(root, { captureTimeout: 0 });
    root.delete(1, 1);
    undo.undo();
    expect(order(root)).toEqual(['[block]', '[block]', '~1']);
    const copy = root._start!.right!;
    expect(same(copy.rightOrigin, blocks[1]._item!.id)).toBe(true);
    expect((copy.content as Y.ContentType).type.toString()).toContain('second block');

    const cross = doc('first block', 'second block');
    const crossUndo = new Y.UndoManager(cross.root, { captureTimeout: 0 });
    cross.doc.transact(() => {
      cross.blocks[0].delete(7, 5);
      cross.root.delete(1, 1);
      cross.blocks[0].insert(7, 'block');
    });
    crossUndo.undo();
    expect(order(cross.blocks[0])).toEqual(['[map]', 'first ', 'block', '~10']);
    expect(order(cross.root)).toEqual(['[block]', '[block]', '~1']);
    expect((cross.root._start!.right!.content as Y.ContentType).type.toString()).toContain('second block');
  });

  it("F3: once a deleted parent is redone, a later undo places its children between the copies of their old neighbours", () => {
    const { root, blocks } = doc('The quick brown fox');
    const undo = new Y.UndoManager(root, { captureTimeout: 0 });
    blocks[0].delete(11, 6);
    root.delete(0, 1);
    undo.undo();
    const restored = (root._start!.content as Y.ContentType).type as Y.XmlText;
    expect(restored.toString()).toContain('The quick fox');
    // The ids of the restored characters either side of the gap, whether or not the copies merged.
    const chars: Y.ID[] = [];
    for (let item = restored._start; item; item = item.right) {
      if (item.deleted || !(item.content instanceof Y.ContentString)) continue;
      for (let i = 0; i < item.length; i += 1) chars.push(Y.createID(item.id.client, item.id.clock + i));
    }
    const [left, right] = [chars[9], chars[10]];
    undo.undo();
    expect(restored.toString()).toContain('The quick brown fox');
    let copy: Y.Item | null = null;
    for (let item = restored._start; item; item = item.right) if (!item.deleted && item.content instanceof Y.ContentString && item.content.str === 'brown ') copy = item;
    expect(copy).not.toBeNull();
    expect(same(copy!.origin, left)).toBe(true);
    expect(same(copy!.rightOrigin, right)).toBe(true);
  });

  it('F4: every node in the registry maps to an XmlText, a leaf XmlElement or a property map, and the corpus agrees', () => {
    const editor = createConverterEditor();
    const kinds = new Map<string, string>();
    const is = (klass: Klass<LexicalNode>, base: { prototype: object }) =>
      klass === (base as unknown) || Object.prototype.isPrototypeOf.call(base.prototype, klass.prototype);
    for (const [type, { klass }] of editor._nodes) {
      const kind = is(klass, DecoratorNode) ? 'XmlElement' : is(klass, ElementNode) ? 'XmlText' : is(klass, TextNode) || is(klass, LineBreakNode) ? 'Map' : 'other';
      kinds.set(type, kind);
    }
    expect([...kinds].filter(([, kind]) => kind === 'other')).toEqual([]);
    expect([...kinds.values()]).toContain('XmlElement');

    const dir = new URL('../../src/converter/fixtures/', import.meta.url);
    const corpus = readdirSync(dir).filter((file) => file.endsWith('.md'));
    expect(corpus.length).toBeGreaterThan(20);
    for (const name of corpus) {
      const fixture = { name, markdown: readFileSync(new URL(name, dir), 'utf8') };
      const ydoc = new Y.Doc();
      importBody(ydoc, fixture.markdown);
      const visit = (type: Y.XmlText) => {
        for (let item = type._start; item; item = item.right) {
          if (!(item.content instanceof Y.ContentType)) continue;
          const child = item.content.type;
          if (child instanceof Y.XmlText) visit(child);
          else if (child instanceof Y.XmlElement) expect(child._start, `${fixture.name}: ${child.nodeName} is a leaf`).toBeNull();
          else expect(child, fixture.name).toBeInstanceOf(Y.Map);
        }
      };
      visit(ydoc.get('root', Y.XmlText));
      ydoc.destroy();
    }
  });
});

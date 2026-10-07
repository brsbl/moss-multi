import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { splitUpdate } from './update-pieces.ts';

/** A note shaped as @lexical/yjs V1 writes one: top-level blocks embedded in the root, each with its `__type`. */
function addBlocks(doc: Y.Doc, count: number, at = doc.get('root', Y.XmlText).length): void {
  const root = doc.get('root', Y.XmlText);
  doc.transact(() => {
    for (let i = 0; i < count; i += 1) {
      const block = new Y.XmlText();
      block.setAttribute('__type', i % 3 === 0 ? 'heading' : 'paragraph');
      const run = new Y.Map();
      run.set('__type', 'text');
      run.set('__format', i % 2);
      block.insertEmbed(0, run);
      block.insert(1, `Block ${i} `.repeat(20));
      root.insertEmbed(at + i, block);
    }
  });
}

const capture = (doc: Y.Doc, change: () => void): Uint8Array => {
  const updates: Uint8Array[] = [];
  const listener = (update: Uint8Array) => { updates.push(update); };
  doc.on('update', listener);
  change();
  doc.off('update', listener);
  if (updates.length !== 1) throw new Error(`expected one update, got ${updates.length}`);
  return updates[0];
};

function replica(doc: Y.Doc): Y.Doc {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
}

it('splits a large update into pieces of whole top-level blocks that apply in order to the same doc', () => {
  const doc = new Y.Doc();
  addBlocks(doc, 3);
  const peer = replica(doc);
  const update = capture(doc, () => addBlocks(doc, 400, 1));
  const limit = 16 * 1024;
  expect(update.byteLength).toBeGreaterThan(limit * 4);
  const pieces = splitUpdate(doc, update, limit);
  expect(pieces.length).toBeGreaterThan(3);
  for (const piece of pieces) {
    expect(piece.update.byteLength, 'each piece fits').toBeLessThanOrEqual(limit);
    Y.applyUpdate(peer, piece.update);
    expect(peer.store.pendingStructs, 'nothing waits on a later piece').toBeNull();
    for (const { insert } of peer.get('root', Y.XmlText).toDelta() as { insert: unknown }[]) {
      if (insert instanceof Y.XmlText) expect(insert.getAttribute('__type'), 'a peer never sees a block without its type').toBeDefined();
    }
    for (const [client, clock] of piece.ends) expect(Y.getState(peer.store, client)).toBe(clock);
  }
  expect(Y.encodeStateVector(peer)).toEqual(Y.encodeStateVector(doc));
  expect(peer.get('root', Y.XmlText).toJSON()).toEqual(doc.get('root', Y.XmlText).toJSON());
});

it('carries the deletes in the last piece, so no piece deletes what the receiver lacks', () => {
  const doc = new Y.Doc();
  addBlocks(doc, 50);
  const peer = replica(doc);
  const update = capture(doc, () => {
    doc.transact(() => {
      doc.get('root', Y.XmlText).delete(10, 20);
      addBlocks(doc, 300, 5);
    });
  });
  const pieces = splitUpdate(doc, update, 16 * 1024);
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces.map((piece) => piece.deletes)).toEqual([...pieces.slice(1).map(() => false), true]);
  for (const piece of pieces) {
    Y.applyUpdate(peer, piece.update);
    expect(peer.store.pendingStructs).toBeNull();
    expect(peer.store.pendingDs).toBeNull();
  }
  expect(peer.get('root', Y.XmlText).toJSON()).toEqual(doc.get('root', Y.XmlText).toJSON());
  expect(Y.snapshotContainsUpdate(Y.snapshot(peer), update)).toBe(true);
});

/** XmlTexts at any depth under `type` without their `__type`: a peer would render an untyped element. */
function untyped(type: Y.XmlText): number {
  let count = 0;
  for (const { insert } of type.toDelta() as { insert: unknown }[]) {
    if (!(insert instanceof Y.XmlText)) continue;
    if (insert.getAttribute('__type') === undefined) count += 1;
    count += untyped(insert);
  }
  return count;
}

/** One top-level list of `count` items, or a table of `count` rows of two cells, as @lexical/yjs writes them. */
function addOneLargeBlock(doc: Y.Doc, shape: 'list' | 'table', count: number): void {
  const element = (type: string) => {
    const node = new Y.XmlText();
    node.setAttribute('__type', type);
    return node;
  };
  const run = (holder: Y.XmlText, value: string) => {
    const props = new Y.Map();
    props.set('__type', 'text');
    holder.insertEmbed(0, props);
    holder.insert(1, value);
  };
  doc.transact(() => {
    const block = element(shape);
    for (let i = 0; i < count; i += 1) {
      if (shape === 'list') {
        const item = element('listitem');
        run(item, `Item ${i} of the list. `.repeat(3));
        block.insertEmbed(i, item);
      } else {
        const row = element('tablerow');
        for (let c = 0; c < 2; c += 1) {
          const cell = element('tablecell');
          const paragraph = element('paragraph');
          run(paragraph, `Row ${i} cell ${c}. `.repeat(2));
          cell.insertEmbed(0, paragraph);
          row.insertEmbed(c, cell);
        }
        block.insertEmbed(i, row);
      }
    }
    doc.get('root', Y.XmlText).insertEmbed(1, block);
  });
}

it('cuts one large list or table between its items or rows, every piece within the limit, no element ever untyped', () => {
  for (const shape of ['list', 'table'] as const) {
    const doc = new Y.Doc();
    addBlocks(doc, 2);
    const peer = replica(doc);
    const update = capture(doc, () => addOneLargeBlock(doc, shape, 3_000));
    const limit = 16 * 1024;
    expect(update.byteLength).toBeGreaterThan(limit * 8);
    const pieces = splitUpdate(doc, update, limit);
    expect(pieces.length, `${shape}: in pieces`).toBeGreaterThan(8);
    for (const piece of pieces) {
      expect(piece.update.byteLength, `${shape}: each piece fits`).toBeLessThanOrEqual(limit);
      Y.applyUpdate(peer, piece.update);
      expect(peer.store.pendingStructs, `${shape}: nothing waits on a later piece`).toBeNull();
      expect(untyped(peer.get('root', Y.XmlText)), `${shape}: no element arrives without its type`).toBe(0);
    }
    expect(peer.get('root', Y.XmlText).toJSON()).toEqual(doc.get('root', Y.XmlText).toJSON());
  }
});

it('leaves an update within the limit whole, and never cuts inside a block', () => {
  const doc = new Y.Doc();
  const small = capture(doc, () => addBlocks(doc, 2));
  expect(splitUpdate(doc, small, 64 * 1024).map((piece) => piece.update)).toEqual([small]);
  const big = capture(doc, () => {
    doc.transact(() => {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'code');
      block.insert(0, 'x'.repeat(40_000));
      doc.get('root', Y.XmlText).insertEmbed(0, block);
    });
  });
  expect(splitUpdate(doc, big, 8 * 1024)).toHaveLength(1);
});

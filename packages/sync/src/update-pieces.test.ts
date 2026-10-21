import { expect, it } from 'vitest';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { ANSWER_PIECE_BYTES } from '@moss-multi/protocol/limits';
import { splitAnswer, splitUpdate } from './update-pieces.ts';
import { CHAIN, interleavedChains, waitersOnOne } from '../test/harness/answer-shapes.ts';

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
  const pieces = splitUpdate(update, limit);
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
  const pieces = splitUpdate(update, 16 * 1024);
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
    const pieces = splitUpdate(update, limit);
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
  expect(splitUpdate(small, 64 * 1024).map((piece) => piece.update)).toEqual([small]);
  const big = capture(doc, () => {
    doc.transact(() => {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'code');
      block.insert(0, 'x'.repeat(40_000));
      doc.get('root', Y.XmlText).insertEmbed(0, block);
    });
  });
  expect(splitUpdate(big, 8 * 1024)).toHaveLength(1);
});

it('splits an answer whose structs depend on each other in a cycle, rather than looping (T3.B4, B212)', () => {
  // A crafted frame can leave a cycle in the DocDO's pending structs, which every answer then carries: A:0 after B:0,
  // and B:0 after A:0.
  const a = new Y.Doc();
  a.clientID = 1;
  a.getText('t').insert(0, 'a'.repeat(40));
  const b = new Y.Doc();
  b.clientID = 2;
  b.getText('t').insert(0, 'b'.repeat(40));
  const { structs } = Y.decodeUpdate(Y.mergeUpdates([Y.encodeStateAsUpdate(a), Y.encodeStateAsUpdate(b)]));
  const [first, second] = structs as Y.Item[];
  first.origin = Y.createID(second.id.client, 0);
  second.origin = Y.createID(first.id.client, 0);
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 2);
  for (const item of [first, second]) {
    encoding.writeVarUint(encoder.restEncoder, 1);
    encoder.writeClient(item.id.client);
    encoding.writeVarUint(encoder.restEncoder, 0);
    item.write(encoder, 0);
  }
  encoding.writeVarUint(encoder.restEncoder, 0);
  const update = encoder.toUint8Array();
  // The loop is synchronous, so a test timeout cannot end it: the waiting clients' Map writes are counted instead.
  const set = Map.prototype.set;
  let writes = 0;
  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if ((writes += 1) > 100_000) throw new Error('splitAnswer did not terminate');
    return set.call(this, key, value);
  };
  let pieces: Uint8Array[];
  try {
    pieces = splitAnswer(update, 16);
  } finally {
    Map.prototype.set = set;
  }
  const ids = pieces.flatMap((piece) => Y.decodeUpdate(piece).structs.map((struct) => `${struct.id.client}:${struct.id.clock}`));
  expect(ids.sort()).toEqual(['1:0', '2:0']);
});

/** Applies `pieces` in order to an empty doc, asserting none needs a later one; returns the doc. */
function appliedInOrder(pieces: Uint8Array[]): Y.Doc {
  const peer = new Y.Doc();
  for (const [index, piece] of pieces.entries()) {
    Y.applyUpdate(peer, piece);
    expect(peer.store.pendingStructs, `piece ${index} of ${pieces.length} needs nothing a later piece carries`).toBeNull();
  }
  return peer;
}

/**
 * splitAnswer's work, counted as the Map lookups and writes it makes (its bookkeeping lives in Maps). The loop is
 * synchronous, so a test timeout cannot end it: past `bound` the count throws.
 */
function counted<T>(bound: number, run: () => T): { result: T; work: number } {
  const { get, set } = Map.prototype;
  let work = 0;
  const tick = () => {
    if ((work += 1) > bound) throw new Error(`splitAnswer did more than ${bound} steps`);
  };
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
    tick();
    return get.call(this, key);
  };
  Map.prototype.set = function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    tick();
    return set.call(this, key, value);
  };
  try {
    return { result: run(), work };
  } finally {
    Map.prototype.get = get;
    Map.prototype.set = set;
  }
}

it('orders 2,000 interleaved authors near the 2 MB cap in work linear in structs plus clients (T3.B28)', () => {
  const clients = 2_000;
  const update = interleavedChains(clients, 120_000);
  expect(update.byteLength, 'near the 2 MB cap').toBeGreaterThan(1.8 * 1024 * 1024);
  const structs = Y.decodeUpdate(update).structs.length;
  // Waking every waiter on each struct the chain places costs about 120,000 x 2,000 steps, far past this.
  const bound = 32 * (structs + clients);
  const { result: pieces, work } = counted(bound, () => splitAnswer(update, ANSWER_PIECE_BYTES));
  expect(work).toBeLessThanOrEqual(bound);
  expect(pieces.length, 'the answer is several pieces').toBeGreaterThan(4);
  const source = new Y.Doc();
  Y.applyUpdate(source, update);
  const peer = appliedInOrder(pieces);
  expect(Y.encodeStateVector(peer)).toEqual(Y.encodeStateVector(source));
  expect(peer.getText('chains').toString()).toBe(source.getText('chains').toString());
});

it('splits an answer whose woken list or whose one blocked run passes 200,000 entries, without a RangeError (T3.B28)', () => {
  // 200,000 clients wait on CHAIN's one struct, so placing it wakes them all at once.
  const woken = waitersOnOne(200_000);
  const source = new Y.Doc();
  Y.applyUpdate(source, woken);
  const peer = appliedInOrder(splitAnswer(woken, ANSWER_PIECE_BYTES));
  expect(Y.encodeStateVector(peer)).toEqual(Y.encodeStateVector(source));

  // One client's 200,001 structs behind a crafted cycle with CHAIN's one struct: all of them go in the fallback.
  const run = 200_001;
  const doc = new Y.Doc();
  const text = doc.getText('run');
  doc.transact(() => {
    doc.clientID = CHAIN;
    text.insert(0, 'c');
    doc.clientID = 1;
    for (let i = 0; i < run; i += 1) text.insert(0, 'r');
  });
  const { structs } = Y.decodeUpdate(Y.encodeStateAsUpdate(doc));
  const chain = structs[0] as Y.Item;
  expect(chain.id.client).toBe(CHAIN);
  // 1:0 sits before CHAIN:0 (its right origin); CHAIN:0 now follows 1:0.
  chain.origin = Y.createID(1, 0);
  const encoder = new Y.UpdateEncoderV1();
  encoding.writeVarUint(encoder.restEncoder, 2);
  for (const group of [[chain], structs.slice(1)]) {
    encoding.writeVarUint(encoder.restEncoder, group.length);
    encoder.writeClient(group[0].id.client);
    encoding.writeVarUint(encoder.restEncoder, group[0].id.clock);
    for (const struct of group) struct.write(encoder, 0);
  }
  encoding.writeVarUint(encoder.restEncoder, 0);
  const pieces = splitAnswer(encoder.toUint8Array(), ANSWER_PIECE_BYTES);
  const count = pieces.reduce((sum, piece) => sum + Y.decodeUpdate(piece).structs.length, 0);
  expect(count).toBe(run + 1);
});

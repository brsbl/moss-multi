// A note's size as its limits count it (A§5.1 Limits): the body's text, kept exact per transaction, and the growth an
// update would bring, read from the update before it applies: its text exactly, its structs never under what lands.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { withDeletes } from '../test/harness/crafted.ts';
import { countChars, deletedWithin, growthOf, payloadSize, structCount, TextCount } from './note-size.ts';

/** A seeded random source, so a failure replays. */
function random(seed: number): () => number {
  let state = seed;
  return () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
}

/** Every XmlText in the body, the root first. */
function texts(doc: Y.Doc): Y.XmlText[] {
  const out: Y.XmlText[] = [];
  const visit = (type: Y.XmlText) => {
    out.push(type);
    for (const op of type.toDelta() as { insert: unknown }[]) if (op.insert instanceof Y.XmlText) visit(op.insert);
  };
  visit(doc.get('root', Y.XmlText));
  return out;
}

/** One random edit of the kinds a Lexical binding makes: text, a block, a run's properties, a deletion, a payload's element. */
function edit(doc: Y.Doc, next: () => number): void {
  const all = texts(doc);
  const target = all[Math.floor(next() * all.length)];
  const at = Math.floor(next() * (target.length + 1));
  const roll = next();
  doc.transact(() => {
    if (roll < 0.35) target.insert(at, 'abcdefgh'.slice(0, 1 + Math.floor(next() * 8)));
    else if (roll < 0.5) {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'paragraph');
      block.insert(0, `line ${Math.floor(next() * 1000)}`);
      target.insertEmbed(at, block);
    } else if (roll < 0.6) {
      const run = new Y.Map();
      run.set('__type', 'text');
      target.insertEmbed(at, run);
      target.insert(at + 1, 'run');
    } else if (roll < 0.68) {
      const element = new Y.XmlElement('code-block');
      element.setAttribute('__type', 'code-block');
      element.setAttribute('__regId', `id-${Math.floor(next() * 1e9)}`);
      target.insertEmbed(at, element);
    } else if (roll < 0.75) target.setAttribute('__format', Math.floor(next() * 8));
    else if (roll < 0.8) doc.getText('title').insert(0, 'T');
    else if (target.length > 0) {
      const from = Math.floor(next() * target.length);
      target.delete(from, 1 + Math.floor(next() * Math.min(6, target.length - from)));
    }
  });
}

describe('growthOf and TextCount', () => {
  it.each([1, 2, 3, 4, 5, 6])('predict the text an update adds (exactly from one writer, never under from several) and never fewer structs than land (seed %i)', (seed) => {
    const next = random(seed);
    const server = new Y.Doc();
    const counted = new TextCount(server);
    const writers = Array.from({ length: seed % 2 ? 3 : 1 }, () => new Y.Doc());
    for (let round = 0; round < 300; round += 1) {
      const writer = writers[Math.floor(next() * writers.length)];
      // A writer sometimes works from a stale copy, so its edits interleave with the others'.
      if (next() < 0.6) Y.applyUpdate(writer, Y.encodeStateAsUpdate(server, Y.encodeStateVector(writer)));
      const before = Y.encodeStateVector(writer);
      for (let n = 1 + Math.floor(next() * 3); n > 0; n -= 1) edit(writer, next);
      // Each writer holds only what the server has and its own edits, so the server never lacks what an update needs.
      const update = Y.encodeStateAsUpdate(writer, before);
      const growth = growthOf(server, update);
      const chars = counted.chars;
      const structs = structCount(server);
      Y.applyUpdate(server, update);
      expect(server.store.pendingStructs, 'no update waits').toBeNull();
      // Exact without concurrency; a stale writer's edit inside a block another deleted adds nothing it predicts, and its
      // delete of a block takes text it never saw: the prediction is then above what lands, never below.
      if (writers.length === 1) expect(counted.chars - chars, `round ${round}: the text it adds`).toBe(growth.chars);
      else expect(counted.chars - chars, `round ${round}: the text it adds`).toBeLessThanOrEqual(growth.chars);
      expect(structCount(server) - structs, `round ${round}: the structs it adds`).toBeLessThanOrEqual(growth.structs);
      expect(counted.chars, 'the kept count is the walked one').toBe(countChars(server));
    }
    expect(counted.chars).toBeGreaterThan(0);
  });

  it('counts the body only: the title and frontmatter are not the note\'s text', () => {
    const doc = new Y.Doc();
    const counted = new TextCount(doc);
    const writer = new Y.Doc();
    writer.getText('title').insert(0, 'A long title');
    writer.getMap('frontmatter').set('tags', 'x'.repeat(100));
    const update = Y.encodeStateAsUpdate(writer);
    expect(growthOf(doc, update).chars).toBe(0);
    Y.applyUpdate(doc, update);
    expect(counted.chars).toBe(0);
  });

  it('reads an update of only deletions as inserting nothing, and the text it removes', () => {
    const doc = new Y.Doc();
    const counted = new TextCount(doc);
    const root = doc.get('root', Y.XmlText);
    const block = new Y.XmlText();
    root.insertEmbed(0, block);
    block.insert(0, 'hello world');
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(writer);
    (writer.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlText).delete(2, 5);
    const growth = growthOf(doc, Y.encodeStateAsUpdate(writer, before));
    expect(growth).toMatchObject({ inserts: false, chars: -5 });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(writer, before));
    expect(counted.chars).toBe(6);
    // A deleted block takes its text with it.
    const again = Y.encodeStateVector(writer);
    writer.get('root', Y.XmlText).delete(0, 1);
    expect(growthOf(doc, Y.encodeStateAsUpdate(writer, again)).chars).toBe(-6);
  });

  it('names the payload ids an update\'s new elements carry', () => {
    const writer = new Y.Doc();
    const element = new Y.XmlElement('code-block');
    element.setAttribute('__regId', 'payload-1');
    writer.get('root', Y.XmlText).insertEmbed(0, element);
    expect([...growthOf(new Y.Doc(), Y.encodeStateAsUpdate(writer)).named]).toEqual(['payload-1']);
  });

  it('sizes a payload doc by its text and its structs; a chart\'s keys hold no text', () => {
    const code = new Y.Doc();
    code.getText('payload').insert(0, 'const a = 1;');
    expect(payloadSize(code)).toEqual({ chars: 12, structs: 1 });
    const chart = new Y.Doc();
    chart.getMap('payload-map').set('/type', 'bar');
    expect(payloadSize(chart)).toEqual({ chars: 0, structs: 1 });
  });
});

describe('growthOf against crafted and compound updates (T3.B31c)', () => {
  /** A doc whose body holds one paragraph of `text`, and the paragraph's text struct. */
  function holding(text: string): { doc: Y.Doc; counted: TextCount; run: Y.Item; paragraph: Y.XmlText } {
    const doc = new Y.Doc();
    const counted = new TextCount(doc);
    const paragraph = new Y.XmlText();
    doc.get('root', Y.XmlText).insertEmbed(0, paragraph);
    paragraph.insert(0, text);
    const run = [...doc.store.clients.values()].flat().find((struct) => struct instanceof Y.Item && struct.content instanceof Y.ContentString) as Y.Item;
    return { doc, counted, run, paragraph };
  }

  it.each([
    ['repeated', (clock: number) => [[clock, 100], [clock, 100]]],
    ['overlapping', (clock: number) => [[clock, 100], [clock + 50, 100], [clock + 20, 30]]],
    ['out of order', (clock: number) => [[clock + 100, 50], [clock, 100], [clock + 40, 80]]],
  ] as const)('counts a %s delete range\'s text once, as applying it deletes it once', (_kind, ranges) => {
    const { doc, counted, run } = holding('a'.repeat(1_000));
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(writer);
    (writer.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlText).insert(1_000, 'b'.repeat(200));
    const update = withDeletes(Y.encodeStateAsUpdate(writer, before), ranges(run.id.clock).map(([clock, len]) => [run.id.client, clock, len]));
    const growth = growthOf(doc, update);
    const chars = counted.chars;
    Y.applyUpdate(doc, update);
    expect(counted.chars, 'the kept count is the walked one').toBe(countChars(doc));
    expect(growth.chars, 'the text it adds').toBe(counted.chars - chars);
  });

  it('names the payload an element already holding a `__regId` comes to name when its `__type` becomes a payload\'s', () => {
    const doc = new Y.Doc();
    const element = new Y.XmlElement('horizontalrule');
    element.setAttribute('__type', 'horizontalrule');
    element.setAttribute('__regId', 'withheld-1');
    doc.get('root', Y.XmlText).insertEmbed(0, element);
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(writer);
    (writer.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlElement).setAttribute('__type', 'code-block');
    expect([...growthOf(doc, Y.encodeStateAsUpdate(writer, before)).named]).toEqual(['withheld-1']);
  });

  it('gives the elements an update deletes or unnames, so a payload losing its last name stops counting', () => {
    const doc = new Y.Doc();
    const root = doc.get('root', Y.XmlText);
    for (const id of ['gone', 'retyped', 'kept']) {
      const element = new Y.XmlElement('code-block');
      element.setAttribute('__type', 'code-block');
      element.setAttribute('__regId', id);
      root.insertEmbed(root.length, element);
    }
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const before = Y.encodeStateVector(writer);
    const [, retyped] = writer.get('root', Y.XmlText).toDelta().map((op: { insert: unknown }) => op.insert as Y.XmlElement);
    writer.transact(() => {
      retyped.setAttribute('__type', 'horizontalrule');
      writer.get('root', Y.XmlText).delete(0, 1);
    });
    const dropped = [...growthOf(doc, Y.encodeStateAsUpdate(writer, before)).dropped].map((element) => element.getAttribute('__regId')).sort();
    expect(dropped).toEqual(['gone', 'retyped']);
  });

  it('tells a write of only properties and formats from one that adds content', () => {
    const { doc, paragraph } = holding('hello world');
    paragraph.setAttribute('__type', 'paragraph');
    const writer = new Y.Doc();
    Y.applyUpdate(writer, Y.encodeStateAsUpdate(doc));
    const text = writer.get('root', Y.XmlText).toDelta()[0].insert as Y.XmlText;
    let before = Y.encodeStateVector(writer);
    writer.transact(() => {
      text.format(0, 5, { __format: 0 });
      text.setAttribute('__format', 2);
    });
    expect(growthOf(doc, Y.encodeStateAsUpdate(writer, before))).toMatchObject({ inserts: true, content: false });
    before = Y.encodeStateVector(writer);
    text.insert(0, 'x');
    expect(growthOf(doc, Y.encodeStateAsUpdate(writer, before))).toMatchObject({ inserts: true, content: true });
  });
});

describe('growthOf for an update of only deletions (coordinator ruling 2)', () => {
  /** A server doc whose body holds one paragraph of `text`, a writer synced to it, and the writer's paragraph. */
  function paragraphOf(text: string): { server: Y.Doc; writer: Y.Doc; paragraph: Y.XmlText } {
    const writer = new Y.Doc();
    const paragraph = new Y.XmlText();
    writer.get('root', Y.XmlText).insertEmbed(0, paragraph);
    paragraph.insert(0, text);
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(writer));
    return { server, writer, paragraph };
  }

  /** The update one transaction of `edit` makes on `writer`. */
  function updateOf(writer: Y.Doc, edit: () => void): Uint8Array {
    let update: Uint8Array | null = null;
    const listen = (u: Uint8Array) => { update = u; };
    writer.on('update', listen);
    writer.transact(edit);
    writer.off('update', listen);
    if (!update) throw new Error('the edit made no update');
    return update;
  }

  it('counts the splits a deletion inside a run makes: one character from its middle is two structs more', () => {
    const { server, writer, paragraph } = paragraphOf('a'.repeat(100));
    const update = updateOf(writer, () => paragraph.delete(50, 1));
    const growth = growthOf(server, update);
    const before = structCount(server);
    Y.applyUpdate(server, update);
    expect(growth).toMatchObject({ inserts: false, structs: 2 });
    expect(structCount(server) - before).toBe(2);
  });

  it('counts the merge with a deleted neighbour: deleting a 10,000-character run from its end adds one struct, then none', () => {
    const { server, writer, paragraph } = paragraphOf('a'.repeat(10_000));
    const start = structCount(server);
    for (let length = 10_000; length > 0; length -= 1) {
      const update = updateOf(writer, () => paragraph.delete(length - 1, 1));
      const growth = growthOf(server, update);
      const before = structCount(server);
      Y.applyUpdate(server, update);
      expect(structCount(server) - before, `${length}: never more than predicted`).toBeLessThanOrEqual(growth.structs);
      if (length < 10_000) expect(growth.structs, `${length}: a deletion beside the deleted end adds nothing`).toBe(0);
    }
    expect(structCount(server)).toBeLessThanOrEqual(start + 1);
  });

  it.each([1, 2, 3, 4])('never predicts fewer structs than land for scattered deletions from several writers (seed %i)', (seed) => {
    const next = random(seed);
    const server = new Y.Doc();
    const writers = Array.from({ length: 3 }, () => new Y.Doc());
    for (let round = 0; round < 200; round += 1) edit(writers[round % 3], next);
    for (const writer of writers) Y.applyUpdate(server, Y.encodeStateAsUpdate(writer));
    for (const writer of writers) Y.applyUpdate(writer, Y.encodeStateAsUpdate(server, Y.encodeStateVector(writer)));
    for (let round = 0; round < 400; round += 1) {
      const writer = writers[Math.floor(next() * writers.length)];
      if (next() < 0.5) Y.applyUpdate(writer, Y.encodeStateAsUpdate(server, Y.encodeStateVector(writer)));
      const targets = texts(writer).filter((type) => type.length > 0);
      if (!targets.length) break;
      const update = updateOf(writer, () => {
        for (let n = 1 + Math.floor(next() * 4); n > 0; n -= 1) {
          const target = targets[Math.floor(next() * targets.length)];
          if (target.length === 0) continue;
          const from = Math.floor(next() * target.length);
          target.delete(from, 1 + Math.floor(next() * Math.min(3, target.length - from)));
        }
      });
      const growth = growthOf(server, update);
      expect(growth.inserts).toBe(false);
      const before = structCount(server);
      Y.applyUpdate(server, update);
      expect(structCount(server) - before, `round ${round}: the structs it adds`).toBeLessThanOrEqual(growth.structs);
    }
  });

  it('reads a whole block\'s deletion as adding no struct', () => {
    const writer = new Y.Doc();
    const root = writer.get('root', Y.XmlText);
    for (let i = 0; i < 20; i += 1) {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'paragraph');
      root.insertEmbed(i, block);
      block.insert(0, `Line ${i}`);
    }
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(writer));
    for (const at of [10, 3, 0]) {
      const update = updateOf(writer, () => root.delete(at, 1));
      const growth = growthOf(server, update);
      const before = structCount(server);
      Y.applyUpdate(server, update);
      expect(growth.structs).toBeLessThanOrEqual(0);
      expect(structCount(server)).toBeLessThanOrEqual(before);
    }
  });
});

describe('deletedWithin', () => {
  const RANGES = Array.from({ length: 10_000 }, (_, i) => ({ clock: i * 10, len: 4 }));
  const linear = (start: number, end: number) =>
    RANGES.reduce((sum, { clock, len }) => sum + Math.max(0, Math.min(end, clock + len) - Math.max(start, clock)), 0);

  it('counts the clocks the ranges delete inside a span', () => {
    for (const [start, end] of [[0, 1], [0, 10], [3, 12], [55, 56], [99_990, 100_100], [5, 5], [-10, 3], [12_345, 54_321]]) {
      expect(deletedWithin(RANGES, start, end), `${start}-${end}`).toBe(linear(start, end));
    }
    expect(deletedWithin([], 0, 10)).toBe(0);
  });

  it('reads only the ranges near the span, so a frame of many strings and ranges costs no more than their sum (T3.B31c)', () => {
    let reads = 0;
    const counted = new Proxy(RANGES, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(deletedWithin(counted, 50_000, 50_010)).toBe(4);
    expect(reads).toBeLessThan(40);
  });
});

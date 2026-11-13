// A note's size as its limits count it (A§5.1 Limits): the body's text, kept exact per transaction, and the growth an
// update would bring, read from the update before it applies: its text exactly, its structs never under what lands.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { countChars, growthOf, payloadSize, structCount, TextCount } from './note-size.ts';

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
  it.each([1, 2, 3, 4, 5])('predict exactly the text an update adds and never fewer structs than land, over concurrent edits (seed %i)', (seed) => {
    const next = random(seed);
    const server = new Y.Doc();
    const counted = new TextCount(server);
    const writers = [new Y.Doc(), new Y.Doc(), new Y.Doc()];
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
      expect(counted.chars - chars, `round ${round}: the text it adds`).toBe(growth.chars);
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

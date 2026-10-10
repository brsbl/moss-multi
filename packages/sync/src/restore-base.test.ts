// The restore route sizes its body cap on this (T6.R): a doc's state vector never encodes longer than the doc's state,
// whether stored as one encoded state or as the log of updates that built it. Each client in a vector costs its id and
// its clock; the state spends the same id and at least a byte per run for that run's length.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

/** A doc built by `write`, with every update it emitted. */
function built(write: (doc: Y.Doc) => void, gc = true): { doc: Y.Doc; log: Uint8Array[] } {
  const doc = new Y.Doc({ gc });
  const log: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => log.push(update));
  write(doc);
  return { doc, log };
}

const sessions = (doc: Y.Doc, count: number, step: (doc: Y.Doc, s: number) => void, first = 0xf000_0000) => {
  for (let s = 0; s < count; s += 1) {
    doc.clientID = first + s;
    step(doc, s);
  }
};

const CASES: [string, (doc: Y.Doc) => void, boolean?][] = [
  ['many sessions, one character each', (doc) => sessions(doc, 2_000, (d) => d.getText('t').insert(0, 'x'))],
  ['many sessions, small client ids', (doc) => sessions(doc, 2_000, (d) => d.getText('t').insert(0, 'x'), 1)],
  ['many sessions, each deleting what it typed', (doc) => sessions(doc, 1_000, (d) => {
    const text = d.getText('t');
    text.insert(0, 'xy');
    text.delete(0, 2);
  })],
  ['one session, a long run typed a character at a time and deleted', (doc) => {
    const text = doc.getText('t');
    for (let i = 0; i < 20_000; i += 1) text.insert(i, 'x');
    text.delete(0, text.length);
  }],
  ['the same, without garbage collection', (doc) => {
    const text = doc.getText('t');
    for (let i = 0; i < 20_000; i += 1) text.insert(i, 'x');
    text.delete(0, text.length);
  }, false],
  ['astral characters', (doc) => sessions(doc, 500, (d) => d.getText('t').insert(0, '😀'))],
  ['map keys overwritten by many sessions', (doc) => sessions(doc, 1_000, (d, s) => d.getMap('m').set('k', s))],
  ['nested elements, as a note writes them', (doc) => sessions(doc, 500, (d) => {
    const block = new Y.XmlText();
    d.get('root', Y.XmlText).insertEmbed(0, block);
    block.setAttribute('__type', 'paragraph');
    block.insert(0, 'x');
  })],
];

describe('a state vector is never longer than the state it describes', () => {
  for (const [name, write, gc] of CASES) {
    it(name, () => {
      const { doc, log } = built(write, gc ?? true);
      const vector = Y.encodeStateVector(doc).byteLength;
      expect(vector).toBeLessThanOrEqual(Y.encodeStateAsUpdate(doc).byteLength);
      expect(vector).toBeLessThanOrEqual(log.reduce((sum, update) => sum + update.byteLength, 0));
      expect(vector).toBeLessThanOrEqual(Y.mergeUpdates(log).byteLength);
      doc.destroy();
    });
  }
});

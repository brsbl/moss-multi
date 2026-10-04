// A server title write (create, REST rename) diffs caller text with a bounded budget: worst-case pairs land exactly,
// and an ordinary rename still merges with a peer's concurrent typing. The CPU budget is measured in workerd by
// scripts/measure-converter.mjs on the same pairs.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TITLE_CASES } from '../measure/title-cases.ts';
import { writeTitle } from './server-doc.ts';

const title = (doc: Y.Doc) => doc.getText('title').toString();

describe('server title writes @p:col-5 @p:tech-8', () => {
  it.each(Object.entries(TITLE_CASES))('%s lands exactly in both directions', (_name, [a, b]) => {
    const doc = new Y.Doc();
    for (const next of [a, b, a, b]) {
      writeTitle(doc, next, 'server');
      expect(title(doc) === next).toBe(true);
    }
  });

  it("a rename merges with a peer's concurrent typing instead of replacing it", () => {
    const server = new Y.Doc();
    writeTitle(server, 'Quarterly plan', 'server');
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    writeTitle(server, 'Quarterly plan (draft)', 'server');
    peer.getText('title').insert(0, 'Q3 ');
    Y.applyUpdate(server, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(server)));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server, Y.encodeStateVector(peer)));
    expect(title(server)).toBe('Q3 Quarterly plan (draft)');
    expect(title(peer)).toBe(title(server));
  });
});

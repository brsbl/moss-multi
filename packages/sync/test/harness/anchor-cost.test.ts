// T4.0 cost by counters (docs/design/comments.md I7): server anchor work per frame depends on the frame, never on the
// document's size or its comment count. Deterministic struct-visit counters, not timing.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { COMMENT_BUDGET, liveUnits, mintAnchor, OVERLAP_CAP } from '@moss-multi/core/anchor-frame';
import { CommentsHost } from '../../src/doc/comments-host.ts';
import { forged, raw } from './raw-frames.ts';

const PARAGRAPHS = 100;
const WORDS = 25;

/** A V1-shaped doc: paragraphs of one text node each (a property map, then the text). */
function bigDoc(): Y.Doc {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  doc.transact(() => {
    for (let p = 0; p < PARAGRAPHS; p += 1) {
      const block = new Y.XmlText();
      root.insertEmbed(p, block);
      block.setAttribute('__type', 'paragraph');
      const node = new Y.Map();
      block.insertEmbed(0, node);
      node.set('__type', 'text');
      const words = Array.from({ length: WORDS }, (_, w) => `w${String(p * WORDS + w).padStart(4, '0')}`);
      block.insert(1, `${words.join(' ')}.`);
    }
  });
  return doc;
}

const paragraph = (doc: Y.Doc, p: number) => (doc.get('root', Y.XmlText).toDelta() as { insert: Y.XmlText }[])[p].insert;

function setup() {
  const server = bigDoc();
  const host = new CommentsHost(server);
  const { text, units } = liveUnits(server);
  const word = (n: number) => text.indexOf(`w${String(n).padStart(4, '0')}`);
  // 1,968 word comments plus 32 sharing one space: 2,000 records.
  for (let n = 0; n < 2_000 - OVERLAP_CAP; n += 1) host.create(`w${n}`, mintAnchor(units[word(n)], units[word(n) + 4]));
  // The space between w2475 and w2476, in a paragraph no word comment touches.
  const shared = word(PARAGRAPHS * WORDS - WORDS + 1) - 1;
  for (let k = 0; k < OVERLAP_CAP; k += 1) host.create(`s${k}`, mintAnchor(units[shared], units[shared + 1 + k]));
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  const send = (edit: () => void) => {
    const before = Y.encodeStateVector(server);
    client.transact(edit);
    return host.receive(Y.encodeStateAsUpdate(client, before));
  };
  // 500 orphans: the first 20 paragraphs' words, each word deleted with its trailing space.
  send(() => {
    for (let p = 0; p < 20; p += 1) paragraph(client, p).delete(1, WORDS * 6);
  });
  return { server, host, client, send };
}

describe('T4.0 per-frame anchor cost is bounded by the frame @p:tech-3', () => {
  it('on a 2,000-comment, 500-orphan doc a single-key frame anywhere does no anchor work', () => {
    const { host, client, send } = setup();
    const orphans = [...host.records()].filter(([, anchor]) => anchor.status === 'orphaned');
    expect(orphans).toHaveLength(500);
    expect(orphans.every(([, anchor]) => anchor.lost !== undefined)).toBe(true);

    for (const p of [30, 55, 77]) {
      // Index 12 is the space after the paragraph's second word (index 0 is the property map).
      expect(send(() => paragraph(client, p).delete(12, 1)).refused).toBeNull();
      expect(host.engine.stats.comments).toBe(0);
      expect(host.engine.stats.structs).toBe(0);
      expect(send(() => paragraph(client, p).insert(3, 'z')).refused).toBeNull();
      expect(host.engine.stats.comments).toBe(0);
      expect(host.engine.stats.structs).toBe(0);
      expect(host.engine.stats.lookups).toBeLessThanOrEqual(2);
    }
  });

  it('a frame deleting one character shared by 32 comments visits at most 32 comment budgets', () => {
    const { host, client, send } = setup();
    // Index 6: the text node's property map, then 'w2475', then the shared space.
    expect(send(() => paragraph(client, PARAGRAPHS - 1).delete(6, 1)).refused).toBeNull();
    expect(host.engine.stats.comments).toBe(OVERLAP_CAP);
    expect(host.engine.stats.structs).toBeLessThanOrEqual(OVERLAP_CAP * COMMENT_BUDGET);
    expect(host.engine.stats.structs, 'in practice a few structs each').toBeLessThanOrEqual(OVERLAP_CAP * 64);
    for (let k = 0; k < OVERLAP_CAP; k += 1) expect(host.anchor(`s${k}`)?.status).toBe('anchored');
  });

  it('a forged one-item frame naming a lost member stops after a few structs', () => {
    const { host, server } = setup();
    const orphan = host.anchor('w0')!;
    const [client, clock] = orphan.lost!.members[0];
    const far = liveUnits(server).units.at(-1)!;
    const frame = raw([
      forged(Y.createID(4242, 0), { origin: Y.createID(far.item.id.client, far.item.id.clock + far.off), right: Y.createID(client, clock) }, new Y.ContentString('q')),
    ]);
    expect(host.receive(frame).refused).toBeNull();
    expect(host.engine.stats.comments).toBeGreaterThanOrEqual(1);
    expect(host.engine.stats.structs).toBeLessThanOrEqual(8 * host.engine.stats.comments);
    expect(host.anchor('w0')?.status).toBe('orphaned');
  });
});

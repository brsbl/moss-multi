// T4.0 and T4.2 cost by counters (docs/design/comments.md I7, §5.6): server anchor work per frame depends on the frame,
// never on the document's size, its comment count, how many orphans share a lost place, a decorator's attribute
// history, or how many other anchors index the same client. Deterministic counters, not timing; the workerd CPU budget
// is measured by scripts/measure-converter.mjs.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { COMMENT_BUDGET, liveUnits, mintAnchor, OVERLAP_CAP, type FrameStats } from '@moss-multi/core/anchor-frame';
import { CommentsHost } from '../../src/doc/comments-host.ts';
import { forged, raw } from './raw-frames.ts';

const PARAGRAPHS = 100;
const WORDS = 25;

/** A V1-shaped paragraph: one text node (a property map, then the text). */
function addParagraph(root: Y.XmlText, index: number, text: string): Y.XmlText {
  const block = new Y.XmlText();
  root.insertEmbed(index, block);
  block.setAttribute('__type', 'paragraph');
  const node = new Y.Map();
  block.insertEmbed(0, node);
  node.set('__type', 'text');
  block.insert(1, text);
  return block;
}

const word = (n: number) => `w${String(n).padStart(4, '0')}`;

function bigDoc(): Y.Doc {
  const doc = new Y.Doc();
  const root = doc.get('root', Y.XmlText);
  doc.transact(() => {
    for (let p = 0; p < PARAGRAPHS; p += 1) addParagraph(root, p, `${Array.from({ length: WORDS }, (_, w) => word(p * WORDS + w)).join(' ')}.`);
  });
  return doc;
}

const paragraph = (doc: Y.Doc, p: number) => (doc.get('root', Y.XmlText).toDelta() as { insert: Y.XmlText }[])[p].insert;
const copyOf = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};
const idAt = (unit: { item: Y.Item; off: number }) => Y.createID(unit.item.id.client, unit.item.id.clock + unit.off);
const counted = (host: CommentsHost): FrameStats => ({ ...host.engine.stats });

/** A host and a client replica; `send` applies one client transaction as one frame. */
function hosted(server: Y.Doc) {
  const host = new CommentsHost(server);
  const client = copyOf(server);
  const send = (edit: () => void) => {
    const before = Y.encodeStateVector(server);
    client.transact(edit);
    return host.receive(Y.encodeStateAsUpdate(client, before));
  };
  return { host, client, send };
}

function setup() {
  const server = bigDoc();
  const { host, client, send } = hosted(server);
  const { text, units } = liveUnits(server);
  const at = (n: number) => text.indexOf(word(n));
  // 1,968 word comments plus 32 sharing one space: 2,000 records.
  for (let n = 0; n < 2_000 - OVERLAP_CAP; n += 1) host.create(`w${n}`, mintAnchor(units[at(n)], units[at(n) + 4]));
  // The space between w2475 and w2476, in a paragraph no word comment touches.
  const shared = at(PARAGRAPHS * WORDS - WORDS + 1) - 1;
  for (let k = 0; k < OVERLAP_CAP; k += 1) host.create(`s${k}`, mintAnchor(units[shared], units[shared + 1 + k]));
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
      // Its origin, its right origin, and its paragraph's right origin (§5.4).
      expect(host.engine.stats.lookups).toBeLessThanOrEqual(3);
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
    const frame = raw([forged(Y.createID(4242, 0), { origin: idAt(far), right: Y.createID(client, clock) }, new Y.ContentString('q'))]);
    expect(host.receive(frame).refused).toBeNull();
    expect(host.engine.stats.comments).toBeGreaterThanOrEqual(1);
    expect(host.engine.stats.structs).toBeLessThanOrEqual(8 * host.engine.stats.comments);
    expect(host.anchor('w0')?.status).toBe('orphaned');
  });
});

/**
 * `count` disjoint word comments in one paragraph, all orphaned by one frame that deletes the paragraph's text (`run`)
 * or the paragraph itself, then one forged item placed inside their shared lost place. Returns the forged frame's work.
 */
function forgedIntoSharedPlace(count: number, how: 'run' | 'paragraph'): { stats: FrameStats; orphaned: number } {
  const server = new Y.Doc();
  const root = server.get('root', Y.XmlText);
  server.transact(() => {
    addParagraph(root, 0, 'Head.');
    addParagraph(root, 1, `${Array.from({ length: count }, (_, n) => word(n)).join(' ')}.`);
    addParagraph(root, 2, 'Tail.');
  });
  const { host, client, send } = hosted(server);
  const { text, units } = liveUnits(server);
  for (let n = 0; n < count; n += 1) host.create(`w${n}`, mintAnchor(units[text.indexOf(word(n))], units[text.indexOf(word(n)) + 4]));
  const lostBy = send(() => (how === 'run' ? paragraph(client, 1).delete(1, paragraph(client, 1).length - 1) : client.get('root', Y.XmlText).delete(1, 1)));
  expect(lostBy.refused).toBeNull();
  const lost = host.anchor('w0')!.lost!;
  for (let n = 0; n < count; n += 1) expect(host.anchor(`w${n}`)?.lost, `w${n} shares w0's place`).toEqual({ ...lost, pre: { ...lost.pre, a: expect.any(Number), b: expect.any(Number) } });
  // Inside the place: its left bound is the origin and the shared member the right origin.
  const [mc, mk] = lost.members[0];
  const left = lost.segs[0].left!;
  const frame = raw([forged(Y.createID(4242, 0), { origin: Y.createID(left[0], left[1]), right: Y.createID(mc, mk) }, new Y.ContentString('q'))]);
  expect(host.receive(frame).refused).toBeNull();
  const stats = counted(host);
  const orphaned = [...host.records()].filter(([, anchor]) => anchor.status === 'orphaned').length;
  return { stats, orphaned };
}

describe('T4.2 anchor cost: orphans sharing a lost place share one check @p:tech-3', () => {
  for (const how of ['run', 'paragraph'] as const) {
    it(`anchor-cost: 500 disjoint comments orphaned by one deleted ${how}; a forged one-item frame naming the shared member does one segment walk`, () => {
      const many = forgedIntoSharedPlace(500, how);
      const few = forgedIntoSharedPlace(5, how);
      expect(many.orphaned).toBe(500);
      expect(few.orphaned).toBe(5);
      expect(many.stats.comments, 'one check for the whole group').toBe(1);
      expect(many.stats.structs, 'one short walk').toBeLessThanOrEqual(8);
      expect(many.stats, 'work independent of orphan count').toEqual(few.stats);
    });
  }
});

/**
 * A block comment on a decorator whose attribute `h` was set `history` times by two alternating writers (so the
 * deleted values never merge) and then removed; the fixed frame deletes the decorator.
 */
function decoratorWithHistory(history: number): { stats: FrameStats; status: string | undefined } {
  const server = new Y.Doc();
  const root = server.get('root', Y.XmlText);
  let image!: Y.XmlElement;
  server.transact(() => {
    addParagraph(root, 0, 'Before.');
    image = new Y.XmlElement('image');
    root.insertEmbed(1, image);
    image.setAttribute('src', 'one.png');
    addParagraph(root, 2, 'After.');
  });
  const own = server.clientID;
  for (let i = 0; i < history; i += 1) {
    server.clientID = i % 2 ? 1_000_001 : 1_000_002;
    server.transact(() => image.setAttribute('h', String(i)));
  }
  server.clientID = 1_000_003;
  server.transact(() => image.removeAttribute('h'));
  server.clientID = own;
  const { host, client, send } = hosted(server);
  const { text, units } = liveUnits(server);
  const at = text.indexOf('￼');
  host.create('c1', mintAnchor(units[at], units[at], 'block'));
  expect(send(() => client.get('root', Y.XmlText).delete(1, 1)).refused).toBeNull();
  return { stats: counted(host), status: host.anchor('c1')?.status };
}

describe('T4.2 anchor cost: decorator fingerprints read attribute history inside the walk budget @p:tech-3', () => {
  it('anchor-attribute-history-obeys-walk-budget', () => {
    const small = decoratorWithHistory(10);
    const large = decoratorWithHistory(1_000);
    expect(small.status).toBe('orphaned');
    expect(large.status).toBe('orphaned');
    expect(large.stats.structs - small.stats.structs, 'each historical value read is counted').toBeGreaterThanOrEqual(990);
    const huge = decoratorWithHistory(60_000);
    expect(huge.stats.structs, 'the walk stops at its budget').toBeLessThanOrEqual(COMMENT_BUDGET);
    expect(huge.status, 'over budget fails safe').toBe('orphaned');
  });
});

/**
 * A comment on 'beta', written by one client, then `unrelated` later word comments on that same client's text; the
 * fixed frame deletes and retypes 'beta' (a gap re-mint onto that client's newest clocks). Returns its work, the index
 * updates after the flush included.
 */
function remintAmong(unrelated: number): FrameStats {
  const server = new Y.Doc();
  const root = server.get('root', Y.XmlText);
  server.transact(() => {
    addParagraph(root, 0, 'alpha  gamma.');
    addParagraph(root, 1, '');
  });
  const { host, client, send } = hosted(server);
  send(() => paragraph(client, 0).insert(7, 'beta'));
  const commentOn = (id: string, quote: string, nth = 0) => {
    const { text, units } = liveUnits(server);
    let at = -1;
    for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
    host.create(id, mintAnchor(units[at], units[at + quote.length - 1]));
  };
  commentOn('c1', 'beta');
  for (let n = 0; n < unrelated; n += 1) {
    send(() => paragraph(client, 1).insert(paragraph(client, 1).length, `${word(n)} `));
    commentOn(`u${n}`, word(n));
  }
  expect(send(() => {
    paragraph(client, 0).delete(7, 4);
    paragraph(client, 0).insert(7, 'beta');
  }).refused).toBeNull();
  expect(host.anchor('c1')?.status).toBe('anchored');
  return counted(host);
}

describe('T4.2 anchor cost: index maintenance is bounded by the frame @p:tech-3', () => {
  it('anchor-index-maintenance-is-frame-bounded', () => {
    const few = remintAmong(10);
    const many = remintAmong(1_900);
    expect(few.index, 'the index updates after the flush are counted').toBeGreaterThan(0);
    expect(many.index, 'independent of the other spans of that client').toBe(few.index);
    expect(many.structs, 'counted with the tree visits').toBe(few.structs);
  });
});

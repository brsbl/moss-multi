// restoredCopies (suggestions.md §4.7): a copy of a copy resolves to the body unit it restores, in time linear in the
// doc, whatever order writers chose their client ids in, and without recursion however writers shaped the chain.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { itemKey, restoredCopies } from './apply.ts';

const BASE = 1_000_000;
const CHAIN = 2_000;

/**
 * A paragraph (a text node's property map, then "x") in `body`; `doc` replaces "x" by a copy of it, that copy by a copy
 * of it, and so on, each copy under its own client, the last one live. Every copying client first wrote elsewhere in
 * reverse order, so the store iterates the chain's clients last link first.
 */
function chain(): { doc: Y.Doc; body: Y.Doc; original: Y.ID; last: Y.ID } {
  // As the fork and the mirrors keep them: a removed copy keeps its content.
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const root = doc.get('root', Y.XmlText);
  const paragraph = new Y.XmlText();
  root.insertEmbed(0, paragraph);
  const properties = new Y.Map<string>();
  paragraph.insertEmbed(0, properties);
  properties.set('__type', 'text');
  paragraph.insert(1, 'x');
  const original = (paragraph._start!.right as Y.Item).id;
  const scratch = doc.getText('scratch');
  for (let k = CHAIN; k >= 1; k -= 1) {
    doc.clientID = BASE + k;
    scratch.insert(scratch.length, '.');
  }
  const body = new Y.Doc({ gc: false });
  Y.applyUpdate(body, Y.encodeStateAsUpdate(doc));
  let last = original;
  for (let k = 1; k <= CHAIN; k += 1) {
    doc.clientID = BASE + k;
    paragraph.insert(1, 'x');
    paragraph.delete(2, 1);
    last = Y.createID(BASE + k, 1);
  }
  return { doc, body, original, last };
}

describe('T5.S14 restoredCopies is linear @p:mean-2 @p:R17', () => {
  it('a copy chain across 2,000 clients in reverse client order resolves to its body original in steps linear in the structs', () => {
    const { doc, body, original, last } = chain();
    expect([...doc.store.clients.keys()].slice(1, 3), 'the chain iterates last link first').toEqual([BASE + CHAIN, BASE + CHAIN - 1]);
    const structs = [...doc.store.clients.values()].reduce((sum, list) => sum + list.length, 0);
    const steps = { count: 0 };
    const restored = restoredCopies(doc, body, steps);
    expect([...restored.copies], 'the live copy restores the body original').toEqual([[itemKey(last), original]]);
    expect([...restored.originals]).toEqual([itemKey(original)]);
    expect([...restored.clients]).toEqual([last.client]);
    expect(steps.count, `steps for ${structs} structs`).toBeLessThan(structs * 12);
  });

  it('a restores chain alternating text and map units 50,000 deep returns without throwing, in steps linear in the structs', () => {
    const DEPTH = 50_000;
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 1;
    const root = doc.get('root', Y.XmlText);
    const paragraph = new Y.XmlText();
    root.insertEmbed(0, paragraph);
    const properties = new Y.Map<string>();
    paragraph.insertEmbed(0, properties);
    properties.set('__type', 'text');
    paragraph.insert(1, 'x');
    const body = new Y.Doc({ gc: false });
    Y.applyUpdate(body, Y.encodeStateAsUpdate(doc));
    // Each unit restores the one before it (inserted just before it, which is then removed), text and map in turn, so
    // the text links' property map is the live map at the chain's head.
    doc.clientID = 2;
    for (let k = 1; k <= DEPTH; k += 1) {
      if (k % 2) paragraph.insert(1, 'x');
      else paragraph.insertEmbed(1, new Y.Map());
      paragraph.delete(2, 1);
    }
    const structs = [...doc.store.clients.values()].reduce((sum, list) => sum + list.length, 0);
    const steps = { count: 0 };
    let restored: ReturnType<typeof restoredCopies> | null = null;
    expect(() => {
      restored = restoredCopies(doc, body, steps);
    }).not.toThrow();
    expect([...restored!.copies], 'a map restores no text').toEqual([]);
    expect(steps.count, `steps for ${structs} structs`).toBeLessThan(structs * 12);
  });
});

/** The text of the first top-level paragraph of `doc`. */
const firstText = (doc: Y.Doc): string => {
  const [first] = doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[];
  if (!(first?.insert instanceof Y.XmlText)) return '';
  return (first.insert.toDelta() as { insert: unknown }[]).map(({ insert }) => (typeof insert === 'string' ? insert : '')).join('');
};

/**
 * A paragraph "abcd" in `live`; the mirror restores "bc" as copies (an undo's redo of removed text) and types "X"
 * between the copies, so accept keeps the originals and writes "X" afresh after the original "b" (orderPlan).
 */
function typedAmongCopies() {
  const live = new Y.Doc({ gc: false });
  live.clientID = 1;
  const paragraph = new Y.XmlText();
  live.get('root', Y.XmlText).insertEmbed(0, paragraph);
  const properties = new Y.Map<string>();
  paragraph.insertEmbed(0, properties);
  properties.set('__type', 'text');
  paragraph.insert(1, 'abcd');
  const chars = (paragraph._start!.right as Y.Item).id;
  const mirror = new Y.Doc({ gc: false });
  Y.applyUpdate(mirror, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(mirror);
  mirror.clientID = 2;
  const copy = (mirror.get('root', Y.XmlText).toDelta() as { insert: Y.XmlText }[])[0]!.insert;
  copy.insert(2, 'bc');
  copy.delete(4, 2);
  copy.insert(3, 'X');
  const restored = restoredCopies(mirror, live);
  const removed = [{ client: 1, clock: chars.clock + 1, len: 2 }];
  const landed = landing(mirror, sv, removed, () => false, restored)!;
  return { live, mirror, restored, update: landed.update, paragraph };
}

describe('T5.S14 accept never guesses where typing among restored copies goes @p:mean-2 @p:R17', () => {
  it('typing among the copies lands where the preview shows it', () => {
    const { live, mirror, restored, update } = typedAmongCopies();
    expect(restored.copies.size, 'both copies read as their originals').toBe(2);
    const moved = relocated(live, update, mirror, restored);
    expect(moved).not.toBeNull();
    const landed = new Y.Doc({ gc: false });
    Y.applyUpdate(landed, Y.encodeStateAsUpdate(live));
    Y.applyUpdate(landed, moved!);
    expect(firstText(landed)).toBe('abXcd');
  });

  it.each([
    ['its anchor unit', (paragraph: Y.XmlText) => paragraph.delete(2, 1)],
    ['its holder paragraph', (paragraph: Y.XmlText) => (paragraph.parent as Y.XmlText).delete(0, 1)],
  ] as const)('a plan whose %s a concurrent writer deleted between preview and accept refuses the whole accept and changes nothing', (_name, concurrent) => {
    const { live, mirror, restored, update, paragraph } = typedAmongCopies();
    live.clientID = 3;
    concurrent(paragraph);
    const before = Y.encodeStateAsUpdate(live);
    expect(relocated(live, update, mirror, restored), 'refused (accept answers 409)').toBeNull();
    expect(Y.encodeStateAsUpdate(live), 'the doc is byte-identical').toEqual(before);
  });
});

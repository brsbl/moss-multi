// restoredCopies (suggestions.md §4.7): a copy of a copy resolves to the body unit it restores, in time linear in the
// doc, whatever order writers chose their client ids in.
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
});

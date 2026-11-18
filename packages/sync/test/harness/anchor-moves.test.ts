// T4.W: a large paste holds back its deletes until every item of it has landed (T3.B32), so the delete of the words a
// split moved reaches the DocDO after their copy, in a frame of its own. The pasting tab names where the comments on
// them went in a moves message just before that frame; the DocDO takes a named place only for a comment that frame
// would detach, and only when it reads exactly as the comment's text did.
import { $createParagraphNode, $createTextNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { liveUnits, mintAnchor } from '@moss-multi/core/anchor-frame';
import { encodeMovesFrame } from '@moss-multi/protocol/sync';
import { deletesUpdate, PasteWatch, withoutDeletes } from '../../src/paste-rollback.ts';
import { $block, $caret, scene, type Peer, type Scene } from './comments-scene.ts';

/** The anchor positions over the live `quote` in `peer`'s doc (the `nth` occurrence). */
function placeOf(peer: Peer, quote: string, nth = 0): [string, string] {
  const { text, units } = liveUnits(peer.doc);
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`"${quote}" is not in ${JSON.stringify(text)}`);
  const minted = mintAnchor(units[at], units[at + quote.length - 1]);
  return [minted.start, minted.end];
}

/**
 * A paste at the caret before "lazy dog." that lands in two writes, each sent without the paste's deletes: the split
 * (the words move into a new paragraph) and a later paragraph between. Returns the held deletes.
 */
async function landWithHeldDeletes(s: Scene, a: Peer): Promise<ReturnType<PasteWatch['deletes']>> {
  const watch = new PasteWatch(a.doc);
  a.edit(() => $caret('lazy dog.').insertParagraph());
  a.edit(() => $block(0).insertAfter($createParagraphNode().append($createTextNode('Pasted later.'))));
  watch.finish();
  const held = watch.deletes();
  expect(held.length, 'the split deleted the moved words').toBeGreaterThan(0);
  for (const frame of a.outbox.splice(0)) expect((await s.deliver(withoutDeletes(frame, held))).refused).toBeNull();
  s.pullAll();
  expect(s.text('c1'), 'the comment stays on the original words while the deletes are held').toBe('lazy dog.');
  return held;
}

describe('T4.W a paste\'s held-back deletes keep a comment on the text it moved @p:tech-3 @p:R18', () => {
  it('the moved copy the paster names takes the comment, on the server', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'lazy dog.');
    const held = await landWithHeldDeletes(s, a);
    const [start, end] = placeOf(a, 'lazy dog.');
    await s.message(encodeMovesFrame([['c1', start, end]]));
    expect((await s.deliver(deletesUpdate(held))).refused).toBeNull();
    expect(s.status('c1')).toBe('anchored');
    expect(s.text('c1'), 'the comment is on the moved words').toBe('lazy dog.');
    expect(liveUnits(s.server).text).toContain('Pasted later.');
  }));

  it('without a named place the comment detaches, as any delete of its words does', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'lazy dog.');
    const held = await landWithHeldDeletes(s, a);
    expect((await s.deliver(deletesUpdate(held))).refused).toBeNull();
    expect(s.status('c1')).toBe('orphaned');
  }));

  it('a named place that reads differently is not taken', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'lazy dog.');
    const held = await landWithHeldDeletes(s, a);
    const [start, end] = placeOf(a, 'quick brown');
    await s.message(encodeMovesFrame([['c1', start, end]]));
    expect((await s.deliver(deletesUpdate(held))).refused).toBeNull();
    expect(s.status('c1')).toBe('orphaned');
  }));

  it('a named place holds for the next frame only', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'lazy dog.');
    const held = await landWithHeldDeletes(s, a);
    const [start, end] = placeOf(a, 'lazy dog.');
    await s.message(encodeMovesFrame([['c1', start, end]]));
    a.edit(() => $caret('Third.').insertText('More. '));
    for (const frame of a.outbox.splice(0)) expect((await s.deliver(frame)).refused).toBeNull();
    expect((await s.deliver(deletesUpdate(held))).refused).toBeNull();
    expect(s.status('c1')).toBe('orphaned');
  }));

  it('a comment the frame does not detach is never moved by a named place', () => scene(async (s) => {
    const a = s.peer();
    await s.comment('c1', 'lazy dog.');
    await s.comment('c2', 'Second paragraph');
    const held = await landWithHeldDeletes(s, a);
    const [start, end] = placeOf(a, 'lazy dog.');
    await s.message(encodeMovesFrame([['c1', start, end], ['c2', start, end]]));
    expect((await s.deliver(deletesUpdate(held))).refused).toBeNull();
    expect(s.text('c1')).toBe('lazy dog.');
    expect(s.text('c2'), 'c2 stays on its own words').toBe('Second paragraph');
  }));
});

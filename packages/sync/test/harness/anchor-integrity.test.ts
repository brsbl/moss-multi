// T4.0 never-jump and integrity scenes (docs/design/comments.md §0 I3-I5): each comment stays orphaned or stays on
// its own text. Equal text is a different occurrence unless it lies inside the comment's own gap or lost place.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { liveUnits } from '@moss-multi/core/anchor-frame';
import type { FrameVerdict } from '../../src/doc/comments-host.ts';
import { $block, $caret, $select, scene, type Scene } from './comments-scene.ts';
import { forged, raw } from './raw-frames.ts';

const TWINS = 'TODO: fix this\n\nTODO: fix this\n\nTail.';
const accepted = (verdicts: FrameVerdict[]) => expect(verdicts.map((verdict) => verdict.refused)).toEqual(verdicts.map(() => null));
const orphaned = (s: Scene, id = 'c1') => {
  expect(s.status(id), `${id} is orphaned`).toBe('orphaned');
  expect(s.text(id)).toBeNull();
};

/** The ids of the server's live units over the `nth` occurrence of `quote`, plus the unit just before it. */
function idsOf(s: Scene, quote: string, nth = 0): { before: Y.ID; first: Y.ID; last: Y.ID } {
  const { text, units } = liveUnits(s.server);
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
  const id = (i: number) => Y.createID(units[i].item.id.client, units[i].item.id.clock + units[i].off);
  return { before: id(at - 1), first: id(at), last: id(at + quote.length - 1) };
}

describe('T4.0 never-jump: a comment stays orphaned or on its own text @p:tech-3 @p:R16', () => {
  it('two identical lines: deleting the commented one never moves the comment to the other', () => scene((s) => {
    const a = s.peer();
    s.comment('c1', 'TODO: fix this', 1);
    a.edit(() => $block(1).remove());
    accepted(a.send());
    orphaned(s);
    a.edit(() => $caret('Tail').insertText('More. '));
    accepted(a.send());
    orphaned(s);
  }, TWINS));

  it('forged edge copies around new text leave it orphaned', () => scene((s) => {
    const a = s.peer();
    s.comment('c1', 'brown fox');
    const { before, first, last } = idsOf(s, 'brown fox');
    a.edit(() => $select('brown fox').removeText());
    accepted(a.send());
    orphaned(s);
    const frame = raw([
      forged(Y.createID(4242, 0), { origin: before, right: first }, new Y.ContentString('b')),
      forged(Y.createID(4242, 1), { origin: Y.createID(4242, 0), right: first }, new Y.ContentString('EVIL')),
      forged(Y.createID(4242, 5), { origin: Y.createID(4242, 4), right: last }, new Y.ContentString('x')),
    ]);
    accepted([s.deliver(frame)]);
    orphaned(s);
  }));

  it('a forged item whose origin is a distant live item and whose right origin is the deleted character leaves it orphaned', () => scene((s) => {
    const a = s.peer();
    s.comment('c1', 'brown fox');
    const { first } = idsOf(s, 'brown fox');
    const far = idsOf(s, 'Second').first;
    a.edit(() => $select('brown fox').removeText());
    accepted(a.send());
    const frame = raw([forged(Y.createID(4242, 0), { origin: far, right: first }, new Y.ContentString('brown fox'))]);
    accepted([s.deliver(frame)]);
    orphaned(s);
  }));

  it('a stale peer typing inside the deleted span keeps it orphaned, even after the deleter undoes', () => scene((s) => {
    const a = s.peer();
    const b = s.peer();
    s.comment('c1', 'brown fox');
    s.offline(b);
    a.edit(() => $select('brown fox').removeText());
    accepted(a.send());
    orphaned(s);
    b.edit(() => $caret('own').insertText('X'));
    s.online(b);
    accepted(b.send());
    orphaned(s);
    a.undo();
    accepted(a.send());
    expect(a.text()).toContain('brXown fox');
    orphaned(s);
  }));

  it('a decorator swapped for a different one in the same place orphans its block comment', () => scene((s) => {
    s.comment('c1', '￼', 0, 'block');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(s.server));
    const found = (function find(type: Y.XmlText): [Y.XmlText, number, Y.XmlElement] | null {
      let index = 0;
      for (const { insert } of type.toDelta() as { insert: unknown }[]) {
        if (insert instanceof Y.XmlElement) return [type, index, insert];
        if (insert instanceof Y.XmlText) {
          const inner = find(insert);
          if (inner) return inner;
        }
        index += typeof insert === 'string' ? insert.length : 1;
      }
      return null;
    })(client.get('root', Y.XmlText));
    expect(found, 'the image is a decorator').not.toBeNull();
    const [parent, index, image] = found!;
    client.transact(() => {
      const swap = new Y.XmlElement(image.nodeName);
      for (const [key, value] of Object.entries(image.getAttributes())) swap.setAttribute(key, value as never);
      swap.setAttribute('src' as never, 'two.png' as never);
      parent.delete(index, 1);
      parent.insertEmbed(index, swap);
    });
    accepted([s.deliver(Y.encodeStateAsUpdate(client, Y.encodeStateVector(s.server)))]);
    orphaned(s);
    client.destroy();
  }, 'Before.\n\n![one](one.png)\n\nAfter.'));

  it('an identical paste over a different occurrence never takes the deleted comment', () => scene((s) => {
    const a = s.peer();
    s.comment('c1', 'TODO: fix this', 1);
    a.edit(() => $select('TODO: fix this', 1).removeText());
    accepted(a.send());
    orphaned(s);
    a.edit(() => $select('TODO: fix this', 0).insertText('TODO: fix this'));
    accepted(a.send());
    orphaned(s);
  }, TWINS));
});

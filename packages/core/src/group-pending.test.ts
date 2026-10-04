// T4.0 frame discipline (docs/design/comments.md §5): pending local updates replay as separate frames, coalescing
// only runs of insert-only or delete-only updates.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { groupPending } from './group-pending.ts';

function updates(): { doc: Y.Doc; log: Uint8Array[] } {
  const doc = new Y.Doc();
  const log: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => log.push(update));
  return { doc, log };
}

const kinds = (frames: Uint8Array[]) =>
  frames.map((frame) => {
    const { structs, ds } = Y.decodeUpdate(frame);
    return `${structs.length ? 'i' : ''}${ds.clients.size ? 'd' : ''}`;
  });

describe('T4.0 groupPending @p:tech-3', () => {
  it('never merges a deleting update with another update\'s inserts', () => {
    const { doc, log } = updates();
    const text = doc.getText('t');
    text.insert(0, 'abc');
    text.insert(3, 'def');
    text.delete(0, 1);
    text.delete(0, 1);
    doc.transact(() => {
      text.delete(0, 1);
      text.insert(0, 'X');
    });
    text.insert(0, 'Y');
    text.delete(0, 1);
    text.insert(0, 'Z');
    const frames = groupPending(log);
    expect(kinds(frames)).toEqual(['i', 'd', 'id', 'i', 'd', 'i']);
    const replay = new Y.Doc();
    for (const frame of frames) Y.applyUpdate(replay, frame);
    expect(replay.getText('t').toString()).toBe(text.toString());
  });

  it('keeps a delete and a retype of the same text in different frames', () => {
    const { doc, log } = updates();
    const text = doc.getText('t');
    text.insert(0, 'brown');
    log.length = 0;
    text.delete(0, 5);
    text.insert(0, 'brown');
    expect(kinds(groupPending(log))).toEqual(['d', 'i']);
  });
});

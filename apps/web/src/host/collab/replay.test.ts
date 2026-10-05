// The client frame discipline (T4.2; docs/design/comments.md §6): a replay sends unacked writes as grouped frames, at
// most 40 a second, with writes made meanwhile after them, and only then answers the server's step 1.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { readStep1, Replay, REPLAY_FRAMES_PER_SECOND } from './replay.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const kinds = (frames: Uint8Array[]) =>
  frames.map((frame) => {
    const { structs, ds } = Y.decodeUpdate(frame);
    return `${structs.length ? 'i' : ''}${ds.clients.size ? 'd' : ''}`;
  });

function writes(): { doc: Y.Doc; log: Uint8Array[] } {
  const doc = new Y.Doc();
  const log: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => log.push(update));
  return { doc, log };
}

it('replays a deletion apart from the typing around it, paced, then answers', () => {
  const { doc, log } = writes();
  const text = doc.getText('t');
  text.insert(0, 'quick brown');
  text.insert(8, 'X');
  text.delete(0, 12);
  text.insert(0, 'quick brown');
  const sent: Uint8Array[] = [];
  const done = vi.fn();
  const replay = new Replay((frame) => {
    sent.push(frame);
    return true;
  });
  replay.start(log, done);
  expect(sent, 'the first frame goes at once').toHaveLength(1);
  expect(replay.active).toBe(true);
  const gap = 1000 / REPLAY_FRAMES_PER_SECOND;
  vi.advanceTimersByTime(gap - 1);
  expect(sent, 'no faster than 40 a second').toHaveLength(1);
  // A write made during the replay waits behind it.
  text.insert(0, 'Y');
  replay.hold(log.at(-1)!);
  vi.advanceTimersByTime(1);
  expect(sent).toHaveLength(2);
  vi.advanceTimersByTime(gap * 2);
  expect(kinds(sent), 'typing, the deletion alone, the retype, then the write made meanwhile').toEqual(['i', 'd', 'i', 'i']);
  expect(done).not.toHaveBeenCalled();
  vi.advanceTimersByTime(gap);
  expect(done).toHaveBeenCalledTimes(1);
  expect(replay.active).toBe(false);
  const server = new Y.Doc();
  for (const frame of sent) Y.applyUpdate(server, frame);
  expect(server.getText('t').toString()).toBe(text.toString());
});

it('a socket that can no longer send ends the replay without answering', () => {
  const { doc, log } = writes();
  doc.getText('t').insert(0, 'a');
  doc.getText('t').delete(0, 1);
  const done = vi.fn();
  let open = true;
  const replay = new Replay(() => open);
  replay.start(log, done);
  open = false;
  vi.advanceTimersByTime(1_000);
  expect(done).not.toHaveBeenCalled();
  expect(replay.active).toBe(false);
});

/** A y-protocols sync message body: its type, then a length-prefixed payload (lengths here stay under 128). */
const message = (type: number, payload: Uint8Array) => ({ arr: Uint8Array.from([type, payload.length, ...payload]), pos: 0 });

it('reads a sync step 1 and leaves any other sync message unread', () => {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'abc');
  const sv = Y.encodeStateVector(doc);
  const step1 = message(syncProtocol.messageYjsSyncStep1, sv);
  expect(readStep1(step1)).toEqual(sv);
  expect(step1.pos).toBe(step1.arr.length);
  const update = message(syncProtocol.messageYjsUpdate, Y.encodeStateAsUpdate(doc));
  expect(readStep1(update)).toBeNull();
  expect(update.pos).toBe(0);
});

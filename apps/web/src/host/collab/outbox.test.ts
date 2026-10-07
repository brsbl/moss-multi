import { encodeSyncFrame } from '@moss-multi/protocol/sync';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Outbox } from './outbox.ts';

const AWARENESS = new Uint8Array([1, 2, 0, 0]);

function bigDoc(): { doc: Y.Doc; update: Uint8Array } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on('update', (update: Uint8Array) => updates.push(update));
  doc.transact(() => {
    for (let i = 0; i < 300; i += 1) {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'paragraph');
      block.insert(0, `Paragraph ${i} `.repeat(30));
      doc.get('root', Y.XmlText).insertEmbed(i, block);
    }
  });
  return { doc, update: updates[0] };
}

/** The update a `[0, 2, varUint8Array]` sync frame carries. */
function payloadOf(frame: Uint8Array): Uint8Array {
  let length = 0;
  let shift = 0;
  let at = 2;
  for (;;) {
    const byte = frame[at++];
    length += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) break;
  }
  return frame.subarray(at, at + length);
}

const isUpdate = (frame: Uint8Array | string): frame is Uint8Array => typeof frame !== 'string' && frame[0] === 0 && frame[1] === 2;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('sends small frames at once, and a large update in pieces paced by acks, in order', () => {
  const { doc, update } = bigDoc();
  const sent: (Uint8Array | string)[] = [];
  const outbox = new Outbox(doc, (frame) => sent.push(frame), { pieceBytes: 8 * 1024, windowBytes: 16 * 1024, stallMs: 5_000 });
  outbox.send(encodeSyncFrame(0, Y.encodeStateVector(doc)));
  expect(sent, 'a small frame goes at once').toHaveLength(1);
  sent.length = 0;
  outbox.send(encodeSyncFrame(2, update));
  expect(sent.length, 'a window of pieces goes before any ack').toBeGreaterThan(0);
  expect(sent.length).toBeLessThanOrEqual(3);
  expect(outbox.busy).toBe(true);
  const typed = encodeSyncFrame(2, new Uint8Array([0, 0]));
  outbox.send(typed);
  outbox.send(AWARENESS);
  expect(sent[sent.length - 1], 'awareness never waits').toBe(AWARENESS);
  expect(sent.includes(typed), 'a later write waits behind the pieces').toBe(false);

  const peer = new Y.Doc();
  const order: Uint8Array[] = [];
  const deliver = () => {
    for (const frame of sent.splice(0)) {
      if (!isUpdate(frame)) continue;
      order.push(frame);
      if (frame !== typed) Y.applyUpdate(peer, payloadOf(frame));
    }
  };
  let rounds = 0;
  while (outbox.busy && rounds < 200) {
    rounds += 1;
    deliver();
    outbox.acked(Y.decodeStateVector(Y.encodeStateVector(peer)));
  }
  deliver();
  expect(rounds).toBeGreaterThan(2);
  expect(order[order.length - 1], 'the later write goes last').toBe(typed);
  expect(peer.get('root', Y.XmlText).toJSON()).toEqual(doc.get('root', Y.XmlText).toJSON());
  outbox.close();
});

it('keeps going when no ack comes, and drops pieces an ack already covers', () => {
  const { doc, update } = bigDoc();
  const sent: (Uint8Array | string)[] = [];
  const outbox = new Outbox(doc, (frame) => sent.push(frame), { pieceBytes: 8 * 1024, windowBytes: 8 * 1024, stallMs: 2_000 });
  outbox.send(encodeSyncFrame(2, update));
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(2_000);
  expect(sent, 'a stalled window reopens').toHaveLength(2);
  outbox.acked(Y.decodeStateVector(Y.encodeStateVector(doc)));
  expect(outbox.busy, 'everything left is already on the server').toBe(false);
  expect(sent).toHaveLength(2);
  outbox.close();
});

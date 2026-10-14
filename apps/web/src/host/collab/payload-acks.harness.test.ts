// B290: payload ids named like Object's own keys, through the real DocDO's acks and into the client's ack ledger.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ACK_COALESCE_MS } from '@moss-multi/protocol/limits';
import { bytesToBase64, CUSTOM_PREFIX, encodePayloadFrame, PAYLOAD_UPDATE } from '@moss-multi/protocol/sync';
import { connect, openDoc, start } from '../../../../../packages/sync/test/harness/do-harness.ts';
import { AckLedger, type Ack } from './acks.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('an ack names payloads __proto__ and constructor as its own keys, and the ledger settles both', async () => {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: 'Intro.' });
  const ada = await connect(opened, { id: 'ada', role: 'editor' });
  await ada.hello();
  const ledger = new AckLedger();
  const ids = ['__proto__', 'constructor'];
  for (const id of ids) {
    const doc = new Y.Doc();
    doc.on('update', (update: Uint8Array) => ledger.wrote(update, id));
    doc.getText('payload').insert(0, `text of ${id}`);
    await ada.deliver(encodePayloadFrame(id, PAYLOAD_UPDATE, Y.encodeStateAsUpdate(doc)));
  }
  expect(ada.closed).toBeNull();
  const note = bytesToBase64(Y.encodeStateVector(new Y.Doc()));
  expect(() => ledger.acked(JSON.parse(`{"t":"ack","sv":"${note}","p":{}}`)), 'an ack lacking them').not.toThrow();
  expect(ledger.pendingPayloads().sort(), 'still pending').toEqual(['__proto__', 'constructor']);
  const sent = ada.socket.sent.length;
  vi.advanceTimersByTime(ACK_COALESCE_MS + 1);
  const raw = ada.socket.sent.slice(sent).filter((frame): frame is string => typeof frame === 'string' && frame.startsWith(CUSTOM_PREFIX));
  const acks = raw.map((frame) => JSON.parse(frame.slice(CUSTOM_PREFIX.length)) as Ack).filter((event) => event.t === 'ack');
  expect(acks.length).toBeGreaterThan(0);
  for (const id of ids) expect(acks.some((ack) => ack.p && Object.hasOwn(ack.p, id)), `the ack's own key ${id}`).toBe(true);
  for (const ack of acks) ledger.acked(ack);
  expect(ledger.unacked, 'both settle').toBe(false);
});

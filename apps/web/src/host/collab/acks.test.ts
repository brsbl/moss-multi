import { expect, it } from 'vitest';
import { bytesToBase64 } from '@moss-multi/protocol/sync';
import * as Y from 'yjs';
import { AckLedger } from './acks.ts';

it('a stale vector cannot acknowledge a later delete; reconnect coverage can', () => {
  const doc = new Y.Doc();
  const ledger = new AckLedger();
  doc.on('update', (update: Uint8Array) => ledger.wrote(update));
  doc.getText('title').insert(0, 'abc');
  const sv = bytesToBase64(Y.encodeStateVector(doc));
  expect(ledger.acked({ t: 'ack', sv })).toBe(true);
  doc.getText('title').delete(0, 1);
  expect(ledger.acked({ t: 'ack', sv })).toBe(false);
  const first = Y.snapshot(doc).ds;
  doc.getText('title').delete(0, 1);
  expect(ledger.acked({ t: 'ack', sv, ds: bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(first, new Map()))) })).toBe(false);
  expect(ledger.acked({ t: 'ack', sv, ds: bytesToBase64(Y.encodeSnapshot(Y.snapshot(doc))) })).toBe(true);
  expect(ledger.unacked).toBe(false);
  doc.destroy();
});

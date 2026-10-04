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

it('a payload write stays unacked until an ack names that payload and covers it', () => {
  const note = new Y.Doc();
  const code = new Y.Doc();
  const ledger = new AckLedger();
  note.on('update', (update: Uint8Array) => ledger.wrote(update));
  code.on('update', (update: Uint8Array) => ledger.wrote(update, 'code'));
  note.getText('title').insert(0, 'note');
  code.getText('payload').insert(0, 'typed');
  const noteSv = bytesToBase64(Y.encodeStateVector(note));
  expect(ledger.acked({ t: 'ack', sv: noteSv }), 'the note alone is covered').toBe(false);
  expect(ledger.pendingPayloads()).toEqual(['code']);
  expect(ledger.acked({ t: 'ack', sv: noteSv, p: { other: { sv: bytesToBase64(Y.encodeStateVector(code)) } } })).toBe(false);
  expect(ledger.acked({ t: 'ack', sv: noteSv, p: { code: { sv: bytesToBase64(Y.encodeStateVector(code)) } } })).toBe(true);
  code.getText('payload').delete(0, 1);
  const sv = bytesToBase64(Y.encodeStateVector(code));
  expect(ledger.acked({ t: 'ack', sv: noteSv, p: { code: { sv } } }), 'a delete needs its delete set').toBe(false);
  expect(ledger.acked({ t: 'ack', sv: noteSv, p: { code: { sv, ds: bytesToBase64(Y.encodeSnapshot(Y.snapshot(code))) } } })).toBe(true);
  note.destroy();
  code.destroy();
});

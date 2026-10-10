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

it('each acked write leaves the ledger as its ack arrives, so a resync resends only the writes still in flight (T3.S6)', () => {
  const doc = new Y.Doc();
  const ledger = new AckLedger();
  doc.on('update', (update: Uint8Array) => ledger.wrote(update));
  const text = doc.getText('body');
  text.insert(0, 'first batch, ');
  const firstSv = bytesToBase64(Y.encodeStateVector(doc));
  text.insert(text.length, 'second batch');
  expect(ledger.acked({ t: 'ack', sv: firstSv }), 'the second batch is still in flight').toBe(false);
  const resent = ledger.pendingUpdate();
  expect(resent).not.toBeNull();
  expect(Y.parseUpdateMeta(resent!).from.get(doc.clientID), 'the acked first batch is not resent').toBe('first batch, '.length);
  expect(ledger.acked({ t: 'ack', sv: bytesToBase64(Y.encodeStateVector(doc)) })).toBe(true);
  expect(ledger.pendingUpdate()).toBeNull();
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

it('a payload ack names only its own frames\' clocks, so an edit past clock 0 and a delete-only window still settle', () => {
  const code = new Y.Doc();
  const ledger = new AckLedger();
  const frames: Uint8Array[] = [];
  code.on('update', (update: Uint8Array) => {
    ledger.wrote(update, 'code');
    frames.push(update);
  });
  // The DocDO's coverage of a window: each frame's clock range end, never the doc's whole vector.
  const ackOf = (window: Uint8Array[], deletes = false) => {
    const sv = new Map<number, number>();
    for (const frame of window) for (const [client, end] of Y.parseUpdateMeta(frame).to) sv.set(client, Math.max(sv.get(client) ?? 0, end));
    const ds = deletes ? Y.mergeDeleteSets(window.map((frame) => Y.decodeUpdate(frame).ds)) : Y.createDeleteSet();
    return { t: 'ack' as const, sv: '', p: { code: { sv: bytesToBase64(Y.encodeStateVector(sv)), ds: bytesToBase64(Y.encodeSnapshot(Y.createSnapshot(ds, new Map()))) } } };
  };
  code.getText('payload').insert(0, 'a');
  expect(ledger.acked(ackOf(frames.splice(0))), 'the first write').toBe(true);
  code.getText('payload').insert(1, 'b');
  code.getText('payload').insert(2, 'c');
  expect(ledger.acked(ackOf(frames.splice(0))), 'later writes start past clock 0').toBe(true);
  code.getText('payload').insert(3, 'd');
  const inserts = frames.splice(0);
  code.getText('payload').delete(0, 1);
  expect(ledger.acked(ackOf(inserts)), 'the delete is not acked yet').toBe(false);
  expect(ledger.acked(ackOf(frames.splice(0), true)), 'a delete-only window settles with the earlier vector').toBe(true);
  code.destroy();
});

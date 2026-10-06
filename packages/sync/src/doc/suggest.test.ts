// Suggest-mode ingest is bookkeeping in O(frame) (docs/design/suggestions.md §3, §6, §14): leases with per-doc clocks,
// server-minted record ids, `suggest-ops` checks on the body and payload docs against the channel table,
// `suggest-delete` validation, continuations, merge, undelete and withdraw, and the cost of ingest and of the
// body-frame lease check, which grows with neither the doc nor its closed records.
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { deleteUpdate, recordDigest } from '@moss-multi/core/suggest/apply';
import { payloadDocsFor } from '../payload-docs.ts';
import { closeRecord, newSuggestionsClient, readMeta, readRecord, SuggestionsWriter } from '../suggest/records.ts';
import { acceptRecord, nodeRegistry, previewRecord, rejectRecord } from '../suggest/review.ts';
import { ForkShim } from '../suggest/fork-shim.ts';
import { EDITOR, OTHER_SUGGESTER, seededBody, select, spansOfText, SUGGESTER } from '../suggest/test-support.ts';
import { SUGGEST_CAPS, SuggestIngest, type IngestOptions, type Suggester } from './suggest.ts';

const sam = (connection = 'c-sam', role = 'suggester'): Suggester => ({ ...SUGGESTER, role, connection });
const sky = (connection = 'c-sky', role = 'suggester'): Suggester => ({ ...OTHER_SUGGESTER, role, connection });

const ingestOn = (doc: Y.Doc, options: Partial<IngestOptions> = {}) =>
  new SuggestIngest(doc, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry(), ...options });

function leaseOne(ingest: SuggestIngest, who: Suggester) {
  const leased = ingest.lease(who, [], 1);
  expect(leased).toMatchObject({ ok: true });
  return (leased as { leases: { client: number; record: string }[] }).leases[0];
}

/** What `write` does on a copy of `live` under `client`, as one update. */
function frame(live: Y.Doc, client: number, write: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = client;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(doc);
  write(doc);
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return update;
}

const paragraph = (text: string, type = 'paragraph') => {
  const block = new Y.XmlText();
  block.setAttribute('__type', type);
  block.insert(0, text);
  return block;
};
const append = (doc: Y.Doc, block: Y.XmlText) => doc.get('root', Y.XmlText).insertEmbed(doc.get('root', Y.XmlText).length, block);
const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;

/** Accepts `id` as an editor would, through the preview's hash. */
function accept(live: Y.Doc, id: string) {
  const preview = previewRecord(live, id);
  if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
  return acceptRecord(live, id, { previewHash: preview.hash, digest: recordDigest(readRecord(live, id)!) }, EDITOR);
}

describe('T5.2 ingest: leases and suggest-ops @p:mean-2', () => {
  it('leases are exclusive and never in the body state vector', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const leased = [sam(), sky(), sam()].flatMap((who) => (ingest.lease(who) as { leases: { client: number }[] }).leases.map((l) => l.client));
    expect(leased).toHaveLength(6);
    expect(new Set(leased).size).toBe(leased.length);
    const body = Y.decodeStateVector(Y.encodeStateVector(live));
    for (const client of leased) expect(body.has(client)).toBe(false);
  });

  it('a frame under a lease is appended to the record minted with it; the body is never written', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const { client, record } = leaseOne(ingest, sam());
    const root = JSON.stringify(live.get('root', Y.XmlText).toJSON());
    const update = frame(live, client, (doc) => append(doc, paragraph('mine')));
    expect(ingest.ops(sam(), record, update)).toMatchObject({ ok: true, record, requested: record, sv: { [client]: Y.parseUpdateMeta(update).to.get(client) } });
    expect(JSON.stringify(live.get('root', Y.XmlText).toJSON())).toBe(root);
    const stored = readRecord(live, record)!;
    expect(stored.ops).toEqual([{ doc: 'body', update }]);
    expect(stored.meta).toMatchObject({ author: SUGGESTER.id, status: 'open', clients: [client] });
  });

  it('refuses a client it did not lease to this connection, a clock gap, an unregistered node type and a role below suggester', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const mine = leaseOne(ingest, sam());
    const theirs = leaseOne(ingest, sky());
    const x = (client: number) => frame(live, client, (doc) => append(doc, paragraph('x')));
    expect(ingest.ops(sam(), mine.record, x(0x5eed0001))).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam(), mine.record, x(theirs.client))).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam('another-connection'), mine.record, x(mine.client))).toEqual({ ok: false, reason: 'lease' });
    const gapped = new Y.Doc();
    gapped.clientID = mine.client;
    Y.applyUpdate(gapped, Y.encodeStateAsUpdate(live));
    append(gapped, paragraph('first'));
    const after = Y.encodeStateVector(gapped);
    append(gapped, paragraph('second'));
    expect(ingest.ops(sam(), mine.record, Y.encodeStateAsUpdate(gapped, after))).toEqual({ ok: false, reason: 'clock-gap' });
    expect(ingest.ops(sam(), mine.record, frame(live, mine.client, (doc) => append(doc, paragraph('x', 'no-such-node'))))).toEqual({ ok: false, reason: 'node-type' });
    expect(ingest.ops(sam('c-sam', 'commenter'), mine.record, x(mine.client))).toEqual({ ok: false, reason: 'role' });
    expect(readRecord(live, mine.record)).toBeNull();
  });

  it("another principal cannot write into someone's record", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const mine = leaseOne(ingest, sam());
    const theirs = leaseOne(ingest, sky());
    expect(ingest.ops(sam(), mine.record, frame(live, mine.client, (doc) => append(doc, paragraph('a'))))).toMatchObject({ ok: true });
    expect(ingest.ops(sky(), mine.record, frame(live, theirs.client, (doc) => append(doc, paragraph('b'))))).toEqual({ ok: false, reason: 'not-author' });
  });

  it("payload ops ride the same leases, each payload doc with its own clocks; one outside the record's leases is refused", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const mine = leaseOne(ingest, sam());
    const theirs = leaseOne(ingest, sky());
    const [id, held] = [...payloadDocsFor(live).docs][0];
    const edit = (client: number, text: string) => frame(held, client, (doc) => doc.getText('payload').insert(0, text));
    const body = frame(live, mine.client, (doc) => append(doc, paragraph('mine')));
    expect(ingest.ops(sam(), mine.record, body)).toMatchObject({ ok: true, doc: 'body' });
    // The lease's clocks in the payload doc start at 0, whatever it wrote in the body.
    expect(ingest.ops(sam(), mine.record, { doc: id, update: edit(mine.client, 'p') })).toMatchObject({ ok: true, doc: id, sv: { [mine.client]: 1 } });
    expect(ingest.ops(sam(), mine.record, { doc: id, update: edit(0x5eed0004, 'x') })).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam(), mine.record, { doc: id, update: edit(theirs.client, 'x') })).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam(), mine.record, { doc: 'not a payload id!', update: edit(mine.client, 'x') })).toEqual({ ok: false, reason: 'malformed' });
    expect(readRecord(live, mine.record)!.ops.map((op) => op.doc)).toEqual(['body', id]);
    expect(held.getText('payload').toString(), 'ingest never writes the payload').not.toContain('p');
    // A resume hands back every doc's acknowledged clock.
    ingest.expireConnection('c-sam');
    const resumed = ingest.lease(sam('c-again'), [mine.client], 0);
    expect(resumed).toMatchObject({ ok: true, leases: [{ client: mine.client, clock: Y.parseUpdateMeta(body).to.get(mine.client), clocks: { body: Y.parseUpdateMeta(body).to.get(mine.client), [id]: 1 } }] });
  });

  it("a lease's first write to a payload doc that already holds its client id is refused", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const mine = leaseOne(ingest, sam());
    const [id, held] = [...payloadDocsFor(live).docs][0];
    /** `write` on a copy of the payload under the lease's id, applied before the id is set so Yjs keeps it. */
    const onCopy = (text: string) => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(held));
      doc.clientID = mine.client;
      const sv = Y.encodeStateVector(doc);
      doc.getText('payload').insert(0, text);
      return Y.encodeStateAsUpdate(doc, sv);
    };
    // The payload already holds structs under the lease's id (minting checks only the body).
    Y.applyUpdate(held, onCopy('old'));
    const update = onCopy('new');
    expect(Y.parseUpdateMeta(update).from.get(mine.client)).toBeGreaterThan(0);
    const fromZero = frame(new Y.Doc(), mine.client, (doc) => doc.getText('payload').insert(0, 'z'));
    expect(ingest.ops(sam(), mine.record, { doc: id, update: fromZero })).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam(), mine.record, { doc: id, update })).toEqual({ ok: false, reason: 'clock-gap' });
    expect(readRecord(live, mine.record)).toBeNull();
  });

  it('typing into a paragraph an editor deleted before the frame arrived is not refused at ingest (I6)', () => {
    const writes: [string, (block: Y.XmlText) => void][] = [
      ['a first character', (block) => block.insert(0, 'hi')],
      ['a first property', (block) => block.setAttribute('__indent', 1)],
    ];
    for (const [name, write] of writes) {
      const live = seededBody();
      const ingest = ingestOn(live);
      const { client, record } = leaseOne(ingest, sam());
      // An empty paragraph: the suggester's first struct in it names the paragraph as its explicit parent.
      append(live, paragraph(''));
      const root = live.get('root', Y.XmlText);
      const update = frame(live, client, (doc) => {
        const delta = doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[];
        write(delta.at(-1)!.insert as Y.XmlText);
      });
      // An editor deletes the paragraph first; the live doc collects it, leaving a ContentDeleted tombstone.
      root.delete(root.length - 1, 1);
      expect(ingest.ops(sam(), record, update), name).toMatchObject({ ok: true });
    }
  });

  it("a merged record's structs still place later ops: an off-table struct under a paragraph the merged record created is refused", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const a = leaseOne(ingest, sam());
    const b = leaseOne(ingest, sam());
    const fork = new Y.Doc();
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(live));
    // b's paragraph follows the note's last block, so ingest places it; a writes elsewhere.
    fork.clientID = b.client;
    let sv = Y.encodeStateVector(fork);
    append(fork, paragraph('from b'));
    expect(ingest.ops(sam(), b.record, Y.encodeStateAsUpdate(fork, sv))).toMatchObject({ ok: true });
    fork.clientID = a.client;
    sv = Y.encodeStateVector(fork);
    firstBlock(fork).insert(0, 'A ');
    expect(ingest.ops(sam(), a.record, Y.encodeStateAsUpdate(fork, sv))).toMatchObject({ ok: true });
    expect(ingest.merge(sam(), a.record, b.record)).toMatchObject({ ok: true, record: a.record });
    // A formatting mark inside b's paragraph: off the table, placed only through the merged record's own structs.
    fork.clientID = a.client;
    sv = Y.encodeStateVector(fork);
    const delta = fork.get('root', Y.XmlText).toDelta() as { insert: unknown }[];
    (delta.at(-1)!.insert as Y.XmlText).format(0, 2, { bold: true });
    expect(ingest.ops(sam(), a.record, Y.encodeStateAsUpdate(fork, sv))).toEqual({ ok: false, reason: 'channel' });
  });

  it("a closed record's placements are dropped, so open records alone hold them", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const grants = [leaseOne(ingest, sam()), leaseOne(ingest, sam())];
    for (const [i, grant] of grants.entries()) {
      expect(ingest.ops(sam(), grant.record, frame(live, grant.client, (doc) => append(doc, paragraph(`p${i}`))))).toMatchObject({ ok: true });
    }
    expect(ingest.placedRecords).toBe(2);
    expect(ingest.withdraw(sam(), grants[0].record)).toMatchObject({ ok: true });
    expect(rejectRecord(live, grants[1].record, EDITOR)).toEqual({ ok: true });
    expect(ingest.placedRecords).toBe(0);
    // Accept drops them too.
    const c = leaseOne(ingest, sam());
    const fork = new ForkShim(live, c.client);
    try {
      for (const op of fork.act(() => select('Hello', 24).insertText(' C'))) expect(ingest.ops(sam(), c.record, op)).toMatchObject({ ok: true });
    } finally {
      fork.dispose();
    }
    expect(ingest.placedRecords).toBe(1);
    expect(accept(live, c.record)).toEqual({ ok: true });
    expect(ingest.placedRecords).toBe(0);
  });

  it('overlapping_clocks_refused: an update starting below the acknowledged clock is refused, so a record never holds two versions of one id', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const { client, record } = leaseOne(ingest, sam());
    const fork = new Y.Doc();
    fork.clientID = client;
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(live));
    const base = Y.encodeStateVector(fork);
    append(fork, paragraph('first'));
    const first = Y.encodeStateAsUpdate(fork, base);
    expect(ingest.ops(sam(), record, first)).toMatchObject({ ok: true });
    // The same ids again, with other content, and a frame that starts inside them.
    const other = new Y.Doc();
    other.clientID = client;
    Y.applyUpdate(other, Y.encodeStateAsUpdate(live));
    append(other, paragraph('FORGED'));
    // Encoded against `live` now: it holds the record the first frame created, which `other` copied.
    expect(ingest.ops(sam(), record, Y.encodeStateAsUpdate(other, Y.encodeStateVector(live)))).toEqual({ ok: false, reason: 'clock-overlap' });
    append(fork, paragraph('second'));
    const inside = Y.decodeStateVector(Y.encodeStateVector(live));
    inside.set(client, 2);
    expect(ingest.ops(sam(), record, Y.encodeStateAsUpdate(fork, Y.encodeStateVector(inside)))).toEqual({ ok: false, reason: 'clock-overlap' });
    expect(readRecord(live, record)!.ops).toEqual([{ doc: 'body', update: first }]);
  });
});

describe('T5.2 record ids, continuations and delete targets @p:mean-2', () => {
  it('suggest-delete names only live body items no pending lease wrote, and derives the quote', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const { record } = leaseOne(ingest, sam());
    expect(ingest.delete(sam(), record, { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true, parts: ['d1'] });
    expect(readRecord(live, record)!.parts).toEqual([{ id: 'd1', kind: 'delete', targets: spansOfText(live, 'world'), quote: 'world' }]);
    const [first] = spansOfText(live, 'Hello');
    expect(ingest.delete(sam(), record, { id: 'd2', targets: [{ client: first.client, clock: 1e9, len: 1 }] })).toEqual({ ok: false, reason: 'target' });
    const titled = frame(live, 0x5eed0002, (doc) => doc.getText('title').insert(0, 'T'));
    Y.applyUpdate(live, titled);
    expect(ingest.delete(sam(), record, { id: 'd3', targets: [{ client: 0x5eed0002, clock: 0, len: 1 }] })).toEqual({ ok: false, reason: 'target' });
  });

  it('accepted_record_continuation_preserves_occupied_id: a continuation never takes an id another record holds, and long ids never collide', () => {
    const live = seededBody();
    const long = (tail: string) => `${'a'.repeat(48)}-${tail}`;
    const queue = [long('one'), long('two'), 'peer-record', 'peer-record', long('one'), long('two'), 'cont-1', 'peer-record', 'cont-2'];
    const ingest = ingestOn(live, { mintId: () => queue.shift() ?? crypto.randomUUID() });
    // Sam's two records share a 48-character prefix; Sky's open record holds the id minted next.
    const one = leaseOne(ingest, sam());
    const two = leaseOne(ingest, sam());
    const peer = leaseOne(ingest, sky());
    expect([one.record, two.record, peer.record]).toEqual([long('one'), long('two'), 'peer-record']);
    const forks = [new ForkShim(live, one.client), new ForkShim(live, two.client), new ForkShim(live, peer.client)];
    try {
      const steps = [() => select('Hello', 24).insertText(' One'), () => select('join tail', 0).insertText('Two '), () => select('Indented', 0).insertText('Peer ')];
      for (const [i, [who, grant]] of ([[sam(), one], [sam(), two], [sky(), peer]] as const).entries()) {
        for (const update of forks[i].act(steps[i])) expect(ingest.ops(who, grant.record, update)).toMatchObject({ ok: true, record: grant.record });
      }
      const peerBefore = readRecord(live, 'peer-record');
      expect(accept(live, one.record)).toEqual({ ok: true });
      expect(accept(live, two.record)).toEqual({ ok: true });
      // The minter offers taken ids first: they are skipped.
      const deleted = ingest.delete(sam(), one.record, { id: 'd1', targets: spansOfText(live, 'world') });
      const typed = forks[1].act(() => select('Two', 4).insertText('more ')).map((update) => ingest.ops(sam(), two.record, update));
      expect(deleted).toMatchObject({ ok: true, requested: one.record, record: 'cont-1' });
      expect(typed.length).toBeGreaterThan(0);
      for (const result of typed) expect(result).toMatchObject({ ok: true, requested: two.record, record: 'cont-2' });
      expect(readMeta(live, 'cont-1')).toMatchObject({ author: SUGGESTER.id, continues: one.record, status: 'open' });
      expect(readMeta(live, 'cont-2')).toMatchObject({ author: SUGGESTER.id, continues: two.record, status: 'open' });
      expect(readRecord(live, 'peer-record')).toEqual(peerBefore);
      expect(readMeta(live, 'peer-record')).toMatchObject({ author: OTHER_SUGGESTER.id, status: 'open' });
    } finally {
      for (const fork of forks) fork.dispose();
    }
  });

  it('accepted_suggestion_text_is_valid_body_delete_target: accepted text is ordinary body text; items under a pending lease stay refused', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const alice = leaseOne(ingest, sam());
    const pending = leaseOne(ingest, sam());
    const forks = [new ForkShim(live, alice.client), new ForkShim(live, pending.client)];
    try {
      for (const update of forks[0].act(() => select('Hello', 24).insertText(' Accepted'))) expect(ingest.ops(sam(), alice.record, update)).toMatchObject({ ok: true });
      const pendingUpdates = forks[1].act(() => select('join tail', 0).insertText('Pending '));
      for (const update of pendingUpdates) expect(ingest.ops(sam(), pending.record, update)).toMatchObject({ ok: true });
      expect(accept(live, alice.record)).toEqual({ ok: true });
      // Pending items reach the body only by accept; were they there under a live lease, they still are no target.
      for (const op of pendingUpdates) if (op.doc === 'body') Y.applyUpdate(live, op.update);
      const bob = leaseOne(ingest, sky());
      expect(ingest.delete(sky(), bob.record, { id: 'd1', targets: spansOfText(live, 'Accepted') })).toMatchObject({ ok: true, parts: ['d1'] });
      expect(ingest.delete(sky(), bob.record, { id: 'd2', targets: spansOfText(live, 'Pending') })).toEqual({ ok: false, reason: 'target' });
    } finally {
      for (const fork of forks) fork.dispose();
    }
  });

  it('a rejected record answers record-closed; withdraw writes only the record', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const a = leaseOne(ingest, sam());
    expect(ingest.ops(sam(), a.record, frame(live, a.client, (doc) => firstBlock(doc).insert(0, 'A ')))).toMatchObject({ ok: true });
    expect(rejectRecord(live, a.record, EDITOR)).toEqual({ ok: true });
    expect(ingest.ops(sam(), a.record, frame(live, a.client, (doc) => firstBlock(doc).insert(0, 'B ')))).toEqual({ ok: false, reason: 'record-closed' });
    const b = leaseOne(ingest, sam());
    expect(ingest.ops(sam(), b.record, frame(live, b.client, (doc) => firstBlock(doc).insert(0, 'C ')))).toMatchObject({ ok: true });
    const body = JSON.stringify(live.get('root', Y.XmlText).toJSON());
    expect(ingest.withdraw(sky(), b.record)).toEqual({ ok: false, reason: 'not-author' });
    expect(ingest.withdraw(sam(), b.record)).toMatchObject({ ok: true });
    expect(readRecord(live, b.record)).toMatchObject({ meta: { status: 'withdrawn', resolvedBy: SUGGESTER.id }, ops: [], parts: [] });
    expect(JSON.stringify(live.get('root', Y.XmlText).toJSON())).toBe(body);
  });

  it('merge moves ops, parts and leases into one record; undelete takes back a part', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const a = leaseOne(ingest, sam());
    const b = leaseOne(ingest, sam());
    const fork = new Y.Doc();
    fork.clientID = a.client;
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(live));
    let sv = Y.encodeStateVector(fork);
    firstBlock(fork).insert(0, 'A ');
    expect(ingest.ops(sam(), a.record, Y.encodeStateAsUpdate(fork, sv))).toMatchObject({ ok: true });
    fork.clientID = b.client;
    sv = Y.encodeStateVector(fork);
    firstBlock(fork).insert(2, 'B ');
    const second = Y.encodeStateAsUpdate(fork, sv);
    expect(ingest.ops(sam(), b.record, second)).toMatchObject({ ok: true });
    expect(ingest.delete(sam(), b.record, { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
    expect(ingest.merge(sam(), a.record, b.record)).toMatchObject({ ok: true, record: a.record });
    const merged = readRecord(live, a.record)!;
    expect(merged.ops).toHaveLength(2);
    expect(merged.parts.map((p) => p.id)).toEqual(['d1']);
    expect(merged.meta.clients.sort()).toEqual([a.client, b.client].sort());
    expect(readMeta(live, b.record)).toMatchObject({ status: 'withdrawn', mergedInto: a.record });
    // Frames for the merged record, and under its lease, land in the record it merged into.
    sv = Y.encodeStateVector(fork);
    firstBlock(fork).insert(4, 'more ');
    expect(ingest.ops(sam(), b.record, Y.encodeStateAsUpdate(fork, sv))).toMatchObject({ ok: true, record: a.record, requested: b.record });
    expect(ingest.undelete(sam(), a.record, 'd1')).toMatchObject({ ok: true });
    expect(readRecord(live, a.record)!.parts).toEqual([]);
    expect(ingest.undelete(sam(), a.record, 'd1')).toEqual({ ok: false, reason: 'target' });
  });

  it('caps: ops per record, open records per principal, all open ops, and the projected doc state', () => {
    const live = seededBody();
    const big = (client: number, size: number) => frame(live, client, (doc) => append(doc, paragraph('x'.repeat(size))));
    const capped = ingestOn(live);
    const one = leaseOne(capped, sam());
    expect(capped.ops(sam(), one.record, big(one.client, SUGGEST_CAPS.recordOpsBytes + 10))).toEqual({ ok: false, reason: 'record-cap' });

    const small = ingestOn(seededBody(), { stateCap: 400_000 });
    const s1 = leaseOne(small, sam());
    expect(small.ops(sam(), s1.record, big(s1.client, 120_000))).toEqual({ ok: false, reason: 'ops-cap' });

    const near = ingestOn(seededBody(), { stateBytes: () => STATE_CAP_BYTES - 100 });
    const n1 = leaseOne(near, sam());
    expect(near.ops(sam(), n1.record, big(n1.client, 1_000))).toEqual({ ok: false, reason: 'doc-cap' });

    const many = seededBody();
    const counted = ingestOn(many);
    for (let i = 0; i < SUGGEST_CAPS.openPerPrincipal; i += 1) {
      const grant = leaseOne(counted, sam(`c-${i}`));
      expect(counted.delete(sam(`c-${i}`), grant.record, { id: 'd', targets: spansOfText(many, 'world') })).toMatchObject({ ok: true });
      counted.expireConnection(`c-${i}`);
    }
    const last = leaseOne(counted, sam('c-last'));
    expect(counted.delete(sam('c-last'), last.record, { id: 'd', targets: spansOfText(many, 'world') })).toEqual({ ok: false, reason: 'open-cap' });
  });

  it('projected_state_cap_counts_the_record_write: the record and meta the server writes count, not only the op bytes', () => {
    const live = seededBody();
    let state = 0;
    const ingest = ingestOn(live, { stateBytes: () => state });
    const a = leaseOne(ingest, sam());
    const update = frame(live, a.client, (doc) => append(doc, paragraph('x')));
    // The op fits exactly; the record created around it does not.
    state = STATE_CAP_BYTES - update.byteLength;
    expect(ingest.ops(sam(), a.record, update)).toEqual({ ok: false, reason: 'doc-cap' });
    const targets = spansOfText(live, 'world');
    state = STATE_CAP_BYTES - 200;
    expect(ingest.delete(sam(), a.record, { id: 'd1', targets })).toEqual({ ok: false, reason: 'doc-cap' });
    // A merge copies the moved ops: it is projected too.
    state = 0;
    const b = leaseOne(ingest, sam());
    expect(ingest.ops(sam(), a.record, update)).toMatchObject({ ok: true });
    expect(ingest.ops(sam(), b.record, frame(live, b.client, (doc) => append(doc, paragraph('y'))))).toMatchObject({ ok: true });
    state = STATE_CAP_BYTES - 10;
    expect(ingest.merge(sam(), a.record, b.record)).toEqual({ ok: false, reason: 'doc-cap' });
    expect(readMeta(live, b.record)).toMatchObject({ status: 'open' });
  });
});

describe('T5.2 leases never run out in ordinary suggesting @p:mean-2', () => {
  it('lease_cap_counts_only_unused_leases: open records past the lease cap, then withdraw and reject cycles, on one connection', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const write = (grant: { client: number; record: string }, text: string) =>
      expect(ingest.ops(sam(), grant.record, frame(live, grant.client, (doc) => firstBlock(doc).insert(0, text))), text).toMatchObject({ ok: true });
    // Six suggestions open at once, each with its own lease, as the client starts a group after 30 s idle.
    for (let i = 0; i < 6; i += 1) write(leaseOne(ingest, sam()), `open-${i} `);
    // Then many suggestions closed one after another; none frees a slot it never held.
    for (let i = 0; i < 10; i += 1) {
      const grant = leaseOne(ingest, sam());
      write(grant, `cycle-${i} `);
      if (i % 2 === 0) expect(ingest.withdraw(sam(), grant.record)).toMatchObject({ ok: true });
      else expect(rejectRecord(live, grant.record, EDITOR)).toEqual({ ok: true });
    }
    // Unused leases are still capped: a client cannot hoard ids.
    const hoard = [ingest.lease(sam()), ingest.lease(sam()), ingest.lease(sam())];
    expect(hoard.at(-1)).toEqual({ ok: false, reason: 'lease-cap' });
  });

  it('delete_only_records_bind_their_lease: delete parts and struct-free ops, opened and closed on one connection, never hit lease-cap', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    for (let i = 0; i < 12; i += 1) {
      const grant = leaseOne(ingest, sam());
      const result = i % 3 === 2
        ? ingest.ops(sam(), grant.record, deleteUpdate(spansOfText(live, 'world')))
        : ingest.delete(sam(), grant.record, { id: `d${i}`, targets: spansOfText(live, 'world') });
      expect(result, `cycle ${i}`).toMatchObject({ ok: true, record: grant.record });
      if (i % 2 === 0) expect(ingest.withdraw(sam(), grant.record)).toMatchObject({ ok: true });
      else expect(rejectRecord(live, grant.record, EDITOR)).toEqual({ ok: true });
    }
    // The bound lease writes on into its record (an existing record id, not a fresh reservation).
    const open = leaseOne(ingest, sam());
    expect(ingest.delete(sam(), open.record, { id: 'a', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true, record: open.record });
    expect(ingest.ops(sam(), open.record, frame(live, open.client, (doc) => firstBlock(doc).insert(0, 'x')))).toMatchObject({ ok: true, record: open.record });
    expect([ingest.lease(sam()), ingest.lease(sam()), ingest.lease(sam())].at(-1)).toEqual({ ok: false, reason: 'lease-cap' });
  });

  it('a reserved id opens a record only from the connection its lease is bound to', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const grant = leaseOne(ingest, sam('c-one'));
    const part = { id: 'd', targets: spansOfText(live, 'world') };
    expect(ingest.delete(sam('c-two'), grant.record, part)).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(sam('c-two'), grant.record, deleteUpdate(spansOfText(live, 'world')))).toEqual({ ok: false, reason: 'lease' });
    ingest.expireConnection('c-one');
    expect(ingest.delete(sam('c-one'), grant.record, part)).toEqual({ ok: false, reason: 'lease' });
    // Resumed onto a new connection, it opens the record there.
    expect(ingest.lease(sam('c-two'), [grant.client], 0)).toMatchObject({ ok: true });
    expect(ingest.delete(sam('c-two'), grant.record, part)).toMatchObject({ ok: true, record: grant.record });
    expect(readMeta(live, grant.record)).toMatchObject({ status: 'open', author: SUGGESTER.id });
  });
});

/** A doc of `paragraphs` paragraphs: 3 000 make the 1.69 MB census doc. */
function docOf(paragraphs: number): Y.Doc {
  const doc = new Y.Doc();
  const body = doc.get('root', Y.XmlText);
  const line = 'lorem ipsum dolor sit amet '.repeat(20);
  doc.transact(() => {
    for (let i = 0; i < paragraphs; i++) {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'paragraph');
      block.insert(0, line);
      body.insertEmbed(body.length, block);
    }
  });
  return doc;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** A frame of many small structs, just under the per-record cap. */
function capFrame(live: Y.Doc, client: number): Uint8Array {
  return frame(live, client, (doc) => {
    const block = paragraph('');
    append(doc, block);
    doc.transact(() => {
      for (let i = 0; i < 20_000; i++) block.insert(0, 'x');
    });
  });
}

/** One delete part of the most spans a part may name, single characters across the doc's first paragraphs. */
function maxPart(live: Y.Doc): { id: string; targets: { client: number; clock: number; len: number }[] } {
  const targets: { client: number; clock: number; len: number }[] = [];
  const root = live.get('root', Y.XmlText);
  for (let block = root._start; block && targets.length < SUGGEST_CAPS.partSpans; block = block.right) {
    if (!(block.content instanceof Y.ContentType)) continue;
    for (let item = (block.content.type as Y.XmlText)._start; item && targets.length < SUGGEST_CAPS.partSpans; item = item.right) {
      if (item.content instanceof Y.ContentString && !item.deleted) {
        for (let i = 0; i < item.length && targets.length < SUGGEST_CAPS.partSpans; i += 2) targets.push({ client: item.id.client, clock: item.id.clock + i, len: 1 });
      }
    }
  }
  return { id: 'max', targets };
}

function measure(paragraphs: number) {
  const live = docOf(paragraphs);
  const bytes = Y.encodeStateAsUpdate(live).byteLength;
  let connection = 0;
  const ingest = ingestOn(live);
  const who = () => sam(`cost-${connection}`);
  const ops: number[] = [];
  const deletes: number[] = [];
  const part = maxPart(live);
  expect(part.targets).toHaveLength(SUGGEST_CAPS.partSpans);
  for (let run = 0; run < 5; run++) {
    connection += 1;
    const grant = leaseOne(ingest, who());
    const update = capFrame(live, grant.client);
    expect(update.byteLength).toBeLessThanOrEqual(SUGGEST_CAPS.recordOpsBytes);
    expect(update.byteLength).toBeGreaterThan(SUGGEST_CAPS.recordOpsBytes / 2);
    let started = performance.now();
    expect(ingest.ops(who(), grant.record, update)).toMatchObject({ ok: true });
    ops.push(performance.now() - started);
    const other = leaseOne(ingest, who());
    started = performance.now();
    expect(ingest.delete(who(), other.record, part)).toMatchObject({ ok: true });
    deletes.push(performance.now() - started);
    expect(ingest.withdraw(who(), grant.record)).toMatchObject({ ok: true });
    expect(ingest.withdraw(who(), other.record)).toMatchObject({ ok: true });
    ingest.expireConnection(who().connection);
  }
  const typing = frame(live, 0x5eed0003, (doc) => firstBlock(doc).insert(3, 'x'));
  connection += 1;
  const spare = leaseOne(ingest, who());
  const big = capFrame(live, spare.client);
  const lease: number[] = [];
  for (let run = 0; run < 25; run++) {
    const started = performance.now();
    expect(ingest.namesLease(typing)).toBe(false);
    expect(ingest.namesLease(big)).toBe(true);
    lease.push(performance.now() - started);
  }
  return { bytes, ops: median(ops), deletes: median(deletes), lease: median(lease) };
}

/**
 * A crafted frame of `n` one-character deleted structs under the root, its delete set as `n` separate one-clock
 * ranges (an honest encoder merges them): each struct's delete-set lookup is the channel check's hot path.
 */
function deletedRun(client: number, n: number): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  const rest = encoder.restEncoder;
  encoding.writeVarUint(rest, 1);
  encoding.writeVarUint(rest, n);
  encoder.writeClient(client);
  encoding.writeVarUint(rest, 0);
  for (let i = 0; i < n; i++) {
    const origin = i === 0 ? null : Y.createID(client, i - 1);
    new Y.Item(Y.createID(client, i), null, origin, null, null, (i === 0 ? 'root' : null) as never, null, new Y.ContentDeleted(1)).write(encoder, 0);
  }
  encoding.writeVarUint(rest, 1);
  encoding.writeVarUint(rest, client);
  encoding.writeVarUint(rest, n);
  for (let i = 0; i < n; i++) {
    encoding.writeVarUint(rest, i);
    encoding.writeVarUint(rest, 1);
  }
  return encoder.toUint8Array();
}

describe('T5.2 cost: ingest and the lease check are O(frame) @p:mean-2', () => {
  it('a frame of many deleted structs and as many delete ranges costs linear in its size (I5)', () => {
    const time = (n: number) => {
      const live = seededBody();
      const ingest = ingestOn(live);
      const runs: number[] = [];
      for (let run = 0; run < 3; run++) {
        const who = sam(`deleted-${n}-${run}`);
        const grant = leaseOne(ingest, who);
        const update = deletedRun(grant.client, n);
        expect(update.byteLength).toBeLessThanOrEqual(SUGGEST_CAPS.recordOpsBytes);
        const started = performance.now();
        const result = ingest.ops(who, grant.record, update);
        runs.push(performance.now() - started);
        expect(result).toMatchObject({ ok: true });
        expect(ingest.withdraw(who, grant.record)).toMatchObject({ ok: true });
        ingest.expireConnection(who.connection);
      }
      return median(runs);
    };
    time(2_000);
    const small = time(2_000);
    const large = time(16_000);
    console.log(`T5.Ps cost: ${small.toFixed(2)} ms for 2 000 deleted structs vs ${large.toFixed(2)} ms for 16 000`);
    // Linear is 8x; a per-struct scan of the delete set is 64x.
    expect(large).toBeLessThan(small * 12 + 40);
  });

  it('a frame at the cap, a delete part of the most spans, and the body-frame lease check cost the same on a small doc and the 1.69 MB doc', () => {
    measure(5);
    const small = measure(5);
    const large = measure(3_000);
    expect(large.bytes).toBeGreaterThan(1_600_000);
    console.log(
      `T5.2 cost: suggest-ops at the cap ${small.ops.toFixed(2)} ms (${small.bytes} B doc) vs ${large.ops.toFixed(2)} ms (${large.bytes} B doc); ` +
        `suggest-delete ${small.deletes.toFixed(2)} ms vs ${large.deletes.toFixed(2)} ms; lease check ${small.lease.toFixed(3)} ms vs ${large.lease.toFixed(3)} ms`,
    );
    expect(large.ops).toBeLessThan(small.ops * 3 + 5);
    expect(large.deletes).toBeLessThan(small.deletes * 3 + 5);
    expect(large.lease).toBeLessThan(small.lease * 3 + 1);
  });

  it('fixed_frame_ingest_cost_independent_of_closed_record_count_and_continuation_depth', () => {
    /** Ingest of one fixed `suggest-ops` frame after `closed` closed records, aimed at a chain `depth` accepts deep. */
    const run = (closed: number, depth: number): { first: number; median: number } => {
      const live = seededBody();
      // As in the DocDO: records are written under S, so a close drops S clocks.
      new SuggestionsWriter(live, newSuggestionsClient(live));
      let n = 0;
      const ingest = ingestOn(live);
      /** Each record gets its own connection's lease, expired once used, so the live-lease cap never bites. */
      const withLease = <T>(use: (who: Suggester, grant: { client: number; record: string }) => T): T => {
        const who = sam(`c-${(n += 1)}`);
        const result = use(who, leaseOne(ingest, who));
        ingest.expireConnection(who.connection);
        return result;
      };
      for (let i = 0; i < closed; i += 1) {
        withLease((who, grant) => {
          expect(ingest.delete(who, grant.record, { id: 'd', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
          expect(ingest.withdraw(who, grant.record)).toMatchObject({ ok: true });
        });
      }
      // A chain of `depth` accepted records, each a continuation of the one before.
      const first = withLease((who, grant) => {
        let head = grant.record;
        for (let i = 0; i < depth; i += 1) {
          const result = ingest.delete(who, head, { id: `d${i}`, targets: spansOfText(live, 'cat') });
          if (!result.ok) throw new Error(result.reason);
          head = result.record;
          acceptAsIs(live, head);
        }
        return grant.record;
      });
      const times: number[] = [];
      for (let i = 0; i < 9; i += 1) {
        withLease((who, grant) => {
          const update = frame(live, grant.client, (doc) => append(doc, paragraph('fixed frame of typing')));
          const started = performance.now();
          // Aimed at the chain's first record: it lands in a fresh continuation of the accepted head.
          const result = ingest.ops(who, first, update);
          times.push(performance.now() - started);
          if (!result.ok) throw new Error(result.reason);
          acceptAsIs(live, result.record);
        });
      }
      // The first frame walks the whole chain (as after a wake); later ones ride the compressed path.
      return { first: times[0], median: median(times) };
    };
    /** The first frame is a single sample, so a GC pause can swamp it: keep the best of three runs. */
    const best = (closed: number, depth: number): { first: number; median: number } => {
      const runs = [run(closed, depth), run(closed, depth), run(closed, depth)];
      return { first: Math.min(...runs.map((r) => r.first)), median: Math.min(...runs.map((r) => r.median)) };
    };
    run(5, 1);
    const few = best(5, 1);
    const many = best(3_000, 1);
    const deep = best(5, 2_000);
    console.log(
      `T5.2 fixed frame: ${few.median.toFixed(3)} ms (5 closed, depth 1); ${many.median.toFixed(3)} ms (3000 closed); ${deep.median.toFixed(3)} ms (depth 2000); ` +
        `first frame ${few.first.toFixed(3)} / ${many.first.toFixed(3)} / ${deep.first.toFixed(3)} ms`,
    );
    expect(many.median).toBeLessThan(few.median * 3 + 1);
    expect(deep.median).toBeLessThan(few.median * 3 + 1);
    expect(many.first).toBeLessThan(few.first * 3 + 5);
    expect(deep.first).toBeLessThan(few.first * 3 + 5);
  }, 30_000);
});

/** Closes `id` as accepted without landing it, as accept's last step does (the chain's cost is under test, not accept's). */
function acceptAsIs(live: Y.Doc, id: string): void {
  closeRecord(live, id, { status: 'accepted', resolvedBy: EDITOR.id, resolvedAt: 1 });
}

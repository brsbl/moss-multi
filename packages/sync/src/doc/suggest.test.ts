// Suggest-mode ingest is bookkeeping in O(frame) (docs/design/suggestions.md §3, §6): leases, server-minted record
// ids, `suggest-ops` checks, `suggest-delete` validation, continuations, merge, undelete and withdraw, and the cost
// of ingest and of the body-frame lease check, which grows with neither the doc nor its closed records.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { deleteUpdate, recordDigest } from '@moss-multi/core/suggest/apply';
import { closeRecord, readMeta, readRecord } from '../suggest/records.ts';
import { acceptRecord, nodeRegistry, previewRecord, rejectRecord } from '../suggest/review.ts';
import { EDITOR, OTHER_SUGGESTER, seededBody, spansOfText, SUGGESTER } from '../suggest/test-support.ts';
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
    expect(stored.ops).toEqual([update]);
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
    expect(ingest.ops(sam(), record, Y.encodeStateAsUpdate(other, base))).toEqual({ ok: false, reason: 'clock-overlap' });
    append(fork, paragraph('second'));
    const inside = Y.decodeStateVector(Y.encodeStateVector(live));
    inside.set(client, 2);
    expect(ingest.ops(sam(), record, Y.encodeStateAsUpdate(fork, Y.encodeStateVector(inside)))).toEqual({ ok: false, reason: 'clock-overlap' });
    expect(readRecord(live, record)!.ops).toEqual([first]);
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
    const queue = [long('one'), long('two'), 'peer-record', 'peer-record', long('one'), long('two'), 'cont-1', 'cont-2'];
    const ingest = ingestOn(live, { mintId: () => queue.shift() ?? crypto.randomUUID() });
    // Sam's two records share a 48-character prefix; Sky's open record holds the id minted next.
    const one = leaseOne(ingest, sam());
    const two = leaseOne(ingest, sam());
    const peer = leaseOne(ingest, sky());
    expect([one.record, two.record, peer.record]).toEqual([long('one'), long('two'), 'peer-record']);
    const insert = (client: number, text: string) => frame(live, client, (doc) => firstBlock(doc).insert(0, text));
    for (const [who, grant, text] of [[sam(), one, 'One '], [sam(), two, 'Two '], [sky(), peer, 'Peer ']] as const) {
      expect(ingest.ops(who, grant.record, insert(grant.client, text))).toMatchObject({ ok: true, record: grant.record });
    }
    const peerBefore = readRecord(live, 'peer-record');
    expect(accept(live, one.record)).toEqual({ ok: true });
    expect(accept(live, two.record)).toEqual({ ok: true });
    // The minter offers taken ids first: they are skipped.
    const deleted = ingest.delete(sam(), one.record, { id: 'd1', targets: spansOfText(live, 'world') });
    const typed = ingest.ops(sam(), two.record, frame(live, two.client, (doc) => {
      const block = firstBlock(doc);
      block.insert(block.length, '!');
    }));
    expect(deleted).toMatchObject({ ok: true, requested: one.record, record: 'cont-1' });
    expect(typed).toMatchObject({ ok: true, requested: two.record, record: 'cont-2' });
    expect(readMeta(live, 'cont-1')).toMatchObject({ author: SUGGESTER.id, continues: one.record, status: 'open' });
    expect(readMeta(live, 'cont-2')).toMatchObject({ author: SUGGESTER.id, continues: two.record, status: 'open' });
    expect(readRecord(live, 'peer-record')).toEqual(peerBefore);
    expect(readMeta(live, 'peer-record')).toMatchObject({ author: OTHER_SUGGESTER.id, status: 'open' });
  });

  it('accepted_suggestion_text_is_valid_body_delete_target: accepted text is ordinary body text; items under a pending lease stay refused', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const alice = leaseOne(ingest, sam());
    expect(ingest.ops(sam(), alice.record, frame(live, alice.client, (doc) => firstBlock(doc).insert(0, 'Accepted ')))).toMatchObject({ ok: true });
    const pending = leaseOne(ingest, sam());
    const pendingUpdate = frame(live, pending.client, (doc) => firstBlock(doc).insert(0, 'Pending '));
    expect(ingest.ops(sam(), pending.record, pendingUpdate)).toMatchObject({ ok: true });
    expect(accept(live, alice.record)).toEqual({ ok: true });
    // Pending items reach the body only by accept; were they there under a live lease, they still are no target.
    Y.applyUpdate(live, pendingUpdate);
    const bob = leaseOne(ingest, sky());
    expect(ingest.delete(sky(), bob.record, { id: 'd1', targets: spansOfText(live, 'Accepted') })).toMatchObject({ ok: true, parts: ['d1'] });
    expect(ingest.delete(sky(), bob.record, { id: 'd2', targets: spansOfText(live, 'Pending') })).toEqual({ ok: false, reason: 'target' });
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

describe('T5.2 cost: ingest and the lease check are O(frame) @p:mean-2', () => {
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
    const run = (closed: number, depth: number): number => {
      const live = seededBody();
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
      return median(times);
    };
    run(5, 1);
    const few = run(5, 1);
    const many = run(3_000, 1);
    const deep = run(5, 2_000);
    console.log(`T5.2 fixed frame: ${few.toFixed(3)} ms (5 closed, depth 1); ${many.toFixed(3)} ms (3000 closed); ${deep.toFixed(3)} ms (depth 2000)`);
    expect(many).toBeLessThan(few * 3 + 1);
    expect(deep).toBeLessThan(few * 3 + 1);
  });
});

/** Closes `id` as accepted without landing it, as accept's last step does (the chain's cost is under test, not accept's). */
function acceptAsIs(live: Y.Doc, id: string): void {
  closeRecord(live, id, { status: 'accepted', resolvedBy: EDITOR.id, resolvedAt: 1 });
}

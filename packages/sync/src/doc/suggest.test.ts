// T5.0 spike: suggest-mode ingest is bookkeeping in O(frame) (docs/design/suggestions.md §3, §6). Leases, the
// `suggest-ops` checks, `suggest-delete` validation, and test 8: the cost of ingest at the frame cap and of the
// body-frame lease check does not grow with the doc.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { readRecord } from '../suggest/records.ts';
import { nodeRegistry } from '../suggest/review.ts';
import { seededBody, spansOfText, SUGGESTER, OTHER_SUGGESTER } from '../suggest/test-support.ts';
import { SUGGEST_CAPS, SuggestIngest } from './suggest.ts';

const ingestOn = (doc: Y.Doc) => new SuggestIngest(doc, { stateCap: STATE_CAP_BYTES, registry: nodeRegistry() });

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

describe('T5.0 ingest: leases and suggest-ops @p:mean-2', () => {
  it('leases are exclusive and never in the body state vector', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const leased = [...ingest.lease(SUGGESTER.id), ...ingest.lease(OTHER_SUGGESTER.id), ...ingest.lease(SUGGESTER.id)];
    expect(new Set(leased).size).toBe(leased.length);
    const body = Y.decodeStateVector(Y.encodeStateVector(live));
    for (const client of leased) expect(body.has(client)).toBe(false);
  });

  it('a frame under a lease is appended to the record; the body is never written', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const [lease] = ingest.lease(SUGGESTER.id);
    const root = JSON.stringify(live.get('root', Y.XmlText).toJSON());
    const update = frame(live, lease, (doc) => append(doc, paragraph('mine')));
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', update)).toMatchObject({ ok: true, record: 'r1' });
    expect(JSON.stringify(live.get('root', Y.XmlText).toJSON())).toBe(root);
    const record = readRecord(live, 'r1')!;
    expect(record.ops).toEqual([update]);
    expect(record.meta).toMatchObject({ author: SUGGESTER.id, status: 'open', clients: [lease] });
  });

  it('refuses a client it did not lease to this principal, a clock gap, an unregistered node type and a role below suggester', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const [mine] = ingest.lease(SUGGESTER.id);
    const [theirs] = ingest.lease(OTHER_SUGGESTER.id);
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', frame(live, 0x5eed0001, (doc) => append(doc, paragraph('x'))))).toEqual({ ok: false, reason: 'lease' });
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', frame(live, theirs, (doc) => append(doc, paragraph('x'))))).toEqual({ ok: false, reason: 'lease' });
    const gapped = new Y.Doc();
    gapped.clientID = mine;
    Y.applyUpdate(gapped, Y.encodeStateAsUpdate(live));
    append(gapped, paragraph('first'));
    const after = Y.encodeStateVector(gapped);
    append(gapped, paragraph('second'));
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', Y.encodeStateAsUpdate(gapped, after))).toEqual({ ok: false, reason: 'clock-gap' });
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', frame(live, mine, (doc) => append(doc, paragraph('x', 'no-such-node'))))).toEqual({ ok: false, reason: 'node-type' });
    expect(ingest.ops(SUGGESTER, 'commenter', 'r1', frame(live, mine, (doc) => append(doc, paragraph('x'))))).toEqual({ ok: false, reason: 'role' });
  });

  it("another principal cannot write into someone's record", () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const [mine] = ingest.lease(SUGGESTER.id);
    const [theirs] = ingest.lease(OTHER_SUGGESTER.id);
    expect(ingest.ops(SUGGESTER, 'suggester', 'r1', frame(live, mine, (doc) => append(doc, paragraph('a'))))).toMatchObject({ ok: true });
    expect(ingest.ops(OTHER_SUGGESTER, 'suggester', 'r1', frame(live, theirs, (doc) => append(doc, paragraph('b'))))).toEqual({ ok: false, reason: 'not-author' });
  });

  it('suggest-delete names only live body items no lease wrote, and derives the quote', () => {
    const live = seededBody();
    const ingest = ingestOn(live);
    const [lease] = ingest.lease(SUGGESTER.id);
    expect(ingest.delete(SUGGESTER, 'suggester', 'r1', { id: 'd1', targets: spansOfText(live, 'world') })).toMatchObject({ ok: true });
    expect(readRecord(live, 'r1')!.parts).toEqual([{ id: 'd1', kind: 'delete', targets: spansOfText(live, 'world'), quote: 'world' }]);
    // Not live: a clock past the doc.
    const [first] = spansOfText(live, 'Hello');
    expect(ingest.delete(SUGGESTER, 'suggester', 'r1', { id: 'd2', targets: [{ client: first.client, clock: 1e9, len: 1 }] })).toEqual({ ok: false, reason: 'target' });
    // Outside the body: the title.
    const titled = frame(live, 0x5eed0002, (doc) => doc.getText('title').insert(0, 'T'));
    Y.applyUpdate(live, titled);
    expect(ingest.delete(SUGGESTER, 'suggester', 'r1', { id: 'd3', targets: [{ client: 0x5eed0002, clock: 0, len: 1 }] })).toEqual({ ok: false, reason: 'target' });
    void lease;
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

function measure(paragraphs: number) {
  const live = docOf(paragraphs);
  const ingest = ingestOn(live);
  const ops: number[] = [];
  for (let run = 0; run < 5; run++) {
    const [lease] = ingest.lease(SUGGESTER.id);
    const update = capFrame(live, lease);
    expect(update.byteLength).toBeLessThanOrEqual(SUGGEST_CAPS.recordOpsBytes);
    expect(update.byteLength).toBeGreaterThan(SUGGEST_CAPS.recordOpsBytes / 2);
    const started = performance.now();
    const result = ingest.ops(SUGGESTER, 'suggester', `cost-${run}`, update);
    ops.push(performance.now() - started);
    expect(result).toMatchObject({ ok: true });
  }
  const typing = frame(live, 0x5eed0003, (doc) => ((doc.get('root', Y.XmlText)._start!.content as Y.ContentType).type as Y.XmlText).insert(3, 'x'));
  const [spare] = ingest.lease(SUGGESTER.id);
  const big = capFrame(live, spare);
  const lease: number[] = [];
  for (let run = 0; run < 25; run++) {
    const started = performance.now();
    expect(ingest.namesLease(typing)).toBe(false);
    expect(ingest.namesLease(big)).toBe(true);
    lease.push(performance.now() - started);
  }
  return { bytes: Y.encodeStateAsUpdate(live).byteLength, ops: median(ops), lease: median(lease) };
}

describe('T5.0 cost: ingest and the lease check are O(frame) @p:mean-2', () => {
  it('a frame at the cap, and the body-frame lease check, cost the same on a small doc and the 1.69 MB doc', () => {
    measure(5);
    const small = measure(5);
    const large = measure(3_000);
    expect(large.bytes).toBeGreaterThan(1_600_000);
    console.log(
      `T5.0 cost: suggest-ops at the cap ${small.ops.toFixed(2)} ms (${small.bytes} B doc) vs ${large.ops.toFixed(2)} ms (${large.bytes} B doc); ` +
        `lease check ${small.lease.toFixed(3)} ms vs ${large.lease.toFixed(3)} ms`,
    );
    expect(large.ops).toBeLessThan(small.ops * 3 + 5);
    expect(large.lease).toBeLessThan(small.lease * 3 + 1);
  });
});

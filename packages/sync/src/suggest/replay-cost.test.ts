// T5.B4 (B281): replaying a record is linear in it. Delete-only ops that each name the record's own inserted structs
// are applied as one merged update per doc, so K such ops over N structs visit the structs about once, not K times;
// the preview, the accept, G5 and the record's digest read exactly as they did.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { deleteUpdate, recordDigest, type RecordOp } from '@moss-multi/core/suggest/apply';
import { readRecord } from './records.ts';
import { acceptRecord, previewRecord } from './review.ts';
import { deterministicIds, EDITOR, exported, forgeRecord, LEASED, opOn, seededBody, spansOfText } from './test-support.ts';

let restore: () => void = () => {};
beforeEach(() => {
  restore = deterministicIds();
});
afterEach(() => restore());

const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
const blocks = (doc: Y.Doc) => (root(doc).toDelta() as { insert: unknown }[]).map((op) => op.insert);
const paragraph = (doc: Y.Doc) => blocks(doc).find((x) => x instanceof Y.XmlText) as Y.XmlText;

/** Reads of `Item.deleted`: every struct a delete set walks is read once per walk. */
function countVisits<T>(run: () => T): { visits: number; result: T } {
  const proto = Y.Item.prototype as unknown as object;
  const own = Object.getOwnPropertyDescriptor(proto, 'deleted')!;
  let visits = 0;
  Object.defineProperty(proto, 'deleted', {
    ...own,
    get(this: Y.Item) {
      visits += 1;
      return own.get!.call(this);
    },
  });
  try {
    const result = run();
    return { visits, result };
  } finally {
    Object.defineProperty(proto, 'deleted', own);
  }
}

/**
 * `n` single characters typed one by one right after the first paragraph's text-node map (each its own struct), then
 * `k` delete-only ops each naming all of them, then a visible insert, so the preview has a hunk.
 */
function record(n: number, k: number): { live: Y.Doc; ops: RecordOp[] } {
  const live = seededBody();
  const inserted = opOn(live, 'body', (copy) => {
    for (let i = 0; i < n; i++) paragraph(copy).insert(1, 'q');
  });
  const span = { client: LEASED, clock: 0, len: n };
  const deletes: RecordOp[] = Array.from({ length: k }, () => ({ doc: 'body', update: deleteUpdate([span]) }));
  const copy = new Y.Doc({ gc: false });
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
  Y.applyUpdate(copy, inserted.update);
  for (const op of deletes) Y.applyUpdate(copy, op.update);
  const visible = opOn(copy, 'body', (doc) => paragraph(doc).insert(1, 'Kept. '));
  copy.destroy();
  return { live, ops: [inserted, ...deletes, visible] };
}

describe('T5.B4 a record replays in time linear in it @p:mean-2 @p:R17', () => {
  it('K delete-only ops over N own inserted structs: struct visits grow near-linearly as K and N double', () => {
    const measure = (n: number, k: number) => {
      const { live, ops } = record(n, k);
      forgeRecord(live, 'g', ops);
      const { visits, result } = countVisits(() => previewRecord(live, 'g'));
      expect(result, `the preview at n=${n}, k=${k}`).toMatchObject({ ok: true });
      return visits;
    };
    const small = measure(600, 150);
    const large = measure(1200, 300);
    // Quadratic replay reads K × N structs: four times as many when both double.
    expect(large, `struct visits: ${small} at 600 × 150, ${large} at 1200 × 300`).toBeLessThanOrEqual(2.6 * small);
  }, 120_000);

  it('the preview, the accept and the digest read exactly as the same ops with their deletes in one op', () => {
    const merge = (ops: RecordOp[]): RecordOp[] => [ops[0], { doc: 'body', update: deleteUpdate([{ client: LEASED, clock: 0, len: 200 }]) }, ops.at(-1)!];
    const { live, ops } = record(200, 40);
    forgeRecord(live, 'g', ops);
    forgeRecord(live, 'h', merge(ops));
    const preview = previewRecord(live, 'g');
    const expected = previewRecord(live, 'h');
    if (!preview.ok || !expected.ok) throw new Error(`refused: ${JSON.stringify([preview, expected])}`);
    expect(preview.hash).toBe(expected.hash);
    expect(preview.hunks).toEqual(expected.hunks);
    // The digest is over the stored op bytes, one entry per op, unchanged by the replay.
    const stored = readRecord(live, 'g')!;
    expect(stored.ops).toHaveLength(ops.length);
    expect(stored.ops.map((op) => op.update)).toEqual(ops.map((op) => op.update));
    expect(preview.digest).toBe(recordDigest(stored));
    expect(acceptRecord(live, 'g', { previewHash: preview.hash, digest: preview.digest }, EDITOR)).toEqual({ ok: true });
    const twin = record(200, 40);
    forgeRecord(twin.live, 'h', merge(twin.ops));
    const accepted = previewRecord(twin.live, 'h');
    if (!accepted.ok) throw new Error(accepted.reason);
    expect(acceptRecord(twin.live, 'h', { previewHash: accepted.hash, digest: accepted.digest }, EDITOR)).toEqual({ ok: true });
    expect(exported(live)).toBe(exported(twin.live));
    expect(exported(live)).toContain('Kept. Hello world');
  });

  it('G5 still refuses repeated delete-only ops over text an editor already removed, and G1 a gap between ops', () => {
    const live = seededBody();
    const targets = spansOfText(live, 'cat');
    const stale: RecordOp[] = Array.from({ length: 8 }, () => ({ doc: 'body', update: deleteUpdate(targets) }));
    paragraph(live).delete(1 + 'Hello world and the '.length, 3);
    forgeRecord(live, 'g', stale);
    expect(previewRecord(live, 'g')).toEqual({ ok: false, reason: 'outdated' });

    const body = seededBody();
    const copy = new Y.Doc({ gc: false });
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(body));
    copy.clientID = LEASED;
    const steps: Uint8Array[] = [];
    copy.on('update', (update: Uint8Array) => steps.push(update));
    for (const word of ['one ', 'two ', 'three ']) paragraph(copy).insert(1, word);
    copy.destroy();
    // The middle step is missing: the third parks, in a record of several ops as in a record of one.
    forgeRecord(body, 'gap', [{ doc: 'body', update: steps[0] }, { doc: 'body', update: steps[2] }]);
    expect(previewRecord(body, 'gap')).toEqual({ ok: false, reason: 'unresolvable' });
  });
});

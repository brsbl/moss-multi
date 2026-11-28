// T5.S4 checker P1: the running count of retained suggestion state must never fall below what the doc and the lease
// rows hold (a delete and undelete loop credited more than it charged, so the share stopped bounding anything), and
// must not run far above it either (non-ASCII text was credited by UTF-16 length, locking suggesters out early).
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { IdSpan } from '@moss-multi/protocol/suggest';
import { newSuggestionsClient, suggestionStateBytes, SuggestionsWriter } from '../suggest/records.ts';
import { nodeRegistry } from '../suggest/review.ts';
import { seededBody, spansOfText, SUGGESTER } from '../suggest/test-support.ts';
import { MemoryLeases, SuggestIngest, type Suggester } from './suggest.ts';

/** What one fresh lease row holds, as the share charges it: a fixed row plus `{}`. */
const FRESH_LEASE = 130;

const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;

function setup() {
  const live = seededBody();
  // As in the DocDO: records are written under S, so the measure reads S's structs.
  new SuggestionsWriter(live, newSuggestionsClient(live));
  const ingest = new SuggestIngest(live, { stateCap: 27 * 1024 * 1024, registry: nodeRegistry(), leases: new MemoryLeases() });
  let minted = 0;
  const lease = (who: Suggester) => {
    const leased = ingest.lease(who, [], 1);
    if (!leased.ok) throw new Error(leased.reason);
    minted += leased.leases.length;
    return leased.leases[0];
  };
  /** What the doc and the lease rows hold now, measured independently of the running count. */
  const held = () => suggestionStateBytes(live) + minted * FRESH_LEASE;
  return { live, ingest, lease, held };
}

describe('T5.S4 the retained-state count stays a bound between measures @p:mean-2', () => {
  it('delete and undelete of a 1,024-span part on one open record never takes the count below what is held', () => {
    const { live, ingest, lease, held } = setup();
    // 1,100 one-character spans of body text.
    const start = Y.getState(live.store, live.clientID);
    firstBlock(live).insert(0, 'y'.repeat(1100));
    const targets: IdSpan[] = Array.from({ length: 1024 }, (_, i) => ({ client: live.clientID, clock: start + i, len: 1 }));
    const who: Suggester = { ...SUGGESTER, role: 'suggester', connection: 'c-loop' };
    const { record } = lease(who);
    for (let i = 0; i < 20; i += 1) {
      expect(ingest.delete(who, record, { id: `d${i}`, targets })).toMatchObject({ ok: true });
      expect(ingest.retainedBytes, `after delete ${i}`).toBeGreaterThanOrEqual(held());
      expect(ingest.undelete(who, record, `d${i}`)).toMatchObject({ ok: true });
      expect(ingest.retainedBytes, `after undelete ${i}`).toBeGreaterThanOrEqual(held());
    }
    expect(ingest.retainedBytes).toBeGreaterThan(0);
  });

  it('records written and withdrawn under a long non-ASCII name keep the count close to what is held', () => {
    const { live, ingest, lease, held } = setup();
    const world = spansOfText(live, 'world');
    const name = '山田さくら🌸'.repeat(60);
    const cycles = 30;
    for (let i = 0; i < cycles; i += 1) {
      const who: Suggester = { ...SUGGESTER, name, role: 'suggester', connection: `c-${i}` };
      const { record } = lease(who);
      expect(ingest.delete(who, record, { id: `d${i}`, targets: world })).toMatchObject({ ok: true });
      expect(ingest.withdraw(who, record)).toMatchObject({ ok: true });
      ingest.expireConnection(who.connection);
      expect(ingest.retainedBytes, `cycle ${i}`).toBeGreaterThanOrEqual(held());
    }
    // Each cycle's two writes may overcount by their update headers, never by the name's bytes.
    expect((ingest.retainedBytes - held()) / cycles, 'overcount per cycle').toBeLessThan(300);
  });
});

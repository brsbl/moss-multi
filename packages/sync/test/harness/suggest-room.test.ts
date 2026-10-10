// T5.S4 (whole-repo Slop Cop P1): all retained suggestion state (closed records' metadata, close and merge overhead,
// leases) counts against a bounded share of the state cap, with a reserve kept for body and payload edits. A suggester
// looping create-and-withdraw of tiny records through the doc socket, across compaction and wake, is stopped before
// the reserve, editors keep writing, and the bell hears of each author once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CUSTOM_PREFIX, encodePayloadFrame, PAYLOAD_UPDATE, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { readMeta } from '../../src/suggest/records.ts';
import { SEED, SUGGESTER } from '../../src/suggest/test-support.ts';
import { connect, openDoc, start, wake, type Opened, type TestClient, type Who } from './do-harness.ts';

const CAP = 256 * 1024;

class SmallDoc extends DocDO {
  static override limits = { ...DocDO.limits, stateCapBytes: CAP };
}

const notices: { author: string; record: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  notices.length = 0;
  DocDO.suggestionNotices = () => async (notice) => {
    notices.push({ author: notice.author, record: notice.record });
  };
});
afterEach(() => {
  DocDO.suggestionNotices = () => null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

const SAM: Who = { id: SUGGESTER.id, name: 'Sam Suggester', role: 'suggester' };
const ED: Who = { id: 'editor-room@example.invalid', name: 'Ed Editor', role: 'editor' };

const isReply = (event: ServerEvent): event is SuggestReply => event.t.startsWith('suggest-');

async function send(client: TestClient, request: SuggestRequest): Promise<SuggestReply> {
  const before = client.events.length;
  await client.deliver(`${CUSTOM_PREFIX}${JSON.stringify(request)}`);
  await client.pump();
  const reply = client.events.slice(before).find(isReply);
  expect(reply, `a reply to ${request.t}`).toBeDefined();
  return reply!;
}

async function on(opened: Opened, who: Who): Promise<TestClient> {
  const client = await connect(opened, who);
  await client.hello();
  return client;
}

const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;

/** A tiny insert under `client` (or an empty update), as a fork transaction's. */
function tiny(server: Y.Doc, client: number, empty: boolean): Uint8Array {
  if (empty) return Y.encodeStateAsUpdate(new Y.Doc());
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  doc.clientID = client;
  const sv = Y.encodeStateVector(doc);
  firstBlock(doc).insert(0, 'x');
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return update;
}

const stateBytes = (opened: Opened) => Y.encodeStateAsUpdate(opened.dobj.document).byteLength;

describe('T5.S4 retained suggestion state has a bounded share and leaves editors room @p:mean-2', () => {
  it('create-and-withdraw of tiny records across compaction and wake stops before the reserve; editors still write; notices stay bounded', { timeout: 120_000 }, async () => {
    let opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    const ed = await on(opened, ED);
    let frames = 0;
    const pace = async () => {
      frames += 1;
      if (frames % 100 === 0) await vi.advanceTimersByTimeAsync(SUGGEST_LIMITS.refusals.windowMs / 10);
    };
    /** Lease, one tiny (or empty) op, withdraw, until a refusal; compacts every 25 cycles, `onCycle` after each. */
    const loop = async (client: TestClient, onCycle: (cycles: number) => Promise<void> = async () => {}) => {
      let cycles = 0;
      for (let round = 0; round < 2_000; round += 1) {
        const leased = await send(client, { t: 'suggest-lease' });
        if (leased.t !== 'suggest-leased') return { cycles, stopped: leased };
        for (const grant of leased.leases as LeaseGrant[]) {
          const ops = await send(client, { t: 'suggest-ops', record: grant.record, update: bytesToBase64(tiny(opened.dobj.document, grant.client, cycles % 3 === 2)) });
          await pace();
          if (ops.t !== 'suggest-ack') return { cycles, stopped: ops };
          expect(await send(client, { t: 'suggest-withdraw', record: ops.record })).toMatchObject({ t: 'suggest-ack' });
          await pace();
          expect(readMeta(opened.dobj.document, ops.record)?.status).toBe('withdrawn');
          cycles += 1;
          if (cycles % 25 === 0) await opened.dobj.onSave();
          await onCycle(cycles);
        }
      }
      return { cycles, stopped: null };
    };
    const { cycles, stopped } = await loop(sam, async (n) => {
      // One eviction midway: the accounting is rebuilt from what the DO stores.
      if (n !== 60) return;
      opened = await start(wake(opened));
      sam.opened = opened;
      ed.opened = opened;
    });
    expect(cycles, 'the loop crossed a compaction and a wake').toBeGreaterThan(60);
    expect(stopped, 'suggestion admission stopped').toMatchObject({ t: 'suggest-refused', reason: 'doc-cap' });
    expect(stateBytes(opened), 'stopped before the reserve').toBeLessThanOrEqual(CAP * SUGGEST_LIMITS.reserveShare);

    // Editors keep a bounded body edit and a bounded payload edit.
    const body = 'e'.repeat(Math.floor(CAP * 0.08));
    firstBlock(ed.doc).insert(0, body);
    await ed.flush();
    expect(ed.events.filter((event) => event.t === 'write-refused'), 'the body edit is not refused').toEqual([]);
    expect(firstBlock(opened.dobj.document).toString()).toContain(body);
    const payload = new Y.Doc();
    payload.getText('payload').insert(0, 'p'.repeat(Math.floor(CAP * 0.04)));
    await ed.deliver(encodePayloadFrame('room-payload', PAYLOAD_UPDATE, Y.encodeStateAsUpdate(payload)));
    await ed.pump();
    expect(ed.events.filter((event) => event.t === 'write-refused'), 'the payload edit is not refused').toEqual([]);
    expect(ed.closed).toBeNull();

    // The bell hears of the author once, however many records they opened.
    expect(notices.filter((notice) => notice.author === SAM.id).length, 'notices per author').toBeLessThanOrEqual(1);

    // After another wake the accounting is rebuilt, not reset: a fresh connection is stopped again within a few cycles.
    opened = await start(wake(opened));
    sam.opened = opened;
    ed.opened = opened;
    await sam.drop();
    const again = await on(opened, SAM);
    const after = await loop(again);
    expect(after.stopped, 'still stopped after the wake').toMatchObject({ t: 'suggest-refused', reason: 'doc-cap' });
    expect(after.cycles, 'at most a sliver more than before the wake').toBeLessThanOrEqual(Math.ceil(cycles / 10));
    expect(stateBytes(opened), 'still short of the reserve').toBeLessThanOrEqual(CAP * SUGGEST_LIMITS.reserveShare);
    expect(notices.filter((notice) => notice.author === SAM.id).length, 'notices per author, across the wakes').toBeLessThanOrEqual(1);
  });

  it('leases count too: reconnecting to mint fresh leases is refused before the share fills', { timeout: 120_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    let refused: SuggestReply | null = null;
    let minted = 0;
    for (let i = 0; i < 4_000 && !refused; i += 1) {
      const sam = await on(opened, SAM);
      const reply = await send(sam, { t: 'suggest-lease' });
      if (reply.t === 'suggest-leased') minted += reply.leases.length;
      else refused = reply;
      await sam.drop();
      if (i % 200 === 199) await opened.dobj.onSave();
    }
    expect(refused, 'lease minting stopped').toMatchObject({ t: 'suggest-refused', reason: 'doc-cap' });
    expect(minted, 'leases are bounded by the share').toBeLessThan(4_000);
  });
});

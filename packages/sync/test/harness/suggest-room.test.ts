// T5.S4 (whole-repo Slop Cop P1): all retained suggestion state (closed records' metadata, close and merge overhead,
// leases) counts against a bounded share of the state cap, with a reserve kept for body and payload edits. A suggester
// looping create-and-withdraw of tiny records through the doc socket, across compaction and wake, is stopped before
// the reserve, editors keep writing, and the bell hears of each author once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import { WRITE_RATE } from '@moss-multi/protocol/limits';
import { bytesToBase64, CLOSE, CUSTOM_PREFIX, encodePayloadFrame, PAYLOAD_UPDATE, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { SuggestIngest } from '../../src/doc/suggest.ts';
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

  it('delete and undelete cycles of 1,024 one-character spans do not reopen the share: lease minting still stops at it', { timeout: 120_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const ed = await on(opened, ED);
    const from = Y.getState(ed.doc.store, ed.doc.clientID);
    firstBlock(ed.doc).insert(0, 'y'.repeat(1100));
    await ed.flush();
    const targets = Array.from({ length: SUGGEST_LIMITS.partSpans }, (_, i) => ({ client: ed.doc.clientID, clock: from + i, len: 1 }));
    const sam = await on(opened, SAM);
    const leased = await send(sam, { t: 'suggest-lease' });
    expect(leased.t).toBe('suggest-leased');
    const record = (leased as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0].record;
    for (let i = 0; i < 12; i += 1) {
      expect(await send(sam, { t: 'suggest-delete', record, part: { id: `d${i}`, targets } }), `delete ${i}`).toMatchObject({ t: 'suggest-ack' });
      expect(await send(sam, { t: 'suggest-undelete', record, partId: `d${i}` }), `undelete ${i}`).toMatchObject({ t: 'suggest-ack' });
      await opened.dobj.onSave();
    }
    let refused: SuggestReply | null = null;
    let minted = 0;
    for (let i = 0; i < 4_000 && !refused; i += 1) {
      const again = await on(opened, SAM);
      const reply = await send(again, { t: 'suggest-lease' });
      if (reply.t === 'suggest-leased') minted += reply.leases.length;
      else refused = reply;
      await again.drop();
    }
    expect(refused, 'lease minting stopped').toMatchObject({ t: 'suggest-refused', reason: 'doc-cap' });
    // A lease row is charged at least 130 bytes against a share of 0.4 of the cap.
    expect(minted, 'leases are bounded by the share').toBeLessThanOrEqual(Math.floor((CAP * SUGGEST_LIMITS.stateShare) / 130));
  });

  it('a burst of suggest frames in flight on a full note, and reloads, are refused for room without the refusal cooldown', { timeout: 60_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    const leased = await send(sam, { t: 'suggest-lease' });
    expect(leased.t).toBe('suggest-leased');
    const grant = (leased as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0];
    // Editors fill the note past the reserve kept for them.
    const ed = await on(opened, ED);
    firstBlock(ed.doc).insert(0, 'f'.repeat(Math.ceil(CAP * (SUGGEST_LIMITS.reserveShare + 0.03))));
    await ed.flush();
    expect(ed.events.filter((event) => event.t === 'write-refused')).toEqual([]);
    // Fast typing: three keystrokes in flight, each an op and the merge into the active record that follows it.
    const before = sam.events.length;
    for (let i = 0; i < 3; i += 1) {
      await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-ops', record: grant.record, update: bytesToBase64(tiny(opened.dobj.document, grant.client, false)) })}`);
      await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-merge', into: grant.record, from: 'older-record' })}`);
    }
    // The rebuilt fork asks for a lease, twice (the mode toggled).
    await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-lease' })}`);
    await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-lease' })}`);
    await sam.pump();
    expect(sam.closed, 'the suggester stays connected').toBeNull();
    const replies = sam.events.slice(before).filter(isReply);
    expect(replies.map((reply) => reply.t === 'suggest-refused' && reply.reason), 'every frame refused for room').toEqual(Array(8).fill('doc-cap'));
    // Reloads: each new socket's lease is refused for room, and none of it cools the suggester down.
    for (let i = 0; i < 3; i += 1) {
      const reload = await on(opened, SAM);
      expect(await send(reload, { t: 'suggest-lease' }), `reload ${i}`).toMatchObject({ t: 'suggest-refused', reason: 'doc-cap' });
      expect(reload.closed, `reload ${i} stays connected`).toBeNull();
    }
    expect(sam.closed).toBeNull();
    // The editor still writes.
    firstBlock(ed.doc).insert(0, 'Ada adds a line.');
    await ed.flush();
    expect(ed.events.filter((event) => event.t === 'write-refused')).toEqual([]);
    expect(firstBlock(opened.dobj.document).toString()).toContain('Ada adds a line.');
  });
});

/** An insert of `n` characters under `client`, as a fork transaction's. */
function sized(server: Y.Doc, client: number, n: number): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  doc.clientID = client;
  const sv = Y.encodeStateVector(doc);
  firstBlock(doc).insert(0, 'z'.repeat(n));
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return bytesToBase64(update);
}

const frame = (request: unknown) => `${CUSTOM_PREFIX}${JSON.stringify(request)}`;

describe('T5.S12 no suggest refusal escapes the cooldown except the cheap no-room short-circuit @p:mean-2', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a burst of suggest-lease frames on a full note does no admission work and is charged to the write rate', { timeout: 60_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const ed = await on(opened, ED);
    firstBlock(ed.doc).insert(0, 'f'.repeat(Math.ceil(CAP * (SUGGEST_LIMITS.reserveShare + 0.03))));
    await ed.flush();
    const sam = await on(opened, SAM);
    const lease = vi.spyOn(SuggestIngest.prototype, 'lease');
    for (let i = 0; i <= WRITE_RATE.max + 20; i += 1) await sam.deliver(frame({ t: 'suggest-lease' }));
    await sam.pump();
    expect(lease.mock.calls.length, 'lease admission runs a bounded number of times').toBeLessThanOrEqual(SUGGEST_LIMITS.refusals.max);
    expect(sam.closed?.code, 'the burst trips the write rate').toBe(CLOSE.writeRate);
  });

  it('after a no-room refusal every growth frame short-circuits, and no-room refusals from admission are counted', { timeout: 60_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const big = Math.ceil(CAP * SUGGEST_LIMITS.openOpsShare) + 1024;
    /** A fresh socket: a granted lease, then an op too large for the open-ops share. */
    const overflow = async () => {
      const client = await on(opened, SAM);
      const leased = await send(client, { t: 'suggest-lease' });
      expect(leased.t).toBe('suggest-leased');
      const grant = (leased as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0];
      expect(await send(client, { t: 'suggest-ops', record: grant.record, update: sized(opened.dobj.document, grant.client, big) })).toMatchObject({ t: 'suggest-refused', reason: 'ops-cap' });
      return { client, grant };
    };
    const { client: sam, grant } = await overflow();
    const spies = (['lease', 'ops', 'delete', 'undelete', 'merge'] as const).map((name) => vi.spyOn(SuggestIngest.prototype, name));
    const before = sam.events.length;
    const growth = [
      { t: 'suggest-lease' },
      { t: 'suggest-ops', record: grant.record, update: sized(opened.dobj.document, grant.client, 1) },
      { t: 'suggest-delete', record: grant.record, part: { id: 'd0', targets: [] } },
      { t: 'suggest-undelete', record: grant.record, partId: 'd0' },
      { t: 'suggest-merge', into: grant.record, from: 'older-record' },
    ];
    for (let i = 0; i < 4; i += 1) for (const request of growth) await sam.deliver(frame(request));
    await sam.pump();
    expect(spies.map((spy) => spy.mock.calls.length), 'no admission work in the no-room state').toEqual([0, 0, 0, 0, 0]);
    expect(sam.events.slice(before).filter(isReply).map((reply) => reply.t === 'suggest-refused' && reply.reason)).toEqual(Array(growth.length * 4).fill('doc-cap'));
    expect(sam.closed, 'short-circuited frames are not counted').toBeNull();
    vi.restoreAllMocks();
    // Each refusal admission returns is counted, room or not: the third in the window cools the principal down.
    // The second socket closes, so its leases expire and the third is granted fresh ones.
    await (await overflow()).client.drop();
    const third = await on(opened, SAM);
    const leased = await send(third, { t: 'suggest-lease' });
    const lease = (leased as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0];
    await send(third, { t: 'suggest-ops', record: lease.record, update: sized(opened.dobj.document, lease.client, big) });
    expect(third.closed?.code).toBe(CLOSE.connectionLimit);
    expect(sam.closed?.code).toBe(CLOSE.connectionLimit);
  });

  it('repeated malformed or forbidden frames still trip the cooldown', { timeout: 60_000 }, async () => {
    const opened = await start(openDoc(undefined, SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    await sam.deliver(frame({ t: 'suggest-bogus' }));
    await sam.deliver(frame({ t: 'suggest-withdraw', record: 'not-a-record' }));
    await sam.deliver(frame({ t: 'suggest-ops', record: 'not-a-record', update: 7 }));
    await sam.pump();
    expect(sam.closed?.code).toBe(CLOSE.connectionLimit);
  });
});

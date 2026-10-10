// T5.S5 (whole-repo Slop Cop P2): unbound lease reservations stay bounded per principal. Leasing, sending nothing
// and reconnecting, across wakes, retires the principal's oldest dormant reservations instead of keeping rows without
// end; an issued id is never handed out again, and live() reads only live rows through a partial covering index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CUSTOM_PREFIX, type ServerEvent } from '@moss-multi/protocol/sync';
import { LIVE_LEASES_SQL } from '../../src/doc/suggest.ts';
import { SEED, SUGGESTER } from '../../src/suggest/test-support.ts';
import { connect, openDoc, start, wake, type Opened, type TestClient, type Who } from './do-harness.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const SAM: Who = { id: SUGGESTER.id, name: 'Sam Suggester', role: 'suggester' };
/** What a principal may retain in unbound reservations: a few windows' worth beyond the live cap. */
const BOUND = 4 * SUGGEST_LIMITS.liveLeases;

const isReply = (event: ServerEvent): event is SuggestReply => event.t.startsWith('suggest-');

async function send(client: TestClient, request: SuggestRequest): Promise<SuggestReply> {
  const before = client.events.length;
  await client.deliver(`${CUSTOM_PREFIX}${JSON.stringify(request)}`);
  await client.pump();
  const reply = client.events.slice(before).find(isReply);
  expect(reply, `a reply to ${request.t}`).toBeDefined();
  return reply!;
}

async function lease(client: TestClient, request: Partial<Extract<SuggestRequest, { t: 'suggest-lease' }>> = {}): Promise<LeaseGrant[]> {
  const reply = await send(client, { t: 'suggest-lease', ...request });
  expect(reply.t, JSON.stringify(reply)).toBe('suggest-leased');
  return (reply as Extract<SuggestReply, { t: 'suggest-leased' }>).leases;
}

async function on(opened: Opened, who: Who): Promise<TestClient> {
  const client = await connect(opened, who);
  await client.hello();
  return client;
}

const rows = (opened: Opened, principal: string) =>
  Number(opened.backing.query<{ n: number }>('SELECT COUNT(*) AS n FROM suggest_leases WHERE principal_id = ?', principal)[0].n);

const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;

function tiny(server: Y.Doc, client: number): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  doc.clientID = client;
  const sv = Y.encodeStateVector(doc);
  firstBlock(doc).insert(0, 'x');
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return update;
}

describe('T5.S5 unbound lease reservations are bounded per principal @p:mean-2', () => {
  it('lease, close and wake in a loop: the row count stays bounded, no id is issued twice, and a fresh lease writes', { timeout: 120_000 }, async () => {
    let opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const seen = new Set<number>();
    const records = new Set<string>();
    let issued = 0;
    for (let i = 0; i < 60; i += 1) {
      const sam = await on(opened, SAM);
      for (const grant of await lease(sam)) {
        seen.add(grant.client);
        records.add(grant.record);
        issued += 1;
      }
      await sam.drop();
      if (i % 15 === 14) opened = await start(wake(opened));
    }
    expect(rows(opened, SUGGESTER.id), 'rows retained for one principal').toBeLessThanOrEqual(BOUND);
    expect(seen.size, 'every client id handed out is new').toBe(issued);
    expect(records.size, 'every reserved record id handed out is new').toBe(issued);

    const sam = await on(opened, SAM);
    const [grant] = await lease(sam);
    expect(seen.has(grant.client)).toBe(false);
    expect(await send(sam, { t: 'suggest-ops', record: grant.record, update: bytesToBase64(tiny(opened.dobj.document, grant.client)) })).toMatchObject({ t: 'suggest-ack', record: grant.record });
  });

  it('a retired reservation is refused on resume, never handed to the fork that asks next', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const first = await on(opened, SAM);
    const mine = (await lease(first, { fork: 'fork-t5s5-first' })).map((grant) => grant.client);
    await first.drop();
    const others: number[] = [];
    for (let i = 0; i < BOUND; i += 1) {
      const other = await on(opened, SAM);
      for (const grant of await lease(other, { fork: `fork-t5s5-other-${i}` })) others.push(grant.client);
      await other.drop();
    }
    expect(others.filter((client) => mine.includes(client)), 'no other fork receives the first fork\'s ids').toEqual([]);
    expect(rows(opened, SUGGESTER.id)).toBeLessThanOrEqual(BOUND);
    const back = await on(opened, SAM);
    expect(await send(back, { t: 'suggest-lease', resume: mine, fork: 'fork-t5s5-first' })).toMatchObject({ t: 'suggest-refused', reason: 'lease' });
  });

  it('a live fork asking afresh after idling never gets back a lease it still holds', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const fork = 'fork-t5s5-idle';
    const sam = await on(opened, SAM);
    const held = (await lease(sam, { fork })).map((grant) => grant.client);
    vi.setSystemTime(Date.now() + SUGGEST_LIMITS.leaseIdleMs + 60_000);
    const fresh = (await lease(sam, { fork })).map((grant) => grant.client);
    expect(fresh.filter((client) => held.includes(client))).toEqual([]);
  });

  it('live() reads a partial covering index of live rows only', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    await lease(sam);
    const plan = opened.backing.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${LIVE_LEASES_SQL}`, SUGGESTER.id, 0,
    ).map((row) => row.detail).join('\n');
    expect(plan).toContain('USING COVERING INDEX suggest_leases_live');
    const index = opened.backing.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'suggest_leases_live'")[0]?.sql ?? '';
    expect(index.replace(/\s+/g, ' ')).toMatch(/\(principal_id, used_at[^)]*\) WHERE record_id IS NULL AND expired = 0/);
  });
});

// T5.S5 (whole-repo Slop Cop P2): unbound lease reservations stay bounded per principal. Leasing, sending nothing
// and reconnecting, across wakes, resumes the principal's dormant reservations instead of minting rows without end,
// and live() reads only live rows through a partial covering index.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CUSTOM_PREFIX, type ServerEvent } from '@moss-multi/protocol/sync';
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
  it('lease, close and wake in a loop: the row count stays bounded, and a reused lease still writes', { timeout: 120_000 }, async () => {
    let opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const seen = new Set<number>();
    for (let i = 0; i < 60; i += 1) {
      const sam = await on(opened, SAM);
      for (const grant of await lease(sam)) seen.add(grant.client);
      await sam.drop();
      if (i % 15 === 14) opened = await start(wake(opened));
    }
    expect(rows(opened, SUGGESTER.id), 'rows retained for one principal').toBeLessThanOrEqual(BOUND);
    expect(seen.size, 'client ids handed out').toBeLessThanOrEqual(BOUND);

    // A resumed reservation writes as a fresh one does.
    const sam = await on(opened, SAM);
    const [grant] = await lease(sam);
    expect(grant.clock).toBe(0);
    expect(await send(sam, { t: 'suggest-ops', record: grant.record, update: bytesToBase64(tiny(opened.dobj.document, grant.client)) })).toMatchObject({ t: 'suggest-ack', record: grant.record });
  });

  it('a fork asking afresh gets its own dormant reservations back before any new row', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const fork = 'fork-t5s5-aaaa';
    const first = await on(opened, SAM);
    const before = (await lease(first, { fork })).map((grant) => grant.client).sort();
    await first.drop();
    const again = await on(opened, SAM);
    const after = (await lease(again, { fork })).map((grant) => grant.client).sort();
    expect(after).toEqual(before);
    expect(rows(opened, SUGGESTER.id)).toBe(before.length);
  });

  it('live() reads a partial covering index of live rows only', async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    await lease(sam);
    const plan = opened.backing.query<{ detail: string }>(
      'EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM suggest_leases WHERE principal_id = ? AND record_id IS NULL AND expired = 0 AND used_at >= ?', SUGGESTER.id, 0,
    ).map((row) => row.detail).join('\n');
    expect(plan).toContain('USING COVERING INDEX suggest_leases_live');
    const index = opened.backing.query<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'suggest_leases_live'")[0]?.sql ?? '';
    expect(index.replace(/\s+/g, ' ')).toMatch(/\(principal_id, used_at\) WHERE record_id IS NULL AND expired = 0/);
  });
});

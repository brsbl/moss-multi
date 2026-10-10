// T5.2 (docs/design/suggestions.md §2, §3, §14; A§5.1): suggest frames through the real DocDO's doc socket. Leases
// bound to a connection and persisted, server-minted record ids, payload ops on the DO's served payloads,
// continuations after accept, the live role on every frame, the protected `suggestions` map and leased ids for every
// role and doc, loud refusals with a cooldown, a suggester's body frame costing O(frame) however large the doc, and
// accept's state cap over every stored payload.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { recordDigest, deleteUpdate, type RecordOp } from '@moss-multi/core/suggest/apply';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CLOSE, CUSTOM_PREFIX, encodePayloadFrame, PAYLOAD_UPDATE, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { payloadSourceOf } from '../../src/server-doc.ts';
import { ForkShim } from '../../src/suggest/fork-shim.ts';
import { opsOf, readMeta, readRecord, SUGGESTIONS } from '../../src/suggest/records.ts';
import { acceptRecord, previewRecord, rejectRecord } from '../../src/suggest/review.ts';
import { CENSUS, EDITOR, insertBlock, OTHER_SUGGESTER, select, SEED, spansOfText, SUGGESTER } from '../../src/suggest/test-support.ts';
import { connect, openDoc, start, syncFrame, wake, type Opened, type TestClient, type Who } from './do-harness.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const isReply = (event: ServerEvent): event is SuggestReply => event.t.startsWith('suggest-');

/** One suggest request over the socket, and its reply. */
async function send(client: TestClient, request: SuggestRequest): Promise<SuggestReply> {
  const before = client.events.length;
  await client.deliver(`${CUSTOM_PREFIX}${JSON.stringify(request)}`);
  await client.pump();
  const reply = client.events.slice(before).find(isReply);
  expect(reply, `a reply to ${request.t}`).toBeDefined();
  return reply!;
}

async function leases(client: TestClient, resume?: number[]): Promise<LeaseGrant[]> {
  const reply = await send(client, { t: 'suggest-lease', ...(resume ? { resume } : {}) });
  expect(reply).toMatchObject({ t: 'suggest-leased' });
  return (reply as Extract<SuggestReply, { t: 'suggest-leased' }>).leases;
}

const opsRequest = (record: string, op: Uint8Array | RecordOp): SuggestRequest =>
  op instanceof Uint8Array ? { t: 'suggest-ops', record, update: bytesToBase64(op) } : { t: 'suggest-ops', record, doc: op.doc, update: bytesToBase64(op.update) };

async function seeded(): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
  return opened;
}

const SAM: Who = { id: SUGGESTER.id, name: SUGGESTER.name, role: 'suggester' };
const SKY: Who = { id: OTHER_SUGGESTER.id, name: OTHER_SUGGESTER.name, role: 'suggester' };

async function on(opened: Opened, who: Who): Promise<TestClient> {
  const client = await connect(opened, who);
  await client.hello();
  return client;
}

/** What `write` does on a copy of the server's doc under `client`, as one update. */
function forge(server: Y.Doc, write: (doc: Y.Doc) => void, client?: number): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  if (client !== undefined) doc.clientID = client;
  const sv = Y.encodeStateVector(doc);
  write(doc);
  const update = Y.encodeStateAsUpdate(doc, sv);
  doc.destroy();
  return update;
}

const firstBlock = (doc: Y.Doc) => (doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[]).map((op) => op.insert).find((x) => x instanceof Y.XmlText) as Y.XmlText;
const bodyState = (doc: Y.Doc) => JSON.stringify([doc.get('root', Y.XmlText).toJSON(), doc.getText('title').toString()]);
const suggestions = (doc: Y.Doc) => JSON.stringify(doc.getMap(SUGGESTIONS).toJSON(), (_k, v: unknown) => (v instanceof Uint8Array ? bytesToBase64(v) : v));

function accept(doc: Y.Doc, id: string) {
  const preview = previewRecord(doc, id);
  if (!preview.ok) throw new Error(`preview refused: ${preview.reason}`);
  return acceptRecord(doc, id, { previewHash: preview.hash, digest: recordDigest(readRecord(doc, id)!) }, EDITOR);
}

/** A plain fork of `server` under a leased `client`: each write returns its own update, as a fork transaction's. */
function forkDoc(server: Y.Doc, client: number): { write: (text: string) => Uint8Array } {
  const doc = new Y.Doc();
  doc.clientID = client;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  return {
    write: (text) => {
      const sv = Y.encodeStateVector(doc);
      firstBlock(doc).insert(0, text);
      return Y.encodeStateAsUpdate(doc, sv);
    },
  };
}

/** A suggester's fork over the doc as their client holds it, under `client`. */
function forkOf(client: TestClient, lease: number): ForkShim {
  return new ForkShim(client.doc, lease);
}

describe('T5.2 suggest-ops through the doc socket @p:mean-2 @p:R17', () => {
  it('colliding-prefix typing and an insert outside any existing suggestion are never refused', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const grants = [...(await leases(sam)), ...(await leases(sam))];
    expect(grants).toHaveLength(4);
    const colliding = CENSUS.slice(0, 3);
    expect(colliding.map((op) => op.name)).toEqual(['colliding prefix: "the " before "the cat"', 'a duplicated word', 'a sentence pasted before itself']);
    for (const [i, op] of colliding.entries()) {
      const fork = forkOf(sam, grants[i].client);
      try {
        for (const step of op.steps) if (step !== 'undo') fork.act(step);
        if (i === 0) fork.act(() => select('join tail', 0).insertText('Elsewhere, '));
        expect(fork.sent.length).toBeGreaterThan(0);
        for (const update of fork.sent) {
          expect(await send(sam, opsRequest(grants[i].record, update)), op.name).toMatchObject({ t: 'suggest-ack', record: grants[i].record });
        }
      } finally {
        fork.dispose();
      }
    }
    // A fresh record for an insert outside every existing suggestion.
    const fork = forkOf(sam, grants[3].client);
    try {
      fork.act(() => select('Indented', 0).insertText('New words. '));
      for (const update of fork.sent) expect(await send(sam, opsRequest(grants[3].record, update))).toMatchObject({ t: 'suggest-ack', record: grants[3].record });
    } finally {
      fork.dispose();
    }
    expect(sam.events.filter((e) => e.t === 'suggest-refused' || e.t === 'write-refused')).toEqual([]);
    expect(sam.closed).toBeNull();
  });

  it('leases are exclusive, never in the body state vector, and never the suggestions writer', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const sky = await on(opened, SKY);
    const all = [...(await leases(sam)), ...(await leases(sky)), ...(await leases(sam))];
    const clients = all.map((grant) => grant.client);
    expect(new Set(clients).size).toBe(6);
    expect(new Set(all.map((grant) => grant.record)).size).toBe(6);
    const fork = forkOf(sam, all[0].client);
    fork.act(() => select('Hello', 0).insertText('Hi. '));
    for (const update of fork.sent) expect(await send(sam, opsRequest(all[0].record, update))).toMatchObject({ t: 'suggest-ack' });
    fork.dispose();
    const body = Y.decodeStateVector(Y.encodeStateVector(opened.dobj.document));
    for (const client of clients) expect(body.has(client), `lease ${client}`).toBe(false);
    const writer = Number(opened.backing.query<{ value: string }>("SELECT value FROM meta WHERE key = 'suggestions-client'")[0].value);
    expect(clients).not.toContain(writer);
    expect(body.has(writer), 'records are written under S').toBe(true);
  });

  it("an editor's or owner's body frame carrying a leased client id is refused protected-type, 4409", async () => {
    for (const role of ['editor', 'owner']) {
      const opened = await seeded();
      const sam = await on(opened, SAM);
      const [grant] = await leases(sam);
      const editor = await on(opened, { role });
      const before = bodyState(opened.dobj.document);
      await editor.deliver(syncFrame(2, forge(opened.dobj.document, (doc) => firstBlock(doc).insert(0, 'X'), grant.client)));
      await editor.pump();
      expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'protected-type' });
      expect(editor.closed?.code).toBe(CLOSE.writeRefused);
      expect(bodyState(opened.dobj.document)).toBe(before);
    }
  });

  it('all_roles_cannot_write_suggestions_via_sync: step 2, update, nested writes and deletes under suggestions are refused; body writes land', async () => {
    const writes: [string, (doc: Y.Doc, id: string) => void][] = [
      ['a new top-level record', (doc) => doc.getMap(SUGGESTIONS).set('forged', 'accepted')],
      ["a record's meta overwritten", (doc, id) => (doc.getMap(SUGGESTIONS).get(id) as Y.Map<unknown>).set('meta', '{"status":"accepted"}')],
      ['an op pushed into a record', (doc, id) => opsOf(doc, id).push([{ doc: 'body', update: new Uint8Array([0, 0]) }])],
      ['a record deleted', (doc, id) => doc.getMap(SUGGESTIONS).delete(id)],
      ["a record's ops cleared", (doc, id) => opsOf(doc, id).delete(0, 1)],
    ];
    for (const role of ['suggester', 'editor', 'owner'] as const) {
      for (const step of [1, 2]) {
        for (const [name, write] of writes) {
          const opened = await seeded();
          const sam = await on(opened, SAM);
          const [grant] = await leases(sam);
          const fork = forkOf(sam, grant.client);
          fork.act(() => select('Hello', 0).insertText('Hi. '));
          for (const update of fork.sent) await send(sam, opsRequest(grant.record, update));
          fork.dispose();
          const map = suggestions(opened.dobj.document);
          const client = await on(opened, { role, id: `${role}-x@example.invalid` });
          await client.deliver(syncFrame(step, forge(opened.dobj.document, (doc) => write(doc, grant.record))));
          await client.pump();
          const label = `${role} step ${step}: ${name}`;
          expect(client.events, label).toContainEqual({ t: 'write-refused', reason: role === 'suggester' ? 'role' : 'protected-type' });
          expect(suggestions(opened.dobj.document), label).toBe(map);
          expect(readMeta(opened.dobj.document, grant.record)?.status, label).toBe('open');
        }
      }
    }
    // Positive controls: an editor's and an owner's body write lands and is acked, and an honest step 2 carrying the
    // deletes of closed records' items is inert.
    for (const role of ['editor', 'owner']) {
      const opened = await seeded();
      const sam = await on(opened, SAM);
      const [grant] = await leases(sam);
      expect(await send(sam, { t: 'suggest-delete', record: grant.record, part: { id: 'd1', targets: spansOfText(opened.dobj.document, 'world') } })).toMatchObject({ t: 'suggest-ack' });
      expect(await send(sam, { t: 'suggest-withdraw', record: grant.record })).toMatchObject({ t: 'suggest-ack' });
      const writer = await on(opened, { role });
      firstBlock(writer.doc).insert(0, `${role} wrote this. `);
      await writer.flush();
      await vi.advanceTimersByTimeAsync(300);
      await writer.pump();
      expect(writer.closed, role).toBeNull();
      expect(writer.events.some((e) => e.t === 'ack'), role).toBe(true);
      expect(firstBlock(opened.dobj.document).toString()).toContain(`${role} wrote this. `);
      const again = await connect(opened, { role }, writer.doc);
      await again.hello();
      expect(again.closed).toBeNull();
      expect(again.events.filter((e) => e.t === 'write-refused')).toEqual([]);
    }
  });
});

describe('T5.2 checker regressions: duplicates and lease cycles @p:mean-2', () => {
  it('duplicate_then_rewrite_refused: no role writes a copied note\'s suggestions map through the source\'s tombstones', async () => {
    const source = await seeded();
    const sam = await on(source, SAM);
    const [grant] = await leases(sam);
    expect(await send(sam, opsRequest(grant.record, forge(source.dobj.document, (d) => firstBlock(d).insert(0, 'A '), grant.client)))).toMatchObject({ t: 'suggest-ack' });
    expect(await send(sam, { t: 'suggest-delete', record: grant.record, part: { id: 'd1', targets: spansOfText(source.dobj.document, 'world') } })).toMatchObject({ t: 'suggest-ack' });
    const snapshot = await source.dobj.snapshotForDuplicate();
    const writes: [string, (doc: Y.Doc) => void][] = [
      ['the copied record id set again', (doc) => doc.getMap(SUGGESTIONS).set(grant.record, 'FORGED')],
      ['a fresh record id', (doc) => doc.getMap(SUGGESTIONS).set('fresh', 'FORGED')],
    ];
    for (const role of ['editor', 'owner']) {
      for (const [name, write] of writes) {
        const copy = await start(openDoc());
        await copy.dobj.createFromSnapshot({ folderId: 'folder-2', ownerId: 'owner-1', title: 'Copy' }, snapshot.state);
        const doc = copy.dobj.document;
        expect(doc.getMap(SUGGESTIONS).size).toBe(0);
        const client = await on(copy, { role, id: `${role}-x@example.invalid` });
        await client.deliver(syncFrame(2, forge(doc, write)));
        await client.pump();
        const label = `${role}: ${name}`;
        expect(client.events, label).toContainEqual({ t: 'write-refused', reason: 'protected-type' });
        expect(doc.getMap(SUGGESTIONS).size, label).toBe(0);
        // The copy's own records still work.
        const copySam = await on(copy, SAM);
        const [own] = await leases(copySam);
        expect(await send(copySam, opsRequest(own.record, forge(doc, (d) => firstBlock(d).insert(0, 'B '), own.client))), label).toMatchObject({ t: 'suggest-ack' });
        expect(readMeta(doc, own.record), label).toMatchObject({ status: 'open', author: SUGGESTER.id });
      }
    }
  });

  it('close_and_start_cycles_on_one_socket: open suggestions past the lease cap, then withdraw and reject cycles, never refused', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const pool: LeaseGrant[] = [];
    // An honest client uses its spare before it asks again.
    const next = async () => {
      if (pool.length === 0) pool.push(...(await leases(sam)));
      return pool.shift()!;
    };
    const write = async (grant: LeaseGrant, text: string) =>
      expect(await send(sam, opsRequest(grant.record, forge(doc, (d) => firstBlock(d).insert(0, text), grant.client))), text).toMatchObject({ t: 'suggest-ack', record: grant.record });
    for (let i = 0; i < 6; i += 1) await write(await next(), `open-${i} `);
    for (let i = 0; i < 10; i += 1) {
      const grant = await next();
      await write(grant, `cycle-${i} `);
      if (i % 2 === 0) expect(await send(sam, { t: 'suggest-withdraw', record: grant.record })).toMatchObject({ t: 'suggest-ack' });
      else expect(rejectRecord(doc, grant.record, EDITOR)).toEqual({ ok: true });
    }
    expect(sam.events.filter((e) => e.t === 'suggest-refused' || e.t === 'write-refused')).toEqual([]);
    expect(sam.closed).toBeNull();
  });

  it('delete_only_cycles_on_one_socket: delete-only suggestions opened then withdrawn or rejected, never refused', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const pool: LeaseGrant[] = [];
    const next = async () => {
      if (pool.length === 0) pool.push(...(await leases(sam)));
      return pool.shift()!;
    };
    for (let i = 0; i < 12; i += 1) {
      const grant = await next();
      const targets = spansOfText(doc, 'world');
      const request: SuggestRequest = i % 3 === 2
        ? opsRequest(grant.record, deleteUpdate(targets))
        : { t: 'suggest-delete', record: grant.record, part: { id: `d${i}`, targets } };
      expect(await send(sam, request), `cycle ${i}`).toMatchObject({ t: 'suggest-ack', record: grant.record });
      if (i % 2 === 0) expect(await send(sam, { t: 'suggest-withdraw', record: grant.record })).toMatchObject({ t: 'suggest-ack' });
      else expect(rejectRecord(doc, grant.record, EDITOR)).toEqual({ ok: true });
    }
    expect(sam.events.filter((e) => e.t === 'suggest-refused' || e.t === 'write-refused')).toEqual([]);
    expect(sam.closed).toBeNull();
  });
});

describe('T5.2 continuations after accept @p:mean-2', () => {
  it('a delete-only frame after accept opens a continuation record: a delete part, and a delete-only op', async () => {
    for (const kind of ['part', 'op'] as const) {
      const opened = await seeded();
      const doc = opened.dobj.document;
      const sam = await on(opened, SAM);
      const [grant] = await leases(sam);
      const fork = forkOf(sam, grant.client);
      fork.act(() => select('Hello', 24).insertText(' More words.'));
      for (const update of fork.sent) await send(sam, opsRequest(grant.record, update));
      fork.dispose();
      expect(accept(doc, grant.record)).toEqual({ ok: true });
      expect(firstBlock(doc).toString()).toContain('More words.');
      const reply = kind === 'part'
        ? await send(sam, { t: 'suggest-delete', record: grant.record, part: { id: 'd1', targets: spansOfText(doc, 'words') } })
        : await send(sam, opsRequest(grant.record, deleteUpdate(spansOfText(doc, 'words'))));
      expect(reply, kind).toMatchObject({ t: 'suggest-ack', requested: grant.record });
      const continuation = (reply as { record: string }).record;
      expect(continuation).not.toBe(grant.record);
      expect(readMeta(doc, continuation), kind).toMatchObject({ status: 'open', continues: grant.record, author: SUGGESTER.id });
      expect(readMeta(doc, grant.record)).toMatchObject({ status: 'accepted', continuedBy: continuation });
      const record = readRecord(doc, continuation)!;
      expect(kind === 'part' ? record.parts.length : record.ops.length).toBe(1);
    }
  });

  it('first_insert_after_accept_opens_continuation: it lands, is never refused, and nothing typed is lost', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const fork = forkOf(sam, grant.client);
    try {
      fork.act(() => select('Hello', 24).insertText(' More.'));
      for (const update of fork.sent.splice(0)) await send(sam, opsRequest(grant.record, update));
      expect(accept(doc, grant.record)).toEqual({ ok: true });
      // The fork has not heard of the accept: its next insert names the accepted record, under the same lease.
      fork.act(() => select('Hello', 30).insertText(' Again.'));
      const replies: SuggestReply[] = [];
      for (const update of fork.sent.splice(0)) replies.push(await send(sam, opsRequest(grant.record, update)));
      expect(replies.every((reply) => reply.t === 'suggest-ack')).toBe(true);
      const continuation = (replies[0] as { record: string }).record;
      expect(continuation).not.toBe(grant.record);
      expect(readMeta(doc, continuation)).toMatchObject({ status: 'open', continues: grant.record, clients: [grant.client] });
      expect(accept(doc, continuation)).toEqual({ ok: true });
      expect(firstBlock(doc).toString()).toContain('More. Again.');
    } finally {
      fork.dispose();
    }
  });
});

describe('T5.2 lease and record authorization @p:mean-2', () => {
  it('leases_are_bounded_and_bound: a small fixed number live, bound to the asking connection, expired on close or idle', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const first = await leases(sam);
    const second = await leases(sam);
    expect(first.length + second.length).toBe(4);
    // A request cannot raise it.
    await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-lease', count: 100 })}`);
    await sam.pump();
    expect(sam.events.at(-1)).toEqual({ t: 'suggest-refused', record: null, reason: 'lease-cap' });
    // Refusals are rate-limited per principal; each step below stays inside its own window.
    await vi.advanceTimersByTimeAsync(61_000);
    // Another connection of the same principal cannot write with it, nor take it while it is held.
    const other = await on(opened, SAM);
    const fork = forkDoc(doc, first[0].client);
    const stray = forge(doc, (d) => firstBlock(d).insert(0, 'X '), first[0].client);
    expect(await send(other, opsRequest(first[0].record, stray))).toEqual({ t: 'suggest-refused', record: first[0].record, reason: 'lease' });
    expect(await send(other, { t: 'suggest-lease', resume: [first[0].client] })).toEqual({ t: 'suggest-refused', record: null, reason: 'lease' });
    expect(await send(sam, opsRequest(first[0].record, fork.write('Mine ')))).toMatchObject({ t: 'suggest-ack' });
    await vi.advanceTimersByTimeAsync(61_000);
    // The asking connection closes: its leases expire, and only a resume rebinds them, with their acknowledged clock.
    await sam.drop();
    const later = fork.write('Later ');
    const nextClock = Y.parseUpdateMeta(later).from.get(first[0].client)!;
    expect(nextClock).toBeGreaterThan(0);
    expect(await send(other, opsRequest(first[0].record, later))).toEqual({ t: 'suggest-refused', record: first[0].record, reason: 'lease' });
    const resumed = await leases(other, [first[0].client]);
    expect(resumed[0]).toEqual({ client: first[0].client, record: first[0].record, clock: nextClock, clocks: { body: nextClock } });
    // Fresh leases may be minted again, since the closed connection's no longer count.
    expect(resumed.length).toBeGreaterThan(1);
    expect(await send(other, opsRequest(first[0].record, later))).toMatchObject({ t: 'suggest-ack', record: first[0].record });
    // An idle lease expires too.
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(await send(other, opsRequest(first[0].record, fork.write('Idle ')))).toEqual({ t: 'suggest-refused', record: first[0].record, reason: 'lease' });
  });

  it('leases persist: after a wake the same connection keeps writing', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const fork = forkDoc(opened.dobj.document, grant.client);
    expect(await send(sam, opsRequest(grant.record, fork.write('A ')))).toMatchObject({ t: 'suggest-ack' });
    const woken = await start(wake(opened));
    sam.opened = woken;
    expect(await send(sam, opsRequest(grant.record, fork.write('B ')))).toMatchObject({ t: 'suggest-ack', record: grant.record });
    expect(readRecord(woken.dobj.document, grant.record)!.ops).toHaveLength(2);
  });

  it('record_ids_are_server_minted: a client-chosen id cannot create a record or squat a peer\'s minted id', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const sky = await on(opened, SKY);
    const [mine] = await leases(sam);
    const [theirs] = await leases(sky);
    const write = (text: string) => forge(doc, (d) => firstBlock(d).insert(0, text), mine.client);
    expect(await send(sam, opsRequest('my-own-id', write('A ')))).toEqual({ t: 'suggest-refused', record: 'my-own-id', reason: 'record' });
    expect(await send(sam, { t: 'suggest-delete', record: 'my-own-id', part: { id: 'd1', targets: spansOfText(doc, 'world') } })).toMatchObject({ reason: 'record' });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(await send(sam, opsRequest(theirs.record, write('A ')))).toEqual({ t: 'suggest-refused', record: theirs.record, reason: 'record' });
    expect(await send(sam, { t: 'suggest-delete', record: theirs.record, part: { id: 'd1', targets: spansOfText(doc, 'world') } })).toMatchObject({ reason: 'record' });
    expect(readMeta(doc, 'my-own-id')).toBeNull();
    expect(readMeta(doc, theirs.record)).toBeNull();
    // Each principal's own minted id still works.
    expect(await send(sky, { t: 'suggest-delete', record: theirs.record, part: { id: 'd1', targets: spansOfText(doc, 'world') } })).toMatchObject({ t: 'suggest-ack', record: theirs.record });
    expect(readMeta(doc, theirs.record)).toMatchObject({ author: OTHER_SUGGESTER.id });
  });

  it('live_role_on_every_suggest_frame: a suggester demoted to viewer is refused on the next frame of each kind', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const [a, b] = await leases(sam);
    expect(await send(sam, opsRequest(a.record, forge(doc, (d) => firstBlock(d).insert(0, 'A '), a.client)))).toMatchObject({ t: 'suggest-ack' });
    expect(await send(sam, { t: 'suggest-delete', record: b.record, part: { id: 'd1', targets: spansOfText(doc, 'world') } })).toMatchObject({ t: 'suggest-ack' });
    // The one kick path (A§8): the demotion closes every socket of theirs 4403; the client reconnects at its new role.
    await opened.dobj.recheck({ principalIds: [SUGGESTER.id], at: Date.now() });
    expect(sam.closed?.code).toBe(CLOSE.revoked);
    await vi.advanceTimersByTimeAsync(1);
    const demoted = await on(opened, { ...SAM, role: 'viewer' });
    const frames: SuggestRequest[] = [
      opsRequest(a.record, forge(doc, (d) => firstBlock(d).insert(0, 'More '), a.client)),
      { t: 'suggest-delete', record: a.record, part: { id: 'd2', targets: spansOfText(doc, 'cat') } },
      { t: 'suggest-merge', into: a.record, from: b.record },
      { t: 'suggest-lease' },
    ];
    for (const frame of frames) {
      expect(await send(demoted, frame), frame.t).toMatchObject({ t: 'suggest-refused', reason: 'role' });
      // Past the refusal window, so the cooldown is not what answers the next one.
      await vi.advanceTimersByTimeAsync(61_000);
    }
    expect(readRecord(doc, a.record)!.ops).toHaveLength(1);
    expect(readRecord(doc, b.record)!.parts).toHaveLength(1);
  });
});

describe('T5.2 loud refusal, rate and cooldown @p:mean-2 @p:tech-7', () => {
  it('three refusals a minute close every socket of the principal 4429, and a reconnect is refused for 60 s', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const second = await on(opened, SAM);
    const sky = await on(opened, SKY);
    for (let i = 0; i < 2; i += 1) expect(await send(sam, { t: 'suggest-withdraw', record: `nope-${i}` })).toMatchObject({ t: 'suggest-refused' });
    expect(sam.closed).toBeNull();
    expect(await send(sam, { t: 'suggest-withdraw', record: 'nope-2' })).toMatchObject({ t: 'suggest-refused' });
    expect(sam.closed?.code).toBe(CLOSE.connectionLimit);
    expect(second.closed?.code).toBe(CLOSE.connectionLimit);
    expect(sky.closed, 'another principal is untouched').toBeNull();
    const refused = await connect(opened, SAM);
    expect(refused.closed?.code).toBe(CLOSE.connectionLimit);
    await vi.advanceTimersByTimeAsync(61_000);
    const back = await on(opened, SAM);
    expect(back.closed).toBeNull();
    expect(await leases(back)).toHaveLength(2);
  });

  it('refused frames that name one record, on one socket, each count toward the cooldown (T5.R2)', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    for (let i = 0; i < 2; i += 1) expect(await send(sam, { t: 'suggest-withdraw', record: 'nope' })).toMatchObject({ t: 'suggest-refused' });
    expect(sam.closed, 'two refusals').toBeNull();
    expect(await send(sam, { t: 'suggest-withdraw', record: 'nope' })).toMatchObject({ t: 'suggest-refused' });
    expect(sam.closed?.code, 'three refusals of the same record').toBe(CLOSE.connectionLimit);
  });

  it('role refusals of body frames count toward the cooldown', async () => {
    const opened = await seeded();
    const body = bodyState(opened.dobj.document);
    for (let i = 0; i < 3; i += 1) {
      const sam = await on(opened, SAM);
      await sam.deliver(syncFrame(2, forge(opened.dobj.document, (doc) => firstBlock(doc).insert(0, `X${i} `))));
      await sam.pump();
      expect(sam.events, `frame ${i}`).toContainEqual({ t: 'write-refused', reason: 'role' });
    }
    const refused = await connect(opened, SAM);
    expect(refused.closed?.code).toBe(CLOSE.connectionLimit);
    expect(bodyState(opened.dobj.document)).toBe(body);
  });

  it('suggest frames, the lease included, count toward the write rate (4420)', async () => {
    const original = DocDO.limits;
    DocDO.limits = { ...original, writeRate: { max: 4, windowMs: 5_000 } };
    try {
      const opened = await seeded();
      const sam = await on(opened, SAM);
      const [grant] = await leases(sam);
      for (let i = 0; i < 3; i += 1) {
        expect(await send(sam, { t: 'suggest-delete', record: grant.record, part: { id: `d${i}`, targets: spansOfText(opened.dobj.document, 'world') } })).toMatchObject({ t: 'suggest-ack' });
      }
      await sam.deliver(`${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-delete', record: grant.record, part: { id: 'd9', targets: spansOfText(opened.dobj.document, 'world') } })}`);
      expect(sam.closed?.code).toBe(CLOSE.writeRate);
      expect(readRecord(opened.dobj.document, grant.record)!.parts).toHaveLength(3);
    } finally {
      DocDO.limits = original;
    }
  });
});

/** The DO's stored text of payload `id`, or null when it holds none. */
const payloadText = (opened: Opened, id: string): string | null => {
  const state = payloadSourceOf(opened.dobj.document).read(id);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText('payload').toString();
};

describe('T5.R suggestions on payload docs through the DocDO @p:mean-2', () => {
  it("a new block's payload op lands in the record under the same lease, with its own clocks; the DO's payload is untouched", async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const fork = forkOf(sam, grant.client);
    try {
      fork.act(insertBlock('```js\nnew code\n```'));
      const payloadOps = fork.sent.filter((op) => op.doc !== 'body');
      expect(payloadOps.length, 'the new block travels with a payload op').toBeGreaterThan(0);
      for (const op of fork.sent) {
        expect(await send(sam, opsRequest(grant.record, op))).toMatchObject({ t: 'suggest-ack', record: grant.record, doc: op.doc });
      }
      const payload = payloadOps[0].doc;
      expect(readRecord(doc, grant.record)!.ops.map((op) => op.doc)).toEqual(fork.sent.map((op) => op.doc));
      expect(payloadText(opened, payload), 'ingest writes no payload').toBeNull();
      await sam.drop();
      const again = await on(opened, SAM);
      const [resumed] = await leases(again, [grant.client]);
      expect(resumed.clocks[payload], 'the payload doc keeps its own clock').toBeGreaterThan(0);
      expect(resumed.clocks.body).toBe(resumed.clock);
      expect(accept(doc, grant.record)).toEqual({ ok: true });
      expect(payloadText(opened, payload), 'accept lands the payload').toContain('new code');
    } finally {
      fork.dispose();
    }
  });

  it('a suggest-ops struct outside the channel table is refused channel, and nothing is stored', async () => {
    const opened = await seeded();
    const doc = opened.dobj.document;
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const update = forge(doc, (d) => firstBlock(d).format(0, 2, { bold: true }), grant.client);
    expect(await send(sam, opsRequest(grant.record, update))).toEqual({ t: 'suggest-refused', record: grant.record, reason: 'channel' });
    expect(readRecord(doc, grant.record)).toBeNull();
  });

  it("an editor's payload frame carrying a leased client id is refused protected-type, 4409", async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const editor = await on(opened, { role: 'editor' });
    const minted = new Y.Doc();
    minted.clientID = grant.client;
    minted.getText('payload').insert(0, 'under a lease');
    await editor.deliver(encodePayloadFrame('leased-payload', PAYLOAD_UPDATE, Y.encodeStateAsUpdate(minted)));
    await editor.pump();
    expect(editor.events).toContainEqual({ t: 'write-refused', reason: 'protected-type' });
    expect(editor.closed?.code).toBe(CLOSE.writeRefused);
  });

  it('accept_counts_every_stored_payload: a near-cap note whose record touches one payload is refused when every stored payload, withheld included, passes the cap', async () => {
    class RoomyDoc extends DocDO {
      static override limits = { ...DocDO.limits, withheldBytesPerIdentity: 1024 * 1024 };
    }
    for (const withheld of [false, true]) {
      const opened = await start(openDoc(undefined, RoomyDoc as never));
      await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
      const doc = opened.dobj.document;
      const sam = await on(opened, SAM);
      const [grant] = await leases(sam);
      const fork = forkOf(sam, grant.client);
      try {
        fork.act(insertBlock('```js\nnew code\n```'));
        expect(fork.sent.some((op) => op.doc !== 'body'), 'the record touches one payload').toBe(true);
        for (const op of fork.sent) expect(await send(sam, opsRequest(grant.record, op))).toMatchObject({ t: 'suggest-ack' });
      } finally {
        fork.dispose();
      }
      if (withheld) {
        // An editor mints a payload no element names: stored and withheld, counted toward the cap all the same.
        const eve = await on(opened, { id: 'eve@example.invalid', role: 'editor' });
        const big = new Y.Doc();
        big.getText('payload').insert(0, 'w'.repeat(64 * 1024));
        await eve.deliver(encodePayloadFrame('withheld-big', PAYLOAD_UPDATE, Y.encodeStateAsUpdate(big)));
        await eve.pump();
        expect(eve.closed, 'the withheld write is stored').toBeNull();
        expect(opened.dobj.payloadWork.withheld).toBeGreaterThan(0);
      }
      // Near the cap for the note and the payloads the record writes; 64 KB short of every stored payload.
      const cap = Y.encodeStateAsUpdate(doc).byteLength + 32 * 1024;
      const before = bodyState(doc);
      const preview = previewRecord(doc, grant.record);
      if (!preview.ok) throw new Error(preview.reason);
      const result = acceptRecord(doc, grant.record, { previewHash: preview.hash, digest: recordDigest(readRecord(doc, grant.record)!) }, EDITOR, { stateCap: cap });
      if (withheld) {
        expect(result).toEqual({ ok: false, status: 409, reason: 'doc-cap' });
        expect(bodyState(doc)).toBe(before);
        expect(readMeta(doc, grant.record)?.status).toBe('open');
      } else {
        expect(result, 'the control fits').toEqual({ ok: true });
      }
    }
  });
});

/**
 * A doc of `paragraphs` paragraphs plus a deleted region of `scattered` characters that another client interleaved,
 * so the region's deleted items stay separate structs (a doc's deleted history). Returns the region's client range.
 */
function bigDoc(paragraphs: number, scattered: number): { doc: Y.Doc; client: number; from: number; len: number } {
  const doc = new Y.Doc();
  const body = doc.get('root', Y.XmlText);
  const line = 'lorem ipsum dolor sit amet '.repeat(20);
  const client = doc.clientID;
  doc.transact(() => {
    for (let i = 0; i < paragraphs + 1; i++) {
      const block = new Y.XmlText();
      block.setAttribute('__type', 'paragraph');
      block.insert(0, i < paragraphs ? line : '');
      body.insertEmbed(body.length, block);
    }
  });
  const region = (body.toDelta() as { insert: Y.XmlText }[]).at(-1)!.insert;
  const from = Y.getState(doc.store, client);
  region.insert(0, 'a'.repeat(scattered));
  doc.clientID = client + 1;
  doc.transact(() => {
    for (let i = scattered - 1; i > 0; i -= 1) region.insert(i, 'b');
  });
  region.delete(0, region.length);
  doc.clientID = client;
  return { doc, client, from, len: scattered };
}

/** A V1 update with no structs and `ranges` delete ranges, each over [from, from + len) of `client`. */
function manyDeleteRanges(client: number, from: number, len: number, ranges: number): Uint8Array {
  const bytes: number[] = [];
  const varuint = (n: number) => {
    while (n > 0x7f) {
      bytes.push((n & 0x7f) | 0x80);
      n = Math.floor(n / 128);
    }
    bytes.push(n);
  };
  varuint(0);
  varuint(1);
  varuint(client);
  varuint(ranges);
  for (let i = 0; i < ranges; i += 1) {
    varuint(from);
    varuint(len);
  }
  return new Uint8Array(bytes);
}

describe('T5.2 a suggester body frame costs O(frame) @p:mean-2', () => {
  it('a maximum-size forged frame from a suggester costs the same on a small doc and the 1.69 MB doc', async () => {
    // Fake timers freeze performance.now.
    vi.useRealTimers();
    const measure = async (paragraphs: number, scattered: number) => {
      const opened = await start(openDoc());
      const source = bigDoc(paragraphs, scattered);
      Y.applyUpdate(opened.dobj.document, Y.encodeStateAsUpdate(source.doc));
      source.doc.destroy();
      // One frame of many delete ranges, each over the whole deleted region: every item it names is already deleted.
      const forged = manyDeleteRanges(source.client, source.from, source.len, 20_000);
      const body = bodyState(opened.dobj.document);
      const times: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        const sam = await on(opened, SAM);
        const started = performance.now();
        await sam.deliver(syncFrame(2, forged));
        times.push(performance.now() - started);
        await sam.pump();
        expect(bodyState(opened.dobj.document)).toBe(body);
      }
      return { bytes: Y.encodeStateAsUpdate(opened.dobj.document).byteLength, ms: [...times].sort((x, y) => x - y)[2], frame: forged.byteLength };
    };
    await measure(5, 100);
    const small = await measure(5, 100);
    const large = await measure(3_000, 50_000);
    console.log(`T5.2 suggester body frame (${large.frame} B): ${small.ms.toFixed(2)} ms on ${small.bytes} B vs ${large.ms.toFixed(2)} ms on ${large.bytes} B`);
    expect(large.bytes).toBeGreaterThan(1_600_000);
    expect(large.ms).toBeLessThan(small.ms * 3 + 10);
  });
});

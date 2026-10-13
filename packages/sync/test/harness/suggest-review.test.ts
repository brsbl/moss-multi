// T5.3 (docs/design/suggestions.md §4, §4.3, §4.7; PRODUCT ruling 16 and 17): preview, accept, reject and withdraw
// through the real DocDO's RPCs. An editor's accept lands the previewed diff on every connected client and closes the
// record; reject and withdraw change only the record, so the body stays byte-identical; a stale hash, a closed record
// and a reviewer below the role floor are refused with nothing applied; the working export adds every valid open
// record while the default export stays clean; and a new live suggestion notifies.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as Y from 'yjs';
import { applyRecord } from '@moss-multi/core/suggest/apply';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { base64ToBytes, bytesToBase64, CUSTOM_PREFIX, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { ForkShim } from '../../src/suggest/fork-shim.ts';
import { readMeta } from '../../src/suggest/records.ts';
import { forgeRecord, opOn, OTHER_SUGGESTER, select, SEED, SUGGESTER } from '../../src/suggest/test-support.ts';
import { bindLexical, connect, openDoc, start, wake, type Opened, type TestClient, type Who } from './do-harness.ts';

// applyRecord as itself, counted, so a cached working export is seen doing no gate work.
vi.mock('@moss-multi/core/suggest/apply', async (original) => {
  const actual = await original<typeof import('@moss-multi/core/suggest/apply')>();
  return { ...actual, applyRecord: vi.fn(actual.applyRecord) };
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  DocDO.suggestionNotices = () => null;
});

const isReply = (event: ServerEvent): event is SuggestReply => event.t.startsWith('suggest-');

async function send(client: TestClient, request: SuggestRequest): Promise<SuggestReply> {
  const before = client.events.length;
  await client.deliver(`${CUSTOM_PREFIX}${JSON.stringify(request)}`);
  await client.pump();
  const reply = client.events.slice(before).find(isReply);
  expect(reply, `a reply to ${request.t}`).toBeDefined();
  return reply!;
}

async function leases(client: TestClient): Promise<LeaseGrant[]> {
  const reply = await send(client, { t: 'suggest-lease' });
  expect(reply).toMatchObject({ t: 'suggest-leased' });
  return (reply as Extract<SuggestReply, { t: 'suggest-leased' }>).leases;
}

async function seeded(): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
  return opened;
}

const SAM: Who = { id: SUGGESTER.id, name: SUGGESTER.name, role: 'suggester' };
const SKY: Who = { id: OTHER_SUGGESTER.id, name: OTHER_SUGGESTER.name, role: 'suggester' };
const ED: Who = { id: 'editor-1@example.invalid', name: 'Ed Editor', role: 'editor' };
const EDITOR = { id: 'editor-1@example.invalid', role: 'editor' as const };

async function on(opened: Opened, who: Who): Promise<TestClient> {
  const client = await connect(opened, who);
  await client.hello();
  return client;
}

/** `who`'s fork makes `step` into a fresh record; returns its id. */
async function suggest(client: TestClient, step: () => void): Promise<string> {
  const [grant] = await leases(client);
  const fork = new ForkShim(client.doc, grant.client);
  try {
    fork.act(step);
    for (const op of fork.sent) {
      expect(await send(client, { t: 'suggest-ops', record: grant.record, doc: op.doc, update: bytesToBase64(op.update) })).toMatchObject({ t: 'suggest-ack' });
    }
  } finally {
    fork.dispose();
  }
  return grant.record;
}

const body = (doc: Y.Doc) => doc.get('root', Y.XmlText).toString();
const rootJson = (doc: Y.Doc) => JSON.stringify([doc.get('root', Y.XmlText).toJSON(), doc.getText('title').toString()]);

async function preview(opened: Opened, id: string) {
  const result = await opened.dobj.previewSuggestion({ id, reviewer: EDITOR });
  if (!result.ok) throw new Error(`preview refused: ${result.reason}`);
  return result;
}

describe('T5.3 accept, reject and withdraw through the DocDO @p:mean-2 @p:R16 @p:R17', () => {
  it("an editor's accept and reject converge on both sides", async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const ed = await on(opened, ED);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    expect(body(ed.doc)).not.toContain('More words.');
    const shown = await preview(opened, id);
    expect(shown.hunks.length).toBeGreaterThan(0);
    expect(await opened.dobj.acceptSuggestion({ id, reviewer: EDITOR, previewHash: shown.hash, digest: shown.digest })).toEqual({ ok: true });
    await ed.pump();
    await sam.pump();
    for (const client of [ed, sam]) {
      expect(body(client.doc)).toContain('More words.');
      expect(readMeta(client.doc, id)).toMatchObject({ status: 'accepted', resolvedBy: EDITOR.id });
    }
    expect(await opened.dobj.exportMarkdown()).toContain('Hello world and the cat. More words.');

    const second = await suggest(sam, () => select('Indented', 0).insertText('Rejected words. '));
    const before = rootJson(opened.dobj.document);
    expect(await opened.dobj.rejectSuggestion({ id: second, reviewer: EDITOR })).toEqual({ ok: true });
    await ed.pump();
    await sam.pump();
    expect(rootJson(opened.dobj.document)).toBe(before);
    for (const client of [ed, sam]) {
      expect(body(client.doc)).not.toContain('Rejected words.');
      expect(readMeta(client.doc, second)).toMatchObject({ status: 'rejected', resolvedBy: EDITOR.id });
    }
  });

  it('withdraw by the author leaves the body byte-identical; nobody else withdraws', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    const root = () => JSON.stringify(opened.dobj.document.get('root', Y.XmlText).toJSON());
    const before = root();
    const exported = await opened.dobj.exportMarkdown();
    expect(await opened.dobj.withdrawSuggestion({ id, reviewer: { id: OTHER_SUGGESTER.id, role: 'suggester' } })).toMatchObject({ ok: false, status: 403 });
    expect(await opened.dobj.withdrawSuggestion({ id, reviewer: EDITOR })).toMatchObject({ ok: false, status: 403 });
    expect(await opened.dobj.withdrawSuggestion({ id, reviewer: { id: SUGGESTER.id, role: 'suggester' } })).toEqual({ ok: true });
    expect(root()).toBe(before);
    expect(await opened.dobj.exportMarkdown()).toBe(exported);
    expect(readMeta(opened.dobj.document, id)).toMatchObject({ status: 'withdrawn' });
    expect(await opened.dobj.exportWorking(), 'a withdrawn record is in no view').not.toContain('More words.');
  });

  it('a stale hash, a changed record, a closed record and a reviewer below editor are refused with nothing applied', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    const shown = await preview(opened, id);
    const before = JSON.stringify(opened.dobj.document.get('root', Y.XmlText).toJSON());
    const unchanged = () => expect(JSON.stringify(opened.dobj.document.get('root', Y.XmlText).toJSON())).toBe(before);
    expect(await opened.dobj.acceptSuggestion({ id, reviewer: EDITOR, previewHash: 'stale', digest: shown.digest })).toEqual({ ok: false, status: 409, reason: 'changed' });
    unchanged();
    expect(await opened.dobj.acceptSuggestion({ id, reviewer: EDITOR, previewHash: shown.hash, digest: 'other' })).toEqual({ ok: false, status: 409, reason: 'changed' });
    unchanged();
    for (const role of ['suggester', 'commenter', 'viewer'] as const) {
      expect(await opened.dobj.acceptSuggestion({ id, reviewer: { id: 'x@example.invalid', role }, previewHash: shown.hash, digest: shown.digest })).toMatchObject({ ok: false, status: 403 });
      expect(await opened.dobj.rejectSuggestion({ id, reviewer: { id: 'x@example.invalid', role } })).toMatchObject({ ok: false, status: 403 });
    }
    unchanged();
    expect(await opened.dobj.acceptSuggestion({ id: 'missing', reviewer: EDITOR, previewHash: shown.hash, digest: shown.digest })).toMatchObject({ ok: false, status: 404 });
    expect(await opened.dobj.rejectSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: true });
    expect(await opened.dobj.acceptSuggestion({ id, reviewer: EDITOR, previewHash: shown.hash, digest: shown.digest })).toEqual({ ok: false, status: 409, reason: 'not-open' });
    unchanged();
  });

  it('the default export is the clean body; ?view=working adds every valid open record', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const sky = await on(opened, SKY);
    await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    await suggest(sky, () => select('Indented', 0).insertText('Sky says. '));
    const clean = await opened.dobj.exportMarkdown();
    expect(clean).not.toContain('More words.');
    expect(clean).not.toContain('Sky says.');
    const working = await opened.dobj.exportWorking();
    expect(working).toContain('Hello world and the cat. More words.');
    expect(working).toContain('Sky says. Indented words here.');
    expect(await opened.dobj.exportMarkdown()).toBe(clean);
  });

  it('a repeated working export is served from the cache with no gate work until the note or a record changes (I5)', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const sky = await on(opened, SKY);
    await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    const gates = vi.mocked(applyRecord);
    gates.mockClear();
    const first = await opened.dobj.exportWorking();
    expect(gates).toHaveBeenCalledTimes(1);
    gates.mockClear();
    expect(await opened.dobj.exportWorking()).toBe(first);
    expect(await opened.dobj.exportWorking()).toBe(first);
    expect(gates, 'a cached read runs no gate').not.toHaveBeenCalled();
    // A new record changes the composite: the next read recomputes and shows it.
    await suggest(sky, () => select('Indented', 0).insertText('Sky says. '));
    gates.mockClear();
    const second = await opened.dobj.exportWorking();
    expect(second).toContain('Sky says. Indented words here.');
    expect(gates).toHaveBeenCalledTimes(2);
    // A body edit does too.
    await opened.dobj.renameTitle('Renamed');
    gates.mockClear();
    await opened.dobj.exportWorking();
    expect(gates).toHaveBeenCalledTimes(2);
  });

  it('past the per-document bound a working export that would compute is refused before any gate work; a cached one is still served', async () => {
    const limits = DocDO.limits;
    DocDO.limits = { ...limits, workingRate: { max: 2, windowMs: 60_000 } };
    try {
      const opened = await seeded();
      const sam = await on(opened, SAM);
      await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
      const gates = vi.mocked(applyRecord);
      gates.mockClear();
      expect(await opened.dobj.exportWorking()).toContain('More words.');
      await opened.dobj.renameTitle('One');
      expect(await opened.dobj.exportWorking()).toContain('More words.');
      expect(await opened.dobj.exportWorking(), 'cached, so not counted').toContain('More words.');
      await opened.dobj.renameTitle('Two');
      gates.mockClear();
      expect(await opened.dobj.exportWorking()).toBeNull();
      expect(gates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(await opened.dobj.exportWorking()).toContain('More words.');
    } finally {
      DocDO.limits = limits;
    }
  });

  it('the per-document bound survives an eviction: a woken DocDO refuses inside the window with no gate work, and computes after it (T5.B1)', async () => {
    const limits = DocDO.limits;
    DocDO.limits = { ...limits, workingRate: { max: 2, windowMs: 60_000 } };
    try {
      let opened = await seeded();
      const sam = await on(opened, SAM);
      await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
      expect(await opened.dobj.exportWorking()).toContain('More words.');
      await opened.dobj.renameTitle('One');
      expect(await opened.dobj.exportWorking()).toContain('More words.');
      // Evicted inside the window: the woken instance has no cache, and the window it spent is in storage.
      opened = await start(wake(opened));
      const gates = vi.mocked(applyRecord);
      gates.mockClear();
      expect(await opened.dobj.exportWorking(), 'a wake does not reopen the window').toBeNull();
      expect(gates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(await opened.dobj.exportWorking()).toContain('More words.');
    } finally {
      DocDO.limits = limits;
    }
  });

  it("a collaborator's body frames are applied and acked while a burst of working exports is refused or served from the cache", async () => {
    const limits = DocDO.limits;
    DocDO.limits = { ...limits, workingRate: { max: 2, windowMs: 60_000 } };
    try {
      const opened = await seeded();
      const sam = await on(opened, SAM);
      const ed = await connect(opened, ED);
      const lexical = bindLexical(ed.doc);
      await ed.hello();
      await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
      // Open records that fail the gates: a block of a type nobody registered.
      const root = (doc: Y.Doc) => doc.get('root', Y.XmlText);
      for (const n of [0, 1, 2]) {
        forgeRecord(opened.dobj.document, `bad${n}`, [opOn(opened.dobj.document, 'body', (copy) => {
          const block = new Y.XmlText();
          block.setAttribute('__type', 'no-such-node');
          root(copy).insertEmbed(root(copy).length, block);
        })]);
      }
      const gates = vi.mocked(applyRecord);
      const served: (string | null)[] = [];
      for (let round = 0; round < 6; round += 1) {
        // Each edit drops the cache, so every read after the second computes and meets the bound.
        lexical.editor.update(() => select('Indented', 9).insertText(`Ed${round} `), { discrete: true });
        await ed.flush();
        gates.mockClear();
        for (let i = 0; i < 5; i += 1) served.push(await opened.dobj.exportWorking());
        if (round >= 2) expect(gates, 'past the bound no gate runs').not.toHaveBeenCalled();
        vi.advanceTimersByTime(250);
        await ed.pump();
        expect(body(opened.dobj.document)).toContain(`Ed${round} `);
      }
      expect(ed.closed).toBeNull();
      expect(ed.events.filter((event) => event.t === 'write-refused')).toEqual([]);
      const acks = ed.events.filter((event): event is Extract<ServerEvent, { t: 'ack' }> => event.t === 'ack');
      expect(acks).toHaveLength(6);
      const acked = Y.decodeStateVector(base64ToBytes(acks.at(-1)!.sv));
      for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(ed.doc))) expect(acked.get(client) ?? 0).toBeGreaterThanOrEqual(clock);
      // Rounds 0 and 1 compute once each and serve the rest from the cache; later rounds are refused.
      expect(served.slice(0, 10).every((markdown) => markdown?.includes('More words.'))).toBe(true);
      expect(served.slice(10)).toEqual(Array(20).fill(null));
      vi.advanceTimersByTime(60_000);
      const after = await opened.dobj.exportWorking();
      expect(after).toContain('Ed5 ');
      expect(after).toContain('More words.');
      expect(after).not.toContain('no-such-node');
    } finally {
      DocDO.limits = limits;
    }
  });

  it.each([false, true])('a record with nothing to show is rejected by the system on the alarm once idle, with nobody fetching its preview (evicted=%s)', async (evicted) => {
    let opened = await seeded();
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const fork = new ForkShim(sam.doc, grant.client);
    try {
      // Typed and taken back: ops, and no change.
      fork.act(() => select('Hello', 24).insertText('x'));
      fork.act(() => select('Hello', 24, 25).removeText());
      for (const op of fork.sent) {
        expect(await send(sam, { t: 'suggest-ops', record: grant.record, doc: op.doc, update: bytesToBase64(op.update) })).toMatchObject({ t: 'suggest-ack' });
      }
    } finally {
      fork.dispose();
    }
    const meta = readMeta(opened.dobj.document, grant.record)!;
    expect(meta.status).toBe('open');
    expect(opened.backing.alarm, 'the idle check is scheduled').not.toBeNull();
    expect(opened.backing.alarm!, 'within the idle window of the last change').toBeLessThanOrEqual(meta.updatedAt + 30_000 + 1_000);
    // An eviction drops what the instance held in memory; the alarm it set still fires on the fresh one. (The wake
    // clears fake timers, which resets the clock, so time moves on after it.)
    if (evicted) opened = await start(wake(opened));
    vi.setSystemTime(meta.updatedAt + 30_001);
    await opened.dobj.alarm();
    expect(readMeta(opened.dobj.document, grant.record)).toMatchObject({ status: 'rejected', resolvedBy: 'system' });
  });

  it('a new live suggestion notifies once, naming its author and record; a continuation does not', async () => {
    const notices: { docId: string; author: string; record: string }[] = [];
    DocDO.suggestionNotices = () => async (notice) => {
      notices.push(notice);
    };
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    expect(notices).toEqual([{ docId: opened.backing.docId, author: SUGGESTER.id, record: id }]);
  });
});

describe('T5.S9 a review heals a missed restore settle from D1', () => {
  /** D1's answer to the DocDO's liveness reads: trashed or not, and whether it answers at all. */
  function liveness(): { deleted: boolean; fails: boolean } {
    const d1 = { deleted: false, fails: false };
    const original = DocDO.liveness;
    DocDO.liveness = () => async () => {
      if (d1.fails) throw new Error('D1 unavailable');
      return d1.deleted;
    };
    onTestFinished(() => { DocDO.liveness = original; });
    return d1;
  }

  /** A doc with one open record (and its preview), trashed and settled; D1 then restores it, but that settle is lost. */
  async function missedRestore(d1: { deleted: boolean }) {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    const shown = await preview(opened, id);
    await opened.dobj.trash('hold-1');
    d1.deleted = true;
    expect(await opened.dobj.settle('hold-1')).toEqual({ deleted: true });
    d1.deleted = false;
    return { opened: await start(wake(opened)), id, shown };
  }

  it('the next preview recovers, and so does the next accept', async () => {
    const d1 = liveness();
    const viewed = await missedRestore(d1);
    expect(await viewed.opened.dobj.previewSuggestion({ id: viewed.id, reviewer: EDITOR })).toMatchObject({ ok: true, hash: viewed.shown.hash });

    const pushed = await missedRestore(d1);
    expect(await pushed.opened.dobj.acceptSuggestion({ id: pushed.id, reviewer: EDITOR, previewHash: pushed.shown.hash, digest: pushed.shown.digest }))
      .toEqual({ ok: true });
    expect(body(pushed.opened.dobj.document)).toContain('More words.');
  });

  it('a held doc and a doc D1 still trashes stay refused', async () => {
    const d1 = liveness();
    const held = await seeded();
    const sam = await on(held, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    await held.dobj.trash('hold-1');
    expect(await held.dobj.previewSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: false, status: 404, reason: 'trashed' });

    d1.deleted = true;
    await held.dobj.settle('hold-1');
    const woken = await start(wake(held));
    expect(await woken.dobj.previewSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: false, status: 404, reason: 'trashed' });
    expect(await woken.dobj.rejectSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: false, status: 404, reason: 'trashed' });
  });

  it('a liveness read that fails answers 503 and changes nothing; the next one recovers', async () => {
    const d1 = liveness();
    const { opened, id } = await missedRestore(d1);
    d1.fails = true;
    expect(await opened.dobj.rejectSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: false, status: 503, reason: 'unconfirmed' });
    expect(readMeta(opened.dobj.document, id)).toMatchObject({ status: 'open' });
    d1.fails = false;
    expect(await opened.dobj.rejectSuggestion({ id, reviewer: EDITOR })).toEqual({ ok: true });
  });
});

describe('T5.B1 an anonymous link holder previews through the DocDO @p:mean-2 @p:ppl-2', () => {
  const LINK = 'good-link-token';
  /** D1 as the check reads it: a signed-in owner, and one share link that reaches the note as a viewer. */
  class LinkDocDO extends DocDO {
    static override access = () => ({
      stamp: async (_docId: string, sessions: string[], agents: string[]) => ({ key: 'e1', sessions: new Set(sessions), agents: new Set(agents) }),
      resolve: async (_docId: string, socket: { kind: string; principalId: string; shareToken: string | null }) => {
        if (socket.kind === 'user') return { role: socket.principalId === SUGGESTER.id ? 'suggester' as const : 'owner' as const, presence: true };
        return socket.kind === 'anonymous' && socket.shareToken === LINK ? { role: 'viewer' as const, presence: false } : null;
      },
    });
  }
  const OWNER = { kind: 'user' as const, principalId: 'owner-1', sessionId: 'sess-owner', shareToken: null };
  const ANONYMOUS = { kind: 'anonymous' as const, principalId: 'anonymous', sessionId: null, shareToken: LINK };

  it('previews with a link that reaches the note; another link is not found; accept, reject and withdraw stay 401', async () => {
    const opened = await start(openDoc(undefined, LinkDocDO as never));
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
    const sam = await on(opened, SAM);
    const id = await suggest(sam, () => select('Hello', 24).insertText(' More words.'));
    const asOwner = await opened.dobj.previewSuggestion({ id, reviewer: { id: 'owner-1', role: 'owner' }, actor: OWNER });
    expect(asOwner).toMatchObject({ ok: true });
    const reader = { id: 'anonymous', role: 'viewer' as const };
    expect(await opened.dobj.previewSuggestion({ id, reviewer: reader, actor: ANONYMOUS }), 'the link holder sees what the owner sees').toEqual(asOwner);
    expect(await opened.dobj.previewSuggestion({ id, reviewer: reader, actor: { ...ANONYMOUS, shareToken: 'other-link' } })).toMatchObject({ ok: false, status: 404 });
    expect(await opened.dobj.previewSuggestion({ id, reviewer: reader, actor: { ...ANONYMOUS, shareToken: null } })).toMatchObject({ ok: false, status: 401 });
    const refused = { ok: false, status: 401 };
    expect(await opened.dobj.acceptSuggestion({ id, reviewer: reader, actor: ANONYMOUS, previewHash: 'h', digest: 'd' })).toMatchObject(refused);
    expect(await opened.dobj.rejectSuggestion({ id, reviewer: reader, actor: ANONYMOUS })).toMatchObject(refused);
    expect(await opened.dobj.withdrawSuggestion({ id, reviewer: reader, actor: ANONYMOUS })).toMatchObject(refused);
    expect(readMeta(opened.dobj.document, id)).toMatchObject({ status: 'open' });
  });
});

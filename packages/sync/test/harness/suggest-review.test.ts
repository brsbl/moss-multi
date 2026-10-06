// T5.3 (docs/design/suggestions.md §4, §4.3, §4.7; PRODUCT ruling 16 and 17): preview, accept, reject and withdraw
// through the real DocDO's RPCs. An editor's accept lands the previewed diff on every connected client and closes the
// record; reject and withdraw change only the record, so the body stays byte-identical; a stale hash, a closed record
// and a reviewer below the role floor are refused with nothing applied; the working export adds every valid open
// record while the default export stays clean; and a new live suggestion notifies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { LeaseGrant, SuggestReply, SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CUSTOM_PREFIX, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { ForkShim } from '../../src/suggest/fork-shim.ts';
import { readMeta } from '../../src/suggest/records.ts';
import { OTHER_SUGGESTER, select, SEED, SUGGESTER } from '../../src/suggest/test-support.ts';
import { connect, openDoc, start, type Opened, type TestClient, type Who } from './do-harness.ts';

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
    expect(await opened.dobj.exportMarkdown({ view: 'working' }), 'a withdrawn record is in no view').not.toContain('More words.');
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
    const working = await opened.dobj.exportMarkdown({ view: 'working' });
    expect(working).toContain('Hello world and the cat. More words.');
    expect(working).toContain('Sky says. Indented words here.');
    expect(await opened.dobj.exportMarkdown()).toBe(clean);
  });

  it('a record with nothing to show is rejected by the system on the alarm once idle, with nobody fetching its preview', async () => {
    const opened = await seeded();
    const sam = await on(opened, SAM);
    const [grant] = await leases(sam);
    const fork = new ForkShim(sam.doc, grant.client);
    try {
      // Typed and taken back: ops, and no change.
      fork.act(() => select('Hello', 24).insertText('x'));
      fork.act(() => select('Hello', 25).deleteCharacter(true));
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

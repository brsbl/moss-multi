// Suggestion writes meet the note's limits (A§5.1 Limits; T5.V). A record's ops, parts and meta are structs of the
// note's doc, so they count toward the structure guard, and the text a record inserts counts toward the text limit it
// would reach once accepted. A suggest frame that would pass either is refused whole, `doc-cap` naming the limit, as is
// every growth frame after it in the no-room window; a withdraw or a reject always lands. An accept that would take the
// note past a limit is refused 409 naming it, with nothing written. The caps are shrunk per case so each note is small.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STRUCT_CAP, TEXT_CHAR_CAP } from '@moss-multi/protocol/limits';
import { SUGGEST_LIMITS, type LeaseGrant, type SuggestReply, type SuggestRequest } from '@moss-multi/protocol/suggest';
import { bytesToBase64, CUSTOM_PREFIX, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { ForkShim } from '../../src/suggest/fork-shim.ts';
import { readMeta, recordIds } from '../../src/suggest/records.ts';
import { select, SEED, SUGGESTER } from '../../src/suggest/test-support.ts';
import { connect, openDoc, start, type Opened, type TestClient, type Who } from './do-harness.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A DocDO class whose limits can be changed between writes. */
function capped(): { Doc: typeof DocDO; limits: DocLimits } {
  const limits = { ...DocDO.limits } as DocLimits;
  class Capped extends DocDO {
    static override limits = limits;
  }
  return { Doc: Capped, limits };
}

const SAM: Who = { id: SUGGESTER.id, name: SUGGESTER.name, role: 'suggester' };
const EDITOR = { id: 'editor-limits@example.invalid', role: 'editor' as const };

const isReply = (event: ServerEvent): event is SuggestReply => event.t.startsWith('suggest-');

async function send(client: TestClient, request: SuggestRequest): Promise<SuggestReply> {
  const before = client.events.length;
  await client.deliver(`${CUSTOM_PREFIX}${JSON.stringify(request)}`);
  await client.pump();
  const reply = client.events.slice(before).find(isReply);
  expect(reply, `a reply to ${request.t}`).toBeDefined();
  return reply!;
}

async function note(Doc: typeof DocDO): Promise<{ opened: Opened; sam: TestClient }> {
  const opened = await start(openDoc(undefined, Doc as never));
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'owner-1', markdown: SEED });
  const sam = await connect(opened, SAM);
  await sam.hello();
  return { opened, sam };
}

async function lease(client: TestClient): Promise<LeaseGrant> {
  const reply = await send(client, { t: 'suggest-lease' });
  expect(reply).toMatchObject({ t: 'suggest-leased' });
  return (reply as Extract<SuggestReply, { t: 'suggest-leased' }>).leases[0];
}

/** The ops `step` makes in a fork of the client's doc under `grant`'s lease, as suggest-ops requests. */
function opsOf(client: TestClient, grant: LeaseGrant, step: () => void): SuggestRequest[] {
  const fork = new ForkShim(client.doc, grant.client);
  try {
    fork.act(step);
    return fork.sent.map((op) => ({ t: 'suggest-ops', record: grant.record, doc: op.doc, update: bytesToBase64(op.update) }));
  } finally {
    fork.dispose();
  }
}

const records = (opened: Opened) => JSON.stringify(opened.dobj.document.getMap('suggestions').toJSON());
const body = (opened: Opened) => opened.dobj.document.get('root', Y.XmlText).toString();

/** `request` is refused naming `limit`, and neither the records nor the note's state change. */
async function expectLimit(opened: Opened, client: TestClient, request: SuggestRequest, limit: 'text' | 'structure'): Promise<void> {
  const before = records(opened);
  const state = Y.encodeStateVector(opened.dobj.document);
  expect(await send(client, request)).toMatchObject({ t: 'suggest-refused', reason: 'doc-cap', limit });
  expect(records(opened)).toBe(before);
  expect(Y.encodeStateVector(opened.dobj.document)).toEqual(state);
}

/** Past the no-room window and the refusal cooldown, so the next frame reaches admission again. */
const nextWindow = () => vi.advanceTimersByTimeAsync(Math.max(SUGGEST_LIMITS.refusals.windowMs, SUGGEST_LIMITS.cooldownMs) + 1);

describe('suggestion writes meet the note\'s limits @p:tech-3 @p:mean-2', () => {
  it('at the structure guard a record is refused naming the limit, as is every growth frame in its window; a withdraw lands', async () => {
    const { Doc, limits } = capped();
    const { opened, sam } = await note(Doc);
    const grant = await lease(sam);
    const [first] = opsOf(sam, grant, () => select('Hello', 5).insertText(' there'));
    expect(await send(sam, first)).toMatchObject({ t: 'suggest-ack' });
    const open = recordIds(opened.dobj.document)[0];

    limits.structCap = (await opened.dobj.noteSize()).structs;
    const second = await lease(sam);
    const [next] = opsOf(sam, second, () => select('Indented', 0).insertText('More '));
    await expectLimit(opened, sam, next, 'structure');
    // The connection's window answers the next growth frame alike, without admission.
    await expectLimit(opened, sam, { t: 'suggest-delete', record: open, part: { id: 'p1', targets: [{ client: 1, clock: 0, len: 1 }] } }, 'structure');
    expect(await send(sam, { t: 'suggest-withdraw', record: open }), 'a withdraw always lands').toMatchObject({ t: 'suggest-ack' });
    expect(readMeta(opened.dobj.document, open)?.status).toBe('withdrawn');

    await nextWindow();
    limits.structCap = STRUCT_CAP;
    const third = await lease(sam);
    const [again] = opsOf(sam, third, () => select('Indented', 0).insertText('More '));
    expect(await send(sam, again), 'under the guard again').toMatchObject({ t: 'suggest-ack' });
  });

  it('a record whose inserted text would take the note past its text limit is refused naming it', async () => {
    const { Doc, limits } = capped();
    const { opened, sam } = await note(Doc);
    limits.textCharCap = (await opened.dobj.noteSize()).chars + 8;
    const grant = await lease(sam);
    const fork = new ForkShim(sam.doc, grant.client);
    try {
      const request = (op: { doc: string; update: Uint8Array }): SuggestRequest => ({ t: 'suggest-ops', record: grant.record, doc: op.doc, update: bytesToBase64(op.update) });
      const [small] = fork.act(() => select('Hello', 5).insertText('abcde'));
      expect(await send(sam, request(small)), 'five characters fit').toMatchObject({ t: 'suggest-ack' });
      // The record would hold ten characters, past the eight left.
      const [more] = fork.act(() => select('Indented', 0).insertText('fghij'));
      await expectLimit(opened, sam, request(more), 'text');
    } finally {
      fork.dispose();
    }
    expect(body(opened), 'the body is untouched').not.toContain('abcde');
    limits.textCharCap = TEXT_CHAR_CAP;
  });

  it('an accept that would pass the text or structure limit is refused 409 naming it with nothing written; reject lands', async () => {
    const { Doc, limits } = capped();
    const { opened, sam } = await note(Doc);
    const grant = await lease(sam);
    for (const request of opsOf(sam, grant, () => select('Hello', 5).insertText(' accepted words'))) {
      expect(await send(sam, request)).toMatchObject({ t: 'suggest-ack' });
    }
    const id = recordIds(opened.dobj.document)[0];
    const shown = await opened.dobj.previewSuggestion({ id, reviewer: EDITOR });
    if (!shown.ok) throw new Error(`preview refused: ${shown.reason}`);
    const accept = () => opened.dobj.acceptSuggestion({ id, reviewer: EDITOR, previewHash: shown.hash, digest: shown.digest });
    const unchanged = async (limit: 'text' | 'structure') => {
      const before = body(opened);
      const state = Y.encodeStateVector(opened.dobj.document);
      expect(await accept()).toEqual({ ok: false, status: 409, reason: 'doc-cap', limit });
      expect(body(opened)).toBe(before);
      expect(Y.encodeStateVector(opened.dobj.document)).toEqual(state);
      expect(readMeta(opened.dobj.document, id)?.status).toBe('open');
    };

    const size = await opened.dobj.noteSize();
    limits.textCharCap = size.chars + 3;
    await unchanged('text');
    limits.textCharCap = TEXT_CHAR_CAP;
    limits.structCap = size.structs;
    await unchanged('structure');
    limits.structCap = STRUCT_CAP;
    expect(await accept(), 'under both limits again').toEqual({ ok: true });
    expect(body(opened)).toContain('accepted words');

    // A reject writes only the record's status, so it lands at the guard.
    const other = await lease(sam);
    for (const request of opsOf(sam, other, () => select('Indented', 0).insertText('Rejected '))) {
      expect(await send(sam, request)).toMatchObject({ t: 'suggest-ack' });
    }
    const rejected = recordIds(opened.dobj.document).find((each) => readMeta(opened.dobj.document, each)?.status === 'open')!;
    limits.structCap = (await opened.dobj.noteSize()).structs;
    expect(await opened.dobj.rejectSuggestion({ id: rejected, reviewer: EDITOR })).toEqual({ ok: true });
  });
});

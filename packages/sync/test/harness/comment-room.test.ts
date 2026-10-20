// T4.S2 comment room counts stored payloads (A§5.1 Limits): comment writes fill at most COMMENT_STATE_SHARE of the
// state cap, measured as #overCap measures it, the note's state plus every stored payload, served or withheld. A
// comment past that budget is refused with state unchanged, and an ordinary edit still lands after one that fits.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodePosition, liveUnits } from '@moss-multi/core/anchor-frame';
import { DocDO } from '../../src/doc-do.ts';
import { COMMENT_STATE_SHARE } from '../../src/doc/comments.ts';
import { Backing, connect, openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const CAP = 64 * 1024;
const BUDGET = Math.floor(CAP * COMMENT_STATE_SHARE);
const PAYLOAD_CHARS = 22_000;

class SmallDoc extends DocDO {
  static override limits = { ...DocDO.limits, stateCapBytes: CAP };
}

const code = (chars: number) => `\`\`\`js\n${'x'.repeat(chars)}\n\`\`\``;
const payloadBytes = (opened: Opened) => Number(opened.backing.query<{ n: number }>('SELECT COALESCE(SUM(bytes), 0) AS n FROM payload_meta')[0].n);
const withheldIds = (opened: Opened) => opened.backing.query<{ reg_id: string }>('SELECT reg_id FROM payload_meta WHERE withheld_since IS NOT NULL').length;
const aggregate = (opened: Opened) => Y.encodeStateAsUpdate(opened.dobj.document).byteLength + payloadBytes(opened);
const comments = (opened: Opened) => opened.dobj.document.getMap('comments').toJSON();

/** An editor's one-character edit to the first paragraph lands. */
async function expectTypeable(opened: Opened): Promise<void> {
  const client = await connect(opened, { role: 'editor' });
  await client.hello();
  const paragraph = (client.doc.get('root', Y.XmlText).toDelta() as { insert: unknown }[])[0].insert as Y.XmlText;
  client.doc.transact(() => paragraph.insert(paragraph.length, '!'));
  await client.flush();
  expect(client.closed, 'the next body edit is admitted').toBeNull();
  expect(client.events).not.toContainEqual(expect.objectContaining({ t: 'write-refused' }));
}

/** A served code payload from the import and a withheld one an editor typed then deleted, close to the comment budget. */
async function nearCap(): Promise<Opened> {
  const opened = await start(openDoc(new Backing(), SmallDoc as never));
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: `Intro words to comment on.\n\n${code(PAYLOAD_CHARS)}\n\nOutro.` });
  const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
  try {
    ada.insert('code-block', 'y'.repeat(PAYLOAD_CHARS));
    await syncAll(ada);
    ada.remove(0);
    await syncAll(ada);
  } finally { ada.dispose(); }
  expect(withheldIds(opened), 'one stored payload is withheld').toBe(1);
  const room = BUDGET - aggregate(opened);
  expect(room, 'the stored payloads leave a little comment room').toBeGreaterThan(1_000);
  expect(room).toBeLessThan(9_000);
  return opened;
}

function anchorOn(opened: Opened, quote: string) {
  const { text, units } = liveUnits(opened.dobj.document);
  const at = text.indexOf(quote);
  return { kind: 'text' as const, start: encodePosition(units[at], 0), end: encodePosition(units[at + quote.length - 1], -1) };
}

/** `write` is refused doc-cap and changes neither the comments nor the note's state. */
async function expectRefused(opened: Opened, write: () => Promise<unknown>): Promise<void> {
  const before = comments(opened);
  const state = Y.encodeStateVector(opened.dobj.document);
  expect(await write()).toEqual({ ok: false, status: 413, error: 'doc-cap' });
  expect(comments(opened)).toEqual(before);
  expect(Y.encodeStateVector(opened.dobj.document)).toEqual(state);
}

describe('T4.S2 comment room counts served and withheld payloads @p:tech-3', () => {
  const big = 'x'.repeat(9_500);

  it('a comment, reply, expanding edit or reaction past the aggregate budget is refused; ordinary edits still land', async () => {
    const opened = await nearCap();
    await expectRefused(opened, () => opened.dobj.createComment({ author: 'ada', id: 'big', text: big, anchor: anchorOn(opened, 'Intro words') }));
    expect(await opened.dobj.createComment({ author: 'ada', id: 'root', text: 'note', anchor: anchorOn(opened, 'Intro words') })).toMatchObject({ ok: true });
    await expectTypeable(opened);
    await expectRefused(opened, () => opened.dobj.createComment({ author: 'ben', id: 'reply', text: big, parentId: 'root' }));
    await expectRefused(opened, () => opened.dobj.editComment({ id: 'root', author: 'ada', text: big }));
    await expectRefused(opened, () => opened.dobj.reactComment({ id: 'root', principal: 'p'.repeat(9_500), emoji: '👍', on: true }));

    let refused: unknown = null;
    for (let i = 0; i < 200 && !refused; i += 1) {
      const result = await opened.dobj.createComment({ author: 'ben', id: `fill${i}`, text: 'x'.repeat(500), parentId: 'root' });
      if (!result.ok) refused = result;
    }
    expect(refused).toEqual({ ok: false, status: 413, error: 'doc-cap' });
    expect(aggregate(opened), 'comments stop at their share of the note plus its payloads').toBeLessThanOrEqual(BUDGET);
    await expectTypeable(opened);
  });

  it('a sidecar import counts the imported payloads: comments stop at the aggregate budget', async () => {
    const ids = ['k0', 'k1', 'k2', 'k3'];
    const marked = ids.map((id) => `%%m:${id}:start%%word ${id}%%m:${id}:end%%`).join(' and ');
    const sidecar = Object.fromEntries(ids.map((id, i) => [id, { text: 'x'.repeat(4_000), createdAt: i, updatedAt: i, source: 'user' }]));
    const opened = await start(openDoc(new Backing(), SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', author: 'importer', markdown: `${marked}.\n\n${code(2 * PAYLOAD_CHARS)}`, comments: sidecar } as never);
    const imported = Object.keys(comments(opened)).filter((key) => key.startsWith('c:'));
    expect(imported.length, 'not every 4,000-character comment fits beside the payload').toBeLessThan(ids.length);
    expect(aggregate(opened)).toBeLessThanOrEqual(BUDGET);
    await expectTypeable(opened);
  });
});

// Comment writes meet the note's limits (A§5.1 Limits; T4.V): they add no body text, so a note at its text limit still
// takes comments, and their records count toward the structure guard. At the guard a comment, reply, edit or reaction
// is refused whole, 413 naming the structure limit; a resolve or a removed reaction has the headroom formats and
// properties have, and a delete always lands. A sidecar import keeps only the records that fit under the guard.
// The caps are shrunk per case so each note is small.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { encodePosition, liveUnits } from '@moss-multi/core/anchor-frame';
import { STRUCT_CAP } from '@moss-multi/protocol/limits';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { Backing, openDoc, start, type Opened } from './do-harness.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A DocDO class whose limits can be changed between writes. */
function capped(caps: Partial<DocLimits> = {}): { Doc: typeof DocDO; limits: DocLimits } {
  const limits = { ...DocDO.limits, ...caps } as DocLimits;
  class Capped extends DocDO {
    static override limits = limits;
  }
  return { Doc: Capped, limits };
}

const MARKDOWN = 'Intro words to comment on.\n\nOutro words.';
const STRUCTURE = { ok: false, status: 413, error: 'doc-cap', limit: 'structure' };

async function note(Doc: typeof DocDO, input: Record<string, unknown> = {}): Promise<Opened> {
  const opened = await start(openDoc(new Backing(), Doc as never));
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: MARKDOWN, ...input } as never);
  return opened;
}

function anchorOn(opened: Opened, quote: string) {
  const { text, units } = liveUnits(opened.dobj.document);
  const at = text.indexOf(quote);
  return { kind: 'text' as const, start: encodePosition(units[at], 0), end: encodePosition(units[at + quote.length - 1], -1) };
}

const comments = (opened: Opened) => opened.dobj.document.getMap('comments').toJSON() as Record<string, Record<string, unknown>>;

/** `write` is refused with the structure limit and changes neither the comments nor the note's state. */
async function expectStructure(opened: Opened, write: () => Promise<unknown>): Promise<void> {
  const before = comments(opened);
  const state = Y.encodeStateVector(opened.dobj.document);
  expect(await write()).toEqual(STRUCTURE);
  expect(comments(opened)).toEqual(before);
  expect(Y.encodeStateVector(opened.dobj.document)).toEqual(state);
}

describe('comment writes meet the note\'s limits @p:tech-3', () => {
  it('at the structure guard a comment, reply, edit or reaction is refused naming the limit; a resolve, an unreact and a delete land', async () => {
    const { Doc, limits } = capped();
    const opened = await note(Doc);
    const { dobj } = opened;
    expect(await dobj.createComment({ author: 'ada', id: 'root', text: 'On the intro', anchor: anchorOn(opened, 'Intro words') })).toMatchObject({ ok: true });
    expect(await dobj.createComment({ author: 'ben', id: 'reply', text: 'Agreed', parentId: 'root' })).toMatchObject({ ok: true });
    expect(await dobj.reactComment({ id: 'root', principal: 'ben', emoji: '👍', on: true })).toMatchObject({ ok: true });

    limits.structCap = (await dobj.noteSize()).structs;
    await expectStructure(opened, () => dobj.createComment({ author: 'ada', id: 'second', text: 'On the outro', anchor: anchorOn(opened, 'Outro words') }));
    await expectStructure(opened, () => dobj.createComment({ author: 'ben', id: 'reply2', text: 'Another', parentId: 'root' }));
    await expectStructure(opened, () => dobj.editComment({ id: 'root', author: 'ada', text: 'On the intro, edited' }));
    await expectStructure(opened, () => dobj.reactComment({ id: 'root', principal: 'ada', emoji: '🎉', on: true }));

    expect(await dobj.resolveComment({ id: 'root', resolved: true, by: 'user' }), 'a resolve has the headroom').toMatchObject({ ok: true });
    expect(await dobj.reactComment({ id: 'root', principal: 'ben', emoji: '👍', on: false }), 'so does a removed reaction').toMatchObject({ ok: true });
    expect(await dobj.deleteComment({ id: 'reply', author: 'ben', scope: 'comment' }), 'a delete always lands').toMatchObject({ ok: true });
    expect(comments(opened)['c:root']).toMatchObject({ resolvedBy: 'user', reactions: {} });
    expect(comments(opened)['c:reply']).toBeUndefined();

    limits.structCap = STRUCT_CAP;
    expect(await dobj.createComment({ author: 'ada', id: 'second', text: 'On the outro', anchor: anchorOn(opened, 'Outro words') }), 'under the guard again').toMatchObject({ ok: true });
  });

  it('past the headroom a resolve is refused with the structure limit, and a delete still lands', async () => {
    const { Doc, limits } = capped({ structHeadroom: 0 });
    const opened = await note(Doc);
    const { dobj } = opened;
    expect(await dobj.createComment({ author: 'ada', id: 'root', text: 'On the intro', anchor: anchorOn(opened, 'Intro words') })).toMatchObject({ ok: true });
    limits.structCap = (await dobj.noteSize()).structs;
    await expectStructure(opened, () => dobj.resolveComment({ id: 'root', resolved: true, by: 'user' }));
    expect(await dobj.deleteComment({ id: 'root', author: 'ada', scope: 'thread' })).toMatchObject({ ok: true });
    expect(comments(opened)).toEqual({});
  });

  it('a comment adds no body text: a note at its text limit still takes a long comment', async () => {
    const { Doc, limits } = capped();
    const opened = await note(Doc);
    const { dobj } = opened;
    limits.textCharCap = (await dobj.noteSize()).chars;
    const text = 'x'.repeat(5_000);
    expect(await dobj.createComment({ author: 'ada', id: 'root', text, anchor: anchorOn(opened, 'Intro words') })).toMatchObject({ ok: true });
    expect(await dobj.createComment({ author: 'ben', id: 'reply', text, parentId: 'root' })).toMatchObject({ ok: true });
    expect((await dobj.noteSize()).chars).toBe(limits.textCharCap);
  });

  it('a sidecar import keeps only the records that fit under the structure guard, leaving the title room', async () => {
    const ids = ['k0', 'k1', 'k2', 'k3'];
    const markdown = `${ids.map((id) => `%%m:${id}:start%%word ${id}%%m:${id}:end%%`).join(' and ')}.`;
    const sidecar = Object.fromEntries(ids.map((id, i) => [id, { text: `Comment ${id}`, createdAt: i, updatedAt: i, source: 'user' }]));
    const bare = await note(capped().Doc, { markdown, comments: {}, title: 'Imported' });
    const structs = (await bare.dobj.noteSize()).structs;

    const { Doc } = capped({ structCap: structs + 3 });
    const opened = await note(Doc, { markdown, comments: sidecar, title: 'Imported', author: 'importer' });
    const roots = Object.keys(comments(opened)).filter((key) => key.startsWith('c:'));
    expect(roots, 'one root and its anchor fit in three structs').toEqual(['c:k0']);
    expect(comments(opened)['a:k0']).toMatchObject({ status: 'anchored' });
    expect(opened.dobj.document.getText('title').toString(), 'the title still landed').toBe('Imported');
    expect((await opened.dobj.noteSize()).structs).toBeLessThanOrEqual(structs + 3);
  });
});

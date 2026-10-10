// T6.S5 (whole-repo Slop Cop P1; A§14, PRODUCT ruling 18): a restore re-anchors a detached comment only on the item
// the restore brought back for the version's span. A three-way restore keeps a peer's insert made after the base, so
// the version's unit ordinals no longer name the restored item; the comment must land on that item, never on a block
// of the same type or another occurrence of the same text that now sits at the old ordinals.
import { $isParagraphNode, $isTextNode, $getRoot } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as Y from 'yjs';
import { anchorText, liveUnits, mintAnchor, type Anchor } from '@moss-multi/core/anchor-frame';
import { idKey, ordinalsOf } from '@moss-multi/core/comment-units';
import { decodeRelPos } from '@moss-multi/core/tree-anchor';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { openDoc, start, wake, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };

async function note(markdown: string): Promise<{ opened: Opened; ada: LiveClient; ben: LiveClient }> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown });
  const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
  const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
  onTestFinished(() => {
    ada.dispose();
    ben.dispose();
  });
  return { opened, ada, ben };
}

async function settle(...clients: LiveClient[]): Promise<void> {
  await syncAll(...clients);
  await syncAll(...clients);
}

/** Comment `id` on the `nth` occurrence of `quote` in the server's units (a block reads as U+FFFC). */
async function commentOn(opened: Opened, id: string, quote: string, nth: number, kind: Anchor['kind']): Promise<void> {
  const { text, units } = liveUnits(opened.dobj.document);
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = text.indexOf(quote, at + 1);
  if (at < 0) throw new Error(`"${quote}" is not in ${JSON.stringify(text)}`);
  const minted = mintAnchor(units[at], units[at + quote.length - 1], kind);
  const made = await opened.dobj.createComment({ author: 'ada', id, text: `comment ${id}`, anchor: { kind, start: minted.start, end: minted.end } });
  if (!made.ok) throw new Error(`create ${id}: ${made.status} ${made.error}`);
}

const anchorOf = (doc: Y.Doc, id: string) => doc.getMap<Anchor>('comments').get(`a:${id}`);

/** The item an anchored comment starts on, as `client:clock`. */
const startItem = (doc: Y.Doc, id: string): string | null => {
  const item = decodeRelPos(anchorOf(doc, id)!.start).item;
  return item ? idKey(item) : null;
};

/** The first and last unit an anchored comment covers in the live doc. */
function sits(doc: Y.Doc, id: string): [number, number] | null {
  const anchor = anchorOf(doc, id);
  if (anchor?.status !== 'anchored') return null;
  const start = decodeRelPos(anchor.start).item;
  const end = decodeRelPos(anchor.end).item;
  if (!start || !end) return null;
  const ordinals = ordinalsOf(doc, [start, end]);
  const first = ordinals.get(idKey(start));
  const last = ordinals.get(idKey(end));
  return first === undefined || last === undefined ? null : [first, last];
}

async function save(opened: Opened, name: string): Promise<string> {
  const saved = await opened.dobj.saveVersion({ name, reviewer: ADA });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.version.id;
}

/** Sets the one paragraph's text through the client's editor, as typing would (a prefix/suffix splice). */
function edit(client: LiveClient, change: (text: string) => string): void {
  client.editor.update(() => {
    const paragraph = $getRoot().getChildren().find($isParagraphNode);
    const text = paragraph?.getFirstChild();
    if (!$isTextNode(text)) throw new Error('no text');
    text.setTextContent(change(text.getTextContent()));
  }, { discrete: true });
}

describe('a restore re-anchors a detached comment on the item it restored @p:mean-3', () => {
  it('lands a block comment on the restored block, not on the block a peer inserted before it after the base, across a restart', async () => {
    const { opened, ada, ben } = await note('Intro.\n');
    ada.insert('code-block', 'B');
    ada.insert('code-block', 'A');
    await settle(ada, ben);
    expect(ben.texts()).toEqual(['A', 'B']);
    await commentOn(opened, 'c1', '￼', 1, 'block');
    expect(startItem(opened.dobj.document, 'c1'), 'the comment is on B').toBe(ben.elements()[1]);
    const id = await save(opened, 'A and B');

    ada.remove(1);
    await settle(ada, ben);
    expect(anchorOf(opened.dobj.document, 'c1')?.status, 'deleting B detaches its comment').toBe('orphaned');

    const base = captureRestoreBase(ada.doc, ada.payloads);
    ben.insert('code-block', 'C');
    await settle(ben);
    expect(await opened.dobj.restoreVersion({ id, reviewer: ADA, base: { ...base, age: 0 } })).toMatchObject({ ok: true });
    await settle(ben, ada);

    expect(ben.texts(), "the peer's block stays before the restored ones").toEqual(['C', 'A', 'B']);
    const restoredB = ben.elements()[2];
    expect(anchorOf(opened.dobj.document, 'c1')?.status).toBe('anchored');
    expect(startItem(opened.dobj.document, 'c1'), 'the comment is on the restored B').toBe(restoredB);

    const woken = await start(wake(opened));
    expect(anchorOf(woken.dobj.document, 'c1')?.status, 'persisted with the restore').toBe('anchored');
    expect(startItem(woken.dobj.document, 'c1'), 'still on the restored B after a restart').toBe(restoredB);
  });

  it('lands a text comment on the restored occurrence of repeated text, not on one a peer typed before it after the base, across a restart', async () => {
    const { opened, ada, ben } = await note('foo bar foo\n');
    await commentOn(opened, 'c1', 'foo', 1, 'text');
    expect(sits(opened.dobj.document, 'c1')).toEqual([8, 10]);
    const id = await save(opened, 'Two foos');

    edit(ada, () => 'foo bar');
    await settle(ada, ben);
    expect(anchorOf(opened.dobj.document, 'c1')?.status, 'deleting the second foo detaches its comment').toBe('orphaned');

    const base = captureRestoreBase(ada.doc, ada.payloads);
    edit(ben, (text) => `foo bar ${text}`);
    await settle(ben);
    expect(await opened.dobj.restoreVersion({ id, reviewer: ADA, base: { ...base, age: 0 } })).toMatchObject({ ok: true });
    await settle(ben, ada);

    expect(ben.paragraphs()).toEqual(['foo bar foo bar foo']);
    const doc = opened.dobj.document;
    expect(anchorText(doc, anchorOf(doc, 'c1')!)).toBe('foo');
    expect(sits(doc, 'c1'), 'the comment is on the foo the restore brought back, the last one').toEqual([16, 18]);

    const woken = await start(wake(opened));
    expect(sits(woken.dobj.document, 'c1'), 'still there after a restart').toEqual([16, 18]);
  });

  it('leaves a comment detached when the text the restore would put it on was deleted after the base', async () => {
    const { opened, ada, ben } = await note('foo bar foo\n');
    await commentOn(opened, 'c1', 'bar foo', 0, 'text');
    const id = await save(opened, 'Bar foo');

    edit(ada, () => 'foo bar');
    await settle(ada, ben);
    expect(anchorOf(opened.dobj.document, 'c1')?.status).toBe('orphaned');

    const base = captureRestoreBase(ada.doc, ada.payloads);
    edit(ben, (text) => text.replace('bar', ''));
    await settle(ben);
    expect(await opened.dobj.restoreVersion({ id, reviewer: ADA, base: { ...base, age: 0 } })).toMatchObject({ ok: true });
    await settle(ben, ada);

    expect(anchorOf(opened.dobj.document, 'c1')?.status, 'the restored span starts on a word the peer deleted').toBe('orphaned');
    const woken = await start(wake(opened));
    expect(anchorOf(woken.dobj.document, 'c1')?.status).toBe('orphaned');
  });
});

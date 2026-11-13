// The note's limits at every DocDO entry point (A§5.1 Limits; T3.B31c): its text (TEXT_CHAR_CAP, counted over the
// body's text runs and the text of every payload it names) and its structure (STRUCT_CAP, its structs and its named
// payloads'). A write just under a limit lands; one just over is refused whole with that limit, both peers keeping what
// they had; a write that only deletes is always admitted, so a note at a limit, or one stored over it, can be shrunk.
// The caps are shrunk here so each case is small; the `memory` CI job and the API harness hold the real ones.
import { $getRoot, $isParagraphNode, $isTextNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STRUCT_CAP, TEXT_CHAR_CAP } from '@moss-multi/protocol/limits';
import { CLOSE } from '@moss-multi/protocol/sync';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { blockTypes, Backing, openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A DocDO class whose limits are `caps` over the defaults; the returned object can be changed between writes. */
function capped(caps: Record<string, number>): { Doc: typeof DocDO; limits: DocLimits } {
  const limits = { ...DocDO.limits, ...caps } as DocLimits;
  class Capped extends DocDO {
    static override limits = limits;
  }
  return { Doc: Capped, limits };
}

const structsOf = (doc: Y.Doc): number => [...doc.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0);
const refusals = (client: LiveClient) => client.socket.events.filter((event) => event.t === 'write-refused');

async function opened(Doc: typeof DocDO, backing = new Backing()): Promise<Opened> {
  return start(openDoc(backing, Doc as never));
}

/** Deletes `count` characters from the start of the paragraph that starts with `prefix`. */
function erase(client: LiveClient, prefix: string, count: number): void {
  client.editor.update(() => {
    const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith(prefix));
    const text = $isParagraphNode(paragraph) ? paragraph.getFirstChild() : null;
    if (!$isTextNode(text)) throw new Error(`no paragraph ${prefix}`);
    text.spliceText(0, count, '');
  }, { discrete: true });
}

function removeParagraph(client: LiveClient, prefix: string): void {
  client.editor.update(() => {
    $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith(prefix))?.remove();
  }, { discrete: true });
}

/** `write` is refused whole with `limit`: the writer's socket closes 4409, and the server and the peer keep what they had. */
async function expectRefused(doc: Opened, writer: LiveClient, peer: LiveClient, limit: 'text' | 'structure', write: () => void): Promise<void> {
  const exported = await doc.dobj.exportMarkdown();
  const seen = peer.paragraphs();
  const texts = peer.texts();
  write();
  await writer.up();
  await writer.socket.pump();
  expect(refusals(writer), `refused with the ${limit} limit`).toContainEqual({ t: 'write-refused', reason: 'doc-cap', limit });
  expect(writer.socket.closed?.code).toBe(CLOSE.writeRefused);
  expect(await doc.dobj.exportMarkdown(), 'the server keeps what it had').toBe(exported);
  await peer.down();
  expect(peer.paragraphs(), 'and so does the peer').toEqual(seen);
  expect(peer.texts()).toEqual(texts);
}

describe('the limits', () => {
  it('are 1,020,000 characters of text and 165,000 structs (owner ruling 2026-10-28; coordinator ruling 2026-11-13)', () => {
    expect(TEXT_CHAR_CAP).toBe(1_020_000);
    expect(STRUCT_CAP).toBe(165_000);
    expect(DocDO.limits).toMatchObject({ textCharCap: 1_020_000, structCap: 165_000 });
  });
});

describe('socket frames', () => {
  it('typing can no longer grow a note past the text limit: a keystroke up to it lands, the next is refused whole with the text limit', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insertParagraph(`Note ${'a'.repeat(990)}`);
      await syncAll(ada, ben);
      ada.appendToParagraph('Note', 'bbbbb');
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'up to the limit lands').toBeNull();
      expect(ben.paragraphs()).toContain(`Note ${'a'.repeat(990)}bbbbb`);
      await expectRefused(doc, ada, ben, 'text', () => ada.appendToParagraph('Note', 'c'));
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a payload the note names counts toward its text: typing into a code block past the limit is refused whole', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insert('code-block', 'x'.repeat(600));
      await syncAll(ada, ben);
      ada.type(0, 600, 'y'.repeat(400));
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'up to the limit lands').toBeNull();
      expect(ben.texts()).toEqual([`${'x'.repeat(600)}${'y'.repeat(400)}`]);
      await expectRefused(doc, ada, ben, 'text', () => ada.type(0, 0, 'z'));
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a deleted block\'s text no longer counts, and an undo that would name it again past the limit is refused whole', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insert('code-block', 'x'.repeat(800));
      await syncAll(ada, ben);
      ada.remove(0);
      await syncAll(ada, ben);
      ben.insertParagraph(`Ben ${'p'.repeat(896)}`);
      await syncAll(ben, ada);
      expect(ben.socket.closed, 'room freed by the delete').toBeNull();
      await expectRefused(doc, ada, ben, 'text', () => ada.undo.undo());
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a paragraph within the structure limit lands; one past it is refused whole with the structure limit', async () => {
    const { Doc, limits } = capped({});
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insertParagraph('One');
      await syncAll(ada, ben);
      limits.structCap = structsOf(doc.dobj.document) + 40;
      ada.insertParagraph('Two');
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'within the limit lands').toBeNull();
      limits.structCap = structsOf(doc.dobj.document) + 2;
      await expectRefused(doc, ada, ben, 'structure', () => ada.insertParagraph('Three'));
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a note at each limit accepts a deletion', async () => {
    const { Doc, limits } = capped({ textCharCap: 1_000 });
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insertParagraph(`Full ${'a'.repeat(995)}`);
      await syncAll(ada, ben);
      expect(ada.socket.closed).toBeNull();
      // At the text limit (1,000) and, with the cap set to what it holds, at the structure limit.
      limits.structCap = structsOf(doc.dobj.document);
      erase(ada, 'Full', 10);
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'a deletion at both limits lands').toBeNull();
      expect(ben.paragraphs()).toContain(`${'a'.repeat(990)}`);
      removeParagraph(ada, 'aaa');
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'so does removing a block').toBeNull();
      expect(await doc.dobj.exportMarkdown()).not.toContain('aaa');
    } finally { ada.dispose(); ben.dispose(); }
  });
});

describe('create and import', () => {
  const input = { folderId: 'folder', ownerId: 'owner' };

  it('markdown up to the text limit lands; one character more is refused whole with the text limit, leaving the seed', async () => {
    const { Doc } = capped({ textCharCap: 1_000 });
    const under = await opened(Doc);
    await under.dobj.create({ ...input, markdown: 'a'.repeat(1_000) });
    expect(await under.dobj.exportMarkdown()).toContain('a'.repeat(1_000));
    const over = await opened(Doc);
    await expect(over.dobj.create({ ...input, markdown: 'a'.repeat(1_001) })).rejects.toThrow('doc-cap:text');
    expect(blockTypes(over.dobj.document)).toEqual(['paragraph']);
    expect((await over.dobj.exportMarkdown()).trim()).toBe('');
  });

  it('counts a code block\'s text as the note\'s', async () => {
    const { Doc } = capped({ textCharCap: 1_000 });
    const over = await opened(Doc);
    await expect(over.dobj.create({ ...input, markdown: `${'a'.repeat(500)}\n\n\`\`\`js\n${'b'.repeat(520)}\n\`\`\`` })).rejects.toThrow('doc-cap:text');
    const under = await opened(Doc);
    await under.dobj.create({ ...input, markdown: `${'a'.repeat(500)}\n\n\`\`\`js\n${'b'.repeat(400)}\n\`\`\`` });
    expect(await under.dobj.exportMarkdown()).toContain('b'.repeat(400));
  });

  it('markdown within the structure limit lands; past it is refused whole with the structure limit', async () => {
    const { Doc } = capped({ structCap: 400 });
    const lines = (count: number) => Array.from({ length: count }, (_, i) => `Line ${i}`).join('\n\n');
    const under = await opened(Doc);
    await under.dobj.create({ ...input, markdown: lines(50) });
    expect(await under.dobj.exportMarkdown()).toContain('Line 49');
    const over = await opened(Doc);
    await expect(over.dobj.create({ ...input, markdown: lines(100) })).rejects.toThrow('doc-cap:structure');
    expect(blockTypes(over.dobj.document)).toEqual(['paragraph']);
  });
});

describe('duplicate', () => {
  it('a copy is held to the limits too: a source within them copies, one stored over them is refused whole', async () => {
    const { Doc } = capped({ textCharCap: 1_000 });
    for (const [length, lands] of [[900, true], [1_100, false]] as const) {
      const source = await opened(DocDO);
      await source.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: 'a'.repeat(length) });
      const snapshot = await source.dobj.snapshotForDuplicate();
      const copy = await opened(Doc);
      const made = copy.dobj.createFromSnapshot({ folderId: 'folder', ownerId: 'owner', title: 'Copy' }, snapshot.state, snapshot.payloads);
      if (lands) {
        await made;
        expect(await copy.dobj.exportMarkdown()).toContain('a'.repeat(length));
      } else {
        await expect(made).rejects.toThrow('doc-cap:text');
        expect(blockTypes(copy.dobj.document)).toEqual(['paragraph']);
      }
    }
  });
});

describe('a note stored over a limit', () => {
  it('opens and exports, takes deletions, and refuses every write that grows it', async () => {
    const backing = new Backing();
    const first = await opened(DocDO, backing);
    await first.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: `Over ${'a'.repeat(1_095)}` });
    first.state.alive = false;
    vi.clearAllTimers();
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc, backing);
    expect(await doc.dobj.exportMarkdown()).toContain('a'.repeat(1_095));
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      erase(ada, 'Over', 50);
      await syncAll(ada, ben);
      expect(ada.socket.closed, 'a deletion lands though the note is still over').toBeNull();
      await expectRefused(doc, ada, ben, 'text', () => ada.appendToParagraph('aaa', 'b'));
    } finally { ada.dispose(); ben.dispose(); }
  });
});

// The note's limits at every DocDO entry point (A§5.1 Limits; T3.B31c): its text (TEXT_CHAR_CAP, counted over the
// body's text runs and the text of every payload it names) and its structure (STRUCT_CAP, its structs and its named
// payloads'). A write just under a limit lands; one just over is refused whole with that limit, both peers keeping what
// they had; a write that only deletes is admitted up to the structure headroom, or whenever it adds no struct, so a
// note at a limit, or one stored over it, can be shrunk.
// The caps are shrunk here so each case is small; the `memory` CI job and the API harness hold the real ones.
import { $getRoot, $isParagraphNode, $isTextNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STRUCT_CAP, STRUCT_HEADROOM, TEXT_CHAR_CAP } from '@moss-multi/protocol/limits';
import { CLOSE } from '@moss-multi/protocol/sync';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { withDeletes } from './crafted.ts';
import { blockTypes, Backing, connect, openDoc, start, syncFrame, wake, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** A DocDO class whose limits are `caps` over the defaults; the returned object can be changed between writes. */
function capped(caps: Record<string, unknown>): { Doc: typeof DocDO; limits: DocLimits } {
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

  it('a crafted frame listing one delete range twice is counted as it applies: past the text limit it is refused whole', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    try {
      ada.insertParagraph(`Full ${'a'.repeat(995)}`);
      await ada.sync();
      const exported = await doc.dobj.exportMarkdown();
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.dobj.document));
      const run = [...copy.store.clients.values()].flat()
        .find((struct) => struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentString && struct.length >= 995) as Y.Item;
      const before = Y.encodeStateVector(copy);
      const paragraph = run.parent as Y.XmlText;
      paragraph.insert(paragraph.length, 'b'.repeat(200));
      // 200 characters in, and the same 100 out twice: 100 more in all, which the estimate must see.
      const frame = withDeletes(Y.encodeStateAsUpdate(copy, before), [[run.id.client, run.id.clock + 10, 100], [run.id.client, run.id.clock + 10, 100]]);
      const eve = await connect(doc, { id: 'eve' });
      await eve.deliver(syncFrame(2, frame));
      await eve.pump();
      expect(eve.events, 'refused with the text limit').toContainEqual({ t: 'write-refused', reason: 'doc-cap', limit: 'text' });
      expect(await doc.dobj.exportMarkdown(), 'the server keeps what it had').toBe(exported);
      expect((await doc.dobj.noteSize()).chars).toBe(1_000);
    } finally { ada.dispose(); }
  });

  it('a frame that turns an element already naming a stored payload into a payload\'s counts that payload: past the text limit it is refused whole', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ben.insertParagraph(`Body ${'p'.repeat(495)}`);
      await syncAll(ben, ada);
      ada.insert('code-block', 'x'.repeat(450));
      await syncAll(ada, ben);
      const [id] = ada.ids();
      ada.remove(0);
      await syncAll(ada, ben);
      // Ada's own payload, unnamed now: an element of another type names its id, which counts nothing.
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.dobj.document));
      const element = new Y.XmlElement('horizontalrule');
      let before = Y.encodeStateVector(copy);
      copy.transact(() => {
        element.setAttribute('__type', 'horizontalrule');
        element.setAttribute('__regId', id);
        const root = copy.get('root', Y.XmlText);
        root.insertEmbed(root.length, element);
      });
      const raw = await connect(doc, { id: 'ada' });
      await raw.deliver(syncFrame(2, Y.encodeStateAsUpdate(copy, before)));
      await raw.pump();
      expect(raw.closed, 'an element of another type lands').toBeNull();
      ben.appendToParagraph('Body', 'q'.repeat(100));
      await syncAll(ben, ada);
      expect(ben.socket.closed, 'the payload it names does not count').toBeNull();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.dobj.document, Y.encodeStateVector(copy)));
      before = Y.encodeStateVector(copy);
      element.setAttribute('__type', 'code-block');
      const exported = await doc.dobj.exportMarkdown();
      await raw.deliver(syncFrame(2, Y.encodeStateAsUpdate(copy, before)));
      await raw.pump();
      expect(raw.events, 'naming the payload counts its 450 characters').toContainEqual({ t: 'write-refused', reason: 'doc-cap', limit: 'text' });
      expect(await doc.dobj.exportMarkdown(), 'the server keeps what it had').toBe(exported);
      expect((await doc.dobj.noteSize()).chars).toBe(600);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('one update that deletes a code block and types elsewhere is counted without the block: at the text limit it lands', async () => {
    const doc = await opened(capped({ textCharCap: 1_000 }).Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insert('code-block', 'x'.repeat(800));
      await syncAll(ada, ben);
      ada.insertParagraph(`Ada ${'p'.repeat(196)}`);
      await syncAll(ada, ben);
      expect((await doc.dobj.noteSize()).chars).toBe(1_000);
      ada.editor.update(() => {
        for (const node of $getRoot().getChildren()) if (node.getType() === 'code-block') node.remove();
        const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith('Ada'));
        const text = $isParagraphNode(paragraph) ? paragraph.getFirstChild() : null;
        if ($isTextNode(text)) text.setTextContent(`${text.getTextContent()}q`);
      }, { discrete: true });
      await syncAll(ada, ben);
      expect(refusals(ada), 'the block\'s text leaves with it').toEqual([]);
      expect(ben.texts()).toEqual([]);
      expect(ben.paragraphs()).toContain(`Ada ${'p'.repeat(196)}q`);
      expect((await doc.dobj.noteSize()).chars).toBe(201);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a format removal at the structure limit lands; adding a line there is still refused', async () => {
    const { Doc, limits } = capped({});
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    const format = (value: number) => ada.editor.update(() => {
      const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith('Bold'));
      const text = $isParagraphNode(paragraph) ? paragraph.getFirstChild() : null;
      if (!$isTextNode(text)) throw new Error('no paragraph Bold');
      text.setFormat(value);
    }, { discrete: true });
    try {
      ada.insertParagraph('Bold words');
      format(1);
      await syncAll(ada, ben);
      limits.structCap = (await doc.dobj.noteSize()).structs;
      format(0);
      await syncAll(ada, ben);
      expect(refusals(ada), 'the removal lands at the limit').toEqual([]);
      expect(await doc.dobj.exportMarkdown()).not.toContain('**Bold words**');
      await expectRefused(doc, ada, ben, 'structure', () => ada.insertParagraph('More'));
    } finally { ada.dispose(); ben.dispose(); }
  });
});

/** Deletes the one character at `offset` of the paragraph that starts with `prefix`. */
function eraseAt(client: LiveClient, prefix: string, offset: number): void {
  client.editor.update(() => {
    const paragraph = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent().startsWith(prefix));
    const text = $isParagraphNode(paragraph) ? paragraph.getFirstChild() : null;
    if (!$isTextNode(text)) throw new Error(`no paragraph ${prefix}`);
    text.spliceText(offset, 1, '');
  }, { discrete: true });
}

/**
 * Sends `deletion(n)` for n = 0, 1, … one frame each, until the DocDO refuses one: each that lands keeps the note at or
 * under `ceiling`, and the one refused is refused whole with the structure limit, past the ceiling, the server and the
 * peer keeping what they had. Returns how many landed.
 */
async function deleteUntilRefused(doc: Opened, writer: LiveClient, peer: LiveClient, ceiling: number, deletion: (n: number) => void): Promise<number> {
  for (let n = 0; n < 100; n += 1) {
    const before = (await doc.dobj.noteSize()).structs;
    const exported = await doc.dobj.exportMarkdown();
    const [paragraphs, texts] = [peer.paragraphs(), peer.texts()];
    deletion(n);
    await writer.up();
    await writer.socket.pump();
    if (refusals(writer).length) {
      expect(refusals(writer), 'refused with the structure limit').toEqual([{ t: 'write-refused', reason: 'doc-cap', limit: 'structure' }]);
      expect(writer.socket.closed?.code).toBe(CLOSE.writeRefused);
      expect(before + 2, 'refused only once it would pass the headroom').toBeGreaterThan(ceiling);
      expect(await doc.dobj.exportMarkdown(), 'the server keeps what it had').toBe(exported);
      expect((await doc.dobj.noteSize()).structs).toBe(before);
      await peer.down();
      expect(peer.paragraphs(), 'and so does the peer').toEqual(paragraphs);
      expect(peer.texts()).toEqual(texts);
      return n;
    }
    await syncAll(writer, peer);
    expect((await doc.dobj.noteSize()).structs, `deletion ${n} keeps the note within the headroom`).toBeLessThanOrEqual(ceiling);
  }
  throw new Error('no deletion was refused');
}

describe('deletions (coordinator ruling 2)', () => {
  it('the headroom is 5% of the structure limit, one constant for deletions and for formats and properties', () => {
    expect(STRUCT_HEADROOM).toBe(8_250);
    expect(DocDO.limits).toMatchObject({ structHeadroom: STRUCT_HEADROOM });
  });

  it('scattered one-character deletions in a note at the structure limit land up to the headroom, then are refused whole; the note still opens, saves and exports', async () => {
    const { Doc, limits } = capped({ structHeadroom: 20 });
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insertParagraph(`Long ${'abcdefghij'.repeat(40)}`);
      await syncAll(ada, ben);
      limits.structCap = (await doc.dobj.noteSize()).structs;
      // Each deletion inside the run splits it twice: ten fit the headroom of 20.
      const landed = await deleteUntilRefused(doc, ada, ben, limits.structCap + 20, (n) => eraseAt(ada, 'Long', 400 - n * 9));
      expect(landed).toBe(10);
    } finally { ada.dispose(); ben.dispose(); }
    await doc.dobj.onSave();
    const woken = await start(wake(doc));
    expect((await woken.dobj.noteSize()).structs).toBeLessThanOrEqual(limits.structCap + 20);
    expect(await woken.dobj.exportMarkdown()).toContain('Long abcdefghij');
  });

  it('the same holds for a payload\'s text: scattered deletions in a code block land up to the headroom, then are refused whole', async () => {
    const { Doc, limits } = capped({ structHeadroom: 20 });
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insert('code-block', 'abcdefghij'.repeat(40));
      await syncAll(ada, ben);
      limits.structCap = (await doc.dobj.noteSize()).structs;
      const landed = await deleteUntilRefused(doc, ada, ben, limits.structCap + 20, (n) => ada.erase(0, 395 - n * 9, 1));
      expect(landed).toBe(10);
    } finally { ada.dispose(); ben.dispose(); }
    await doc.dobj.onSave();
    expect(await (await start(wake(doc))).dobj.exportMarkdown()).toContain('abcdefghij');
  });

  it('deleting a 10,000-character run one character at a time from its end never raises the count, and lands in a note at the ceiling', async () => {
    const { Doc, limits } = capped({ structHeadroom: 20, writeRate: { max: 100_000, windowMs: 5_000 } });
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    try {
      ada.insertParagraph(`Run ${'r'.repeat(9_996)}`);
      await ada.sync();
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc.dobj.document));
      const run = [...copy.store.clients.values()].flat()
        .find((struct) => struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentString && struct.length === 10_000) as Y.Item;
      const paragraph = run.parent as Y.XmlText;
      const frames: Uint8Array[] = [];
      copy.on('update', (update: Uint8Array) => frames.push(update));
      const eve = await connect(doc, { id: 'eve' });
      // The first deletion splits the run once; the note is then at the ceiling, and each deletion after it merges.
      paragraph.delete(paragraph.length - 1, 1);
      await eve.deliver(syncFrame(2, frames.shift()!));
      await eve.pump();
      const ceiling = (await doc.dobj.noteSize()).structs;
      limits.structCap = ceiling - 20;
      for (let left = 9_999; left > 0; left -= 1) {
        paragraph.delete(paragraph.length - 1, 1);
        await eve.deliver(syncFrame(2, frames.shift()!));
        if (left % 500 === 0) await eve.pump();
      }
      await eve.pump();
      expect(eve.events.filter((event) => event.t === 'write-refused'), 'every deletion lands').toEqual([]);
      expect(eve.closed).toBeNull();
      expect((await doc.dobj.noteSize()).structs, 'and the count never rose').toBeLessThanOrEqual(ceiling);
      expect(await doc.dobj.exportMarkdown()).not.toContain('Run');
    } finally { ada.dispose(); }
  });

  it('deleting whole paragraphs never raises the count, and lands in a note at the ceiling', async () => {
    const { Doc, limits } = capped({ structHeadroom: 20 });
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      for (let i = 0; i < 10; i += 1) ada.insertParagraph(`Para ${i} words`);
      await syncAll(ada, ben);
      const ceiling = (await doc.dobj.noteSize()).structs;
      limits.structCap = ceiling - 20;
      for (const i of [3, 7, 0]) {
        const before = (await doc.dobj.noteSize()).structs;
        removeParagraph(ada, `Para ${i} `);
        await syncAll(ada, ben);
        expect(refusals(ada), `removing paragraph ${i} lands`).toEqual([]);
        expect((await doc.dobj.noteSize()).structs).toBeLessThanOrEqual(before);
      }
      expect(ben.paragraphs().filter((text) => text.startsWith('Para'))).toHaveLength(7);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a note stored over the ceiling accepts a whole-block deletion and refuses a scattered one', async () => {
    const backing = new Backing();
    const first = await opened(DocDO, backing);
    await first.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: Array.from({ length: 30 }, (_, i) => `Line ${i} ${'w'.repeat(40)}`).join('\n\n') });
    const stored = (await first.dobj.noteSize()).structs;
    first.state.alive = false;
    vi.clearAllTimers();
    const doc = await opened(capped({ structCap: stored - 40, structHeadroom: 20 }).Doc, backing);
    expect(await doc.dobj.exportMarkdown()).toContain('Line 29');
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      removeParagraph(ada, 'Line 4 ');
      await syncAll(ada, ben);
      expect(refusals(ada), 'a whole-block deletion lands').toEqual([]);
      expect(await doc.dobj.exportMarkdown()).not.toContain('Line 4 ');
      await expectRefused(doc, ada, ben, 'structure', () => eraseAt(ada, 'Line 9 ', 20));
    } finally { ada.dispose(); ben.dispose(); }
  });
});

describe('payload frames', () => {
  it('a deletion inside a code block lands in a note stored past the byte cap; typing there is refused', async () => {
    const { Doc, limits } = capped({});
    const doc = await opened(Doc);
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    try {
      ada.insert('code-block', 'x'.repeat(600));
      await syncAll(ada, ben);
      limits.stateCapBytes = 100;
      ada.erase(0, 0, 100);
      await syncAll(ada, ben);
      expect(refusals(ada), 'the deletion lands').toEqual([]);
      expect(ben.texts()).toEqual(['x'.repeat(500)]);
      ada.type(0, 0, 'z');
      await ada.up();
      await ada.socket.pump();
      expect(refusals(ada), 'typing is refused').toContainEqual({ t: 'write-refused', reason: 'doc-cap' });
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

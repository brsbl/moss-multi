// T3.B32 in the DocDO harness: a large paste cut short by a limit leaves nothing behind. The DocDO admits each of the
// paste's frames on its own (no reservation, A§5.1), so another writer can fill the room while its later frames are on
// the way; the pasting tab then deletes the paste's landed blocks whole, in delete-only batches of whole blocks the
// DocDO admits at any limit, and the exact run it inserted into a line it did not make. The paste's own deletes (a
// selection it replaced) are held back until all of it has landed, so a cut one deleted nothing. A pasted block
// another writer wrote into, or into its payload, stays whole. A peer's bound editor follows the rollback. The browser
// side (the record, holding the deletes back, the resume, the notice) is in doc-session.test and j01-paste-tail.
import * as decoding from 'lib0/decoding';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isParagraphNode, $isTextNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STRUCT_CAP } from '@moss-multi/protocol/limits';
import { CLOSE, encodeSyncFrame } from '@moss-multi/protocol/sync';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { payloadText } from '../../src/payload-docs.ts';
import { Backing, openDoc, start, type Opened } from './do-harness.ts';
import { heldText, LiveClient, syncAll } from './live-client.ts';

type Rollback = typeof import('../../src/paste-rollback.ts');
const rollback: Rollback | null = await import('../../src/paste-rollback.ts').catch(() => null);
/** The rollback module, or a failed assertion naming it. */
function use(): Rollback {
  expect(rollback, 'the paste rollback (packages/sync/src/paste-rollback.ts)').not.toBeNull();
  return rollback as Rollback;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ROLLBACK = Symbol('rollback');
const structsOf = (doc: Y.Doc): number => [...doc.store.clients.values()].reduce((sum, structs) => sum + structs.length, 0);

function capped(): { Doc: typeof DocDO; limits: DocLimits } {
  const limits = { ...DocDO.limits };
  class Capped extends DocDO {
    static override limits = limits;
  }
  return { Doc: Capped, limits };
}

interface Cut {
  doc: Opened;
  limits: DocLimits;
  ben: LiveClient;
  record: import('../../src/paste-rollback.ts').PasteRecord;
  payloadId: string;
  /** Ben's paragraphs before Ada's paste. */
  before: string[];
}

/**
 * Ada pastes a code block and 240 paragraphs in six batches, each its own update; three of her frames land, then Ben
 * writes five lines and the note is at the structure guard, so the rest is refused. Her tab is gone; the record of
 * her paste's items is what it stored.
 */
async function cutPaste(): Promise<Cut> {
  const { Doc, limits } = capped();
  const doc = await start(openDoc(new Backing(), Doc as never));
  const ada = await LiveClient.open(doc, { id: 'ada' });
  const ben = await LiveClient.open(doc, { id: 'ben' });
  ada.insertParagraph('Kept.');
  await syncAll(ada, ben);
  const before = ben.paragraphs();
  const client = ada.doc.clientID;
  const from = Y.getState(ada.doc.store, client);
  ada.insert('code-block', 'print(1)');
  await ada.settle();
  for (let b = 0; b < 6; b += 1) {
    ada.editor.update(() => {
      for (let i = 0; i < 40; i += 1) $getRoot().append($createParagraphNode().append($createTextNode(`Alpha ${b}-${i}.`)));
    }, { discrete: true });
  }
  await ada.settle();
  const payloadId = ada.ids()[0];
  const code = ada.payloads.get(payloadId)!;
  const record = {
    note: { client, from, to: Y.getState(ada.doc.store, client) },
    payloads: { [payloadId]: { client: code.clientID, from: 0, to: Y.getState(code.store, code.clientID) } },
  };
  const frames = ada.socket.drain();
  expect(frames.length, 'the paste goes in several frames').toBeGreaterThan(4);
  for (const frame of frames.slice(0, 3)) await ada.socket.deliver(frame);
  for (let i = 0; i < 5; i += 1) ben.insertParagraph(`Bravo ${i}.`);
  await syncAll(ben);
  expect(ben.socket.closed, "Ben's lines fit beside what landed").toBeNull();
  limits.structCap = structsOf(doc.dobj.document);
  for (const frame of frames.slice(3)) if (ada.socket.socket.readyState === 1) await ada.socket.deliver(frame);
  await ada.socket.pump();
  expect(ada.socket.events).toContainEqual({ t: 'write-refused', reason: 'doc-cap', limit: 'structure' });
  expect(ada.socket.closed?.code).toBe(CLOSE.writeRefused);
  const landed = await doc.dobj.exportMarkdown();
  expect(landed, 'the paste is cut short').toContain('Alpha 0-0.');
  expect(landed).not.toContain('Alpha 5-39.');
  ada.dispose();
  return { doc, limits, ben, record, payloadId, before };
}

/** Ada's next binding (a fresh doc and socket) applies the rollback, its updates queued but not sent. */
async function rollingBack(cut: Cut, maxStructs: number): Promise<{ again: LiveClient; frames: Uint8Array[]; kept: number }> {
  const { rollBackPaste } = use();
  const again = await LiveClient.open(cut.doc, { id: 'ada' });
  const code = again.payloads.get(cut.payloadId);
  expect(code, 'the landed code block is named, so its doc arrives').toBeDefined();
  const result = rollBackPaste(again.doc, cut.record.note, [[cut.payloadId, code!, cut.record.payloads[cut.payloadId]]], ROLLBACK, maxStructs) as
    { updates: number; kept: number } | number;
  const { updates, kept } = typeof result === 'number' ? { updates: result, kept: -1 } : result;
  expect(updates, 'in several batches').toBeGreaterThan(2);
  again.flush();
  return { again, frames: again.socket.drain(), kept };
}

/** The whole tree a client's editor shows: each top-level block's type and text. */
function tree(client: LiveClient): string[] {
  client.flush();
  return client.editor.getEditorState().read(() => $getRoot().getChildren().map((node) => `${node.getType()}:${node.getTextContent()}`));
}

/** What a fresh binding of the server's copy shows (a reload, or the export's view). */
async function fresh(cut: Cut): Promise<string[]> {
  const reader = await LiveClient.open(cut.doc, { id: 'cy' });
  try {
    return tree(reader);
  } finally { reader.dispose(); }
}

const nothingPasted = (paragraphs: string[]) => paragraphs.filter((text) => /Alpha|print/.test(text));

describe('a cut paste rolled back (T3.B32)', () => {
  it('leaves the note as it was before the paste plus the other writer\'s lines, its code block\'s text too; every batch is admitted at the structure guard and both peers converge', async () => {
    const cut = await cutPaste();
    const { again, frames } = await rollingBack(cut, 40);
    try {
      expect(structsOf(cut.doc.dobj.document), 'the note is at the guard').toBeGreaterThanOrEqual(cut.limits.structCap);
      for (const frame of frames) {
        await again.socket.deliver(frame);
        expect(again.socket.closed, 'a deletion is admitted at the limit').toBeNull();
      }
      await syncAll(again, cut.ben);
      expect(again.socket.events.filter((event) => event.t === 'write-refused')).toEqual([]);
      const server = await cut.doc.dobj.exportMarkdown();
      expect(server).not.toMatch(/Alpha|print/);
      expect(nothingPasted(cut.ben.paragraphs())).toEqual([]);
      expect(cut.ben.paragraphs()).toEqual(again.paragraphs());
      expect(cut.ben.paragraphs().filter((text) => !text.startsWith('Bravo')), 'the note before the paste').toEqual(cut.before);
      expect(cut.ben.paragraphs().filter((text) => text.startsWith('Bravo'))).toHaveLength(5);
      expect(again.ids(), 'no code block').toEqual([]);
      expect(payloadText(again.payloads.get(cut.payloadId)!).toString(), 'its payload doc is left as it was, unnamed').toBe('print(1)');
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  it('deletes only whole top-level blocks, the last first, each batch whole blocks', async () => {
    const { rollbackUpdates } = use();
    const cut = await cutPaste();
    const again = await LiveClient.open(cut.doc, { id: 'ada' });
    try {
      const root = again.doc.get('root', Y.XmlText);
      const order = new Map<Y.Item, number>();
      let at = 0;
      for (let item = root._start; item; item = item.right) order.set(item, at++);
      const updates = rollbackUpdates(again.doc, cut.record.note, 40);
      expect(updates.length, 'in several batches').toBeGreaterThan(2);
      const positions = updates.map((update) => {
        const { structs, ds } = Y.decodeUpdate(update);
        expect(structs, 'delete-only').toEqual([]);
        const deleted: number[] = [];
        ds.clients.forEach((items, client) => {
          for (const { clock, len } of items) {
            for (let c = clock; c < clock + len; c += 1) {
              const item = Y.getItem(again.doc.store, Y.createID(client, c)) as Y.Item;
              expect(item.parent, 'a top-level block, never a part of one').toBe(root);
              deleted.push(order.get(item)!);
            }
          }
        });
        return deleted.sort((a, b) => a - b);
      });
      for (let i = 1; i < positions.length; i += 1) {
        expect(positions[i].at(-1)!, 'each batch before the one before it').toBeLessThan(positions[i - 1][0]);
      }
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  it("a peer's bound editor shows exactly what the server holds after the rollback, with no error", async () => {
    const cut = await cutPaste();
    expect(tree(cut.ben).some((line) => line.includes('Alpha')), 'Ben sees the part that landed').toBe(true);
    const { again, frames } = await rollingBack(cut, 7);
    try {
      for (const frame of frames) {
        await again.socket.deliver(frame);
        await syncAll(cut.ben);
      }
      await syncAll(again, cut.ben);
      expect(cut.ben.errors, "no error in Ben's editor").toEqual([]);
      const shown = tree(cut.ben);
      expect(shown.filter((line) => /Alpha|print/.test(line))).toEqual([]);
      expect(shown, "Ben's editor equals the server's copy").toEqual(await fresh(cut));
      expect(tree(again)).toEqual(shown);
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  it('converges when a third writer edits the note while the rollback\'s deletes are on their way', async () => {
    const cut = await cutPaste();
    // Room again (the guard counts deleted structs too): the race is about convergence.
    cut.limits.structCap = STRUCT_CAP;
    const cy = await LiveClient.open(cut.doc, { id: 'cy' });
    const { again, frames } = await rollingBack(cut, 40);
    try {
      await again.socket.deliver(frames[0]);
      cy.appendToParagraph('Kept.', ' And Cy.');
      cy.insertParagraph('Charlie.');
      await syncAll(cy);
      for (const frame of frames.slice(1)) await again.socket.deliver(frame);
      await syncAll(again, cut.ben, cy);
      await syncAll(again, cut.ben, cy);
      expect(again.socket.closed).toBeNull();
      expect(cy.socket.closed).toBeNull();
      const held = cut.ben.paragraphs();
      expect(cy.paragraphs()).toEqual(held);
      expect(again.paragraphs()).toEqual(held);
      expect(nothingPasted(held)).toEqual([]);
      expect(held).toContain('Kept. And Cy.');
      expect(held).toContain('Charlie.');
      expect(await cut.doc.dobj.exportMarkdown()).not.toMatch(/Alpha|print/);
    } finally { again.dispose(); cut.ben.dispose(); cy.dispose(); }
  });

  it('an interrupted rollback, run again from its record by a fresh binding, finishes', async () => {
    const cut = await cutPaste();
    const { again, frames } = await rollingBack(cut, 40);
    await again.socket.deliver(frames[0]);
    await again.socket.drop();
    again.dispose();
    expect(await cut.doc.dobj.exportMarkdown(), 'only part of the rollback landed').toMatch(/Alpha/);
    // The note reopened in the same profile: the record is still there, and the rollback runs again in full.
    const { again: third, frames: rest } = await rollingBack(cut, 40);
    try {
      for (const frame of rest) await third.socket.deliver(frame);
      await syncAll(third, cut.ben);
      expect(third.socket.closed).toBeNull();
      expect(nothingPasted(cut.ben.paragraphs())).toEqual([]);
      expect(cut.ben.paragraphs()).toEqual(third.paragraphs());
      expect(await cut.doc.dobj.exportMarkdown()).not.toMatch(/Alpha|print/);
    } finally { third.dispose(); cut.ben.dispose(); }
  });

  it('keeps a landed pasted line another writer typed into whole, and removes the rest of the paste', async () => {
    const cut = await cutPaste();
    cut.limits.structCap = STRUCT_CAP;
    await syncAll(cut.ben);
    cut.ben.appendToParagraph('Alpha 0-0.', ' Ben was here.');
    await syncAll(cut.ben);
    const { again, frames, kept } = await rollingBack(cut, 40);
    try {
      for (const frame of frames) await again.socket.deliver(frame);
      await syncAll(again, cut.ben);
      await syncAll(again, cut.ben);
      expect(again.socket.closed).toBeNull();
      expect(kept, 'one block kept').toBe(1);
      const held = cut.ben.paragraphs();
      expect(nothingPasted(held), 'the line he typed into stays whole, and nothing else of the paste').toEqual(['Alpha 0-0. Ben was here.']);
      expect(again.paragraphs()).toEqual(held);
      expect(tree(cut.ben)).toEqual(await fresh(cut));
      const server = await cut.doc.dobj.exportMarkdown();
      expect(server).toContain('Alpha 0-0. Ben was here.');
      expect(server).not.toMatch(/Alpha 0-1\.|print/);
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  it('keeps a landed pasted code block another writer typed into whole, its pasted code too', async () => {
    const { rollBackPaste } = use();
    expect(rollBackPaste, 'a whole paste rolled back, its payload docs with it').toBeTypeOf('function');
    const cut = await cutPaste();
    cut.limits.structCap = STRUCT_CAP;
    await syncAll(cut.ben);
    expect(cut.ben.ids(), 'the pasted code block reached Ben').toEqual([cut.payloadId]);
    cut.ben.type(0, 0, 'ben();');
    await syncAll(cut.ben);
    const again = await LiveClient.open(cut.doc, { id: 'ada' });
    try {
      const code = again.payloads.get(cut.payloadId)!;
      const result = rollBackPaste(again.doc, cut.record.note, [[cut.payloadId, code, cut.record.payloads[cut.payloadId]]], ROLLBACK, 40) as unknown;
      expect(result, 'one block kept').toMatchObject({ kept: 1 });
      again.flush();
      for (const frame of again.socket.drain()) await again.socket.deliver(frame);
      await syncAll(again, cut.ben);
      await syncAll(again, cut.ben);
      expect(again.socket.closed).toBeNull();
      expect(cut.ben.ids(), 'the code block stays').toEqual([cut.payloadId]);
      expect(again.ids()).toEqual([cut.payloadId]);
      expect(heldText(cut.ben.payloadDoc(0)), "Ben's code and the paste's, as it stood").toBe('ben();print(1)');
      expect(heldText(again.payloadDoc(0))).toBe('ben();print(1)');
      expect(nothingPasted(cut.ben.paragraphs())).toEqual([]);
      expect(again.paragraphs()).toEqual(cut.ben.paragraphs());
      expect(tree(cut.ben)).toEqual(await fresh(cut));
      const server = await cut.doc.dobj.exportMarkdown();
      expect(server).toContain('ben();print(1)');
      expect(server).not.toMatch(/Alpha/);
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  // A delete leaves no item of the writer who made it: only the paste's own deletes tell it apart.
  it('keeps a landed pasted line another writer only deleted from whole', async () => {
    const cut = await cutPaste();
    cut.limits.structCap = STRUCT_CAP;
    await syncAll(cut.ben);
    const clock = Y.getState(cut.ben.doc.store, cut.ben.doc.clientID);
    cut.ben.editor.update(() => {
      const line = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent() === 'Alpha 0-0.');
      const text = $isParagraphNode(line) ? line.getFirstChild() : null;
      if (!$isTextNode(text)) throw new Error('no Alpha 0-0.');
      text.spliceText(9, 1, '');
    }, { discrete: true });
    await syncAll(cut.ben);
    expect(Y.getState(cut.ben.doc.store, cut.ben.doc.clientID), 'Ben only deleted').toBe(clock);
    const { again, frames, kept } = await rollingBack(cut, 40);
    try {
      for (const frame of frames) await again.socket.deliver(frame);
      await syncAll(again, cut.ben);
      await syncAll(again, cut.ben);
      expect(kept, 'one block kept').toBe(1);
      const held = cut.ben.paragraphs();
      expect(nothingPasted(held), 'the line he deleted from stays, and nothing else of the paste').toEqual(['Alpha 0-0']);
      expect(again.paragraphs()).toEqual(held);
      expect(tree(cut.ben)).toEqual(await fresh(cut));
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  it('keeps a landed pasted code block another writer only deleted from whole', async () => {
    const { rollBackPaste } = use();
    const cut = await cutPaste();
    cut.limits.structCap = STRUCT_CAP;
    await syncAll(cut.ben);
    const payload = cut.ben.payloadDoc(0)!;
    cut.ben.erase(0, 0, 2);
    await syncAll(cut.ben);
    expect(heldText(payload)).toBe('int(1)');
    expect(Y.getState(payload.store, payload.clientID), 'Ben only deleted').toBe(0);
    const again = await LiveClient.open(cut.doc, { id: 'ada' });
    try {
      const code = again.payloads.get(cut.payloadId)!;
      const result = rollBackPaste(again.doc, cut.record.note, [[cut.payloadId, code, cut.record.payloads[cut.payloadId]]], ROLLBACK, 40) as unknown;
      expect(result, 'one block kept').toMatchObject({ kept: 1 });
      again.flush();
      for (const frame of again.socket.drain()) await again.socket.deliver(frame);
      await syncAll(again, cut.ben);
      await syncAll(again, cut.ben);
      expect(cut.ben.ids(), 'the code block stays').toEqual([cut.payloadId]);
      expect(heldText(cut.ben.payloadDoc(0)), 'as it stood').toBe('int(1)');
      expect(nothingPasted(cut.ben.paragraphs())).toEqual([]);
      expect(tree(cut.ben)).toEqual(await fresh(cut));
    } finally { again.dispose(); cut.ben.dispose(); }
  });

  // The first batch replaces the selected 'Kept.', or goes into the middle of 'Kept. Tail.' (splitting it); five more
  // follow. Either way the line ends as it was.
  // While it lands the server holds the line's text beside the paste's: the binding writes a line's change as a
  // diff ('Kept. Tail.' to 'Kept.Alpha 0-0.' keeps the last '.'), and its deletes are held back.
  const cases: [string, string, [number, number], string][] = [
    ['a paste that replaced a selection holds its deletes back until it lands, so cut short it leaves the selection, and its rollback the note as it was', 'Kept.', [0, 5], 'Kept'],
    ['a paste into the middle of a line leaves that line as it was: the run it inserted there goes, with the blocks it made', 'Kept. Tail.', [5, 5], 'Kept. Tail'],
  ];
  for (const [name, line, [anchor, focus], landing] of cases) it(name, async () => {
    const { PasteWatch, withoutDeletes, rollBack } = use();
    expect(PasteWatch, "the paste's deletes, recorded").toBeTypeOf('function');
    expect(withoutDeletes, 'held back from what is sent').toBeTypeOf('function');
    const { Doc, limits } = capped();
    const doc = await start(openDoc(new Backing(), Doc as never));
    const ada = await LiveClient.open(doc, { id: 'ada' });
    const ben = await LiveClient.open(doc, { id: 'ben' });
    ada.insertParagraph(line);
    await syncAll(ada, ben);
    const before = ben.paragraphs();
    expect(before).toContain(line);
    const watch = new PasteWatch(ada.doc);
    ada.editor.update(() => {
      const kept = $getRoot().getChildren().find((node) => $isParagraphNode(node) && node.getTextContent() === line);
      const text = $isParagraphNode(kept) ? kept.getFirstChild() : null;
      if (!$isTextNode(text)) throw new Error(`no ${line}`);
      text.select(anchor, focus);
      $getSelection()!.insertNodes(Array.from({ length: 40 }, (_, i) => $createParagraphNode().append($createTextNode(`Alpha 0-${i}.`))));
    }, { discrete: true });
    for (let b = 1; b < 6; b += 1) {
      ada.editor.update(() => {
        for (let i = 0; i < 40; i += 1) $getRoot().append($createParagraphNode().append($createTextNode(`Alpha ${b}-${i}.`)));
      }, { discrete: true });
    }
    await ada.settle();
    watch.finish();
    expect(watch.deletes().length, 'the paste deleted the text it replaced or moved').toBeGreaterThan(0);
    // What the tab sends: each frame without the paste's deletes.
    const frames = ada.socket.drain().map((frame) => {
      const decoder = decoding.createDecoder(frame);
      if (decoding.readVarUint(decoder) !== 0 || decoding.readVarUint(decoder) !== 2) return frame;
      return encodeSyncFrame(2, withoutDeletes(decoding.readVarUint8Array(decoder), watch.deletes()));
    });
    expect(frames.length).toBeGreaterThan(4);
    for (const frame of frames.slice(0, 3)) await ada.socket.deliver(frame);
    expect(await doc.dobj.exportMarkdown(), 'the line stays on the server while the paste lands').toContain(landing);
    for (let i = 0; i < 5; i += 1) ben.insertParagraph(`Bravo ${i}.`);
    await syncAll(ben);
    limits.structCap = structsOf(doc.dobj.document);
    for (const frame of frames.slice(3)) if (ada.socket.socket.readyState === 1) await ada.socket.deliver(frame);
    await ada.socket.pump();
    expect(ada.socket.events).toContainEqual({ t: 'write-refused', reason: 'doc-cap', limit: 'structure' });
    ada.dispose();
    const again = await LiveClient.open(doc, { id: 'ada' });
    try {
      rollBack(again.doc, watch.span(), ROLLBACK, 40);
      again.flush();
      for (const frame of again.socket.drain()) {
        await again.socket.deliver(frame);
        expect(again.socket.closed, 'a deletion is admitted at the limit').toBeNull();
      }
      await syncAll(again, ben);
      await syncAll(again, ben);
      const held = ben.paragraphs();
      expect(nothingPasted(held)).toEqual([]);
      expect(held.filter((text) => !text.startsWith('Bravo')), 'the note before the paste, that line too').toEqual(before);
      expect(held.filter((text) => text.startsWith('Bravo'))).toHaveLength(5);
      expect(again.paragraphs()).toEqual(held);
      expect(ben.errors, "no error in Ben's editor").toEqual([]);
      const reader = await LiveClient.open(doc, { id: 'cy' });
      const server = tree(reader);
      reader.dispose();
      expect(tree(ben), "Ben's editor equals the server's copy").toEqual(server);
    } finally { again.dispose(); ben.dispose(); }
  });
});

describe('rollback updates (T3.B32)', () => {
  it('delete only the landed part of a span, whole items, the last in the document first, about maxStructs structs per batch; a whole span is reported whole', () => {
    const { landedPart, landedWhole, rollbackUpdates } = use();
    const doc = new Y.Doc();
    const text = doc.getText('t');
    text.insert(0, 'before');
    const from = Y.getState(doc.store, doc.clientID);
    // Ten structs: each insert at the start does not merge with the one before it.
    for (let i = 0; i < 10; i += 1) text.insert(0, `${i}${i}`);
    const span = { client: doc.clientID, from, to: from + 20 };
    expect(landedWhole(doc, span)).toBe(true);
    expect(landedWhole(doc, { ...span, to: span.to + 1 })).toBe(false);
    expect(landedPart(doc, { ...span, to: span.to + 50 })).toEqual(span);
    expect(landedPart(doc, { client: 12345, from: 0, to: 9 })).toBeNull();
    const updates = rollbackUpdates(doc, span, 3);
    expect(updates).toHaveLength(4);
    const ranges = updates.map((update) => {
      const decoded = Y.decodeUpdate(update);
      expect(decoded.structs, 'delete-only').toEqual([]);
      const [[client, list]] = [...decoded.ds.clients];
      expect(client).toBe(doc.clientID);
      return list.map((item) => [item.clock, item.len]);
    });
    // '99' ... '00' 'before': '00' (the first clock) is the last pasted item in the document.
    expect(ranges).toEqual([[[from, 6]], [[from + 6, 6]], [[from + 12, 6]], [[from + 18, 2]]]);
    for (const update of updates) Y.applyUpdate(doc, update);
    expect(text.toString(), 'the text before the span stays').toBe('before');
  });

  /** A note holding 'Kept.' and a pasted chart (a compound payload, its fields in a Y.Map) after it. */
  function pastedChart() {
    const note = new Y.Doc();
    const root = note.get('root', Y.XmlText);
    const kept = new Y.XmlText();
    root.insertEmbed(0, kept);
    kept.insert(0, 'Kept.');
    const from = Y.getState(note.store, note.clientID);
    const element = new Y.XmlElement('chart');
    root.insertEmbed(1, element);
    element.setAttribute('__type', 'chart');
    element.setAttribute('__regId', 'chart');
    const span = { client: note.clientID, from, to: Y.getState(note.store, note.clientID) };
    const chart = new Y.Doc();
    chart.getMap('payload-map').set('title', 'Pasted');
    chart.getMap('payload-map').set('data', '1,2,3');
    const payload = { client: chart.clientID, from: 0, to: Y.getState(chart.store, chart.clientID) };
    return { note, root, chart, span, payload };
  }
  const named = (root: Y.XmlText) => root.toDelta().filter((op: { insert: unknown }) => op.insert instanceof Y.XmlElement).length;

  it('a pasted chart nobody else edited goes whole: its element deleted, its payload left as it was', () => {
    const { rollBackPaste } = use();
    const { note, root, chart, span, payload } = pastedChart();
    const result = rollBackPaste(note, span, [['chart', chart, payload]], ROLLBACK) as unknown;
    expect(result).toMatchObject({ kept: 0 });
    expect(named(root), 'no chart').toBe(0);
    expect(chart.getMap('payload-map').toJSON(), 'nothing inside its payload deleted').toEqual({ title: 'Pasted', data: '1,2,3' });
  });

  it("a pasted chart another writer edited stays whole, the paste's entries too", () => {
    const { rollBackPaste } = use();
    const { note, root, chart, span, payload } = pastedChart();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(chart));
    peer.getMap('payload-map').set('title', 'Ben');
    Y.applyUpdate(chart, Y.encodeStateAsUpdate(peer));
    const result = rollBackPaste(note, span, [['chart', chart, payload]], ROLLBACK) as unknown;
    expect(result).toMatchObject({ kept: 1 });
    expect(named(root), 'the chart stays').toBe(1);
    expect(chart.getMap('payload-map').toJSON(), 'as it stands').toEqual({ title: 'Ben', data: '1,2,3' });
  });

  it("a pasted chart another writer only deleted an entry from stays whole", () => {
    const { rollBackPaste } = use();
    const { note, root, chart, span, payload } = pastedChart();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(chart));
    peer.getMap('payload-map').delete('data');
    Y.applyUpdate(chart, Y.encodeStateAsUpdate(peer));
    expect(Y.getState(chart.store, peer.clientID), 'the peer only deleted').toBe(0);
    const result = rollBackPaste(note, span, [['chart', chart, payload]], ROLLBACK) as unknown;
    expect(result).toMatchObject({ kept: 1 });
    expect(named(root), 'the chart stays').toBe(1);
    expect(chart.getMap('payload-map').toJSON(), 'as it stands').toEqual({ title: 'Pasted' });
  });

  it("the paste's own deletes, in its payload or in a block it made, keep nothing", () => {
    const { rollBackPaste, PasteWatch } = use();
    const { note, root, chart, span, payload } = pastedChart();
    const watch = new PasteWatch(chart);
    chart.getMap('payload-map').delete('data');
    watch.finish();
    const at = Y.getState(note.store, note.clientID);
    const noteWatch = new PasteWatch(note);
    const line = new Y.XmlText();
    root.insertEmbed(root.length, line);
    line.insert(0, 'Alpha.');
    line.delete(5, 1);
    noteWatch.finish();
    const whole = { ...span, to: Y.getState(note.store, note.clientID) };
    expect(at).toBe(span.to);
    const result = rollBackPaste(note, whole, [['chart', chart, { ...payload, deletes: watch.deletes() }]], ROLLBACK, undefined, noteWatch.deletes()) as unknown;
    expect(result).toMatchObject({ kept: 0 });
    expect(root.toDelta(), 'only the line before the paste').toHaveLength(1);
  });
});

// T3.B32 in the DocDO harness: a large paste cut short by a limit leaves nothing behind. The DocDO admits each of the
// paste's frames on its own (no reservation, A§5.1), so another writer can fill the room while its later frames are on
// the way; the pasting tab then deletes the paste's landed items, by client id and clock range, in delete-only batches
// the DocDO admits at any limit. Its note and payload docs end as they were before the paste, plus everyone else's
// writes. The browser side (the record, its resume, the notice) is in doc-session.test and j01-paste-tail.
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { STRUCT_CAP } from '@moss-multi/protocol/limits';
import { CLOSE } from '@moss-multi/protocol/sync';
import { DocDO, type DocLimits } from '../../src/doc-do.ts';
import { payloadText } from '../../src/payload-docs.ts';
import { Backing, openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

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
async function rollingBack(cut: Cut, maxStructs: number): Promise<{ again: LiveClient; frames: Uint8Array[] }> {
  const { rollBack } = use();
  const again = await LiveClient.open(cut.doc, { id: 'ada' });
  const code = again.payloads.get(cut.payloadId);
  expect(code, 'the landed code block is named, so its doc arrives').toBeDefined();
  // Its payload's items first, while the note still names it; then the note's.
  rollBack(code!, cut.record.payloads[cut.payloadId], ROLLBACK, maxStructs);
  expect(rollBack(again.doc, cut.record.note, ROLLBACK, maxStructs), 'in several batches').toBeGreaterThan(2);
  again.flush();
  return { again, frames: again.socket.drain() };
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
      expect(payloadText(again.payloads.get(cut.payloadId)!).toString(), "the code block's text is gone").toBe('');
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
});

describe('rollback updates (T3.B32)', () => {
  it('delete only the landed part of a span, last items first, each at most maxStructs structs cut between structs; a whole span is reported whole', () => {
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
    expect(ranges).toEqual([[[from + 14, 6]], [[from + 8, 6]], [[from + 2, 6]], [[from, 2]]]);
    for (const update of updates) Y.applyUpdate(doc, update);
    expect(text.toString(), 'the text before the span stays').toBe('before');
  });
});

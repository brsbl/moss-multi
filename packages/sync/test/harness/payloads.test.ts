// T1.F2 (docs/design/registers.md): decorator payload docs through the real DocDO, moss's code, HTML and formula nodes
// and live V1 clients. The DocDO withholds a payload while no element names it (stored privately, never served) and
// reveals it with its original items when one does; nobody deletes payload text on anyone's behalf. Ports every case
// of packages/sync/src/register-lifecycle.spike.test.ts, plus the frame scan, the restart, the wake resync and acks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ACK_COALESCE_MS } from '@moss-multi/protocol/limits';
import { base64ToBytes, CLOSE, encodePayloadFrame, PAYLOAD_STEP1, PAYLOAD_UPDATE, type ServerEvent } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { PAYLOAD_DOCS_HELD } from '../../src/payloads.ts';
import { payloadText } from '../../src/payload-docs.ts';
import { Backing, connect, openDoc, start, syncFrame, wake, type Opened } from './do-harness.ts';
import { heldText, KINDS, LiveClient, syncAll } from './live-client.ts';
import { serverEnds, type FakeSocket } from './workerd.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const SEED = 'Intro.\n\nOutro.';

async function seeded(): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: SEED });
  return opened;
}

/** Where each server socket's sent frames stand now: a wire scan from here sees only what is sent later. */
type Mark = Map<FakeSocket, number>;
const mark = (): Mark => new Map(serverEnds.map((socket) => [socket, socket.sent.length]));
const MARK_ALL: Mark = new Map();

/** Every frame a server sent on any socket since `since`, and every row the DocDO persisted for the note. */
function served(opened: Opened, since: Mark = MARK_ALL): Buffer[] {
  const sent = serverEnds.flatMap((socket) => socket.sent.slice(since.get(socket) ?? 0))
    .map((frame) => (typeof frame === 'string' ? Buffer.from(frame) : Buffer.from(frame)));
  const rows = [
    ...opened.backing.query<{ data: ArrayBuffer }>('SELECT data FROM yupdates'),
    ...opened.backing.query<{ data: ArrayBuffer }>('SELECT data FROM ystate'),
  ].map((row) => Buffer.from(new Uint8Array(row.data)));
  return [...sent, ...rows];
}
const carries = (frames: Buffer[], text: string) => frames.some((frame) => frame.includes(text));
const inNote = (opened: Opened, text: string) => Buffer.from(Y.encodeStateAsUpdate(opened.dobj.document)).includes(text);
/** The DocDO's private payload rows. */
const stored = (opened: Opened, text: string) =>
  opened.backing.query<{ data: ArrayBuffer }>('SELECT data FROM payload_updates').some((row) => Buffer.from(new Uint8Array(row.data)).includes(text));

/** A reader who joins now, reads every payload node's text through its getter, and leaves. */
async function lateReader(opened: Opened): Promise<string[]> {
  const late = await LiveClient.open(opened);
  try {
    return late.texts();
  } finally {
    await late.socket.drop();
    late.dispose();
  }
}

async function duplicate(opened: Opened): Promise<Opened> {
  const snapshot = await opened.dobj.snapshotForDuplicate();
  const copy = await start(openDoc());
  await copy.dobj.createFromSnapshot({ folderId: 'folder', ownerId: 'owner', title: 'Copy' }, snapshot.state, snapshot.payloads);
  return copy;
}

async function acks(client: LiveClient): Promise<Extract<ServerEvent, { t: 'ack' }>[]> {
  vi.advanceTimersByTime(ACK_COALESCE_MS + 1);
  await client.down();
  return client.socket.events.filter((event): event is Extract<ServerEvent, { t: 'ack' }> => event.t === 'ack');
}

describe.each(KINDS)('T1.F2 payload docs, %s @p:col-1 @p:col-3', (kind) => {
  it('a deleted block\'s text never reaches a later joiner, a duplicate, an export or the note\'s rows, and stays private', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'SECRET-alpha');
      await syncAll(ada, ben);
      expect(await lateReader(opened), 'positive control').toEqual(['SECRET-alpha']);
      expect(ben.texts()).toEqual(['SECRET-alpha']);
      ada.remove(0);
      await syncAll(ada, ben);
      const since = mark();
      expect(await lateReader(opened)).toEqual([]);
      const copy = await duplicate(opened);
      expect(await lateReader(copy)).toEqual([]);
      expect(await copy.dobj.exportMarkdown()).not.toContain('SECRET-alpha');
      expect(await opened.dobj.exportMarkdown()).not.toContain('SECRET-alpha');
      expect(carries(served(opened, since), 'SECRET-alpha'), 'no frame after the delete, and no note row ever').toBe(false);
      expect(carries(served(copy, since), 'SECRET-alpha'), "the duplicate's frames and rows").toBe(false);
      expect(inNote(opened, 'SECRET-alpha'), "the note's state never carried it").toBe(false);
      expect(stored(opened, 'SECRET-alpha'), 'kept privately for undo').toBe(true);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('the deleter\'s undo brings back block and text, a peer\'s characters included, with their original items', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'const kept = 1;');
      await syncAll(ada, ben);
      ben.type(0, 0, '/*ben*/');
      await syncAll(ada, ben);
      const before = Y.encodeStateVector(ben.payloadDoc(0)!);
      ada.remove(0);
      await syncAll(ada, ben);
      expect(ben.texts()).toEqual([]);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['/*ben*/const kept = 1;']);
      expect(Y.encodeStateVector(ben.payloadDoc(0)!), 'nothing was rewritten').toEqual(before);
      expect(await lateReader(opened)).toEqual(['/*ben*/const kept = 1;']);
      ben.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), "the peer's own undo still works").toEqual(['const kept = 1;']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['mover first', 'typist first'])('typing that races a move is kept, however long the typist was offline (%s)', async (order) => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'base');
      await syncAll(ada, ben);
      const withheld = opened.dobj.payloadWork.withheld;
      const before = ada.elements();
      ben.type(0, 4, ' RACED-ben');
      ada.moveToEnd(0);
      ben.type(0, 99, ' still-offline');
      ada.type(0, 0, 'A:');
      if (order === 'mover first') await syncAll(ada, ben); else await syncAll(ben, ada);
      expect(ada.elements(), 'the move recreated the element').not.toEqual(before);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['A:base RACED-ben still-offline']);
      expect(await lateReader(opened)).toEqual(['A:base RACED-ben still-offline']);
      expect(opened.dobj.payloadWork.withheld, 'a move never withholds').toBe(withheld);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['deleter first', 'mover first'])('a delete racing a move keeps one block with the text once (%s); every undo keeps one', async (order) => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    const cat = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'race();');
      await syncAll(ada, ben, cat);
      ben.remove(0);
      ada.moveToEnd(0);
      ada.type(0, 99, ' // ada');
      if (order === 'deleter first') await syncAll(ben, ada, cat); else await syncAll(ada, ben, cat);
      await syncAll(ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), 'the move wins, as it does for a V1 paragraph').toEqual(['race(); // ada']);
      ben.undo.undo();
      await syncAll(ada, ben, cat);
      await syncAll(ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the deleter's undo restores nothing twice").toEqual(['race(); // ada']);
      cat.type(0, 99, ' // cat');
      await syncAll(ada, ben, cat);
      ada.undo.undo();
      ada.undo.undo();
      await syncAll(ada, ben, cat);
      await syncAll(ada, ben, cat);
      for (const peer of [ada, ben, cat]) expect(peer.texts(), "the mover's undo keeps the third peer's edit").toEqual(['race(); // cat']);
      expect(await lateReader(opened)).toEqual(['race(); // cat']);
    } finally { ada.dispose(); ben.dispose(); cat.dispose(); }
  });

  it.each(['ada first', 'ben first'])('two concurrent moves, then two concurrent undos, leave exactly one block (%s)', async (order) => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'twin');
      await syncAll(ada, ben);
      ada.moveToEnd(0);
      ben.moveToStart(0);
      if (order === 'ada first') await syncAll(ada, ben); else await syncAll(ben, ada);
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['twin']);
      ada.undo.undo();
      ben.undo.undo();
      if (order === 'ada first') await syncAll(ada, ben); else await syncAll(ben, ada);
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['twin']);
      expect(await lateReader(opened)).toEqual(['twin']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('undoing a creation after an undone delete hides the block and a peer\'s typing; redo restores both', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'seed');
      await syncAll(ada, ben);
      ada.remove(0);
      await syncAll(ada, ben);
      ada.undo.undo();
      await syncAll(ada, ben);
      ben.type(0, 4, ' ben');
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['seed ben']);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), 'undoing a creation removes the block, as for a paragraph').toEqual([]);
      const since = mark();
      expect(await lateReader(opened)).toEqual([]);
      expect(carries(served(opened, since), ' ben') || carries(served(opened, since), 'seed')).toBe(false);
      ada.undo.redo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['seed ben']);
      expect(await lateReader(opened)).toEqual(['seed ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('offline typing into a block someone deleted stays private and is acked; the deleter\'s undo brings it back', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'shared');
      await syncAll(ada, ben);
      const withheld = opened.dobj.payloadWork.withheld;
      const id = ben.ids()[0];
      const before = Y.encodeStateVector(ben.payloadDoc(0)!);
      ben.type(0, 6, ' OFFLINE-ben');
      ada.remove(0);
      const since = mark();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      expect(carries(served(opened, since), 'OFFLINE-ben')).toBe(false);
      expect(await lateReader(opened)).toEqual([]);
      expect(opened.dobj.payloadWork.withheld).toBe(withheld + 1);
      const ack = (await acks(ben)).at(-1);
      const covered = ack?.p?.[id];
      expect(covered, 'the withheld write is acked').toBeDefined();
      const typed = Y.encodeStateAsUpdate(ben.payloads.get(id)!, before);
      expect(Y.snapshotContainsUpdate(Y.createSnapshot(Y.createDeleteSet(), Y.decodeStateVector(base64ToBytes(covered!.sv))), typed), 'the ack covers the typing').toBe(true);
      expect(Y.decodeStateVector(base64ToBytes(covered!.sv)).size, "the ack's vector names only what Ben sent").toBe(1);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['shared OFFLINE-ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each([
    ['before the delete, incrementally', 'before'],
    ['after the delete, incrementally', 'after-delete'],
    ['after the restore, incrementally', 'after-restore'],
    ['after the restore, through a reconnect', 'reconnect'],
  ] as const)('a peer\'s erase inside a deleted block lands exactly and its undo restores it once (%s)', async (_label, when) => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert(kind, 'keep-xy-keep');
      await syncAll(ada, ben);
      ada.erase(0, 5, 2);
      if (when === 'before') await ada.up();
      ben.remove(0);
      await ben.sync();
      if (when === 'after-delete') await ada.up();
      ben.undo.undo();
      await ben.sync();
      if (when === 'reconnect') {
        ada.socket.drain();
        await ada.reconnect();
      } else {
        await syncAll(ada, ben);
      }
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['keep--keep']);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['keep-xy-keep']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a restart between the delete and the undo loses nothing and serves nothing early', async () => {
    const first = await seeded();
    const ada = await LiveClient.open(first);
    const ben = await LiveClient.open(first);
    try {
      ada.insert(kind, 'survives-wake');
      await syncAll(ada, ben);
      ada.remove(0);
      await syncAll(ada, ben);
      await first.dobj.onSave();
      const since = mark();
      const opened = await start(wake(first));
      for (const peer of [ada, ben]) await peer.resync(opened);
      expect(await lateReader(opened)).toEqual([]);
      expect(carries(served(opened, since), 'survives-wake')).toBe(false);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['survives-wake']);
      expect(await lateReader(opened)).toEqual(['survives-wake']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a wake resync re-delivers a held, withheld payload\'s unacked typing, which is acked and still served to no one', async () => {
    const first = await seeded();
    const ada = await LiveClient.open(first);
    const ben = await LiveClient.open(first);
    try {
      ada.insert(kind, 'held');
      await syncAll(ada, ben);
      const id = ben.ids()[0];
      ada.remove(0);
      await syncAll(ada, ben);
      // Ben still holds the payload and types into his open field; the frame lands, then the DO is evicted before its ack.
      const held = ben.payloads.get(id)!;
      held.transact(() => payloadText(held).insert(4, ' WAKE-ben'), Symbol.for('field'));
      await ben.up();
      const since = mark();
      const opened = await start(wake(first));
      await ben.resync(opened);
      await ada.resync(opened);
      const ack = (await acks(ben)).at(-1);
      expect(ack?.p?.[id], 'the re-delivered write is acked by the woken DO').toBeDefined();
      expect(carries(served(opened, since), 'WAKE-ben')).toBe(false);
      expect(await lateReader(opened)).toEqual([]);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['held WAKE-ben']);
    } finally { ada.dispose(); ben.dispose(); }
  });
});

describe('T1.F2 payloads in moved paragraphs and containers @p:col-1', () => {
  it('a payload inside a moved paragraph or container keeps its text and a racing peer\'s typing', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insertBoxed('code-block', 'boxed();');
      ada.insert('formula', 'f=1');
      await syncAll(ada, ben);
      const withheld = opened.dobj.payloadWork.withheld;
      expect(ada.texts()).toEqual(['f=1', 'boxed();']);
      const before = ada.elements();
      ben.type(0, 3, '+ben');
      ben.type(1, 8, ' // ben');
      ada.moveToEnd(0);
      ada.moveToEnd(0);
      await syncAll(ada, ben);
      const after = ada.elements();
      expect(after.every((element) => !before.includes(element)), 'both payload elements were recreated').toBe(true);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['f=1+ben', 'boxed(); // ben']);
      expect(await lateReader(opened)).toEqual(['f=1+ben', 'boxed(); // ben']);
      expect(opened.dobj.payloadWork.withheld).toBe(withheld);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it.each(['splitter first', 'typist first'])('a formula in a paragraph that splits keeps its text and a racing peer\'s typing (%s)', async (order) => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert('formula', 'f=2');
      await syncAll(ada, ben);
      const withheld = opened.dobj.payloadWork.withheld;
      const before = ada.elements();
      ben.type(0, 3, '+b');
      ada.splitBefore(0, 3);
      if (order === 'splitter first') await syncAll(ada, ben); else await syncAll(ben, ada);
      expect(ada.elements(), 'the split recreated the formula element').not.toEqual(before);
      expect(ada.paragraphs()).toContain('mula: ');
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['f=2+b']);
      expect(await lateReader(opened)).toEqual(['f=2+b']);
      expect(opened.dobj.payloadWork.withheld).toBe(withheld);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('undoing the creation of a paragraph holding a formula a peer edited hides both; redo restores every character', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insert('formula', 'f=1');
      await syncAll(ada, ben);
      ben.type(0, 3, '+b');
      await syncAll(ada, ben);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual([]);
      const snapshot = await opened.dobj.snapshotForDuplicate();
      expect(carries([Buffer.from(snapshot.state), ...snapshot.payloads.map(([, state]) => Buffer.from(state))], '+b')).toBe(false);
      ada.undo.redo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts()).toEqual(['f=1+b']);
      expect(ben.paragraphs()).toEqual(['Intro.', 'Formula: ', 'Outro.']);
      expect(await lateReader(opened)).toEqual(['f=1+b']);
    } finally { ada.dispose(); ben.dispose(); }
  });
});

describe('T1.F2 joining a draft @p:col-1', () => {
  it.each(['element first', 'first text first'])('a peer that joins at any point of a new block\'s drafting, and touches the block, never costs the drafter a character (%s)', async (order) => {
    const base = await seeded();
    const seed = Y.encodeStateAsUpdate(base.dobj.document);
    const ada = await LiveClient.open(base);
    try {
      ada.insert('code-block', 'const ');
      await ada.settle();
      for (const chunk of ['ada', ' = 1;']) ada.type(0, 99, chunk);
      await ada.settle();
      const sent = ada.socket.drain();
      expect(sent.map((frame) => (frame[0] === 0 ? 'root' : 'payload')), 'a client sends the element, then its first text')
        .toEqual(['root', 'payload', 'payload', 'payload']);
      // The server takes either order: a first text can reach it before its element (a minting write).
      const frames = order === 'element first' ? sent : [sent[1], sent[0], ...sent.slice(2)];
      const drafter = ada.payloadDoc(0)!.clientID;
      for (let prefix = 0; prefix <= frames.length; prefix++) {
        const opened = await start(openDoc());
        const raw = await connect(opened, { id: 'ada', role: 'editor' });
        await raw.deliver(syncFrame(2, seed));
        for (const frame of frames.slice(0, prefix)) await raw.deliver(frame);
        const ben = await LiveClient.open(opened);
        try {
          if (ben.texts().length) ben.touch(0);
          await ben.up();
          for (const frame of frames.slice(prefix)) await raw.deliver(frame);
          await ben.down();
          const late = await LiveClient.open(opened);
          try {
            expect(late.texts(), `a reader after ${prefix} of ${frames.length} frames`).toEqual(['const ada = 1;']);
            expect([...late.payloadDoc(0)!.store.clients.keys()], 'only the drafter ever writes the payload').toEqual([drafter]);
          } finally { late.dispose(); }
          expect(ben.texts(), 'and ben sees it').toEqual(['const ada = 1;']);
        } finally { ben.dispose(); }
      }
    } finally { ada.dispose(); }
  });
});

describe('T1.F2 security: no reveal by naming, no cap bypass, bounded work @p:col-1 @p:tech-8', () => {
  it('a later joiner, a demoted reader and a second editor who name a deleted block\'s id receive nothing; the deleter\'s undo still restores it', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
    try {
      ada.insert('code-block', 'NAMED-secret');
      await syncAll(ada, ben);
      const id = ada.ids()[0];
      expect(ben.texts(), 'positive control: ben could read it').toEqual(['NAMED-secret']);
      ada.remove(0);
      await syncAll(ada, ben);
      const since = mark();
      // A second editor and a later joiner, who never could read it, each put an element naming the id.
      const cat = await LiveClient.open(opened, { id: 'cat', role: 'editor' });
      const dan = await LiveClient.open(opened, { id: 'dan', role: 'editor' });
      for (const forger of [cat, dan]) {
        forger.forge(id);
        await syncAll(forger);
        await forger.socket.deliver(encodePayloadFrame(id, PAYLOAD_STEP1, new Uint8Array([0])));
        await forger.down();
        expect(forger.texts().every((text) => text === ''), 'the forged block stays empty').toBe(true);
      }
      // Ben, demoted to viewer, cannot name it at all.
      ben.dispose();
      const demoted = await LiveClient.open(opened, { id: 'ben', role: 'viewer' });
      demoted.forge(id);
      await demoted.up();
      expect(demoted.socket.closed?.code, "a viewer's write is refused").toBeDefined();
      const late = await lateReader(opened);
      expect(late.length > 0 && late.every((text) => text === ''), 'a later joiner reads nothing').toBe(true);
      expect(carries(served(opened, since), 'NAMED-secret'), 'no frame carried the text').toBe(false);
      expect(await opened.dobj.exportMarkdown()).not.toContain('NAMED-secret');
      ada.undo.undo();
      await syncAll(ada, cat, dan);
      await syncAll(ada, cat, dan);
      expect(ada.texts().sort()).toContain('NAMED-secret');
      expect(await lateReader(opened), "the deleter's undo reveals it, one element per id").toEqual(['NAMED-secret']);
      cat.dispose();
      dan.dispose();
      demoted.dispose();
    } finally { ada.dispose(); }
  });

  it('withheld writes are bounded per connection and per identity, and never evict another\'s withheld payload', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, withheldIdsPerConnection: 3, withheldBytesPerIdentity: 4 * 1024 };
    }
    const opened = await start(openDoc(new Backing(), SmallDoc as never));
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: SEED });
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
    try {
      ada.insert('code-block', 'kept');
      await syncAll(ada, ben);
      const id = ada.ids()[0];
      ben.type(0, 4, ' BEN-private');
      ada.remove(0);
      await syncAll(ada, ben);
      expect(ben.socket.closed, "ben's withheld write is accepted").toBeNull();
      // Eve mints ids no element names: the fourth is refused, as is a payload past her identity's bytes.
      const eve = await connect(opened, { id: 'eve', role: 'editor' });
      await eve.hello();
      const minted = (text: string) => {
        const doc = new Y.Doc();
        doc.getText('payload').insert(0, text);
        return Y.encodeStateAsUpdate(doc);
      };
      for (let i = 0; i < 3; i++) await eve.deliver(encodePayloadFrame(`eve-${i}`, PAYLOAD_UPDATE, minted(`e${i}`)));
      expect(eve.closed, 'three withheld ids are allowed').toBeNull();
      await eve.deliver(encodePayloadFrame('eve-3', PAYLOAD_UPDATE, minted('e3')));
      expect(eve.closed?.code, 'a fourth is refused').toBe(CLOSE.writeRefused);
      const eve2 = await connect(opened, { id: 'eve', role: 'editor' });
      await eve2.hello();
      await eve2.deliver(encodePayloadFrame('eve-big', PAYLOAD_UPDATE, minted('x'.repeat(8 * 1024))));
      expect(eve2.closed?.code, "past eve's withheld bytes").toBe(CLOSE.writeRefused);
      // Eve cannot write into Ben's withheld payload either.
      const eve3 = await connect(opened, { id: 'eve', role: 'editor' });
      await eve3.hello();
      await eve3.deliver(encodePayloadFrame(id, PAYLOAD_UPDATE, minted('EVE')));
      expect(eve3.closed?.code, 'a non-reader writing a withheld payload').toBe(CLOSE.writeRefused);
      ada.undo.undo();
      await syncAll(ada, ben);
      for (const peer of [ada, ben]) expect(peer.texts(), "ben's withheld typing survived").toEqual(['kept BEN-private']);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('many tiny payload frames over thousands of ids hold a bounded number of docs and ack only the ids they touched', async () => {
    class BusyDoc extends DocDO {
      static override limits = { ...DocDO.limits, writeRate: { max: 100_000, windowMs: 5_000 } };
    }
    const opened = await start(openDoc(new Backing(), BusyDoc as never));
    await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: SEED });
    const ada = await LiveClient.open(opened);
    try {
      const count = 2_000;
      const started = performance.now();
      ada.insertMany('code-block', count);
      await ada.sync();
      const elapsed = performance.now() - started;
      expect(opened.dobj.payloadWork.held, 'payload docs held in memory are bounded').toBeLessThanOrEqual(PAYLOAD_DOCS_HELD);
      // Stated budget in the Node harness: 2,000 new blocks' frames land in well under 30 s.
      expect(elapsed).toBeLessThan(30_000);
      const ack = (await acks(ada)).at(-1);
      expect(Object.keys(ack?.p ?? {}).length, 'the ack names the ids its frames wrote').toBe(count);
      ada.type(1_234, 0, 'x');
      await ada.up();
      const next = (await acks(ada)).at(-1);
      expect(Object.keys(next?.p ?? {}), 'and a later ack only the one touched').toEqual([ada.ids()[1_234]]);
      expect(await lateReader(opened)).toHaveLength(count);
    } finally { ada.dispose(); }
  }, 120_000);
});

describe('T1.F2 the DocDO: migration and cost @p:col-1 @p:tech-8', () => {
  it('loading an M1 doc moves its register entries into payload docs; an orphan is never served', async () => {
    const opened = await seeded();
    const m1 = new Y.Doc();
    Y.applyUpdate(m1, Y.encodeStateAsUpdate(opened.dobj.document));
    const block = new Y.XmlElement('code-block');
    m1.transact(() => {
      m1.get('root', Y.XmlText).insertEmbed(1, block);
      for (const [key, value] of Object.entries({ __type: 'code-block', __language: 'plaintext', __regId: 'm1-live', __commentIds: [] })) {
        block.setAttribute(key, value as never);
      }
      m1.getMap<Y.Text>('registers').set('m1-live', new Y.Text('live();'));
      m1.getMap<Y.Text>('registers').set('orphan', new Y.Text('ORPHAN-gamma'));
    });
    const raw = await connect(opened, { role: 'editor' });
    await raw.deliver(syncFrame(2, Y.encodeStateAsUpdate(m1, Y.encodeStateVector(opened.dobj.document))));
    await opened.dobj.onSave();
    const since = mark();
    const loaded = await start(wake(opened));
    expect(inNote(loaded, 'ORPHAN-gamma') || inNote(loaded, 'live();'), "the note's state no longer carries either").toBe(false);
    expect(await lateReader(loaded)).toEqual(['live();']);
    expect(await loaded.dobj.exportMarkdown()).toContain('live();');
    expect(carries(served(loaded, since), 'ORPHAN-gamma')).toBe(false);
  });

  it('the server\'s work is the ids an update touched: an edit costs none, a delete or move the elements V1 rewrote', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insertMany('code-block', 200);
      await syncAll(ada, ben);
      const work = opened.dobj.payloadWork;
      const reset = () => Object.assign(work, { evaluated: 0, revealed: 0, withheld: 0, deduped: 0, compared: 0 });
      reset();
      ben.type(57, 0, 'x');
      await syncAll(ada, ben);
      expect(work.evaluated, 'an edit never touches the note').toBe(0);
      expect(ada.texts()[57]).toBe('xblock 57;');
      // V1 rewrites more than the moved node (a move recreates every later sibling), so the server's work is the
      // elements V1 actually rewrote, never the note.
      for (const step of [() => ada.remove(3), () => ada.moveToEnd(120)]) {
        const before = ada.elements();
        reset();
        step();
        await syncAll(ada, ben);
        const after = new Set(ada.elements());
        expect(work.evaluated).toBe(before.filter((element) => !after.has(element)).length);
        expect([work.revealed, work.compared]).toEqual([0, 0]);
      }
      expect(ada.texts()).toHaveLength(199);
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('two concurrent moves in a long note: one element per payload block survives, each duplicate costing only its copies', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    const ben = await LiveClient.open(opened);
    try {
      ada.insertMany('code-block', 40);
      await syncAll(ada, ben);
      const expected = ada.texts();
      const work = opened.dobj.payloadWork;
      Object.assign(work, { deduped: 0, compared: 0 });
      ada.moveToEnd(10);
      ben.moveToStart(20);
      await syncAll(ada, ben);
      await syncAll(ada, ben);
      expect(work.deduped, 'V1 rewrote overlapping siblings on both sides').toBeGreaterThan(0);
      expect(work.compared, 'each duplicated id cost its two copies').toBe(2 * work.deduped);
      for (const peer of [ada, ben]) expect([...peer.texts()].sort()).toEqual([...expected].sort());
    } finally { ada.dispose(); ben.dispose(); }
  });

  it('a withheld payload\'s state is in no frame a viewer\'s step 1 can draw out', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened);
    try {
      ada.insert('code-block', 'VIEWER-delta');
      await ada.sync();
      const id = ada.ids()[0];
      ada.remove(0);
      await ada.sync();
      const viewer = await connect(opened, { role: 'viewer' });
      await viewer.hello();
      const since = mark();
      await viewer.deliver(encodePayloadFrame(id, PAYLOAD_STEP1, new Uint8Array([0])));
      await viewer.pump();
      expect(carries(served(opened, since), 'VIEWER-delta')).toBe(false);
      expect(heldText(ada.payloads.get(id))).toBe('VIEWER-delta');
    } finally { ada.dispose(); }
  });
});

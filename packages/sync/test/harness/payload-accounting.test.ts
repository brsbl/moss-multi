// T3.B3: the DocDO's withheld-payload accounting across wakes and reveals, payload compaction cost, and a client's
// resends of payloads it made and deleted offline (B035, B036, B038, B159).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { CLOSE, encodePayloadFrame, PAYLOAD_UPDATE } from '@moss-multi/protocol/sync';
import { DocDO } from '../../src/doc-do.ts';
import { COMPACT_BYTES } from '../../src/payloads.ts';
import { Backing, connect, openDoc, start, wake, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const SEED = 'Intro.\n\nOutro.';

async function seeded(Doc: typeof DocDO = DocDO): Promise<Opened> {
  const opened = await start(openDoc(new Backing(), Doc as never));
  await opened.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: SEED });
  return opened;
}

/** A payload update minting `text` into a doc of its own. */
function minted(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('payload').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe('T3.B3 withheld payload accounting @p:col-1 @p:tech-8', () => {
  it('a connection\'s withheld ids stay counted across a wake that keeps its socket (B035)', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, withheldIdsPerConnection: 3 };
    }
    const first = await seeded(SmallDoc);
    const eve = await connect(first, { id: 'eve', role: 'editor' });
    await eve.hello();
    // Admitted before the wake and never wrote a withheld id: its attachment has no withheld ids.
    const ben = await connect(first, { id: 'ben', role: 'editor' });
    await ben.hello();
    for (let i = 0; i < 3; i++) await eve.deliver(encodePayloadFrame(`eve-${i}`, PAYLOAD_UPDATE, minted(`e${i}`)));
    expect(eve.closed, 'three withheld ids are allowed').toBeNull();
    const woken = await start(wake(first));
    eve.opened = woken;
    ben.opened = woken;
    await eve.deliver(encodePayloadFrame('eve-0', PAYLOAD_UPDATE, minted('again')));
    expect(eve.closed, 'rewriting a counted id is still allowed').toBeNull();
    await ben.deliver(encodePayloadFrame('ben-0', PAYLOAD_UPDATE, minted('b0')));
    expect(ben.closed, 'an attachment without withheld ids loads').toBeNull();
    await eve.deliver(encodePayloadFrame('eve-3', PAYLOAD_UPDATE, minted('e3')));
    expect(eve.closed?.code, 'a fourth id after the wake is refused').toBe(CLOSE.writeRefused);
  });

  it('text written while a block was served counts against its writer once the block is withheld, once (B038)', async () => {
    class SmallDoc extends DocDO {
      static override limits = { ...DocDO.limits, withheldBytesPerIdentity: 8 * 1024 };
    }
    const first = await seeded(SmallDoc);
    /** A fresh socket of `who` writes a new, unnamed payload; the close code, or null when it was accepted. */
    const write = async (opened: Opened, who: string, id: string, text: string) => {
      const client = await connect(opened, { id: who, role: 'editor' });
      await client.hello();
      await client.deliver(encodePayloadFrame(id, PAYLOAD_UPDATE, minted(text)));
      return client.closed?.code ?? null;
    };
    const ada = await LiveClient.open(first, { id: 'ada', role: 'editor' });
    try {
      ada.insert('code-block', 'x'.repeat(5000));
      await ada.sync();
      ada.remove(0);
      await ada.sync();
      expect(await write(first, 'ada', 'ada-0', 'y'.repeat(4000)), 'her served text counts once withheld').toBe(CLOSE.writeRefused);
      expect(await write(first, 'ben', 'ben-0', 'b'.repeat(4000)), 'ben is unaffected').toBeNull();
      // Reveal, then withhold again: her bytes count once, not twice.
      ada.undo.undo();
      await ada.sync();
      expect(ada.texts()).toEqual(['x'.repeat(5000)]);
      ada.remove(0);
      await ada.sync();
      expect(ada.socket.closed).toBeNull();
      expect(await write(first, 'ada', 'ada-1', 'y'.repeat(2000)), 'within her allowance: counted once').toBeNull();
      expect(await write(first, 'ada', 'ada-2', 'y'.repeat(2000)), 'past it').toBe(CLOSE.writeRefused);
    } finally { ada.dispose(); }
    const woken = await start(wake(first));
    expect(await write(woken, 'ada', 'ada-3', 'y'.repeat(2000)), 'a wake keeps the count').toBe(CLOSE.writeRefused);
    expect(await write(woken, 'ben', 'ben-1', 'b'.repeat(2000)), 'ben still writes').toBeNull();
  });
});

describe('T3.B3 payload compaction @p:tech-8', () => {
  /** Counts each payload compaction (it deletes the id's rows) on this instance's storage. */
  function countCompactions(opened: Opened): { n: number } {
    const count = { n: 0 };
    const sql = opened.state.storage.sql;
    const exec = sql.exec.bind(sql);
    sql.exec = (query: string, ...bindings: unknown[]) => {
      if (query.startsWith('DELETE FROM payload_updates WHERE reg_id')) count.n += 1;
      return exec(query, ...bindings);
    };
    return count;
  }

  it('a payload past the compaction size is not rewritten on every write; crossing the append threshold compacts once (B159)', async () => {
    const opened = await seeded();
    const compactions = countCompactions(opened);
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    try {
      ada.insert('code-block', 'x'.repeat(COMPACT_BYTES + 64 * 1024));
      await ada.sync();
      const before = compactions.n;
      for (let i = 0; i < 5; i++) {
        ada.type(0, 0, `small ${i};`);
        await ada.sync();
      }
      expect(compactions.n - before, 'small writes append').toBe(0);
      for (let i = 0; i < 2; i++) {
        ada.type(0, 0, 'z'.repeat(COMPACT_BYTES / 2 + 1024));
        await ada.sync();
      }
      expect(compactions.n - before, 'crossing the append threshold').toBe(1);
      ada.type(0, 0, 'after;');
      await ada.sync();
      expect(compactions.n - before, 'appending again').toBe(1);
      expect(ada.socket.closed).toBeNull();
    } finally { ada.dispose(); }
    const woken = await start(wake(opened));
    const after = countCompactions(woken);
    const again = await LiveClient.open(woken, { id: 'ada', role: 'editor' });
    try {
      for (let i = 0; i < 5; i++) {
        again.type(0, 0, `woken ${i};`);
        await again.sync();
      }
      expect(after.n, 'a reload counts only the rows after the last compaction').toBe(0);
      for (let i = 0; i < 2; i++) {
        again.type(0, 0, 'w'.repeat(COMPACT_BYTES / 2 + 1024));
        await again.sync();
      }
      expect(after.n, 'and compacts once when they cross it').toBe(1);
      expect(again.texts()[0]).toContain('woken 4;');
      expect(again.texts()[0]).toContain('after;');
    } finally {
      await again.socket.drop();
      again.dispose();
    }
  });
});

describe('T3.B3 offline payloads on reconnect @p:col-1', () => {
  it('blocks made and deleted offline are not resent on reconnect; an undo of one deletion resends and syncs it (B036)', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
    try {
      await ada.socket.drop();
      ada.insertMany('code-block', 70);
      await ada.settle();
      for (let i = 0; i < 70; i++) ada.remove(0);
      await ada.settle();
      await ada.reconnect();
      expect(ada.socket.closed, 'no withheld write past the bound').toBeNull();
      ben.insert('code-block', 'ben-live');
      await syncAll(ben, ada);
      expect(ada.texts(), 'a live edit converges').toEqual(['ben-live']);
      ada.undo.undo();
      await syncAll(ada, ben);
      await syncAll(ada, ben);
      expect(ada.socket.closed).toBeNull();
      for (const peer of [ada, ben]) expect(peer.texts().sort(), 'the undone deletion\'s text returns and syncs').toEqual(['ben-live', 'block 69;']);
    } finally { ada.dispose(); ben.dispose(); }
  });
  it('an empty block a peer filled stays shared: an offline edit and delete reach the server for a later reveal', async () => {
    const opened = await seeded();
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    const ben = await LiveClient.open(opened, { id: 'ben', role: 'editor' });
    try {
      ada.insert('code-block', '');
      await syncAll(ada, ben);
      const [id] = ada.ids();
      ben.type(0, 0, 'ben;');
      await syncAll(ben, ada);
      expect(ada.texts()).toEqual(['ben;']);
      await ada.socket.drop();
      ada.type(0, 4, ' ada offline;');
      ada.remove(0);
      await ada.settle();
      await ada.reconnect();
      expect(ada.socket.closed).toBeNull();
      // Ben names it again before Ada reads anything more: the server reveals what it holds.
      await ben.sync();
      expect(ben.texts()).toEqual([]);
      ben.forge(id!);
      await ben.sync();
      expect(ben.texts(), 'her offline edit reached the server').toEqual(['ben; ada offline;']);
    } finally { ada.dispose(); ben.dispose(); }
  });
});

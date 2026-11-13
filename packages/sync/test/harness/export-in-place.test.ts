// An export reads the DocDO's live doc in place (A§12): an update emitted on it meanwhile is refused before it is
// persisted or broadcast, and before any listener or observer of the doc acts on it; the export fails, and the
// instance holding the unsaved write is dropped.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LexicalEditor } from 'lexical';
import * as Y from 'yjs';
import { type Backing, counts, connect, openDoc, start, wake, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

const during = vi.hoisted(() => ({ export: null as (() => void) | null }));

vi.mock('../../src/converter/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/converter/index.ts')>();
  return {
    ...actual,
    exportMarkdown: (editor: LexicalEditor) => {
      during.export?.();
      return actual.exportMarkdown(editor);
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  during.export = null;
  vi.clearAllTimers();
  vi.useRealTimers();
});

const REFUSED = /an export wrote to the doc it read in place/;

/** Every row of every table, so a write anywhere in storage shows. */
function dump(backing: Backing): Record<string, unknown[]> {
  const tables = backing.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((t) => t.name);
  return Object.fromEntries(tables.map((table) => [table, backing.query(`SELECT * FROM "${table}"`)]));
}

/** A created note, its export memoized, then a fresh instance with an editor connected; an export runs in place. */
async function reopened(markdown: string): Promise<Opened> {
  const created = await start(openDoc());
  await created.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown });
  let exports = 0;
  during.export = () => {
    exports += 1;
  };
  expect(await created.dobj.exportMarkdown(), 'positive control: the hook runs inside a working export').toBe(markdown);
  expect(exports).toBe(1);
  during.export = null;
  return start(wake(created));
}

it('refuses a write during an export: nothing persisted or broadcast, the export fails and the instance is dropped', async () => {
  const opened = await reopened('Kept.');
  const client = await connect(opened, { role: 'editor' });
  await client.hello();
  const stored = counts(opened.backing);
  const rows = dump(opened.backing);
  const sent = client.socket.sent.length;
  let ran = 0;
  during.export = () => {
    ran += 1;
    opened.dobj.document.getText('title').insert(0, 'Forced');
  };
  await expect(opened.dobj.exportMarkdown(), 'the export fails loudly').rejects.toThrow(REFUSED);
  during.export = null;
  expect(ran, 'the forced write ran inside the export').toBe(1);
  expect(opened.state.alive, 'the instance holding the write was dropped').toBe(false);
  expect(counts(opened.backing), 'nothing persisted').toEqual(stored);
  expect(dump(opened.backing), 'no row changed').toEqual(rows);
  expect(client.socket.sent.length, 'nothing broadcast').toBe(sent);

  const next = await start(wake(opened));
  expect(next.dobj.document.getText('title').toString(), 'the write never landed').toBe('');
  expect(await next.dobj.exportMarkdown()).toBe('Kept.');
});

it('a read that writes and then throws is still refused, and the instance is dropped', async () => {
  const opened = await reopened('Kept.');
  const rows = dump(opened.backing);
  during.export = () => {
    // A write the read swallows, then a failure of its own: the refusal still wins.
    try {
      opened.dobj.document.getText('title').insert(0, 'Forced');
    } catch {
      // swallowed
    }
    throw new Error('the converter broke');
  };
  await expect(opened.dobj.exportMarkdown()).rejects.toThrow(REFUSED);
  during.export = null;
  expect(opened.state.alive, 'the instance holding the write was dropped').toBe(false);
  expect(dump(opened.backing), 'no row changed').toEqual(rows);
});

it('no listener or observer of the live doc acts on a forced write, so no payload is withheld or written', async () => {
  const opened = await reopened('Intro.');
  const ada = await LiveClient.open(opened);
  try {
    ada.insert('code-block', 'const kept = 1;');
    await syncAll(ada);
  } finally {
    ada.dispose();
  }
  await opened.dobj.exportMarkdown();
  expect(opened.backing.query('SELECT * FROM payload_meta').length, 'positive control: the block names a stored payload').toBeGreaterThan(0);
  // A further update, so the next export is not the memoized one.
  opened.dobj.document.getText('title').insert(0, 'T');
  const doc = opened.dobj.document;
  const heard: string[] = [];
  const listeners = ['beforeTransaction', 'beforeObserverCalls', 'afterTransaction', 'afterTransactionCleanup', 'afterAllTransactions'] as const;
  const hears = Object.fromEntries(listeners.map((name) => [name, () => heard.push(name)]));
  for (const name of listeners) doc.on(name, hears[name]);
  const root = doc.get('root', Y.XmlText);
  const deep = () => heard.push('observeDeep');
  root.observeDeep(deep);
  const rows = dump(opened.backing);
  const withheld = opened.dobj.payloadWork.withheld;
  let ran = 0;
  during.export = () => {
    ran += 1;
    heard.length = 0;
    // Deleting the element that names the payload would withhold it, writing payload_meta.
    root.delete(0, root.length);
  };
  await expect(opened.dobj.exportMarkdown()).rejects.toThrow(REFUSED);
  during.export = null;
  expect(ran).toBe(1);
  expect(heard, 'no listener or observer heard the forced write').toEqual([]);
  expect(opened.dobj.payloadWork.withheld, 'no payload withheld').toBe(withheld);
  expect(dump(opened.backing), 'no row changed, payload_meta included').toEqual(rows);
  expect(opened.state.alive, 'the instance holding the write was dropped').toBe(false);
  for (const name of listeners) doc.off(name, hears[name]);
  root.unobserveDeep(deep);
});

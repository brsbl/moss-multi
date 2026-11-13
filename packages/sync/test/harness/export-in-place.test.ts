// An export reads the DocDO's live doc in place (A§12): an update emitted on it meanwhile is refused before it is
// persisted or broadcast, the export fails, and the instance holding the unsaved write is dropped.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LexicalEditor } from 'lexical';
import { counts, connect, openDoc, start, wake } from './do-harness.ts';

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

it('refuses a write during an export: nothing persisted or broadcast, the export fails and the instance is dropped', async () => {
  const created = await start(openDoc());
  await created.dobj.create({ folderId: 'folder', ownerId: 'owner', markdown: 'Kept.' });
  let exports = 0;
  during.export = () => {
    exports += 1;
  };
  expect(await created.dobj.exportMarkdown(), 'positive control: the hook runs inside a working export').toBe('Kept.');
  expect(exports).toBe(1);

  // A fresh instance, since an export is memoized until the next update.
  const opened = await start(wake(created));
  const client = await connect(opened, { role: 'editor' });
  await client.hello();
  const stored = counts(opened.backing);
  const rows = opened.backing.query('SELECT * FROM yupdates');
  const sent = client.socket.sent.length;
  during.export = () => {
    exports += 1;
    opened.dobj.document.getText('title').insert(0, 'Forced');
  };
  await expect(opened.dobj.exportMarkdown(), 'the export fails loudly').rejects.toThrow();
  during.export = null;
  expect(exports, 'the forced write ran inside the export').toBe(2);
  expect(counts(opened.backing), 'nothing persisted').toEqual(stored);
  expect(opened.backing.query('SELECT * FROM yupdates'), 'no row changed').toEqual(rows);
  expect(client.socket.sent.length, 'nothing broadcast').toBe(sent);

  const reopened = await start(wake(opened));
  expect(reopened.dobj.document.getText('title').toString(), 'the write never landed').toBe('');
  expect(await reopened.dobj.exportMarkdown()).toBe('Kept.');
});

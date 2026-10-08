// T6.1 checker P2, routed to T6.2: a restore whose reconciled body does not export as the version's is refused by
// reconcileBody's export comparison before any body, payload or note write. The converter's stateToMarkdown (what
// the comparison expects) is perturbed, so the reconcile itself succeeds and only the comparison can refuse.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { openDoc, start, type Opened } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';

const forced = vi.hoisted(() => ({ on: false, calls: 0 }));

vi.mock('../../src/converter/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/converter/index.ts')>();
  return {
    ...actual,
    stateToMarkdown: (state: Parameters<typeof actual.stateToMarkdown>[0]) => {
      if (!forced.on) return actual.stateToMarkdown(state);
      forced.calls += 1;
      return `${actual.stateToMarkdown(state)}\nnot what the reconciled body exports`;
    },
  };
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  forced.on = false;
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };
const seen = (opened: Opened) => ({ ...captureRestoreBase(opened.dobj.document), age: 0 });

describe('restore export mismatch @p:mean-3', () => {
  it("refuses 409 at reconcileBody's export comparison, before any body, payload or note write", async () => {
    const opened = await start(openDoc());
    await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown: 'alpha\n' });
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    try {
      ada.insert('code-block', 'const a = 1;');
      await syncAll(ada);
      const saved = await opened.dobj.saveVersion({ name: 'With code', reviewer: ADA });
      if (!saved.ok) throw new Error(saved.reason);
      // The restore would change the body and the code block's payload.
      ada.type(0, 0, '// changed ');
      ada.insertParagraph('later');
      await syncAll(ada);

      const count = (table: string) => Number(opened.backing.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
      const markdown = await opened.dobj.exportMarkdown();
      const vector = Y.encodeStateVector(opened.dobj.document);
      const rows = { note: count('yupdates') + count('ystate'), payloads: count('payload_updates'), versions: count('versions') };
      expect(markdown).toContain('// changed');

      forced.on = true;
      const restored = await opened.dobj.restoreVersion({ base: seen(opened), id: saved.version.id, reviewer: ADA });
      expect(forced.calls, 'the comparison ran').toBeGreaterThan(0);
      expect(restored).toMatchObject({ ok: false, status: 409, reason: 'restore-unverified' });
      expect(await opened.dobj.exportMarkdown()).toBe(markdown);
      expect(Y.encodeStateVector(opened.dobj.document)).toEqual(vector);
      expect({ note: count('yupdates') + count('ystate'), payloads: count('payload_updates'), versions: count('versions') }).toEqual(rows);
    } finally {
      ada.dispose();
    }
  });
});

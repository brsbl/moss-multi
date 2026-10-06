// The DocDO's D1 writes (A§5.1) against a real local D1 with the committed migrations: the title column takes the
// trimmed title, the filename is `<slug>.md` unique among live docs in the doc's folder (a collision gets `-N`, never
// an error), a doc keeps its own filename when its slug does not change, and updated_at takes the touch time.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { d1Projections } from '@moss-multi/sync/projections';
import { migratedD1, type TestD1 } from '../test/d1.ts';

let d1: TestD1;
const OWNER = 'user-projections';
const VAULT = 'vault-projections';
const OTHER = 'folder-projections-other';

beforeAll(async () => {
  d1 = await migratedD1();
  const now = Date.now();
  await d1.db.prepare('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
    .bind(OWNER, 'Ada', 'mm-projections@example.invalid', now, now).run();
  await d1.db.prepare("INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, 'Home', 'vault', NULL, ?)")
    .bind(VAULT, OWNER, OWNER, now).run();
  await d1.db.prepare("INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, 'Other', 'folder', ?, ?)")
    .bind(OTHER, OWNER, OWNER, VAULT, now).run();
}, 60_000);
afterAll(() => d1?.dispose());

let docs = 0;
async function doc(folder = VAULT, { deleted = false } = {}): Promise<string> {
  docs += 1;
  const id = `doc-projections-${docs}`;
  await d1.db.prepare('INSERT INTO docs (id, owner_user_id, created_by, folder_id, title, filename, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)')
    .bind(id, OWNER, OWNER, folder, '', `untitled-${docs}.md`, deleted ? 1 : null).run();
  return id;
}

const row = (id: string) =>
  d1.db.prepare('SELECT title, filename, updated_at AS updatedAt FROM docs WHERE id = ?').bind(id).first<{ title: string; filename: string; updatedAt: number }>();

describe('d1Projections', () => {
  it.each(['recipient RPC unavailable', 'recipient lookup unavailable', 'UNIQUE notification failure'])(
    'committed title and timestamp writes survive %s', async (message) => {
      const id = await doc();
      const publish = vi.fn(async () => { throw new Error(message); });
      const projections = d1Projections(d1.db, publish);
      await expect(projections.title(id, 'Committed notification failure')).resolves.toBeUndefined();
      expect(await row(id)).toMatchObject({ title: 'Committed notification failure' });
      expect(publish).toHaveBeenCalledTimes(1);
      await expect(projections.touch(id, 9000)).resolves.toBeUndefined();
      expect((await row(id))?.updatedAt).toBe(9000);
      expect(publish).toHaveBeenCalledTimes(2);
    },
  );

  it('still rejects a failed D1 projection without notifying', async () => {
    const failure = new Error('D1 write unavailable');
    const publish = vi.fn();
    const run = vi.fn(async () => { throw failure; });
    const db = { prepare: () => ({ bind: () => ({
      all: async () => ({ results: [] }), first: async () => null, run,
    }) }) } as unknown as D1Database;
    await expect(d1Projections(db, publish).title('doc', 'Title')).rejects.toBe(failure);
    await expect(d1Projections(db, publish).touch('doc', 9000)).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
  });

  it('writes the title and its slug filename', async () => {
    const id = await doc();
    await d1Projections(d1.db).title(id, 'Weekly Review: Q4 / 2026');
    expect(await row(id)).toMatchObject({ title: 'Weekly Review: Q4 / 2026', filename: 'weekly-review-q4-2026.md' });
  });

  it('suffixes a filename another live doc in the folder holds, and ignores trashed docs and other folders', async () => {
    const projections = d1Projections(d1.db);
    const first = await doc();
    const second = await doc();
    const trashed = await doc(VAULT, { deleted: true });
    const elsewhere = await doc(OTHER);
    await projections.title(trashed, 'Shared name');
    await projections.title(elsewhere, 'Shared name');
    await projections.title(first, 'Shared name');
    await projections.title(second, 'Shared name');
    expect((await row(first))?.filename).toBe('shared-name.md');
    expect((await row(second))?.filename).toBe('shared-name-2.md');
    expect((await row(elsewhere))?.filename, 'another folder has its own names').toBe('shared-name.md');
  });

  it('keeps a doc its own filename when the slug is unchanged', async () => {
    const projections = d1Projections(d1.db);
    const id = await doc();
    await projections.title(id, 'Keep me');
    await projections.title(id, 'Keep Me');
    expect(await row(id)).toMatchObject({ title: 'Keep Me', filename: 'keep-me.md' });
  });

  it('names a title with no letters or digits "untitled"', async () => {
    const id = await doc();
    await d1Projections(d1.db).title(id, '!!!');
    expect(await row(id)).toMatchObject({ title: '!!!', filename: 'untitled.md' });
  });

  it('touches updated_at', async () => {
    const id = await doc();
    await d1Projections(d1.db).touch(id, 1_790_000_000_000);
    expect((await row(id))?.updatedAt).toBe(1_790_000_000_000);
  });
});

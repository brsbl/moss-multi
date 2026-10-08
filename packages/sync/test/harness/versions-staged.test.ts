// T6.S4 (M6 Slop Cop P1; A§14): a restore point too large for its row is staged in the DocDO's own SQLite in the
// restore's serialized turn, chunked under the 2 MB row cap, and moved to R2 afterwards. So a restore on a large note
// never waits for a quiet interval of R2 latency and succeeds while a peer keeps typing; the restore point reads the
// same before and after it moves; and a crash between staging and the move recovers on wake with no loss and no orphan.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DocDO } from '../../src/doc-do.ts';
import { VERSION_SPILL_BYTES, type VersionBlobs } from '../../src/doc/versions.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };
const ROW_CAP = 2 * 1024 * 1024;

/** A note well past the spill size, near the 2 MB of markdown a note may hold. */
const LARGE = `${'spill words '.repeat(Math.ceil((VERSION_SPILL_BYTES * 1.2) / 12))}\n`;

/** An in-memory R2 bucket whose put runs `onPut` (a peer's keystroke, a failure, a crash) before it stores, or after. */
function bucket(onPut: (key: string) => Promise<void> | void, storeFirst = false): { stored: Map<string, string>; puts: string[] } {
  const state = { stored: new Map<string, string>(), puts: [] as string[] };
  const fake: VersionBlobs = {
    put: async (key, body) => {
      state.puts.push(key);
      if (storeFirst) state.stored.set(key, body);
      await onPut(key);
      state.stored.set(key, body);
    },
    get: async (key) => state.stored.get(key) ?? null,
    delete: async (keys) => {
      for (const key of keys) state.stored.delete(key);
    },
  };
  const original = DocDO.versionBlobs;
  DocDO.versionBlobs = () => fake;
  onTestFinished(() => {
    DocDO.versionBlobs = original;
  });
  return state;
}

/** workerd refuses a row over 2 MB; the harness's SQLite would not, so the versions table refuses one here. */
function rowCap(opened: Opened): void {
  const size = ['full_title', 'frontmatter', 'markdown', 'lexical_json', 'payloads', 'comments', 'anchors']
    .map((column) => `COALESCE(LENGTH(CAST(NEW.${column} AS BLOB)), 0)`).join(' + ');
  opened.backing.db.exec(`CREATE TRIGGER row_cap BEFORE INSERT ON versions WHEN ${size} > ${ROW_CAP} BEGIN SELECT RAISE(ABORT, 'SQLITE_TOOBIG'); END;`);
}

const tables = (opened: Opened) => new Set(opened.backing.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name));

/** The staged chunks of a version, each with its size; none where staging does not exist. */
function stagedChunks(opened: Opened, id: string): number[] {
  if (!tables(opened).has('version_staged')) return [];
  return opened.backing.query<{ n: number }>('SELECT LENGTH(data) AS n FROM version_staged WHERE id = ? ORDER BY idx', id).map((row) => Number(row.n));
}

const r2KeyOf = (opened: Opened, id: string) =>
  opened.backing.query<{ r2_key: string | null }>('SELECT r2_key FROM versions WHERE id = ?', id)[0]?.r2_key ?? null;

/** The R2 keys the doc's version rows hold. */
const liveKeys = (opened: Opened) =>
  opened.backing.query<{ r2_key: string }>('SELECT r2_key FROM versions WHERE r2_key IS NOT NULL').map((row) => row.r2_key).sort();

const restorePoints = (opened: Opened) =>
  opened.backing.query<{ id: string }>("SELECT id FROM versions WHERE kind = 'restore-point'").map((row) => row.id);

async function created(markdown: string): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown });
  rowCap(opened);
  return opened;
}

async function editorOn(opened: Opened, id: string): Promise<TestClient> {
  const client = await connect(opened, { id, role: 'editor' });
  await client.hello();
  return client;
}

async function typeTitle(client: TestClient, text: string): Promise<void> {
  const title = client.doc.getText('title');
  title.insert(title.length, text);
  await client.flush();
}

/** A restore's base as the server holds the note now. */
const seen = (opened: Opened) => ({ ...captureRestoreBase(opened.dobj.document), age: 0 });

async function saveNamed(opened: Opened, name: string): Promise<string> {
  const saved = await opened.dobj.saveVersion({ name, reviewer: ADA });
  if (!saved.ok) throw new Error(saved.reason);
  return saved.version.id;
}

async function markdownOf(opened: Opened, id: string): Promise<string | null> {
  const read = await opened.dobj.getVersion({ id, reviewer: ADA });
  return read.ok ? read.version.markdown : null;
}

describe('a large restore point is staged locally in the restore turn, then moved to R2 (A§14) @p:mean-3', () => {
  it('restores a note past the spill size while a peer types through every R2 put, keeping the exact restore point and his words', async () => {
    let ben: TestClient | null = null;
    // Ben keeps typing: one keystroke lands on the server during every R2 put.
    const r2 = bucket(async () => {
      if (ben) await typeTitle(ben, 'k');
    });
    const opened = await created(LARGE);
    const id = await saveNamed(opened, 'Large');
    ben = await editorOn(opened, 'ben');
    await typeTitle(ben, 'Draft');
    const before = await opened.dobj.exportMarkdown();
    const putsBefore = r2.puts.length;

    const restored = await opened.dobj.restoreVersion({ base: seen(opened), id, reviewer: ADA });
    expect(restored, 'a peer typing never starves a large restore').toMatchObject({ ok: true });
    if (!restored.ok) return;
    const point = restored.restorePoint!;
    expect(point).toBeTruthy();
    // Bounded work: the auto version after the restore and the restore point's move, nothing retried.
    const putsDuring = r2.puts.length - putsBefore;
    expect(putsDuring).toBeLessThanOrEqual(2);

    expect(await markdownOf(opened, point), 'the restore point is the note as the restore found it').toBe(before);
    expect(r2KeyOf(opened, point), 'moved to R2 once the restore is done').toBeTruthy();
    expect(r2.stored.has(r2KeyOf(opened, point)!)).toBe(true);
    expect(stagedChunks(opened, point), 'its staged chunks are gone after the move').toEqual([]);

    // Every keystroke Ben typed after the restore turn is kept, on the server and in his doc.
    await ben.pump();
    const title = opened.dobj.document.getText('title').toString();
    expect(title).toBe('k'.repeat(putsDuring));
    expect(ben.doc.getText('title').toString()).toBe(title);
    expect([...r2.stored.keys()].sort(), 'no orphan in R2').toEqual(liveKeys(opened));
  }, 300_000);

  it('reads a staged restore point from SQLite while R2 is down, and the same content after it moves', async () => {
    let failing = false;
    const r2 = bucket(() => {
      if (failing) throw new Error('R2 unavailable');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const opened = await created(LARGE);
    const id = await saveNamed(opened, 'Large');
    const ben = await editorOn(opened, 'ben');
    await typeTitle(ben, 'Draft');
    const before = await opened.dobj.exportMarkdown();
    failing = true;

    const restored = await opened.dobj.restoreVersion({ base: seen(opened), id, reviewer: ADA });
    expect(restored, 'R2 being down does not refuse a restore whose point fits locally').toMatchObject({ ok: true });
    if (!restored.ok) return;
    const point = restored.restorePoint!;
    expect(r2KeyOf(opened, point), 'not moved while R2 is down').toBeNull();
    const chunks = stagedChunks(opened, point);
    expect(chunks.length, 'staged in more than one chunk').toBeGreaterThan(1);
    for (const size of chunks) expect(size).toBeLessThanOrEqual(ROW_CAP);
    expect(await markdownOf(opened, point), 'readable while staged').toBe(before);

    failing = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r2KeyOf(opened, point), 'the move is retried once R2 is back').toBeTruthy();
    expect(stagedChunks(opened, point)).toEqual([]);
    expect(await markdownOf(opened, point), 'readable after the move').toBe(before);
    expect([...r2.stored.keys()].sort(), 'no orphan in R2').toEqual(liveKeys(opened));
  }, 300_000);

  it('recovers a restore point staged before a crash on wake, with nothing lost and no orphan in R2', async () => {
    let crashing = false;
    let opened: Opened | null = null;
    // The instance dies once the restore point's R2 put has landed, before its row knows.
    const r2 = bucket(async (key) => {
      if (crashing && opened && restorePoints(opened).some((point) => key.includes(point))) await new Promise(() => undefined);
    }, true);
    opened = await created(LARGE);
    const id = await saveNamed(opened, 'Large');
    const ben = await editorOn(opened, 'ben');
    await typeTitle(ben, 'Draft');
    const before = await opened.dobj.exportMarkdown();
    crashing = true;

    void opened.dobj.restoreVersion({ base: seen(opened), id, reviewer: ADA });
    let point: string | undefined;
    const landed = () => point !== undefined && [...r2.stored.keys()].some((key) => key.includes(point!));
    for (let i = 0; i < 100 && !landed(); i += 1) {
      await vi.advanceTimersByTimeAsync(10);
      [point] = restorePoints(opened);
    }
    expect(point, 'the restore point was stored in the restore turn').toBeTruthy();
    expect(r2KeyOf(opened, point!), 'the row does not know the move yet').toBeNull();
    expect(stagedChunks(opened, point!).length, 'staged locally').toBeGreaterThan(0);

    crashing = false;
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await markdownOf(woken, point!), 'nothing lost').toBe(before);
    expect(r2KeyOf(woken, point!), 'moved on wake').toBeTruthy();
    expect(stagedChunks(woken, point!)).toEqual([]);
    expect([...r2.stored.keys()].sort(), 'no orphan in R2').toEqual(liveKeys(woken));
  }, 300_000);
});

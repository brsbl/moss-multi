// T6.B1 (backlog B320, B321, B329, B325; A§14): the version storage lifecycle. A sweep never deletes the object of a
// version still staged or still listed; a late move of a pruned version leaves its object tracked for the sweep; the
// DocDO runs one storage pass at a time; an orphan left by a failed auto version or a stop after its spill is swept by
// a later wake; and a named save revoked while its spill is written is refused with nothing kept.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DocDO, type Resolved, type SocketIdentity } from '../../src/doc-do.ts';
import { VERSION_BOUNDS, VersionStore, type VersionBlobs, type VersionBounds } from '../../src/doc/versions.ts';
import type { VersionContent } from '../../src/doc/version-content.ts';
import { captureRestoreBase } from '../../src/restore-base.ts';
import { connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';
import { Backing, FakeState } from './workerd.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };
const HOUR = 60 * 60_000;

/** A promise and its resolve. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => undefined as void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** An R2 bucket whose puts and deletes the test can hold, fail or crash, recording every call. */
function controlledBucket() {
  let putGate = deferred();
  let deleteGate = deferred();
  let holdPut: (key: string) => boolean = () => false;
  const state = {
    stored: new Map<string, string>(),
    puts: [] as string[],
    deletes: [] as string[][],
    failPut: new Set<string>(),
    /** The object lands before the put returns, as when an instance stops inside it. */
    storeFirst: false,
    holdDeletes: false,
    setHoldPut: (hold: (key: string) => boolean) => {
      holdPut = hold;
    },
    release: () => {
      putGate.resolve();
      putGate = deferred();
    },
    releaseDeletes: () => {
      deleteGate.resolve();
      deleteGate = deferred();
    },
  };
  const fake: VersionBlobs = {
    put: async (key, body) => {
      state.puts.push(key);
      if (state.failPut.has(key)) throw new Error('R2 put failed');
      if (state.storeFirst) state.stored.set(key, body);
      if (holdPut(key)) await putGate.promise;
      state.stored.set(key, body);
    },
    get: async (key) => state.stored.get(key) ?? null,
    delete: async (keys) => {
      state.deletes.push([...keys]);
      if (state.holdDeletes) await deleteGate.promise;
      for (const key of keys) state.stored.delete(key);
    },
  };
  return Object.assign(state, { fake });
}

const contentOf = (text: string): VersionContent => ({
  title: text,
  frontmatter: '',
  markdown: `${text}\n`,
  lexical: '{"root":{"type":"root","children":[]}}',
  payloads: '{}',
  comments: '{}',
  anchors: '{}',
});

/** A VersionStore on its own SQLite, spilling every version, with lowered bounds. */
function storeOn(bucket: ReturnType<typeof controlledBucket>, bounds: Partial<VersionBounds> = {}) {
  const state = new FakeState(new Backing());
  const store = new VersionStore(state.storage.sql as never, 'doc-lifecycle', () => bucket.fake, 1,
    (run) => state.storage.transactionSync(run), () => ({ ...VERSION_BOUNDS, ...bounds }));
  const orphans = () => state.backing.query<{ r2_key: string }>('SELECT r2_key FROM version_orphans').map((row) => row.r2_key);
  const liveKeys = () => state.backing.query<{ r2_key: string }>('SELECT r2_key FROM versions WHERE r2_key IS NOT NULL').map((row) => row.r2_key).sort();
  return { store, state, orphans, liveKeys };
}

const keyOf = (id: string) => `versions/doc-lifecycle/${id}.json`;
const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = 'ffffffff-ffff-4fff-8fff-fffffffffffb';

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('a sweep never deletes a staged or listed version (B320) @p:mean-3', () => {
  it('leaves a staged version with an expired orphan untouched while another staged move fails, then moves it intact', async () => {
    const bucket = controlledBucket();
    const { store } = storeOn(bucket);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const uuid = vi.spyOn(crypto, 'randomUUID');

    // B is staged and its first move fails, leaving its orphan row due after the grace.
    uuid.mockReturnValueOnce(ID_B);
    const b = store.stage(store.prepare(contentOf('Bravo')));
    store.insert('restore-point', b, {});
    bucket.failPut.add(keyOf(ID_B));
    await expect(store.migrate()).rejects.toThrow('R2 put failed');
    vi.setSystemTime(Date.now() + HOUR + 60_000);

    // A, staged later, moves first (by id) and fails; the sweep that follows runs while R2 deletes are slow.
    bucket.failPut.clear();
    uuid.mockReturnValueOnce(ID_A);
    const a = store.stage(store.prepare(contentOf('Alpha')));
    store.insert('restore-point', a, {});
    bucket.failPut.add(keyOf(ID_A));
    await expect(store.migrate()).rejects.toThrow('R2 put failed');
    expect(bucket.puts.at(-1), 'A moved first').toBe(keyOf(ID_A));
    bucket.holdDeletes = true;
    const sweeping = store.sweep();
    await settle();
    expect(bucket.deletes.flat(), 'no delete is issued for a version still staged').not.toContain(keyOf(ID_B));
    bucket.releaseDeletes();
    await sweeping;

    bucket.failPut.clear();
    await store.migrate();
    expect(await store.content(ID_B), "B's content reads back after its move").toEqual(contentOf('Bravo'));
    expect(bucket.stored.has(keyOf(ID_B)), "B's R2 object exists").toBe(true);
    expect(store.meta(ID_B)?.spilled).toBe(true);
  });

  it('never deletes the object of a listed version, even when a stale orphan row names it', async () => {
    const bucket = controlledBucket();
    const { store, state, orphans } = storeOn(bucket);
    const saved = await store.add('named', contentOf('Kept'), { name: 'Kept' });
    const key = keyOf(saved!.id);
    state.backing.db.prepare('INSERT OR REPLACE INTO version_orphans (r2_key, due) VALUES (?, 0)').run(key);
    await store.sweep();
    expect(bucket.deletes.flat()).not.toContain(key);
    expect(bucket.stored.has(key)).toBe(true);
    expect(orphans(), 'the stale orphan row is dropped').toEqual([]);
  });
});

describe('a late move of a pruned staged version stays tracked (B321) @p:mean-3', () => {
  it('records the object a second, late put recreates after the first move was published, pruned and swept', async () => {
    const bucket = controlledBucket();
    const { store, orphans, liveKeys } = storeOn(bucket, { restorePointsKept: 1, restorePointsProtected: 0 });
    const point = store.stage(store.prepare(contentOf('Point')));
    store.insert('restore-point', point, {});
    const key = keyOf(point.id);
    // Each put of the point waits for its own release.
    const held: (() => void)[] = [];
    const original = bucket.fake.put;
    bucket.fake.put = async (k, body) => {
      if (k !== key) return original(k, body);
      const gate = deferred();
      held.push(gate.resolve);
      await gate.promise;
      bucket.stored.set(k, body);
    };

    const first = store.migrate();
    const second = store.migrate();
    await settle();
    expect(held, 'both moves put the same key').toHaveLength(2);
    held[0]();
    await first;
    expect(store.meta(point.id)?.spilled, 'the first move is published').toBe(true);

    // A newer restore point prunes it, and the sweep deletes its object and its orphan row.
    await store.add('restore-point', contentOf('Newer'), {});
    expect(store.meta(point.id), 'pruned').toBeNull();
    await store.sweep();
    expect(bucket.stored.has(key)).toBe(false);

    held[1]();
    await second;
    expect(bucket.stored.has(key), 'the late put recreated the object').toBe(true);
    expect(orphans(), 'and it is tracked for the sweep').toContain(key);
    await store.sweep();
    expect(bucket.stored.has(key), 'the next sweep deletes it').toBe(false);
    expect([...bucket.stored.keys()].sort()).toEqual(liveKeys());
  });
});

/** Every version spills, so each one's R2 object can be followed. */
function spillAll(): void {
  const original = DocDO.versionSpillBytes;
  DocDO.versionSpillBytes = 1;
  onTestFinished(() => {
    DocDO.versionSpillBytes = original;
  });
}

function bounds(next: Partial<VersionBounds>): void {
  const original = DocDO.versionBounds;
  DocDO.versionBounds = { ...original, ...next };
  onTestFinished(() => {
    DocDO.versionBounds = original;
  });
}

function install(bucket: ReturnType<typeof controlledBucket>): void {
  const original = DocDO.versionBlobs;
  DocDO.versionBlobs = () => bucket.fake;
  onTestFinished(() => {
    DocDO.versionBlobs = original;
  });
}

const liveKeysOf = (opened: Opened) =>
  opened.backing.query<{ r2_key: string }>('SELECT r2_key FROM versions WHERE r2_key IS NOT NULL').map((row) => row.r2_key).sort();
const orphansOf = (opened: Opened) => opened.backing.query<{ r2_key: string }>('SELECT r2_key FROM version_orphans').map((row) => row.r2_key);
const restorePoints = (opened: Opened) =>
  opened.backing.query<{ id: string }>("SELECT id FROM versions WHERE kind = 'restore-point'").map((row) => row.id);
const versionRows = (opened: Opened) => opened.backing.query<{ id: string; kind: string }>('SELECT id, kind FROM versions');
const dirty = (opened: Opened) => opened.backing.query<{ value: string }>("SELECT value FROM meta WHERE key = 'versions-dirty'")[0]?.value ?? null;

async function created(Doc?: typeof DocDO): Promise<Opened> {
  const opened = await start(Doc ? openDoc(undefined, Doc as never) : openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', markdown: 'alpha\n' });
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

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await vi.advanceTimersByTimeAsync(5);
}

describe('the DocDO runs one version storage pass at a time (B320, B321) @p:mean-3', () => {
  it('moves a staged restore point once while a named save lands during its held R2 put', async () => {
    const bucket = controlledBucket();
    install(bucket);
    spillAll();
    const opened = await created();
    const one = await opened.dobj.saveVersion({ name: 'One', reviewer: ADA });
    if (!one.ok) throw new Error(one.reason);
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Two');
    await ada.drop();

    const pointKey = (key: string) => restorePoints(opened).some((id) => key.includes(id));
    bucket.setHoldPut(pointKey);
    const restoring = opened.dobj.restoreVersion({ base: { ...captureRestoreBase(opened.dobj.document), age: 0 }, id: one.version.id, reviewer: ADA });
    await until(() => bucket.puts.some(pointKey));
    expect(bucket.puts.filter(pointKey), "the restore point's move is under way").toHaveLength(1);

    const saving = opened.dobj.saveVersion({ name: 'During', reviewer: ADA });
    await vi.advanceTimersByTimeAsync(100);
    expect(bucket.puts.filter(pointKey), 'a second pass does not move the same point again').toHaveLength(1);

    bucket.release();
    const [restored, saved] = await Promise.all([restoring, saving]);
    expect(restored).toMatchObject({ ok: true });
    expect(saved).toMatchObject({ ok: true });
    expect(bucket.puts.filter(pointKey)).toHaveLength(1);
    expect([...bucket.stored.keys()].sort(), 'no orphan in R2').toEqual(liveKeysOf(opened));
    expect(orphansOf(opened)).toEqual([]);
  });
});

describe('a wake sweeps orphans whatever the dirty marker says (B329) @p:mean-3', () => {
  it('sweeps the spill of an auto version whose insert failed', async () => {
    const bucket = controlledBucket();
    install(bucket);
    spillAll();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const opened = await created();
    opened.backing.db.exec("CREATE TRIGGER no_auto BEFORE INSERT ON versions WHEN NEW.kind = 'auto' BEGIN SELECT RAISE(ABORT, 'refused'); END;");
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Unsaved');
    await ada.drop();
    expect(bucket.puts, 'the auto version spilled').toHaveLength(1);
    expect(versionRows(opened), 'its insert failed').toEqual([]);

    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bucket.stored.size, 'its spill is deleted').toBe(0);
    expect(orphansOf(woken)).toEqual([]);
    expect(dirty(woken)).not.toBe('1');
  });

  it('sweeps the spill of an instance that stopped after writing it, once its grace has passed', async () => {
    const bucket = controlledBucket();
    install(bucket);
    spillAll();
    bucket.storeFirst = true;
    const opened = await created();
    expect(dirty(opened)).not.toBe('1');
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Stopped');
    // The instance stops inside the spill's put, after R2 has the object and before its row exists.
    bucket.setHoldPut(() => true);
    void ada.drop();
    await until(() => bucket.puts.length > 0);
    const [key] = bucket.puts;
    expect(bucket.stored.has(key)).toBe(true);
    bucket.setHoldPut(() => false);

    const early = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(bucket.stored.has(key), 'within its grace, a spill may still get its row').toBe(true);
    const due = () => opened.backing.query<{ r2_key: string; due: number }>('SELECT r2_key, due FROM version_orphans');
    expect({ orphans: due().map((row) => row.r2_key), dirty: dirty(early) }, 'the spill is recorded for a later sweep').toEqual({ orphans: [key], dirty: '1' });

    await vi.advanceTimersByTimeAsync(HOUR);
    const later = await start(wake(early));
    await vi.advanceTimersByTimeAsync(5_000);
    expect({ now: Date.now(), orphans: due(), deletes: bucket.deletes, dirty: dirty(later) }, 'past its grace, a later wake sweeps it')
      .toMatchObject({ orphans: [], deletes: [[key]] });
    expect(bucket.stored.has(key), 'past its grace, a later wake deletes it').toBe(false);
    expect(orphansOf(later)).toEqual([]);
    expect(versionRows(later)).toEqual([]);
  });
});

describe('a named save re-checks access after its spill (B325) @p:ppl-2 @p:mean-3', () => {
  /** Ben edits Ada's note by a grant, as a person with a session and through his agent key, until the grant goes. */
  let revoked = false;
  class GrantedDocDO extends DocDO {
    static override access = () => ({
      stamp: async (_docId: string, sessions: string[], agents: string[]) => ({ key: 'e1', sessions: new Set(sessions), agents: new Set(agents) }),
      resolve: async (_docId: string, socket: SocketIdentity): Promise<Resolved | null> => {
        if (socket.principalId === 'ada') return { role: 'owner', presence: true };
        return revoked ? null : { role: 'editor', presence: true };
      },
    });
  }
  beforeEach(() => {
    revoked = false;
  });

  const actors: [string, { reviewer: { id: string; role: 'editor' }; actor: SocketIdentity }][] = [
    ['session', { reviewer: { id: 'ben', role: 'editor' }, actor: { kind: 'user', principalId: 'ben', sessionId: 'sess-ben', shareToken: null } }],
    ['agent key', { reviewer: { id: 'ben-key', role: 'editor' }, actor: { kind: 'agent', principalId: 'ben-key', sessionId: null, shareToken: null } }],
  ];

  it.each(actors)("%s: a grant revoked while the spill is written refuses the save, keeping no row, no slot and no spill", async (_name, who) => {
    const bucket = controlledBucket();
    install(bucket);
    spillAll();
    bounds({ namedPerPerson: 1 });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const opened = await created(GrantedDocDO);

    bucket.setHoldPut(() => true);
    const saving = opened.dobj.saveVersion({ name: 'Revoked', ...who, actingUserId: 'ben' });
    await until(() => bucket.puts.length > 0);
    expect(bucket.puts, 'the spill is being written').toHaveLength(1);
    revoked = true;
    bucket.setHoldPut(() => false);
    bucket.release();
    const result = await saving;
    expect(result, 'refused, not stored').toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).not.toBe('unstored');
    expect(versionRows(opened), 'no version row').toEqual([]);
    expect(bucket.stored.size, 'the spill is swept').toBe(0);
    expect(orphansOf(opened)).toEqual([]);

    revoked = false;
    expect(await opened.dobj.saveVersion({ name: 'Granted', ...who, actingUserId: 'ben' }), 'no named slot was consumed').toMatchObject({ ok: true });
  });
});

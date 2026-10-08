// Version storage and triggers (BUILDPLAN T6.2; A§14): an auto version on the last disconnect of a changed doc, the
// activity trigger checked on save, dedupe against the latest version, the R2 spill above 1.5 MB, named versions
// bounded per person, and a restore that is verified against the version or refused 409 with nothing changed.
import { $createTextNode, $getRoot, type ElementNode, type TextNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { anchorText, type Anchor } from '@moss-multi/core/anchor-frame';
import { DocDO } from '../../src/doc-do.ts';
import {
  NAMED_VERSIONS_PER_PERSON, RESTORE_POINTS_KEPT, VERSION_SPILL_BYTES, VERSION_TITLE_LIST_MAX, type VersionBlobs, type VersionMeta,
} from '../../src/doc/versions.ts';
import { bindLexical, connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';
import { LiveClient, syncAll } from './live-client.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

const ADA = { id: 'ada', role: 'editor' as const };

/** An in-memory R2 bucket for version spills. */
function blobs(): Map<string, string> {
  const stored = new Map<string, string>();
  const original = DocDO.versionBlobs;
  const fake: VersionBlobs = {
    put: async (key, body) => {
      stored.set(key, body);
    },
    get: async (key) => stored.get(key) ?? null,
    delete: async (keys) => {
      for (const key of keys) stored.delete(key);
    },
  };
  DocDO.versionBlobs = () => fake;
  onTestFinished(() => {
    DocDO.versionBlobs = original;
  });
  return stored;
}

async function created(markdown?: string): Promise<Opened> {
  const opened = await start(openDoc());
  await opened.dobj.create({ folderId: 'folder-1', ownerId: 'ada', ...(markdown ? { markdown } : {}) });
  return opened;
}

async function list(opened: Opened): Promise<VersionMeta[]> {
  const result = await opened.dobj.listVersions({ reviewer: ADA });
  if (!result.ok) throw new Error(`list refused: ${result.reason}`);
  return result.versions;
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

async function named(opened: Opened, name: string, reviewer: { id: string; role: 'editor' | 'viewer' | 'owner' } = ADA) {
  return opened.dobj.saveVersion({ name, reviewer });
}

describe('version triggers @p:mean-3', () => {
  it('writes an auto version when the last socket of a changed doc leaves, and none for an unchanged doc', async () => {
    const opened = await created();
    const ada = await editorOn(opened, 'ada');
    const ben = await editorOn(opened, 'ben');
    await typeTitle(ada, 'Plan');
    await ada.drop();
    expect(await list(opened), 'another socket is still open').toEqual([]);
    await ben.drop();
    const [auto, ...rest] = await list(opened);
    expect(rest).toEqual([]);
    expect(auto).toMatchObject({ kind: 'auto', name: null, title: 'Plan', authorIds: ['ada'], spilled: false });

    const idle = await editorOn(opened, 'ben');
    await idle.drop();
    expect(await list(opened), 'nothing changed since the last version').toHaveLength(1);
  });

  it('remembers a change across a wake, so the last disconnect after hibernation still writes a version', async () => {
    const opened = await created();
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Before the wake');
    const woken = await start(wake(opened));
    ada.opened = woken;
    await ada.drop();
    const versions = await list(woken);
    expect(versions.map((version) => [version.kind, version.title, version.authorIds])).toEqual([['auto', 'Before the wake', ['ada']]]);
  });

  it('writes an auto version on save after 500 updates, or 10 minutes after the last auto version', async () => {
    const opened = await created();
    const ada = await editorOn(opened, 'ada');
    for (let i = 0; i < 499; i += 1) {
      // Under the per-socket write rate (300 per 5 s).
      if (i % 250 === 249) vi.setSystemTime(Date.now() + 5_001);
      await typeTitle(ada, 'x');
    }
    expect(ada.closed).toBeNull();
    await opened.dobj.onSave();
    expect(await list(opened), '499 updates are below the activity threshold').toEqual([]);
    await typeTitle(ada, 'y');
    await opened.dobj.onSave();
    expect((await list(opened)).map((version) => version.kind)).toEqual(['auto']);

    await typeTitle(ada, 'z');
    await opened.dobj.onSave();
    expect(await list(opened), 'one update, a moment after the last auto version').toHaveLength(1);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await opened.dobj.onSave();
    const versions = await list(opened);
    expect(versions.map((version) => version.kind)).toEqual(['auto', 'auto']);
    // Past VERSION_TITLE_LIST_MAX, the whole title is in the row's content, not the listed title.
    const [row] = opened.backing.query<{ full_title: string | null }>('SELECT full_title FROM versions WHERE id = ?', versions[0].id);
    expect(row.full_title?.endsWith('yz')).toBe(true);
  });

  it('dedupes an auto version identical to the latest version', async () => {
    const opened = await created();
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Plan');
    const saved = await named(opened, 'First draft');
    expect(saved).toMatchObject({ ok: true, version: { kind: 'named', name: 'First draft', title: 'Plan' } });
    // Changed and changed back: the doc saw updates, but its content is the named version's.
    await typeTitle(ada, '!');
    const title = ada.doc.getText('title');
    title.delete(title.length - 1, 1);
    await ada.flush();
    await ada.drop();
    expect((await list(opened)).map((version) => version.kind)).toEqual(['named']);

    const again = await editorOn(opened, 'ada');
    await typeTitle(again, ' B');
    await again.drop();
    expect((await list(opened)).map((version) => [version.kind, version.title])).toEqual([['auto', 'Plan B'], ['named', 'Plan']]);
  });
});

describe('version storage @p:mean-3', () => {
  it('keeps a small version in the row, with the body, payloads and comments it captured', async () => {
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Small');
    if (!saved.ok) throw new Error(saved.reason);
    const [row] = opened.backing.query<{ markdown: string | null; lexical_json: string | null; r2_key: string | null; comments: string | null }>(
      'SELECT markdown, lexical_json, r2_key, comments FROM versions WHERE id = ?',
      saved.version.id,
    );
    expect(row.r2_key).toBeNull();
    expect(row.markdown).toBe(await opened.dobj.exportMarkdown());
    expect(JSON.parse(row.lexical_json ?? 'null')).toMatchObject({ root: { type: 'root' } });
    expect(row.comments).not.toBeNull();
    const read = await opened.dobj.getVersion({ id: saved.version.id, reviewer: ADA });
    expect(read).toMatchObject({ ok: true, version: { id: saved.version.id, markdown: row.markdown } });
  });

  it('spills a version above 1.5 MB to R2 and reads it back', async () => {
    const bucket = blobs();
    const body = `${'spill '.repeat(Math.ceil((VERSION_SPILL_BYTES * 1.05) / 6))}\n`;
    const opened = await created(body);
    const saved = await named(opened, 'Big');
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.version).toMatchObject({ spilled: true });
    expect(saved.version.bytes).toBeGreaterThan(VERSION_SPILL_BYTES);
    const [row] = opened.backing.query<{ markdown: string | null; lexical_json: string | null; r2_key: string | null }>(
      'SELECT markdown, lexical_json, r2_key FROM versions WHERE id = ?',
      saved.version.id,
    );
    expect(row.markdown).toBeNull();
    expect(row.lexical_json).toBeNull();
    expect(row.r2_key).toBeTruthy();
    expect(bucket.has(row.r2_key as string)).toBe(true);
    const read = await opened.dobj.getVersion({ id: saved.version.id, reviewer: ADA });
    if (!read.ok) throw new Error(read.reason);
    expect(read.version.markdown).toBe(await opened.dobj.exportMarkdown());
  }, 120_000);

  it('bounds named versions per person, so one person filling the bound blocks nobody else', async () => {
    const opened = await created();
    for (let i = 0; i < NAMED_VERSIONS_PER_PERSON; i += 1) expect((await named(opened, `v${i}`)).ok).toBe(true);
    expect(await named(opened, 'one more')).toMatchObject({ ok: false, status: 409, reason: 'version-limit' });
    expect((await named(opened, 'ben', { id: 'ben', role: 'editor' })).ok).toBe(true);
  });

  it('refuses a named version below editor, and a blank name', async () => {
    const opened = await created();
    expect(await named(opened, 'mine', { id: 'cara', role: 'viewer' })).toMatchObject({ ok: false, status: 403 });
    expect(await named(opened, '   ')).toMatchObject({ ok: false, status: 400 });
    expect(await list(opened)).toEqual([]);
  });
});

describe('restore @p:mean-3', () => {
  it('lands the version, keeps a peer insert in an untouched block, and brackets it with a restore point and an auto version', async () => {
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Two paragraphs');
    if (!saved.ok) throw new Error(saved.reason);

    const ada = await connect(opened, { id: 'ada', role: 'editor' });
    const adaLexical = bindLexical(ada.doc);
    await ada.hello();
    adaLexical.type(' more');
    await ada.flush();
    expect(await opened.dobj.exportMarkdown()).toContain('beta more');

    const ben = await connect(opened, { id: 'ben', role: 'editor' });
    const benLexical = bindLexical(ben.doc);
    await ben.hello();
    // Ben types into the first block while the restore runs; his frame arrives after it.
    benLexical.editor.update(() => {
      ($getRoot().getFirstChild() as ElementNode).append($createTextNode(' peer'));
    }, { discrete: true });

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    expect(restored).toMatchObject({ ok: true });
    await ben.flush();
    await ada.pump();
    const markdown = await opened.dobj.exportMarkdown();
    expect(markdown).toContain('alpha peer');
    expect(markdown).not.toContain('more');
    expect(markdown).toContain('beta');
    expect(adaLexical.text()).toBe(benLexical.text());

    const kinds = (await list(opened)).map((version) => version.kind);
    expect(kinds).toEqual(['auto', 'restore-point', 'named']);
  });

  it('refuses a restore below editor and an unknown version', async () => {
    const opened = await created('alpha\n');
    const saved = await named(opened, 'v1');
    if (!saved.ok) throw new Error(saved.reason);
    expect(await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: { id: 'cara', role: 'commenter' } })).toMatchObject({ ok: false, status: 403 });
    expect(await opened.dobj.restoreVersion({ id: 'missing', reviewer: ADA })).toMatchObject({ ok: false, status: 404 });
  });
});

/** Makes every INSERT of a `kind` version fail in SQLite, as a full disk would, until the returned heal runs. */
function failInserts(opened: Opened, kind: string): () => void {
  const name = `fail_${kind.replace('-', '_')}`;
  opened.backing.db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON versions WHEN NEW.kind = '${kind}' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  return () => opened.backing.db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

const anchorOf = (opened: Opened, id: string) => opened.dobj.document.getMap<Anchor>('comments').get(`a:${id}`);

describe('restore point and comment anchors @p:mean-3', () => {
  it('refuses a restore whose restore point cannot be stored, changing nothing', async () => {
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Two paragraphs');
    if (!saved.ok) throw new Error(saved.reason);
    const ada = await connect(opened, { id: 'ada', role: 'editor' });
    const lexical = bindLexical(ada.doc);
    await ada.hello();
    lexical.type(' more');
    await ada.flush();
    const before = await opened.dobj.exportMarkdown();
    failInserts(opened, 'restore-point');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    expect(restored).toMatchObject({ ok: false, status: 503 });
    expect(await opened.dobj.exportMarkdown(), 'the doc keeps the state no version holds').toBe(before);
    expect((await list(opened)).map((version) => version.kind)).toEqual(['named']);
  });

  it('re-anchors a comment the version held on text the restore brings back', async () => {
    const opened = await created('alpha\n\nbeta gamma\n');
    const made = await opened.dobj.createComment({ author: 'ada', id: 'c1', text: 'about gamma', anchor: { quote: 'gamma' } });
    expect(made).toMatchObject({ ok: true, quote: 'gamma' });
    const saved = await named(opened, 'With gamma');
    if (!saved.ok) throw new Error(saved.reason);

    const ada = await connect(opened, { id: 'ada', role: 'editor' });
    const lexical = bindLexical(ada.doc);
    await ada.hello();
    lexical.editor.update(() => {
      (($getRoot().getChildAtIndex(1) as ElementNode).getFirstChild() as TextNode).setTextContent('beta world');
    }, { discrete: true });
    await ada.flush();
    expect(anchorOf(opened, 'c1')?.status, 'deleting its text detaches the comment').toBe('orphaned');

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    expect(restored).toMatchObject({ ok: true });
    const anchor = anchorOf(opened, 'c1');
    expect(anchor?.status).toBe('anchored');
    expect(anchorText(opened.dobj.document, anchor!)).toBe('gamma');
    const woken = await start(wake(opened));
    expect(anchorText(woken.dobj.document, anchorOf(woken, 'c1')!), 'persisted with the restore').toBe('gamma');
  });
});

describe('version retries and bounds @p:mean-3', () => {
  it('retries an auto version that failed to store at the next trigger', async () => {
    const opened = await created();
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Plan');
    const heal = failInserts(opened, 'auto');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await ada.drop();
    expect(await list(opened)).toEqual([]);
    heal();
    const idle = await editorOn(opened, 'ben');
    await idle.drop();
    expect((await list(opened)).map((version) => [version.kind, version.title, version.authorIds])).toEqual([['auto', 'Plan', ['ada']]]);
  });

  it('keeps the per-person named cap under concurrent saves', async () => {
    const opened = await created();
    for (let i = 0; i < NAMED_VERSIONS_PER_PERSON - 1; i += 1) expect((await named(opened, `v${i}`)).ok).toBe(true);
    const both = await Promise.all([named(opened, 'last a'), named(opened, 'last b')]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect((await list(opened)).filter((version) => version.createdBy === 'ada')).toHaveLength(NAMED_VERSIONS_PER_PERSON);
  });

  it('charges a named version to the actor, refusing it past their bound and refunding a refused one', async () => {
    const charges: [string, number][] = [];
    let room = Number.POSITIVE_INFINITY;
    const original = DocDO.versionCharge;
    DocDO.versionCharge = () => async (principal, bytes) => {
      if (bytes > 0 && bytes > room) return false;
      charges.push([principal, bytes]);
      return true;
    };
    onTestFinished(() => {
      DocDO.versionCharge = original;
    });
    const opened = await created('alpha\n');
    const saved = await named(opened, 'Charged');
    if (!saved.ok) throw new Error(saved.reason);
    expect(charges).toEqual([['ada', saved.version.bytes]]);

    room = 0;
    expect(await named(opened, 'Over')).toMatchObject({ ok: false, status: 413, reason: 'version-quota' });
    expect((await list(opened)).map((version) => version.name)).toEqual(['Charged']);

    room = Number.POSITIVE_INFINITY;
    charges.length = 0;
    expect(await named(opened, 'Viewer', { id: 'cara', role: 'viewer' })).toMatchObject({ ok: false, status: 403 });
    expect(charges.reduce((sum, [, bytes]) => sum + bytes, 0), 'a refused save costs nothing').toBe(0);
  });

  it("reports the doc's version bytes for its vault after every write", async () => {
    const reported: number[] = [];
    const original = DocDO.versionUsage;
    DocDO.versionUsage = () => async (_docId, bytes) => {
      reported.push(bytes);
    };
    onTestFinished(() => {
      DocDO.versionUsage = original;
    });
    const opened = await created('alpha\n');
    await named(opened, 'One');
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Plan');
    await ada.drop();
    const total = (await list(opened)).reduce((sum, version) => sum + version.bytes, 0);
    expect(total).toBeGreaterThan(0);
    expect(reported.at(-1)).toBe(total);
  });

  it('deletes a spill whose row was never written', async () => {
    const bucket = blobs();
    const original = DocDO.versionSpillBytes;
    DocDO.versionSpillBytes = 64;
    onTestFinished(() => {
      DocDO.versionSpillBytes = original;
    });
    const opened = await created('alpha beta gamma delta epsilon zeta eta theta iota kappa lambda\n');
    const heal = failInserts(opened, 'named');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await named(opened, 'Lost')).ok).toBe(false);
    heal();
    const kept = await named(opened, 'Kept');
    if (!kept.ok) throw new Error(kept.reason);
    expect(kept.version.spilled).toBe(true);
    const [row] = opened.backing.query<{ r2_key: string }>('SELECT r2_key FROM versions WHERE id = ?', kept.version.id);
    expect([...bucket.keys()], 'only the stored version keeps a spill').toEqual([row.r2_key]);
  });
});

/** A fake PrincipalDO charge: each successful charge recorded; a positive one refused past `room` unless forced. */
function charging(): { charges: [string, number][]; setRoom(room: number): void } {
  const charges: [string, number][] = [];
  let room = Number.POSITIVE_INFINITY;
  const original = DocDO.versionCharge;
  DocDO.versionCharge = () => async (principal, bytes, force) => {
    if (bytes > 0 && !force && bytes > room) return false;
    charges.push([principal, bytes]);
    return true;
  };
  onTestFinished(() => {
    DocDO.versionCharge = original;
  });
  return { charges, setRoom: (next) => { room = next; } };
}

const BEN = { id: 'ben', role: 'editor' as const };
const chargedTo = (charges: [string, number][], principal: string) =>
  charges.filter(([who]) => who === principal).reduce((sum, [, bytes]) => sum + bytes, 0);

describe('restore bounds (T6.2 checker P1s) @p:mean-3', () => {
  it("charges a restore's restore point and its auto version to the restoring editor", async () => {
    const { charges } = charging();
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Ada draft');
    if (!saved.ok) throw new Error(saved.reason);
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Changed');
    charges.length = 0;

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: BEN });
    if (!restored.ok) throw new Error(restored.reason);
    const versions = await list(opened);
    expect(versions.map((version) => [version.kind, version.createdBy])).toEqual([['auto', 'ben'], ['restore-point', 'ben'], ['named', 'ada']]);
    const [auto, point] = versions;
    expect(chargedTo(charges, 'ben'), 'net of the reservation and its true-up').toBe(point.bytes + auto.bytes);
    expect(chargedTo(charges, 'ada'), 'nobody else pays for it').toBe(0);
  });

  it("refuses a restore 413 past the restoring editor's own bound, changing nothing", async () => {
    const { charges, setRoom } = charging();
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Ada draft');
    if (!saved.ok) throw new Error(saved.reason);
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Changed');
    const before = await opened.dobj.exportMarkdown();
    charges.length = 0;
    setRoom(0);

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: BEN });
    expect(restored).toMatchObject({ ok: false, status: 413, reason: 'version-quota' });
    expect(await opened.dobj.exportMarkdown()).toBe(before);
    expect(opened.dobj.document.getText('title').toString()).toBe('Changed');
    expect((await list(opened)).map((version) => version.kind)).toEqual(['named']);
    expect(chargedTo(charges, 'ben')).toBe(0);
  });

  it('refunds a pruned restore point to the editor it was charged to', async () => {
    const { charges } = charging();
    const opened = await created('alpha\n');
    const one = await named(opened, 'One');
    if (!one.ok) throw new Error(one.reason);
    const ada = await editorOn(opened, 'ada');
    await typeTitle(ada, 'Two');
    const two = await named(opened, 'Two');
    if (!two.ok) throw new Error(two.reason);
    await ada.drop();

    let first: VersionMeta | undefined;
    for (let i = 0; i <= RESTORE_POINTS_KEPT; i += 1) {
      const restored = await opened.dobj.restoreVersion({ id: (i % 2 === 0 ? one : two).version.id, reviewer: BEN });
      if (!restored.ok) throw new Error(restored.reason);
      first ??= (await list(opened)).find((version) => version.id === restored.restorePoint);
    }
    const points = (await list(opened)).filter((version) => version.kind === 'restore-point');
    expect(points).toHaveLength(RESTORE_POINTS_KEPT);
    expect(points.some((version) => version.id === first!.id)).toBe(false);
    const kept = (await list(opened)).filter((version) => version.createdBy === 'ben').reduce((sum, version) => sum + version.bytes, 0);
    expect(chargedTo(charges, 'ben'), 'what ben stores, the pruned point refunded').toBe(kept);
  }, 120_000);

  it("counts the title in a version's bytes and spill, and lists a short title", async () => {
    blobs();
    const { charges } = charging();
    const original = DocDO.versionSpillBytes;
    DocDO.versionSpillBytes = 4096;
    onTestFinished(() => {
      DocDO.versionSpillBytes = original;
    });
    const opened = await created('alpha\n');
    const ada = await editorOn(opened, 'ada');
    const long = 'T'.repeat(6000);
    await typeTitle(ada, long);
    const saved = await named(opened, 'Long title');
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.version.spilled, 'the title alone is past the spill size').toBe(true);
    expect(saved.version.bytes).toBeGreaterThan(6000);
    expect(chargedTo(charges, 'ada')).toBe(saved.version.bytes);
    expect(saved.version.title).toBe(long.slice(0, VERSION_TITLE_LIST_MAX));
    const [row] = opened.backing.query<{ title: string; full_title: string | null }>('SELECT title, full_title FROM versions WHERE id = ?', saved.version.id);
    expect(row.title.length).toBe(VERSION_TITLE_LIST_MAX);
    expect(row.full_title, 'a spilled title is in its spill').toBeNull();

    await typeTitle(ada, ' and more');
    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    if (!restored.ok) throw new Error(restored.reason);
    expect(opened.dobj.document.getText('title').toString()).toBe(long);
  });

  it('keeps a long title whole in an inline row', async () => {
    const opened = await created('alpha\n');
    const ada = await editorOn(opened, 'ada');
    const long = 'L'.repeat(1000);
    await typeTitle(ada, long);
    const saved = await named(opened, 'Inline');
    if (!saved.ok) throw new Error(saved.reason);
    expect(saved.version).toMatchObject({ spilled: false, title: long.slice(0, VERSION_TITLE_LIST_MAX) });
    await typeTitle(ada, '!');
    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    if (!restored.ok) throw new Error(restored.reason);
    expect(opened.dobj.document.getText('title').toString()).toBe(long);
  });
});

describe('version triggers and retries (T6.2 checker P2s) @p:mean-3', () => {
  it('checks the activity trigger after payload-only edits', async () => {
    const opened = await created('alpha\n');
    const ada = await LiveClient.open(opened, { id: 'ada', role: 'editor' });
    try {
      ada.insert('code-block', 'const a = 1;');
      await syncAll(ada);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await list(opened), 'moments after the first change').toEqual([]);
      vi.setSystemTime(Date.now() + 10 * 60_000);
      ada.type(0, 0, '// ');
      await syncAll(ada);
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await list(opened)).map((version) => version.kind)).toEqual(['auto']);
    } finally {
      ada.dispose();
    }
  });

  it("retries the doc's version bytes after a wake when recording them failed", async () => {
    const reported: number[] = [];
    let failing = true;
    const original = DocDO.versionUsage;
    DocDO.versionUsage = () => async (_docId, bytes) => {
      if (failing) throw new Error('D1 unavailable');
      reported.push(bytes);
    };
    onTestFinished(() => {
      DocDO.versionUsage = original;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const opened = await created('alpha\n');
    const saved = await named(opened, 'One');
    if (!saved.ok) throw new Error(saved.reason);
    expect(reported).toEqual([]);
    failing = false;
    const woken = await start(wake(opened));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reported.at(-1)).toBe((await list(woken)).reduce((sum, version) => sum + version.bytes, 0));
  });
});

// Version storage and triggers (BUILDPLAN T6.2; A§14): an auto version on the last disconnect of a changed doc, the
// activity trigger checked on save, dedupe against the latest version, the R2 spill above 1.5 MB, named versions
// bounded per person, and a restore that is verified against the version or refused 409 with nothing changed.
import { $createTextNode, $getRoot, type ElementNode } from 'lexical';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DocDO } from '../../src/doc-do.ts';
import { NAMED_VERSIONS_PER_PERSON, VERSION_SPILL_BYTES, type VersionBlobs, type VersionMeta } from '../../src/doc/versions.ts';
import { bindLexical, connect, openDoc, start, wake, type Opened, type TestClient } from './do-harness.ts';

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
    for (let i = 0; i < 499; i += 1) await typeTitle(ada, 'x');
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
    expect(versions[0].title.endsWith('yz')).toBe(true);
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

  it('refuses 409 when the restored export differs from the version, changing nothing', async () => {
    const opened = await created('alpha\n\nbeta\n');
    const saved = await named(opened, 'Tampered');
    if (!saved.ok) throw new Error(saved.reason);
    const ada = await connect(opened, { id: 'ada', role: 'editor' });
    const lexical = bindLexical(ada.doc);
    await ada.hello();
    lexical.type(' more');
    await ada.flush();
    opened.backing.query('UPDATE versions SET markdown = ? WHERE id = ?', 'not what the tree exports\n', saved.version.id);
    const before = await opened.dobj.exportMarkdown();

    const restored = await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: ADA });
    expect(restored).toMatchObject({ ok: false, status: 409, reason: 'restore-unverified' });
    expect(await opened.dobj.exportMarkdown()).toBe(before);
    expect((await list(opened)).map((version) => version.kind), 'no restore point for a refused restore').toEqual(['named']);
  });

  it('refuses a restore below editor and an unknown version', async () => {
    const opened = await created('alpha\n');
    const saved = await named(opened, 'v1');
    if (!saved.ok) throw new Error(saved.reason);
    expect(await opened.dobj.restoreVersion({ id: saved.version.id, reviewer: { id: 'cara', role: 'commenter' } })).toMatchObject({ ok: false, status: 403 });
    expect(await opened.dobj.restoreVersion({ id: 'missing', reviewer: ADA })).toMatchObject({ ok: false, status: 404 });
  });
});

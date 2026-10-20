// A note's media step uploads only what its own user put there (T7.S9): a reference that arrived from the server is
// download only, and a file in a shared assets/ folder that another note holds or references never goes up for this one.
// @p:agt-2
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ProgramDeps, runCli } from './program.ts';

const SERVER = 'http://127.0.0.1:9999';
const KEY = `mm_sk_${'a'.repeat(64)}`;

interface Row { id: string; title: string; filename: string; folderId: string; vaultId: string; role: string; updatedAt: number }

/** A fake server: create, list, content, rename, push and per-doc media, as the CLI calls them. */
function fakeServer() {
  const docs: Row[] = [];
  const content = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  let next = 1;
  /** Runs after a create, before its answer: an edit landing between the create and the CLI's first read. */
  const hooks: { afterCreate?: (id: string) => void } = {};
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    if (new Headers(init.headers).get('authorization') !== `Bearer ${KEY}`) return reply(401, { error: 'unauthenticated' });
    const path = url.pathname;
    if (path === '/api/docs' && method === 'GET') return reply(200, { docs });
    if (path === '/api/docs' && method === 'POST') {
      const input = body as { title?: string; markdown?: string };
      const id = `d0000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
      const title = input.title ?? '';
      const filename = `${(title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
      content.set(id, input.markdown ?? '');
      docs.push({ id, title, filename, folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
      const created = reply(201, { doc: { id, title, filename, folderId: 'f' }, role: 'owner', content: input.markdown ?? '' });
      hooks.afterCreate?.(id);
      return created;
    }
    const match = /^\/api\/docs\/([^/]+)(?:\/(.+))?$/.exec(path);
    if (!match || !content.has(match[1]!)) return reply(404, { error: 'not-found' });
    const [, id, sub] = match as unknown as [string, string, string | undefined];
    if (sub === 'content') return reply(200, content.get(id)!, { 'content-type': 'text/markdown; charset=utf-8' });
    if (!sub && method === 'PATCH') {
      const row = docs.find((doc) => doc.id === id)!;
      row.title = (body as { title: string }).title;
      return reply(200, { doc: { id, title: row.title }, role: 'owner' });
    }
    if (sub === 'push') {
      content.set(id, (body as { newText: string }).newText);
      return reply(200, { ok: true, mode: 'edit', applied: 1, failedHunks: [] });
    }
    if (sub === 'assets' && method === 'POST') {
      const name = url.searchParams.get('filename')!;
      assets.set(`${id}/${name}`, new Uint8Array(init.body as Uint8Array));
      return reply(201, { filename: name });
    }
    if (sub?.startsWith('assets/')) {
      const stored = assets.get(`${id}/${decodeURIComponent(sub.slice('assets/'.length))}`);
      if (!stored) return reply(404, { error: 'not-found' });
      return new Response(method === 'HEAD' ? null : stored, { status: 200, headers: { etag: `"${createHash('sha256').update(stored).digest('hex')}"` } });
    }
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  return { fetchImpl, docs, content, assets, hooks };
}

let dir: string;
let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-media-'));
  server = fakeServer();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], extra: Partial<ProgramDeps> = {}) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    env: { MOSS_MULTI_SERVER: SERVER, MOSS_MULTI_API_KEY: KEY, MOSS_MULTI_CONFIG_DIR: join(dir, '.config'), MOSS_MULTI_NO_OPEN: '1' },
    cwd: () => dir,
    fetchImpl: server.fetchImpl,
    stdout: (chunk) => out.push(Buffer.from(chunk).toString('utf8')),
    stderr: (line) => errors.push(line),
    sleep: async () => undefined,
    foldsCase: () => false,
    confirm: async () => false,
    ...extra,
  });
  return { code, out: out.join(''), err: errors.join('\n') };
}

type Result = { action: string; file: string; docId?: string; message?: string };
async function syncJson(extra: Partial<ProgramDeps> = {}): Promise<{ code: number; results: Result[]; err: string }> {
  const run = await cli(['sync', '--json'], extra);
  return { code: run.code, err: run.err, results: run.out.trim() ? JSON.parse(run.out) as Result[] : [] };
}

const png = (tag: string) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from(tag)]);
const write = (rel: string, data: string | Buffer) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), data);
};
const held = (docId: string) => [...server.assets.keys()].filter((key) => key.startsWith(`${docId}/`)).map((key) => key.slice(docId.length + 1)).sort();
const createdId = (results: Result[], file: string) => results.find((result) => result.action === 'created' && result.file === file)?.docId;
const failedFor = (results: Result[], docId: string, file: string) =>
  results.some((result) => result.action === 'failed' && result.docId === docId && result.file === file);

describe('note media provenance and ownership', () => {
  it('a collaborator\'s edit referencing another note\'s file in the shared assets/ uploads nothing and is reported', async () => {
    write('plan.md', 'The plan.\n');
    write('diary.md', 'Dear diary ![s](assets/secret.png)\n');
    write(join('assets', 'secret.png'), png('secret'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    const plan = createdId(first.results, 'plan.md')!;
    const diary = createdId(first.results, 'diary.md')!;
    expect(held(diary)).toEqual(['secret.png']);

    // Ben, who can edit plan, adds a reference to the diary's file; Ada's next sync pulls it.
    server.content.set(plan, `${server.content.get(plan)!.trimEnd()}\n\n![s](assets/secret.png)\n`);
    const pulled = await syncJson();
    const again = await syncJson();
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('assets/secret.png');
    expect(held(plan), 'the diary\'s file never reaches the plan').toEqual([]);
    expect(failedFor([...pulled.results, ...again.results], plan, join('assets', 'secret.png')), JSON.stringify(pulled.results)).toBe(true);
  });

  it('a locally added reference to a new file uploads; a reference the server introduced is download only and reported', async () => {
    write('plan.md', 'The plan.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;

    write(join('assets', 'new.png'), png('new'));
    appendFileSync(join(dir, 'plan.md'), '\n![n](assets/new.png)\n');
    const own = await syncJson();
    expect(own.code, own.err).toBe(0);
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'new.png') }));
    expect(held(plan)).toEqual(['new.png']);

    // A file here that no note references, named by a reference from the server, stays here.
    write(join('assets', 'stray.png'), png('stray'));
    server.content.set(plan, `${server.content.get(plan)!.trimEnd()}\n\n![g](assets/stray.png)\n`);
    const pulled = await syncJson();
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('assets/stray.png');
    expect(held(plan), 'the server-introduced reference is not filled from disk').toEqual(['new.png']);
    expect(failedFor(pulled.results, plan, join('assets', 'stray.png')), JSON.stringify(pulled.results)).toBe(true);
  });

  it('notes sharing one assets/ folder keep separate ownership across add, pull, push and sync, and after a rename', async () => {
    expect((await cli(['init'])).code).toBe(0);
    write('plan.md', 'The plan ![p](assets/plan.png)\n');
    write(join('assets', 'plan.png'), png('plan'));
    const added = await cli(['add', 'plan.md', '--json']);
    expect(added.code, added.err).toBe(0);
    const plan = (JSON.parse(added.out) as { id: string }).id;
    expect(held(plan)).toEqual(['plan.png']);

    const trip = 'd0000000-0000-4000-8000-0000000000aa';
    server.docs.push({ id: trip, title: 'trip', filename: 'trip.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(trip, 'Trip ![t](assets/trip.png)\n');
    server.assets.set(`${trip}/trip.png`, png('trip'));
    const pulled = await cli(['pull', trip, 'trip.md']);
    expect(pulled.code, pulled.err).toBe(0);
    expect(readFileSync(join(dir, 'assets', 'trip.png')).equals(png('trip'))).toBe(true);

    write('diary.md', 'Dear diary.\n');
    const created = await syncJson();
    const diary = createdId(created.results, 'diary.md')!;
    expect(diary).toBeTruthy();

    // The diary's user references the other notes' files: neither goes up for the diary.
    appendFileSync(join(dir, 'diary.md'), '\n![p](assets/plan.png)\n\n![t](assets/trip.png)\n');
    const synced = await syncJson();
    expect(held(diary)).toEqual([]);
    expect(failedFor(synced.results, diary, join('assets', 'plan.png')), JSON.stringify(synced.results)).toBe(true);
    expect(failedFor(synced.results, diary, join('assets', 'trip.png')), JSON.stringify(synced.results)).toBe(true);

    // push: the plan's user references the trip's downloaded file.
    appendFileSync(join(dir, 'plan.md'), '\n![t](assets/trip.png)\n');
    const pushed = await cli(['push', 'plan.md']);
    expect(pushed.err).toContain('trip.png');
    expect(held(plan)).toEqual(['plan.png']);

    // After a local rename the plan still owns its file, and the diary still cannot take it; its own new file goes up.
    renameSync(join(dir, 'plan.md'), join(dir, 'plans.md'));
    await syncJson();
    write(join('assets', 'mood.png'), png('mood'));
    appendFileSync(join(dir, 'diary.md'), '\n![m](assets/mood.png)\n');
    const renamed = await syncJson();
    expect(renamed.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: diary, file: join('assets', 'mood.png') }));
    expect(held(diary)).toEqual(['mood.png']);
    expect(held(plan)).toEqual(['plan.png']);
  });
});

describe('note media provenance: what the server controls never counts as this user\'s (T7.S9 recheck)', () => {
  it('a collaborator\'s title for a moss note never uploads the file it names, across sync and watch passes', async () => {
    write(join('Trip', 'Trip.md'), '# Trip\n\nThe trip.\n');
    write(join('Trip', 'assets', 'private.png'), png('private'));
    write(join('Trip', 'assets', 'other.png'), png('other'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'Trip.md'))!;
    expect(trip).toBeTruthy();

    // Ben renames the doc: one title names a file, another breaks onto a line of its own.
    const row = server.docs.find((doc) => doc.id === trip)!;
    for (const title of ['Trip ![x](assets/private.png)', 'Trip\n\n![y](assets/other.png)']) {
      row.title = title;
      for (let i = 0; i < 3; i += 1) await syncJson();
      const controller = new AbortController();
      const watching = cli(['watch', '--interval', '0.05'], { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 400));
      controller.abort();
      expect((await watching).code).toBe(0);
      await syncJson();
      expect(held(trip), `after the title ${JSON.stringify(title)}`).toEqual([]);
    }

    // A reference Ada types into the body is hers, and her own file goes up.
    write(join('Trip', 'assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'Trip', 'Trip.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: trip, file: join('Trip', 'assets', 'mine.png') }));
    expect(held(trip)).toEqual(['mine.png']);
  });

  it('adoption counts only the references in the file as the user chose it, not an edit between the create and the first read', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'stray.png'), png('stray'));
    expect((await cli(['init'])).code).toBe(0);
    server.hooks.afterCreate = (id) => server.content.set(id, `${server.content.get(id)!.trimEnd()}\n\n![s](assets/stray.png)\n`);
    const first = await syncJson();
    server.hooks.afterCreate = undefined;
    const plan = createdId(first.results, 'plan.md')!;
    expect(plan).toBeTruthy();
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('assets/stray.png');
    await syncJson();
    expect(held(plan), 'the edit made between create and read is not the adopter\'s').toEqual([]);
  });

  it('a stale editor save of a reference the server added and removed again does not upload its file', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'stray.png'), png('stray'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    const clean = server.content.get(plan)!;

    // Ben adds a reference and removes it again; Ada pulls both.
    const withRef = `${clean.trimEnd()}\n\n![s](assets/stray.png)\n`;
    server.content.set(plan, withRef);
    await syncJson();
    server.content.set(plan, clean);
    await syncJson();
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).not.toContain('stray.png');

    // Ada's editor still held the text with the reference, and saves it with an unrelated edit.
    write('plan.md', `${withRef}\nA line of my own.\n`);
    await syncJson();
    await syncJson();
    expect(held(plan), 'the stale save is not a reference Ada added').toEqual([]);
  });

  it('on a volume that folds case, another note\'s file is its own under any spelling', async () => {
    const folds = { foldsCase: () => true };
    write('diary.md', 'Dear diary ![s](assets/secret.png)\n');
    write(join('assets', 'secret.png'), png('secret'));
    write('plan.md', 'The plan.\n');
    expect((await cli(['init'], folds)).code).toBe(0);
    const first = await syncJson(folds);
    const plan = createdId(first.results, 'plan.md')!;
    const diary = createdId(first.results, 'diary.md')!;
    expect(held(diary)).toEqual(['secret.png']);

    // Here the volume folds case, so assets/SECRET.png is the diary's file.
    write(join('assets', 'SECRET.png'), png('secret'));
    appendFileSync(join(dir, 'plan.md'), '\n![s](assets/SECRET.png)\n');
    const synced = await syncJson(folds);
    expect(held(plan), JSON.stringify(synced.results)).toEqual([]);
    expect(failedFor(synced.results, plan, join('assets', 'SECRET.png')), JSON.stringify(synced.results)).toBe(true);
  });
});

describe('note media provenance: every name the server ever showed stays download only (T7.S9 third check)', () => {
  it('a collaborator\'s title that broke onto a body line, then reset, uploads nothing when a stale editor saves it', async () => {
    write(join('Trip', 'Trip.md'), '# Trip\n\nThe trip.\n');
    write(join('Trip', 'assets', 'private.png'), png('private'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'Trip.md'))!;
    expect(trip).toBeTruthy();

    const row = server.docs.find((doc) => doc.id === trip)!;
    row.title = 'Trip\n\n![x](assets/private.png)';
    await syncJson();
    const injected = readFileSync(join(dir, 'Trip', 'Trip.md'), 'utf8');
    expect(injected).toContain('assets/private.png');
    row.title = 'Trip';
    await syncJson();
    expect(readFileSync(join(dir, 'Trip', 'Trip.md'), 'utf8')).not.toContain('private.png');

    // Ada's editor still held the injected render, and saves it with typing of her own.
    write(join('Trip', 'Trip.md'), `${injected.trimEnd()}\n\nMore of my own.\n`);
    const stale = await syncJson();
    await syncJson();
    expect(held(trip), JSON.stringify(stale.results)).toEqual([]);
  });

  it('explicit pull then push of a stale save of a reference the server added and removed uploads nothing', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'private.png'), png('private'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    const clean = server.content.get(plan)!;

    const withRef = `${clean.trimEnd()}\n\n![x](assets/private.png)\n`;
    server.content.set(plan, withRef);
    expect((await cli(['pull', plan, 'plan.md'])).code).toBe(0);
    server.content.set(plan, clean);
    expect((await cli(['pull', plan, 'plan.md'])).code).toBe(0);
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).not.toContain('private.png');

    write('plan.md', withRef.replace('The plan.', 'The plan (edited).'));
    const pushed = await cli(['push', 'plan.md']);
    expect(held(plan), pushed.out + pushed.err).toEqual([]);
  });

  it('a name another note references in another Unicode form is still that note\'s file', async () => {
    const nfc = 'café.png';
    const nfd = 'café.png';
    write('diary.md', `Dear diary ![s](assets/${nfc})\n`);
    write(join('assets', nfc), png('secret'));
    write('plan.md', 'The plan.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    write(join('assets', nfd), png('secret'));
    appendFileSync(join(dir, 'plan.md'), `\n![s](assets/${nfd})\n`);
    const synced = await syncJson();
    expect(held(plan), JSON.stringify(synced.results)).toEqual([]);
  });

  it('a standalone add on a volume that folds case sees a sibling\'s file under any spelling', async () => {
    write('diary.md', 'Dear diary ![s](assets/secret.png)\n');
    write(join('assets', 'secret.png'), png('secret'));
    write(join('assets', 'SECRET.png'), png('secret'));
    write('plan.md', 'The plan ![s](assets/SECRET.png)\n');
    const added = await cli(['add', 'plan.md', '--json'], { foldsCase: () => true });
    const plan = server.docs[0]!.id;
    expect(held(plan), added.err).toEqual([]);
    expect(added.err).toContain('SECRET.png was not uploaded');
  });

  it('on a case-sensitive volume, Trip/ and trip/ are separate folders with separate files', async () => {
    write(join('trip', 'a.md'), 'A ![a](assets/a.png)\n');
    write(join('trip', 'assets', 'a.png'), png('lower'));
    // Only where the volume tells the two folders apart.
    if (existsSync(join(dir, 'TRIP', 'a.md'))) return;
    write(join('Trip', 'b.md'), 'B.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const a = createdId(first.results, join('trip', 'a.md'))!;
    const b = createdId(first.results, join('Trip', 'b.md'))!;
    expect(held(a)).toEqual(['a.png']);
    write(join('Trip', 'assets', 'a.png'), png('upper'));
    appendFileSync(join(dir, 'Trip', 'b.md'), '\n![a](assets/a.png)\n');
    const synced = await syncJson();
    expect(synced.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: b, file: join('Trip', 'assets', 'a.png') }));
  });

  it('a note folder that cannot be listed uploads nothing', async () => {
    if (process.getuid?.() === 0) return;
    write(join('Trip', 'trip.md'), 'The trip.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'trip.md'))!;
    expect(trip).toBeTruthy();
    write(join('Trip', 'assets', 'new.png'), png('new'));
    appendFileSync(join(dir, 'Trip', 'trip.md'), '\n![n](assets/new.png)\n');
    // Write and search, but no listing.
    chmodSync(join(dir, 'Trip'), 0o300);
    const pushed = await cli(['push', join('Trip', 'trip.md')]).finally(() => chmodSync(join(dir, 'Trip'), 0o755));
    expect(held(trip), pushed.out + pushed.err).toEqual([]);
  });
});

describe('the folder taint store: a name the server ever showed in a folder never uploads from it (T7.S9 round 4)', () => {
  const state = (...parts: string[]) => join(dir, '.moss-multi', ...parts);

  it('a spaced destination in a collaborator\'s title or body, normalised by the editor on save, uploads nothing', async () => {
    write(join('Trip', 'Trip.md'), '# Trip\n\nThe trip.\n');
    write(join('Trip', 'assets', 'private.png'), png('private'));
    write(join('Trip', 'assets', 'hidden.png'), png('hidden'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'Trip.md'))!;
    expect(trip).toBeTruthy();

    // Ben renames the doc with a title that breaks onto a body line, and adds a spaced reference to the body.
    server.docs.find((doc) => doc.id === trip)!.title = 'Trip\n\n![x]( assets/private.png )';
    server.content.set(trip, `${server.content.get(trip)!.trimEnd()}\n\n![y]( assets/hidden.png )\n`);
    await syncJson();
    const injected = readFileSync(join(dir, 'Trip', 'Trip.md'), 'utf8');
    expect(injected).toContain('( assets/private.png )');
    expect(injected).toContain('( assets/hidden.png )');

    // Ada's Moss editor normalises both destinations when it saves her typing.
    write(join('Trip', 'Trip.md'), `${injected.replace(/\(\s+assets\/([^\s)]+)\s+\)/g, '(assets/$1)').trimEnd()}\n\nMy own line.\n`);
    expect(readFileSync(join(dir, 'Trip', 'Trip.md'), 'utf8')).toContain('](assets/private.png)');
    const saved = await syncJson();
    await syncJson();
    expect(held(trip), JSON.stringify(saved.results)).toEqual([]);
    expect(failedFor(saved.results, trip, join('Trip', 'assets', 'private.png')), JSON.stringify(saved.results)).toBe(true);

    // Positive control: an image Ada adds herself goes up.
    write(join('Trip', 'assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'Trip', 'Trip.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: trip, file: join('Trip', 'assets', 'mine.png') }));
    expect(held(trip)).toEqual(['mine.png']);
  });

  it('a file a pull left behind, at its old path or under --force, uploads nothing when it is adopted', async () => {
    write(join('assets', 'stray.png'), png('stray'));
    write(join('assets', 'odd.png'), png('odd'));
    write('c.md', 'Mine.\n');
    expect((await cli(['init'])).code).toBe(0);
    const doc = 'd0000000-0000-4000-8000-0000000000bb';
    server.docs.push({ id: doc, title: 'shared', filename: 'shared.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(doc, 'Shared ![s](assets/stray.png)\n');
    expect((await cli(['pull', doc, 'a.md'])).code).toBe(0);
    server.content.set(doc, 'Shared ![o](assets/odd.png)\n');
    // A pull to a new path leaves a.md behind; one with --force over c.md leaves b.md behind.
    expect((await cli(['pull', doc, 'b.md'])).code).toBe(0);
    expect((await cli(['pull', doc, 'c.md', '--force'])).code).toBe(0);

    const adopted = await syncJson();
    const a = createdId(adopted.results, 'a.md')!;
    const b = createdId(adopted.results, 'b.md')!;
    expect(a && b, JSON.stringify(adopted.results)).toBeTruthy();
    await syncJson();
    expect(held(a), JSON.stringify(adopted.results)).toEqual([]);
    expect(held(b), JSON.stringify(adopted.results)).toEqual([]);
    expect(held(doc)).toEqual([]);
    expect(failedFor(adopted.results, a, join('assets', 'stray.png')), JSON.stringify(adopted.results)).toBe(true);

    // Positive control: an image Ada adds to the adopted note goes up.
    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'a.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: a, file: join('assets', 'mine.png') }));
    expect(held(a)).toEqual(['mine.png']);
  });

  for (const damage of ['missing', 'corrupt'] as const) {
    it(`a ${damage} store is rebuilt closed: a stale save of a pulled reference uploads nothing`, async () => {
      write('plan.md', 'The plan.\n');
      write(join('assets', 'stray.png'), png('stray'));
      expect((await cli(['init'])).code).toBe(0);
      const first = await syncJson();
      const plan = createdId(first.results, 'plan.md')!;
      const clean = server.content.get(plan)!;
      const withRef = `${clean.trimEnd()}\n\n![s](assets/stray.png)\n`;
      server.content.set(plan, withRef);
      await syncJson();
      expect(readFileSync(join(dir, 'plan.md'), 'utf8')).toContain('assets/stray.png');

      // The workspace loses its record of what the server showed: the store, and any per-doc record and base.
      if (damage === 'missing') rmSync(state('served-names.json'), { force: true });
      else writeFileSync(state('served-names.json'), '{ "folders": ');
      const metaPath = state(plan, 'meta.json');
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Record<string, unknown>;
      delete meta.served;
      writeFileSync(metaPath, JSON.stringify(meta));
      rmSync(state(plan, 'base.md'), { force: true });

      // Ben removes the reference again; Ada's editor still holds it and saves it with typing of her own.
      server.content.set(plan, clean);
      await syncJson();
      expect(readFileSync(join(dir, 'plan.md'), 'utf8')).not.toContain('stray.png');
      write('plan.md', `${withRef}\nA line of my own.\n`);
      const stale = await syncJson();
      await syncJson();
      expect(held(plan), JSON.stringify(stale.results)).toEqual([]);

      // Positive control: an image Ada adds afterwards goes up.
      write(join('assets', 'new.png'), png('new'));
      appendFileSync(join(dir, 'plan.md'), '\n![n](assets/new.png)\n');
      const own = await syncJson();
      expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'new.png') }));
    });
  }

  it('a note written just before a crash, with no record of its doc yet, uploads nothing when adopted', async () => {
    write(join('assets', 'stray.png'), png('stray'));
    expect((await cli(['init'])).code).toBe(0);
    const doc = 'd0000000-0000-4000-8000-0000000000cc';
    server.docs.push({ id: doc, title: 'shared', filename: 'shared.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(doc, 'Shared ![s](assets/stray.png)\n');
    expect((await cli(['pull', doc, 'shared.md'])).code).toBe(0);
    // The crash: the note is on disk, the doc's record never was.
    rmSync(state(doc), { recursive: true, force: true });

    const adopted = await syncJson();
    const note = createdId(adopted.results, 'shared.md')!;
    expect(note, JSON.stringify(adopted.results)).toBeTruthy();
    await syncJson();
    expect(held(note), JSON.stringify(adopted.results)).toEqual([]);

    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'shared.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: note, file: join('assets', 'mine.png') }));
  });
});

describe('the folder taint store holds under concurrency, Moss\'s own path normalisation, damage and moves (T7.S9 round 5)', () => {
  const state = (...parts: string[]) => join(dir, '.moss-multi', ...parts);

  it('a pull while another process updates the store keeps both updates: the pulled reference never uploads', async () => {
    write(join('assets', 'secret.png'), png('secret'));
    expect((await cli(['init'])).code).toBe(0);
    expect(existsSync(state('served-names.json'))).toBe(true);
    const doc = 'd0000000-0000-4000-8000-0000000000dd';
    server.docs.push({ id: doc, title: 'shared', filename: 'shared.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(doc, 'Shared ![s](assets/secret.png)\n');

    // Another moss-multi process (the watch daemon) holds the store's lock: it has read the store and writes it back later.
    const other = spawn(process.execPath, ['-e', `
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
      const state = path.join(process.argv[1], '.moss-multi');
      const lock = path.join(state, '.served-names.lock');
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: 'other', at: Date.now() }), { flag: 'wx' });
      const store = path.join(state, 'served-names.json');
      const data = JSON.parse(fs.readFileSync(store, 'utf8'));
      process.stdout.write('held\\n');
      setTimeout(() => {
        (data.folders['notes/assets'] ??= []).push('theirs.png');
        fs.writeFileSync(store + '.other', JSON.stringify(data));
        fs.renameSync(store + '.other', store);
        fs.unlinkSync(lock);
        process.exit(0);
      }, 1500);
    `, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>((done) => other.on('exit', done));
    await new Promise<void>((done) => other.stdout.on('data', (chunk: Buffer) => chunk.toString().includes('held') && done()));
    const pulled = await cli(['pull', doc, 'shared.md']);
    expect(await exited).toBe(0);
    expect(pulled.code, pulled.err).toBe(0);
    const store = JSON.parse(readFileSync(state('served-names.json'), 'utf8')) as { folders: Record<string, string[]> };
    expect(store.folders['notes/assets'], 'the other process\'s update stands').toContain('theirs.png');

    appendFileSync(join(dir, 'shared.md'), '\nA line of my own.\n');
    const pushed = await cli(['push', 'shared.md']);
    expect(held(doc), pushed.out + pushed.err).toEqual([]);

    // Positive control: an image Ada adds goes up.
    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'shared.md'), '\n![m](assets/mine.png)\n');
    const own = await cli(['push', 'shared.md']);
    expect(held(doc), own.out + own.err).toEqual(['mine.png']);
  }, 30_000);

  it('a reference Moss resolves only after stripping invisible characters and mapping spaces uploads nothing once the editor saves it', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'secret.png'), png('secret'));
    write(join('assets', 'my file.png'), png('my file'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    expect(plan).toBeTruthy();

    // Ben's references: Moss strips U+200B, and maps U+200B&#8239;U+200B to a space, when it resolves a local asset.
    server.content.set(plan, `${server.content.get(plan)!.trimEnd()}\n\n![x](assets/sec\u200Bret.png)\n\n![y](assets/my\u200B&#8239;\u200Bfile.png)\n`);
    await syncJson();
    const injected = readFileSync(join(dir, 'plan.md'), 'utf8');
    expect(injected).toContain('sec\u200Bret.png');

    // Ada's editor saves the resolved paths with her typing.
    write('plan.md', `${injected.replace('sec\u200Bret.png', 'secret.png').replace('my\u200B&#8239;\u200Bfile.png', 'my%20file.png').trimEnd()}\n\nMy own line.\n`);
    const saved = await syncJson();
    await syncJson();
    expect(held(plan), JSON.stringify(saved.results)).toEqual([]);

    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'plan.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'mine.png') }));
    expect(held(plan)).toEqual(['mine.png']);
  });

  it('a store rebuilt while an assets folder cannot be listed is not trusted: a name it held uploads nothing once it can be listed', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'stray.png'), png('stray'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    const clean = server.content.get(plan)!;
    const withRef = `${clean.trimEnd()}\n\n![s](assets/stray.png)\n`;
    server.content.set(plan, withRef);
    await syncJson();
    server.content.set(plan, clean);
    await syncJson();
    expect(readFileSync(join(dir, 'plan.md'), 'utf8')).not.toContain('stray.png');

    // The store, the base and the prior texts are lost; the store is rebuilt while assets/ can be searched but not listed.
    rmSync(state('served-names.json'), { force: true });
    for (const name of readdirSync(state(plan))) if (name !== 'meta.json') rmSync(state(plan, name), { force: true });
    chmodSync(join(dir, 'assets'), 0o100);
    await syncJson().finally(() => chmodSync(join(dir, 'assets'), 0o755));
    await syncJson();

    // The name comes back in an edit of Ada's own (not a stale editor save, which sync's prior texts catch first).
    write('plan.md', `${clean.trimEnd()}\n\nAgain ![again](assets/stray.png)\n`);
    const later = await syncJson();
    await syncJson();
    expect(held(plan), JSON.stringify(later.results)).toEqual([]);

    write(join('assets', 'new.png'), png('new'));
    appendFileSync(join(dir, 'plan.md'), '\n![n](assets/new.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'new.png') }));
  });

  it('a note moved to another folder carries its folder\'s whole taint: a stale save there uploads nothing', async () => {
    write(join('A', 'n.md'), 'Note.\n');
    write(join('A', 'assets', 'x.png'), png('x'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const note = createdId(first.results, join('A', 'n.md'))!;
    const clean = server.content.get(note)!;
    const withRef = `${clean.trimEnd()}\n\n![x](assets/x.png)\n`;
    // The server shows the reference, then removes it.
    server.content.set(note, withRef);
    await syncJson();
    server.content.set(note, clean);
    await syncJson();
    expect(readFileSync(join(dir, 'A', 'n.md'), 'utf8')).not.toContain('x.png');

    // Ada moves the note, with its images, to B/.
    mkdirSync(join(dir, 'B', 'assets'), { recursive: true });
    renameSync(join(dir, 'A', 'n.md'), join(dir, 'B', 'n.md'));
    writeFileSync(join(dir, 'B', 'assets', 'x.png'), png('x'));
    const moved = await syncJson();
    expect(moved.results).toContainEqual(expect.objectContaining({ action: 'renamed', docId: note, file: join('B', 'n.md') }));

    // A stale editor save re-adds the reference there.
    write(join('B', 'n.md'), `${withRef}\nA line of my own.\n`);
    const stale = await syncJson();
    await syncJson();
    expect(held(note), JSON.stringify(stale.results)).toEqual([]);

    write(join('B', 'assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'B', 'n.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: note, file: join('B', 'assets', 'mine.png') }));
  });

  it('a server text naming more media than the scan records leaves its folder fully tainted and the store under its cap', async () => {
    write(join('Big', 'big.md'), 'Big.\n');
    write(join('Other', 'other.md'), 'Other.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const big = createdId(first.results, join('Big', 'big.md'))!;
    const other = createdId(first.results, join('Other', 'other.md'))!;
    // About 1 MB of distinct a-a-a-…-a.png tokens.
    const flood = Array.from({ length: 12_000 }, (_, i) => `${'a-'.repeat(40)}${i}.png`).join(' ');
    server.content.set(big, `${server.content.get(big)!.trimEnd()}\n\n${flood}\n`);
    await syncJson();
    expect(readFileSync(join(dir, 'Big', 'big.md'), 'utf8')).toContain('a-a-a-');
    expect(statSync(state('served-names.json')).size).toBeLessThan(4 * 1024 * 1024);

    // Nothing uploads from Big/ afterwards, and that is reported; Other/ is unaffected.
    write(join('Big', 'assets', 'fresh.png'), png('fresh'));
    appendFileSync(join(dir, 'Big', 'big.md'), '\n![f](assets/fresh.png)\n');
    write(join('Other', 'assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'Other', 'other.md'), '\n![m](assets/mine.png)\n');
    const after = await syncJson();
    expect(held(big), JSON.stringify(after.results)).toEqual([]);
    expect(failedFor(after.results, big, join('Big', 'assets', 'fresh.png')), JSON.stringify(after.results)).toBe(true);
    expect(after.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: other, file: join('Other', 'assets', 'mine.png') }));
  }, 60_000);

  it('a sibling note that references a file through a spaced destination owns it', async () => {
    write('diary.md', 'Dear diary ![s]( assets/secret.png )\n');
    write('plan.md', 'The plan.\n');
    write(join('assets', 'secret.png'), png('secret'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    appendFileSync(join(dir, 'plan.md'), '\n![s](assets/secret.png)\n');
    const shared = await syncJson();
    expect(held(plan), JSON.stringify(shared.results)).toEqual([]);
    expect(failedFor(shared.results, plan, join('assets', 'secret.png')), JSON.stringify(shared.results)).toBe(true);

    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'plan.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'mine.png') }));
  });
});

describe('the folder taint store follows edited moves, Moss\'s exact path rules and every record a rebuild needs (T7.S9 round 6)', () => {
  const state = (...parts: string[]) => join(dir, '.moss-multi', ...parts);
  const newest = () => server.docs[server.docs.length - 1]!.id;

  it('a note moved to another folder and edited before the next sync uploads nothing the server showed', async () => {
    write(join('Trip', 'Trip.md'), '# Trip\n\nThe trip.\n');
    write(join('Trip', 'assets', 'hidden.png'), png('hidden'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'Trip.md'))!;
    expect(trip).toBeTruthy();
    // Ben adds a reference to a file Ada keeps; her sync pulls it and refuses the file.
    server.content.set(trip, `${server.content.get(trip)!.trimEnd()}\n\n![s](assets/hidden.png)\n`);
    await syncJson();
    expect(readFileSync(join(dir, 'Trip', 'Trip.md'), 'utf8')).toContain('assets/hidden.png');

    // Ada moves the folder into Archive/ and types a line, with an image of her own, before the next sync.
    mkdirSync(join(dir, 'Archive'));
    renameSync(join(dir, 'Trip'), join(dir, 'Archive', 'Trip'));
    write(join('Archive', 'Trip', 'assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'Archive', 'Trip', 'Trip.md'), '\nArchived. ![m](assets/mine.png)\n');
    const moved = await syncJson();
    await syncJson();
    const uploaded = moved.results.filter((result) => result.action === 'uploaded').map((result) => result.file);
    expect(uploaded, JSON.stringify(moved.results)).not.toContain(join('Archive', 'Trip', 'assets', 'hidden.png'));
    expect([...server.assets.keys()].filter((key) => key.endsWith('/hidden.png')), JSON.stringify(moved.results)).toEqual([]);
    // Positive control: her own image goes up for the note at its new path.
    expect(uploaded, JSON.stringify(moved.results)).toContain(join('Archive', 'Trip', 'assets', 'mine.png'));
  });

  it('a fullwidth name Moss resolves after stripping only invisible characters uploads nothing once the editor saves it', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'ｓｅｃｒｅｔ.png'), png('fullwidth'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    server.content.set(plan, `${server.content.get(plan)!.trimEnd()}\n\n![x](assets/ｓｅｃ​ｒｅｔ.png)\n`);
    await syncJson();
    const injected = readFileSync(join(dir, 'plan.md'), 'utf8');
    expect(injected).toContain('ｃ​ｒ');
    write('plan.md', `${injected.replace('ｃ​ｒ', 'ｃｒ').trimEnd()}\n\nMy own line.\n`);
    const saved = await syncJson();
    await syncJson();
    expect(held(plan), JSON.stringify(saved.results)).toEqual([]);

    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'plan.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'mine.png') }));
  });

  it('a zero-padded numeric entity Moss decodes uploads nothing once the editor saves the name it resolves to', async () => {
    write('plan.md', 'The plan.\n');
    write(join('assets', 'secret.png'), png('secret'));
    write(join('assets', 'hidden.png'), png('hidden'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    server.content.set(plan, `${server.content.get(plan)!.trimEnd()}\n\n![x](assets/&#00000000115;ecret.png)\n\n![y](assets/&#x00000000068;idden.png)\n`);
    await syncJson();
    const injected = readFileSync(join(dir, 'plan.md'), 'utf8');
    expect(injected).toContain('&#00000000115;ecret.png');
    write('plan.md', `${injected.replace('&#00000000115;ecret.png', 'secret.png').replace('&#x00000000068;idden.png', 'hidden.png').trimEnd()}\n\nMy own line.\n`);
    const saved = await syncJson();
    await syncJson();
    expect(held(plan), JSON.stringify(saved.results)).toEqual([]);

    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'plan.md'), '\n![m](assets/mine.png)\n');
    const own = await syncJson();
    expect(own.results).toContainEqual(expect.objectContaining({ action: 'uploaded', docId: plan, file: join('assets', 'mine.png') }));
  });

  it('a rebuild that cannot read a doc\'s record uploads nothing until it can', async () => {
    write('plan.md', 'The plan.\n');
    write(join('Other', 'other.md'), 'Other.\n');
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const plan = createdId(first.results, 'plan.md')!;
    const other = createdId(first.results, join('Other', 'other.md'))!;
    expect(plan && other).toBeTruthy();

    // The store is lost while another doc's record cannot be read.
    rmSync(state('served-names.json'), { force: true });
    chmodSync(state(other, 'meta.json'), 0o000);
    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, 'plan.md'), '\n![m](assets/mine.png)\n');
    try {
      const blocked = await cli(['push', 'plan.md']);
      expect(held(plan), blocked.out + blocked.err).toEqual([]);
      expect(readFileSync(state('served-names.json'), 'utf8'), 'the rebuilt store is marked incomplete').toContain('"incomplete"');
    } finally {
      chmodSync(state(other, 'meta.json'), 0o644);
    }
    // Positive control: once the record can be read, the rebuild completes and her image goes up.
    const again = await cli(['push', 'plan.md']);
    expect(held(plan), again.out + again.err).toEqual(['mine.png']);
  });

  it('a rebuild scans a dot-prefixed note a pull left behind: adopting it uploads nothing it names', async () => {
    write('c.md', 'Mine.\n');
    expect((await cli(['init'])).code).toBe(0);
    const doc = 'd0000000-0000-4000-8000-0000000000ee';
    server.docs.push({ id: doc, title: 'shared', filename: 'shared.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(doc, 'Shared ![s](assets/secret.png)\n');
    expect((await cli(['pull', doc, '.old.md'])).code).toBe(0);
    server.content.set(doc, 'Shared.\n');
    expect((await cli(['pull', doc, 'current.md'])).code).toBe(0);
    expect(readFileSync(join(dir, '.old.md'), 'utf8')).toContain('assets/secret.png');

    // The store is lost; later a file under the name .old.md references appears, and Ada adds .old.md with an image of her own.
    rmSync(state('served-names.json'), { force: true });
    write(join('assets', 'secret.png'), png('secret'));
    write(join('assets', 'mine.png'), png('mine'));
    appendFileSync(join(dir, '.old.md'), '\n![m](assets/mine.png)\n');
    const added = await cli(['add', '.old.md']);
    expect(added.code, added.err).toBe(0);
    expect(held(newest()), added.out + added.err).toEqual(['mine.png']);
  });
});

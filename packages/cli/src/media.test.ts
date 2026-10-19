// A note's media step uploads only what its own user put there (T7.S9): a reference that arrived from the server is
// download only, and a file in a shared assets/ folder that another note holds or references never goes up for this one.
// @p:agt-2
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

  it('adoption never counts a reference on a moss note\'s title line', async () => {
    write(join('Trip', 'Trip.md'), '# Trip ![x](assets/private.png)\n\nThe trip.\n');
    write(join('Trip', 'assets', 'private.png'), png('private'));
    expect((await cli(['init'])).code).toBe(0);
    const first = await syncJson();
    const trip = createdId(first.results, join('Trip', 'Trip.md'))!;
    expect(trip).toBeTruthy();
    await syncJson();
    expect(held(trip)).toEqual([]);
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
    expect(added.code, added.err).toBe(0);
    const plan = (JSON.parse(added.out) as { id: string }).id;
    expect(held(plan), added.err).toEqual([]);
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

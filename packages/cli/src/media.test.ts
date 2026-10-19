// A note's media step uploads only what its own user put there (T7.S9): a reference that arrived from the server is
// download only, and a file in a shared assets/ folder that another note holds or references never goes up for this one.
// @p:agt-2
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './program.ts';

const SERVER = 'http://127.0.0.1:9999';
const KEY = `mm_sk_${'a'.repeat(64)}`;

interface Row { id: string; title: string; filename: string; folderId: string; vaultId: string; role: string; updatedAt: number }

/** A fake server: create, list, content, rename, push and per-doc media, as the CLI calls them. */
function fakeServer() {
  const docs: Row[] = [];
  const content = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  let next = 1;
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
      return reply(201, { doc: { id, title, filename, folderId: 'f' }, role: 'owner', content: input.markdown ?? '' });
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
  return { fetchImpl, docs, content, assets };
}

let dir: string;
let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-media-'));
  server = fakeServer();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[]) {
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
  });
  return { code, out: out.join(''), err: errors.join('\n') };
}

type Result = { action: string; file: string; docId?: string; message?: string };
async function syncJson(): Promise<{ code: number; results: Result[]; err: string }> {
  const run = await cli(['sync', '--json']);
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

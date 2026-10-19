// A workspace scope (T7.P1): with `.moss-multi/scope.json`, sync uploads only the notes `allow` names, pulls those and
// the notes `follow` reaches through links (download only), and never touches a denied path, even one an entry links
// to. `scope confirm` writes the notes follow reaches into `allow`. Without the file, every .md syncs as before. @p:agt-2
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './program.ts';
import { noteLinks } from './scope.ts';

const SERVER = 'http://127.0.0.1:9999';
const KEY = `mm_sk_${'a'.repeat(64)}`;
const ALPHA_ID = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const TAXES_ID = '0a1b2c3d-2222-4222-8222-bbbbbbbbbbbb';

interface Row { id: string; title: string; filename: string; folderId: string; vaultId: string; role: string; updatedAt: number }
interface Call { method: string; path: string; body: unknown }

/** A fake server holding many docs: create, list, content, rename, push and media, as the CLI calls them. */
function fakeServer() {
  const calls: Call[] = [];
  const docs: Row[] = [];
  const content = new Map<string, string>();
  const assets = new Map<string, Uint8Array>();
  const uploadAs = new Map<string, string>();
  let next = 1;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, path: url.pathname, body });
    if (new Headers(init.headers).get('authorization') !== `Bearer ${KEY}`) return reply(401, { error: 'unauthenticated' });
    const path = url.pathname;
    if (path === '/api/docs' && method === 'GET') return reply(200, { docs });
    if (path === '/api/docs' && method === 'POST') {
      const input = body as { title?: string; markdown?: string; titleLine?: boolean };
      const id = `d0000000-0000-4000-8000-${String(next++).padStart(12, '0')}`;
      let title = input.title ?? '';
      let markdown = (input.markdown ?? '').replace(/%%m:[A-Za-z0-9_,-]+:(?:start|end)%%/g, '');
      const line = input.titleLine ? /^# ([^\n]+)\n+/.exec(markdown) : null;
      if (line && (!title || title === line[1])) {
        title = line[1]!;
        markdown = markdown.slice(line[0].length);
      }
      const filename = `${(title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
      content.set(id, markdown);
      docs.push({ id, title, filename, folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
      return reply(201, { doc: { id, title, filename, folderId: 'f' }, role: 'owner', content: markdown });
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
      // A name another upload took meanwhile: the server keeps these bytes under another one.
      const stored = uploadAs.get(name) ?? name;
      assets.set(`${id}/${stored}`, new Uint8Array(init.body as Uint8Array));
      return reply(201, { filename: stored });
    }
    if (sub?.startsWith('assets/')) {
      const stored = assets.get(`${id}/${decodeURIComponent(sub.slice('assets/'.length))}`);
      if (!stored) return reply(404, { error: 'not-found' });
      return new Response(method === 'HEAD' ? null : stored, { status: 200, headers: { etag: `"${createHash('sha256').update(stored).digest('hex')}"` } });
    }
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  return { fetchImpl, calls, docs, content, assets, uploadAs };
}

let dir: string;
let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-scope-'));
  server = fakeServer();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Options { cwd?: string; folds?: boolean; confirm?: (question: string) => Promise<boolean>; signal?: AbortSignal }

async function cli(args: string[], options: Options = {}) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runCli(args, {
    env: { MOSS_MULTI_SERVER: SERVER, MOSS_MULTI_API_KEY: KEY, MOSS_MULTI_CONFIG_DIR: join(dir, '.config'), MOSS_MULTI_NO_OPEN: '1' },
    cwd: () => options.cwd ?? dir,
    fetchImpl: server.fetchImpl,
    stdout: (chunk) => out.push(Buffer.from(chunk).toString('utf8')),
    stderr: (line) => errors.push(line),
    sleep: async () => undefined,
    foldsCase: () => options.folds ?? false,
    confirm: options.confirm ?? (async () => false),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { code, out: out.join(''), err: errors.join('\n') };
}

type Result = { action: string; file: string; docId?: string; count?: number };
async function syncJson(options: Options = {}): Promise<{ code: number; results: Result[]; err: string }> {
  const run = await cli(['sync', '--json'], options);
  return { code: run.code, err: run.err, results: run.out.trim() ? JSON.parse(run.out) as Result[] : [] };
}

/** A moss note `<Title>/<Title>.md` under `folder`, with its meta.json when it has an id. */
function note(folder: string, title: string, body: string, id?: string): string {
  const at = join(dir, folder, title);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, `${title}.md`), `# ${title}\n\n${body}\n`);
  if (id) writeFileSync(join(at, 'meta.json'), JSON.stringify({ id, title, createdAt: 1, updatedAt: 1, stickyTabs: [] }));
  return join(folder, title, `${title}.md`);
}

function writeScope(scope: Record<string, unknown>) {
  mkdirSync(join(dir, '.moss-multi'), { recursive: true });
  writeFileSync(join(dir, '.moss-multi', 'scope.json'), JSON.stringify(scope));
}
const readScopeFile = () => JSON.parse(readFileSync(join(dir, '.moss-multi', 'scope.json'), 'utf8')) as { allow?: string[]; follow?: string[]; depth?: number; deny?: string[] };
const allowList = () => [...(readScopeFile().allow ?? [])].sort();
const posix = (rel: string) => rel.split(sep).join('/');

const SECRET = 'bank account 1234';

/**
 * Moss Home links Alpha by its id (under an old title), Beta notes by a relative markdown link with spaces, and Diary and Taxes 2026,
 * which live under denied folders. Beta links Gamma by title. Loose is linked from nowhere.
 */
function pilotVault(scope: Record<string, unknown> | null) {
  const files = {
    home: note('', 'Moss Home', `Start at [[Alpha (old title)|${ALPHA_ID}]], then [Beta](../Beta notes/Beta notes.md). Private: [[Diary]] and [[Taxes 2026|${TAXES_ID}]].`),
    alpha: note('', 'Alpha', 'The alpha note.', ALPHA_ID),
    beta: note('', 'Beta notes', 'Beta leads on to [[Gamma#Notes]].'),
    gamma: note('', 'Gamma', 'Gamma, two hops out.'),
    diary: note('Personal', 'Diary', `Dear diary, ${SECRET}.`),
    taxes: note(join('Admin', 'Finance'), 'Taxes 2026', `Refund to ${SECRET}.`, TAXES_ID),
    loose: note('', 'Loose', 'Nobody links here.'),
  };
  mkdirSync(join(dir, '.moss-multi'), { recursive: true });
  if (scope) writeScope(scope);
  return files;
}

const PILOT = { follow: ['Moss Home'], deny: ['Personal/**', 'Admin/Finance/**'] };
const created = (results: Result[]) => results.filter((result) => result.action === 'created').map((result) => result.file).sort();
const followOnly = (results: Result[]) => results.filter((result) => result.action === 'follow-only').map((result) => result.file).sort();
/** Every byte the CLI sent the server, so a private note's text can be shown never to have left. */
const sent = () => JSON.stringify(server.calls.map((call) => call.body ?? null));

/** `scope confirm --yes <path>...` for the notes `files`, which must succeed. */
async function confirmYes(files: string[], options: Options = {}) {
  const run = await cli(['scope', 'confirm', '--yes', ...files.map(posix)], options);
  expect(run.code, run.err).toBe(0);
  return run;
}

describe('a workspace scope', () => {
  it('follow alone uploads nothing: the notes it reaches are reported, the rest only counted', async () => {
    const files = pilotVault(PILOT);
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([]);
    expect(server.calls.filter((call) => call.method === 'POST')).toEqual([]);
    expect(followOnly(run.results)).toEqual([files.alpha, files.beta, files.home].sort());
    // Gamma (two hops), Loose, Diary and Taxes 2026: a count, never their names.
    expect(run.results.find((result) => result.action === 'out-of-scope')?.count).toBe(4);
    expect(JSON.stringify(run.results)).not.toMatch(/Diary|Taxes|Gamma|Loose/);
  });

  it('scope confirm lists exactly the notes follow reaches, adds exactly those to allow, and sync then uploads exactly them', async () => {
    const files = pilotVault(PILOT);
    const listed = await cli(['scope', 'confirm']);
    expect(listed.code, listed.err).toBe(0);
    for (const file of [files.home, files.alpha, files.beta]) expect(listed.out).toContain(posix(file));
    expect(listed.out).not.toMatch(/Diary|Taxes|Gamma|Loose/);
    // Not confirmed (no terminal, no --yes): nothing is written.
    expect(allowList()).toEqual([]);

    const confirmed = await confirmYes([files.home, files.alpha, files.beta]);
    expect(confirmed.out).not.toMatch(/Diary|Taxes|Gamma|Loose/);
    expect(allowList()).toEqual([files.alpha, files.beta, files.home].map(posix).sort());
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([files.alpha, files.beta, files.home].sort());
    expect(sent()).not.toContain(SECRET);
    expect(server.docs.map((doc) => doc.title).sort()).toEqual(['Alpha', 'Beta notes', 'Moss Home']);
    const again = await syncJson();
    expect(again.results.filter((result) => !['up-to-date', 'out-of-scope'].includes(result.action))).toEqual([]);
  });

  it('--yes alone is refused and adds nothing; --yes with paths adds exactly those; a path follow does not reach is refused', async () => {
    const files = pilotVault(PILOT);
    const bare = await cli(['scope', 'confirm', '--yes']);
    expect(bare.code).toBe(1);
    expect(bare.err).toMatch(/--yes/);
    expect(allowList()).toEqual([]);
    const outside = await cli(['scope', 'confirm', '--yes', posix(files.loose)]);
    expect(outside.code).toBe(1);
    expect(allowList()).toEqual([]);
    const denied = await cli(['scope', 'confirm', '--yes', posix(files.diary)]);
    expect(denied.code).toBe(1);
    expect(allowList()).toEqual([]);
    await confirmYes([files.alpha]);
    expect(allowList()).toEqual([posix(files.alpha)]);
    const run = await syncJson();
    expect(created(run.results)).toEqual([files.alpha]);
  });

  it('an interactive yes confirms too; a no writes nothing', async () => {
    const files = pilotVault(PILOT);
    const asked: string[] = [];
    const no = await cli(['scope', 'confirm'], { confirm: async (question) => (asked.push(question), false) });
    expect(no.code, no.err).toBe(0);
    expect(asked).toHaveLength(1);
    expect(allowList()).toEqual([]);
    const yes = await cli(['scope', 'confirm'], { confirm: async () => true });
    expect(yes.code, yes.err).toBe(0);
    expect(allowList()).toEqual([files.alpha, files.beta, files.home].map(posix).sort());
  });

  it('scope confirm at depth 2 adds the note two hops out, and still never a denied one', async () => {
    const files = pilotVault({ ...PILOT, depth: 2 });
    await confirmYes([files.home, files.alpha, files.beta, files.gamma]);
    expect(allowList()).toEqual([files.alpha, files.beta, files.gamma, files.home].map(posix).sort());
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([files.alpha, files.beta, files.gamma, files.home].sort());
    expect(sent()).not.toContain(SECRET);
  });

  it('a link added here is reported, not uploaded, until scope confirm adds its note', async () => {
    const files = pilotVault(PILOT);
    await confirmYes([files.home, files.alpha, files.beta]);
    expect((await syncJson()).code).toBe(0);
    const home = join(dir, files.home);
    writeFileSync(home, readFileSync(home, 'utf8').replace('Private:', 'Also [[Loose]]. Private:'));
    // Before it syncs, a link typed here is not marked.
    const listed = await cli(['scope', 'confirm']);
    expect(listed.out).toContain(posix(files.loose));
    expect(listed.out, 'a link typed here is not marked').not.toContain('linked by a synced edit');
    const linked = await syncJson();
    expect(linked.code, linked.err).toBe(0);
    expect(created(linked.results)).toEqual([]);
    expect(followOnly(linked.results)).toEqual([files.loose]);
    await confirmYes([files.loose]);
    expect(created((await syncJson()).results)).toEqual([files.loose]);
  });

  it('a doc reached only by follow is pulled while linked and stops syncing when the link goes, keeping its doc', async () => {
    const files = pilotVault({ ...PILOT, allow: ['Moss Home'] });
    const id = 'd0000000-0000-4000-8000-00000000f00d';
    server.docs.push({ id, title: 'Shared', filename: 'shared.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(id, 'Shared text.\n');
    const home = join(dir, files.home);
    writeFileSync(home, readFileSync(home, 'utf8').replace('Private:', 'And [[shared]]. Private:'));
    // Pulled while allowed, then left only to follow.
    writeScope({ ...PILOT, allow: ['Moss Home', 'shared.md'] });
    const pulled = await cli(['pull', id, 'shared.md']);
    expect(pulled.code, pulled.err).toBe(0);
    writeScope({ ...PILOT, allow: ['Moss Home'] });
    server.content.set(id, 'Shared text, edited on the web.\n');
    expect((await syncJson()).code).toBe(0);
    expect(readFileSync(join(dir, 'shared.md'), 'utf8')).toBe('Shared text, edited on the web.\n');
    // Edited here: never sent, since only allow uploads.
    writeFileSync(join(dir, 'shared.md'), 'Edited here.\n');
    expect((await syncJson()).code).toBe(0);
    expect(server.content.get(id)).toBe('Shared text, edited on the web.\n');

    writeFileSync(home, readFileSync(home, 'utf8').replace('And [[shared]]. ', ''));
    server.content.set(id, 'Edited on the web again.\n');
    server.calls.length = 0;
    const after = await syncJson();
    expect(after.code, after.err).toBe(0);
    expect(server.calls.filter((call) => call.path.includes(id))).toEqual([]);
    expect(readFileSync(join(dir, 'shared.md'), 'utf8')).toBe('Edited here.\n');
    expect(server.docs.some((doc) => doc.id === id)).toBe(true);
  });

  it('never writes a server doc to a denied path: not by pull, not to a tracked file now denied, not by a server rename', async () => {
    pilotVault({ allow: ['*.md', 'Notes/**'], deny: ['Personal/**', '**/secret*'] });
    writeFileSync(join(dir, 'plan.md'), 'The plan.\n');
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    const planId = first.results.find((result) => result.action === 'created')!.docId!;

    const pulled = await cli(['pull', planId, join('Personal', 'leak.md')]);
    expect(pulled.code).toBe(1);
    expect(pulled.err).toMatch(/scope/);
    expect(existsSync(join(dir, 'Personal', 'leak.md'))).toBe(false);

    // The server renames the doc to a denied name: the file keeps its name.
    const row = server.docs.find((doc) => doc.id === planId)!;
    row.filename = 'secret-plan.md';
    server.content.set(planId, 'The plan, edited on the web.\n');
    const renamed = await syncJson();
    expect(renamed.code, renamed.err).toBe(0);
    expect(existsSync(join(dir, 'secret-plan.md'))).toBe(false);

    // A tracked file the scope now denies is neither written nor read.
    const tracked = renamed.results.find((result) => result.docId === planId)!.file;
    writeScope({ allow: ['*.md'], deny: [tracked] });
    const before = readFileSync(join(dir, tracked), 'utf8');
    server.content.set(planId, 'Edited on the web again.\n');
    server.calls.length = 0;
    const denied = await syncJson();
    expect(denied.code, denied.err).toBe(0);
    expect(readFileSync(join(dir, tracked), 'utf8')).toBe(before);
    expect(server.calls.filter((call) => call.path.includes(planId))).toEqual([]);
  });

  it('refuses to add a denied note or one only follow reaches', async () => {
    const files = pilotVault(PILOT);
    for (const file of [files.diary, files.alpha]) {
      const added = await cli(['add', file]);
      expect(added.code).toBe(1);
      expect(added.err).toMatch(/scope/);
    }
    expect(sent()).not.toContain(SECRET);
    expect(server.docs).toEqual([]);
  });

  it('a scope file that cannot be read stops the pass before anything is uploaded', async () => {
    pilotVault(null);
    writeFileSync(join(dir, '.moss-multi', 'scope.json'), '{ "allow": [');
    const run = await cli(['sync']);
    expect(run.code).toBe(1);
    expect(run.err).toMatch(/scope\.json/);
    expect(server.docs).toEqual([]);
  });

  it('init --scope writes a scope file from --allow, --follow, --deny and --depth, and sync honours it', async () => {
    const files = pilotVault(null);
    const init = await cli(['init', '--scope', '--allow', 'Loose', '--follow', 'Moss Home', '--deny', 'Personal/**', '--deny', 'Admin/Finance/**', '--depth', '1']);
    expect(init.code, init.err).toBe(0);
    expect(init.out).toContain('scope confirm');
    expect(readScopeFile()).toEqual({ allow: ['Loose'], follow: ['Moss Home'], depth: 1, deny: ['Personal/**', 'Admin/Finance/**'] });
    const run = await syncJson();
    expect(created(run.results)).toEqual([files.loose]);
  });

  it('a plain note adopted through an exact allow keeps its name, so its later edits still sync', async () => {
    mkdirSync(join(dir, 'Notes'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'Daily Plan.md'), 'Plan the day.\n');
    writeFileSync(join(dir, 'Index.md'), 'See [the reading list](Reading%20List.md).\n');
    writeFileSync(join(dir, 'Reading List.md'), 'Books.\n');
    writeScope({ allow: ['Notes/Daily Plan.md'], follow: ['Index.md'] });
    await confirmYes(['Index.md', 'Reading List.md']);
    expect(allowList()).toEqual(['Index.md', 'Notes/Daily Plan.md', 'Reading List.md']);
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    expect(created(first.results)).toEqual(['Index.md', join('Notes', 'Daily Plan.md'), 'Reading List.md'].sort());
    const ids = new Map(first.results.filter((result) => result.action === 'created').map((result) => [result.file, result.docId!]));
    writeFileSync(join(dir, 'Notes', 'Daily Plan.md'), 'Plan the day, then rest.\n');
    writeFileSync(join(dir, 'Reading List.md'), 'Books and papers.\n');
    const second = await syncJson();
    expect(second.code, second.err).toBe(0);
    expect(server.content.get(ids.get(join('Notes', 'Daily Plan.md'))!)).toBe('Plan the day, then rest.\n');
    expect(server.content.get(ids.get('Reading List.md')!)).toBe('Books and papers.\n');
    expect(second.results.find((result) => result.action === 'out-of-scope')).toBeUndefined();
  });

  it('a link that arrives in a pull never uploads a local note; scope confirm lists it and adds it on yes', async () => {
    const files = pilotVault(PILOT);
    await confirmYes([files.home, files.alpha, files.beta]);
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    const homeId = first.results.find((result) => result.file === files.home && result.action === 'created')!.docId!;
    server.content.set(homeId, `${server.content.get(homeId)!.trimEnd()} And [[Loose]].\n`);
    const pulled = await syncJson();
    expect(pulled.code, pulled.err).toBe(0);
    expect(readFileSync(join(dir, files.home), 'utf8')).toContain('[[Loose]]');
    const next = await syncJson();
    expect(next.code, next.err).toBe(0);
    expect(created([...pulled.results, ...next.results])).toEqual([]);
    expect(sent()).not.toContain('Nobody links here');
    expect(followOnly(next.results)).toEqual([files.loose]);

    const listed = await cli(['scope', 'confirm']);
    const entry = listed.out.split('\n').find((text) => text.includes(posix(files.loose)));
    expect(entry, 'listed with its title, the note linking to it, and marked').toMatch(/Loose/);
    expect(entry).toContain(posix(files.home));
    expect(entry).toContain('linked by a synced edit');
    await confirmYes([files.loose]);
    expect(allowList()).toContain(posix(files.loose));
    expect(created((await syncJson()).results)).toEqual([files.loose]);
  });

  // The refuted provenance scenarios: with uploads authorized only by allow, none of them uploads anything outside it.
  it('a remote link removal followed by an interrupted write uploads nothing outside allow', async () => {
    const hub = note('', 'Hub', 'Hub.');
    note('', 'Private', `Private, ${SECRET}.`);
    writeScope({ allow: [posix(hub)], follow: [posix(hub)] });
    const first = await syncJson();
    expect(created(first.results)).toEqual([hub]);
    const hubId = first.results.find((result) => result.action === 'created')!.docId!;
    const state = join(dir, '.moss-multi', hubId);
    server.content.set(hubId, `${server.content.get(hubId)!.trimEnd()} See [[Private]].\n`);
    expect((await syncJson()).code).toBe(0);
    expect(readFileSync(join(dir, hub), 'utf8')).toContain('[[Private]]');
    const withLink = readFileSync(join(dir, hub), 'utf8');
    const saved = mkdtempSync(join(tmpdir(), 'mm-saved-'));
    for (const name of ['base.md', 'meta.json']) copyFileSync(join(state, name), join(saved, name));
    // The server removes the link; the pass dies before the write lands: the file, base and meta are as before.
    server.content.set(hubId, server.content.get(hubId)!.replace(' See [[Private]].', ''));
    expect((await syncJson()).code).toBe(0);
    for (const name of ['base.md', 'meta.json']) copyFileSync(join(saved, name), join(state, name));
    rmSync(saved, { recursive: true, force: true });
    // And the user edits the note, so the stale link goes back along with the edit.
    writeFileSync(join(dir, hub), `${withLink.trimEnd()} Edited here.\n`);
    const next = await syncJson();
    const after = await syncJson();
    expect(next.code, next.err).toBe(0);
    expect(created([...next.results, ...after.results])).toEqual([]);
    expect(sent()).not.toContain(SECRET);
  });

  it('a case-only path change on a case-sensitive volume uploads nothing outside allow', async () => {
    writeFileSync(join(dir, 'Index.md'), 'See [it](Public.md).\n');
    writeFileSync(join(dir, 'Public.md'), 'Public.\n');
    writeFileSync(join(dir, 'public.md'), `Private, ${SECRET}.\n`);
    writeScope({ follow: ['Index.md'] });
    await confirmYes(['Index.md', 'Public.md']);
    expect(allowList()).toEqual(['Index.md', 'Public.md']);
    const first = await syncJson();
    expect(created(first.results)).toEqual(['Index.md', 'Public.md']);
    const indexId = first.results.find((result) => result.file === 'Index.md')!.docId!;
    server.content.set(indexId, 'See [it](public.md).\n');
    expect((await syncJson()).code).toBe(0);
    expect(readFileSync(join(dir, 'Index.md'), 'utf8')).toContain('(public.md)');
    const next = await syncJson();
    expect(next.code, next.err).toBe(0);
    expect(created(next.results)).toEqual([]);
    expect(followOnly(next.results)).toEqual(['public.md']);
    expect(sent()).not.toContain(SECRET);
  });

  it('a byte-identical local rename uploads nothing outside allow', async () => {
    writeFileSync(join(dir, 'hub.md'), 'Hub.\n');
    writeFileSync(join(dir, 'Private.md'), `Private, ${SECRET}.\n`);
    writeScope({ allow: ['hub.md', 'index.md'], follow: ['hub.md', 'index.md'] });
    const first = await syncJson();
    expect(created(first.results)).toEqual(['hub.md']);
    const hubId = first.results.find((result) => result.action === 'created')!.docId!;
    server.content.set(hubId, 'Hub. See [[Private]].\n');
    expect((await syncJson()).code).toBe(0);
    renameSync(join(dir, 'hub.md'), join(dir, 'index.md'));
    const moved = await syncJson();
    const after = await syncJson();
    expect(moved.code, moved.err).toBe(0);
    expect(created([...moved.results, ...after.results])).toEqual([]);
    expect(sent()).not.toContain(SECRET);
  });

  it('on a case-sensitive volume allow and deny match the exact case; on one that folds case, any case', async () => {
    mkdirSync(join(dir, 'Notes'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'A.md'), 'Upper.\n');
    writeFileSync(join(dir, 'Notes', 'a.md'), 'Lower.\n');
    writeFileSync(join(dir, 'Notes', 'B.md'), 'Kept.\n');
    writeScope({ allow: ['Notes/A.md', 'Notes/B.md'], deny: ['notes/b.md'] });
    const exact = await syncJson();
    expect(created(exact.results)).toEqual([join('Notes', 'A.md'), join('Notes', 'B.md')]);

    rmSync(join(dir, 'Notes'), { recursive: true, force: true });
    rmSync(join(dir, '.moss-multi'), { recursive: true, force: true });
    server = fakeServer();
    mkdirSync(join(dir, 'Notes'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'Plan.md'), 'Plan.\n');
    writeFileSync(join(dir, 'Notes', 'Secret.md'), `Private, ${SECRET}.\n`);
    writeScope({ allow: ['notes/plan.md', 'Notes/*'], deny: ['notes/secret.md'] });
    const folded = await syncJson({ folds: true });
    // Adopted, it may take the doc's lowercased filename: on a volume that folds case that is the same file.
    expect(created(folded.results).map((file) => file.toLowerCase())).toEqual([join('notes', 'plan.md')]);
    expect(sent()).not.toContain(SECRET);
  });

  it('a link inside code is not a link, and a denied asset of an in-scope note is never uploaded', async () => {
    const home = note('', 'Moss Home', 'Write links as `[[Loose]]`, and:\n\n```\n[[Gamma]]\n```\n\n![p](assets/private.png)');
    note('', 'Loose', 'Nobody links here.');
    note('', 'Gamma', 'Nor here.');
    mkdirSync(join(dir, 'Moss Home', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Moss Home', 'assets', 'private.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    writeScope({ follow: ['Moss Home'], deny: ['Moss Home/assets/**'] });
    await confirmYes([home]);
    expect(allowList()).toEqual([posix(home)]);
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([home]);
    expect(server.calls.filter((call) => call.path.includes('private.png'))).toEqual([]);
  });

  it('an allowed moss note sends its own assets; a media reference that arrives in a pull never uploads a file outside allow', async () => {
    mkdirSync(join(dir, 'Notes', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'Daily Plan.md'), 'Plan the day.\n');
    writeFileSync(join(dir, 'Notes', 'Private.md'), 'Private, with ![s](assets/secret.png).\n');
    writeFileSync(join(dir, 'Notes', 'assets', 'secret.png'), Buffer.from('89504e470d0a1a0a01', 'hex'));
    const home = note('', 'Moss Home', 'Home ![m](assets/mine.png).');
    mkdirSync(join(dir, 'Moss Home', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Moss Home', 'assets', 'mine.png'), Buffer.from('89504e470d0a1a0a02', 'hex'));
    writeScope({ allow: ['Notes/Daily Plan.md', posix(home)] });
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    expect(created(first.results)).toEqual([home, join('Notes', 'Daily Plan.md')].sort());
    expect([...server.assets.keys()].map((key) => key.split('/')[1])).toEqual(['mine.png']);
    const ids = first.results.filter((result) => result.action === 'created').map((result) => result.docId!);
    // Another replica references a file only this machine holds, in a folder another note shares.
    for (const id of ids) server.content.set(id, `${server.content.get(id)!.trimEnd()}\n\n![s](assets/secret.png)\n`);
    const pulled = await syncJson();
    const next = await syncJson();
    expect(pulled.code, pulled.err).toBe(0);
    expect(next.code, next.err).toBe(0);
    expect(readFileSync(join(dir, 'Notes', 'Daily Plan.md'), 'utf8')).toContain('assets/secret.png');
    expect([...server.assets.keys()].map((key) => key.split('/')[1])).toEqual(['mine.png']);
  });

  it('pull never downloads a media file into a denied path', async () => {
    writeScope({ allow: ['Notes/**'], deny: ['Notes/assets/**'] });
    const id = 'd0000000-0000-4000-8000-00000000abcd';
    server.docs.push({ id, title: 'Plan', filename: 'plan.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(id, 'The plan. ![p](assets/pic.png)\n');
    server.assets.set(`${id}/pic.png`, Buffer.from('89504e470d0a1a0a03', 'hex'));
    const pulled = await cli(['pull', id, join('Notes', 'plan.md')]);
    expect(pulled.code, pulled.err).toBe(0);
    expect(existsSync(join(dir, 'Notes', 'plan.md'))).toBe(true);
    expect(existsSync(join(dir, 'Notes', 'assets', 'pic.png'))).toBe(false);
  });

  it('add, pull and push from outside a scoped workspace never reach into it: a denied note is not uploaded or written', async () => {
    // The vault sits below an unscoped folder the command runs from (an agent working from $HOME).
    const vault = join(dir, 'vault');
    const at = (rel: string) => join(vault, rel);
    mkdirSync(join(vault, 'Personal', 'Diary'), { recursive: true });
    writeFileSync(at(join('Personal', 'Diary', 'Diary.md')), `# Diary\n\nDear diary, ${SECRET}.\n`);
    mkdirSync(join(vault, '.moss-multi'), { recursive: true });
    writeFileSync(join(vault, '.moss-multi', 'scope.json'), JSON.stringify(PILOT));
    const id = 'd0000000-0000-4000-8000-00000000beef';
    server.docs.push({ id, title: 'Leak', filename: 'leak.md', folderId: 'f', vaultId: 'v', role: 'owner', updatedAt: 1 });
    server.content.set(id, 'Server text.\n');

    const added = await cli(['add', join('vault', 'Personal', 'Diary', 'Diary.md')]);
    expect(added.code).toBe(1);
    expect(added.err).toMatch(/workspace/);
    const pulled = await cli(['pull', id, join('vault', 'Personal', 'leak.md')]);
    expect(pulled.code).toBe(1);
    expect(existsSync(at(join('Personal', 'leak.md')))).toBe(false);

    // The same from a workspace of its own around the vault: the vault's scope still holds.
    mkdirSync(join(dir, '.moss-multi'), { recursive: true });
    const nestedAdd = await cli(['add', join('vault', 'Personal', 'Diary', 'Diary.md')]);
    expect(nestedAdd.code).toBe(1);
    expect(nestedAdd.err).toMatch(/workspace/);
    const nestedPull = await cli(['pull', id, join('vault', 'Personal', 'leak.md')]);
    expect(nestedPull.code).toBe(1);
    expect(existsSync(at(join('Personal', 'leak.md')))).toBe(false);

    expect(sent()).not.toContain(SECRET);
    expect(server.docs.map((doc) => doc.id)).toEqual([id]);
  });

  it('a media file the server stores under another name is not written to a denied path', async () => {
    const home = note('', 'Moss Home', 'Home ![p](assets/pic.png).');
    mkdirSync(join(dir, 'Moss Home', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Moss Home', 'assets', 'pic.png'), Buffer.from('89504e470d0a1a0a04', 'hex'));
    writeScope({ allow: [posix(home)], deny: ['Moss Home/assets/pic-2.png'] });
    server.uploadAs.set('pic.png', 'pic-2.png');
    await syncJson();
    expect(existsSync(join(dir, 'Moss Home', 'assets', 'pic-2.png'))).toBe(false);
    expect(readFileSync(join(dir, home), 'utf8')).not.toContain('pic-2.png');
  });

  it('a long line of unclosed links is scanned in linear time', () => {
    const started = Date.now();
    expect(noteLinks('x](y '.repeat(10_000), 'a.md')).toEqual([]);
    expect(noteLinks(`${'[[a\n'.repeat(50_000)}]]`, 'a.md')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('many link openers sharing one closing mark are scanned in linear time', () => {
    const started = Date.now();
    // 40 000 openers (160 KB) before one `)`: a scan that keeps each opener's text to the shared mark is quadratic.
    expect(noteLinks(`${'x](y'.repeat(40_000)})`, 'a.md').length).toBeLessThanOrEqual(1);
    expect(noteLinks(`${'x](<y'.repeat(40_000)}>`, 'a.md').length).toBeLessThanOrEqual(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('sync and watch from an outer workspace leave a tracked note alone once a nested workspace scopes it out', async () => {
    // The outer workspace tracked the diary before the vault inside it got a scope that denies it.
    mkdirSync(join(dir, '.moss-multi'), { recursive: true });
    const diary = join(dir, 'vault', 'Personal', 'Diary', 'Diary.md');
    mkdirSync(join(dir, 'vault', 'Personal', 'Diary'), { recursive: true });
    writeFileSync(diary, '# Diary\n\nDear diary.\n');
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    const [docId] = first.results.filter((result) => result.action === 'created').map((result) => result.docId!);
    expect(docId).toBeDefined();
    mkdirSync(join(dir, 'vault', '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, 'vault', '.moss-multi', 'scope.json'), JSON.stringify({ allow: ['Home'], deny: ['Personal/**'] }));

    writeFileSync(diary, `# Diary\n\nDear diary, ${SECRET}.\n`);
    server.content.set(docId!, 'A remote edit.\n');
    const second = await syncJson();
    expect(second.code, second.err).toBe(0);
    expect(second.results.map((result) => result.action)).not.toContain('pushed');
    expect(sent()).not.toContain(SECRET);
    expect(readFileSync(diary, 'utf8')).toContain(SECRET);

    const controller = new AbortController();
    const before = server.calls.length;
    const running = cli(['watch', '--interval', '0.1'], { signal: controller.signal });
    const deadline = Date.now() + 3_000;
    while (server.calls.slice(before).filter((call) => call.path === '/api/docs').length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const watched = await running;
    expect(watched.code, watched.err).toBe(0);
    expect(server.calls.slice(before).filter((call) => call.path === '/api/docs').length).toBeGreaterThanOrEqual(2);
    expect(sent()).not.toContain(SECRET);
    expect(server.content.get(docId!)).toBe('A remote edit.\n');
    expect(readFileSync(diary, 'utf8')).toContain(SECRET);
  });

  it('a nested workspace with no scope file is reachable from outside, as before scopes', async () => {
    mkdirSync(join(dir, 'other', '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, 'other', 'mine.md'), 'Mine.\n');
    const added = await cli(['add', join('other', 'mine.md')]);
    expect(added.code, added.err).toBe(0);
    expect(server.docs).toHaveLength(1);
  });

  it('pull stops on a scope file that cannot be read before any request', async () => {
    mkdirSync(join(dir, '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, '.moss-multi', 'scope.json'), '{ not json');
    const pulled = await cli(['pull', 'd0000000-0000-4000-8000-00000000beef', 'x.md']);
    expect(pulled.code).toBe(1);
    expect(server.calls).toEqual([]);
  });

  it('without a scope file, every note is synced as before', async () => {
    pilotVault(null);
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toHaveLength(7);
    expect(run.results.some((result) => result.action === 'out-of-scope')).toBe(false);
  });
});

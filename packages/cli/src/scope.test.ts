// A workspace scope (T7.P1): with `.moss-multi/scope.json`, sync adopts, pulls and pushes only the notes it allows or
// reaches by following links from its entry notes, and never a denied path, even one an entry links to. Without the
// file, every .md is synced as before. @p:agt-2
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from './program.ts';

const SERVER = 'http://127.0.0.1:9999';
const KEY = `mm_sk_${'a'.repeat(64)}`;
const ALPHA_ID = '0a1b2c3d-1111-4111-8111-aaaaaaaaaaaa';
const TAXES_ID = '0a1b2c3d-2222-4222-8222-bbbbbbbbbbbb';

interface Row { id: string; title: string; filename: string; folderId: string; vaultId: string; role: string; updatedAt: number }
interface Call { method: string; path: string; body: unknown }

/** A fake server holding many docs: create, list, content, rename and push, as the CLI calls them. */
function fakeServer() {
  const calls: Call[] = [];
  const docs: Row[] = [];
  const content = new Map<string, string>();
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
    if (sub?.startsWith('assets')) return reply(404, { error: 'not-found' });
    return reply(404, { error: 'not-found' });
  }) as typeof fetch;
  return { fetchImpl, calls, docs, content };
}

let dir: string;
let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mm-scope-'));
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
  });
  return { code, out: out.join(''), err: errors.join('\n') };
}

type Result = { action: string; file: string; docId?: string; count?: number };
async function syncJson(): Promise<{ code: number; results: Result[]; err: string }> {
  const run = await cli(['sync', '--json']);
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
  if (scope) writeFileSync(join(dir, '.moss-multi', 'scope.json'), JSON.stringify(scope));
  return files;
}

const PILOT = { follow: ['Moss Home'], deny: ['Personal/**', 'Admin/Finance/**'] };
const created = (results: Result[]) => results.filter((result) => result.action === 'created').map((result) => result.file).sort();
/** Every byte the CLI sent the server, so a denied note's text can be shown never to have left. */
const sent = () => JSON.stringify(server.calls.map((call) => call.body ?? null));

describe('a workspace scope', () => {
  it('syncs exactly the entry note and the notes it links to, never a denied note it links to, and counts the rest', async () => {
    const files = pilotVault(PILOT);
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([files.alpha, files.beta, files.home].sort());
    expect(sent()).not.toContain(SECRET);
    expect(server.docs.map((doc) => doc.title).sort()).toEqual(['Alpha', 'Beta notes', 'Moss Home']);
    // Gamma (two hops), Loose, Diary and Taxes 2026: a count, never their names.
    const out = run.results.find((result) => result.action === 'out-of-scope');
    expect(out?.count).toBe(4);
    expect(JSON.stringify(run.results)).not.toMatch(/Diary|Taxes|Gamma|Loose/);
    const again = await syncJson();
    expect(again.results.filter((result) => !['up-to-date', 'out-of-scope'].includes(result.action))).toEqual([]);
  });

  it('follows links two hops out at depth 2, and still never into a denied folder', async () => {
    const files = pilotVault({ ...PILOT, depth: 2 });
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([files.alpha, files.beta, files.gamma, files.home].sort());
    expect(sent()).not.toContain(SECRET);
  });

  it('brings in a newly linked note on the next pass, and stops syncing one whose link is removed without deleting its doc', async () => {
    const files = pilotVault(PILOT);
    expect((await syncJson()).code).toBe(0);
    const home = join(dir, files.home);
    writeFileSync(home, readFileSync(home, 'utf8').replace('Private:', 'Also [[Loose]]. Private:'));
    const linked = await syncJson();
    expect(linked.code, linked.err).toBe(0);
    expect(created(linked.results)).toEqual([files.loose]);
    const looseId = linked.results.find((result) => result.action === 'created')!.docId!;

    writeFileSync(home, readFileSync(home, 'utf8').replace('Also [[Loose]]. ', ''));
    expect((await syncJson()).code).toBe(0);
    // Out of scope now: a local edit is not pushed and a server edit is not pulled, and the doc stays.
    writeFileSync(join(dir, files.loose), '# Loose\n\nEdited here.\n');
    server.content.set(looseId, 'Edited on the web.\n');
    server.calls.length = 0;
    const after = await syncJson();
    expect(after.code, after.err).toBe(0);
    expect(server.calls.filter((call) => call.path.includes(looseId))).toEqual([]);
    expect(readFileSync(join(dir, files.loose), 'utf8')).toBe('# Loose\n\nEdited here.\n');
    expect(server.docs.some((doc) => doc.id === looseId)).toBe(true);
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
    writeFileSync(join(dir, '.moss-multi', 'scope.json'), JSON.stringify({ allow: ['*.md'], deny: [tracked] }));
    const before = readFileSync(join(dir, tracked), 'utf8');
    server.content.set(planId, 'Edited on the web again.\n');
    server.calls.length = 0;
    const denied = await syncJson();
    expect(denied.code, denied.err).toBe(0);
    expect(readFileSync(join(dir, tracked), 'utf8')).toBe(before);
    expect(server.calls.filter((call) => call.path.includes(planId))).toEqual([]);
  });

  it('refuses to push or add a note outside the scope', async () => {
    const files = pilotVault(PILOT);
    const added = await cli(['add', files.diary]);
    expect(added.code).toBe(1);
    expect(added.err).toMatch(/scope/);
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

  it('init --scope writes a scope file from --follow, --deny and --depth, and sync honours it', async () => {
    const files = pilotVault(null);
    const init = await cli(['init', '--scope', '--follow', 'Moss Home', '--deny', 'Personal/**', '--deny', 'Admin/Finance/**', '--depth', '1']);
    expect(init.code, init.err).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, '.moss-multi', 'scope.json'), 'utf8'))).toEqual({ allow: [], follow: ['Moss Home'], depth: 1, deny: ['Personal/**', 'Admin/Finance/**'] });
    const run = await syncJson();
    expect(created(run.results)).toEqual([files.alpha, files.beta, files.home].sort());
  });

  it('a plain note adopted through an exact allow or a markdown link keeps its name, so its later edits still sync', async () => {
    mkdirSync(join(dir, 'Notes'), { recursive: true });
    mkdirSync(join(dir, '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, 'Notes', 'Daily Plan.md'), 'Plan the day.\n');
    writeFileSync(join(dir, 'Index.md'), 'See [the reading list](Reading%20List.md).\n');
    writeFileSync(join(dir, 'Reading List.md'), 'Books.\n');
    writeFileSync(join(dir, '.moss-multi', 'scope.json'), JSON.stringify({ allow: ['Notes/Daily Plan.md'], follow: ['Index.md'] }));
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

  it('a link that arrives in a pull never makes a local note upload until `scope confirm`; a link added here is followed at once', async () => {
    const files = pilotVault(null);
    expect((await cli(['init', '--scope', '--follow', 'Moss Home', '--deny', 'Personal/**', '--deny', 'Admin/Finance/**'])).code).toBe(0);
    const first = await syncJson();
    expect(first.code, first.err).toBe(0);
    const homeId = first.results.find((result) => result.file === files.home && result.action === 'created')!.docId!;
    // Someone else adds a link to Loose, a local note nobody here linked.
    server.content.set(homeId, `${server.content.get(homeId)!.trimEnd()} And [[Loose]].\n`);
    const pulled = await syncJson();
    expect(pulled.code, pulled.err).toBe(0);
    expect(readFileSync(join(dir, files.home), 'utf8')).toContain('[[Loose]]');
    const next = await syncJson();
    expect(next.code, next.err).toBe(0);
    expect(created([...pulled.results, ...next.results])).toEqual([]);
    expect(sent()).not.toContain('Nobody links here');
    expect(next.results.find((result) => result.action === 'remote-link')?.file).toBe(files.loose);

    const confirmed = await cli(['scope', 'confirm']);
    expect(confirmed.code, confirmed.err).toBe(0);
    expect(created((await syncJson()).results)).toEqual([files.loose]);

    // A link written here goes at once, even in a note already synced.
    const home = join(dir, files.home);
    writeFileSync(home, readFileSync(home, 'utf8').replace('Private:', 'Gamma too: [[Gamma]]. Private:'));
    expect(created((await syncJson()).results)).toEqual([files.gamma]);
  });

  it('a link inside code is not a link, and a denied asset of an in-scope note is never uploaded', async () => {
    note('', 'Moss Home', 'Write links as `[[Loose]]`, and:\n\n```\n[[Gamma]]\n```\n\n![p](assets/private.png)');
    note('', 'Loose', 'Nobody links here.');
    note('', 'Gamma', 'Nor here.');
    mkdirSync(join(dir, 'Moss Home', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Moss Home', 'assets', 'private.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    mkdirSync(join(dir, '.moss-multi'), { recursive: true });
    writeFileSync(join(dir, '.moss-multi', 'scope.json'), JSON.stringify({ follow: ['Moss Home'], deny: ['Moss Home/assets/**'] }));
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toEqual([join('Moss Home', 'Moss Home.md')]);
    expect(server.calls.filter((call) => call.path.includes('private.png'))).toEqual([]);
  });

  it('without a scope file, every note is synced as before', async () => {
    pilotVault(null);
    const run = await syncJson();
    expect(run.code, run.err).toBe(0);
    expect(created(run.results)).toHaveLength(7);
    expect(run.results.some((result) => result.action === 'out-of-scope')).toBe(false);
  });
});

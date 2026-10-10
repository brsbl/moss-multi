// j18-sync (T7.4): the built moss-multi CLI keeps a local folder in sync with the stack (PRODUCT ruling 9). `watch`
// pushes a local edit to the web and writes a web edit into the local file; a local delete never trashes the doc;
// `init` makes a folder a workspace, and `sync` then turns an untracked file into a doc titled from its stem and renames the file to the doc's filename; a
// moss vault note syncs through the moss interchange path with one title and its comments anchored, and its file stays in moss format; and `add
// --title` on a file whose first line is that title shows the title once.
//
// The note being watched is imported through POST /api/docs as declared setup; import is not this journey's promise.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../lib/actors.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';
import { childBudgetEnv } from '../lib/budget.ts';

const CLI = fileURLToPath(new URL('../../packages/cli/dist/moss-multi.mjs', import.meta.url));
const SOLO = 'one person and her own agent key keep her own notes folder in sync';
const BIND_TIMEOUT = 30_000;
const SYNC_TIMEOUT = 30_000;

interface Run { code: number; stdout: string; stderr: string }

function moss(args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...childBudgetEnv(), ...env }, encoding: 'utf8', timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'mm-j18s-'));

async function importNote(actor: Actor, stack: Stack, title: string, markdown: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title, markdown }, timeout: 60_000 });
  expect(response.status(), `declared setup: "${title}" is imported`).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

async function agentEnv(actor: Actor, stack: Stack, dir: string): Promise<Record<string, string>> {
  const minted = await actor.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name: 'Scribe' } });
  expect(minted.status(), 'declared setup: an agent key').toBe(201);
  const { key } = (await minted.json()) as { key: string };
  return { MOSS_MULTI_SERVER: stack.baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, 'config') };
}

async function served(actor: Actor, docId: string): Promise<{ status: number; text: string }> {
  const response = await actor.context.request.get(`/api/docs/${docId}/content`, { timeout: 30_000 });
  return { status: response.status(), text: await response.text() };
}

const readOr = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** Opens the doc and waits for its body and title to bind. */
async function openDoc(actor: Actor, docId: string): Promise<void> {
  await actor.goto(`/d/${docId}`);
  await ui.waitLive(actor, docId);
}

/** `watch` in `dir`, ticking every `interval` seconds; resolves once it says it is watching. */
async function startWatch(dir: string, env: Record<string, string>, interval: number): Promise<{ child: ChildProcessWithoutNullStreams; output: () => string; stop: () => Promise<number> }> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', String(interval)], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, ...childBudgetEnv(), ...env } });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const exited = new Promise<number>((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  await expect.poll(() => output, { message: 'watch says it is watching', timeout: 15_000 }).toContain('watching');
  return {
    child,
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      return Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 10_000))]);
    },
  };
}

test('j18-sync watch: a local edit appears on the web, a web edit updates the local file, a local delete does not propagate @p:agt-2 @p:R9 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Garden plan', 'Beans first.');
  const dir = scratch();
  const env = await agentEnv(ada, stack, dir);
  let watcher: Awaited<ReturnType<typeof startWatch>> | null = null;
  try {
    const pulled = await moss(['pull', docId, 'garden-plan.md'], env, dir);
    expect(pulled.code, pulled.stderr).toBe(0);
    const file = join(dir, 'garden-plan.md');
    watcher = await startWatch(dir, env, 2);

    writeFileSync(file, `${readFileSync(file, 'utf8').replace(/\n*$/, '')}\n\nPeas next.\n`);
    await openDoc(ada, docId);
    await expect(ui.body(ada, docId), 'the local edit reaches the web editor').toContainText('Peas next.', { timeout: SYNC_TIMEOUT });

    await ui.typeBody(ada, docId, ' Water daily.');
    await ui.waitAcked(ada, docId);
    await expect.poll(() => readOr(file), { message: 'the web edit reaches the local file', timeout: SYNC_TIMEOUT }).toContain('Water daily.');
    expect(readOr(file), 'and the local edit is still there').toContain('Peas next.');
    await actors.checkpoint('both-ways');

    rmSync(file);
    await expect.poll(() => readOr(file), { message: 'the deleted file comes back from the server', timeout: SYNC_TIMEOUT }).toContain('Water daily.');
    const after = await served(ada, docId);
    expect(after.status, 'the doc was not trashed').toBe(200);
    expect(after.text, 'and keeps its text').toContain('Peas next.');
    await expect(ui.body(ada, docId), 'the open note still shows it').toContainText('Water daily.');
    expect(await watcher.stop(), `watch stops cleanly on SIGTERM: ${watcher.output()}`).toBe(0);
    watcher = null;
  } finally {
    if (watcher) watcher.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('j18-sync sync: an untracked file becomes a doc titled from its stem, the file takes its filename, and it renders in the web editor @p:agt-2 @p:R9 @p:agt-1', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const dir = scratch();
  const env = await agentEnv(ada, stack, dir);
  try {
    writeFileSync(join(dir, 'Seed Packets.md'), 'Order the beans in March.\n\n- Runner beans\n- Sugar snap peas\n');
    const init = await moss(['init'], env, dir);
    expect(init.code, `the folder becomes a workspace only when asked: ${init.stderr}`).toBe(0);
    const synced = await moss(['sync', '--json'], env, dir);
    expect(synced.code, synced.stderr).toBe(0);
    const results = JSON.parse(synced.stdout) as { action: string; docId?: string; file: string }[];
    const created = results.find((result) => result.action === 'created');
    expect(created, `sync reports the new doc: ${synced.stdout}`).toBeTruthy();
    const docId = created!.docId!;
    expect(existsSync(join(dir, 'Seed Packets.md')), 'the untracked name is gone').toBe(false);
    expect(readdirSync(dir).filter((name) => name.endsWith('.md')), 'the file is renamed to the doc\'s filename').toEqual(['seed-packets.md']);
    expect(readFileSync(join(dir, 'seed-packets.md'), 'utf8')).toContain('Order the beans in March.');

    await openDoc(ada, docId);
    await expect(ui.title(ada, docId), 'titled from the file stem').toHaveText('Seed Packets', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId), 'the CLI-created doc renders in the web editor').toContainText('Order the beans in March.');
    await expect(ui.body(ada, docId).getByRole('listitem'), 'its list renders as a list').toHaveCount(2);
    await actors.checkpoint('created-renders');

    const again = await moss(['sync', '--json'], env, dir);
    expect(again.code, again.stderr).toBe(0);
    expect((JSON.parse(again.stdout) as { action: string }[]).filter((result) => result.action === 'created'), 'a second sync creates nothing').toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('j18-sync moss note: sync imports a moss vault note with one title and its comments anchored, and leaves the file in moss format @p:agt-2 @p:note-3', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const dir = scratch();
  const env = await agentEnv(ada, stack, dir);
  try {
    const bundle = join(dir, 'Tomato log');
    mkdirSync(bundle);
    writeFileSync(join(bundle, 'Tomato log.md'), '# Tomato log\n\nThe %%m:c1:start%%cherry tomatoes%%m:c1:end%% ripened first.\n');
    writeFileSync(join(bundle, 'comments.json'), JSON.stringify({ c1: { text: 'Save seeds from these', createdAt: 1_700_000_000, updatedAt: 1_700_000_000, source: 'user' } }));
    const note = readFileSync(join(bundle, 'Tomato log.md'), 'utf8');
    expect((await moss(['init'], env, dir)).code).toBe(0);
    const synced = await moss(['sync', '--json'], env, dir);
    expect(synced.code, synced.stderr).toBe(0);
    const created = (JSON.parse(synced.stdout) as { action: string; docId?: string }[]).filter((result) => result.action === 'created');
    expect(created, `one doc: ${synced.stdout}`).toHaveLength(1);
    const docId = created[0]!.docId!;
    expect(readdirSync(bundle).sort(), 'the moss note keeps its name').toEqual(['Tomato log.md', 'comments.json']);
    expect(readFileSync(join(bundle, 'Tomato log.md'), 'utf8'), 'and its title line and markers').toBe(note);

    await openDoc(ada, docId);
    await expect(ui.title(ada, docId), 'the # line is the title').toHaveText('Tomato log', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId)).toContainText('ripened first.');
    await expect(ui.body(ada, docId).getByRole('heading'), 'and not a heading in the body too').toHaveCount(0);
    expect(await ui.fieldText(ada, docId, 'body'), 'no marker reaches the body').not.toContain('%%m:');
    await expect.poll(() => ui.body(ada, docId).evaluate((root) => {
      const out: string[] = [];
      CSS.highlights.forEach((highlight, name) => {
        if (!/^moss-comment-\d+$/.test(name)) return;
        highlight.forEach((range) => { if (!range.collapsed && root.contains(range.startContainer)) out.push((range as Range).toString()); });
      });
      return out;
    }), { message: 'the comment is anchored on its words', timeout: BIND_TIMEOUT }).toEqual(['cherry tomatoes']);
    const content = await served(ada, docId);
    expect(content.text, 'the export carries neither the title line nor a marker').not.toMatch(/Tomato log|%%m:/);
    const again = await moss(['sync', '--json'], env, dir);
    expect(again.code, again.stderr).toBe(0);
    expect((JSON.parse(again.stdout) as { action: string }[]).filter((result) => result.action !== 'up-to-date'), 'a second sync changes nothing').toEqual([]);
    expect(readFileSync(join(bundle, 'Tomato log.md'), 'utf8')).toBe(note);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('j18-sync add --title: a file whose first line is that title shows the title once, with no duplicate H1 @p:agt-1 @p:note-1', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const dir = scratch();
  const env = await agentEnv(ada, stack, dir);
  try {
    writeFileSync(join(dir, 'tomato.md'), '# Tomato log\n\nPlant out in May.\n');
    const added = await moss(['add', 'tomato.md', '--title', 'Tomato log'], env, dir);
    expect(added.code, added.stderr).toBe(0);
    const docId = added.stdout.trim();

    await openDoc(ada, docId);
    await expect(ui.title(ada, docId)).toHaveText('Tomato log', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId)).toContainText('Plant out in May.');
    await expect(ui.body(ada, docId).getByRole('heading'), 'the title is not repeated as an H1').toHaveCount(0);
    expect(await ui.fieldText(ada, docId, 'body')).not.toContain('Tomato log');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

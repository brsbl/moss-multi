// j18-sync (T7.4): the built moss-multi CLI keeps a local folder in sync with the stack (PRODUCT ruling 9). `watch`
// pushes a local edit to the web and writes a web edit into the local file; a local delete never trashes the doc;
// `init` makes a folder a workspace, and `sync` then turns an untracked file into a doc titled from its stem and renames the file to the doc's filename; a
// moss vault note syncs through the moss interchange path with one title and its comments anchored, and its file stays in moss format; and `add
// --title` on a file whose first line is that title shows the title once. A note's `assets/` media travel with it both
// ways through the doc's asset routes: a name another note's media holds on the server is taken under the next free
// name and the note's reference follows, and a transfer the server cannot take is reported as failed.
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

const CLI = fileURLToPath(new URL('../../packages/cli/dist/moss-multi.mjs', import.meta.url));
const SOLO = 'one person and her own agent key keep her own notes folder in sync';
const BIND_TIMEOUT = 30_000;
const SYNC_TIMEOUT = 30_000;

interface Run { code: number; stdout: string; stderr: string }

function moss(args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env }, encoding: 'utf8', timeout: 60_000 },
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
const MEDIA = new URL('../fixtures/media/', import.meta.url);
const fixture = (name: string): Buffer => readFileSync(new URL(name, MEDIA));
/** A second PNG, other bytes than pattern.png, for the name collision. */
const DOT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

async function asset(actor: Actor, docId: string, name: string): Promise<{ status: number; body: Buffer }> {
  const response = await actor.context.request.get(`/api/docs/${docId}/assets/${name}`, { timeout: 30_000 });
  return { status: response.status(), body: response.ok() ? await response.body() : Buffer.alloc(0) };
}

/** Opens the doc and waits for its body and title to bind. */
async function openDoc(actor: Actor, docId: string): Promise<void> {
  await actor.goto(`/d/${docId}`);
  await ui.waitLive(actor, docId);
}

/** `watch` in `dir`, ticking every `interval` seconds; resolves once it says it is watching. */
async function startWatch(dir: string, env: Record<string, string>, interval: number): Promise<{ child: ChildProcessWithoutNullStreams; output: () => string; stop: () => Promise<number> }> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  const child = spawn(process.execPath, [CLI, 'watch', '--interval', String(interval)], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, ...env } });
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

test('j18-sync media: a note\'s image and video round-trip through sync and pull, a name collision takes the next free name, and a refused upload is reported as failed @p:agt-2 @p:R9 @p:note-8', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const dir = scratch();
  const away = scratch();
  const env = await agentEnv(ada, stack, dir);
  type Result = { action: string; docId?: string; file: string; message?: string };
  const syncJson = async (cwd: string): Promise<{ run: Run; results: Result[] }> => {
    const run = await moss(['sync', '--json'], env, cwd);
    return { run, results: run.stdout.trim() ? (JSON.parse(run.stdout) as Result[]) : [] };
  };
  try {
    // Two moss notes in one vault folder, each with its own pattern.png: the server holds one name per folder.
    for (const [name, bytes] of [['Garden', fixture('pattern.png')], ['Shed', DOT_PNG]] as const) {
      mkdirSync(join(dir, name, 'assets'), { recursive: true });
      writeFileSync(join(dir, name, 'assets', 'pattern.png'), bytes);
    }
    writeFileSync(join(dir, 'Garden', 'assets', 'clip.webm'), fixture('clip.webm'));
    writeFileSync(join(dir, 'Garden', 'Garden.md'), '# Garden\n\nThe beds in May.\n\n![pattern](assets/pattern.png)\n\n![clip](assets/clip.webm)\n');
    writeFileSync(join(dir, 'Shed', 'Shed.md'), '# Shed\n\nThe door.\n\n![pattern](assets/pattern.png)\n');
    expect((await moss(['init'], env, dir)).code).toBe(0);

    const first = await syncJson(dir);
    expect(first.run.code, `${first.run.stderr}\n${first.run.stdout}`).toBe(0);
    const docOf = (file: string) => first.results.find((result) => result.action === 'created' && result.file === file)?.docId;
    const garden = docOf(join('Garden', 'Garden.md'));
    const shed = docOf(join('Shed', 'Shed.md'));
    expect(garden && shed, `both notes become docs: ${first.run.stdout}`).toBeTruthy();
    expect(first.results.filter((result) => result.action === 'uploaded').map((result) => result.file).sort(), 'each file is uploaded once').toEqual([
      join('Garden', 'assets', 'clip.webm'), join('Garden', 'assets', 'pattern.png'), join('Shed', 'assets', 'pattern.png'),
    ]);
    expect((await asset(ada, garden!, 'pattern.png')).body.equals(fixture('pattern.png')), 'the PNG reaches the server byte for byte').toBe(true);
    expect((await asset(ada, garden!, 'clip.webm')).body.equals(fixture('clip.webm')), 'and so does the video').toBe(true);

    // The collision: Shed's image takes the next free name, and its note (here and on the server) follows it.
    expect((await asset(ada, shed!, 'pattern-2.png')).body.equals(DOT_PNG), 'Shed keeps its own image under the next free name').toBe(true);
    expect(readFileSync(join(dir, 'Shed', 'Shed.md'), 'utf8'), 'the local note references the name it got').toContain('](assets/pattern-2.png)');
    expect(readFileSync(join(dir, 'Shed', 'assets', 'pattern-2.png')).equals(DOT_PNG), 'the file is there under that name').toBe(true);
    expect(readFileSync(join(dir, 'Shed', 'assets', 'pattern.png')).equals(DOT_PNG), 'the original file is left as it was').toBe(true);
    expect((await served(ada, shed!)).text, 'the doc references it too').toContain('](assets/pattern-2.png)');
    expect((await asset(ada, garden!, 'pattern.png')).body.equals(fixture('pattern.png')), 'Garden\'s image is untouched').toBe(true);

    const second = await syncJson(dir);
    expect(second.run.code, second.run.stderr).toBe(0);
    expect(second.results.filter((result) => result.action !== 'up-to-date'), 'a second sync moves nothing').toEqual([]);

    await openDoc(ada, garden!);
    await expect.poll(() => ui.body(ada, garden!).locator('img[src*="/assets/pattern.png"]').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
      .catch(() => false), { message: 'the image renders on the web', timeout: BIND_TIMEOUT }).toBe(true);
    await expect(ui.body(ada, garden!).locator('[data-video-node-kind="local"]'), 'and the video').toHaveCount(1, { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, garden!).locator('[data-video-error-state]')).toHaveCount(0);
    await actors.checkpoint('media-on-web');

    // Down: pull writes the media beside the file, and sync brings back a file deleted here.
    const awayEnv = { ...env, MOSS_MULTI_CONFIG_DIR: join(away, 'config') };
    expect((await moss(['init'], awayEnv, away)).code).toBe(0);
    const pulled = await moss(['pull', garden!, 'garden.md'], awayEnv, away);
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(readFileSync(join(away, 'assets', 'pattern.png')).equals(fixture('pattern.png')), 'pull writes the PNG byte for byte').toBe(true);
    expect(readFileSync(join(away, 'assets', 'clip.webm')).equals(fixture('clip.webm')), 'and the video').toBe(true);
    rmSync(join(away, 'assets', 'clip.webm'));
    const back = await moss(['sync', '--json'], awayEnv, away);
    expect(back.code, back.stderr).toBe(0);
    expect((JSON.parse(back.stdout) as Result[]).filter((result) => result.action === 'downloaded').map((result) => result.file), 'sync downloads it again')
      .toEqual([join('assets', 'clip.webm')]);
    expect(readFileSync(join(away, 'assets', 'clip.webm')).equals(fixture('clip.webm'))).toBe(true);

    // A failed transfer: an image past the 10 MB cap is reported as failed, and the note's text still syncs.
    mkdirSync(join(dir, 'Big', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'Big', 'assets', 'huge.png'), Buffer.concat([fixture('pattern.png'), Buffer.alloc(11 * 1024 * 1024)]));
    writeFileSync(join(dir, 'Big', 'Big.md'), '# Big\n\n![huge](assets/huge.png)\n');
    const big = await syncJson(dir);
    expect(big.run.code, `a failed transfer fails the sync: ${big.run.stdout}`).toBe(1);
    const failed = big.results.find((result) => result.file === join('Big', 'assets', 'huge.png'));
    expect(failed?.action, `the image is reported as failed: ${big.run.stdout}`).toBe('failed');
    expect(failed?.message ?? '').toMatch(/10 MB/);
    const bigDoc = big.results.find((result) => result.action === 'created')?.docId;
    expect(bigDoc, 'the note itself is created').toBeTruthy();
    expect((await asset(ada, bigDoc!, 'huge.png')).status, 'nothing reached the server').toBe(404);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(away, { recursive: true, force: true });
  }
});

test('j18-sync stale save: an editor that saves its old text over a pulled agent edit never reverts it; a clash is set aside, not pushed @p:agt-2 @p:R9', async ({ actors, stack }) => {
  // Moss's overwrite bug (T7.P2): a note open with unsaved typing is saved from the editor's text after the daemon
  // wrote a pulled edit into its file. The agent edits from a second workspace, as on the Linux replica.
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Field notes', 'Para one.\n\nPara two.\n\nPara three.\n\nPara four.');
  const mac = scratch();
  const linux = scratch();
  const env = await agentEnv(ada, stack, mac);
  const agentEdit = async (from: string, to: string) => {
    const pulled = await moss(['pull', docId, 'note.md', '--force'], env, linux);
    expect(pulled.code, pulled.stderr).toBe(0);
    writeFileSync(join(linux, 'note.md'), readFileSync(join(linux, 'note.md'), 'utf8').replace(from, to));
    const pushed = await moss(['push', 'note.md'], env, linux);
    expect(pushed.code, pushed.stderr).toBe(0);
  };
  try {
    expect((await moss(['init'], env, mac)).code).toBe(0);
    const pulled = await moss(['pull', docId, 'note.md'], env, mac);
    expect(pulled.code, pulled.stderr).toBe(0);
    const file = join(mac, 'note.md');
    const editor = readFileSync(file, 'utf8');

    await agentEdit('Para two.', 'Para two, edited by the agent.');
    const pull = await moss(['sync'], env, mac);
    expect(pull.code, pull.stderr).toBe(0);
    expect(readFileSync(file, 'utf8'), 'the daemon writes the agent edit into the file').toContain('Para two, edited by the agent.');

    writeFileSync(file, editor.replace('Para four.', 'Para four, and my typing.'));
    const saved = await moss(['sync'], env, mac);
    expect(saved.code, `${saved.stdout}${saved.stderr}`).toBe(0);
    const after = await served(ada, docId);
    expect(after.text, 'the server keeps the agent edit').toContain('Para two, edited by the agent.');
    expect(after.text, 'and gains the typing').toContain('Para four, and my typing.');
    expect(readFileSync(file, 'utf8'), 'the file holds both').toContain('Para two, edited by the agent.');
    expect(readFileSync(file, 'utf8')).toContain('Para four, and my typing.');

    const held = readFileSync(file, 'utf8');
    await agentEdit('Para three.', 'Para three, edited by the agent.');
    expect((await moss(['sync'], env, mac)).code).toBe(0);
    writeFileSync(file, held.replace('Para three.', 'Para three, rewritten in the editor.'));
    const clash = await moss(['sync', '--json'], env, mac);
    expect(clash.code, `a clash exits 2: ${clash.stdout}${clash.stderr}`).toBe(2);
    const kept = await served(ada, docId);
    expect(kept.text, 'no revert reaches the server').toContain('Para three, edited by the agent.');
    expect(kept.text).not.toContain('rewritten in the editor');
    expect(kept.text, 'the earlier edits stand').toContain('Para four, and my typing.');
    expect(readFileSync(file, 'utf8'), 'the file takes the server version').toContain('Para three, edited by the agent.');
    expect(readOr(`${file}.rej`), 'the typing waits beside the note').toContain('+Para three, rewritten in the editor.');
  } finally {
    rmSync(mac, { recursive: true, force: true });
    rmSync(linux, { recursive: true, force: true });
  }
});

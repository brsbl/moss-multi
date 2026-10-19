// j18-replica (T7.P3): the pilot's two replicas on one stack, with the Mac offline. Workspace M (the Mac: moss note
// folders, a scope that allows Moss Home and the notes it links to and denies Personal/ and Admin/Finance/) syncs up
// through its daemon, which then stops. Workspace L (the Linux replica: an empty folder whose scope follows Moss Home)
// pulls every in-scope note through its own daemon, and an agent there edits two of them and creates a linked note.
// M's daemon starts again and brings every change down, while a Moss editor that still held a note's old text saves
// it with new typing (T7.P2). Nothing out of scope reaches the server or L, and no edit is lost.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../lib/actors.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

const CLI = fileURLToPath(new URL('../../packages/cli/dist/moss-multi.mjs', import.meta.url));
const SOLO = 'one person, her Mac and a Linux replica her agents work on, syncing one scoped set of notes';
const SYNC_TIMEOUT = 45_000;

interface Run { code: number; stdout: string; stderr: string }

const childEnv = (dir: string, env: Record<string, string>) => ({ PATH: process.env.PATH ?? '', HOME: dir, MOSS_MULTI_NO_OPEN: '1', ...env });

function moss(args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: childEnv(cwd, env), encoding: 'utf8', timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });
}

/** One replica's daemon: `watch <dir>`, ticking every 2 s, as the launchd agent or systemd unit runs it. */
async function daemon(dir: string, env: Record<string, string>): Promise<{ output: () => string; stop: () => Promise<number>; kill: () => void }> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [CLI, 'watch', dir, '--interval', '2'], { cwd: tmpdir(), env: childEnv(dir, env) });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
  const exited = new Promise<number>((resolve) => child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  await expect.poll(() => output, { message: 'the daemon says it is watching', timeout: 15_000 }).toContain('watching');
  return {
    output: () => output,
    stop: async () => {
      child.kill('SIGTERM');
      return Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 10_000))]);
    },
    kill: () => child.kill('SIGKILL'),
  };
}

async function agentEnv(actor: Actor, stack: Stack, name: string, dir: string): Promise<Record<string, string>> {
  const minted = await actor.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name } });
  expect(minted.status(), `declared setup: an agent key for ${name}`).toBe(201);
  const { key } = (await minted.json()) as { key: string };
  return { MOSS_MULTI_SERVER: stack.baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, '.config-moss-multi') };
}

const readOr = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '');

/** Every note file in a workspace, `/`-separated, its state and config folders aside. */
function notes(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.md')) out.push(relative(root, join(dir, entry.name)).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

test('j18-replica: with the Mac offline, an agent on the Linux replica reads and edits the scoped notes, and every edit lands on the Mac when it returns @p:agt-2 @p:R9 @p:note-3 @evidence', async ({ actors, stack }) => {
  test.setTimeout(240_000);
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const mac = mkdtempSync(join(tmpdir(), 'mm-j18r-mac-'));
  const linux = mkdtempSync(join(tmpdir(), 'mm-j18r-linux-'));
  const macEnv = await agentEnv(ada, stack, 'Mac', mac);
  const linuxEnv = await agentEnv(ada, stack, 'Linux agent', linux);
  const SECRET = 'account 4417';
  const note = (folder: string, title: string, body: string): string => {
    mkdirSync(join(mac, folder, title), { recursive: true });
    writeFileSync(join(mac, folder, title, `${title}.md`), `# ${title}\n\n${body}\n`);
    return [folder, title, `${title}.md`].filter(Boolean).join('/');
  };
  const titles = async (): Promise<string[]> => {
    const response = await ada.context.request.get('/api/docs', { timeout: 30_000 });
    expect(response.status()).toBe(200);
    // A new account's own docs aside: only the names this journey uses.
    const names = ['Alpha', 'Beta notes', 'Diary', 'Garden plan', 'Loose', 'Moss Home', 'Shopping', 'Taxes 2026'];
    return ((await response.json()) as { docs: { title: string }[] }).docs.map((doc) => doc.title).filter((title) => names.includes(title)).sort();
  };
  const docText = async (title: string): Promise<string> => {
    const response = await ada.context.request.get('/api/docs', { timeout: 30_000 });
    const doc = ((await response.json()) as { docs: { id: string; title: string }[] }).docs.find((row) => row.title === title);
    if (!doc) return '';
    return (await ada.context.request.get(`/api/docs/${doc.id}/content`, { timeout: 30_000 })).text();
  };
  const daemons: Awaited<ReturnType<typeof daemon>>[] = [];
  try {
    const home = note('', 'Moss Home', 'Start at [[Alpha]], then [[Beta notes]]. Private: [[Diary]] and [[Taxes 2026]].');
    const alpha = note('', 'Alpha', 'Para one.\n\nPara two.\n\nPara three.');
    const beta = note('', 'Beta notes', 'Beta body.');
    note('Personal', 'Diary', `Dear diary, ${SECRET}.`);
    note('Admin/Finance', 'Taxes 2026', `Refund to ${SECRET}.`);
    note('', 'Loose', 'Nobody links here.');
    const shopping = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: 'Shopping', markdown: 'Milk.' } });
    expect(shopping.status(), 'declared setup: a web note nobody links to').toBe(201);
    const webDiary = await ada.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title: 'Diary', markdown: 'A web note named like the private one.' } });
    expect(webDiary.status(), 'declared setup: a web note named like a denied one').toBe(201);

    // M: the scope, then its daemon syncs the three allowed notes up.
    const init = await moss(['init', '--scope', '--follow', 'Moss Home', '--deny', 'Personal/**', '--deny', 'Admin/Finance/**'], macEnv, mac);
    expect(init.code, init.stderr).toBe(0);
    const confirmed = await moss(['scope', 'confirm', '--yes', home, alpha, beta], macEnv, mac);
    expect(confirmed.code, confirmed.stderr).toBe(0);
    const macDaemon = await daemon(mac, macEnv);
    daemons.push(macDaemon);
    await expect.poll(titles, { message: 'M syncs up the allowed notes', timeout: SYNC_TIMEOUT }).toEqual(['Alpha', 'Beta notes', 'Diary', 'Moss Home', 'Shopping']);
    // Moss has Alpha open: its editor holds this text until it saves.
    const editor = readFileSync(join(mac, alpha), 'utf8');

    // M goes offline. Its owner types in Beta notes meanwhile.
    expect(await macDaemon.stop(), `M's daemon stops cleanly: ${macDaemon.output()}`).toBe(0);
    daemons.splice(daemons.indexOf(macDaemon), 1);
    writeFileSync(join(mac, beta), readFileSync(join(mac, beta), 'utf8').replace('Beta body.', 'Beta body. Typed while offline.'));

    // L: an empty folder that follows Moss Home pulls exactly the in-scope notes.
    // Its scope comes from the Mac: the Mac's deny list, plus the denied titles Moss Home links to.
    const replica = await moss(['scope', 'replica'], macEnv, mac);
    expect(replica.code, replica.stderr).toBe(0);
    expect(JSON.parse(replica.stdout)).toEqual({ allow: ['**'], follow: ['Moss Home'], depth: 1, deny: ['Personal/**', 'Admin/Finance/**', '**/Diary', '**/Taxes 2026'] });
    const linuxInit = await moss(['init'], linuxEnv, linux);
    expect(linuxInit.code, linuxInit.stderr).toBe(0);
    writeFileSync(join(linux, '.moss-multi', 'scope.json'), replica.stdout, { mode: 0o600 });
    const linuxDaemon = await daemon(linux, linuxEnv);
    daemons.push(linuxDaemon);
    await expect.poll(() => notes(linux), { message: `L pulls every in-scope note: ${linuxDaemon.output()}`, timeout: SYNC_TIMEOUT }).toEqual([alpha, beta, home].sort());
    expect(readOr(join(linux, alpha)), 'L reads Alpha in moss form').toMatch(/^# Alpha\n\nPara one\.\n\nPara two\.\n\nPara three\.\n?$/);
    expect(readOr(join(linux, home))).toMatch(/^# Moss Home\n\nStart at \[\[Alpha\]\], then \[\[Beta notes\]\]\./);
    expect(readOr(join(linux, beta))).toContain('Beta body.');
    expect(readOr(join(linux, beta)), 'the offline typing has not left the Mac').not.toContain('Typed while offline.');

    // The agent on L creates a note, links it from Moss Home, and edits Alpha.
    mkdirSync(join(linux, 'Garden plan'));
    writeFileSync(join(linux, 'Garden plan', 'Garden plan.md'), '# Garden plan\n\nBeans by the fence.\n');
    writeFileSync(join(linux, home), readOr(join(linux, home)).replace('Private:', 'Plan: [[Garden plan]]. Private:'));
    writeFileSync(join(linux, alpha), readOr(join(linux, alpha)).replace('Para two.', 'Para two, edited by the agent.'));
    await expect.poll(() => docText('Alpha'), { message: 'the agent edit reaches the server', timeout: SYNC_TIMEOUT }).toContain('Para two, edited by the agent.');
    await expect.poll(() => docText('Moss Home'), { timeout: SYNC_TIMEOUT }).toContain('[[Garden plan]]');
    await expect.poll(() => docText('Garden plan'), { message: 'the agent\'s note reaches the server', timeout: SYNC_TIMEOUT }).toContain('Beans by the fence.');

    // M returns: its daemon brings every change down, then the Moss editor saves its old Alpha text with new typing.
    const back = await daemon(mac, macEnv);
    daemons.push(back);
    await expect.poll(() => readOr(join(mac, alpha)), { message: `M pulls the agent edit: ${back.output()}`, timeout: SYNC_TIMEOUT }).toContain('Para two, edited by the agent.');
    await expect.poll(() => readOr(join(mac, 'Garden plan', 'Garden plan.md')), { message: `M pulls the linked note: ${back.output()}`, timeout: SYNC_TIMEOUT }).toMatch(/^# Garden plan\n\nBeans by the fence\.\n?$/);
    expect(readOr(join(mac, home))).toContain('[[Garden plan]]');
    writeFileSync(join(mac, alpha), editor.replace('Para three.', 'Para three, typed in Moss.'));
    await expect.poll(() => docText('Alpha'), { message: `the stale save lands only its typing: ${back.output()}`, timeout: SYNC_TIMEOUT }).toContain('Para three, typed in Moss.');
    for (const text of ['Para two, edited by the agent.', 'Para three, typed in Moss.']) {
      expect(await docText('Alpha'), `the server keeps "${text}"`).toContain(text);
      await expect.poll(() => readOr(join(mac, alpha)), { message: `M's file holds "${text}"`, timeout: SYNC_TIMEOUT }).toContain(text);
      await expect.poll(() => readOr(join(linux, alpha)), { message: `L's file holds "${text}"`, timeout: SYNC_TIMEOUT }).toContain(text);
    }
    await expect.poll(() => docText('Beta notes'), { message: 'the offline typing lands', timeout: SYNC_TIMEOUT }).toContain('Typed while offline.');
    await expect.poll(() => readOr(join(linux, beta)), { timeout: SYNC_TIMEOUT }).toContain('Typed while offline.');
    expect(existsSync(join(mac, `${alpha}.rej`)), 'no clash was set aside').toBe(false);
    expect(back.output(), 'the linked note is download only on the Mac until she confirms it').toMatch(/pulled Garden plan\/Garden plan\.md: .*download only/);

    // Nothing out of scope reached the server or L.
    expect(await titles(), 'only the scoped notes and the agent\'s note are on the server').toEqual(['Alpha', 'Beta notes', 'Diary', 'Garden plan', 'Moss Home', 'Shopping']);
    expect(existsSync(join(mac, 'Diary')), 'the web Diary never comes down in place of the private one').toBe(false);
    for (const title of ['Alpha', 'Beta notes', 'Garden plan', 'Moss Home']) expect(await docText(title)).not.toContain(SECRET);
    expect(notes(linux), 'L holds only the scoped notes and the agent\'s note').toEqual([alpha, beta, 'Garden plan/Garden plan.md', home].sort());

    const alphaRow = ((await (await ada.context.request.get('/api/docs')).json()) as { docs: { id: string; title: string }[] }).docs.find((row) => row.title === 'Alpha')!;
    await ada.goto(`/d/${alphaRow.id}`);
    await ui.waitLive(ada, alphaRow.id);
    await expect(ui.body(ada, alphaRow.id), 'the web shows both edits').toContainText('Para two, edited by the agent.');
    await expect(ui.body(ada, alphaRow.id)).toContainText('Para three, typed in Moss.');
    await actors.checkpoint('replicas-converged');

    for (const running of [...daemons]) {
      expect(await running.stop(), `a daemon stops cleanly: ${running.output()}`).toBe(0);
      daemons.splice(daemons.indexOf(running), 1);
    }
  } finally {
    for (const running of daemons) running.kill();
    rmSync(mac, { recursive: true, force: true });
    rmSync(linux, { recursive: true, force: true });
  }
});

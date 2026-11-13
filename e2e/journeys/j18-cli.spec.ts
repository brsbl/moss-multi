// j18-cli (T7.1): the built moss-multi CLI (packages/cli/dist) against the stack. `cat` writes the doc's bytes with
// no trailing LF added; a title prefix resolves; `url` prints an address that opens the doc in the web app; a 2 MB
// pull returns every byte; the device flow signs the terminal in, `rm` reports the trash in words and JSON, and
// `logout` ends the session on the server.
//
// Notes are imported through POST /api/docs as declared setup; import is not this journey's promise.
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../lib/actors.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

const CLI = fileURLToPath(new URL('../../packages/cli/dist/moss-multi.mjs', import.meta.url));
const SOLO = 'one person and her own agent key drive the CLI against her own notes';
const BIND_TIMEOUT = 30_000;
/** protocol/limits MARKDOWN_CAP_BYTES. */
const MARKDOWN_CAP_BYTES = 2 * 1024 * 1024;

interface Run { code: number; stdout: Buffer; stderr: string }

function moss(args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env }, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr: stderr.toString('utf8') }));
  });
}

const scratch = (): string => mkdtempSync(join(tmpdir(), 'mm-j18-'));

async function importNote(actor: Actor, stack: Stack, title: string, markdown: string): Promise<string> {
  const response = await actor.context.request.post('/api/docs', { headers: { origin: stack.baseUrl }, data: { title, markdown }, timeout: 60_000 });
  expect(response.status(), `declared setup: "${title}" is imported`).toBe(201);
  return ((await response.json()) as { doc: { id: string } }).doc.id;
}

async function agentKey(actor: Actor, stack: Stack): Promise<string> {
  const minted = await actor.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name: 'Scribe' } });
  expect(minted.status(), 'declared setup: an agent key').toBe(201);
  return ((await minted.json()) as { key: string }).key;
}

/** The doc's export as the server serves it, for comparing bytes. */
async function served(stack: Stack, docId: string, key: string): Promise<Buffer> {
  const response = await fetch(`${stack.baseUrl}/api/docs/${docId}/content`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) });
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

test('j18-cli cat: the bytes are exact with no trailing LF; a title prefix resolves; url opens the doc in the web app @p:agt-1 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const planId = await importNote(ada, stack, 'Garden plan', 'Beans, then peas — é ✓\n\nThe last line has no newline');
  await importNote(ada, stack, 'Garden notes', 'Water daily.');
  const key = await agentKey(ada, stack);
  const dir = scratch();
  const env = { MOSS_MULTI_SERVER: stack.baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, 'config') };
  try {
    const bytes = await served(stack, planId, key);
    const cat = await moss(['cat', planId], env, dir);
    expect(cat.code, cat.stderr).toBe(0);
    expect(cat.stdout.byteLength, 'cat adds no byte, a trailing LF included').toBe(bytes.byteLength);
    expect(cat.stdout.equals(bytes), 'cat writes the doc\'s bytes exactly').toBe(true);
    expect(cat.stdout.toString('utf8'), 'non-ASCII text intact').toContain('Beans, then peas — é ✓');

    const byPrefix = await moss(['cat', 'garden pl'], env, dir);
    expect(byPrefix.code, byPrefix.stderr).toBe(0);
    expect(byPrefix.stdout.equals(bytes), 'a unique title prefix names the same doc').toBe(true);
    const ambiguous = await moss(['cat', 'Garden'], env, dir);
    expect(ambiguous.code, 'a prefix two titles share is refused').toBe(1);
    expect(ambiguous.stderr).toContain(planId);
    expect(ambiguous.stdout.byteLength).toBe(0);

    const url = await moss(['url', 'Garden pl'], env, dir);
    expect(url.code, url.stderr).toBe(0);
    const printed = url.stdout.toString('utf8');
    expect(printed).toBe(`${stack.baseUrl}/d/${planId}\n`);
    await ada.goto(ui.pathOf(printed.trim()));
    await ui.waitLive(ada, planId);
    await expect(ui.body(ada, planId), 'the url opens the doc itself, with its body').toContainText('Beans, then peas — é ✓', { timeout: BIND_TIMEOUT });
    await actors.checkpoint('url-opened');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('j18-cli pull: a 2 MB doc pulls every byte into the file and its base @p:agt-1 @p:tech-8', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const paragraphs: string[] = [];
  let size = 0;
  for (let i = 0; size < 2_088_000; i += 1) {
    const paragraph = `Paragraph ${i}: ${'the beans climb the trellis and the peas follow them up '.repeat(16)}end ${i}.`;
    paragraphs.push(paragraph);
    size += Buffer.byteLength(paragraph) + 2;
  }
  const last = paragraphs.length - 1;
  const docId = await importNote(ada, stack, 'Big garden', paragraphs.join('\n\n'));
  const key = await agentKey(ada, stack);
  const dir = scratch();
  const env = { MOSS_MULTI_SERVER: stack.baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, 'config') };
  try {
    const bytes = await served(stack, docId, key);
    expect(bytes.byteLength, 'the doc sits just under the 2 MiB cap').toBeGreaterThan(2_085_000);
    expect(bytes.byteLength).toBeLessThanOrEqual(MARKDOWN_CAP_BYTES);
    const pull = await moss(['pull', docId, 'big.md'], env, dir);
    expect(pull.code, pull.stderr).toBe(0);
    const file = readFileSync(join(dir, 'big.md'));
    expect(file.byteLength, 'every byte arrives').toBe(bytes.byteLength);
    expect(file.equals(bytes), 'byte for byte').toBe(true);
    expect(file.toString('utf8')).toContain(`end ${last}.`);
    expect(readFileSync(join(dir, '.moss-multi', docId, 'base.md')).equals(bytes), 'and the base matches').toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('j18-cli login: the device flow signs the terminal in as Ada, and rm reports the trash in words and JSON @p:agt-1 @p:ppl-1', async ({ actors, stack }) => {
  actors.solo('one person approves her own terminal and trashes her own notes from it');
  const principal = await actors.principal('ada');
  const setup = await actors.session(principal, { label: 'setup' });
  const first = await importNote(setup, stack, 'Old plan', 'Out of date.');
  const second = await importNote(setup, stack, 'Older plan', 'Even older.');
  const dir = scratch();
  const env = { MOSS_MULTI_CONFIG_DIR: join(dir, 'config') };
  const child = spawn(process.execPath, [CLI, 'login', '--server', stack.baseUrl], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, ...env } });
  try {
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
    await expect.poll(() => /\/device\?user_code=\S+/.exec(output)?.[0] ?? '', { message: 'the CLI prints where to approve it', timeout: 15_000 }).not.toBe('');
    const path = /\/device\?user_code=\S+/.exec(output)![0];
    const ada = await actors.open(principal, { path });
    const page = ada.page.getByRole('main');
    await expect(page.getByRole('heading', { name: 'Sign in a device', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(page.getByRole('status'), 'approved').toContainText('Device approved');
    const code = await Promise.race([exited, new Promise<number>((resolve) => setTimeout(() => resolve(-1), 30_000))]);
    expect(code, `the CLI signs in: ${output}`).toBe(0);
    expect(output).toContain(principal.email.toLowerCase());
    const config = join(dir, 'config', 'config.json');
    expect(JSON.parse(readFileSync(config, 'utf8')), 'the session is stored').toMatchObject({ serverUrl: stack.baseUrl, sessionToken: expect.any(String) });

    const who = await moss(['whoami'], env, dir);
    expect(who.stdout.toString('utf8'), 'the terminal acts as Ada').toContain(principal.email.toLowerCase());
    const said = await moss(['rm', first], env, dir);
    expect(said.code, said.stderr).toBe(0);
    expect(said.stdout.toString('utf8')).toBe('moved to Trash — you can restore it for 30 days\n');
    const asJson = await moss(['rm', 'Older', '--json'], env, dir);
    expect(asJson.code, asJson.stderr).toBe(0);
    expect(JSON.parse(asJson.stdout.toString('utf8'))).toEqual({ id: second, action: 'trashed', restorable: true, retentionDays: 30 });
    const gone = await moss(['cat', first], env, dir);
    expect(gone.code, 'a trashed doc is gone to cat').toBe(1);

    const { sessionToken } = JSON.parse(readFileSync(config, 'utf8')) as { sessionToken: string };
    const out = await moss(['logout'], env, dir);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stderr, 'the server ends the session').toBe('');
    const me = await fetch(`${stack.baseUrl}/api/me`, { headers: { authorization: `Bearer ${sessionToken}` }, signal: AbortSignal.timeout(10_000) });
    expect(me.status, 'the logged-out session no longer signs requests').toBe(401);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

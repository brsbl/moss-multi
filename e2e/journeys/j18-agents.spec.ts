// j18-agents (T7.2): the built moss-multi CLI pushes into notes people are typing in. A push while Ada types in the same
// paragraph keeps both; the 61st push in a minute gets 429 with retry-after; a 2 MB push lands and the doc stays
// typeable, and a push past the cap is refused loudly; a push deleting most of the doc is refused without --force.
//
// Notes are imported through POST /api/docs as declared setup; import is not this journey's promise.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor } from '../lib/actors.ts';
import type { Stack } from '../lib/stack.ts';
import { expect, test, ui } from '../lib/test.ts';

const CLI = fileURLToPath(new URL('../../packages/cli/dist/moss-multi.mjs', import.meta.url));
const SOLO = 'one person and her own agent key push into her own notes';
const BIND_TIMEOUT = 30_000;
/** protocol/limits MARKDOWN_CAP_BYTES and PUSH_RATE. */
const MARKDOWN_CAP_BYTES = 2 * 1024 * 1024;
const PUSHES_PER_MINUTE = 60;

interface Run { code: number; stdout: string; stderr: string }

function moss(args: string[], env: Record<string, string>, cwd: string): Promise<Run> {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: build it with pnpm --filter @moss-multi/cli build`);
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env }, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
  });
}

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

async function served(stack: Stack, docId: string, key: string): Promise<string> {
  const response = await fetch(`${stack.baseUrl}/api/docs/${docId}/content`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) });
  expect(response.status).toBe(200);
  return response.text();
}

/** A workspace for the CLI, signed in with the agent key. */
function workspace(stack: Stack, key: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mm-j18a-'));
  const env = { MOSS_MULTI_SERVER: stack.baseUrl, MOSS_MULTI_API_KEY: key, MOSS_MULTI_CONFIG_DIR: join(dir, 'config') };
  return {
    dir,
    run: (...args: string[]) => moss(args, env, dir),
    read: (file: string) => readFileSync(join(dir, file), 'utf8'),
    write: (file: string, text: string) => writeFileSync(join(dir, file), text),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('j18-agents push while typing: a CLI push into the paragraph Ada is typing in keeps both @p:agt-1 @p:tech-5 @p:tech-7 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const principal = await actors.principal('ada');
  const setup = await actors.session(principal, { label: 'setup' });
  const docId = await importNote(setup, stack, 'Garden plan', 'Beans first, then peas, then squash.\n\nWater at dawn.');
  const key = await agentKey(setup, stack);
  const cli = workspace(stack, key);
  try {
    const pulled = await cli.run('pull', docId, 'plan.md');
    expect(pulled.code, pulled.stderr).toBe(0);

    const ada = await actors.open(principal, { path: `/d/${docId}` });
    await ui.waitLive(ada, docId);
    await ada.observeEditor(docId);
    const typed = ' and a row of basil by the gate';
    await ui.body(ada, docId).getByText('Beans first, then peas, then squash.').click();
    await ada.page.keyboard.press('End');
    // Ada keeps typing at the end of the paragraph while the agent edits its start.
    const typing = ada.page.keyboard.type(typed, { delay: 80 });
    await expect(ui.body(ada, docId), 'Ada has started typing').toContainText('squash. and', { timeout: BIND_TIMEOUT });
    cli.write('plan.md', cli.read('plan.md').replace('Beans first', 'Broad beans first'));
    const pushed = await cli.run('push', 'plan.md');
    await typing;
    ada.typed({ docId, field: 'body', text: typed, ordered: true });
    expect(pushed.code, pushed.stderr).toBe(0);
    await ui.waitAcked(ada, docId);
    const paragraph = `Broad beans first, then peas, then squash.${typed}`;
    await expect(ui.body(ada, docId), 'Ada sees the agent\'s edit and her own typing in one paragraph').toContainText(paragraph, { timeout: BIND_TIMEOUT });
    await expect.poll(() => served(stack, docId, key), { message: 'the server holds both', timeout: BIND_TIMEOUT }).toContain(paragraph);
    expect(await served(stack, docId, key)).toContain('Water at dawn.');
    await actors.checkpoint('push-while-typing');
  } finally {
    cli.dispose();
  }
});

test('j18-agents rate: the 61st push in a minute gets 429 with retry-after @p:agt-1 @p:tech-8', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Seed list', 'Beans.\n\nPeas.');
  const key = await agentKey(ada, stack);
  const cli = workspace(stack, key);
  try {
    const base = await served(stack, docId, key);
    const baseHash = createHash('sha256').update(base).digest('hex');
    const push = () => fetch(`${stack.baseUrl}/api/docs/${docId}/push`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ newText: base, baseHash, baseText: base }),
      signal: AbortSignal.timeout(30_000),
    });
    for (let i = 0; i < PUSHES_PER_MINUTE; i += 1) {
      const response = await push();
      expect(response.status, `push ${i + 1} of ${PUSHES_PER_MINUTE}`).toBe(200);
    }
    const over = await push();
    expect(over.status, 'the 61st push in the minute').toBe(429);
    expect(Number(over.headers.get('retry-after')), 'with retry-after').toBeGreaterThan(0);
    expect(await over.json()).toMatchObject({ ok: false, reason: 'rate-limited' });

    expect((await cli.run('pull', docId, 'seeds.md')).code).toBe(0);
    cli.write('seeds.md', `${cli.read('seeds.md')}\n\nSquash.`);
    const refused = await cli.run('push', 'seeds.md');
    expect(refused.code, 'the CLI refuses loudly').toBe(1);
    expect(refused.stderr).toMatch(/rate limited.*try again in \d+ s/);
    expect(await served(stack, docId, key)).not.toContain('Squash.');
  } finally {
    cli.dispose();
  }
});

test('j18-agents size: a 2 MB push lands and stays typeable; a push past the cap is refused loudly @p:agt-1 @p:tech-8', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const principal = await actors.principal('ada');
  const setup = await actors.session(principal, { label: 'setup' });
  const docId = await importNote(setup, stack, 'Big garden', 'The first line.');
  const key = await agentKey(setup, stack);
  const cli = workspace(stack, key);
  try {
    expect((await cli.run('pull', docId, 'big.md')).code).toBe(0);
    const paragraphs = [cli.read('big.md')];
    let size = Buffer.byteLength(paragraphs[0]!);
    for (let i = 0; size < 2_088_000; i += 1) {
      const paragraph = `Paragraph ${i}: ${'the beans climb the trellis and the peas follow them up '.repeat(16)}end ${i}.`;
      paragraphs.push(paragraph);
      size += Buffer.byteLength(paragraph) + 2;
    }
    const big = paragraphs.join('\n\n');
    expect(Buffer.byteLength(big)).toBeLessThanOrEqual(MARKDOWN_CAP_BYTES);
    cli.write('big.md', big);
    const pushed = await cli.run('push', 'big.md');
    expect(pushed.code, pushed.stderr).toBe(0);
    const landed = await served(stack, docId, key);
    expect(Buffer.byteLength(landed), 'every byte landed').toBe(Buffer.byteLength(big));
    expect(landed).toBe(big);

    const ada = await actors.open(principal, { path: `/d/${docId}` });
    await ui.waitLive(ada, docId);
    await ui.body(ada, docId).getByText('The first line.').click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.type(' Still typeable.');
    ada.typed({ docId, field: 'body', text: ' Still typeable.', ordered: true });
    await ui.waitAcked(ada, docId, 30_000);
    await expect.poll(async () => (await served(stack, docId, key)).startsWith('The first line. Still typeable.'), { message: 'the 2 MB doc takes typing', timeout: BIND_TIMEOUT }).toBe(true);
    await actors.checkpoint('two-megabytes-typeable');

    expect((await cli.run('pull', docId, 'big.md', '--force')).code).toBe(0);
    const before = await served(stack, docId, key);
    cli.write('big.md', `${cli.read('big.md')}\n\n${'One paragraph too many. '.repeat(4_000)}`);
    const refused = await cli.run('push', 'big.md');
    expect(refused.code, 'a push past the cap fails').toBe(1);
    expect(refused.stderr, 'and says why').toContain('too large');
    expect(await served(stack, docId, key), 'nothing of it landed').toBe(before);
  } finally {
    cli.dispose();
  }
});

test('j18-agents degenerate: a push deleting most of the doc is refused without --force @p:agt-1 @p:tech-7', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const body = ['Beans in April.', 'Peas in May.', 'Squash in June.', 'Basil in July.', 'Garlic in October.'].join('\n\n');
  const docId = await importNote(ada, stack, 'Planting calendar', body);
  const key = await agentKey(ada, stack);
  const cli = workspace(stack, key);
  try {
    expect((await cli.run('pull', docId, 'calendar.md')).code).toBe(0);
    const before = await served(stack, docId, key);
    cli.write('calendar.md', 'Beans in April.');
    const refused = await cli.run('push', 'calendar.md');
    expect(refused.code, 'exit 3: degenerate').toBe(3);
    expect(refused.stderr).toContain('--force');
    expect(await served(stack, docId, key), 'the doc is untouched').toBe(before);
    const forced = await cli.run('push', 'calendar.md', '--force');
    expect(forced.code, forced.stderr).toBe(0);
    expect(await served(stack, docId, key)).toBe('Beans in April.');
  } finally {
    cli.dispose();
  }
});

// j18-agents (T7.2): the built moss-multi CLI pushes into notes people are typing in. A push while Ada types in the same
// paragraph keeps both; the 61st push in a minute gets 429 with retry-after; a 2 MB push lands and the doc stays
// typeable, and a push past the cap is refused loudly; a push deleting most of the doc is refused without --force.
// T7.3: an agent's push shows a Bot-badged chip for about 15 s and adds no step to Ada's undo; `push --suggest` lands
// as a pending suggestion Ada can accept; an agent Ben granted commenter can pull and comment, has its push refused
// loudly, and is disconnected when the grant is revoked; revoking a key closes its socket and the CLI gets "not signed in".
//
// Notes are imported through POST /api/docs as declared setup; import is not this journey's promise.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { agentSocket } from '../lib/agent-socket.ts';
import { SUGGESTION_CARD_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR } from '../lib/contract.ts';
import { grant } from '../lib/grants.ts';
import type { Stack } from '../lib/stack.ts';
import { openIn } from '../lib/suggest.ts';
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

async function mintAgent(actor: Actor, stack: Stack): Promise<{ id: string; key: string }> {
  const minted = await actor.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name: 'Scribe' } });
  expect(minted.status(), 'declared setup: an agent key').toBe(201);
  const { agent, key } = (await minted.json()) as { agent: { id: string }; key: string };
  return { id: agent.id, key };
}

async function agentKey(actor: Actor, stack: Stack): Promise<string> {
  return (await mintAgent(actor, stack)).key;
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

/** The agent's chip in the note's face pile: its name, with the Bot badge. */
const botChip = (actor: Actor): Locator => actor.page.locator('[data-presence-client][title="Scribe (agent)"]');
const UNDO = 'ControlOrMeta+z';
/** Past the undo capture window, so a later edit is its own step. */
const NEW_STEP_MS = 1_500;

test('j18-agents presence: a push shows a Bot-badged chip for about 15 s and adds no undo step @p:agt-1 @p:col-3 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const principal = await actors.principal('ada');
  const setup = await actors.session(principal, { label: 'setup' });
  const docId = await importNote(setup, stack, 'Bean rows', 'Beans in the first row.\n\nPeas in the second row.');
  const key = await agentKey(setup, stack);
  const cli = workspace(stack, key);
  try {
    expect((await cli.run('pull', docId, 'rows.md')).code).toBe(0);
    const ada = await actors.open(principal, { path: `/d/${docId}` });
    await ui.waitLive(ada, docId);
    await ada.observeEditor(docId);
    await expect(botChip(ada), 'no agent is here yet').toHaveCount(0);
    await ui.body(ada, docId).getByText('Peas in the second row.').click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.type(' Basil by the fence.');
    await ui.waitAcked(ada, docId);
    await ada.page.waitForTimeout(NEW_STEP_MS);

    cli.write('rows.md', cli.read('rows.md').replace('Beans in the first row.', 'Broad beans in the first row.'));
    const pushed = await cli.run('push', 'rows.md');
    expect(pushed.code, pushed.stderr).toBe(0);
    const pushedAt = Date.now();
    await expect(ui.body(ada, docId), 'Ada sees the agent\'s edit').toContainText('Broad beans in the first row.', { timeout: BIND_TIMEOUT });
    await expect(botChip(ada), 'the agent appears in Ada\'s face pile').toHaveCount(1, { timeout: 5_000 });
    await expect(botChip(ada).getByLabel('Agent'), 'with the Bot badge').toHaveCount(1);
    await expect(botChip(ada)).toHaveAttribute('aria-label', 'Scribe');
    await actors.checkpoint('agent-chip');

    // Cmd+Z takes back Ada's own words; the agent's push is never one of her steps.
    await ada.page.keyboard.press(UNDO);
    await expect(ui.body(ada, docId), 'her typing is undone').not.toContainText('Basil by the fence.', { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId), 'the agent\'s edit stays').toContainText('Broad beans in the first row.');
    await ada.page.keyboard.press(UNDO);
    await ada.page.keyboard.press(UNDO);
    await ui.waitAcked(ada, docId);
    await expect.poll(() => served(stack, docId, key), { message: 'the server keeps the agent\'s edit through every Cmd+Z', timeout: BIND_TIMEOUT })
      .toBe('Broad beans in the first row.\n\nPeas in the second row.');
    await expect(ui.body(ada, docId)).toContainText('Broad beans in the first row.');

    // About 15 s: still there past a client's 12 s sweep, gone soon after the window.
    await ada.page.waitForTimeout(Math.max(0, pushedAt + 13_000 - Date.now()));
    await expect(botChip(ada), 'still shown 13 s after the push').toHaveCount(1);
    await expect(botChip(ada), 'and gone after about 15 s').toHaveCount(0, { timeout: 12_000 });
    expect(Date.now() - pushedAt, 'within the window and a sweep').toBeLessThan(25_000);
  } finally {
    cli.dispose();
  }
});

test('j18-agents suggest: push --suggest lands as a pending suggestion that Ada accepts @p:agt-1 @p:mean-2 @evidence', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const principal = await actors.principal('ada');
  const setup = await actors.session(principal, { label: 'setup' });
  const docId = await importNote(setup, stack, 'Pea trellis', 'Peas climb the trellis.\n\nWater them at dawn.');
  const key = await agentKey(setup, stack);
  const cli = workspace(stack, key);
  try {
    expect((await cli.run('pull', docId, 'trellis.md')).code).toBe(0);
    const ada = await actors.open(principal, { path: `/d/${docId}` });
    await openIn(ada, docId, 'edit');
    await ada.observeEditor(docId);
    const before = await served(stack, docId, key);

    cli.write('trellis.md', cli.read('trellis.md').replace('Water them at dawn.', 'Water them at dawn and at dusk.'));
    const suggested = await cli.run('push', 'trellis.md', '--suggest');
    expect(suggested.code, suggested.stderr).toBe(0);
    expect(suggested.stdout).toMatch(/suggested trellis\.md \(suggestion [A-Za-z0-9_-]+\)/);
    expect(cli.read('trellis.md'), 'the file keeps the suggested text').toContain('and at dusk');
    expect(await served(stack, docId, key), 'the note is unchanged until someone accepts').toBe(before);
    const listed = await cli.run('suggestions', docId);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toMatch(/Scribe/);

    const button = ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`);
    await expect(button, 'Ada\'s Suggestions count picks it up').toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
    await expect(ui.body(ada, docId), 'her note does not hold it yet').not.toContainText('and at dusk');
    await button.click();
    const panel = ada.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
    const card = panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`);
    await expect(card).toHaveCount(1);
    await expect(card, 'the card names the agent').toContainText('Scribe');
    await expect(card, 'and shows the suggested text').toContainText('dusk', { timeout: BIND_TIMEOUT });
    await actors.checkpoint('cli-suggestion');
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="accepted"]`)).toHaveCount(1, { timeout: BIND_TIMEOUT });
    await ada.page.keyboard.press('Escape');
    await expect(ui.body(ada, docId), 'accepted, it is in the note').toContainText('Water them at dawn and at dusk.', { timeout: BIND_TIMEOUT });
    await expect.poll(() => served(stack, docId, key), { timeout: BIND_TIMEOUT }).toBe('Peas climb the trellis.\n\nWater them at dawn and at dusk.');
  } finally {
    cli.dispose();
  }
});

test('j18-agents grant: an agent Ben granted commenter pulls and comments, its push is refused loudly, and revoking the grant disconnects it @p:ppl-2 @p:agt-1 @evidence', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const benPrincipal = await actors.principal('ben');
  const setup = await actors.session(adaPrincipal, { label: 'setup' });
  const docId = await importNote(setup, stack, 'Squash bed', 'Squash goes in last.\n\nMulch it well.');
  // Declared setup: Ben manages the note for a while, which is what lets him add his own agent (PRODUCT ruling 20).
  await grant(setup, { docId }, benPrincipal, 'owner');
  const ben = await actors.open(benPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ben, docId);
  await actors.requireDistinct(2);
  const scribe = await mintAgent(ben, stack);
  const benDialog = await ui.openShare(ben, docId);
  await ui.shareInDialog(benDialog, scribe.id, 'Can comment', 'Shared with Scribe.');
  await ben.page.keyboard.press('Escape');
  // Ben leaves the note before he is removed from it (j09 covers a removed person's open pane).
  await ben.goto('/');

  const ada = await actors.open(adaPrincipal, { path: `/d/${docId}` });
  await ui.waitLive(ada, docId);
  await ada.observeEditor(docId);
  // Ben steps away; his agent keeps exactly the role he gave it.
  let dialog = await ui.openShare(ada, docId);
  await dialog.getByRole('button', { name: `Remove ${benPrincipal.name}`, exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: `Access for ${benPrincipal.name}`, exact: true }), 'Ben leaves the list').toHaveCount(0);
  const agentRow = dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem').filter({ hasText: 'Scribe' });
  await expect(agentRow.getByRole('combobox', { name: 'Access for Scribe', exact: true }), 'Scribe stays, at comment').toHaveValue('commenter');
  await ada.page.keyboard.press('Escape');

  const cli = workspace(stack, scribe.key);
  try {
    const pulled = await cli.run('pull', docId, 'squash.md');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(cli.read('squash.md')).toBe('Squash goes in last.\n\nMulch it well.');
    const live = await agentSocket(stack.baseUrl, docId, scribe.key);

    cli.write('squash.md', cli.read('squash.md').replace('Mulch it well.', 'Mulch it well with straw.'));
    const refused = await cli.run('push', 'squash.md');
    expect(refused.code, 'a commenter\'s push fails').toBe(1);
    expect(refused.stderr, 'and says why').toContain('push refused: you can\'t edit this doc');
    expect(await served(stack, docId, scribe.key), 'nothing of it landed').toBe('Squash goes in last.\n\nMulch it well.');

    const commented = await cli.run('comment', docId, 'Leave room for the vines.', '--quote', 'Squash goes in last');
    expect(commented.code, commented.stderr).toBe(0);
    await expect(ada.page.locator('[data-comment-gutter-id]'), 'the agent\'s comment lands in Ada\'s note').toHaveCount(1, { timeout: BIND_TIMEOUT });
    const listed = await cli.run('comments', docId);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('Scribe');
    expect(listed.stdout).toContain('Leave room for the vines.');
    await actors.checkpoint('agent-comment');

    dialog = await ui.openShare(ada, docId);
    await dialog.getByRole('button', { name: 'Remove Scribe', exact: true }).click();
    await expect(dialog.getByRole('combobox', { name: 'Access for Scribe', exact: true }), 'Scribe leaves the list').toHaveCount(0);
    await ada.page.keyboard.press('Escape');
    await expect.poll(live.closeCode, { message: 'the agent\'s live socket closes with a revocation code', timeout: BIND_TIMEOUT }).toBe(4403);
    live.socket.terminate();
    const after = await cli.run('pull', docId, 'squash.md', '--force');
    expect(after.code, 'and its next pull is refused').toBe(1);
    expect(after.stderr).toContain('not found');
  } finally {
    cli.dispose();
  }
});

test('j18-agents revoke key: revoking the key closes the agent\'s socket and the CLI gets "not signed in" @p:agt-1 @p:ppl-2', async ({ actors, stack }) => {
  actors.solo(SOLO);
  const ada = await actors.session(await actors.principal('ada'));
  const docId = await importNote(ada, stack, 'Garlic', 'Garlic goes in in October.');
  const agent = await mintAgent(ada, stack);
  const cli = workspace(stack, agent.key);
  try {
    expect((await cli.run('cat', docId)).stdout).toBe('Garlic goes in in October.');
    const live = await agentSocket(stack.baseUrl, docId, agent.key);
    const revoked = await ada.context.request.delete(`/api/agents/${agent.id}`, { headers: { origin: stack.baseUrl } });
    expect(revoked.status(), 'declared setup: Ada revokes the key (the Settings flow is j08-agents)').toBe(200);
    await expect.poll(live.closeCode, { message: 'the agent\'s socket closes', timeout: BIND_TIMEOUT }).toBe(4403);
    live.socket.terminate();
    const refused = await cli.run('cat', docId);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('not signed in');
  } finally {
    cli.dispose();
  }
});

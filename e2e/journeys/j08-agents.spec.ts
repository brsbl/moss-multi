// j08-agents (T3.6): agents as collaborators. Ada mints an agent key in Settings → Agents; it is shown once, and the
// agent's row offers its id to copy. The key works as a raw bearer; revoking it refuses the next request with 401 and
// closes the agent's live doc socket. Ben shares a note with Ada's agent by its id, and it is listed as an "agent" row
// at its role. The CLI's device flow: opening /device with the terminal's code shows it, and approving signs the
// terminal in as Ada.
import type { Locator } from '@playwright/test';
import WebSocket from 'ws';
import type { Actor, Actors } from '../lib/actors.ts';
import { APP_STATE_ATTR, DOC_SOCKET_PATH } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const LIVE_TIMEOUT = 10_000;
const KEY = /^mm_sk_[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function openShell(actors: Actors, label: string, path = '/'): Promise<Actor> {
  const actor = await actors.open(await actors.principal(label), { path });
  await actor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  return actor;
}

const agentRow = (settings: Locator, name: string): Locator =>
  settings.getByRole('list', { name: 'Agents' }).getByRole('listitem').filter({ hasText: name });

const me = (baseUrl: string, key: string) =>
  fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });

/** A doc socket presenting an agent key, as the CLI's sync would; resolves once the upgrade completes. */
function agentSocket(baseUrl: string, docId: string, key: string): Promise<{ closed: Promise<number>; socket: WebSocket }> {
  const url = `${baseUrl.replace(/^http/, 'ws')}${DOC_SOCKET_PATH}${encodeURIComponent(docId)}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
    const closed = new Promise<number>((done) => socket.on('close', (code) => done(code)));
    const timer = setTimeout(() => reject(new Error(`${url}: no open within 15 s`)), 15_000);
    socket.on('error', () => undefined);
    socket.on('open', () => {
      clearTimeout(timer);
      resolve({ closed, socket });
    });
    void closed.then((code) => reject(new Error(`${url}: closed ${code} before opening`)));
  });
}

test('j08-agents keys: a minted key is shown once; revoking it 401s a raw bearer request and closes the agent\'s live socket @p:ppl-2 @evidence', async ({ actors, stack }) => {
  actors.solo('one person and her own agent key; the agent is a raw socket, not a browser actor');
  const ada = await openShell(actors, 'ada');
  const docId = await ui.createNote(ada);

  let settings = await ui.openSettings(ada);
  await settings.getByLabel('Agent name', { exact: true }).fill('Scribe');
  await settings.getByRole('button', { name: 'New key', exact: true }).click();
  const keyField = settings.getByRole('textbox', { name: 'API key for Scribe', exact: true });
  await expect(keyField, 'the new key is shown').toHaveValue(KEY);
  const key = await keyField.inputValue();
  await expect(settings.getByText('Copy this key now. It won’t be shown again.'), 'and says it is shown once').toBeVisible();
  const idField = agentRow(settings, 'Scribe').getByRole('textbox', { name: 'Agent ID for Scribe', exact: true });
  await expect(idField, 'the agent is listed with its id to copy').toHaveValue(UUID);
  const agentId = await idField.inputValue();
  await actors.checkpoint('minted');

  await ada.page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  settings = await ui.openSettings(ada);
  await expect(agentRow(settings, 'Scribe'), 'the agent is still listed').toHaveCount(1);
  await expect(settings.getByRole('textbox', { name: 'API key for Scribe', exact: true }), 'but its key is not shown again').toHaveCount(0);
  expect(await (await ada.context.request.get('/api/agents')).text(), 'nor sent again').not.toContain(key);

  const before = await me(stack.baseUrl, key);
  expect(before.status, 'the key works as a raw bearer').toBe(200);
  expect(await before.json()).toMatchObject({ principal: { type: 'agent', id: agentId } });
  const live = await agentSocket(stack.baseUrl, docId, key);

  await agentRow(settings, 'Scribe').getByRole('button', { name: 'Revoke Scribe', exact: true }).click();
  const confirm = ada.page.getByRole('alertdialog', { name: 'Revoke Scribe’s key?', exact: true });
  await expect(confirm, 'revoking asks first').toBeVisible();
  await confirm.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(agentRow(settings, 'Scribe'), 'the agent leaves the list').toHaveCount(0, { timeout: LIVE_TIMEOUT });

  expect((await me(stack.baseUrl, key)).status, 'a raw bearer request with the revoked key gets 401').toBe(401);
  const code = await Promise.race([live.closed, new Promise<null>((done) => setTimeout(() => done(null), LIVE_TIMEOUT))]);
  expect(code, 'the agent\'s live doc socket closes').not.toBeNull();
  expect([4401, 4403], 'with a revocation code').toContain(code);
  live.socket.terminate();
});

test('j08-agents share: Ben adds Ada\'s agent by its id and it appears as an "agent" row at its role @p:ppl-2 @evidence', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  // Declared setup: Ada's agent, minted through the API (the Settings flow is the leg above).
  const minted = await ada.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name: 'Scribe' } });
  expect(minted.status(), 'declared setup: an agent').toBe(201);
  const { agent, key } = (await minted.json()) as { agent: { id: string }; key: string };

  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  const docId = await ui.createNote(ben);
  const dialog = await ui.openShare(ben, docId);
  await ui.shareInDialog(dialog, agent.id, 'Can comment', 'Shared with Scribe.');
  const row = dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem').filter({ hasText: 'Scribe' });
  await expect(row, 'the agent is listed').toHaveCount(1);
  await expect(row.getByText('agent', { exact: true }), 'tagged as an agent').toBeVisible();
  const select = row.getByRole('combobox', { name: 'Access for Scribe', exact: true });
  await expect(select, 'at the role Ben chose').toHaveValue('commenter');
  await expect(select.locator('option[value="owner"]'), 'an agent is never offered owner').toHaveCount(0);
  await actors.checkpoint('agent-row');

  const access = await fetch(`${stack.baseUrl}/api/docs/${docId}/access`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  expect(access.status, 'the agent can open the note').toBe(200);
  expect(await access.json(), 'at that role').toMatchObject({ role: 'commenter' });
});

test('j08-agents device: opening /device with the terminal\'s code shows it, and approving signs the terminal in @p:ppl-1 @evidence', async ({ actors, stack }) => {
  actors.solo('one person approves her own terminal; the terminal is a raw HTTP client');
  const adaPrincipal = await actors.principal('ada');
  const started = await fetch(`${stack.baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: 'moss-multi-cli' }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(started.status, 'the terminal gets a code').toBe(200);
  const code = (await started.json()) as { device_code: string; user_code: string };
  const poll = () => fetch(`${stack.baseUrl}/api/auth/device/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code, client_id: 'moss-multi-cli' }),
    signal: AbortSignal.timeout(10_000),
  });

  const ada = await actors.open(adaPrincipal, { path: `/device?user_code=${code.user_code}` });
  const page = ada.page.getByRole('main');
  await expect(page.getByRole('heading', { name: 'Sign in a device', exact: true })).toBeVisible();
  await expect(page.getByText(code.user_code.replace(/-/g, '').toUpperCase(), { exact: false }), 'the code is shown to compare').toBeVisible();
  await actors.checkpoint('device-confirm');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status'), 'approved').toContainText('Device approved');

  // The CLI polls every 5 s; the first poll after approval gets the session.
  let token: { access_token?: string } = {};
  await expect.poll(async () => {
    const response = await poll();
    token = (await response.json()) as { access_token?: string };
    return response.status;
  }, { message: 'the terminal\'s poll gets a session', timeout: 20_000, intervals: [5_500] }).toBe(200);
  const who = await fetch(`${stack.baseUrl}/api/me`, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10_000) });
  expect(await who.json(), 'signed in as Ada').toMatchObject({ principal: { type: 'user', email: adaPrincipal.email.toLowerCase() } });
});

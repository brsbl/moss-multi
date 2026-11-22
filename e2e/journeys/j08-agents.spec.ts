// j08-agents (T3.6): agents as collaborators. Ada mints an agent key in Settings → Agents; it is shown once, and the
// agent's row offers its id to copy. The key works as a raw bearer; revoking it refuses the next request with 401 and
// closes the agent's live doc socket. Ben shares a note with his own agent by its id, and it is listed as an "agent"
// row at its role; Ada's agent id gets the unknown-id refusal (PRODUCT ruling 20). The CLI's device flow: opening
// /device with the terminal's code shows it, and approving signs the terminal in as Ada.
import type { Locator } from '@playwright/test';
import type { Actor, Actors } from '../lib/actors.ts';
import { agentSocket } from '../lib/agent-socket.ts';
import { APP_STATE_ATTR } from '../lib/contract.ts';
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

/** Settings → Agents' New key disclosure: the name field shows only once New key is pressed (T9.45). */
async function mintInSettings(settings: Locator, name: string): Promise<void> {
  const disclose = settings.getByRole('button', { name: 'New key', exact: true });
  if (await disclose.getAttribute('aria-expanded') !== 'true') await disclose.click();
  const field = settings.getByLabel('Agent name', { exact: true });
  await expect(field, 'the name field takes focus').toBeFocused();
  await field.fill(name);
  await settings.getByRole('button', { name: 'Create key', exact: true }).click();
}

const agentIdOf = async (actor: Actor, name: string): Promise<string> => {
  const { agents } = (await (await actor.context.request.get('/api/agents')).json()) as { agents: { id: string; name: string }[] };
  return agents.filter((agent) => agent.name === name).at(-1)?.id ?? '';
};

/** Replaces the page's clipboard writer: `ok` resolves and records what was written, otherwise it refuses. */
const stubClipboard = (actor: Actor, ok: boolean) => actor.page.evaluate((resolve) => {
  const written: string[] = [];
  (window as unknown as { __copied: string[] }).__copied = written;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: (text: string) => (resolve ? (written.push(text), Promise.resolve()) : Promise.reject(new DOMException('denied', 'NotAllowedError'))) },
  });
}, ok);
const copied = (actor: Actor) => actor.page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

const me = (baseUrl: string, key: string) =>
  fetch(`${baseUrl}/api/me`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });

test('j08-agents keys: a minted key is shown once; revoking it 401s a raw bearer request and closes the agent\'s live socket @p:ppl-2 @evidence', async ({ actors, stack }) => {
  actors.solo('one person and her own agent key; the agent is a raw socket, not a browser actor');
  const ada = await openShell(actors, 'ada');
  const docId = await ui.createNote(ada);

  let settings = await ui.openSettings(ada);
  await mintInSettings(settings, 'Scribe');
  const keyField = settings.getByRole('textbox', { name: 'API key for Scribe', exact: true });
  await expect(keyField, 'the new key is shown').toHaveValue(KEY);
  const key = await keyField.inputValue();
  await expect(settings.getByText('Copy this key now. It won’t be shown again.'), 'and says it is shown once').toBeVisible();
  await expect(agentRow(settings, 'Scribe'), 'the agent is listed').toHaveCount(1);
  await expect(agentRow(settings, 'Scribe').getByRole('textbox'), 'its row is its name and quiet actions, no id field').toHaveCount(0);
  await expect(agentRow(settings, 'Scribe').getByRole('button', { name: 'Copy ID for Scribe', exact: true }), 'with Copy ID').toHaveCount(1);
  const agentId = await agentIdOf(ada, 'Scribe');
  expect(agentId).toMatch(UUID);

  await ada.page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  settings = await ui.openSettings(ada);
  await expect(agentRow(settings, 'Scribe'), 'the agent is still listed').toHaveCount(1);
  await expect(settings.getByRole('textbox', { name: 'API key for Scribe', exact: true }), 'but its key is not shown again').toHaveCount(0);
  await actors.checkpoint('minted');
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
  await expect(settings.getByRole('status').filter({ hasText: 'Revoked Scribe’s key.' }), 'and says so').toBeVisible();

  expect((await me(stack.baseUrl, key)).status, 'a raw bearer request with the revoked key gets 401').toBe(401);
  await expect.poll(live.closeCode, { message: 'the agent\'s live doc socket closes with a revocation code', timeout: LIVE_TIMEOUT }).toBe(4403);
  live.socket.terminate();
});

test('j08-agents settings: Agents is a quiet inventory; New key discloses the name field, the key is shown once with a truthful Copy key, a same-name key adds a second record, and a refused revoke says so @p:ppl-2 @evidence', async ({ actors }) => {
  actors.solo('one person manages her own agent keys in Settings');
  const ada = await openShell(actors, 'ada');
  const settings = await ui.openSettings(ada);
  const list = settings.getByRole('list', { name: 'Agents' });
  const disclose = settings.getByRole('button', { name: 'New key', exact: true });

  await expect(settings.getByText('No agents yet.', { exact: true }), 'an empty inventory says so').toBeVisible();
  await expect(disclose, 'New key is a closed disclosure at rest').toHaveAttribute('aria-expanded', 'false');
  await expect(settings.getByLabel('Agent name', { exact: true }), 'with no name field showing').toHaveCount(0);
  await expect(settings.getByText(/moss-multi CLI/), 'the CLI instructions wait behind their help').toHaveCount(0);
  await settings.getByRole('button', { name: 'How agents connect', exact: true }).click();
  await expect(settings.getByText(/moss-multi CLI/), 'and show on demand').toBeVisible();

  await disclose.click();
  await expect(settings.getByLabel('Agent name', { exact: true }), 'New key opens the name field, focused').toBeFocused();
  await ada.page.keyboard.press('Escape');
  await expect(settings, 'Escape in the field closes only the field').toBeVisible();
  await expect(settings.getByLabel('Agent name', { exact: true })).toHaveCount(0);
  await expect(disclose, 'and focus returns to New key').toBeFocused();
  await disclose.click();
  await ada.page.keyboard.press('Tab');
  await expect(settings.getByRole('button', { name: 'Create key', exact: true }), 'Tab reaches Create key').toBeFocused();
  await ada.page.keyboard.press('Escape');
  await expect(settings, 'Escape on Create key closes only the field').toBeVisible();
  await expect(settings.getByLabel('Agent name', { exact: true })).toHaveCount(0);
  await expect(disclose, 'and focus returns to New key from there too').toBeFocused();

  await mintInSettings(settings, 'Scribe');
  const first = settings.getByRole('textbox', { name: 'API key for Scribe', exact: true });
  await expect(first, 'the key is shown once').toHaveValue(KEY);
  const firstKey = await first.inputValue();
  // A second key cannot replace one still on screen: the server keeps only its hash, so it would be lost.
  await expect(disclose, 'New key waits while a key is on screen').toBeDisabled();
  await expect(first, 'and the shown key stays').toHaveValue(firstKey);

  await stubClipboard(ada, false);
  await settings.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect(settings.getByRole('group', { name: 'Key for Scribe', exact: true }).getByRole('alert'), 'a refused copy says so beside the key').toHaveText('Couldn’t copy. Select the key and copy it yourself.');
  await expect(settings.getByRole('button', { name: 'Copied', exact: true }), 'and never claims Copied').toHaveCount(0);
  await expect(first, 'the key is focused to copy by hand').toBeFocused();
  await stubClipboard(ada, true);
  await settings.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Copied', exact: true }), 'a copy that landed says Copied').toBeVisible();
  expect(await copied(ada), 'with the key itself').toEqual([firstKey]);
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: 'API key for Scribe', exact: true }), 'Done puts the key away').toHaveCount(0);
  await expect(disclose, 'and New key is available again').toBeEnabled();

  const firstId = await agentIdOf(ada, 'Scribe');
  await stubClipboard(ada, true);
  await list.getByRole('button', { name: 'Copy ID for Scribe', exact: true }).click();
  await expect.poll(() => copied(ada), { message: 'Copy ID copies the id a share names' }).toEqual([firstId]);

  // A second key of the same name is a second record: the first stays listed and working.
  await disclose.click();
  await settings.getByLabel('Agent name', { exact: true }).fill('scribe');
  await expect(settings.getByText('You already have an agent named “Scribe”. This makes a second key; the first keeps working.'), 'a same-name key is named before it is made').toBeVisible();
  await settings.getByRole('button', { name: 'Create key', exact: true }).click();
  const second = settings.getByRole('textbox', { name: 'API key for scribe', exact: true });
  await expect(second, 'the second key is shown').toHaveValue(KEY);
  const secondKey = await second.inputValue();
  expect(secondKey).not.toBe(firstKey);
  await expect(list.getByRole('listitem'), 'both records are listed').toHaveCount(2);

  // A refused revoke says why and keeps the row; revoking the older same-name agent leaves the new key on screen.
  ada.expectHttp(409, /\/api\/agents\//);
  const revokes = /\/api\/agents\/[^/]+$/;
  await ada.page.route(revokes, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'conflict', message: 'The key wasn’t revoked. Try again.' }) })
    : route.fallback());
  const confirm = ada.page.getByRole('alertdialog', { name: 'Revoke Scribe’s key?', exact: true });
  await list.getByRole('button', { name: 'Revoke Scribe', exact: true }).click();
  await confirm.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(settings.getByRole('alert'), 'a refused revoke says why').toHaveText('The key wasn’t revoked. Try again.');
  await expect(list.getByRole('listitem'), 'and both rows stay').toHaveCount(2);
  await ada.page.unroute(revokes);
  await list.getByRole('button', { name: 'Revoke Scribe', exact: true }).click();
  await confirm.getByRole('button', { name: 'Revoke key', exact: true }).click();
  await expect(list.getByRole('listitem'), 'the older record leaves').toHaveCount(1, { timeout: LIVE_TIMEOUT });
  await expect(list.getByRole('listitem'), 'the newer one stays').toContainText('scribe');
  await expect(settings.getByRole('textbox', { name: 'API key for scribe', exact: true }), 'and its key is still on screen').toHaveValue(secondKey);
  // The evidence screenshot never holds a key.
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(settings.getByRole('textbox', { name: /^API key for /i })).toHaveCount(0);
  await actors.checkpoint('agents-settings');
});

test('j08-agents share: Ben adds his own agent by its id and it appears as an "agent" row at its role; Ada\'s agent id is refused like an unknown one @p:ppl-2 @evidence', async ({ actors, stack }) => {
  const ada = await openShell(actors, 'ada');
  const ben = await openShell(actors, 'ben');
  await actors.requireDistinct(2);
  // Declared setup: one agent each, minted through the API (the Settings flow is the leg above).
  const mintFor = async (actor: Actor, name: string) => {
    const minted = await actor.context.request.post('/api/agents', { headers: { origin: stack.baseUrl }, data: { name } });
    expect(minted.status(), `declared setup: ${actor.label}'s agent`).toBe(201);
    return (await minted.json()) as { agent: { id: string }; key: string };
  };
  const adas = await mintFor(ada, 'Courier');
  const { agent, key } = await mintFor(ben, 'Scribe');

  const docId = await ui.createNote(ben);
  const dialog = await ui.openShare(ben, docId);
  // PRODUCT ruling 20: an agent id is a label, never consent; someone else's agent is refused as an unknown id is.
  ben.expectHttp(404, `/api/docs/${docId}/members`);
  await dialog.getByLabel('Email or agent ID', { exact: true }).fill(adas.agent.id);
  await dialog.getByRole('button', { name: 'Add agent', exact: true }).click();
  await expect(dialog.getByRole('alert'), 'Ada\'s agent is refused').toHaveText('You have no agent with that ID. Copy it from your agent’s row in Settings → Agents.');
  await expect(dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem').filter({ hasText: 'Courier' }), 'and not listed').toHaveCount(0);

  await ui.shareInDialog(dialog, agent.id, 'Can comment', 'Shared with Scribe.');
  const row = dialog.getByRole('list', { name: 'People with access' }).getByRole('listitem').filter({ hasText: 'Scribe' });
  await expect(row, 'his agent is listed').toHaveCount(1);
  await expect(row.getByText('agent', { exact: true }), 'tagged as an agent').toBeVisible();
  const select = ui.roleMenu(row, 'Access for Scribe');
  await expect(select, 'at the role Ben chose').toHaveText('Can comment');
  await select.click();
  const roles = ui.openRoleMenu(dialog);
  await expect(roles.getByRole('menuitemradio', { checked: true }), 'his role is checked').toHaveText('Can comment');
  await expect(roles.getByRole('menuitemradio', { name: 'Owner', exact: true }), 'an agent is never offered owner').toHaveCount(0);
  await ben.page.keyboard.press('Escape');
  await expect(roles, 'Escape closes the menu').toHaveCount(0);
  await expect(dialog, 'and only the menu').toBeVisible();
  await actors.checkpoint('agent-row');

  const access = await fetch(`${stack.baseUrl}/api/docs/${docId}/access`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
  expect(access.status, 'his agent can open the note').toBe(200);
  const refused = await fetch(`${stack.baseUrl}/api/docs/${docId}/access`, { headers: { authorization: `Bearer ${adas.key}` }, signal: AbortSignal.timeout(10_000) });
  expect(refused.status, 'Ada\'s agent cannot').toBe(404);
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

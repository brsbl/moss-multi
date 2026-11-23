// j13-vault-nav (T9.31): vault navigation is quiet and explicit. The notes-panel header holds only Moss's toggle: no
// vault switcher and no vault actions. The footer's app menu names the vault on screen, and Switch vault… lists each
// vault by name (a shared one with its role) with the one on screen checked, then New vault… after a separator.
// Managing vaults lives in Settings, closed at rest. The tab, the note's location and "+ Note" name the vault; a link
// visitor's tab names none, and neither does anything shared from another vault. Search says it is searching until the index answers, says when it could not, and a result
// from another vault names that vault.
import type { Route } from '@playwright/test';
import type { Actor, Viewport } from '../lib/actors.ts';
import { APP_STATE_ATTR, NAMES, SIDEBAR_ROW_ATTR } from '../lib/contract.ts';
import { grant, grantDoc } from '../lib/grants.ts';
import { expect, test, ui } from '../lib/test.ts';

const DESKTOP: Viewport = { width: 1440, height: 1000 };
const BIND_TIMEOUT = 15_000;
const SIDEBAR_MS = 5_000;
const NO_MATCH = 'No notes match your search';

const noteRow = (actor: Actor, docId: string) => actor.page.locator(`[${SIDEBAR_ROW_ATTR}][${NAMES.docId}="${docId}"]`);

async function listing(actor: Actor): Promise<{ vault: { id: string; name: string }; vaults: { id: string; name: string }[] }> {
  const response = await actor.context.request.get('/api/workspace', { timeout: 15_000 });
  expect(response.status()).toBe(200);
  return response.json();
}

async function makeNote(actor: Actor, folderId: string, title: string, markdown: string): Promise<string> {
  const origin = new URL(actor.page.url()).origin;
  const made = await actor.context.request.post('/api/docs', { headers: { origin }, data: { folderId, title, markdown }, timeout: 15_000 });
  expect(made.status(), `declared setup: ${title}`).toBe(201);
  return ((await made.json()) as { doc: { id: string } }).doc.id;
}

test('j13-vault-nav: the notes-panel header holds only Moss\'s toggle, and Switch vault… names each vault, checks the one on screen and ends with New vault… @p:note-4', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const benPrincipal = await actors.principal('ben');
  const ben = await actors.open(benPrincipal, { viewport: DESKTOP });
  await grant(ben, { folderId: (await listing(ben)).vault.id }, adaPrincipal, 'editor');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  await actors.requireDistinct(2);
  const page = ada.page;

  const toggle = page.getByRole('button', { name: 'Hide notes panel', exact: true });
  const header = toggle.locator('xpath=..');
  await expect(toggle).toBeVisible();
  await expect.poll(() => header.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label'))),
    { message: 'the header holds only the panel toggle' }).toEqual(['Hide notes panel']);
  await expect(page.getByRole('button', { name: /^Vault: / }), 'no vault switcher').toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Vault actions', exact: true }), 'no vault actions').toHaveCount(0);

  await ui.expectVault(page, 'Home');
  const list = await ui.openVaultList(page);
  await expect.poll(() => ui.menuEntries(list), { message: 'named choices, then New vault… after a separator' })
    .toEqual(['Home', 'Home Can edit', '—', 'New vault…']);
  await expect(list.getByRole('menuitemradio', { name: 'Home', exact: true }), 'the vault on screen is checked').toHaveAttribute('aria-checked', 'true');
  await expect(list.getByRole('menuitemradio', { name: 'Home Can edit', exact: true })).toHaveAttribute('aria-checked', 'false');
  await ui.closeVaultList(page);

  await ui.switchVault(page, 'Home Can edit');
  await ui.expectVault(page, 'Home');
  await expect(page.getByRole('button', { name: /^Vault: / }), 'still no switcher in a shared vault').toHaveCount(0);
});

test('j13-vault-nav: New vault… opens Settings on its name field; managing vaults is closed at rest, Rename gives focus back on Escape, and Share comes back to Settings @p:note-4', async ({ actors }) => {
  actors.solo('one owner manages her own vaults');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const page = ada.page;
  const name = `Trip ${Date.now().toString(36)}`;
  await ui.newVault(page, name);

  const dialog = await ui.openSettingsDialog(page);
  const manage = dialog.getByRole('button', { name: 'Manage vaults', exact: true });
  await expect(manage, 'closed at rest').toHaveAttribute('aria-expanded', 'false');
  await expect(dialog.getByRole('button', { name: 'Rename…', exact: true }), 'no vault actions at rest').toHaveCount(0);
  await manage.click();
  await expect(manage).toHaveAttribute('aria-expanded', 'true');

  const rename = dialog.getByRole('button', { name: 'Rename…', exact: true });
  await rename.click();
  const field = dialog.getByRole('textbox', { name: 'Vault name', exact: true });
  await expect(field, 'the vault name becomes a field').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  await expect(dialog, 'Escape leaves only the field').toBeVisible();
  await expect(rename, 'focus goes back to Rename…').toBeFocused();

  await dialog.getByRole('button', { name: 'Share vault…', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share vault' });
  await expect(share, 'the vault share dialog opens').toBeVisible();
  await expect(page.getByRole('dialog'), 'Settings closed first').toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();
  const back = page.getByRole('dialog');
  await expect(back.getByRole('button', { name: 'Manage vaults', exact: true }), 'Settings comes back, still open on Vaults').toHaveAttribute('aria-expanded', 'true');
  await expect(back.getByRole('button', { name: 'Share vault…', exact: true }), 'with focus on Share vault…').toBeFocused();
});

test('j13-vault-nav: the tab, the note\'s location and "+ Note" name the vault; a link visitor\'s tab names none @p:note-4 @p:ppl-2', async ({ actors }) => {
  actors.solo('one owner and a signed-out link visitor');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const page = ada.page;
  const origin = new URL(page.url()).origin;
  const home = (await listing(ada)).vault.id;
  const folder = await ada.context.request.post('/api/folders', { headers: { origin }, data: { parentId: home, name: 'Recipes' } });
  expect(folder.status(), 'declared setup: a folder').toBe(201);
  const folderId = ((await folder.json()) as { folder: { id: string } }).folder.id;
  const docId = await makeNote(ada, folderId, 'Lentil soup', 'Red lentils.');
  await expect(ui.folderRow(ada, 'Recipes')).toBeVisible({ timeout: SIDEBAR_MS });
  await ui.folderRow(ada, 'Recipes').click();
  await ui.openNote(ada, docId);

  await expect.poll(() => page.title(), { message: 'the tab names the note and its vault' }).toBe('Lentil soup — Home — Moss');
  await expect(ui.pane(ada, docId).getByRole('navigation', { name: 'Note location in Home', exact: true }), 'the location names the vault').toBeVisible();
  await page.getByRole('button', { name: 'Create new note', exact: true }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: 'New note in Home' }), '"+ Note" says where it lands').toBeVisible();

  // A note left open across a switch is never labelled with the vault switched to.
  await ui.newVault(page, 'Pantry');
  await expect(page.getByRole('navigation', { name: 'Note location in Pantry', exact: true }), 'the location never names the wrong vault').toHaveCount(0);
  expect(await page.title(), 'nor does the tab').not.toContain('Pantry');

  const linked = await ada.context.request.post(`/api/docs/${docId}/links`, { headers: { origin }, data: { role: 'viewer' } });
  expect(linked.status(), 'declared setup: a view link').toBe(201);
  const { token } = ((await linked.json()) as { link: { token: string } }).link;
  const visitor = await actors.anonymous(`/d/${docId}?share=${token}`, { label: 'visitor', viewport: DESKTOP });
  await visitor.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitOpen(visitor, docId, 'readonly');
  await expect.poll(() => visitor.page.title(), { message: 'a visitor\'s tab names the note only' }).toBe('Lentil soup — Moss');
});

test('j13-vault-nav: a note shared with you is never labelled with the vault on screen @p:note-4 @p:ppl-2', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ben = await actors.open(await actors.principal('ben'), { viewport: DESKTOP });
  const docId = await makeNote(ben, (await listing(ben)).vault.id, 'Ben plans', 'Picnic.');
  await grantDoc(ben, docId, adaPrincipal, 'editor');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  await actors.requireDistinct(2);
  await expect(noteRow(ada, docId), 'the shared note surfaces in her vault').toBeVisible({ timeout: BIND_TIMEOUT });
  await ui.openNote(ada, docId);
  await expect.poll(() => ada.page.title(), { message: 'the tab names the note only' }).toBe('Ben plans — Moss');
  await expect(ada.page.getByRole('navigation', { name: /^Note location in / }), 'no location names a vault').toHaveCount(0);
});

test('j13-vault-nav: a folder shared with you is never labelled with the vault on screen, nor is "+ Note" into it @p:note-4 @p:ppl-2', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ben = await actors.open(await actors.principal('ben'), { viewport: DESKTOP });
  const origin = new URL(ben.page.url()).origin;
  const made = await ben.context.request.post('/api/folders', { headers: { origin }, data: { parentId: (await listing(ben)).vault.id, name: 'Trip' } });
  expect(made.status(), 'declared setup: Ben\'s folder').toBe(201);
  const tripId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const docId = await makeNote(ben, tripId, 'Day one', 'Ferry at nine.');
  await grant(ben, { folderId: tripId }, adaPrincipal, 'editor');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  await actors.requireDistinct(2);
  const page = ada.page;
  const create = page.getByRole('button', { name: 'Create new note', exact: true });
  const hint = page.getByRole('tooltip').filter({ hasText: 'New note in' });

  const own = await ada.context.request.post('/api/folders', { headers: { origin }, data: { parentId: (await listing(ada)).vault.id, name: 'Recipes' } });
  expect(own.status(), 'declared setup: her own folder').toBe(201);
  await expect(ui.folderRow(ada, 'Recipes')).toBeVisible({ timeout: BIND_TIMEOUT });
  await ui.folderRow(ada, 'Recipes').click();
  await create.hover();
  await expect(hint.filter({ hasText: 'New note in Home' }), 'in her own folder "+ Note" names her vault').toBeVisible();
  await page.mouse.move(0, 0);
  await expect(hint).toHaveCount(0);

  await expect(ui.folderRow(ada, 'Trip'), 'the shared folder surfaces in her vault').toBeVisible({ timeout: BIND_TIMEOUT });
  await ui.folderRow(ada, 'Trip').click();
  await create.hover();
  await page.waitForTimeout(1_000);
  await expect(hint, 'a note made in Ben\'s folder is not said to land in her vault').toHaveCount(0);
  await page.mouse.move(0, 0);

  await ui.openNote(ada, docId);
  await expect.poll(() => page.title(), { message: 'the tab names the note only' }).toBe('Day one — Moss');
  await expect(ui.pane(ada, docId).getByRole('navigation', { name: 'Note location', exact: true }), 'the location names no vault').toBeVisible();
});

test('j13-vault-nav: search says Searching… until the index answers, says when it could not, and a result from another vault names it @p:note-7', async ({ actors }) => {
  actors.solo('one owner searches across her own vaults');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const page = ada.page;
  const run = Math.random().toString(36).slice(2, 8);
  const word = `barley${run}`;
  const home = (await listing(ada)).vault.id;
  await ui.newVault(page, 'Pantry');
  const soup = await makeNote(ada, home, `Soup ${run}`, `Pearl ${word} and leeks.`);
  await expect.poll(async () => {
    const answer = await ada.context.request.get(`/api/search?q=${word}`);
    return ((await answer.json()) as { results?: { id: string }[] }).results?.map((hit) => hit.id) ?? [];
  }, { message: 'the index answers', timeout: 20_000 }).toContain(soup);

  const field = page.getByRole('textbox', { name: 'Search notes' });
  const search = async (query: string) => {
    if (!(await field.isVisible())) await page.getByRole('button', { name: 'Search notes', exact: true }).click();
    await field.fill(query);
  };
  const searching = page.getByText('Searching…', { exact: true });
  const noMatch = page.getByText(NO_MATCH, { exact: true });

  // While the index has not answered, the caption says so and never concludes.
  const held: Route[] = [];
  await page.route(/\/api\/search\?/, (route) => { held.push(route); });
  await search(`nothing${run}`);
  await expect(searching, 'pending reads as Searching…').toBeVisible();
  await expect.poll(() => held.length, { message: 'the index request is out' }).toBeGreaterThan(0);
  await expect(noMatch, 'no conclusion before the answer').toHaveCount(0);
  for (const route of held.splice(0)) await route.continue();
  await page.unroute(/\/api\/search\?/);
  await expect(noMatch, 'an empty answer concludes').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(searching).toHaveCount(0);

  // A refused index request says the search could not finish, not that nothing matched.
  ada.expectHttp(429, /\/api\/search/);
  await page.route(/\/api\/search\?/, (route) => route.fulfill({ status: 429, contentType: 'application/json', body: '{"message":"Slow down."}' }));
  await search(`other${run}`);
  await expect(page.getByText('Couldn’t search right now. Try again.', { exact: true }), 'a failed search says so').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(noMatch).toHaveCount(0);
  // A title match shown while the index failed still says the search could not finish.
  const pantry = (await listing(ada)).vaults.find((vault) => vault.name === 'Pantry');
  expect(pantry, 'declared setup: Pantry is listed').toBeDefined();
  const leek = await makeNote(ada, pantry?.id ?? '', `Leek ${run}`, 'Sliced.');
  await search(`Leek ${run}`);
  await expect(noteRow(ada, leek), 'the title match shows').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(page.getByText('Couldn’t search right now. Try again.', { exact: true }), 'and the failure is said under it').toBeVisible({ timeout: BIND_TIMEOUT });
  await page.unroute(/\/api\/search\?/);
  // A title match shown while the index has not answered still says the search is running.
  await page.route(/\/api\/search\?/, (route) => { held.push(route); });
  await search(`Leek ${run}`.toLowerCase());
  await expect(noteRow(ada, leek), 'the title match shows').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(searching, 'and Searching… is said under it').toBeVisible({ timeout: BIND_TIMEOUT });
  for (const route of held.splice(0)) await route.continue();
  await page.unroute(/\/api\/search\?/);

  // From Pantry, the Home note's result names Home.
  await search(word);
  await expect(noteRow(ada, soup), 'the Home note is found from Pantry').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(noteRow(ada, soup), 'its result names its vault').toContainText('Home');
});

test('j13-vault-nav: a switch that fails after New vault says so where she is, with Settings still open on Vaults (T9.46) @p:note-4', async ({ actors }) => {
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  actors.solo('one owner makes a vault');
  const page = ada.page;
  const before = new Set((await listing(ada)).vaults.map((vault) => vault.id));
  // The switch to the vault just made fails; every other listing read answers.
  ada.expectHttp(429, /\/api\/workspace/);
  await page.route(/\/api\/workspace\?/, (route) => {
    const vault = new URL(route.request().url()).searchParams.get('vault');
    return vault && !before.has(vault) ? route.fulfill({ status: 429, contentType: 'application/json', body: '{"message":"Slow down."}' }) : route.fallback();
  });
  await (await ui.openVaultList(page)).getByRole('menuitem', { name: 'New vault…', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'New vault name', exact: true });
  await expect(field).toBeFocused();
  await field.fill(`Pantry ${Date.now().toString(36)}`);
  await field.press('Enter');
  const settings = page.getByRole('dialog');
  const error = settings.getByRole('alert').filter({ hasText: 'Could not switch vaults. Please try again.' });
  await expect(error, 'the failed switch is said in Settings, still open').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(settings.getByRole('button', { name: 'Manage vaults', exact: true }), 'on Vaults, disclosed').toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await ui.expectVault(page, 'Home');
  await page.unroute(/\/api\/workspace\?/);
});

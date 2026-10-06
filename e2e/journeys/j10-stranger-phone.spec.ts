// j10-stranger-phone (T2.7): a stranger handed a share link on a phone. At 390x844 (a touch phone) and 1440x1000 the
// stranger opens the link, reads the note at a readable width, signs up through the login card and lands back on the
// same note, with 0, 1 and 2 other people in it; revoked and forged links show the denial page. Every control on
// screen passes an elementFromPoint hit test at its centre (Tier A). A Tier B sweep opens the share dialog, Settings
// and every chrome menu at 390 px and finds every control reachable.
import { randomBytes } from 'node:crypto';
import type { Actor, Viewport } from '../lib/actors.ts';
import { APP_STATE_ATTR, EDITOR_PANE_ATTR, ROLE_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import type { Principal } from '../lib/principals.ts';
import { layoutFit, unreachableControls } from '../lib/reach.js';
import { expect, test, ui } from '../lib/test.ts';

const BIND_TIMEOUT = 15_000;
const BOOT_TIMEOUT = 30_000;
const DENIAL = /doesn.t exist or you don.t have access/i;
const TEXT = 'A note handed to a stranger, who reads every word of it on a small screen.';

const TIER_A: (Viewport & { name: string })[] = [
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '1440x1000', width: 1440, height: 1000 },
];
const PHONE = TIER_A[0];
/** The notes panel while it overlays the note (below 640 px); what it covers is reached by closing it. */
const PANEL = '[data-overlay-surface]';

/** Declared setup: Ada's note with a paragraph of text (the promise here is the stranger's path, not authoring). */
async function adaNote(ada: Actor, baseUrl: string): Promise<string> {
  const made = await ada.context.request.post('/api/docs', {
    headers: { origin: baseUrl },
    data: { title: `Phone ${randomBytes(2).toString('hex')}`, markdown: `${TEXT}\n` },
  });
  expect(made.status(), 'declared setup: a note').toBe(201);
  return ((await made.json()) as { doc: { id: string } }).doc.id;
}

/** Every control on screen (or in `scope`) is on screen at its centre and nothing covers it. */
async function expectReachable(actor: Actor, what: string, scope: string | null = null): Promise<void> {
  await expect.poll(() => actor.page.evaluate(unreachableControls, { scope }), { message: `${actor.label}: ${what}: every control is reachable and tappable`, timeout: 5_000 }).toEqual([]);
}

/** The stranger reads the note: the text is there, the body is at a readable width, and nothing overflows sideways. */
async function expectReadable(actor: Actor, docId: string, size: Viewport): Promise<void> {
  await expect.poll(() => ui.fieldText(actor, docId, 'body'), { message: `${actor.label}: reads the note`, timeout: BIND_TIMEOUT }).toContain(TEXT);
  const width = await ui.body(actor, docId).evaluate((el) => el.getBoundingClientRect().width);
  expect(width, `${actor.label}: the body is readable, not squeezed (${Math.round(width)} px of ${size.width})`).toBeGreaterThanOrEqual(Math.min(size.width * 0.75, 600));
  const fit = await actor.page.evaluate(layoutFit, { selector: '[data-top-bar] [data-collab-chrome]' });
  expect(fit, `${actor.label}: no sideways overflow and no clipped label in the top bar`).toEqual({ overflowX: 0, clipped: [] });
}

/**
 * Search in note, as a person on this screen finds it (folded into More actions below 640 px): type, step through
 * the matches and close it by tapping, with every control on screen reachable and nothing pushed off the side.
 */
async function searchesTheNote(actor: Actor, docId: string, size: Viewport): Promise<void> {
  const page = actor.page;
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  if (size.width < 640) {
    await more.click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Search in note', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Search in note', exact: true }).click();
  }
  const box = page.getByRole('searchbox', { name: 'Find in note', exact: true });
  await expect(box, `${actor.label}: the search field opens`).toBeVisible();
  await box.fill('a s');
  const counter = page.locator('[data-top-bar]').getByText(/^\d+ of \d+$/);
  await expect(counter, `${actor.label}: both matches are counted`).toHaveText('1 of 2');
  await expectReachable(actor, 'searching the note');
  const fit = await page.evaluate(layoutFit, { selector: null });
  expect(fit.overflowX, `${actor.label}: the open search does not push the page sideways`).toBe(0);
  const bodyLeft = await ui.body(actor, docId).evaluate((el) => el.getBoundingClientRect().left);
  expect(bodyLeft, `${actor.label}: the note's left edge stays on screen while searching`).toBeGreaterThanOrEqual(0);
  await page.getByRole('button', { name: 'Next match', exact: true }).click();
  await expect(counter, `${actor.label}: Next match steps on`).toHaveText('2 of 2');
  await page.getByRole('button', { name: 'Previous match', exact: true }).click();
  await expect(counter, `${actor.label}: Previous match steps back`).toHaveText('1 of 2');
  await page.getByRole('button', { name: 'Close search', exact: true }).click();
  await expect(box, `${actor.label}: a tap closes the search`).toBeHidden();
  await expect(more, `${actor.label}: More actions is back in reach`).toBeVisible();
  await expectReachable(actor, 'the search closed');
}

for (const size of TIER_A) {
  test(`j10 ${size.name}: a stranger opens the link, reads, signs up on the card and lands on the same note, with 0, 1 and 2 others there @tierA @p:tech-9 @p:ppl-2 @p:ppl-1 @evidence`, async ({ actors, stack }) => {
    const adaPrincipal = await actors.principal('ada');
    const ada = await actors.session(adaPrincipal, { viewport: size });
    const docId = await adaNote(ada, stack.baseUrl);
    await ada.goto(`/d/${docId}`);
    await ui.waitOpen(ada, docId, 'live');
    await expectReachable(ada, 'the owner\'s note');
    const dialog = await ui.openShare(ada, docId);
    await expectReachable(ada, 'the share dialog', '[role=dialog]');
    const link = ui.pathOf(await ui.createLink(dialog, 'Can view'));
    expect(link, 'a link to this note').toMatch(new RegExp(`^/d/${docId}\\?share=[0-9a-f]{48}$`));
    await actors.checkpoint(`${size.name}-owner-share`);
    await ada.page.close(); // the stranger arrives alone

    // 0 others: the stranger opens the link.
    const stranger = await actors.anonymous(link, { label: 'stranger', viewport: size });
    await ui.waitOpen(stranger, docId, 'readonly');
    await expect(ui.pane(stranger, docId), 'the link opens at viewer').toHaveAttribute(ROLE_ATTR, 'viewer');
    await expectReadable(stranger, docId, size);
    await expectReachable(stranger, 'alone');
    const signIn = stranger.page.getByRole('button', { name: 'Sign in to do more', exact: true });
    await expect(signIn, 'the stranger is offered sign-in, label and all').toBeVisible();
    await actors.checkpoint(`${size.name}-stranger-alone`);
    await searchesTheNote(stranger, docId, size);

    // 1 other: Ada comes back to the note.
    const ada2 = await actors.open(adaPrincipal, { label: 'ada-2', viewport: size, path: `/d/${docId}` });
    await ui.waitOpen(ada2, docId, 'live');
    await expectReadable(stranger, docId, size);
    await expectReachable(stranger, 'with Ada there');
    await expectReachable(ada2, 'the owner with a link reader there');

    // 2 others: Ben, an editor by grant (declared setup), joins.
    const benPrincipal = await actors.principal('ben');
    await grantDoc(ada2, docId, benPrincipal, 'editor');
    const ben = await actors.open(benPrincipal, { viewport: size, path: `/d/${docId}` });
    await ui.waitOpen(ben, docId, 'live');
    await expect(ada2.page.locator('[data-top-bar] [data-presence-client]'), 'Ada sees Ben in her face pile').not.toHaveCount(0, { timeout: BIND_TIMEOUT });
    await expectReadable(stranger, docId, size);
    await expectReachable(stranger, 'with Ada and Ben there');
    await expectReachable(ada2, 'the owner with two others there');
    await expectReachable(ben, 'an editor with two others there');
    await actors.checkpoint(`${size.name}-stranger-with-two`);

    // Sign up through the card and land back on the same note, link and all.
    await signIn.click();
    await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === link);
    await ui.waitForLoginCard(stranger);
    await expectReachable(stranger, 'the login card');
    const newcomer: Principal = actors.credentials('dee');
    await ui.signUpThroughCard(stranger, newcomer);
    await stranger.page.waitForURL((at) => `${at.pathname}${at.search}` === link, { timeout: BOOT_TIMEOUT });
    await ui.waitOpen(stranger, docId, 'readonly');
    await expect(ui.pane(stranger, docId), 'signed up, a viewer link is still a viewer link').toHaveAttribute(ROLE_ATTR, 'viewer');
    await expect(signIn, 'and no longer offers sign-in').toHaveCount(0);
    await expectReadable(stranger, docId, size);
    await expectReachable(stranger, 'signed up, back on the note');
    const me = (await (await stranger.context.request.get('/api/me')).json()) as { principal?: { id?: string; email?: string } };
    expect(me.principal?.email, 'the new account is the session').toBe(newcomer.email);
    newcomer.id = me.principal?.id ?? null;
    await actors.checkpoint(`${size.name}-stranger-signed-up`);
    await actors.requireDistinct(2);
  });

  test(`j10 ${size.name}: revoked and forged links show the denial page, whose Sign in is tappable @tierA @p:tech-9 @p:ppl-2 @evidence`, async ({ actors, stack }) => {
    actors.solo('the denial page is a stranger alone; Ada is setup only');
    const ada = await actors.session(await actors.principal('ada'));
    const docId = await adaNote(ada, stack.baseUrl);
    const headers = { origin: stack.baseUrl };
    const made = await ada.context.request.post(`/api/docs/${docId}/links`, { headers, data: { role: 'viewer' } });
    expect(made.status(), 'declared setup: a link').toBe(201);
    const { token } = ((await made.json()) as { link: { token: string } }).link;
    expect((await ada.context.request.delete(`/api/docs/${docId}/links/${token}`, { headers })).ok(), 'declared setup: revoke it').toBe(true);

    const forged = randomBytes(24).toString('hex');
    const stranger = await actors.anonymous(`/d/${docId}?share=${token}`, { label: 'stranger', viewport: size });
    stranger.expectHttp(404, `/api/docs/${docId}`);
    for (const [i, presented] of [token, forged].entries()) {
      if (i > 0) await stranger.goto(`/d/${docId}?share=${presented}`);
      await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
      await expect(stranger.page.getByRole('heading', { name: DENIAL }), `${i ? 'a forged' : 'a revoked'} link shows the denial page`).toBeVisible();
      await expect(stranger.page.locator(`[${EDITOR_PANE_ATTR}]`), 'and opens no note').toHaveCount(0);
      expect(await stranger.page.evaluate(layoutFit, { selector: 'main h1, main p, main button' }), 'the page fits and its copy is not clipped').toEqual({ overflowX: 0, clipped: [] });
      await expectReachable(stranger, 'the denial page');
      await actors.checkpoint(`${size.name}-denied-${i ? 'forged' : 'revoked'}`);
    }
    await stranger.page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await stranger.page.waitForURL((at) => at.pathname === '/login' && at.searchParams.get('next') === `/d/${docId}?share=${forged}`);
    await ui.waitForLoginCard(stranger);
  });
}

test('j10 390x844: a folder link lands a stranger on the folder, whose note list and notes are reachable @tierA @p:tech-9 @p:ppl-2 @evidence', async ({ actors, stack }) => {
  actors.solo('the folder landing is a stranger alone; Ada is setup only');
  const ada = await actors.session(await actors.principal('ada'));
  const headers = { origin: stack.baseUrl };
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const name = `Trip ${randomBytes(2).toString('hex')}`;
  const made = await ada.context.request.post('/api/folders', { headers, data: { name, parentId: vault.id } });
  expect(made.status(), 'declared setup: a folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const note = await ada.context.request.post('/api/docs', { headers, data: { folderId, title: 'Packing list', markdown: `${TEXT}\n` } });
  expect(note.status(), 'declared setup: a note in it').toBe(201);
  const docId = ((await note.json()) as { doc: { id: string } }).doc.id;
  const linked = await ada.context.request.post(`/api/folders/${folderId}/links`, { headers, data: { role: 'viewer' } });
  expect(linked.status(), 'declared setup: a folder link').toBe(201);
  const { token } = ((await linked.json()) as { link: { token: string } }).link;

  const stranger = await actors.anonymous(`/f/${folderId}?share=${token}`, { label: 'stranger', viewport: PHONE });
  await stranger.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: BOOT_TIMEOUT });
  const row = stranger.page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  // The landing opens the folder's note, with the notes panel put away until asked for.
  await ui.waitOpen(stranger, docId, 'readonly');
  await expect(row, 'the notes panel stays out of the note\'s way').toBeHidden();
  await expectReadable(stranger, docId, PHONE);
  await expectReachable(stranger, 'the folder landing');
  await actors.checkpoint('390x844-folder-landing');
  await stranger.page.getByRole('button', { name: 'Show notes panel', exact: true }).click();
  await expect(row, 'the folder\'s note is listed').toBeVisible();
  await expectReachable(stranger, 'the notes panel', PANEL);
  await row.click();
  await ui.waitOpen(stranger, docId, 'readonly');
  await stranger.page.mouse.click(PHONE.width - 12, PHONE.height / 2);
  await expect(row, 'a tap on the note puts the notes panel away').toBeHidden();
  await expectReadable(stranger, docId, PHONE);
  await expectReachable(stranger, 'a note opened from the folder');
  await stranger.page.getByRole('button', { name: 'Show notes panel', exact: true }).click();
  await expect(row, 'the notes panel comes back over the note').toBeVisible();
  await expectReachable(stranger, 'the notes panel over the note', PANEL);
});

test('j10 Tier B at 390 px: the share dialog, Settings and every chrome menu keep every control reachable @p:tech-9', async ({ actors, stack }) => {
  actors.solo('the Tier B sweep is the owner alone at 390 px');
  const ada = await actors.session(await actors.principal('ada'), { viewport: PHONE });
  const headers = { origin: stack.baseUrl };
  const { vault } = (await (await ada.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  const name = `Notes ${randomBytes(2).toString('hex')}`;
  const made = await ada.context.request.post('/api/folders', { headers, data: { name, parentId: vault.id } });
  expect(made.status(), 'declared setup: a folder').toBe(201);
  const folderId = ((await made.json()) as { folder: { id: string } }).folder.id;
  const note = await ada.context.request.post('/api/docs', { headers, data: { folderId, title: 'In the folder', markdown: `${TEXT}\n` } });
  expect(note.status(), 'declared setup: a note in it').toBe(201);
  const docId = ((await note.json()) as { doc: { id: string } }).doc.id;
  await ada.goto(`/d/${docId}`);
  await ui.waitOpen(ada, docId, 'live');
  const page = ada.page;
  const menu = '[role=menu]';
  const dialog = '[role=dialog]';

  await expectReachable(ada, 'the note');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  for (const folded of ['Search in note', 'Copy note link']) {
    await expect(page.getByRole('menu').getByRole('menuitem', { name: folded, exact: true }), `${folded} folds into the overflow menu`).toBeVisible();
  }
  await expectReachable(ada, 'More actions', menu);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await searchesTheNote(ada, docId, PHONE);

  await ui.openShare(ada, docId);
  await expectReachable(ada, 'Share', dialog);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Show notes panel', exact: true }).click();
  const folder = ui.folderRow(ada, name);
  await expect(folder, 'the notes panel opens over the note').toBeVisible();
  await expectReachable(ada, 'the notes panel', PANEL);

  await page.getByRole('button', { name: 'Vault: Home', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await expectReachable(ada, 'the vault switcher', menu);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  await folder.click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expectReachable(ada, 'the folder menu', menu);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  const row = page.locator(`[data-sidebar-row][data-doc-id="${docId}"]`);
  if (!(await row.isVisible())) await folder.click(); // expand the folder
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expectReachable(ada, 'the note menu', menu);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();

  const settings = await ui.openSettings(ada);
  await expectReachable(ada, 'Settings', dialog);
  await expect(settings.getByRole('button', { name: 'Sign out', exact: true }), 'Sign out is in reach').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

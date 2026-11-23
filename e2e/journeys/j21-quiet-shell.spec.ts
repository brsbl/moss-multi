// j21-quiet-shell (T9.30): the note shell is Moss's at rest. An open note's top bar holds only Moss's own actions; Share,
// Suggestions, Suggest changes and Version history are More actions entries before Trash; the sidebar's Settings opens
// a short app menu (Current vault, Switch vault…, Notifications, Connection status, Account, Settings) that the
// keyboard walks, on every screen. People here, unread notifications and open suggestions show as quiet cues only
// while they exist, and they yield by the pane's width, never pushing Moss's actions off the bar. Suggesting is one
// quiet row in Moss's docked-toolbar region.
import type { Locator } from '@playwright/test';
import type { Actor, Viewport } from '../lib/actors.ts';
import {
  BODY_BINDING_ATTR, COLLAB_CHROME_ATTR, CONNECTION_ATTR, DOC_ID_ATTR, DOC_STATE_ATTR, EDIT_MODE_ATTR, EDITOR_PANE_ATTR, FLOATING_TOOLBAR_ATTR, HISTORY_VIEW_ATTR, INPUT_REFUSAL_ATTR, MODE_ROW_ATTR, REVIEW_BAND_ATTR, ROLE_BAND_ATTR, SIDEBAR_ROW_ATTR,
  SUGGEST_CHIP_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR, SYNC_UNACKED_ATTR, TOP_BAR_ATTR, paneSelector,
} from '../lib/contract.ts';
import { grant, grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, closePanel, openIn, openPanel, reviewSwitch, sharedNote } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const DESKTOP: Viewport = { width: 1440, height: 1000 };
/** Moss's own top-bar actions, which stay at every width (the notes-panel toggle shows while the panel is hidden). */
const NATIVE = ['Go back', 'Go forward', 'Search in note', 'Copy note link', 'More actions', 'Show actions panel'];

const topBar = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).locator(`[${TOP_BAR_ATTR}]`);

/** The web-added controls a person can see in the pane's top bar. */
const visibleChrome = (actor: Actor, docId: string): Promise<string[]> =>
  topBar(actor, docId).locator(`[${COLLAB_CHROME_ATTR}]`).evaluateAll((els) => els
    .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 1 && box.height > 1; })
    .map((el) => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()));

/** The bar fits its pane once the resize has laid out: nothing scrolls sideways and every control lies inside it. */
async function expectFits(actor: Actor, docId: string, what: string): Promise<void> {
  await expect(async () => {
    const fit = await topBar(actor, docId).evaluate((bar) => {
      const edge = bar.getBoundingClientRect();
      const outside = [...bar.querySelectorAll('button, [role="button"]')]
        .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 1 && (box.right > edge.right + 0.5 || box.left < edge.left - 0.5); })
        .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
      return { overflow: bar.scrollWidth - bar.clientWidth, outside };
    });
    expect(fit.outside, `${what}: no control leaves its pane`).toEqual([]);
    expect(fit.overflow, `${what}: the bar does not scroll sideways`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
}

/** Each of Moss's actions is on screen in the bar. */
async function expectNative(actor: Actor, docId: string, what: string, names = NATIVE): Promise<void> {
  for (const name of names) {
    await expect(topBar(actor, docId).getByRole('button', { name, exact: true }), `${what}: ${name} stays`).toBeVisible();
  }
}

/** A bottom row's look: no shadow or border of its own (quiet, like Moss's status line). */
const look = (row: Locator) => row.evaluate((el) => {
  const style = getComputedStyle(el);
  return { shadow: style.boxShadow, border: parseFloat(style.borderTopWidth) + parseFloat(style.borderLeftWidth) };
});

/** How far the row's bottom edge sits above the bottom of its pane. */
const aboveBottom = (docId: string, row: Locator) => row.evaluate((el, selector) => {
  const pane = document.querySelector(selector)!.getBoundingClientRect();
  return Math.round(Math.min(pane.bottom, window.innerHeight) - el.getBoundingClientRect().bottom);
}, paneSelector(docId));

test('j21 at rest the top bar holds only Moss\'s actions, and More actions holds Share, Suggestions, Suggest changes and Version history before Trash @p:tech-9 @p:ppl-2 @p:mean-3', async ({ actors }) => {
  actors.solo('one owner at rest: nothing pending and nobody else here');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Quiet shell', { enter: true });
  await ui.typeBody(ada, docId, 'Resting words');
  await ui.waitAcked(ada, docId);

  await expect.poll(() => visibleChrome(ada, docId), { message: 'no web control in the resting top bar' }).toEqual([]);
  const bar = topBar(ada, docId);
  for (const name of ['Share', 'History', 'Review suggestions', 'Notifications', 'Sign in']) {
    await expect(bar.getByRole('button', { name, exact: true }), `no ${name} in the top bar`).toHaveCount(0);
  }
  const status = bar.locator(`[${CONNECTION_ATTR}]`);
  await expect(status, 'the connection is still published').toHaveAttribute(CONNECTION_ATTR, 'online');
  const box = await status.boundingBox();
  expect(box === null || box.width <= 1, 'with no visible capsule').toBe(true);
  await expectFits(ada, docId, '1440');
  await expectNative(ada, docId, '1440');

  const entries = await ui.noteMenuEntries(ada, docId);
  expect(entries.slice(entries.indexOf('Note stats')), 'web entries sit between Moss\'s groups, Trash last')
    .toEqual(['Note stats', '—', 'Share…', 'Suggestions', 'Suggest changes', 'Version history', '—', 'Trash']);

  // Typeahead walks More actions as it walks every Moss menu, and Escape gives focus back.
  const more = bar.getByRole('button', { name: 'More actions', exact: true });
  await more.focus();
  await ada.page.keyboard.press('Enter');
  const menu = ada.page.getByRole('menu');
  await expect.poll(() => menu.evaluate((m) => m.contains(document.activeElement)), { message: 'focus is in More actions' }).toBe(true);
  await ada.page.keyboard.type('v');
  await expect(menu.getByRole('menuitem', { name: 'Version history', exact: true }), 'typeahead reaches Version history').toBeFocused();
  await ada.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more, 'Escape returns to More actions').toBeFocused();

  // Each entry does what it says, and focus comes back to More actions.
  await (await ui.openNoteMenu(ada, docId)).getByRole('menuitem', { name: 'Share…', exact: true }).click();
  const share = ada.page.getByRole('dialog', { name: 'Share' });
  await expect(share, 'Share… opens the dialog').toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(share).toBeHidden();
  await expect(more, 'focus returns to More actions').toBeFocused();

  await (await ui.openNoteMenu(ada, docId)).getByRole('menuitem', { name: 'Version history', exact: true }).click();
  const history = ui.pane(ada, docId).locator(`[${HISTORY_VIEW_ATTR}]`);
  await expect(history, 'Version history opens the view').toBeVisible();
  await history.getByRole('button', { name: 'Back to note', exact: true }).click();
  await expect(history).toHaveCount(0);

  const pane = ui.pane(ada, docId);
  ada.expectReconnects(2, docId);
  await (await ui.openNoteMenu(ada, docId)).getByRole('menuitem', { name: 'Suggest changes', exact: true }).click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'suggest', { timeout: BIND_TIMEOUT });
  await expect(ada.page.locator(`[${SUGGEST_CHIP_ATTR}]`), 'one Suggesting state, at the bottom').toBeVisible();
  await expect.poll(() => visibleChrome(ada, docId), { message: 'still nothing added to the top bar' }).toEqual([]);
  expect(await ui.noteMenuEntries(ada, docId), 'no second Suggest entry while suggesting').not.toContain('Suggest changes');

  // The one Suggesting row is part of Moss's docked-toolbar region: at the toolbar's place, nearest the bottom.
  const rows = ada.page.locator(`[${MODE_ROW_ATTR}]`);
  await ada.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(rows, 'one Suggesting row').toHaveCount(1);
  expect(await aboveBottom(docId, rows), 'unfocused, the row sits where Moss\'s docked toolbar does').toBeLessThanOrEqual(32);
  expect(await look(rows), 'a quiet row, no card of its own').toEqual({ shadow: 'none', border: 0 });
  await ui.body(ada, docId).getByText('Resting words').click();
  const toolbar = ada.page.locator(`[${FLOATING_TOOLBAR_ATTR}]`).filter({ has: ada.page.locator('button[aria-label]') });
  await expect(toolbar.locator(`[${MODE_ROW_ATTR}]`), 'while typing, the row joins Moss\'s docked toolbar').toHaveCount(1);
  await expect(rows, 'still one Suggesting row').toHaveCount(1);
  const [row, tools] = await Promise.all([rows.boundingBox(), toolbar.locator('button[aria-label]').first().boundingBox()]);
  expect(row!.y, 'the state is nearest the bottom, under the editing tools').toBeGreaterThan(tools!.y + tools!.height);
  // It reads as the toolbar's last line, not a caption below it: within a few px of the toolbar's own surface.
  expect(row!.y - (tools!.y + tools!.height), 'the row sits right under the toolbar\'s surface').toBeLessThanOrEqual(9);
  expect(await aboveBottom(docId, rows), 'and stays at the bottom edge').toBeLessThanOrEqual(32);

  await rows.getByRole('button', { name: 'Stop suggesting', exact: true }).click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
  await expect(ada.page.locator(`[${SUGGEST_CHIP_ATTR}]`)).toHaveCount(0);
});

test('j21 the sidebar\'s Settings opens the app menu on every screen, walked by keys: Current vault, Switch vault…, Notifications, Connection status, Account, Settings @p:tech-9 @p:note-4', async ({ actors }) => {
  actors.solo('the app menu of one signed-in person');
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  const page = ada.page;
  const settings = page.getByRole('button', { name: 'Settings', exact: true });

  // With no note open the same footer target opens the same menu.
  await expect(page.locator(`[${EDITOR_PANE_ATTR}]`), 'no note is open yet').toHaveCount(0);
  const empty = await ui.openAppMenu(page);
  expect(await ui.menuEntries(empty), 'no note open: the same app menu').toEqual(['Switch vault…', 'Notifications', 'Connection status', 'Account', 'Settings']);
  await empty.getByRole('menuitem', { name: 'Connection status', exact: true }).click();
  await expect(page.getByRole('menu').getByText('No note open', { exact: true }), 'Connection status says no note is open').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();

  const docId = await ui.createNote(ada);
  await ui.waitLive(ada, docId);

  // From the keyboard: Enter on the focused footer target opens the menu on its first entry.
  await settings.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu, 'the app menu opens').toBeVisible();
  await expect(menu.getByText(/^Current vault: .+/), 'it names the vault on screen').toBeVisible();
  expect(await ui.menuEntries(menu)).toEqual(['Switch vault…', 'Notifications', 'Connection status', 'Account', 'Settings']);
  await expect.poll(() => menu.evaluate((m) => m.contains(document.activeElement)), { message: 'focus is in the menu' }).toBe(true);
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Settings', exact: true }), 'End reaches the last entry').toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem', { name: 'Switch vault…', exact: true }), 'Home the first').toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Notifications', exact: true }), 'arrows step').toBeFocused();
  await page.keyboard.type('a');
  await expect(menu.getByRole('menuitem', { name: 'Account', exact: true }), 'typeahead reaches Account').toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(settings, 'Escape returns to Settings').toBeFocused();

  // Switch vault… lists the vaults, the one on screen checked, then New vault….
  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Switch vault…', exact: true }).hover();
  const vaults = page.getByRole('menu').filter({ has: page.getByRole('menuitemradio') });
  await expect(vaults.getByRole('menuitemradio', { checked: true }), 'the vault on screen is checked').toHaveCount(1);
  await expect(vaults.getByRole('menuitem').last(), 'New vault… comes last').toHaveText('New vault…');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Notifications opens the inbox here, and Escape brings focus back to Settings.
  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Notifications', exact: true }).click();
  await expect(page.getByText('No notifications yet.', { exact: true }), 'the inbox opens').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('No notifications yet.', { exact: true })).toBeHidden();
  await expect(settings).toBeFocused();

  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Connection status', exact: true }).click();
  await expect(page.getByRole('menu').getByText('Connected', { exact: true }), 'the open note is connected').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeFocused();

  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Account', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(adaPrincipal.email), 'Account opens its Settings section').toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  const opened = await ui.openSettingsDialog(page);
  await expect(opened.getByRole('radiogroup', { name: 'Theme' }), 'Settings opens Settings').toBeVisible();
  await page.keyboard.press('Escape');
});

test('j21 New vault… from the app menu opens its name field while a shared vault is on screen @p:note-4', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const benPrincipal = await actors.principal('ben');
  const ben = await actors.open(benPrincipal, { viewport: DESKTOP });
  const { vault } = (await (await ben.context.request.get('/api/workspace')).json()) as { vault: { id: string } };
  await grant(ben, { folderId: vault.id }, adaPrincipal, 'editor');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  await actors.requireDistinct(2);
  const page = ada.page;

  // Ada moves to Ben's vault, which she does not own.
  await ui.switchVault(page, 'Home Can edit');

  // New vault… opens Settings on the name field, and the new vault opens.
  await ui.newVault(page, `Vault ${Date.now().toString(36)}`);
});

test('j21 people, unread and open suggestions are quiet cues that yield by the pane\'s width and never push Moss\'s actions off @p:tech-9 @p:col-2 @p:ppl-3 @p:mean-2', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown: 'Keep every original word.' } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  await openIn(ada, docId, 'edit');
  await openIn(ben, docId, 'suggest');
  await actors.requireDistinct(2);
  await caret(ben, docId, 'original word', 8);
  await ben.page.keyboard.type(' plus');
  await expect(ui.pane(ben, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ben, docId)).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');

  const page = ada.page;
  const bar = topBar(ada, docId);
  const count = bar.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`);
  const bell = bar.getByRole('button', { name: /^Notifications, \d+ unread$/ });
  const people = bar.getByRole('button', { name: /^People here/ });
  const panel = page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
  const more = bar.getByRole('button', { name: 'More actions', exact: true });
  await expect(count, 'the open suggestion shows its count').toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect(bell, 'the unread notice shows the bell').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(people, 'Ben is here').toBeVisible({ timeout: BIND_TIMEOUT });
  await expectFits(ada, docId, '1440 with every cue');
  await expectNative(ada, docId, '1440 with every cue');

  // Presence is neutral initials, like Moss's own monochrome icons: no coloured fill, no heavy type.
  const faces = await people.locator('[data-presence-client]').evaluateAll((els) => els.map((el) => {
    const style = getComputedStyle(el);
    const [r, g, b] = (style.backgroundColor.match(/[\d.]+/g) ?? ['0', '0', '0']).slice(0, 3).map(Number);
    return { spread: Math.max(r, g, b) - Math.min(r, g, b), weight: Number(style.fontWeight) };
  }));
  expect(faces.length, 'Ben\'s initials show').toBeGreaterThan(0);
  for (const face of faces) {
    expect(face.spread, 'a neutral fill').toBeLessThanOrEqual(16);
    expect(face.weight, 'regular-weight initials').toBeLessThanOrEqual(500);
  }

  // A focused cue that leaves the bar, its popup never opened, hands focus to its stable home, never to the page: the
  // bell to the sidebar footer's Settings (or the notes-panel toggle while the sidebar is away), the count and People
  // here to More actions, where Suggestions and its roster stay.
  const focusMoves = async (cue: Locator, width: number, home: string[], what: string) => {
    await page.setViewportSize(DESKTOP);
    await expect(cue, `${what} is back at 1440`).toBeVisible();
    await cue.focus();
    await expect(cue).toBeFocused();
    await page.setViewportSize({ width, height: 1000 });
    await expect(cue, `${what} leaves the bar at ${width}`).toHaveCount(0);
    await expect.poll(async () => {
      const at = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null);
      return at !== null && home.includes(at) ? 'home' : at;
    }, { message: `${what}: focus moves to its home, not the page` }).toBe('home');
  };
  await focusMoves(bell, 900, ['Settings', 'Show notes panel'], 'the focused bell');
  await focusMoves(count, 640, ['More actions'], 'the focused count');
  await focusMoves(people, 600, ['More actions'], 'the focused People here');
  await page.setViewportSize(DESKTOP);

  // An open popup keeps its activator in its slot while the pane narrows; once it closes the cue yields and focus,
  // which was on it, moves to More actions.
  await count.click();
  await expect(panel, 'the count opens the list').toBeVisible();
  await page.setViewportSize({ width: 640, height: 1000 });
  await expectFits(ada, docId, '640 with the list open');
  await expect(count, '640: the open list keeps its count').toBeVisible();
  await expect(panel, 'and stays open').toBeVisible();
  await count.focus();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(count, 'closed, the count yields').toHaveCount(0);
  await expect(more, 'focus moves to More actions').toBeFocused();

  for (const width of [1024, 640]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectFits(ada, docId, `${width}`);
    await expectNative(ada, docId, `${width}`);
  }
  // Fully yielded below 640 px of pane: People here, the unread shortcut and the count leave; their routes stay.
  await expect(bell, '640: the bell yields').toHaveCount(0);
  await expect(count, '640: the count yields').toHaveCount(0);
  await expect(people, '640: People here leaves the bar').toHaveCount(0);
  const entries = await ui.noteMenuEntries(ada, docId);
  expect(entries, 'the count moves into its More actions row').toContain('Suggestions 1');

  await page.setViewportSize({ width: 390, height: 844 });
  await expectFits(ada, docId, '390');
  await expectNative(ada, docId, '390', ['Show notes panel', ...NATIVE]);
  // Too narrow to read, the location yields instead of showing clipped fragments beside Moss's actions.
  const clipped = await bar.evaluate((root) => [...root.querySelectorAll('*')]
    .filter((el) => [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()))
    .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 1 && box.width < 48 && el.scrollWidth > el.clientWidth + 1; })
    .map((el) => el.textContent));
  expect(clipped, '390: no clipped text in the bar').toEqual([]);
  // People here is in the Suggestions list's heading, its own action there.
  await (await ui.openNoteMenu(ada, docId)).getByRole('menuitem', { name: /^Suggestions/ }).click();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: /^People here/ }).click();
  await expect(page.getByRole('menu').getByText(benPrincipal.name, { exact: true }), 'the roster names Ben').toBeVisible();
  await expect(async () => {
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden({ timeout: 1_000 });
  }, 'Escape closes the roster, then the list').toPass({ timeout: 5_000 });

  // The bell's inbox: once nothing is unread its cue goes, and focus moves to the footer's Settings, where the
  // inbox lives.
  await page.setViewportSize(DESKTOP);
  await expect(bell).toBeVisible();
  await bell.click();
  // T9.38: a quiet 352 px list in Moss's menu material, the count inside it, grouped under its note, neutral ink.
  const inbox = page.getByRole('menu', { name: 'Notifications' });
  await expect(inbox, 'the bell opens the inbox').toBeVisible();
  expect((await inbox.boundingBox())?.width, 'the inbox is 352 px wide at 1440').toBeCloseTo(352, 0);
  await expect(inbox.getByText(/^\d+ unread$/), 'the count is inside the inbox').toBeVisible();
  await expect(inbox.locator('[data-inbox-group]'), 'the note\'s notices sit under it').toHaveCount(1);
  await expect(inbox.getByRole('menuitem', { name: /suggested changes in “/ }).first(), 'each row still names its note in full').toBeVisible();
  const saturated = await inbox.evaluate((root) => [root, ...root.querySelectorAll('*')].flatMap((el) => {
    const style = getComputedStyle(el);
    return [style.backgroundColor, style.color].flatMap((value) => {
      const [r, g, b, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number);
      return r === undefined || a === 0 || Math.max(r, g, b) - Math.min(r, g, b) <= 24 ? [] : [`${el.tagName} ${value}`];
    });
  }));
  expect(saturated, 'no saturated dot or colour in the inbox').toEqual([]);
  await page.getByRole('button', { name: 'Mark all read', exact: true }).click();
  await expect(inbox, 'Mark all read keeps the inbox open').toBeVisible();
  await expect(bar.getByRole('button', { name: 'Notifications', exact: true }), 'and its bell pinned while it is open').toBeVisible();
  await expect.poll(() => inbox.evaluate((root) => root.contains(document.activeElement)), { message: 'focus stays in the inbox' }).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Mark all read')).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /^Notifications/ }), 'nothing unread: the bell goes').toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true }), 'focus moves to Settings in the footer').toBeFocused();
});

test('j21 the inbox says when its first read is pending or has failed, apart from empty, and stays open to retry @p:tech-9 @p:ppl-3', async ({ actors }) => {
  actors.solo('one person\'s inbox');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const page = ada.page;
  const list = /\/api\/notifications$/;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(list, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await gate;
    await route.fulfill({ status: 429, body: '' });
  });
  ada.expectHttp(429, '/api/notifications');
  await page.reload();
  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Notifications', exact: true }).click();
  const inbox = page.getByRole('menu', { name: 'Notifications' });
  await expect(inbox.getByText('Loading notifications…', { exact: true }), 'a first read in flight says so').toBeVisible();
  await expect(inbox.getByText('No notifications yet.', { exact: true }), 'and never claims to be empty').toHaveCount(0);
  expect((await inbox.boundingBox())?.width, 'the inbox is 352 px wide').toBeCloseTo(352, 0);
  release();
  await expect(inbox.getByText('Couldn’t load notifications.', { exact: true }), 'a failed read says so').toBeVisible();
  await page.unroute(list);
  await inbox.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(inbox.getByText('No notifications yet.', { exact: true }), 'an empty answer reads as empty').toBeVisible();
  await expect(inbox, 'the inbox stayed open').toBeVisible();
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings', exact: true }), 'focus returns to Settings').toBeFocused();

  // At 390 px the same inbox fits the screen with 16 px to spare on each side.
  await page.setViewportSize({ width: 390, height: 844 });
  const settings = page.getByRole('button', { name: 'Settings', exact: true });
  if (!(await settings.isVisible())) await page.getByRole('button', { name: 'Show notes panel', exact: true }).click();
  await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Notifications', exact: true }).click();
  await expect(inbox).toBeVisible();
  const box = (await inbox.boundingBox())!;
  expect(box.width, '390: the inbox is the screen less 32 px').toBeLessThanOrEqual(390 - 32 + 0.5);
  expect(box.x, '390: 16 px margin').toBeGreaterThanOrEqual(15.5);
  await page.keyboard.press('Escape');
  await expect(inbox).toBeHidden();
});

test('j21 two panes each keep Moss\'s actions on their own bar @p:tech-9 @p:col-6', async ({ actors }) => {
  actors.solo('one owner with a split');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const first = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, first);
  const second = await ui.newNote(ada, { onlyPane: true });
  await ui.waitBodyLive(ada, second);
  // Opening the first note again, in the split, binds it on a second socket.
  ada.expectReconnects(1, first);
  await ada.page.locator(`[${SIDEBAR_ROW_ATTR}][${DOC_ID_ATTR}="${first}"]`).click({ button: 'right' });
  await ada.page.getByRole('menuitem', { name: 'Open in Split Tab', exact: true }).click();
  await ui.waitBodyLive(ada, first);
  await expect(ui.pane(ada, second)).toBeVisible();
  for (const width of [1440, 1024]) {
    await ada.page.setViewportSize({ width, height: 1000 });
    for (const docId of [first, second]) {
      await expectFits(ada, docId, `${width}, pane ${docId === first ? 'right' : 'left'}`);
      await expectNative(ada, docId, `${width}`, ['Go back', 'Go forward', 'Search in note', 'Copy note link', 'More actions']);
    }
  }
  // Each pane's More actions is its own note's.
  await (await ui.openNoteMenu(ada, first)).getByRole('menuitem', { name: 'Share…', exact: true }).click();
  await expect(ada.page.getByRole('dialog', { name: 'Share' })).toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(ui.pane(ada, first).getByRole('button', { name: 'More actions', exact: true }), 'focus returns to that pane\'s More actions').toBeFocused();
});

test('j21 a reader in Review has one bottom row with their access and Review, and Done or Escape leaves Review @p:tech-9 @p:col-2', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  const carlPrincipal = await actors.principal('carl');
  await grantDoc(ada, docId, carlPrincipal, 'viewer');
  const carl = await actors.session(carlPrincipal, { viewport: DESKTOP });
  await openIn(ben, docId, 'suggest');
  await actors.requireDistinct(3);
  await caret(ben, docId, 'original word', 8);
  await ben.page.keyboard.type(' plus');
  await expect(ui.pane(ben, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ben, docId)).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');

  // Entering and leaving Review remounts the viewer's body on a fresh socket each time.
  carl.expectReconnects(4, docId);
  const pane = await openIn(carl, docId, 'review');
  const page = carl.page;
  const row = page.locator(`[${ROLE_BAND_ATTR}]`);
  const review = page.locator(`[${REVIEW_BAND_ATTR}]`);
  const inReview = async (what: string) => {
    await expect(pane, what).toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
    await expect(row, `${what}: one row holds the access and Review`).toHaveText('Reviewing suggestions · View only Done');
    await expect(row.getByRole('button', { name: 'Done', exact: true })).toHaveAccessibleDescription('Return to the plain note; your access stays the same');
    await expect(review, `${what}: and it is the Review row`).toHaveCount(1);
    await expect(page.locator(`[${ROLE_BAND_ATTR}], [${REVIEW_BAND_ATTR}]`), `${what}: no second row`).toHaveCount(1);
    expect(await look(row), 'a quiet row').toEqual({ shadow: 'none', border: 0 });
    expect(await aboveBottom(docId, row), 'at the bottom').toBeLessThanOrEqual(32);
  };
  const leftReview = async (what: string) => {
    await expect(pane, what).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
    await expect(ui.body(carl, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: BIND_TIMEOUT });
    await expect(row, `${what}: the row keeps the reader's access`).toHaveText('View only');
    await expect(review).toHaveCount(0);
    // Leaving remounts the body; the next switch waits until it is live again.
    await expect(pane).toHaveAttribute(DOC_STATE_ATTR, 'live', { timeout: BIND_TIMEOUT });
  };

  await inReview('a viewer opens in Review');
  await row.getByRole('button', { name: 'Done', exact: true }).click();
  await leftReview('Done leaves Review');

  const entry = reviewSwitch(await openPanel(carl));
  await expect(entry, 'the entry says the note stays view only').toHaveAccessibleDescription('Read proposed changes; this note stays view only');
  await entry.click();
  await closePanel(carl);
  await inReview('back in Review from the list');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await leftReview('Escape leaves Review');
});

// T9.35: restricted access in the one bottom region. A refusal floats as Moss's bottom notice just above the reader's
// row, at its content's width, and the note under the top bar never moves; the row's words explain themselves by
// keyboard, pointer and tap.
test('j21 restricted access: a refused key floats above View only in the bottom region, the note does not move, and View only explains itself by keyboard and tap @p:tech-9 @p:ppl-2', async ({ actors }) => {
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Read only', { enter: true });
  await ui.typeBody(ada, docId, 'Words to read');
  await ui.waitAcked(ada, docId);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await actors.open(benPrincipal, { viewport: DESKTOP, path: `/d/${docId}` });
  await ui.waitOpen(ben, docId, 'readonly');
  await actors.requireDistinct(2);
  const explained = "You can view this note, but you can't edit it.";
  const pane = ui.pane(ben, docId);
  const row = pane.locator(`[${ROLE_BAND_ATTR}]`);
  const refusal = pane.locator(`[${INPUT_REFUSAL_ATTR}]`);
  await expect(row).toHaveText('View only');
  await expect(refusal, 'one refusal region in the pane').toHaveCount(1);

  const titleAt = (await ui.title(ben, docId).boundingBox())!.y;
  await ui.body(ben, docId).getByText('Words to read').click({ force: true });
  await ben.page.keyboard.type('x');
  await expect(refusal, 'the key says why').toHaveText(explained);
  const [notice, band, box] = await Promise.all([refusal.boundingBox(), row.boundingBox(), pane.boundingBox()]);
  expect((await ui.title(ben, docId).boundingBox())!.y, 'the note under the top bar does not move').toBe(titleAt);
  expect(notice!.y + notice!.height, 'the notice stands above the row').toBeLessThanOrEqual(band!.y + 0.5);
  expect(band!.y - (notice!.y + notice!.height), 'just above it, in the same region').toBeLessThanOrEqual(16);
  expect(notice!.width, 'at its content\'s width, not a strip across the pane').toBeLessThan(box!.width - 32);
  expect(await aboveBottom(docId, row), 'the row stays at the bottom').toBeLessThanOrEqual(32);
  await actors.checkpoint('refusal-in-bottom-region');
  await expect(refusal, 'the notice clears').toHaveText('', { timeout: 6_000 });

  const lead = row.getByRole('button', { name: 'View only', exact: true });
  await expect(lead, 'the access explains itself to assistive tech').toHaveAccessibleDescription(explained);
  await lead.focus();
  await expect(ben.page.getByRole('tooltip'), 'and in Moss\'s tooltip on keyboard focus').toContainText(explained);
  await ben.page.keyboard.press('Enter');
  await expect(refusal, 'pressing it says the same out loud').toHaveText(explained);
  await expect(refusal).toHaveText('', { timeout: 6_000 });

  await ben.page.setViewportSize({ width: 390, height: 844 });
  await expect(lead, 'at 390 px the row keeps its words').toBeVisible();
  await lead.tap().catch(() => lead.click());
  await expect(refusal, 'a tap explains it on a phone').toHaveText(explained);
  expect(await ui.fieldText(ada, docId, 'body'), 'the owner\'s note is unchanged').toBe('Words to read');
});


// j21-quiet-shell (T9.30): the note shell is Moss's at rest. An open note's top bar holds only Moss's own actions; Share,
// Suggestions, Suggest changes and Version history are More actions entries before Trash; the sidebar's Settings opens
// a short app menu (Current vault, Switch vault…, Notifications, Connection status, Account, Settings) that the
// keyboard walks. People here, unread notifications and open suggestions show as quiet cues only while they exist,
// and they yield by the pane's width, never pushing Moss's actions off the bar.
import type { Locator } from '@playwright/test';
import type { Actor, Viewport } from '../lib/actors.ts';
import {
  COLLAB_CHROME_ATTR, CONNECTION_ATTR, EDIT_MODE_ATTR, HISTORY_VIEW_ATTR, SUGGEST_CHIP_ATTR, SUGGEST_REFUSED_ATTR, SUGGESTIONS_BUTTON_ATTR,
  SYNC_UNACKED_ATTR, TOP_BAR_ATTR,
} from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, openIn } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const DESKTOP: Viewport = { width: 1440, height: 1000 };

const topBar = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).locator(`[${TOP_BAR_ATTR}]`);

/** The web-added controls a person can see in the pane's top bar. */
const visibleChrome = (actor: Actor, docId: string): Promise<string[]> =>
  topBar(actor, docId).locator(`[${COLLAB_CHROME_ATTR}]`).evaluateAll((els) => els
    .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 1 && box.height > 1; })
    .map((el) => el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()));

/** The bar fits once the resize has laid out: nothing scrolls sideways and every visible control lies inside the window. */
async function expectFits(actor: Actor, docId: string, what: string): Promise<void> {
  await expect(async () => {
    const fit = await topBar(actor, docId).evaluate((bar) => {
      const width = window.innerWidth;
      const outside = [...bar.querySelectorAll('button, [role="button"]')]
        .filter((el) => { const box = el.getBoundingClientRect(); return box.width > 1 && (box.right > width + 0.5 || box.left < -0.5); })
        .map((el) => el.getAttribute('aria-label') ?? el.textContent ?? '');
      return { overflow: bar.scrollWidth - bar.clientWidth, outside };
    });
    expect(fit.outside, `${what}: no control leaves the window`).toEqual([]);
    expect(fit.overflow, `${what}: the bar does not scroll sideways`).toBeLessThanOrEqual(1);
  }).toPass({ timeout: 5_000 });
}

test('j21 at rest the top bar holds only Moss\'s actions, and More actions holds Share, Suggestions, Suggest changes and Version history before Trash @p:tech-9 @p:ppl-2 @p:mean-3', async ({ actors }) => {
  actors.solo('one owner at rest: nothing pending and nobody else here');
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Quiet shell', { enter: true });
  await ui.typeBody(ada, docId, 'Resting words');
  await ui.waitAcked(ada, docId);

  await expect.poll(() => visibleChrome(ada, docId), { message: 'no web control in the resting top bar' }).toEqual([]);
  const bar = topBar(ada, docId);
  for (const name of ['Share', 'History', 'Review suggestions', 'Notifications', 'Sign in to do more']) {
    await expect(bar.getByRole('button', { name, exact: true }), `no ${name} in the top bar`).toHaveCount(0);
  }
  const status = bar.locator(`[${CONNECTION_ATTR}]`);
  await expect(status, 'the connection is still published').toHaveAttribute(CONNECTION_ATTR, 'online');
  const box = await status.boundingBox();
  expect(box === null || box.width <= 1, 'with no visible capsule').toBe(true);
  await expectFits(ada, docId, '1440');

  const entries = await ui.noteMenuEntries(ada, docId);
  expect(entries.slice(entries.indexOf('Note stats')), 'web entries sit between Moss\'s groups, Trash last')
    .toEqual(['Note stats', '—', 'Share…', 'Suggestions', 'Suggest changes', 'Version history', '—', 'Trash']);

  // Each entry does what it says, and focus comes back to More actions.
  const more = bar.getByRole('button', { name: 'More actions', exact: true });
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
  await expect(pane.locator(`[${SUGGEST_CHIP_ATTR}]`), 'one Suggesting state, at the bottom').toBeVisible();
  await expect.poll(() => visibleChrome(ada, docId), { message: 'still nothing added to the top bar' }).toEqual([]);
  expect(await ui.noteMenuEntries(ada, docId), 'no second Suggest entry while suggesting').not.toContain('Suggest changes');
  await pane.getByRole('button', { name: 'Stop suggesting', exact: true }).click();
  await expect(pane).toHaveAttribute(EDIT_MODE_ATTR, 'edit', { timeout: BIND_TIMEOUT });
  await expect(pane.locator(`[${SUGGEST_CHIP_ATTR}]`)).toHaveCount(0);
});

test('j21 the sidebar\'s Settings opens the app menu, walked by keys: Current vault, Switch vault…, Notifications, Connection status, Account, Settings @p:tech-9 @p:note-4', async ({ actors }) => {
  actors.solo('the app menu of one signed-in person');
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal, { viewport: DESKTOP });
  const docId = await ui.createNote(ada);
  await ui.waitLive(ada, docId);
  const page = ada.page;
  const settings = page.getByRole('button', { name: 'Settings', exact: true });

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

  const bar = topBar(ada, docId);
  const count = bar.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`);
  const bell = bar.getByRole('button', { name: /^Notifications, \d+ unread$/ });
  const people = bar.getByRole('button', { name: /^People here/ });
  await expect(count, 'the open suggestion shows its count').toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect(bell, 'the unread notice shows the bell').toBeVisible({ timeout: BIND_TIMEOUT });
  await expect(people, 'Ben is here').toBeVisible({ timeout: BIND_TIMEOUT });
  await expectFits(ada, docId, '1440 with every cue');

  for (const width of [1024, 640]) {
    await ada.page.setViewportSize({ width, height: 1000 });
    await expectFits(ada, docId, `${width}`);
    await expect(bar.getByRole('button', { name: 'More actions', exact: true }), `${width}: More actions stays`).toBeVisible();
  }
  // Fully yielded below 700 px of pane: the unread shortcut and the count leave; their routes stay.
  await expect(bell, '640: the bell yields').toHaveCount(0);
  await expect(count, '640: the count yields').toHaveCount(0);
  await expect(people, '640: People here stays, as one target').toBeVisible();
  const entries = await ui.noteMenuEntries(ada, docId);
  expect(entries, 'the count moves into its More actions row').toContain('Suggestions 1');

  await ada.page.setViewportSize({ width: 390, height: 844 });
  await expectFits(ada, docId, '390');
  for (const name of ['Show notes panel', 'Go back', 'Go forward', 'More actions']) {
    await expect(bar.getByRole('button', { name, exact: true }), `390: ${name} stays`).toBeVisible();
  }
});

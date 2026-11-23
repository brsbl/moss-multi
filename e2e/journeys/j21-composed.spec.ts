// j21-composed (T9.46): the quiet shell's composed states. A link visitor's Review row is one line at 390 px; the
// Suggestions list's way into Review takes one row; a reader's access words explain themselves inside Review; a
// refusal keeps to the pane's one bottom region at a short height, in a split pane and beside the outage notice; and
// a notice whose note is gone stays unread and says why.
import type { Actor, Viewport } from '../lib/actors.ts';
import {
  BOTTOM_REGION_ATTR, CONNECTION_BANNER_ATTR, DOC_ID_ATTR, EDIT_MODE_ATTR, INPUT_REFUSAL_ATTR, REVIEW_BAND_ATTR, ROLE_BAND_ATTR, SIDEBAR_ROW_ATTR,
  SUGGEST_REFUSED_ATTR, SUGGESTION_CARD_ATTR, SYNC_UNACKED_ATTR,
} from '../lib/contract.ts';
import { grantDoc, linkDoc } from '../lib/grants.ts';
import { BIND_TIMEOUT, caret, openIn, openPanel, reviewSwitch, sharedNote } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const DESKTOP: Viewport = { width: 1440, height: 1000 };

// Moss's docked toolbar is 42 px tall at the bottom of the pane (app--default).
const MOSS_TOOLBAR_PX = 42;
/** Moss's comment list: its list's top padding (4) plus a row's own (10), from the line above to a row's first line. */
const MOSS_COMMENT_ROW_GAP_PX = 14;

/** Ben, a suggester, proposes one word in Ada's note; acknowledged. */
async function suggestOne(ben: Actor, docId: string, word = 'original word'): Promise<void> {
  await openIn(ben, docId, 'suggest');
  await caret(ben, docId, word, 5);
  await ben.page.keyboard.type(' plus');
  await expect(ui.pane(ben, docId)).toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: BIND_TIMEOUT });
  await expect(ui.pane(ben, docId)).toHaveAttribute(SUGGEST_REFUSED_ATTR, '0');
}

test('j21-composed a signed-out link visitor in Review at 390x844 reads one line: Reviewing suggestions · View only, Done and Sign in (T9.46) @p:tech-9 @p:ppl-2', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await suggestOne(ben, docId);
  const token = await linkDoc(ada, docId, 'viewer');
  const visitor = await actors.anonymous(`/d/${docId}?share=${token}`, { label: 'visitor', viewport: { width: 390, height: 844, mobile: true } });
  const pane = ui.pane(visitor, docId);
  await expect(pane, 'a link reader opens a note with a suggestion in Review').toHaveAttribute(EDIT_MODE_ATTR, 'review', { timeout: BIND_TIMEOUT });
  const row = visitor.page.locator(`[${ROLE_BAND_ATTR}]`);
  await expect(row).toHaveText('Reviewing suggestions · View only Done Sign in');
  const lines = await row.evaluate((el) => [...el.querySelectorAll('span:not([hidden]), button')]
    .map((part) => part.getBoundingClientRect()).filter((box) => box.width > 0).map((box) => Math.round(box.top + box.height / 2)));
  expect(new Set(lines).size, 'the words, Done and Sign in share one line').toBe(1);
  const box = (await row.boundingBox())!;
  expect(box.height, 'no taller than Moss\'s docked toolbar').toBeLessThanOrEqual(MOSS_TOOLBAR_PX);
  expect(box.x, 'inside the screen').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
});

test('j21-composed the Suggestions list\'s first row sits one entry line and Moss\'s row gap under its header (T9.46) @p:tech-9 @p:col-2', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  await suggestOne(ben, docId);
  await openIn(ada, docId, 'edit');
  const list = await openPanel(ada);
  const entry = reviewSwitch(list);
  await expect(entry, 'outside Review the list offers Review suggestions').toBeVisible({ timeout: BIND_TIMEOUT });
  const author = list.locator(`[${SUGGESTION_CARD_ATTR}]`).first().locator(':scope > div').first();
  await expect(author).toBeVisible();
  const header = list.locator(':scope > div').first();
  const [head, line, first] = await Promise.all([header.boundingBox(), entry.boundingBox(), author.boundingBox()]);
  expect(first!.y - (head!.y + head!.height), 'the first author row sits no lower than the entry\'s line plus Moss\'s row gap')
    .toBeLessThanOrEqual(line!.height + MOSS_COMMENT_ROW_GAP_PX + 0.5);
});

test('j21-composed a reader in Review hears what View only means, as outside Review: tooltip, description and the refusal sentence (T9.46) @p:tech-9 @p:ppl-2', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors);
  const carlPrincipal = await actors.principal('carl');
  await grantDoc(ada, docId, carlPrincipal, 'viewer');
  const carl = await actors.session(carlPrincipal, { viewport: DESKTOP });
  await suggestOne(ben, docId);
  await actors.requireDistinct(3);
  await openIn(carl, docId, 'review');
  const explained = "You can view this note, but you can't edit it.";
  const row = carl.page.locator(`[${REVIEW_BAND_ATTR}]`);
  await expect(row).toHaveText('Reviewing suggestions · View only Done');
  const lead = row.getByRole('button', { name: 'View only', exact: true });
  await expect(lead, 'View only is its own control in the Review row').toBeVisible();
  await expect(lead, 'its accessible description says what it means').toHaveAccessibleDescription(explained);
  await lead.hover();
  await expect(carl.page.getByRole('tooltip'), 'Moss\'s tooltip on hover').toContainText(explained);
  await carl.page.mouse.move(0, 0);
  await lead.focus();
  await expect(carl.page.getByRole('tooltip'), 'and on keyboard focus').toContainText(explained);
  await carl.page.keyboard.press('Enter');
  const refusal = ui.pane(carl, docId).locator(`[${INPUT_REFUSAL_ATTR}]`);
  await expect(refusal, 'a press says it in the refusal notice').toHaveText(explained);
  await expect(ui.pane(carl, docId), 'and the note stays in Review').toHaveAttribute(EDIT_MODE_ATTR, 'review');
});

test('j21-composed a refusal stays in the pane\'s one bottom region above the reader\'s row at a short height, in a split pane and beside the outage notice (T9.46) @p:tech-9 @p:ppl-2', async ({ actors }) => {
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const docId = await ui.createNote(ada);
  await ui.typeTitle(ada, docId, 'Read only', { enter: true });
  await ui.typeBody(ada, docId, 'Words to read');
  await ui.waitAcked(ada, docId);
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'viewer');
  const ben = await actors.open(benPrincipal, { viewport: DESKTOP, path: `/d/${docId}`, severable: true });
  await ui.waitOpen(ben, docId, 'readonly');
  await actors.requireDistinct(2);
  const explained = "You can view this note, but you can't edit it.";
  const pane = ui.pane(ben, docId);
  const region = pane.locator(`[${BOTTOM_REGION_ATTR}]`);
  const row = region.locator(`[${ROLE_BAND_ATTR}]`);
  const refusal = pane.locator(`[${INPUT_REFUSAL_ATTR}]`);
  /** One refused key: the card is in the region, above the row, clear of it, and inside the pane. */
  const refusedAbove = async (what: string) => {
    await expect(refusal).toHaveText('', { timeout: 6_000 });
    await ui.body(ben, docId).getByText('Words to read').click({ force: true });
    await ben.page.keyboard.type('x');
    await expect(refusal, `${what}: the key says why`).toHaveText(explained);
    await expect(region.locator(`[${INPUT_REFUSAL_ATTR}]`), `${what}: in the one bottom region`).toHaveCount(1);
    const [card, band, box] = await Promise.all([refusal.boundingBox(), row.boundingBox(), pane.boundingBox()]);
    expect(card!.y + card!.height, `${what}: the card never covers the reader's row`).toBeLessThanOrEqual(band!.y + 0.5);
    expect(card!.y, `${what}: inside the pane`).toBeGreaterThanOrEqual(box!.y);
    expect(card!.x, `${what}: inside the pane`).toBeGreaterThanOrEqual(box!.x - 0.5);
    expect(card!.x + card!.width).toBeLessThanOrEqual(box!.x + box!.width + 0.5);
    return card!;
  };

  await ben.page.setViewportSize({ width: 1440, height: 420 });
  await refusedAbove('a short window');

  // Split: his own note on the left, Ada's on the right.
  await ben.page.setViewportSize(DESKTOP);
  const own = await ui.newNote(ben, { onlyPane: true });
  await ui.waitBodyLive(ben, own);
  ben.expectReconnects(1, docId);
  await ben.page.locator(`[${SIDEBAR_ROW_ATTR}][${DOC_ID_ATTR}="${docId}"]`).click({ button: 'right' });
  await ben.page.getByRole('menuitem', { name: 'Open in Split Tab', exact: true }).click();
  await ui.waitOpen(ben, docId, 'readonly');
  await expect(ui.pane(ben, own)).toBeVisible();
  await refusedAbove('a split pane');

  // The connection is lost: the outage card and the refusal share the region, neither over the row.
  ben.expectReconnects(2, docId);
  ben.expectReconnects(2, own);
  ben.sever!.blackhole();
  const outage = region.locator(`[${CONNECTION_BANNER_ATTR}="offline"]`);
  await expect(outage, 'the outage shows in the region').toBeVisible({ timeout: 25_000 });
  const card = await refusedAbove('beside the outage');
  const [lost, band] = await Promise.all([outage.boundingBox(), row.boundingBox()]);
  expect(lost!.y + lost!.height, 'the outage stands above the row too').toBeLessThanOrEqual(band!.y + 0.5);
  expect(card.y + card.height <= lost!.y + 0.5 || lost!.y + lost!.height <= card.y + 0.5, 'the two cards do not overlap').toBe(true);
  ben.sever!.restore();
});

test('j21-composed a notice whose note is deleted or whose access is removed before it opens stays unread, and its row says why (T9.46) @p:ppl-3', async ({ actors }) => {
  const ada = await actors.open(await actors.principal('ada'), { viewport: DESKTOP });
  const origin = new URL(ada.page.url()).origin;
  const make = async (markdown: string) => {
    const made = await ada.context.request.post('/api/docs', { headers: { origin }, data: { title: markdown.replace(/ word\.$/, ''), markdown } });
    expect(made.status()).toBe(201);
    return ((await made.json()) as { doc: { id: string } }).doc.id;
  };
  const kept = await make('Keep every original word.');
  const trashed = await make('Keep every other word.');
  const cyPrincipal = await actors.principal('cy');
  const benPrincipal = await actors.principal('ben');
  for (const docId of [kept, trashed]) {
    await grantDoc(ada, docId, cyPrincipal, 'editor');
    await grantDoc(ada, docId, benPrincipal, 'suggester');
  }
  const ben = await actors.session(benPrincipal);
  await suggestOne(ben, kept, 'original word');
  await suggestOne(ben, trashed, 'other word');
  const cy = await actors.open(cyPrincipal, { viewport: DESKTOP });
  await actors.requireDistinct(3);
  const page = cy.page;
  const inbox = page.getByRole('menu', { name: 'Notifications' });
  const openInbox = async () => {
    await (await ui.openAppMenu(page)).getByRole('menuitem', { name: 'Notifications', exact: true }).click();
    await expect(inbox).toBeVisible();
  };
  await openInbox();
  await expect(inbox.getByRole('menuitem', { name: /suggested changes in “/ }), 'both notices are listed').toHaveCount(2, { timeout: BIND_TIMEOUT });
  await page.keyboard.press('Escape');

  // Her list stays as she last read it, the moment before each open (a later read would drop them).
  const listed = await (await cy.context.request.get('/api/notifications')).text();
  await page.route(/\/api\/notifications$/, (route) => (route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: listed })
    : route.fallback()));
  for (const docId of [kept, trashed]) {
    cy.expectHttp(404, new RegExp(`/api/docs/${docId}`));
    cy.expectHttp(403, new RegExp(`/api/docs/${docId}`));
  }
  const cyId = ((await (await cy.context.request.get('/api/me')).json()) as { principal: { id: string } }).principal.id;
  const removed = await ada.context.request.delete(`${origin}/api/docs/${kept}/members`, { headers: { origin, 'content-type': 'application/json' }, data: { principalId: cyId } });
  expect(removed.ok(), 'declared setup: Cy loses the note').toBe(true);
  expect((await ada.context.request.delete(`${origin}/api/docs/${trashed}`, { headers: { origin } })).status(), 'declared setup: the other goes to Trash').toBe(200);

  const why = 'This didn’t open. It may have been deleted, or your access changed.';
  for (const title of ['original', 'other']) {
    await openInbox();
    const row = inbox.getByRole('menuitem', { name: new RegExp(`suggested changes in “Keep every ${title}`) });
    await row.click();
    await openInbox();
    await expect(row, `${title}: still unread after the open was tried`).toHaveAccessibleName(/, unread\. /, { timeout: 20_000 });
    await expect(row, `${title}: and says why`).toContainText(why);
    await page.keyboard.press('Escape');
  }
});

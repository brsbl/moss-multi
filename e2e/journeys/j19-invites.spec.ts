// j19-invites (T2.8): invites and the bell. Ada shares a note with Ben while he is typing in his own; his bell shows
// it without a reload, and clicking the notice mid-sentence opens her note in place, with every key he typed kept.
// An invite to an email with no account gives Ada a copyable link that redeems after the guest signs up on the card
// and lands on the note, once. Notices re-checked against a revoked grant are covered over REST (invites.test.ts).
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { APP_STATE_ATTR, BODY_BINDING_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR } from '../lib/contract.ts';
import { expect, test, ui } from '../lib/test.ts';

const LIVE_TIMEOUT = 10_000;
const PUSH_TIMEOUT = 10_000;

/** The bell in the open note's top bar; its name says how many notices are unread. */
const bell = (actor: Actor, docId: string): Locator => ui.pane(actor, docId).getByRole('button', { name: /^Notifications/ });

async function sharedNote(actor: Actor, title: string, text: string): Promise<string> {
  const docId = await ui.createNote(actor);
  await ui.typeTitle(actor, docId, title, { enter: true });
  await ui.typeBody(actor, docId, text);
  await expect(ui.pane(actor, docId), 'the DocDO acks the text').toHaveAttribute(SYNC_UNACKED_ATTR, '0', { timeout: LIVE_TIMEOUT });
  return docId;
}

const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

test('j19 bell: a share reaches Ben\'s bell without a reload, and its notice opens the note mid-sentence with no key lost @p:ppl-3 @evidence', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const benPrincipal = await actors.principal('ben');
  const ada = await actors.open(adaPrincipal);
  const title = `Bell target ${Date.now() % 10_000}`;
  const target = await sharedNote(ada, title, 'Shared through the bell');

  const ben = await actors.open(benPrincipal);
  const own = await ui.createNote(ben);
  await expect(bell(ben, own), 'Ben has nothing unread').toHaveAccessibleName('Notifications');
  // A marker only this document holds: a page load would drop it.
  await ben.page.evaluate(() => { (window as unknown as { j19Document: boolean }).j19Document = true; });

  const dialog = await ui.shareWith(ada, target, benPrincipal, 'Can edit');
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(bell(ben, own), 'the notice is pushed to Ben\'s open tab').toHaveAccessibleName('Notifications, 1 unread', { timeout: PUSH_TIMEOUT });
  await actors.checkpoint('bell-unread');

  // Mid-sentence: the last keys are still in flight when he clicks the notice.
  await ui.typeBody(ben, own, 'Typing right up to the bell');
  await bell(ben, own).click();
  const notice = ben.page.getByRole('menuitem', { name: new RegExp(`shared “${title}” with you`) });
  await expect(notice, 'the inbox lists the share').toBeVisible();
  await actors.checkpoint('bell-open');
  await notice.click();

  await ui.waitLive(ben, target);
  await ben.declareRemount(target);
  expect(await ben.page.evaluate(() => (window as unknown as { j19Document?: boolean }).j19Document), 'the note opened in place, without a page load').toBe(true);
  await expect(ben.page).toHaveURL(new RegExp(`/d/${target}$`));
  await expect(ui.body(ben, target)).toContainText('Shared through the bell');
  await expect(ui.pane(ben, target)).toHaveAttribute(ROLE_ATTR, 'editor');
  await expect(bell(ben, target), 'opening the notice marks it read').toHaveAccessibleName('Notifications');

  await ui.typeBody(ben, target, ' and Ben replies');
  await expect(ui.body(ada, target), 'Ada sees Ben type').toContainText('and Ben replies', { timeout: LIVE_TIMEOUT });

  // Back in his own note, every key typed before the click is there.
  ben.expectReconnects(1, own);
  await ui.openNote(ben, own);
  expect(await ui.fieldText(ben, own, 'body')).toContain('Typing right up to the bell');

  // Opened from the bell, the share is redeemed: Ada sees Ben by name.
  const members = await ui.openShare(ada, target);
  await expect(ui.accessRow(members, benPrincipal), 'opened, Ben is listed by name').toContainText(benPrincipal.email);
  await ada.page.keyboard.press('Escape');
  await expect(bell(ben, own), 'and the read state survives a reload').toHaveAccessibleName('Notifications');
  ben.expectReconnects(1, own);
  await ben.page.reload();
  await ben.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitLive(ben, own);
  await ben.declareRemount(own);
  await expect(bell(ben, own)).toHaveAccessibleName('Notifications');
});

test('j19 invite: an invite to an unknown email gives a copyable link that redeems after sign-up, once @p:ppl-1 @evidence', async ({ actors, stack }) => {
  const adaPrincipal = await actors.principal('ada');
  const ada = await actors.open(adaPrincipal);
  const title = `Invite target ${Date.now() % 10_000}`;
  const target = await sharedNote(ada, title, 'Waiting for a guest');
  const guest = actors.credentials('guest');

  const dialog = await ui.openShare(ada, target);
  await ui.shareInDialog(dialog, guest.email, 'Can comment');
  const row = ui.inviteRow(dialog, guest.email);
  await expect(row).toContainText('Invited');
  const field = row.getByRole('textbox', { name: `Invite link for ${guest.email}`, exact: true });
  await expect(field, 'the pending invite offers its link').toHaveCount(1);
  const url = await field.inputValue();
  expect(url, 'an /invite link carrying its token').toMatch(/\/invite\/[0-9a-f]{48}$/);
  await expect(row.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await actors.checkpoint('invite-link');
  await ada.page.keyboard.press('Escape');

  const visitor = await actors.anonymous(pathOf(url), { label: 'guest' });
  await expect(visitor.page, 'signed out, the link asks for an account').toHaveURL(/\/login\?next=/);
  await ui.waitForLoginCard(visitor);
  await ui.signUpThroughCard(visitor, guest);
  await expect(visitor.page, 'after sign-up the guest lands on the note').toHaveURL(new RegExp(`/d/${target}$`), { timeout: 30_000 });
  const who = await visitor.context.request.get(new URL('/api/me', stack.baseUrl).href);
  guest.id = ((await who.json()) as { principal: { id: string } }).principal.id;
  await expect(ui.pane(visitor, target), 'at the invite\'s role').toHaveAttribute(ROLE_ATTR, 'commenter', { timeout: LIVE_TIMEOUT });
  await expect(ui.body(visitor, target)).toHaveAttribute(BODY_BINDING_ATTR, 'readonly', { timeout: LIVE_TIMEOUT });
  await expect(ui.body(visitor, target)).toContainText('Waiting for a guest');

  await expect(bell(ada, target), 'Ada hears the invite was accepted').toHaveAccessibleName('Notifications, 1 unread', { timeout: PUSH_TIMEOUT });
  await bell(ada, target).click();
  await expect(ada.page.getByRole('menuitem', { name: new RegExp(`accepted your invite to “${title}”`) })).toBeVisible();
  await ada.page.keyboard.press('Escape');
  const members = await ui.openShare(ada, target);
  await expect(ui.accessRow(members, guest), 'the guest is a member by name').toContainText(guest.email);
  await expect(members.getByRole('textbox', { name: `Invite link for ${guest.email}`, exact: true }), 'and the invite is spent').toHaveCount(0);
  await ada.page.keyboard.press('Escape');

  // The link is single-use: anyone else who follows it gets the one denial page.
  const cy = await actors.open(await actors.principal('cy'), { path: pathOf(url) });
  cy.expectHttp(404, /^\/api\/invites\/[0-9a-f]+\/accept$/);
  await expect(cy.page.getByRole('heading', { name: /doesn.t exist or you don.t have access/i })).toBeVisible();
  expect((await cy.context.request.get(`/api/docs/${target}`)).status(), 'and no access').toBe(404);
  cy.expectHttp(404, `/api/docs/${target}`);
});

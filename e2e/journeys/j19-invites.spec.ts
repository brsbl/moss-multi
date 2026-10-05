// j19-invites (T2.8; PRODUCT ruling 19: an email is a label, never an authority). Ada shares a note with Ben by email:
// that is an invite link she sends him, and it opens nothing for his account until he follows it. He follows it while
// Ada is typing in another note; her bell shows "Ben accepted your invite" without a reload, and clicking the notice
// mid-sentence opens the note in place. No key is lost across the click: the keys typed before it are held in flight
// (the server has none of them) and still reach her note after the switch and a reload, and every key typed straight
// on through the switch either lands in a live field or is refused visibly. An invite to an email with no account
// redeems after the guest signs up through it, once; a spent link shows the one closed-invite page to anyone else.
// The oracle and squatter rules (A§8) are proven over REST in invite-oracle.test.ts and invites.test.ts.
import type { Locator } from '@playwright/test';
import type { Actor } from '../lib/actors.ts';
import { openDocClient } from '../lib/doc-client.ts';
import {
  APP_STATE_ATTR, BODY_BINDING_ATTR, DOC_ID_ATTR, EDITOR_PANE_ATTR, INPUT_REFUSAL_ATTR, ROLE_ATTR, SYNC_UNACKED_ATTR, TITLE_BINDING_ATTR,
} from '../lib/contract.ts';
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

/** A key the page received while a note switched: where it went, and whether something refused it. */
interface KeyFate {
  key: string;
  /** The doc whose live title or body was the key's target, or null for a key aimed at nothing editable. */
  landedIn: string | null;
  refused: boolean;
  /** The refusal notice's text just after the key, if one shows. */
  notice: string;
}

/** Records every printable keydown from now on, ahead of the page's own window listeners. */
async function recordKeys(actor: Actor): Promise<void> {
  await actor.page.evaluate(({ pane, docId, live, refusal }) => {
    const fates: KeyFate[] = [];
    (window as unknown as { j19Keys: KeyFate[] }).j19Keys = fates;
    window.addEventListener('keydown', (event) => {
      if (event.key.length !== 1) return;
      const target = event.target instanceof Element ? event.target : null;
      const field = target?.closest(live) ?? null;
      const fate: KeyFate = { key: event.key, landedIn: field?.closest(`[${pane}]`)?.getAttribute(docId) ?? null, refused: false, notice: '' };
      fates.push(fate);
      setTimeout(() => {
        fate.refused = event.defaultPrevented && fate.landedIn === null;
        fate.notice = document.querySelector(`[${refusal}]`)?.textContent ?? '';
      }, 0);
    }, { capture: true });
  }, {
    pane: EDITOR_PANE_ATTR,
    docId: DOC_ID_ATTR,
    live: `[${BODY_BINDING_ATTR}="live"], [${TITLE_BINDING_ATTR}="live"]`,
    refusal: INPUT_REFUSAL_ATTR,
  });
}

const keyFates = (actor: Actor): Promise<KeyFate[]> => actor.page.evaluate(() => (window as unknown as { j19Keys: KeyFate[] }).j19Keys);

test('j19 bell: an accepted invite reaches Ada\'s bell without a reload, and its notice opens the note mid-sentence with no key lost @p:ppl-3 @evidence', async ({ actors }) => {
  const adaPrincipal = await actors.principal('ada');
  const benPrincipal = await actors.principal('ben');
  // Ada's doc sockets run through a proxy that can hold her keys in flight.
  const ada = await actors.open(adaPrincipal, { severable: true });
  const title = `Bell target ${Date.now() % 10_000}`;
  const target = await sharedNote(ada, title, 'Shared through the bell');
  const dialog = await ui.shareWith(ada, target, benPrincipal, 'Can edit');
  const invite = await ui.inviteLink(dialog, benPrincipal.email);
  await ada.page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // The share is an invite, not a grant to the account with that email: Ben's account has nothing until he follows it.
  const ben = await actors.open(benPrincipal);
  const before = await ben.context.request.get(`/api/docs/${target}`);
  expect(before.status(), 'the email alone opens nothing').toBe(404);
  expect(await before.text()).toBe(await (await ben.context.request.get(`/api/docs/${crypto.randomUUID()}`)).text());

  // Ada moves on to a note of her own; a marker only this document holds would vanish on a page load.
  const own = await ui.createNote(ada);
  await expect(bell(ada, own), 'Ada has nothing unread').toHaveAccessibleName('Notifications');
  await ada.page.evaluate(() => { (window as unknown as { j19Document: boolean }).j19Document = true; });

  // Ben follows the link Ada sent him and lands on the note.
  await ben.goto(pathOf(invite));
  await expect(ben.page, 'the invite leads to the note').toHaveURL(new RegExp(`/d/${target}$`), { timeout: 30_000 });
  await ui.waitLive(ben, target);
  await expect(ui.pane(ben, target), 'at the invite\'s role').toHaveAttribute(ROLE_ATTR, 'editor');

  await expect(bell(ada, own), 'the notice is pushed to Ada\'s open tab').toHaveAccessibleName('Notifications, 1 unread', { timeout: PUSH_TIMEOUT });
  await actors.checkpoint('bell-unread');
  await bell(ada, own).click();
  const notice = ada.page.getByRole('menuitem', { name: new RegExp(`accepted your invite to “${title}”`) });
  await expect(notice, 'the inbox lists the acceptance').toBeVisible();
  await actors.checkpoint('bell-open');
  await ada.page.keyboard.press('Escape');
  await expect(notice).toBeHidden();

  // Mid-sentence: the server has none of the first half when Ada clicks the notice, and she types the rest straight on.
  const firstHalf = 'Typing right up to the bell';
  const rest = 'and straight on';
  ada.sever!.hold(own);
  await ui.typeBody(ada, own, firstHalf);
  await expect(ui.pane(ada, own), 'the keys are still in flight at the click').toHaveAttribute(SYNC_UNACKED_ATTR, '1');
  await bell(ada, own).click();
  await expect(notice).toBeVisible();
  await recordKeys(ada);
  ada.expectReconnects(1, target); // Returning to the shared note opens its session again.
  await notice.click();
  await ada.page.keyboard.type(rest);

  await ui.waitLive(ada, target);
  await ada.declareRemount(target);
  expect(await ada.page.evaluate(() => (window as unknown as { j19Document?: boolean }).j19Document), 'the note opened in place, without a page load').toBe(true);
  await expect(ada.page).toHaveURL(new RegExp(`/d/${target}$`));

  // Every key typed through the switch landed in a live field or was refused with a visible notice; none vanished.
  await expect.poll(async () => (await keyFates(ada)).length, { message: 'every key reached the page' }).toBe(rest.length);
  const fates = await keyFates(ada);
  expect(fates.filter((fate) => fate.landedIn === null && !fate.refused).map((fate) => fate.key), 'no key aimed at nothing went unrefused').toEqual([]);
  for (const fate of fates.filter((f) => f.refused)) expect(fate.notice, `"${fate.key}" was refused visibly`).toMatch(/Opening/);
  expect(fates.filter((fate) => fate.landedIn === own).map((f) => f.key), 'nothing typed after the click lands in the note she left').toEqual([]);
  const landed = fates.filter((fate) => fate.landedIn === target).map((fate) => fate.key).join('');
  if (landed.trim()) await expect(ui.body(ada, target), 'what landed in the opened note is there').toContainText(landed.trim());

  // The note Ada left still holds the first half after the switch, and delivers it once the network lets it through.
  const cookie = (await ada.context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
  const server = await openDocClient(new URL(ada.page.url()).origin, own, cookie);
  try {
    await server.synced;
    expect(ada.sever!.census().held, 'the keys are held in flight').toBeGreaterThan(0);
    expect(server.text(), 'the server has not seen them yet').not.toContain(firstHalf);
    ada.sever!.deliverHeld();
    await expect.poll(() => server.text(), { timeout: LIVE_TIMEOUT, message: 'every key typed before the click reaches the server' }).toContain(firstHalf);
  } finally {
    server.close();
  }

  await expect(ui.body(ada, target)).toContainText('Shared through the bell');
  await expect(bell(ada, target), 'opening the notice marks it read').toHaveAccessibleName('Notifications');
  await ui.typeBody(ben, target, ' and Ben replies');
  await expect(ui.body(ada, target), 'Ada sees Ben type').toContainText('and Ben replies', { timeout: LIVE_TIMEOUT });

  // Redeemed, Ben is a member by name.
  const members = await ui.openShare(ada, target);
  await expect(ui.accessRow(members, benPrincipal), 'redeemed, Ben is listed by name').toContainText(benPrincipal.email);
  await ada.page.keyboard.press('Escape');

  // Back in her own note, every key typed before the click is there, and it and the read state survive a reload.
  ada.expectReconnects(1, own);
  await ui.openNote(ada, own);
  expect(await ui.fieldText(ada, own, 'body')).toContain(firstHalf);
  ada.expectReconnects(1, own);
  await ada.page.reload();
  await ada.page.locator(`html[${APP_STATE_ATTR}="ready"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await ui.waitLive(ada, own);
  await ada.declareRemount(own);
  await expect(bell(ada, own)).toHaveAccessibleName('Notifications');
  expect(await ui.fieldText(ada, own, 'body'), 'and the sentence survives the reload').toContain(firstHalf);
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
  const url = await ui.inviteLink(dialog, guest.email);
  await expect(row.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  // The link is a bearer capability (PRODUCT ruling 19), and the dialog says so rather than promising an email check.
  await expect(dialog.getByText(/first person who opens it signed in gets its access/), 'the owner is told who the link admits').toBeVisible();
  await expect(dialog, 'and never that the email restricts it').not.toContainText(/whoever signs in with that email/);
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

  // The link is spent: anyone else who follows it gets the one closed-invite page.
  const cy = await actors.open(await actors.principal('cy'), { path: pathOf(url) });
  cy.expectHttp(404, /^\/api\/invites\/[0-9a-f]+\/accept$/);
  await expect(cy.page.getByRole('heading', { name: /already been used or is no longer open/i })).toBeVisible();
  expect((await cy.context.request.get(`/api/docs/${target}`)).status(), 'and no access').toBe(404);
  cy.expectHttp(404, `/api/docs/${target}`);
});

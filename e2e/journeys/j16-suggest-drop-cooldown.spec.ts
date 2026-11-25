// j16-suggest-drop, the cooldown's net: a real cooldown with a suggestion in flight says so, ends by itself and
// delivers it, whether the refused frames went out on the window's own socket or on another of the person's; and text
// offered back after a closed suggestion holds the leave-site guard until dismissed. The probe is
// e2e/lib/suggest-drop.ts.
import {
  DOC_SOCKET_PATH, SUGGEST_UNSAVED_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '../lib/contract.ts';
import { CUSTOM_PREFIX } from '../../packages/protocol/src/sync.ts';
import { PROTOCOL_QUERY } from '../lib/doc-client.ts';
import { BIND_TIMEOUT, confirmClose, content } from '../lib/suggest.ts';
import {
  begin, caretEnd, draftLines, firstLine, freshPage, KEY_DELAY, pause, START, until, type Probe,
} from '../lib/suggest-drop.ts';
import { expect, test, ui } from '../lib/test.ts';
import { occurrences } from '../lib/text.ts';

/** The cooldown notice. */
const PAUSED = 'Suggesting is paused for about a minute. What you typed is kept in this window, so don’t reload.';

/** A suggest frame the DocDO refuses: a withdraw of a record that does not exist. */
const forged = (i: number) => `${CUSTOM_PREFIX}${JSON.stringify({ t: 'suggest-withdraw', record: `unknown-${i}` })}`;

/**
 * `count` refused frames on another socket of the person's (a client that ignores its binding), so the window's own
 * fork never hears their replies.
 */
async function refusedElsewhere(probe: Probe, count: number): Promise<void> {
  const fresh = await freshPage(probe);
  try {
    await fresh.page.goto(`${new URL(probe.ben.page.url()).origin}/api/version`);
    // The protocol query, as the app sends it: a socket without it is refused as outdated.
    await fresh.page.evaluate(async ({ path, query, frames }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${path}?${query}&_pk=${crypto.randomUUID()}`);
      await new Promise((done, fail) => {
        socket.addEventListener('open', done, { once: true });
        socket.addEventListener('error', fail, { once: true });
      });
      // Past the DocDO's admission check, which holds a new socket's frames until it passes.
      await new Promise((done) => setTimeout(done, 1_500));
      for (const frame of frames) socket.send(frame);
      await new Promise((done) => setTimeout(done, 1_000));
    }, { path: `${DOC_SOCKET_PATH}${probe.docId}`, query: PROTOCOL_QUERY, frames: Array.from({ length: count }, (_, i) => forged(i)) });
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

// `cooldown`: the three frames go out on the window's own socket, and their replies reach its
// fork ahead of the reply to what it has in flight. `cooldown-elsewhere` sends them on another socket of the person's.
for (const via of ['own', 'elsewhere'] as const) test(`j16-suggest-drop ${via === 'own' ? 'cooldown' : 'cooldown-elsewhere'} suggester: a real cooldown with a suggestion in flight, the refused frames on ${via === 'own' ? "the window's own socket" : 'another socket of the person'}, says so, ends by itself and delivers it with no click @slow`, async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, via === 'own' ? 'cooldown' : 'cooldown-elsewhere', 'suggester');
  await probe.run(async () => {
    const { ada, ben, docId, sever } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    sever.hold(docId);
    await probe.type(ben, 'Hh1');
    await pause(400);
    // Three frames the DocDO refuses, as a forging client sends them: the third starts the cooldown.
    if (via === 'own') for (let i = 0; i < 3; i += 1) sever.inject(forged(i));
    else await refusedElsewhere(probe, 3);
    const closed = await probe.cooldownWithin(10_000);
    expect(closed, 'the forged frames start the cooldown').not.toBeNull();
    // What was held is lost with the socket: Hh1 is owed by the window alone.
    sever.dropHeld();
    const shown = await until(() => probe.pane(ben), (pane) => pane.terminal === 'suggest-cooldown' && pane.banners.length > 0, 10_000, 100);
    const retry = await ui.pane(ben, docId).getByRole('button', { name: 'Retry', exact: true }).count();
    const offered = await ben.page.locator(`[${SUGGEST_UNSAVED_ATTR}]`).count();
    probe.note('cooled down: what the window shows', { ...(await probe.brief(ben)), retry, offered });
    expect.soft(shown.value.terminal, 'the pane reads the cooldown, not the connection limit').toBe('suggest-cooldown');
    expect.soft(shown.value.banners.join(' '), 'the notice says suggesting is paused and the text is kept').toContain(PAUSED);
    expect.soft(retry, 'no Retry while the window reconnects by itself').toBe(0);
    expect.soft(offered, 'nothing is offered back: the window still owes Hh1').toBe(0);
    expect.soft(draftLines(shown.value.lines), 'the text stays on screen').toEqual([`${START.one} Aa1 Hh1`, START.two, START.three]);
    const before = (await probe.pane(ben)).lines.join('\n');
    await ben.page.keyboard.type('Q', { delay: KEY_DELAY }).catch(() => undefined);
    await pause(300);
    expect.soft((await probe.pane(ben)).lines.join('\n'), 'a key changes nothing').toBe(before);
    expect.soft(occurrences(await content(ada, docId, 'working'), 'Hh1'), 'Hh1 is not on the server during the cooldown').toBe(0);
    const opens = () => sever.log().filter((event) => event.kind === 'open' && event.at > closed!.at);
    await pause(Math.max(0, closed!.at + 55_000 - Date.now()));
    expect.soft(opens().length, 'nothing reconnects inside the cooldown').toBe(0);
    const reopened = await until(opens, (list) => list.length > 0, closed!.at + 75_000 - Date.now(), 250);
    probe.note('after the cooldown', { reopenedAfterMs: reopened.value[0] ? reopened.value[0].at - closed!.at : null, ...(await probe.brief(ben)) });
    expect.soft(reopened.ok, 'a socket opens by itself after the 60 s').toBe(true);
    const landed = await until(() => content(ada, docId, 'working'), (text) => occurrences(text, 'Hh1') === 1, 20_000, 500);
    expect.soft(landed.ok, 'Hh1 is on the server once, with no click').toBe(true);
    const live = await until(() => probe.pane(ben), (pane) => pane.terminal === null && pane.binding === 'live' && pane.unacked === '0', BIND_TIMEOUT, 250);
    expect.soft(live.ok, 'the window is live again').toBe(true);
    await probe.reload(ben);
    await probe.reloadOwner();
    const working = await content(ada, docId, 'working');
    for (const token of ['Aa1', 'Hh1']) expect.soft(occurrences(working, token), `"${token}" is in the working export once after a reload`).toBe(1);
    expect.soft(draftLines((await probe.pane(ben)).lines), "the person's window after a reload").toEqual([`${START.one} Aa1 Hh1`, START.two, START.three]);
  });
});

test('j16-suggest-drop halted-card suggester: text offered back after the owner rejects the suggestion it was typed into holds the leave-site guard until dismissed @slow', async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'halted-card', 'suggester');
  await probe.run(async () => {
    const { ada, ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1', 'one', { counted: false });
    await probe.settle(ben, 'Aa1');
    // He types while down; meanwhile the owner rejects the suggestion from the Suggestions panel.
    probe.cut();
    await probe.type(ben, 'Dd4', 'one', { counted: false });
    await pause(300);
    const panel = ada.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
    if (!(await panel.isVisible())) await ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`).first().click();
    const open = panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`).first();
    await expect(open).toContainText('Aa1', { timeout: BIND_TIMEOUT });
    await confirmClose(ada, open, 'Reject');
    await expect(panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="rejected"]`)).toHaveCount(1, { timeout: BIND_TIMEOUT });
    await ada.page.keyboard.press('Escape');
    probe.note('the owner rejected the suggestion');
    probe.up();
    const card = ben.page.locator(`[${SUGGEST_UNSAVED_ATTR}]`).first();
    await expect(card, 'the text typed while down is offered back').toBeVisible({ timeout: 25_000 });
    probe.note('the card', { says: (await card.innerText()).replace(/\s+/g, ' ').slice(0, 260), ...(await probe.brief(ben)) });
    // A reload while the card is up asks first; staying keeps the card.
    probe.dismissDialogs = true;
    const asked = probe.dialogs.length;
    await ben.page.reload({ timeout: 5_000 }).catch((error: unknown) => probe.note('the reload did not complete', firstLine(error)));
    await pause(500);
    probe.note('after a reload with the card up', { dialogs: probe.dialogs.slice(asked).map((dialog) => dialog.type), card: await card.isVisible().catch(() => false) });
    expect.soft(probe.dialogs.length - asked, 'a reload with the card up raises the leave-site dialog').toBe(1);
    expect.soft(await card.isVisible().catch(() => false), 'staying on the page keeps the card').toBe(true);
    // Once dismissed, nothing holds the page.
    if (await card.isVisible().catch(() => false)) {
      await card.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await expect(card).toBeHidden();
      const after = probe.dialogs.length;
      await ben.page.reload();
      await probe.attempt('Suggest again after the reload', () => probe.enterSuggest(ben, { load: false }));
      expect.soft(probe.dialogs.length - after, 'no leave-site dialog after Dismiss').toBe(0);
    }
  });
});

test('j16-suggest-drop halted-card-sign-out suggester: "Sign out anyway" with offered-back text up signs out with no second prompt from the browser; Cancel keeps the card @slow', async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'halted-card-sign-out', 'suggester');
  await probe.run(async () => {
    const { ada, ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1', 'one', { counted: false });
    await probe.settle(ben, 'Aa1');
    probe.cut();
    await probe.type(ben, 'Dd4', 'one', { counted: false });
    await pause(300);
    const panel = ada.page.locator(`[${SUGGESTIONS_PANEL_ATTR}]`);
    if (!(await panel.isVisible())) await ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`).first().click();
    const open = panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="open"]`).first();
    await expect(open).toContainText('Aa1', { timeout: BIND_TIMEOUT });
    await confirmClose(ada, open, 'Reject');
    await expect(panel.locator(`[${SUGGESTION_CARD_ATTR}][${SUGGESTION_STATUS_ATTR}="rejected"]`)).toHaveCount(1, { timeout: BIND_TIMEOUT });
    await ada.page.keyboard.press('Escape');
    probe.up();
    const card = ben.page.locator(`[${SUGGEST_UNSAVED_ATTR}]`).first();
    await expect(card, 'the text typed while down is offered back').toBeVisible({ timeout: 25_000 });
    // A browser prompt would be dismissed, so the page would stay where it is.
    probe.dismissDialogs = true;
    const confirmation = ben.page.getByRole('alertdialog');
    await ui.signOutThroughSettings(ben);
    await expect(confirmation, 'sign-out asks before discarding the offered text').toBeVisible({ timeout: 8_000 });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ben.page.keyboard.press('Escape');
    expect.soft(await card.isVisible(), 'Cancel keeps the card').toBe(true);
    const asked = probe.dialogs.length;
    await ui.signOutThroughSettings(ben);
    await expect(confirmation).toBeVisible({ timeout: 8_000 });
    await confirmation.getByRole('button', { name: 'Sign out anyway', exact: true }).click();
    const left = await until(() => new URL(ben.page.url()).pathname, (path) => path === '/login', 15_000, 250);
    probe.note('after "Sign out anyway"', { path: left.value, dialogs: probe.dialogs.slice(asked).map((dialog) => dialog.type) });
    expect.soft(probe.dialogs.length - asked, 'the browser does not ask a second time').toBe(0);
    expect.soft(left.ok, 'the sign-out lands on the login page').toBe(true);
    if (left.ok) await ui.waitForLoginCard(ben);
  });
});

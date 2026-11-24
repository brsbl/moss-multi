// j16-suggest-drop, other windows after a drop and the cooldown's net: a fresh page of the person's session opens the
// note after an idle or a typed reconnect; a stalled socket's frames arrive after its replacement resumed; a real
// cooldown with a suggestion in flight ends by itself and delivers it; and text offered back after a closed suggestion
// holds the leave-site guard until dismissed. The probe is e2e/lib/suggest-drop.ts.
import type { Page } from '@playwright/test';
import {
  DOC_SOCKET_PATH, SUGGEST_UNSAVED_ATTR, SUGGESTION_CARD_ATTR, SUGGESTION_STATUS_ATTR, SUGGESTIONS_BUTTON_ATTR, SUGGESTIONS_PANEL_ATTR,
} from '../lib/contract.ts';
import { CUSTOM_PREFIX } from '../../packages/protocol/src/sync.ts';
import { suggestFrame } from '../lib/sever.ts';
import { BIND_TIMEOUT, content } from '../lib/suggest.ts';
import {
  begin, caretEnd, draftLines, firstLine, KEY_DELAY, pause, paneOf, START, until, type Probe,
} from '../lib/suggest-drop.ts';
import { expect, test, ui } from '../lib/test.ts';
import { occurrences } from '../lib/text.ts';

/** The cooldown notice (the coordinator's wording). */
const PAUSED = 'Suggesting is paused for about a minute. What you typed is kept in this window, so don’t reload.';

/**
 * A fresh page of the person's own session, as a second tab or a fresh-load comparison is: the same cookies in a
 * context of its own, so the first window's socket census stays its own. Records its suggest refusals.
 */
async function freshPage(probe: Probe): Promise<{ page: Page; refused: string[]; close: () => Promise<void> }> {
  const browser = probe.ben.context.browser();
  if (!browser) throw new Error('no browser for a fresh page');
  const context = await browser.newContext();
  await context.addCookies(await probe.ben.context.cookies());
  const page = await context.newPage();
  probe.listen(page, 'ben-fresh');
  const refused: string[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (data) => {
      const frame = suggestFrame(data.payload);
      if (frame?.t === 'suggest-refused') refused.push(String(frame.reason));
    });
  });
  return { page, refused, close: () => context.close() };
}

/**
 * `count` suggest frames the DocDO refuses, sent on another socket of the person's (a client that ignores its binding),
 * so the window's own fork never hears their replies.
 */
async function refusedElsewhere(probe: Probe, count: number): Promise<void> {
  const fresh = await freshPage(probe);
  try {
    await fresh.page.goto(`${new URL(probe.ben.page.url()).origin}/api/version`);
    await fresh.page.evaluate(async ({ path, count, prefix }) => {
      const socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}${path}?_pk=${crypto.randomUUID()}`);
      await new Promise((done, fail) => {
        socket.addEventListener('open', done, { once: true });
        socket.addEventListener('error', fail, { once: true });
      });
      // Past the DocDO's admission check, which holds a new socket's frames until it passes.
      await new Promise((done) => setTimeout(done, 1_500));
      for (let i = 0; i < count; i += 1) socket.send(`${prefix}${JSON.stringify({ t: 'suggest-withdraw', record: `unknown-${i}` })}`);
      await new Promise((done) => setTimeout(done, 1_000));
    }, { path: `${DOC_SOCKET_PATH}${probe.docId}`, count, prefix: CUSTOM_PREFIX });
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

/**
 * The fresh page loads the note: it must show it live in Suggest within 15 s with nothing refused, and the first
 * window's sockets must stay open.
 */
async function freshLoad(probe: Probe): Promise<void> {
  const { docId } = probe;
  const since = Date.now();
  const fresh = await freshPage(probe);
  try {
    await fresh.page.goto(`${new URL(probe.ben.page.url()).origin}/d/${docId}`).catch((error: unknown) => probe.note('the fresh page failed to load', firstLine(error)));
    const live = await until(() => paneOf(fresh.page, docId), (shown) => shown.mode === 'suggest' && shown.binding === 'live', 15_000, 250);
    const locked = await probe.cooldownWithin(1_000);
    const closed = probe.sever.log().filter((event) => event.kind === 'close' && event.side === 'server' && event.at >= since);
    probe.note('the fresh page', { live: live.ok, afterMs: live.ms, mode: live.value.mode, binding: live.value.binding, banners: live.value.banners, lines: draftLines(live.value.lines), refused: fresh.refused, closed });
    expect.soft(live.ok, 'the fresh page shows the note live in Suggest inside 15 s').toBe(true);
    expect.soft(fresh.refused, 'the DocDO refused the fresh page nothing').toEqual([]);
    expect.soft(locked, 'no 4429').toBeNull();
    expect.soft(closed, "the first window's socket never closes").toEqual([]);
  } finally {
    await fresh.close().catch(() => undefined);
  }
}

for (const drop of ['unseen', 'seen'] as const) test(`j16-suggest-drop fresh-page suggester ${drop}: idle across a cut, then a fresh page of the same session loads the note for 15 s`, async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'fresh-page', 'suggester', drop);
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    const cutAt = probe.cut();
    await pause(1_000);
    probe.up();
    const resumed = await probe.resumed(cutAt);
    expect.soft(resumed?.reply.leases?.length, "the first window's resume reply carries its 2 leases").toBe(2);
    await probe.settle(ben, 'the idle window, reconnected');
    await freshLoad(probe);
    if (!probe.cooled()) {
      await caretEnd(ben, docId, START.one);
      await probe.type(ben, 'Ee5');
      await probe.checkpoint('K1 no lockout');
    } else {
      await probe.checkpoint('locked out, nothing typed', { waitMs: 0, review: false });
      await probe.lockout();
      await probe.attempt('typing after the Retry', async () => {
        await caretEnd(ben, docId, START.one);
        await probe.type(ben, 'Rr6');
      });
      await probe.checkpoint('K2 after the lockout');
    }
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

// The staging shape with typing: a fresh page after typing and two cuts, and after typing, a move to another paragraph
// and one cut.
for (const shape of ['cuts', 'move'] as const) test(`j16-suggest-drop fresh-after-${shape} suggester unseen: typed, ${shape === 'cuts' ? 'two cuts' : 'a move to another paragraph and one cut'}, then a fresh page of the same session loads the note`, async ({ actors }, testInfo) => {
  test.setTimeout(240_000);
  const probe = await begin(actors, testInfo, `fresh-after-${shape}`, 'suggester');
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    if (shape === 'move') {
      await caretEnd(ben, docId, START.three);
      await probe.type(ben, 'Bb2', 'three');
      await probe.settle(ben, 'Bb2');
    }
    for (let cut = 0; cut < (shape === 'cuts' ? 2 : 1); cut += 1) {
      const cutAt = probe.cut();
      await pause(1_000);
      probe.up();
      await probe.resumed(cutAt);
      await probe.settle(ben, `reconnected after cut ${cut + 1}`);
    }
    await freshLoad(probe);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Ee5');
    await probe.checkpoint('K1 after the fresh page');
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

test('j16-suggest-drop late-frames suggester: frames of a stalled socket reach the DocDO after the replacement socket resumed', async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'late-frames', 'suggester');
  await probe.run(async () => {
    const { ben, docId, sever } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    // The connection stalls while he types: four frames leave the page and wait on the wire.
    sever.hold(docId);
    await probe.type(ben, 'Kk4');
    await pause(400);
    probe.note('Kk4 sent, held on the stalled socket', { held: sever.census().held });
    // The page gives the socket up and opens another; the DocDO still holds the old one open.
    const orphanedAt = Date.now();
    sever.orphan();
    probe.note('the page dropped the stalled socket; the DocDO still holds it');
    await probe.resumed(orphanedAt);
    await probe.settle(ben, 'the replacement socket replayed Kk4');
    await probe.checkpoint('K1 on the replacement socket, before the late frames');
    // He types on; the stalled socket's frames arrive now.
    sever.hold(docId);
    await probe.type(ben, 'Ll5');
    await pause(400);
    probe.note('the late frames are delivered', { frames: sever.deliverOrphaned() });
    const locked = await probe.cooldownWithin(10_000);
    if (!locked) {
      sever.closeOrphaned();
      sever.deliverHeld();
      await probe.checkpoint('K1 no lockout');
    } else {
      await probe.checkpoint('locked out, Ll5 in flight', { waitMs: 0, review: false });
      sever.closeOrphaned();
      await probe.lockout();
      await probe.attempt('typing after the Retry', async () => {
        if (!(await probe.pane(ben)).focused) await caretEnd(ben, docId, START.one);
        await probe.type(ben, 'Rr6');
      });
      await probe.checkpoint('K2 after the lockout');
    }
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

test('j16-suggest-drop cooldown suggester: a real cooldown with a suggestion in flight says so, ends by itself and delivers it with no click @slow', async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'cooldown', 'suggester');
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
    // Three frames the DocDO refuses, from a forging client on another socket of the person's: the third starts it.
    await refusedElsewhere(probe, 3);
    const closed = await probe.cooldownWithin(10_000);
    expect(closed, 'the forged frames start the cooldown').not.toBeNull();
    // What was held is lost with the socket: Hh1 is owed by the window alone.
    sever.dropHeld();
    const shown = await until(() => probe.pane(ben), (pane) => pane.terminal === 'suggest-cooldown' && pane.banners.length > 0, 10_000, 100);
    const retry = await ui.pane(ben, docId).getByRole('button', { name: 'Retry', exact: true }).count();
    probe.note('cooled down: what the window shows', { ...(await probe.brief(ben)), retry });
    expect.soft(shown.value.terminal, "the pane reads the cooldown, not the connection limit").toBe('suggest-cooldown');
    expect.soft(shown.value.banners.join(' '), 'the notice says suggesting is paused and the text is kept').toContain(PAUSED);
    expect.soft(retry, 'no Retry while the window reconnects by itself').toBe(0);
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
    await open.getByRole('button', { name: 'Reject' }).click();
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

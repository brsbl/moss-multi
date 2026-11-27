// j16-suggest-drop, more than one window of the person: a second Suggest window open before the cut, opened after an
// idle or a typed cut while a suggestion is in flight, and a third idle Suggest window. Nothing honest is refused, and
// the window the person's others leave no room for shows the note read-only and says why, also while it holds text a
// closed suggestion could not keep (T9.56). The probe is e2e/lib/suggest-drop.ts.
// journey-legs: 12 (the shard budget counts them; scripts/ci/journeys.mjs)
import { BODY_BINDING_ATTR, CONNECTION_BANNER_ATTR, SUGGEST_UNSAVED_ATTR } from '../lib/contract.ts';
import { BIND_TIMEOUT } from '../lib/suggest.ts';
import { begin, caretEnd, draftLines, pause, ROLES, START, typeAcrossCut, until } from '../lib/suggest-drop.ts';
import { expect, test, ui } from '../lib/test.ts';

/** What the window the person's other Suggest windows leave no room for says. */
const BUSY = 'This note is open for suggesting in other windows. Close one to suggest here.';

for (const role of ROLES) {
  for (const drop of ['unseen', 'seen'] as const) test(`j16-suggest-drop tab-before ${role} ${drop}: a second Suggest window open before the cut`, async ({ actors }, testInfo) => {
    test.setTimeout(240_000);
    const probe = await begin(actors, testInfo, 'tab-before', role, drop);
    await probe.run(async () => {
      const { ben, docId } = probe;
      await probe.enterSuggest(ben);
      const ben2 = await probe.second('ben-2');
      await probe.enterSuggest(ben2);
      const cutAt = await typeAcrossCut(probe);
      probe.up();
      await probe.resumed(cutAt);
      await probe.type(ben, 'Ee5');
      await probe.checkpoint('K1 after the reconnect');
      // A new group two blocks away asks for a spare lease; then the idle window types.
      await caretEnd(ben, docId, START.three);
      await probe.type(ben, 'Hh8', 'three');
      await probe.settle(ben, 'Hh8');
      await probe.attempt('the second window types', async () => {
        await caretEnd(ben2, docId, START.two);
        await probe.type(ben2, 'Ii9', 'two');
        await probe.settle(ben2, 'Ii9');
      });
      await probe.checkpoint('K1 after both windows typed');
      await probe.cooldownWithin(3_000);
      if (probe.lockedOutAt !== null) {
        await probe.lockout();
        await probe.checkpoint('K2 after the lockout');
      }
      await probe.reload(ben);
      await probe.reloadOwner();
      await probe.checkpoint('K3 after a reload');
    });
  });

  // A second window after a seen drop is the fresh-page leg.
  test(`j16-suggest-drop tab-after-idle ${role} unseen: idle in Suggest across a cut, then a second window opens while a suggestion is in flight`, async ({ actors }, testInfo) => {
    test.setTimeout(300_000);
    const probe = await begin(actors, testInfo, 'tab-after-idle', role, 'unseen');
    await probe.run(async () => {
      const { ben, docId, sever } = probe;
      await probe.enterSuggest(ben);
      const cutAt = probe.cut();
      await pause(1_000);
      probe.up();
      await probe.resumed(cutAt);
      await probe.settle(ben, 'the idle window, reconnected');
      const ben2 = await probe.second('ben-2');
      if (role === 'editor') await probe.attempt('the second window opens in Edit', () => probe.openEdit(ben2));
      sever.hold(docId);
      await caretEnd(ben, docId, START.one);
      await probe.type(ben, 'Zz9');
      const locked = await probe.secondAsks(ben2, 10_000);
      if (!locked) {
        sever.deliverHeld();
        await probe.checkpoint('K1 no lockout');
      } else {
        await probe.checkpoint('locked out, Zz9 in flight', { waitMs: 0, review: false });
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

  for (const drop of ['unseen', 'seen'] as const) test(`j16-suggest-drop tab-after-typed ${role} ${drop}: typed in Suggest before the cut, then a second window opens while a suggestion is in flight`, async ({ actors }, testInfo) => {
    test.setTimeout(300_000);
    const probe = await begin(actors, testInfo, 'tab-after-typed', role, drop);
    await probe.run(async () => {
      const { ben, docId, sever } = probe;
      await probe.enterSuggest(ben);
      await caretEnd(ben, docId, START.one);
      await probe.type(ben, 'Aa1');
      await probe.settle(ben, 'Aa1');
      probe.note('the owner', { mode: await probe.ownerReview() });
      const cutAt = probe.cut();
      await pause(1_000);
      probe.up();
      await probe.resumed(cutAt);
      await probe.settle(ben, 'reconnected');
      const ben2 = await probe.second('ben-2');
      if (role === 'editor') await probe.attempt('the second window opens in Edit', () => probe.openEdit(ben2));
      sever.hold(docId);
      await probe.type(ben, 'Zz9');
      const locked = await probe.secondAsks(ben2, 10_000);
      if (!locked) {
        sever.deliverHeld();
        await probe.checkpoint('K1 no lockout');
      } else {
        await probe.checkpoint('locked out, Zz9 in flight', { waitMs: 0, review: false });
        await probe.lockout();
        await probe.checkpoint('K2 after the lockout');
      }
      await probe.reload(ben);
      await probe.reloadOwner();
      await probe.checkpoint('K3 after a reload');
    });
  });
}

test('j16-suggest-drop three-tabs suggester: three idle Suggest windows of one person with no cut: the third shows the note read-only and says why, and suggests once another is closed', async ({ actors }, testInfo) => {
  test.setTimeout(180_000);
  const probe = await begin(actors, testInfo, 'three-tabs', 'suggester');
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    const ben2 = await probe.second('ben-2');
    await probe.enterSuggest(ben2);
    const ben3 = await probe.second('ben-3');
    await probe.attempt('the third window opens the note', () => ben3.goto(`/d/${docId}`));
    const third = await until(() => probe.pane(ben3), (shown) => shown.binding === 'readonly' && shown.banners.some((banner) => banner.startsWith('suggest-busy:')), 15_000, 250);
    await probe.cooldownWithin(3_000);
    for (const actor of [ben, ben2, ben3]) probe.note('window', { ...(await probe.brief(actor)), sockets: probe.closesOf(actor) });
    expect.soft(probe.lockedOutAt, 'no 4429').toBeNull();
    for (const actor of [ben, ben2]) expect.soft((await probe.pane(actor)).binding, `${actor.label} stays live in Suggest`).toBe('live');
    expect.soft(third.value.binding, 'the third window shows the note read-only').toBe('readonly');
    expect.soft(draftLines(third.value.lines), "the third window shows the note's text").toEqual([START.one, START.two, START.three]);
    expect.soft(third.value.banners.join(' '), 'and says why').toContain(BUSY);
    expect.soft(probe.refusals().length, 'at most one refusal').toBeLessThanOrEqual(1);
    // As the notice says: with another window closed, Retry suggests here.
    await ben2.page.close();
    await ui.pane(ben3, docId).locator(`[${CONNECTION_BANNER_ATTR}="suggest-busy"]`).getByRole('button', { name: 'Retry', exact: true }).click();
    const live = await until(() => probe.pane(ben3), (shown) => shown.mode === 'suggest' && shown.binding === 'live', 15_000, 250);
    probe.note('the third window after another closed and Retry', await probe.brief(ben3));
    expect.soft(live.ok, 'the third window suggests once another is closed').toBe(true);
    expect.soft(live.value.banners.filter((banner) => banner.startsWith('suggest-busy:')), 'the notice is gone').toEqual([]);
    expect.soft(probe.refusals().length, 'still at most one refusal').toBeLessThanOrEqual(1);
  });
});

test('j16-suggest-drop busy-with-card suggester: a Suggest window that holds offered-back text and is refused its first lease says why, offers Retry, and still offers the text back', async ({ actors }, testInfo) => {
  test.setTimeout(240_000);
  // A drop the server saw: his leases expire, so his other windows can take every one while he is down.
  const probe = await begin(actors, testInfo, 'busy-with-card', 'suggester', 'seen');
  await probe.run(async () => {
    const { ada, ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1', 'one', { counted: false });
    await probe.settle(ben, 'Aa1');
    probe.cut();
    await probe.type(ben, 'Dd4', 'one', { counted: false });
    await pause(300);
    // The owner rejects the suggestion he is typing into; two more of his windows open the note for suggesting.
    const origin = new URL(ada.page.url()).origin;
    const listed = (await (await ada.context.request.get(`/api/docs/${docId}/suggestions`)).json()) as { suggestions: { id: string }[] };
    expect(listed.suggestions.length, 'his suggestion is open').toBe(1);
    expect((await ada.context.request.post(`/api/docs/${docId}/suggestions/${listed.suggestions[0].id}/reject`, { headers: { origin }, data: {} })).status(), 'the owner rejects it').toBe(200);
    const ben2 = await probe.second('ben-2');
    await probe.enterSuggest(ben2);
    const ben3 = await probe.second('ben-3');
    await probe.enterSuggest(ben3);
    probe.up();

    // Back online: the closed suggestion's text is kept, and the rebuilt window is refused its first lease.
    const busy = ui.pane(ben, docId).locator(`[${CONNECTION_BANNER_ATTR}="suggest-busy"]`);
    const retry = busy.getByRole('button', { name: 'Retry', exact: true });
    const recover = busy.getByRole('button', { name: 'Recover unsaved text (1)', exact: true });
    const card = ben.page.locator(`[${SUGGEST_UNSAVED_ATTR}]`).first();
    const show = card.getByRole('button', { name: 'Show text', exact: true });
    await expect(busy, 'the refused window says why the note is read-only, with the kept text undismissed').toContainText(BUSY, { timeout: 30_000 });
    await expect(retry, 'and offers Retry').toBeVisible();
    await expect(ui.body(ben, docId), 'the note is read-only').toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
    expect(probe.refusals(), 'one refusal: the first lease').toEqual(['lease-cap (ben)']);

    // The kept text is one press away, whole.
    await recover.click();
    await expect(recover, 'Recover shows the kept text').toHaveAttribute('aria-expanded', 'true');
    await show.click();
    await expect(card.locator('pre'), 'the text is offered back whole').toHaveText(`${START.one} Aa1 Dd4`);
    probe.dismissDialogs = true;
    const asked = probe.dialogs.length;
    await ben.page.reload({ timeout: 5_000 }).catch(() => undefined);
    await pause(500);
    expect(probe.dialogs.length - asked, 'a reload asks first while the text is kept').toBe(1);

    // Retry with both other windows still open is refused again: the notice and Retry come back, and the text is
    // still one press away, whole.
    await recover.click();
    await expect(recover, 'Recover put away').toHaveAttribute('aria-expanded', 'false');
    await retry.click();
    await expect.poll(() => probe.refusals(), { message: 'Retry with both other windows open is refused again', timeout: 30_000 }).toEqual(['lease-cap (ben)', 'lease-cap (ben)']);
    await expect(busy, 'the notice comes back').toContainText(BUSY, { timeout: 30_000 });
    await expect(retry, 'with Retry').toBeVisible();
    await expect(ui.body(ben, docId), 'the note is still read-only').toHaveAttribute(BODY_BINDING_ATTR, 'readonly');
    await recover.click();
    await expect(recover, 'Recover shows the kept text again').toHaveAttribute('aria-expanded', 'true');
    await show.click();
    await expect(card.locator('pre'), 'the text is still offered back whole after the refused Retry').toHaveText(`${START.one} Aa1 Dd4`);

    // With another window closed, Retry suggests here, and the text is still offered.
    await ben2.page.close();
    await retry.click();
    await expect(ui.body(ben, docId), 'Retry suggests here once another window is closed').toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
    await expect(busy, 'the notice is gone').toHaveCount(0);
    await expect(card, 'the kept text leads again').toBeVisible();
    await expect(show, 'the card is a new one, with its text put away').toBeVisible();
    await show.click();
    await expect(card.locator('pre'), 'and is still whole after the Retry').toHaveText(`${START.one} Aa1 Dd4`);
    expect(probe.refusals().length, 'two refusals in all').toBe(2);
    expect(probe.cooled(), 'no 4429').toBe(false);
  });
});

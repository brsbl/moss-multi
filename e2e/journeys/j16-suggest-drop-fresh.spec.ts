// j16-suggest-drop, other windows after a drop: a fresh page of the person's session opens the note after an idle or a
// typed reconnect, and a stalled socket's frames arrive after its replacement resumed. The probe is
// e2e/lib/suggest-drop.ts; the cooldown's net is in j16-suggest-drop-cooldown.
// journey-legs: 5 (the shard budget counts them; scripts/ci/journeys.mjs)
import {
  begin, caretEnd, draftLines, firstLine, freshPage, pause, paneOf, START, until, type Probe,
} from '../lib/suggest-drop.ts';
import { expect, test } from '../lib/test.ts';

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

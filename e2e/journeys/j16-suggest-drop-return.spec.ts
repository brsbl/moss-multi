// j16-suggest-drop, windows that drop and come back: two Suggest windows of one person drop and return in either order
// with text typed while down; two windows where the first drops again and again; and one window that drops twice
// between moves to a new group, three times a minute. Nothing honest is refused and every token is on the server
// once. The probe is e2e/lib/suggest-drop.ts.
// journey-legs: 11 (the shard budget counts them; scripts/ci/journeys.mjs)
import { begin, caretEnd, pause, resumeReply, ROLES, START, until, type LineKey } from '../lib/suggest-drop.ts';
import { expect, test } from '../lib/test.ts';

// Two Suggest windows of one person drop, and the second is back first. `suggester` and `editor`: the second window is
// idle and the first types while down. `other-typed`: the second window has typed too. `both-idle`: nobody typed.
type Return = 'suggester' | 'editor' | 'other-typed' | 'both-idle';
const RETURNS: [Return, 'unseen' | 'seen'][] = [['suggester', 'unseen'], ['suggester', 'seen'], ['editor', 'seen'], ['other-typed', 'seen'], ['both-idle', 'seen']];

for (const [variant, drop] of RETURNS) test(`j16-suggest-drop offline-return ${variant} ${drop}: text typed while down in one window, whose other window reconnects first`, async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, variant === 'suggester' ? 'offline-return' : `offline-return-${variant}`, variant === 'editor' ? 'editor' : 'suggester', drop);
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    const ben2 = await probe.second('ben-2', { severable: true });
    await probe.enterSuggest(ben2);
    if (variant === 'other-typed') {
      await caretEnd(ben2, docId, START.three);
      await probe.type(ben2, 'Oo7', 'three');
      await probe.settle(ben2, 'Oo7');
    }
    if (variant !== 'both-idle') {
      await caretEnd(ben, docId, START.one);
      await probe.type(ben, 'Aa1');
      await probe.settle(ben, 'Aa1');
      probe.note('the owner', { mode: await probe.ownerReview() });
    }
    const cutAt = probe.cut();
    if (variant !== 'both-idle') {
      await probe.type(ben, 'Dd4');
      await pause(300);
      probe.note('Dd4 typed while down', await probe.brief(ben));
    }
    // The second window drops too, and is back first.
    const other = ben2.sever!;
    const blipAt = Date.now();
    other.reset(probe.closeCode);
    await pause(300);
    other.reset(probe.closeCode);
    other.restore();
    const first = await until(() => resumeReply(other.log(), blipAt, ['crossed']), (value) => value !== null, 20_000, 100);
    probe.note('the second window reconnected first', first.value ? { named: first.value.request.resume?.length, reply: first.value.reply.t, reason: first.value.reply.reason, leases: first.value.reply.leases } : 'no resume answered');
    probe.up();
    await probe.resumed(cutAt);
    const locked = await probe.cooldownWithin(8_000);
    await pause(500);
    probe.note('the returning window', await probe.brief(ben));
    probe.note('the second window', await probe.brief(ben2));
    if (!locked) {
      await probe.checkpoint('K1 after the return');
      expect.soft((await probe.pane(ben2)).binding, 'the second window is live in Suggest').toBe('live');
    } else {
      await probe.checkpoint('locked out after the return', { waitMs: 0, review: false });
      // With nothing typed there is no text to follow through the 60 s.
      if (variant === 'both-idle') return;
      await probe.lockout();
      await probe.card(ben, 'after the Retry');
      await probe.checkpoint('K2 after the lockout');
    }
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

for (const role of ROLES) test(`j16-suggest-drop offline-return-first ${role} seen: text typed while down in one window, which reconnects before its other window`, async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'offline-return-first', role, 'seen');
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    const ben2 = await probe.second('ben-2', { severable: true });
    await probe.enterSuggest(ben2);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    const cutAt = probe.cut();
    await probe.type(ben, 'Dd4');
    await pause(300);
    probe.note('Dd4 typed while down', await probe.brief(ben));
    // The second window drops too, and stays down until the first is back.
    const other = ben2.sever!;
    other.reset(probe.closeCode);
    await pause(300);
    probe.up();
    await probe.resumed(cutAt);
    const blipAt = Date.now();
    other.reset(probe.closeCode);
    other.restore();
    const second = await until(() => resumeReply(other.log(), blipAt, ['crossed']), (value) => value !== null, 20_000, 100);
    probe.note('the second window reconnected after the first', second.value ? { named: second.value.request.resume?.length, reply: second.value.reply.t, reason: second.value.reply.reason, leases: second.value.reply.leases } : 'no resume answered');
    await probe.cooldownWithin(8_000);
    await pause(500);
    probe.note('the returning window', await probe.brief(ben));
    probe.note('the second window', await probe.brief(ben2));
    await probe.checkpoint('K1 after both returned');
    expect.soft((await probe.pane(ben2)).binding, 'the second window is live in Suggest').toBe('live');
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

for (const drop of ['unseen', 'seen'] as const) test(`j16-suggest-drop flap suggester ${drop}: two Suggest windows, and the first drops again and again inside a minute, typing somewhere new each time`, async ({ actors }, testInfo) => {
  test.setTimeout(300_000);
  const probe = await begin(actors, testInfo, 'flap', 'suggester', drop);
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    const ben2 = await probe.second('ben-2');
    await probe.enterSuggest(ben2);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    // Each drop is followed by typing two blocks away, which starts a new group and asks for a spare lease. Every
    // token is counted: nothing is taken from the screen.
    const plan: [LineKey, string][] = [['three', 'Bb2'], ['one', 'Cc3'], ['three', 'Dd4'], ['one', 'Ee5']];
    const typed: string[] = [];
    const startedAt = Date.now();
    for (const [line, token] of plan) {
      const cutAt = probe.cut();
      await pause(500);
      probe.up();
      if (!(await probe.resumed(cutAt, 'crossed', 15_000))) break;
      await probe.attempt(`typing "${token}"`, async () => {
        await caretEnd(ben, docId, START[line]);
        await probe.type(ben, token, line);
        typed.push(token);
      });
      await pause(600);
      if (probe.cooled()) break;
    }
    const flapMs = Date.now() - startedAt;
    probe.note('the drops', { typed, ms: flapMs });
    expect.soft(typed, 'every planned drop resumed and its token was typed').toEqual(plan.map(([, token]) => token));
    expect.soft(flapMs, 'the four drops fall inside a minute').toBeLessThan(60_000);
    const locked = await probe.cooldownWithin(2_000);
    if (!locked) {
      await probe.checkpoint('K1 no lockout');
    } else {
      await probe.checkpoint('locked out while typing', { waitMs: 0, review: false });
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

for (const role of ROLES) test(`j16-suggest-drop one-window ${role} unseen: one window, two cuts with typing, then typing two blocks away, three times inside a minute`, async ({ actors }, testInfo) => {
  test.setTimeout(240_000);
  const probe = await begin(actors, testInfo, 'one-window', role);
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    await probe.type(ben, 'Aa1');
    await probe.settle(ben, 'Aa1');
    probe.note('the owner', { mode: await probe.ownerReview() });
    const rounds: [LineKey, LineKey, string[]][] = [['one', 'three', ['Bb2', 'Cc3', 'Dd4']], ['three', 'one', ['Ee5', 'Ff6', 'Gg7']], ['one', 'three', ['Hh8', 'Ii9', 'Jj1']]];
    const startedAt = Date.now();
    let done = 0;
    rounds: for (const [here, away, [first, second, moved]] of rounds) {
      // Two cuts, each with typing while down.
      for (const token of [first, second]) {
        const cutAt = probe.cut();
        await probe.type(ben, token, here);
        await pause(300);
        probe.up();
        if (!(await probe.resumed(cutAt, 'crossed', 15_000))) break rounds;
      }
      // Then typing two blocks away: a new group.
      const moveTyped = await probe.attempt(`typing "${moved}"`, async () => {
        await caretEnd(ben, docId, START[away]);
        await probe.type(ben, moved, away);
        return true;
      });
      if (moveTyped) done += 1;
      await pause(600);
      if (probe.cooled()) break;
    }
    const roundsMs = Date.now() - startedAt;
    probe.note('three rounds', { done, ms: roundsMs });
    expect.soft(done, 'every round resumed both cuts and typed its move').toBe(rounds.length);
    expect.soft(roundsMs, 'the three rounds fall inside a minute').toBeLessThan(60_000);
    await probe.cooldownWithin(2_000);
    await probe.checkpoint('K1 after three rounds');
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

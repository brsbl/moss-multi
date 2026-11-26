// j16-suggest-drop, one window: text acknowledged, stored with its reply lost, in flight and typed while down is on
// the server once after one cut, two cuts or cuts inside a burst, and so are a strike, an undelete, a paste and a new
// block across a cut. The probe is e2e/lib/suggest-drop.ts.
// journey-legs: 12 (the shard budget counts them; scripts/ci/journeys.mjs)
import { pastePlain } from '../lib/paste.ts';
import { caret, content } from '../lib/suggest.ts';
import { begin, caretEnd, DROPS, KEY_DELAY, pause, ROLES, START, typeAcrossCut, until } from '../lib/suggest-drop.ts';
import { test } from '../lib/test.ts';

for (const role of ROLES) for (const drop of DROPS) {
  test(`j16-suggest-drop one-cut ${role} ${drop}: text acknowledged, stored unheard, in flight and typed while down is all there once after one cut`, async ({ actors }, testInfo) => {
    test.setTimeout(180_000);
    const probe = await begin(actors, testInfo, 'one-cut', role, drop);
    await probe.run(async () => {
      const { ben } = probe;
      await probe.enterSuggest(ben);
      const cutAt = await typeAcrossCut(probe);
      probe.up();
      await probe.resumed(cutAt);
      await probe.type(ben, 'Ee5');
      await probe.checkpoint('K1 after the reconnect');
      await probe.reload(ben);
      await probe.reloadOwner();
      await probe.checkpoint('K3 after a reload');
    });
  });

  test(`j16-suggest-drop two-cuts ${role} ${drop}: a second cut inside the resume and a third after it lose nothing`, async ({ actors }, testInfo) => {
    test.setTimeout(240_000);
    const probe = await begin(actors, testInfo, 'two-cuts', role, drop);
    await probe.run(async () => {
      const { ben } = probe;
      await probe.enterSuggest(ben);
      const cutAt = await typeAcrossCut(probe);
      // The resume reaches the DocDO and is granted; its reply never reaches the page, and the socket drops again.
      probe.up({ loseReplies: true });
      await probe.resumed(cutAt, 'lost');
      const secondCut = probe.cut();
      await probe.type(ben, 'Ff6');
      await pause(300);
      probe.up();
      await probe.resumed(secondCut);
      await probe.type(ben, 'Ee5');
      await probe.checkpoint('K1 after two cuts');
      const thirdCut = probe.cut();
      await probe.type(ben, 'Gg7');
      await pause(300);
      probe.up();
      await probe.resumed(thirdCut);
      await probe.checkpoint('K1 after the third cut');
      await probe.reload(ben);
      await probe.reloadOwner();
      await probe.checkpoint('K3 after a reload');
    });
  });
}

for (const drop of DROPS) test(`j16-suggest-drop burst suggester ${drop}: two cuts inside one burst of typing in a paragraph`, async ({ actors }, testInfo) => {
  test.setTimeout(180_000);
  const probe = await begin(actors, testInfo, 'burst', 'suggester', drop);
  await probe.run(async () => {
    const { ben, docId } = probe;
    await probe.enterSuggest(ben);
    await caretEnd(ben, docId, START.one);
    const words = Array.from({ length: 70 }, (_, index) => `w${String(index).padStart(2, '0')}`);
    // 70 words, 280 keys at 20 ms: the socket drops twice while the keys keep coming.
    const typing = ben.page.keyboard.type(` ${words.join(' ')}`, { delay: 20 });
    await pause(900);
    const firstCut = probe.cut();
    await pause(900);
    probe.up();
    await pause(1_400);
    const secondCut = probe.cut();
    await pause(900);
    probe.up();
    await typing;
    probe.lines.one += ` ${words.join(' ')}`;
    probe.tokens.push(...words);
    probe.note('the burst is typed', { firstCutMs: probe.ms(firstCut), secondCutMs: probe.ms(secondCut) });
    await probe.resumed(secondCut);
    await probe.checkpoint('K1 after the burst');
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload');
  });
});

for (const drop of DROPS) test(`j16-suggest-drop shapes suggester ${drop}: a strike, an undelete, a paste and a new block across one cut are each on the server once`, async ({ actors }, testInfo) => {
  test.setTimeout(240_000);
  const probe = await begin(actors, testInfo, 'shapes', 'suggester', drop);
  await probe.run(async () => {
    const { ada, ben, docId, sever } = probe;
    await probe.enterSuggest(ben);
    // Acknowledged: "one" struck, and a paste at the end of paragraph three.
    await caret(ben, docId, START.one, 'Draft line '.length, 'one'.length);
    await ben.page.keyboard.press('Backspace');
    probe.lines.one = 'Draft line .';
    probe.note('struck "one"');
    await probe.settle(ben, 'the strike');
    await caretEnd(ben, docId, START.three);
    await pastePlain(ben, docId, ' Pp3');
    probe.lines.three += ' Pp3';
    probe.tokens.push('Pp3');
    await probe.settle(ben, 'the paste');
    probe.note('the owner', { mode: await probe.ownerReview() });
    // Stored with its replies lost: a new block after paragraph one.
    sever.loseSuggestReplies();
    await caretEnd(ben, docId, START.one);
    await ben.page.keyboard.press('Enter');
    await ben.page.keyboard.type('Nn5', { delay: KEY_DELAY });
    probe.tokens.push('Nn5');
    const stored = await until(() => content(ada, docId, 'working'), (text) => text.includes('Nn5'), 15_000, 200);
    probe.note('Nn5 on the server, its replies lost', { stored: stored.ok, ms: stored.ms });
    // In flight: "two" struck, as its own undo step.
    await pause(1_000);
    sever.hold(docId);
    await caret(ben, docId, START.two, 'Draft line '.length, 'two'.length);
    await ben.page.keyboard.press('Backspace');
    await pause(400);
    probe.note('struck "two", held in flight', { held: sever.census().held });
    const cutAt = probe.cut();
    // While down: the strike is taken back (an undelete), and more is typed in paragraph three.
    await pause(1_000);
    await ben.page.keyboard.press('ControlOrMeta+z');
    await pause(300);
    await caretEnd(ben, docId, START.three);
    await probe.type(ben, 'Dd4', 'three');
    await pause(300);
    probe.note('undone and typed while down', await probe.brief(ben));
    probe.up();
    await probe.resumed(cutAt);
    await probe.type(ben, 'Ee5', 'three');
    // Struck text stays on screen, painted: each window is read for every token once.
    await probe.checkpoint('K1 after the reconnect', { windows: 'tokens' });
    await probe.reload(ben);
    await probe.reloadOwner();
    await probe.checkpoint('K3 after a reload', { windows: 'tokens' });
  });
});

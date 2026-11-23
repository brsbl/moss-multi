// j01-caret-keep (T9.47): what keeping the caret through a peer's block change must not change. A peer's bold,
// Backspace-merge and check-list sort leave the waiting caret as before; a caret in the title keeps its focus; the
// view does not scroll. Three people each keep their own words, and Cmd+Z after a kept caret undoes one step.
import type { Actor } from '../lib/actors.ts';
import { between, caretNote, converged, lines, park, pick, PEER_TIMEOUT, PREVIOUS, TARGET } from '../lib/caret-note.ts';
import { expect, test, ui } from '../lib/test.ts';

const UNDO = 'ControlOrMeta+z';
const h2 = (actor: Actor, id: string) => ui.body(actor, id).locator('h2').filter({ hasText: 'Target paragraph' });

test("j01 caret keep: M1 a peer's bold and Backspace-merge keep the waiting caret at the end of its line as before @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 0);
  // Ada bolds "paragraph", before Ben's caret in the same text.
  await park(ada, id, TARGET, 26, 17);
  await ada.page.keyboard.press('ControlOrMeta+b');
  await expect(ui.body(ben, id).getByText('paragraph', { exact: true }), "Ada's bold reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('X');
  await converged(ada, ben, id);
  expect(await ui.fieldText(ben, id, 'body'), "after a peer's bold").toContain('Target paragraph where Ben waits.X');

  // Ada presses Backspace at the start of Ben's paragraph, merging it into the one above.
  await park(ada, id, 'Target paragraph where Ben waits.X', 34);
  await ada.page.keyboard.press('Backspace');
  await expect(ui.body(ben, id).locator('p').first(), "Ada's merge reaches Ben").toContainText('stays put.Target', { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('Y');
  await converged(ada, ben, id);
  await expect(ui.body(ben, id).locator('p').first(), 'after a peer merge').toHaveText(`${PREVIOUS}Target paragraph where Ben waits.XY`);
});

test("j01 caret keep: M2 a peer's Backspace-merge never sends the caret into an untouched paragraph that reads the same @p:col-1", async ({ actors, stack }) => {
  const SAME = 'Same words here.';
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl, { markdown: [PREVIOUS, '', SAME, '', SAME].join('\n') });
  await park(ben, id, SAME, 5, 5, 0);
  await park(ada, id, SAME, SAME.length, SAME.length, 0);
  await ada.page.keyboard.press('Backspace');
  await expect.poll(async () => (await lines(ben, id))[0], { message: "Ada's merge reaches Ben", timeout: PEER_TIMEOUT }).toBe(`${PREVIOUS}${SAME}`);
  await ben.page.keyboard.type('X');
  await converged(ada, ben, id);
  for (const actor of [ada, ben]) expect(await lines(actor, id), 'X in the merged line; the untouched paragraph exact').toEqual([`${PREVIOUS}${SAME}X`, SAME]);
});

test("j01 caret keep: M3 a tick in Ben's check list sorts it as before, and the other items stay exact @p:col-1", async ({ actors, stack }) => {
  const items = ['Alpha item.', 'Lima item here.', 'Charlie item.'];
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl, { markdown: [PREVIOUS, '', ...items.map(text => `- [ ] ${text}`)].join('\n') });
  await park(ben, id, items[1]!, 5);
  const box = ui.body(ada, id).locator('li[role="checkbox"]').filter({ hasText: items[2]! });
  const at = await box.boundingBox();
  if (!at) throw new Error('no checkbox');
  await ada.page.mouse.click(at.x + 4, at.y + at.height / 2);
  await expect(ui.body(ben, id).locator('li[role="checkbox"][aria-checked="true"]'), "Ada's tick reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.waitForTimeout(500); // the sort runs 50 ms after the tick, in Ada's window
  await ben.page.keyboard.type('X');
  await converged(ada, ben, id);
  for (const actor of [ada, ben]) {
    const now = (await between(actor, id, PREVIOUS, null)).filter(text => text !== '');
    expect(now, `${actor.label}: three items`).toHaveLength(3);
    for (const text of [items[0]!, items[2]!]) expect(now, `${actor.label}: ${text} exact`).toContain(text);
    const mine = now.filter(text => text !== items[0] && text !== items[2]);
    expect(mine.map(text => text.replace('X', '')), `${actor.label}: Ben's item, his X removed, reads as before`).toEqual([items[1]]);
  }
});

test('j01 caret keep: M4 Ben\'s caret in the title keeps its focus through Ada\'s Heading 2 @p:col-1', async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 7);
  await ui.title(ben, id).click();
  await ben.page.keyboard.press('End');
  await park(ada, id, TARGET, 27);
  await pick(ada, 'Heading level', 'Heading 2');
  await expect(h2(ben, id), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('Q');
  await expect(ui.title(ben, id), 'the title keeps the key').toContainText('Q');
  await expect.poll(() => ben.page.evaluate(() => !!document.activeElement?.closest('[contenteditable]') && document.activeElement?.closest('[data-lexical-editor="true"]') === null), { message: 'the title has focus' }).toBe(true);
  await converged(ada, ben, id);
  for (const actor of [ada, ben]) expect((await lines(actor, id)).some(line => line.includes('Q')), `${actor.label}: the body has no Q`).toBe(false);
});

test("j01 caret keep: M5 Ada's change to Ben's block never scrolls his view @p:col-1", async ({ actors, stack }) => {
  const filler = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1} for a long note.`);
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl, { markdown: [PREVIOUS, '', TARGET, '', ...filler.flatMap(text => [text, ''])].join('\n') });
  await park(ben, id, TARGET, 7);
  const canvas = ben.page.locator('[data-editor-canvas]');
  await canvas.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await ben.page.waitForTimeout(300);
  const before = await canvas.evaluate(element => element.scrollTop);
  expect(before, 'Ben scrolled away').toBeGreaterThan(0);
  await park(ada, id, TARGET, 27);
  await pick(ada, 'Heading level', 'Heading 2');
  await expect(h2(ben, id), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.waitForTimeout(500);
  expect(await canvas.evaluate(element => element.scrollTop), "Ben's scroll position").toBe(before);
});

for (const [name, act, want] of [
  ['M6 Heading 2', (ada: Actor) => pick(ada, 'Heading level', 'Heading 2'), ['Target paragraphY where BenX waits.']],
  ['M7 Enter before both carets', (ada: Actor) => ada.page.keyboard.press('Enter'), ['Target', ' paragraphY where BenX waits.']],
] as const) {
  test(`j01 caret keep: Ada, Ben and Cy: Ada's ${name}, and each key lands beside its own words in all three windows @p:col-1`, async ({ actors, stack }) => {
    const { ada, ben, others: [cy], id } = await caretNote(actors, stack.baseUrl, { others: ['cy'] });
    await park(ben, id, TARGET, 7);
    await park(cy!, id, TARGET, 17);
    await park(ada, id, TARGET, 27);
    await act(ada);
    await expect.poll(() => between(cy!, id, PREVIOUS, 'First item'), { message: "Ada's change reaches Cy", timeout: PEER_TIMEOUT }).toHaveLength(want.length);
    await expect.poll(() => between(ben, id, PREVIOUS, 'First item'), { message: "Ada's change reaches Ben", timeout: PEER_TIMEOUT }).toHaveLength(want.length);
    if (name.startsWith('M6')) await expect(h2(ben, id)).toHaveCount(1, { timeout: PEER_TIMEOUT });
    await ben.page.keyboard.type('X');
    await cy!.page.keyboard.type('Y');
    for (const actor of [ada, ben, cy!]) {
      await expect.poll(() => between(actor, id, PREVIOUS, 'First item'), { message: `${actor.label}'s window`, timeout: PEER_TIMEOUT }).toEqual([...want]);
    }
  });
}

test('j01 caret keep: M8 Ben\'s Cmd+Z after a kept caret undoes his last keys only, and his next key follows @p:col-1', async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 7);
  await ben.page.keyboard.type('abc');
  await expect(ui.body(ada, id)).toContainText('Benabc waits', { timeout: PEER_TIMEOUT });
  await park(ada, id, 'Target paragraph where Benabc waits.', 30);
  await pick(ada, 'Heading level', 'Heading 2');
  await expect(h2(ben, id), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('def');
  await expect(h2(ben, id)).toHaveText('Target paragraph where Benabcdef waits.');
  await ben.page.keyboard.press(UNDO);
  await expect(h2(ben, id)).toHaveText('Target paragraph where Benabc waits.');
  await ben.page.keyboard.type('Y');
  await expect(h2(ben, id)).toHaveText('Target paragraph where BenabcY waits.');
  await converged(ada, ben, id);
  await expect(h2(ada, id)).toHaveText('Target paragraph where BenabcY waits.');
});

test("j01 caret keep: M9 Ada's Heading 2 and her Cmd+Z keep Ben's idle caret on his words @p:col-1", async ({ actors, stack }) => {
  const { ada, ben, id } = await caretNote(actors, stack.baseUrl);
  await park(ben, id, TARGET, 7);
  await park(ada, id, TARGET, 27);
  await pick(ada, 'Heading level', 'Heading 2');
  await expect(h2(ben, id), "Ada's change reaches Ben").toHaveCount(1, { timeout: PEER_TIMEOUT });
  await ada.page.keyboard.press(UNDO);
  await expect(h2(ben, id), "Ada's undo reaches Ben").toHaveCount(0, { timeout: PEER_TIMEOUT });
  await ben.page.keyboard.type('X');
  await expect.poll(() => between(ben, id, PREVIOUS, 'First item'), { timeout: PEER_TIMEOUT }).toEqual(['Target paragraph where BenX waits.']);
  await converged(ada, ben, id);
  expect(await between(ada, id, PREVIOUS, 'First item')).toEqual(['Target paragraph where BenX waits.']);
});

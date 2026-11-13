// j16-review-strikes (T5.3, split from j16-review for the shard budget; docs/design/suggestions.md §4, §8; PRODUCT ruling
// 17): strikes, joins, pastes and highlights made while suggesting read right on the owner's card and land as struck
// through accept.
import type { Actor } from '../lib/actors.ts';
import { cardRows, cards, caret, content, painted, settled as acked, sharedNote, openIn, BIND_TIMEOUT, button, mod } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

test("j16-review: a strike, then Backspace at the block's start, keeps the strike through the join, its undo and redo and the strike's, the card and accept @p:mean-2 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  // Backspace after "a" strikes it; Backspace at the block's start joins the paragraphs without it.
  await caret(ben, docId, 'abc tail.', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the join');
  await expect(body, 'joined, without the struck "a"').toContainText('Intro line stays.bc tail.');
  await expect(body).not.toContainText('abc');

  // Undo takes the join back and the strike stands; redo joins again.
  await keyboard.press(`${mod}+z`);
  await acked(ben, docId, 'the undo');
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));
  await expect.poll(blocks, { message: 'split again, without the struck "a"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'bc tail.', 'Closing line stays too.']);
  // Undo of the strike brings the "a" back; redo strikes it again, then joins again.
  await keyboard.press(`${mod}+z`);
  await acked(ben, docId, 'the undo of the strike');
  await expect.poll(blocks, { message: 'the "a" is back', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'abc tail.', 'Closing line stays too.']);
  await keyboard.press(`${mod}+Shift+z`);
  await acked(ben, docId, 'the redo of the strike');
  await expect.poll(blocks, { message: 'the strike again', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'bc tail.', 'Closing line stays too.']);
  await keyboard.press(`${mod}+Shift+z`);
  await acked(ben, docId, 'the redo');
  await expect.poll(blocks, { message: 'joined again', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.bc tail.', 'Closing line stays too.']);
  await expect(body).not.toContainText('abc');

  // The owner's Edit-mode body paints the old block struck, and the card adds the moved text without the "a".
  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await painted(ada, 'suggest-delete')).join(''), { message: 'the old block paints struck', timeout: BIND_TIMEOUT }).toContain('bc tail.');
  const { card, inserted, deleted } = await cardRows(ada);
  expect(inserted.join(''), 'the card adds the moved text without the struck "a"').toBe('bc tail.');
  expect(deleted.join(' '), 'the card removes the old block').toContain('abc tail.');

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'the accepted note', timeout: BIND_TIMEOUT }).toContain('Intro line stays.bc tail.');
  const accepted = await content(ada, docId);
  expect(accepted, 'the struck "a" is gone').not.toContain('abc');
  expect(accepted, 'unstruck text stays').toContain('Closing line stays too.');
  await expect(ui.body(ada, docId)).toContainText('Intro line stays.bc tail.', { timeout: BIND_TIMEOUT });
});

test('j16-review: a whole list item struck, then Backspace once more, leaves the item text out of the card and of the accepted note @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, '- alpha item\n- beta item\n- gamma item');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);

  await caret(ben, docId, 'beta item', 'beta item'.length);
  for (let i = 0; i < 'beta item'.length; i++) await keyboard.press('Backspace');
  await acked(ben, docId, 'the strikes');
  await expect.poll(async () => (await painted(ben, 'suggest-delete')).join(''), { message: 'the item paints struck', timeout: BIND_TIMEOUT }).toBe('beta item');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the unwrap');
  await expect(body, 'the struck item text stays out').not.toContainText('beta');
  await expect(body).toContainText('alpha item');
  await expect(body).toContainText('gamma item');

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  await expect.poll(async () => (await painted(ada, 'suggest-delete')).join(''), { message: 'the owner sees it struck', timeout: BIND_TIMEOUT }).toContain('beta item');
  const { card, inserted } = await cardRows(ada);
  expect(inserted.join(' '), 'the card adds no struck text').not.toContain('beta');

  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept removes the item text', timeout: BIND_TIMEOUT }).not.toContain('beta');
  const accepted = await content(ada, docId);
  expect(accepted).toContain('alpha item');
  expect(accepted).toContain('gamma item');
});

test('j16-review: adjacent strikes made right to left, a join, then full undo and redo, keep the characters in order through accept @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  // After "b": Backspace strikes "b", then "a", then joins.
  await caret(ben, docId, 'abc tail.', 2);
  for (let i = 0; i < 3; i++) {
    await keyboard.press('Backspace');
    await acked(ben, docId, `Backspace ${i + 1}`);
  }
  await expect.poll(blocks, { message: 'joined without "a" and "b"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.c tail.', 'Closing line stays too.']);
  const rounds: [string, string[]][] = [
    [`${mod}+z`, ['Intro line stays.', 'abc tail.', 'Closing line stays too.']],
    [`${mod}+Shift+z`, ['Intro line stays.c tail.', 'Closing line stays too.']],
    [`${mod}+z`, ['Intro line stays.', 'abc tail.', 'Closing line stays too.']],
  ];
  for (const [key, expected] of rounds) {
    for (let i = 0; i < 3; i++) {
      await keyboard.press(key);
      await acked(ben, docId, `${key} ${i + 1}`);
    }
    await expect.poll(blocks, { message: `${key} three times, in order`, timeout: BIND_TIMEOUT }).toEqual(expected);
  }

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card } = await cardRows(ada);
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept lands the original text', timeout: BIND_TIMEOUT }).toContain('Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
});

test('j16-review: Backspace beside an empty paragraph removes only that paragraph, and strikes either side of live text stay acceptable @p:mean-2 @p:R17', async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line here.\n\na**b**c tail.\n\nClosing line too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  await caret(ben, docId, 'Intro line here.', 'Intro line here.'.length);
  await keyboard.press('Enter');
  await acked(ben, docId, 'the empty paragraph');
  await expect.poll(blocks, { timeout: BIND_TIMEOUT }).toEqual(['Intro line here.', '', 'abc tail.', 'Closing line too.']);
  await caret(ben, docId, 'c tail.', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "c"');
  await caret(ben, docId, 'a', 1);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "a"');
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the Backspace at the block start');
  await expect.poll(blocks, { message: 'only the empty paragraph went', timeout: BIND_TIMEOUT }).toEqual(['Intro line here.', 'abc tail.', 'Closing line too.']);
  await expect.poll(async () => (await painted(ben, 'suggest-delete')).sort(), { message: 'both strikes still paint', timeout: BIND_TIMEOUT }).toEqual(['a', 'c']);

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card } = await cardRows(ada);
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept removes only the struck characters', timeout: BIND_TIMEOUT }).toContain('Intro line here.\n\n**b** tail.\n\nClosing line too.');
});

/** A real text/html paste at the caret. */
const pasteHtml = (actor: Actor, docId: string, html: string, plain: string): Promise<void> =>
  ui.body(actor, docId).evaluate((element, [h, p]) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', p);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [html, plain] as const);

const PASTES = [
  ["at the block's start, pasting the struck character itself", 1, '<p>a</p><p>x</p>', 'a\n\nx', ['Intro line stays.', 'a', 'xbc tail.', 'Closing line stays too.'], false],
  // The pasted "b" sits just before the struck one, in its text node, so it reads as that "b" restored: accept keeps
  // the original (T5.S14) and ben's fork, which held the pasted one, rebuilds on a fresh socket.
  ['just before the struck character, pasting the same character', 2, '<p>b</p><p>x</p>', 'b\n\nx', ['Intro line stays.', 'ab', 'xc tail.', 'Closing line stays too.'], true],
] as const;

for (const [label, offset, html, plain, expected, kept] of PASTES) {
  test(`j16-review: a paste ${label} keeps the pasted text and leaves the struck one out, through the card and accept @p:mean-2 @p:R17`, async ({ actors }) => {
    const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
    if (kept) ben.expectReconnects(1, docId);
    await openIn(ben, docId, 'suggest');
    await openIn(ada, docId, 'edit');
    await actors.requireDistinct(2);
    const body = ui.body(ben, docId);
    const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

    // Backspace strikes the character before the caret and leaves the caret before it; the paste lands there.
    await caret(ben, docId, 'abc tail.', offset);
    await ben.page.keyboard.press('Backspace');
    await acked(ben, docId, 'the strike');
    await pasteHtml(ben, docId, html, plain);
    await acked(ben, docId, 'the paste');
    await expect.poll(blocks, { message: 'the pasted text stays; the struck character stays out of the moved block', timeout: BIND_TIMEOUT }).toEqual([...expected]);

    await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
    const { card } = await cardRows(ada);
    await card.getByRole('button', { name: 'Accept' }).click();
    await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
    await expect.poll(() => content(ada, docId), { message: 'accept lands the pasted text without the struck character', timeout: BIND_TIMEOUT })
      .toContain(expected.join('\n\n'));
  });
}

test("j16-review: a strike, then the '==' highlight shortcut around it, keeps the struck character out of the highlight, the card and accept @p:mean-2 @p:R17", async ({ actors }) => {
  const { ada, ben, docId } = await sharedNote(actors, 'Intro line stays.\n\nabc tail.\n\nClosing line stays too.');
  await openIn(ben, docId, 'suggest');
  await openIn(ada, docId, 'edit');
  await actors.requireDistinct(2);
  const { keyboard } = ben.page;
  const body = ui.body(ben, docId);
  const blocks = () => body.evaluate((root) => [...root.children].map((block) => block.textContent ?? ''));

  await caret(ben, docId, 'abc tail.', 2);
  await keyboard.press('Backspace');
  await acked(ben, docId, 'the strike of "b"');
  await caret(ben, docId, 'abc tail.', 0);
  await keyboard.type('==');
  await acked(ben, docId, 'the opening "=="');
  await caret(ben, docId, '==abc tail.', 5);
  // The closing "=" triggers moss's highlight transformer, which replaces "==abc==" with a new highlighted node.
  await keyboard.type('==');
  await acked(ben, docId, 'the highlight');
  await expect.poll(blocks, { message: 'highlighted, without the struck "b"', timeout: BIND_TIMEOUT }).toEqual(['Intro line stays.', 'ac tail.', 'Closing line stays too.']);

  await expect(button(ada)).toHaveAttribute('aria-label', /1 open/, { timeout: BIND_TIMEOUT });
  const { card, inserted } = await cardRows(ada);
  expect(inserted.join('|'), 'the card adds no struck text').not.toContain('b');
  await card.getByRole('button', { name: 'Accept' }).click();
  await expect(cards(ada, 'accepted')).toHaveCount(1, { timeout: BIND_TIMEOUT });
  await expect.poll(() => content(ada, docId), { message: 'accept lands the highlight without the struck "b"', timeout: BIND_TIMEOUT })
    .toContain('Intro line stays.\n\n==ac== tail.\n\nClosing line stays too.');
});

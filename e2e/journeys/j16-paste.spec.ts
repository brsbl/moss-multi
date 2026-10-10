// j16-paste (T5.R2, T5.S10; docs/design/suggestions.md §5, T3.S6): in Suggest mode a large paste is never batched. It is
// admitted against the suggestion caps before anything changes, the strike of a selection it replaces included, then
// lands in one transaction, one frame, one suggestion; or it is refused whole, visibly, with nothing struck or sent
// and the selection kept. One undo takes it back and one redo brings it back.
import type { Actor } from '../lib/actors.ts';
import { INPUT_REFUSAL_ATTR, SUGGEST_SENT_ATTR } from '../lib/contract.ts';
import { grantDoc } from '../lib/grants.ts';
import { pastePlain } from '../lib/paste.ts';
import { caret, content, mod, openIn, painted, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

type Actors = Parameters<Parameters<typeof test>[2]>[0]['actors'];

/** A note owned by ada, open in ben's window as a suggester. */
async function suggesting(actors: Actors, markdown: string) {
  const ada = await actors.open(await actors.principal('ada'));
  const response = await ada.context.request.post('/api/docs', { headers: { origin: new URL(ada.page.url()).origin }, data: { markdown } });
  expect(response.status()).toBe(201);
  const docId = ((await response.json()) as { doc: { id: string } }).doc.id;
  const benPrincipal = await actors.principal('ben');
  await grantDoc(ada, docId, benPrincipal, 'suggester');
  const ben = await actors.session(benPrincipal);
  await openIn(ben, docId);
  await ben.observeEditor(docId);
  return { ada, ben, docId };
}

const sent = async (actor: Actor, docId: string): Promise<number> => Number(await ui.pane(actor, docId).getAttribute(SUGGEST_SENT_ATTR));

test('j16-paste: a large paste over a selection, past the suggestion record cap, is refused whole: nothing struck or sent, the selection kept @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const working = await content(ada, docId, 'working');
  await caret(ben, docId, 'original', 0, 8);
  const before = await sent(ben, docId);
  // About 280 KB in 14 lines: past the 256 KiB of ops one suggestion holds, far under the note's cap.
  await pastePlain(ben, docId, Array.from({ length: 14 }, (_, i) => `Big line ${i} ${'x'.repeat(20_000)}`).join('\n'));
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'refused visibly').toContainText('too large for one suggestion', { timeout: 60_000 });
  await settled(ben, docId, 'the refused paste');
  expect(await sent(ben, docId), 'nothing was sent').toBe(before);
  expect(await painted(ben, 'suggest-delete'), 'nothing is struck').toEqual([]);
  await expect(ui.body(ben, docId)).not.toContainText('Big line');
  expect(await ben.page.evaluate(() => window.getSelection()?.toString()), 'the selection is kept').toBe('original');
  expect(await content(ada, docId, 'working'), 'no suggestion was made').toBe(working);
});

test('j16-paste: an admissible large paste lands as one frame, one suggestion; one undo takes it back and one redo brings it back @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'Second line.', 12);
  const before = await sent(ben, docId);
  // 42,000 characters: a large paste (T3.S6), many batches in Edit mode, well under the record cap.
  await pastePlain(ben, docId, Array.from({ length: 60 }, (_, i) => `Pasted ${i} ${'y'.repeat(690)}`).join('\n'));
  await settled(ben, docId, 'the paste');
  expect(await sent(ben, docId) - before, 'the paste is one frame').toBe(1);
  await expect.poll(() => content(ada, docId, 'working'), { message: 'the whole paste is one pending suggestion' }).toContain('Pasted 59');
  expect(await content(ada, docId, 'working')).toContain('Pasted 0 ');

  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  expect(await sent(ben, docId) - before, 'the undo is one frame').toBe(2);
  await expect(body).not.toContainText('Pasted');

  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  expect(await sent(ben, docId) - before, 'the redo is one frame').toBe(3);
  await expect(body).toContainText('Pasted 0 ');
  await expect(body).toContainText('Pasted 59 ');
});

test('j16-paste: an admissible large paste over another author\'s selection strikes it in the same step: one undo takes both back, one redo brings both back @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'original', 0, 8);
  await pastePlain(ben, docId, Array.from({ length: 60 }, (_, i) => `Pasted ${i} ${'y'.repeat(690)}`).join('\n'));
  await settled(ben, docId, 'the paste');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the selection is struck' }).toEqual(['original']);
  await expect(body).toContainText('Pasted 59 ');

  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  await expect(body, 'one undo takes the paste back').not.toContainText('Pasted');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual([]);
  await expect.poll(() => content(ada, docId, 'working'), { message: 'nothing is suggested' }).toContain('Ada original line.');

  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  await expect(body, 'one redo brings the paste back').toContainText('Pasted 59 ');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual(['original']);
});

test('j16-paste: a large paste in a new group that builds on the author\'s earlier open suggestion counts it, since it merges: past the cap it is refused whole @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.\n\nThird line.\n\nFourth line.');
  const body = ui.body(ben, docId);
  // About 85 KB as one suggestion, a new last block (its redo would make it some 170 KB, under the cap).
  await caret(ben, docId, 'Fourth line.', 12);
  await pastePlain(ben, docId, `\nFourth tail ${'f'.repeat(85_000)}`);
  await settled(ben, docId, 'the first paste');
  // An edit three blocks away starts a new group.
  await caret(ben, docId, 'Ada original line.', 0);
  await ben.page.keyboard.type('Z');
  await settled(ben, docId, 'the typing');
  const working = await content(ada, docId, 'working');
  // At the end of the block before the first paste, three blocks away again: a new group whose paste builds on the
  // first suggestion and so merges it. Alone it fits every cap, with nothing after it in its block (the next leg
  // admits a paste of this size); with the first one it does not.
  await caret(ben, docId, 'Fourth line.', 12);
  const before = await sent(ben, docId);
  await pastePlain(ben, docId, `Second tail ${'g'.repeat(70_000)}`);
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'refused visibly').toContainText('too large for one suggestion', { timeout: 60_000 });
  await settled(ben, docId, 'the refused paste');
  expect(await sent(ben, docId), 'nothing was sent').toBe(before);
  await expect(body).not.toContainText('Second tail');
  expect(await content(ada, docId, 'working'), 'the suggestions are unchanged').toBe(working);
});

test('j16-paste: a paste inside a long paragraph counts the paragraph\'s rest, which the split re-creates as the suggester\'s: past the cap with it, it is refused whole @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, `Ada ${'q'.repeat(150_000)}\n\nSecond line.`);
  const working = await content(ada, docId, 'working');
  await caret(ben, docId, 'Ada', 0, 3);
  const before = await sent(ben, docId);
  // About 120 KB: under the record cap alone, past it with the 150 KB after the selection.
  await pastePlain(ben, docId, `One ${'a'.repeat(60_000)}\nTwo ${'b'.repeat(60_000)}`);
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'refused visibly').toContainText('too large for one suggestion', { timeout: 60_000 });
  await settled(ben, docId, 'the refused paste');
  expect(await sent(ben, docId), 'nothing was sent').toBe(before);
  expect(await painted(ben, 'suggest-delete'), 'nothing is struck').toEqual([]);
  await expect(ui.body(ben, docId)).not.toContainText('One aaa');
  expect(await ben.page.evaluate(() => window.getSelection()?.toString()), 'the selection is kept').toBe('Ada');
  expect(await content(ada, docId, 'working'), 'no suggestion was made').toBe(working);
});

test('j16-paste: a paste inside a 150 KB paragraph either lands as one suggestion whose undo and redo are one step each, or is refused whole with nothing changed @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, `Lead words MID ${'q'.repeat(150_000)}\n\nSecond line.`);
  const body = ui.body(ben, docId);
  const refusal = ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  const working = await content(ada, docId, 'working');
  await caret(ben, docId, 'Lead words MID', 11, 3);
  const before = await sent(ben, docId);
  await pastePlain(ben, docId, `Alpha ${'c'.repeat(20_000)}\nBeta ${'d'.repeat(20_000)}`);
  // Either it is refused at once, or its one frame goes out.
  await expect.poll(async () => ((await refusal.textContent()) ?? '').includes('too large for one suggestion') || (await sent(ben, docId)) > before, { timeout: 60_000 }).toBe(true);
  if ((await sent(ben, docId)) === before) {
    await settled(ben, docId, 'the refused paste');
    expect(await painted(ben, 'suggest-delete'), 'nothing is struck').toEqual([]);
    await expect(body).not.toContainText('Alpha ccc');
    expect(await ben.page.evaluate(() => window.getSelection()?.toString()), 'the selection is kept').toBe('MID');
    expect(await content(ada, docId, 'working'), 'no suggestion was made').toBe(working);
    return;
  }
  await settled(ben, docId, 'the paste');
  expect(await sent(ben, docId) - before, 'the paste is one frame').toBe(1);
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the selection is struck' }).toEqual(['MID']);
  await expect(body).toContainText('Beta ddd');

  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  expect(await sent(ben, docId) - before, 'the undo is one frame').toBe(2);
  await expect(body, 'one undo takes the paste back').not.toContainText('Alpha ccc');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual([]);
  await expect.poll(() => content(ada, docId, 'working'), { message: 'nothing is suggested' }).toBe(working);

  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  expect(await sent(ben, docId) - before, 'the redo is one frame').toBe(3);
  await expect(body, 'one redo brings the paste back').toContainText('Beta ddd');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual(['MID']);
});

/** The notice of a suggestion the DocDO closed after a refused frame. */
const FORK_CLOSED = 'This suggestion was closed while you typed';

/** A real clipboard paste of HTML with its plain-text flavor, as from a browser page. */
const pasteRich = (actor: Actor, docId: string, html: string, plain: string) =>
  ui.body(actor, docId).evaluate((element, [h, p]) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', p);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, [html, plain] as const);

test('j16-paste: an admitted paste near the record cap at a paragraph end is stored with its one undo and its one redo; every further undo and redo is stored or refused with nothing changed @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const body = ui.body(ben, docId);
  const refusal = ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  const working = await content(ada, docId, 'working');
  await caret(ben, docId, 'Second line.', 12);
  const before = await sent(ben, docId);
  // About 90 KB, admitted with its one undo and its one redo: the redo re-creates it beside the paste's own op.
  await pastePlain(ben, docId, `Tail ${'f'.repeat(90_000)}`);
  await settled(ben, docId, 'the paste');
  expect(await sent(ben, docId) - before, 'the paste is one frame').toBe(1);
  await expect.poll(() => content(ada, docId, 'working'), { message: 'the paste is one pending suggestion' }).not.toBe(working);
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  expect(await sent(ben, docId) - before, 'the undo is one frame').toBe(2);
  await expect(body, 'one undo takes the paste back').not.toContainText('Tail fff');
  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  expect(await sent(ben, docId) - before, 'the redo is one frame').toBe(3);
  await expect(body, 'one redo brings the paste back').toContainText('Tail fff');
  await expect.poll(() => content(ada, docId, 'working'), { message: 'the redone paste is one pending suggestion' }).toContain('Tail fff');
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);

  // Each redo adds the paste to the record again: one past the cap is refused before it changes anything.
  let refused = false;
  for (let cycle = 2; cycle <= 3 && !refused; cycle += 1) {
    for (const [keys, has] of [[`${mod}+z`, false], [`${mod}+Shift+z`, true]] as const) {
      const frames = await sent(ben, docId);
      await expect(refusal).toHaveText('', { timeout: 10_000 });
      await ben.page.keyboard.press(keys);
      await expect.poll(async () => ((await refusal.textContent()) ?? '').includes('too large') || (await sent(ben, docId)) > frames, { timeout: 60_000 }).toBe(true);
      await settled(ben, docId, `${keys} in cycle ${cycle}`);
      if ((await sent(ben, docId)) === frames) {
        refused = true;
        if (has) await expect(body, 'a refused redo changes nothing').not.toContainText('Tail fff');
        else await expect(body, 'a refused undo changes nothing').toContainText('Tail fff');
        break;
      }
      expect(await sent(ben, docId) - frames, `${keys} in cycle ${cycle} is one frame`).toBe(1);
      if (has) await expect(body).toContainText('Tail fff');
      else await expect(body).not.toContainText('Tail fff');
    }
  }
  expect(refused, 'a redo past the record cap is refused').toBe(true);
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
});

test('j16-paste: a short paste replacing the suggester\'s own large suggestion is refused whole, or its undo is one stored step @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const body = ui.body(ben, docId);
  const refusal = ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  await caret(ben, docId, 'Second line.', 12);
  // One suggestion of some 140 KB, in two admitted pastes at the same caret.
  await pastePlain(ben, docId, `Tail ${'f'.repeat(90_000)}`);
  await settled(ben, docId, 'the first paste');
  await pastePlain(ben, docId, `More ${'g'.repeat(50_000)}`);
  await settled(ben, docId, 'the second paste');
  await expect(body).toContainText('More ggg');
  await expect(ben.page.getByText(FORK_CLOSED), 'both are stored').toHaveCount(0);
  const working = await content(ada, docId, 'working');
  // Lexical's paste removes his own selected text natively; its undo restores it as new copies in the record.
  await caret(ben, docId, 'Tail fff', 0, 5 + 90_000 + 5 + 50_000);
  const before = await sent(ben, docId);
  await pastePlain(ben, docId, 'x');
  await expect.poll(async () => ((await refusal.textContent()) ?? '').includes('too large') || (await sent(ben, docId)) > before, { timeout: 60_000 }).toBe(true);
  if ((await sent(ben, docId)) === before) {
    await settled(ben, docId, 'the refused paste');
    await expect(body, 'nothing changed').toContainText('More ggg');
    expect(await content(ada, docId, 'working'), 'the suggestion is unchanged').toBe(working);
    return;
  }
  await settled(ben, docId, 'the paste');
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  expect(await sent(ben, docId) - before, 'the undo is one frame').toBe(2);
  await expect(body, 'one undo takes the paste back').toContainText('More ggg');
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
});

test('j16-paste: a rich paste whose kept link attributes take it past the record cap is stored whole or refused whole, never refused after it changed the note @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  const body = ui.body(ben, docId);
  const refusal = ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  await caret(ben, docId, 'Second line.', 12);
  // About 90 KB as one suggestion, admitted with its redo; the rich paste goes on at its end, into the same record.
  await pastePlain(ben, docId, `Tail ${'f'.repeat(90_000)}`);
  await settled(ben, docId, 'the first paste');
  const working = await content(ada, docId, 'working');
  const before = await sent(ben, docId);
  // The link's title, 170 KB, becomes a property of its node; its text is 25 KB, under the record cap beside the first.
  const plain = `Linked ${'k'.repeat(25_000)}`;
  await pasteRich(ben, docId, `<p><a href="https://example.invalid/" title="${'T'.repeat(170_000)}">${plain}</a></p>`, plain);
  await expect.poll(async () => ((await refusal.textContent()) ?? '').includes('too large for one suggestion') || (await sent(ben, docId)) > before, { timeout: 60_000 }).toBe(true);
  if ((await sent(ben, docId)) === before) {
    await settled(ben, docId, 'the refused paste');
    await expect(body).not.toContainText('Linked kkk');
    expect(await content(ada, docId, 'working'), 'no suggestion was made').toBe(working);
    return;
  }
  await settled(ben, docId, 'the paste');
  await expect.poll(() => content(ada, docId, 'working'), { message: 'the paste is one pending suggestion' }).toContain('Linked kkk');
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
});

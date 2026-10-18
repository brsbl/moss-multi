// j16-paste (T5.R2, T5.S10; docs/design/suggestions.md §5, T3.S6): in Suggest mode a large paste is never batched. It is
// admitted against the suggestion caps before anything changes, the strike of a selection it replaces included, then
// lands in one transaction, one frame, one suggestion; or it is refused whole, visibly, with nothing struck or sent
// and the selection kept. One undo takes it back and one redo brings it back.
import type { Actor } from '../lib/actors.ts';
import { BODY_BINDING_ATTR, INPUT_REFUSAL_ATTR, SUGGEST_MARK_ATTR, SUGGESTIONS_BUTTON_ATTR } from '../lib/contract.ts';
import { pastePlain } from '../lib/paste.ts';
import { FORK_CLOSED, pasteHtml, sent, storedOrRefused, suggesting } from '../lib/suggest-paste.ts';
import { BIND_TIMEOUT, caret, content, mod, openIn, painted, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

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
  // first suggestion and so merges it. Alone it fits every cap with its redo, with nothing after it in its block (the
  // near-cap leg admits a paste of this size); with the first one it does not.
  await caret(ben, docId, 'Fourth line.', 12);
  const before = await sent(ben, docId);
  await pastePlain(ben, docId, `Second tail ${'g'.repeat(90_000)}`);
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

/** A real clipboard paste of markdown with its plain-text flavor, as from a markdown editor. */
const pasteMarkdown = (actor: Actor, docId: string, markdown: string) =>
  ui.body(actor, docId).evaluate((element, m) => {
    const data = new DataTransfer();
    data.setData('text/markdown', m);
    data.setData('text/plain', m);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  }, markdown);

test('j16-paste: a chart whose JSON sits on the opening fence line is measured as the import makes it: stored whole or refused whole, never dropped @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  await caret(ben, docId, 'Second line.', 12);
  // Lexical's code transformer reads the rest of the opening line as the code: a chart whose payload far outgrows its
  // 40 KB of JSON (two entries per array element), past the record cap.
  const config = { type: 'bar', data: [{ label: 'a', value: 1 }], options: { samples: new Array(20_000).fill(0) } };
  expect(await storedOrRefused(ben, ada, docId, () => pasteMarkdown(ben, docId, `\`\`\`moss-chart ${JSON.stringify(config)}\n\`\`\`\n`))).toBe('refused');
});

test('j16-paste: whitespace-preserving HTML makes a tab node per tab: the paste is measured with them, stored whole or refused whole, never dropped @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  await caret(ben, docId, 'Second line.', 12);
  // 20,000 tabs in 20 KB of HTML: Lexical makes each its own node, far past the record cap.
  expect(await storedOrRefused(ben, ada, docId, () => pasteHtml(ben, docId, `<b style="white-space: pre-wrap">${'\t'.repeat(20_000)}</b>`))).toBe('refused');
  // A short one lands whole, its tab nodes with it.
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`)).toHaveText('', { timeout: 15_000 });
  expect(await storedOrRefused(ben, ada, docId, () => pasteHtml(ben, docId, '<b style="white-space: pre-wrap">a\tb\tc</b>'), 'a\tb\tc')).toBe('stored');
});

test('j16-paste: a clipboard copied in the pane is measured through the pane\'s own importer (its serialized nodes): past the cap, refused whole, never dropped @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line.');
  await caret(ben, docId, 'Second line.', 12);
  // The pane's copy puts its serialized nodes on the clipboard under its namespace; Lexical pastes those, not the
  // small HTML and plain flavors beside them.
  const paste = () => ui.body(ben, docId).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'small');
    data.setData('application/x-lexical-editor', JSON.stringify({
      namespace: 'moss-markdown-editor',
      nodes: [{ type: 'text', text: 'x'.repeat(300_000), format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
    }));
    data.setData('text/html', '<p>small</p>');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
  });
  expect(await storedOrRefused(ben, ada, docId, paste)).toBe('refused');
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
});

test('j16-paste: an undone paste inside a paragraph, and an undone Enter, leave nothing suggested: nothing painted for either side, and no pending suggestion once idle @p:mean-2 @p:R17', async ({ actors }) => {
  test.setTimeout(240_000);
  actors.solo('the owner seeds the note and reviews; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, 'Ada original line.\n\nSecond line here.');
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'original', 0, 8);
  // About 9 KB of rich HTML in two paragraphs: the paste splits "Ada original line." after the struck word.
  const plain = `Rich one ${'r'.repeat(4_000)}\nRich two ${'s'.repeat(4_000)}`;
  await pasteRich(ben, docId, `<p>Rich one <b>${'r'.repeat(4_000)}</b></p><p>Rich two ${'s'.repeat(4_000)}</p>`, plain);
  await settled(ben, docId, 'the paste');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'the selection is struck' }).toEqual(['original']);
  await expect(body).toContainText('Rich two sss');

  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  await expect(body, 'one undo takes the paste back').not.toContainText('Rich');
  await expect(body).toContainText('Ada original line.');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual([]);
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'the paragraph\'s rest is not painted as inserted' }).toEqual([]);

  await ben.page.keyboard.press(`${mod}+Shift+z`);
  await settled(ben, docId, 'the redo');
  await expect(body, 'one redo brings the paste back').toContainText('Rich two sss');
  await expect.poll(() => painted(ben, 'suggest-delete'), { message: 'and the strike' }).toEqual(['original']);
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the second undo');
  await expect(body).not.toContainText('Rich');
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'nothing painted after the second undo' }).toEqual([]);

  // The control: Enter mid-paragraph, then its undo.
  await caret(ben, docId, 'Second line here.', 6);
  await ben.page.keyboard.press('Enter');
  await settled(ben, docId, 'the Enter');
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo of Enter');
  await expect(body).toContainText('Second line here.');
  await expect.poll(() => painted(ben, 'suggest-insert'), { message: 'nothing painted after the undo of Enter' }).toEqual([]);
  await expect.poll(() => painted(ben, 'suggest-delete')).toEqual([]);

  // When the system closes his records, his pane rebuilds F from the body (a closed record leaves the fork): a new
  // session and a new body root, declared.
  ben.expectReconnects(2, docId);
  // The owner, in Edit mode, sees none of her words struck and no insert marks.
  await openIn(ada, docId, 'edit');
  await expect(ui.body(ada, docId)).toContainText('Ada original line.');
  await expect.poll(() => painted(ada, 'suggest-delete'), { message: 'nothing struck for the owner' }).toEqual([]);
  await expect(ui.pane(ada, docId).locator(`[${SUGGEST_MARK_ATTR}]`), 'no insert marks').toHaveCount(0);
  // A record that changes nothing is rejected by the system once idle: no pending suggestion is left.
  await expect(ada.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`), 'no pending suggestion').toHaveAttribute('aria-label', 'Suggestions', { timeout: 120_000 });
  await expect(ben.page.locator(`[${SUGGESTIONS_BUTTON_ATTR}]`)).toHaveAttribute('aria-label', 'Suggestions', { timeout: BIND_TIMEOUT });
  await expect(ui.body(ben, docId)).toHaveAttribute(BODY_BINDING_ATTR, 'live', { timeout: BIND_TIMEOUT });
  await expect(body).toContainText('Ada original line.');
  await expect.poll(() => painted(ben, 'suggest-insert')).toEqual([]);
  await ben.declareRemount(docId);
});


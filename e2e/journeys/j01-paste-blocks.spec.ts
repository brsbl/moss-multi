// j01-paste-blocks (T3.S6): a paste of very many short blocks lands whole, or is refused whole. Lexical's insert and
// the Yjs binding each did work per block that grew with the blocks already placed, so 40,000 blank-line-separated
// short paragraphs held the tab for a minute and 100,000 froze it. Pasted between two paragraphs, 40,000 must keep
// the tab responsive, land every block, leave the caret after them, make one undo step that redoes whole, and reach a
// collaborator in full. 100,000 short paragraphs encode past the note's state cap (A§5.1): that paste is refused
// visibly as a whole, never frozen on and never half applied.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { exported, fingerprint, normalized, pasteAndCheck, pastePlain, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** `count` short paragraphs, blank-line separated, ending with a known last line. */
function shortParagraphs(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  return lines.join('\n\n');
}

test('j01-paste-blocks: 40,000 short paragraphs pasted between two paragraphs land whole without holding the tab, caret after them, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(400_000);
  const markdown = shortParagraphs(40_000);
  const { ada, ben, docId } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  expect(want.whole.split('\n\n').length, 'the reference export holds every paragraph').toBe(40_003);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId }, markdown, want, 120_000, 20_000);
});

test('j01-paste-blocks: 100,000 short paragraphs, past the note’s size cap, are refused as a whole and visibly @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(240_000);
  const { ada, ben, docId } = await setup(actors, stack, 'Kept.');
  await ui.waitAcked(ada, docId, 30_000);
  const before = await exported(ada, docId);
  const print = await fingerprint(ada, docId);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Kept\.$/ }).click();
  await ada.page.keyboard.press('End');
  const busyMs = await pastePlain(ada, docId, shortParagraphs(100_000));
  expect(busyMs, 'the refused paste keeps the tab responsive').toBeLessThan(20_000);
  await expect(ada.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the refusal is announced').toContainText('size limit', { timeout: 15_000 });
  await ui.waitAcked(ada, docId, 30_000);
  expect(await fingerprint(ada, docId), 'nothing of the paste is in the editor').toEqual(print);
  await ada.page.waitForTimeout(3_000);
  expect(await exported(ada, docId), 'nothing of the paste reached the server').toBe(before);
  expect(await fingerprint(ben, docId), 'nor the collaborator').toEqual(print);
  await ui.typeBody(ada, docId, ' Still typing.');
  await ui.waitAcked(ada, docId, 30_000);
  await expect.poll(() => exported(ada, docId), { message: 'the note stays editable', timeout: 30_000 }).toBe(await normalized(ada, stack, 'Kept. Still typing.'));
});

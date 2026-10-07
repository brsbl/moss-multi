// j01-paste-blocks (T3.S6): a paste of very many short blocks lands whole too. 100,000 blank-line-separated short
// paragraphs (about 400 KB) froze the tab before: Lexical's insert and the Yjs binding each did work per block that
// grew with the blocks already placed, and the spread of 150,000 blocks into one append() overflowed the stack. Such a
// paste, into an empty note and between two paragraphs, must land every block, leave the caret after it, make one
// undo step that redoes whole, and reach a collaborator in full, as j01-paste checks for mixed markdown.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { pasteAndCheck, normalized, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** `count` short paragraphs, blank-line separated, ending with a known last line. */
function shortParagraphs(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  return lines.join('\n\n');
}

test('j01-paste-blocks: 150,000 short paragraphs pasted into an empty note land whole, caret after them, one undo step, on both screens @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(330_000);
  const markdown = shortParagraphs(150_000);
  const { ada, ben, docId } = await setup(actors, stack);
  const want = { whole: await normalized(ada, stack, markdown), typed: await normalized(ada, stack, `${markdown}Z`) };
  expect(want.whole.split('\n\n').length, 'the reference export holds every paragraph').toBe(150_001);
  await ui.body(ada, docId).click();
  await pasteAndCheck({ ada, ben, docId }, markdown, want, 120_000);
});

test('j01-paste-blocks: 100,000 short paragraphs pasted between two paragraphs land whole, caret after them, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(330_000);
  const markdown = shortParagraphs(100_000);
  const { ada, ben, docId } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId }, markdown, want, 120_000);
});

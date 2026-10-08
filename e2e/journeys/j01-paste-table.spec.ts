// j01-paste-table (T3.S6): one large table pasted lands whole. A 5,000-row table is a single top-level block of
// several megabytes of Yjs state, which the doc socket sent as one frame the DocDO never took. Now it lands in
// batches of whole rows with the tab free between them, and goes out in frames within the client frame cap: every
// row reaches the server and a collaborator, the caret ends in the last cell, one undo step redoes whole, and the
// socket never closes.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { MAX_STALL_MS, normalized, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** A two-column table of `rows` rows; `last` ends the last cell. */
function table(rows: number, last = ''): string {
  const lines = ['| Name | Value |', '| --- | --- |'];
  for (let i = 0; i < rows; i += 1) lines.push(`| row ${i} | value ${i}${i === rows - 1 ? last : ''} |`);
  return lines.join('\n');
}

test('j01-paste-table: a 5,000-row table pasted between two paragraphs lands whole, in frames under the cap, without holding the tab, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = table(5_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    // The caret ends in the last cell, so typing lands there.
    typed: await normalized(ada, stack, `Before.\n\n${table(5_000, 'Z')}\n\nAfter.`),
  };
  expect(want.whole.split('\n').filter((line) => line.startsWith('| row ')).length, 'the reference export holds every row').toBe(5_000);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});

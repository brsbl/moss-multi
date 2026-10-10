// j01-paste-blocks (T3.S6): a paste of very many short blocks lands whole, or is refused whole. Lexical's insert and
// the Yjs binding each did work per block that grew with the blocks already placed, so 40,000 blank-line-separated
// short paragraphs held the tab for a minute and 100,000 froze it. Plain text lands like markdown, in paced batches.
// Pasted between two paragraphs, 40,000 must never hold the tab past MAX_STALL_MS until every piece is acked, land
// every block, leave the caret after them, make one undo step that redoes whole, and reach a collaborator in full.
// 100,000 short paragraphs encode past the note's state cap (A§5.1): that paste is refused visibly as a whole, never
// frozen on and never half applied.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { expectRefusedPaste, MAX_STALL_MS, normalized, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** `count` short paragraphs, blank-line separated, ending with a known last line. */
function shortParagraphs(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(`p${i}`);
  lines.push('Last line of the paste.');
  return lines.join('\n\n');
}

test('j01-paste-blocks: 40,000 short paragraphs pasted between two paragraphs land whole without holding the tab, caret after them, one undo step @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(600_000);
  const markdown = shortParagraphs(40_000);
  const { ada, ben, docId, wire } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  expect(want.whole.split('\n\n').length, 'the reference export holds every paragraph').toBe(40_003);
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  // About 20 MB of Yjs state: the doc socket sends it in acked 256 KiB pieces, about two minutes on a CI runner. The
  // tab is never held past the bound, from the paste until every piece is acked.
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 240_000, { maxBusyMs: MAX_STALL_MS, maxStallMs: MAX_STALL_MS });
});

test('j01-paste-blocks: 100,000 short paragraphs, past the note’s size cap, are refused as a whole and visibly @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(240_000);
  await expectRefusedPaste(await setup(actors, stack, 'Kept.'), stack, shortParagraphs(100_000), { checkWire: false });
});

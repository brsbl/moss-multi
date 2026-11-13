// j01-paste-blocks (T3.S6): a paste of very many short blocks lands whole, or is refused whole. Lexical's insert and
// the Yjs binding each did work per block that grew with the blocks already placed, so 40,000 blank-line-separated
// short paragraphs held the tab for a minute and 100,000 froze it. Plain text lands like markdown, in paced batches.
// Pasted between two paragraphs, short paragraphs must never hold the tab past MAX_STALL_MS until every piece is
// acked, land every block, leave the caret after them and reach a collaborator in full. The note's structure guard
// (A§5.1, T3.B31c) holds it to 165,000 structs, 5 for each short paragraph, and an undone paste's structs stay in its
// history: 12,000 leave room for one undo step that redoes whole; 32,800 are just under the guard; 33,000 are just
// past it, and that paste is refused visibly as a whole, with the structure notice, never half applied.
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { expectRefusedPaste, MAX_STALL_MS, pasteAndCheck, setup, STRUCTURE_NOTICE } from '../lib/paste.ts';
import { shortParagraphs } from '../lib/large-notes.ts';
import { expect, test, ui } from '../lib/test.ts';

const LEGS: [string, number, boolean][] = [
  ['12,000 short paragraphs pasted between two paragraphs land whole without holding the tab, caret after them, one undo step that redoes whole', 12_000, true],
  ['32,800 short paragraphs, just under the structure limit, pasted between two paragraphs land whole without holding the tab, caret after them', 32_800, false],
];

for (const [label, count, history] of LEGS) {
  test(`j01-paste-blocks: ${label} @p:col-1${history ? ' @p:col-3' : ''}`, async ({ actors, stack }) => {
    test.setTimeout(600_000);
    const markdown = shortParagraphs(count);
    const { ada, ben, docId, wire, want } = await setup(actors, stack, 'Before.\n\nAfter.', {
      references: { whole: `Before.\n\n${markdown}\n\nAfter.`, typed: `Before.\n\n${markdown}Z\n\nAfter.` },
    });
    expect(want.whole.split('\n\n').length, 'the reference export holds every paragraph').toBe(count + 3);
    await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
    await ada.page.keyboard.press('End');
    await ada.page.keyboard.press('Enter');
    // Up to about 5 MB of Yjs state: the doc socket sends it in acked 256 KiB pieces, about two minutes on a CI runner.
    // The tab is never held past the bound, from the paste until every piece is acked.
    await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 240_000, { maxBusyMs: MAX_STALL_MS, maxStallMs: MAX_STALL_MS, history });
  });
}

test('j01-paste-blocks: 33,000 short paragraphs, just past the structure limit, are refused as a whole and visibly @p:col-1', async ({ actors, stack }) => {
  test.setTimeout(240_000);
  await expectRefusedPaste(await setup(actors, stack, 'Kept.'), stack, shortParagraphs(33_000), {
    checkWire: false,
    notice: STRUCTURE_NOTICE,
    admission: ({ met }) => expect(met, 'the paste meets the structure limit').toBe('structure'),
  });
});

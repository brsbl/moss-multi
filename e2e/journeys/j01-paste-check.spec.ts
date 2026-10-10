// j01-paste-check (T3.S6): a large check list pasted, undone and redone keeps its written order. It lands in batches
// and redoes in slices, each adding items to a list placed earlier; moss's ChecklistSortPlugin took those changes for
// a checkbox toggle and moved the done items first (run 37718593043: two pairs of 2 MB of mixed markdown swapped).
//
// The notes and the reference imports are created through POST /api/docs as declared setup.
import { MAX_STALL_MS, normalized, pasteAndCheck, setup } from '../lib/paste.ts';
import { expect, test, ui } from '../lib/test.ts';

/** A check list of `count` items, open and done alternating, as written: moss sorts done items first only on a toggle. */
function checklist(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) lines.push(i % 2 === 0 ? `- [ ] open ${i}` : `- [x] done ${i}`);
  return lines.join('\n');
}

test('j01-paste-check: a 12,000-item check list pasted between two paragraphs lands in its own order, and its undo and redo keep it @p:col-1 @p:col-3', async ({ actors, stack }) => {
  test.setTimeout(900_000);
  const markdown = `${checklist(12_000)}\n\nEnd of the list.`;
  const { ada, ben, docId, wire } = await setup(actors, stack, 'Before.\n\nAfter.');
  const want = {
    whole: await normalized(ada, stack, `Before.\n\n${markdown}\n\nAfter.`),
    typed: await normalized(ada, stack, `Before.\n\n${markdown}Z\n\nAfter.`),
  };
  expect(want.whole, 'the reference export keeps the written order').toContain('- [ ] open 0\n- [x] done 1\n- [ ] open 2');
  await ui.body(ada, docId).locator('p').filter({ hasText: /^Before\.$/ }).click();
  await ada.page.keyboard.press('End');
  await ada.page.keyboard.press('Enter');
  await pasteAndCheck({ ada, ben, docId, wire }, markdown, want, 300_000, { maxStallMs: MAX_STALL_MS });
});

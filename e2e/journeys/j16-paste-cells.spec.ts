// j16-paste-cells (T5.S10; docs/design/suggestions.md §5): in Suggest mode a paste Lexical would write over table cells,
// removing what they hold, never removes text unstruck and never leaves an undo it then refuses: it is refused whole
// with nothing changed, or stored with what it replaces struck and its one undo admitted.
import type { Actor } from '../lib/actors.ts';
import { INPUT_REFUSAL_ATTR } from '../lib/contract.ts';
import { pastePlain } from '../lib/paste.ts';
import { FORK_CLOSED, pasteHtml, storedOrRefused, suggesting } from '../lib/suggest-paste.ts';
import { caret, mod, painted, settled } from '../lib/suggest.ts';
import { expect, test, ui } from '../lib/test.ts';

const TABLE_NOTE = 'Ada original line.\n\n| alpha | beta |\n| --- | --- |\n| gamma | delta |';

/** A mouse drag from the cell holding `from` to the cell holding `to`: Lexical selects the cells between. */
async function dragCells(actor: Actor, docId: string, from: string, to: string): Promise<void> {
  const cell = (text: string) => ui.body(actor, docId).locator('td, th', { hasText: text }).first();
  // The table's first row in mid-view, clear of the bar above the note: a cell many screens tall below it starts in view.
  await ui.body(actor, docId).locator('tr').first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
  const start = (await cell(from).boundingBox())!;
  const end = (await cell(to).boundingBox())!;
  await actor.page.mouse.move(start.x + 30, start.y + 20);
  await actor.page.mouse.down();
  await actor.page.mouse.move(end.x + 30, end.y + 20, { steps: 10 });
  await actor.page.mouse.up();
  await expect(ui.body(actor, docId).locator('table.moss-table-selection'), 'the cells are selected').toHaveCount(1);
}

test('j16-paste-cells: a short paste over table cells holding the suggester\'s own large text is refused whole, or its one undo brings that text back @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, TABLE_NOTE);
  const body = ui.body(ben, docId);
  await caret(ben, docId, 'gamma', 5);
  const own = `Own ${'o'.repeat(110_000)}`;
  expect(await storedOrRefused(ben, ada, docId, () => pastePlain(ben, docId, own)), 'the large paste in a cell lands').toBe('stored');
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`)).toHaveText('', { timeout: 15_000 });
  await dragCells(ben, docId, 'gamma', 'delta');
  if (await storedOrRefused(ben, ada, docId, () => pasteHtml(ben, docId, '<p>short</p>')) === 'refused') return;
  await ben.page.keyboard.press(`${mod}+z`);
  await settled(ben, docId, 'the undo');
  await expect(ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`), 'the undo is admitted').toHaveText('');
  await expect(body, 'one undo brings his text back').toContainText(own.slice(0, 2_000));
  await expect(ben.page.getByText(FORK_CLOSED), 'the suggestion stays open').toHaveCount(0);
});

test('j16-paste-cells: a paste over table cells, or a table pasted in a cell, never removes another author\'s text unstruck: refused whole, or struck and kept visible @p:mean-2 @p:R17', async ({ actors }) => {
  actors.solo('the owner only seeds the note; one suggester pastes');
  const { ada, ben, docId } = await suggesting(actors, TABLE_NOTE);
  const body = ui.body(ben, docId);
  const refusal = ben.page.locator(`[${INPUT_REFUSAL_ATTR}]`);
  await caret(ben, docId, 'alpha', 0);
  await dragCells(ben, docId, 'alpha', 'delta');
  if (await storedOrRefused(ben, ada, docId, () => pastePlain(ben, docId, 'cellpaste')) === 'stored') {
    for (const word of ['alpha', 'beta', 'gamma', 'delta']) await expect(body, `${word} stays`).toContainText(word);
    expect(await painted(ben, 'suggest-delete'), 'what it replaced is struck').not.toEqual([]);
    return;
  }
  await expect(refusal).toHaveText('', { timeout: 15_000 });
  // A table at a caret in a cell: Lexical writes its cells over the grid from there.
  await caret(ben, docId, 'gamma', 5);
  if (await storedOrRefused(ben, ada, docId, () => pasteHtml(ben, docId, '<table><tr><td>one</td><td>two</td></tr></table>')) === 'stored') {
    for (const word of ['gamma', 'delta']) await expect(body, `${word} stays`).toContainText(word);
    expect(await painted(ben, 'suggest-delete'), 'what it overwrote is struck').not.toEqual([]);
  }
});

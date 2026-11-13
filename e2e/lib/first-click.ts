// The first click into a table just inserted from the slash menu (T9.21). With the caret on an empty line of `root`,
// it inserts the table, clicks one body cell and types, and reports the cell the text landed in. Shared by the j01
// leg and the probe against pristine moss (e2e/parity/first-click.spec.ts).
//   quick: the pointer arrives and clicks at once, as a test driver's click does (move, down, up, no pause).
//   paced: the pointer arrives, rests, and the button is held briefly, as a person's click does.
import { expect, type Locator, type Page } from '@playwright/test';

export type ClickPace = 'quick' | 'paced';

export interface FirstClick {
  /** The cell the insert left the caret in, as [row, column]. */
  inserted: [number, number] | null;
  /** The cell the typed text landed in, or null when it landed in no cell. */
  landed: [number, number] | null;
  /** Every cell's text, row by row. */
  cells: string[][];
}

const frames = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** The [row, column] of the cell holding the DOM caret, inside `root`. */
const caretCell = (root: Locator): Promise<[number, number] | null> => root.evaluate((element): [number, number] | null => {
  const node = getSelection()?.anchorNode;
  const start = node && (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
  const cell = start && element.contains(start) ? start.closest('td, th') as HTMLTableCellElement | null : null;
  return cell ? [(cell.parentElement as HTMLTableRowElement).rowIndex, cell.cellIndex] : null;
});

/** "/table" and Enter, once the menu's first command is Table. */
export async function slashTable(page: Page, root: Locator): Promise<Locator> {
  const tables = await root.locator('table').count();
  await page.keyboard.type('/table');
  await expect.poll(() => page.locator('button[data-index] .text-sm.font-medium').first().textContent().then((label) => label?.trim()), {
    message: '/table puts Table first in the slash menu',
  }).toBe('Table');
  await page.keyboard.press('Enter');
  await expect(root.locator('table'), 'the slash menu inserts a table').toHaveCount(tables + 1);
  return root.locator('table').nth(tables);
}

export async function firstClick(page: Page, root: Locator, table: Locator, [row, column]: [number, number], pace: ClickPace, typed: string): Promise<FirstClick> {
  await frames(page);
  const inserted = await caretCell(root);
  const box = await table.locator('tr').nth(row).locator('td, th').nth(column).boundingBox();
  if (!box) throw new Error('the cell is not visible');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (pace === 'quick') {
    await page.mouse.click(x, y);
  } else {
    await page.mouse.move(x, y, { steps: 5 });
    await page.waitForTimeout(300);
    await page.mouse.down();
    await page.waitForTimeout(120);
    await page.mouse.up();
  }
  // Lexical takes the click's selection from the selectionchange that follows it.
  await page.evaluate(() => new Promise((done) => {
    document.addEventListener('selectionchange', () => setTimeout(done, 50), { once: true });
    setTimeout(done, 500);
  }));
  await page.keyboard.type(typed);
  await frames(page);
  const cells = await table.evaluate((element) => [...(element as HTMLTableElement).rows].map((tr) => [...tr.cells].map((cell) => cell.textContent ?? '')));
  const at = cells.flatMap((cellsOfRow, r) => cellsOfRow.flatMap((text, c) => (text.includes(typed) ? [[r, c] as [number, number]] : [])));
  return { inserted, landed: at[0] ?? null, cells };
}

// Arrowing below a note's last block (T9.2): put the caret at the end of `start`, press ArrowDown `presses` times,
// then type. After each ArrowDown it records where the DOM selection is while the editor root has focus: `inside`,
// `none` (no range, as a node selection leaves it), or `outside` (the selection left the editor). Shared by the j01
// leg and the probe against pristine moss (e2e/parity/arrow-below.spec.ts).
import type { Locator, Page } from '@playwright/test';

export type Where = 'inside' | 'none' | 'outside' | 'unfocused';

export interface ArrowBelow {
  /** Where the DOM selection was after each ArrowDown. */
  after: Where[];
  /** The root's last block once the text is typed: its tag and text. */
  last: { tag: string; text: string };
  /** The root's whole text once the text is typed. */
  text: string;
}

const where = (root: Locator): Promise<Where> => root.evaluate((element): Where => {
  if (!element.contains(document.activeElement)) return 'unfocused';
  const selection = getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.anchorNode) return 'none';
  return element.contains(selection.anchorNode) && element.contains(selection.focusNode) ? 'inside' : 'outside';
});

export async function arrowBelow(page: Page, root: Locator, start: Locator, presses: number, typed: string): Promise<ArrowBelow> {
  await start.scrollIntoViewIfNeeded();
  const box = await start.boundingBox();
  if (!box) throw new Error('the start line is not visible');
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await page.keyboard.press('End');
  const after: Where[] = [];
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('ArrowDown');
    // Lexical applies the selection a frame after the key.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    after.push(await where(root));
  }
  await page.keyboard.type(typed);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const { last, text } = await root.evaluate((element) => {
    const child = element.lastElementChild;
    return { last: { tag: child?.tagName ?? '', text: child?.textContent ?? '' }, text: element.textContent ?? '' };
  });
  return { after, last, text };
}

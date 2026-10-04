// SP10 (T4.0, A§13): comment highlights are derived paint. This probes, in each CI engine, what the design relies on:
// the CSS Custom Highlight API paints background and underline over a contenteditable without one DOM mutation,
// two overlapping comments both paint, Range geometry places a gutter icon, a pointer hit-test finds the comment
// with no element to target, and a live Range does not survive a text node's data being replaced (Lexical's way of
// writing text), so paint is recomputed from anchors after every update.
import { PNG } from 'pngjs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.ts';

const COMMENT = [251, 242, 224];
const OTHER = [120, 220, 120];
const UNDERLINE = [0, 0, 255];

const PAGE = `<!doctype html><html><head><style>
  body { margin: 0; background: #fff; color: #000; font: 24px/1.8 monospace; }
  #editor { padding: 40px; width: 900px; outline: none; caret-color: transparent; }
  ::highlight(spike-comment-0) { background-color: rgb(${COMMENT}); }
  ::highlight(spike-comment-1) { background-color: rgb(${OTHER}); }
  ::highlight(spike-comment-active) { text-decoration: underline; text-decoration-color: rgb(${UNDERLINE}); text-decoration-thickness: 3px; }
</style></head><body><div id="editor" contenteditable="true"><p>The quick brown fox jumps over the lazy dog.</p><p>Second paragraph here.</p></div></body></html>`;

interface Box { x: number; y: number; width: number; height: number }

/** Paints the anchors as highlights, the way the comment paint layer will: ranges rebuilt from offsets every time. */
async function paint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const text = document.querySelector('#editor p')!.firstChild as Text;
    const range = (start: number, end: number) => {
      const r = document.createRange();
      r.setStart(text, start);
      r.setEnd(text, end);
      return r;
    };
    const at = (word: string) => text.data.indexOf(word);
    const brownFox = range(at('brown fox'), at('brown fox') + 'brown fox'.length);
    CSS.highlights.set('spike-comment-0', new Highlight(brownFox));
    CSS.highlights.set('spike-comment-1', new Highlight(range(at('fox jumps'), at('fox jumps') + 'fox jumps'.length)));
    CSS.highlights.set('spike-comment-active', new Highlight(brownFox));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** The CSS-pixel box of `word` in the first paragraph. */
const boxOf = (page: Page, word: string) => page.evaluate((target) => {
  const text = document.querySelector('#editor p')!.firstChild as Text;
  const r = document.createRange();
  r.setStart(text, text.data.indexOf(target));
  r.setEnd(text, text.data.indexOf(target) + target.length);
  const { x, y, width, height } = r.getBoundingClientRect();
  return { x, y, width, height };
}, word);

/** Share of pixels in `box` within 6 per channel of `rgb`, from a real screenshot at the project's 2x scale. */
async function share(page: Page, box: Box, rgb: number[], band?: 'bottom'): Promise<number> {
  const clip = band ? { x: box.x, y: box.y + box.height - 10, width: box.width, height: 10 } : box;
  const png = PNG.sync.read(await page.screenshot({ clip }));
  let hits = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (rgb.every((value, channel) => Math.abs(png.data[i + channel] - value) <= 6)) hits += 1;
  }
  return hits / (png.width * png.height);
}

test.describe('SP10: comment paint without touching the tree', () => {
  test('SP10 the Custom Highlight API paints overlapping comments with zero DOM mutations', async ({ page }) => {
    await page.setContent(PAGE);
    expect(await page.evaluate(() => typeof Highlight === 'function' && 'highlights' in CSS)).toBe(true);
    const before = await page.evaluate(() => {
      const editor = document.querySelector('#editor')!;
      const records: MutationRecord[] = [];
      new MutationObserver((list) => records.push(...list)).observe(editor, { subtree: true, childList: true, attributes: true, characterData: true });
      (window as unknown as { records: MutationRecord[] }).records = records;
      return editor.innerHTML;
    });
    await paint(page);
    expect(await page.evaluate(() => document.querySelector('#editor')!.innerHTML)).toBe(before);
    expect(await page.evaluate(() => (window as unknown as { records: MutationRecord[] }).records.length)).toBe(0);

    expect(await share(page, await boxOf(page, 'brown'), COMMENT), 'comment 0 paints its background').toBeGreaterThan(0.3);
    expect(await share(page, await boxOf(page, 'jumps'), OTHER), 'comment 1 paints its background').toBeGreaterThan(0.3);
    expect(await share(page, await boxOf(page, 'fox'), COMMENT) + await share(page, await boxOf(page, 'fox'), OTHER), 'the overlap paints').toBeGreaterThan(0.3);
    expect(await share(page, await boxOf(page, 'brown'), UNDERLINE, 'bottom'), 'the active comment is underlined').toBeGreaterThan(0.05);
    expect(await share(page, await boxOf(page, 'lazy'), COMMENT), 'unpainted text stays clean').toBe(0);
    expect(await share(page, await boxOf(page, 'lazy'), UNDERLINE, 'bottom')).toBe(0);
  });

  test('SP10 Range geometry places a gutter icon and a pointer hit-test finds the comment under it', async ({ page }) => {
    await page.setContent(PAGE);
    await paint(page);
    const found = await page.evaluate(() => {
      const paragraph = document.querySelector('#editor p')!;
      const comment = [...CSS.highlights.get('spike-comment-0')!][0] as Range;
      const rect = comment.getBoundingClientRect();
      const line = paragraph.getBoundingClientRect();
      const hit = (x: number, y: number) => {
        const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
        const position = doc.caretPositionFromPoint?.(x, y);
        if (position) return comment.isPointInRange(position.offsetNode, position.offset);
        const caret = document.caretRangeFromPoint(x, y);
        return caret ? comment.isPointInRange(caret.startContainer, caret.startOffset) : null;
      };
      const lazy = document.createRange();
      const text = paragraph.firstChild as Text;
      lazy.setStart(text, text.data.indexOf('lazy'));
      lazy.setEnd(text, text.data.indexOf('lazy') + 4);
      const away = lazy.getBoundingClientRect();
      return {
        withinLine: rect.top >= line.top - 1 && rect.bottom <= line.bottom + 1,
        top: rect.top - line.top,
        inside: hit(rect.left + rect.width / 2, rect.top + rect.height / 2),
        outside: hit(away.left + away.width / 2, away.top + away.height / 2),
      };
    });
    expect(found.withinLine).toBe(true);
    expect(found.top).toBeLessThan(4);
    expect(found.inside).toBe(true);
    expect(found.outside).toBe(false);
  });

  test('SP10 a replaced text node collapses a live Range, so paint is rebuilt from anchors after typing', async ({ page }) => {
    await page.setContent(PAGE);
    await paint(page);
    const collapsed = await page.evaluate(() => {
      const comment = [...CSS.highlights.get('spike-comment-0')!][0] as Range;
      const text = document.querySelector('#editor p')!.firstChild as Text;
      // Lexical writes a changed text node as a whole `nodeValue`, which the DOM treats as replacing all its data.
      text.nodeValue = text.data.replace('quick', 'quick and nimble');
      return comment.collapsed;
    });
    expect(collapsed).toBe(true);

    await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('#editor')!;
      editor.focus();
      const text = document.querySelector('#editor p')!.firstChild as Text;
      const selection = window.getSelection()!;
      selection.collapse(text, text.data.length);
    });
    await page.keyboard.type('Typed');
    await paint(page);
    expect(await page.evaluate(() => document.querySelector('#editor p')!.textContent)).toBe('The quick and nimble brown fox jumps over the lazy dog.Typed');
    expect(await share(page, await boxOf(page, 'brown'), COMMENT), 'repainted after typing').toBeGreaterThan(0.3);
    expect(await share(page, await boxOf(page, 'Typed'), COMMENT)).toBe(0);
  });
});

// Selection cases (T3.10, feature `selection-1`) the viewer and editor fixtures both run on e2e/fixtures/selection-note.md:
// where each selection starts and ends in the rendered body, and the MossSelection it must return. Lines are 1-based
// in the note file, title line included; `lines` is golden-compared against the file's own lines by the specs.
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export const SELECTION_NOTE = readFileSync(new URL('../fixtures/selection-note.md', import.meta.url), 'utf8');
export const SELECTION_TITLE = 'Field Notes';
/** The note's comment thread, so the editor keeps the `%%m:c1` marker (desktop's compact serializer). */
export const SELECTION_COMMENTS = JSON.stringify({
  c1: { text: 'Check this', createdAt: 1_779_916_200, updatedAt: 1_779_916_200, source: 'user' },
  c2: { text: 'And this block', createdAt: 1_779_916_200, updatedAt: 1_779_916_200, source: 'user' },
});

export interface MossSelection {
  text: string;
  markdown: string;
  lines: { start: number; end: number };
  headings: string[];
  blocks: { type: string; line: number; heading?: string }[];
}

export interface SelectionCase {
  name: string;
  /** The selection starts at this text's first character and ends after `to`'s last. */
  from: string;
  to: string;
  /** Narrows the search to an element inside the body (a code block's `code`). */
  within?: string;
  /** Which match of `within` (the editor: which code block), 0 by default. */
  nth?: number;
  expected: MossSelection;
}

export const SELECTION_CASES: SelectionCase[] = [
  {
    name: 'across a heading and a paragraph',
    from: 'nting',
    to: 'Sow the beans',
    expected: {
      text: 'nting\nSow the beans',
      markdown: '## Planting\n\nSow the beans after the last frost.',
      lines: { start: 5, end: 7 },
      headings: ['Planting'],
      blocks: [
        { type: 'heading', line: 5, heading: 'Planting' },
        { type: 'paragraph', line: 7, heading: 'Planting' },
      ],
    },
  },
  {
    name: 'a commented phrase, with no marker',
    from: 'commented',
    to: 'phrase',
    expected: {
      text: 'commented phrase',
      markdown: 'Intro with a commented phrase inside.',
      lines: { start: 3, end: 3 },
      headings: [],
      blocks: [{ type: 'paragraph', line: 3 }],
    },
  },
  {
    name: 'inside a list',
    from: 'Second item',
    to: 'Nested',
    expected: {
      text: 'Second item\nNested',
      markdown: '- Second item\n    - Nested item',
      lines: { start: 10, end: 11 },
      headings: ['Planting'],
      blocks: [{ type: 'list', line: 9, heading: 'Planting' }],
    },
  },
  {
    name: 'inside a table',
    from: 'Beans',
    to: '10',
    expected: {
      text: 'Beans\t8\nPeas\t10',
      markdown: '| Beans | 8 |\n| Peas | 10 |',
      lines: { start: 16, end: 17 },
      headings: ['Planting'],
      blocks: [{ type: 'table', line: 14, heading: 'Planting' }],
    },
  },
  {
    name: 'inside a code block',
    from: 'sow(crop)',
    to: 'return',
    within: 'code',
    expected: {
      text: 'sow(crop):\n    return',
      markdown: 'def sow(crop):\n    return crop',
      lines: { start: 20, end: 21 },
      headings: ['Planting'],
      blocks: [{ type: 'code-block', line: 19, heading: 'Planting' }],
    },
  },
  {
    name: 'from a list into a code block',
    from: 'Third item',
    to: 'sow(crop',
    expected: {
      text: 'Third item\nCrop\tWeeks\nBeans\t8\nPeas\t10\ndef sow(crop',
      markdown: '- Third item\n\n| Crop | Weeks |\n| --- | --- |\n| Beans | 8 |\n| Peas | 10 |\n\n```python\ndef sow(crop):',
      lines: { start: 12, end: 20 },
      headings: ['Planting'],
      blocks: [
        { type: 'list', line: 9, heading: 'Planting' },
        { type: 'table', line: 14, heading: 'Planting' },
        { type: 'code-block', line: 19, heading: 'Planting' },
      ],
    },
  },
  {
    name: 'from a code block into the heading after it',
    from: 'return crop',
    to: 'Harvest',
    expected: {
      text: 'return crop\nHarvest',
      markdown: '    return crop\n```\n\n### Harvest',
      lines: { start: 21, end: 24 },
      headings: ['Planting'],
      blocks: [
        { type: 'code-block', line: 19, heading: 'Planting' },
        { type: 'heading', line: 24, heading: 'Harvest' },
      ],
    },
  },
  {
    name: 'inside a commented code block',
    from: 'x = 1',
    to: 'y = 2',
    within: 'code',
    nth: 1,
    expected: {
      text: 'x = 1;\nlet y = 2',
      markdown: 'let x = 1;\nlet y = 2;',
      lines: { start: 30, end: 31 },
      headings: ['Planting', 'Harvest'],
      blocks: [{ type: 'code-block', line: 28, heading: 'Harvest' }],
    },
  },
  {
    name: 'under a nested heading',
    from: 'Pick',
    to: 'every',
    expected: {
      text: 'Pick every',
      markdown: 'Pick every morning.',
      lines: { start: 26, end: 26 },
      headings: ['Planting', 'Harvest'],
      blocks: [{ type: 'paragraph', line: 26, heading: 'Harvest' }],
    },
  },
];

/** Sets the DOM selection from `from`'s start to `to`'s end, searching the text under `root` (and `within`). */
export async function selectText(page: Page, root: string, from: string, to: string, within?: string, nth = 0): Promise<void> {
  await page.evaluate(
    ({ root, from, to, within, nth }) => {
      const scope = document.querySelector(root);
      const container = within ? scope?.querySelectorAll(within)[nth] : scope;
      if (!container) throw new Error(`no ${root} ${within ?? ''}`);
      const nodes: Text[] = [];
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
      const all = nodes.map((node) => node.data).join('');
      const locate = (index: number) => {
        let rest = index;
        for (const node of nodes) {
          if (rest <= node.data.length) return { node, offset: rest };
          rest -= node.data.length;
        }
        throw new Error(`offset ${index} is past the text`);
      };
      const start = all.indexOf(from);
      const end = all.indexOf(to, start) + to.length;
      if (start < 0 || end < to.length) throw new Error(`no ${from} … ${to}`);
      // An end exactly at a node's end resolves into that node, not the next one.
      const a = locate(start);
      const b = locate(end);
      if (a.offset === a.node.data.length) {
        const next = nodes[nodes.indexOf(a.node) + 1];
        if (next) Object.assign(a, { node: next, offset: 0 });
      }
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { root, from, to, within, nth },
  );
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** Collapses the DOM selection inside the first text node holding `text`. */
export async function collapseIn(page: Page, root: string, text: string): Promise<void> {
  await page.evaluate(
    ({ root, text }) => {
      const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node as Text).data.indexOf(text);
        if (at < 0) continue;
        document.getSelection()?.collapse(node, at + 2);
        return;
      }
      throw new Error(`no ${text}`);
    },
    { root, text },
  );
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
}

/** `lines` golden-compared against a note file: the lines it names are the selection's markdown, markers aside. */
export function expectLinesIn(file: string, selection: MossSelection): void {
  const named = file.split('\n').slice(selection.lines.start - 1, selection.lines.end).join('\n');
  expect(named.replace(/%%m:[A-Za-z0-9_,\-\s]+?:(?:start|end)%%/g, ''), 'the lines name the selection in the file').toBe(selection.markdown);
  for (const block of selection.blocks) {
    expect(file.split('\n')[block.line - 1], `block ${block.type} starts on its line`).not.toBe('');
  }
}

/** No `%%m:` marker in any field. */
export function expectNoMarker(selection: MossSelection): void {
  expect(JSON.stringify(selection)).not.toContain('%%m:');
}

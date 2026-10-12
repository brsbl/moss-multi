// moss's table parsing (markdown/transformers.ts) runs its row scans through helpers in markdown/linear-match.ts: each
// gives moss's own result over random token strings, and the caps on a row's cells, on the padding a widening row adds
// and on a cell's absorbing of broken rows leave ordinary tables as moss makes them.
import {
  mergeWikiLinkCells,
  oddBackslashesBefore,
  repairBacktickWrappedCells,
  TABLE_PADDING_CELLS,
  TABLE_ROW_CELLS,
} from '@moss-desktop/renderer/editor/markdown/linear-match';
import { LINEAR_IMPORT_LIMITS } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { $getRoot, $isElementNode, type LexicalNode } from 'lexical';
import { $isTableCellNode, $isTableNode } from '@lexical/table';
import { describe, expect, it } from 'vitest';
import { importMarkdown } from './index.ts';

// moss's code at the pin, which the helpers replace.
const isEscapedTableChar = (content: string, index: number): boolean => {
  let backslashCount = 0;
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) backslashCount++;
  return backslashCount % 2 === 1;
};
const repairMalformedSingleBacktickWrappedTableCells = (rowContent: string): string =>
  rowContent.replace(/(^|\|\s*)`([^|\n]*\\`[^|\n]*\\`[^|\n]*)`(?=\s*\||$)/g, (_match, prefix: string, inner: string) => `${prefix}${inner.replace(/\\`/g, '`')}`);
const hasUnclosedWikiLink = (content: string): boolean => (content.match(/\[\[/g) || []).length > (content.match(/\]\]/g) || []).length;
const mergeBrokenWikiLinkCells = (cells: string[]): string[] => {
  const healed: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const current = cells[i];
    if (!hasUnclosedWikiLink(current)) {
      healed.push(current);
      continue;
    }
    let mergedCandidate = current;
    let endIndex = i;
    while (endIndex + 1 < cells.length && hasUnclosedWikiLink(mergedCandidate)) {
      endIndex += 1;
      mergedCandidate += `|${cells[endIndex]}`;
    }
    if (!hasUnclosedWikiLink(mergedCandidate)) {
      healed.push(mergedCandidate);
      i = endIndex;
      continue;
    }
    healed.push(current);
  }
  return healed;
};

function* fuzz(count: number, seed: number, tokens: string[], maxTokens: number): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const length = next() % maxTokens;
    let text = '';
    for (let j = 0; j < length; j += 1) text += tokens[next() % tokens.length];
    yield text;
  }
}

const count = (node: LexicalNode, test: (node: LexicalNode) => boolean): number =>
  (test(node) ? 1 : 0) + ($isElementNode(node) ? node.getChildren().reduce((sum, child) => sum + count(child, test), 0) : 0);
const shape = (markdown: string) =>
  importMarkdown(markdown)
    .getEditorState()
    .read(() => $getRoot().getChildren().map((block) => ($isTableNode(block) ? `table ${block.getChildrenSize()}x${count(block.getFirstChildOrThrow(), $isTableCellNode)}` : block.getType())));

describe('linear table parsing @p:tech-4', () => {
  it('finds the escaped characters moss finds, one scan of a row asking at every index', () => {
    const differing: string[] = [];
    for (const text of fuzz(20_000, 3, ['\\', '\\\\', '|', 'a', '`', '[['], 30)) {
      const run = { start: 0, end: 0 };
      for (let index = 0; index <= text.length + 1; index += 1) {
        if (oddBackslashesBefore(text, index, run) !== isEscapedTableChar(text, index) || oddBackslashesBefore(text, index) !== isEscapedTableChar(text, index)) {
          differing.push(`${JSON.stringify(text)} at ${index}`);
          break;
        }
      }
      if (differing.length === 5) break;
    }
    expect(differing).toEqual([]);
  });

  it('repairs backtick-wrapped cells as moss\'s regex does', () => {
    const tokens = ['`', '\\`', '``', '|', ' ', '  ', '\n', '\t', 'a', '\\', '| `'];
    const differing = [...fuzz(40_000, 5, tokens, 24)].filter((row) => repairBacktickWrappedCells(row) !== repairMalformedSingleBacktickWrappedTableCells(row));
    expect(differing.slice(0, 5)).toEqual([]);
  });

  it('merges cells split inside wiki links as moss does', () => {
    const cells = [...fuzz(40_000, 7, ['[[', ']]', '[', ']', 'a', '\\[[', ' '], 6)];
    const differing: string[][] = [];
    for (let i = 0; i + 12 <= cells.length && differing.length < 5; i += 12) {
      const row = cells.slice(i, i + 1 + (i % 11));
      if (JSON.stringify(mergeWikiLinkCells(row)) !== JSON.stringify(mergeBrokenWikiLinkCells(row))) differing.push(row);
    }
    expect(differing).toEqual([]);
  });

  it('makes a table of a row of TABLE_ROW_CELLS cells, and keeps a wider row as a paragraph', () => {
    expect(shape(`|${' x |'.repeat(TABLE_ROW_CELLS)}`)).toEqual([`table 1x${TABLE_ROW_CELLS}`]);
    expect(shape(`|${' x |'.repeat(TABLE_ROW_CELLS + 1)}`)).toEqual(['paragraph']);
  }, 120_000);

  it('widens a table unless that pads its earlier rows with more than TABLE_PADDING_CELLS cells', () => {
    const table = (rows: number) => `| a | b |\n| --- | --- |\n${'| c | d |\n'.repeat(rows)}| e | f | g | h |`;
    expect(shape(table(100))).toEqual(['table 102x4']);
    const rows = TABLE_PADDING_CELLS / 2 + 10;
    expect(shape(table(rows))[0]).toBe(`table ${rows + 1}x2`);
  }, 120_000);

  // A row narrower than its table is padded with empty cells, each a cell's work: the import pays for them as for the
  // row's own, and a row it cannot pay for is not a table row, so narrow rows under a wide header stay within perNote.
  it('pays for the empty cells a narrow row is padded with', () => {
    const note = [`|${' h |'.repeat(64)}`, `|${' --- |'.repeat(64)}`, ...Array.from({ length: 200 }, () => '| b | c |')].join('\n');
    expect(shape(note)).toEqual(['table 201x64']);
    const perNote = LINEAR_IMPORT_LIMITS.perNote;
    try {
      LINEAR_IMPORT_LIMITS.perNote = 20_000_000;
      const blocks = shape(note);
      const rows = Number(/^table (\d+)x64$/.exec(blocks[0])?.[1]);
      expect(rows).toBeGreaterThan(1);
      expect(rows).toBeLessThan(40);
      // The rows after are paragraph lines, joined into paragraphs as adjacent lines are.
      expect(blocks.length).toBeGreaterThan(1);
      expect(blocks.slice(1).every((block) => block === 'paragraph')).toBe(true);
    } finally {
      LINEAR_IMPORT_LIMITS.perNote = perNote;
    }
  }, 120_000);
});

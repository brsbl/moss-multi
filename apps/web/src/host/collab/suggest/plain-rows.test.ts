// T9.9: a card's rows read in plain words. Node names, Lexical field names and `value:` never reach a reader, and list
// renumbering that only follows an added or removed item in the same suggestion is folded into that item's row.
import type { ReviewRow } from '@moss-multi/core/suggest/describe';
import { describe, expect, it } from 'vitest';
import { plainRows } from './rows.ts';

const row = (kind: ReviewRow['kind'], text: string, note?: string, detail = `d:${text}:${note ?? ''}`): ReviewRow => (note ? { kind, text, note, detail } : { kind, text, detail });
const notes = (rows: readonly ReviewRow[]) => rows.map((r) => r.note ?? '');
const INTERNAL = /listitem|textFormat|value:/;

describe('T9.9 plain card rows @p:mean-2 @p:R17', () => {
  it('a new list item says so in words, and the renumbering it causes is not a row of its own', () => {
    const rows = plainRows([
      row('insert', 'Added item', 'new listitem; value: 2'),
      row('change', 'Second item', 'listitem value: 2 → 3'),
      row('change', 'Third item', 'listitem value: 3 → 4'),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'insert', text: 'Added item', note: 'new list item' });
    // The folded rows stay in the row's detail, so the rows still read every hunk.
    expect(rows[0].detail).toContain('d:Second item');
    expect(rows[0].detail).toContain('d:Third item');
  });

  it('a removed list item folds its renumbering too', () => {
    const rows = plainRows([row('delete', 'Gone', 'removes listitem; value: 1'), row('change', 'Next', 'listitem value: 2 → 1')]);
    expect(rows.map((r) => [r.kind, r.text, r.note])).toEqual([['delete', 'Gone', 'removed list item']]);
  });

  it('renumbering alone stays a row, in words', () => {
    const rows = plainRows([row('change', 'Second item', 'listitem value: 2 → 3')]);
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('list number 2 → 3');
  });

  it('a word made bold reads "made bold", and the paragraph format it carries is not a second row', () => {
    const rows = plainRows([
      row('change', 'Support will be staffed', 'paragraph textFormat: plain → bold'),
      row('change', 'Support', 'text format: plain → bold'),
    ]);
    expect(rows.map((r) => [r.text, r.note])).toEqual([['Support', 'made bold']]);
    expect(rows[0].detail).toContain('d:Support will be staffed');
  });

  it('formatting taken off and changed reads as what was done', () => {
    expect(notes(plainRows([row('change', 'a', 'text format: bold → plain')]))).toEqual(['removed bold']);
    expect(notes(plainRows([row('change', 'a', 'text format: bold → italic')]))).toEqual(['made italic; removed bold']);
    expect(notes(plainRows([row('change', 'a', 'text format: plain → bold, italic')]))).toEqual(['made bold and italic']);
  });

  it('node-type notes are dropped and other names read as words', () => {
    expect(notes(plainRows([row('insert', 'word', 'paragraph')]))).toEqual(['']);
    expect(notes(plainRows([row('insert', 'Title', 'new heading; tag: h2')]))).toEqual(['new heading 2']);
    expect(notes(plainRows([row('change', 'Task', 'listitem checked: false → true')]))).toEqual(['checked']);
    expect(notes(plainRows([row('insert', 'x', 'new code-block')]))).toEqual(['new code block']);
    expect(plainRows([row('insert', '[listitem]', 'new listitem')])[0].text).toBe('[list item]');
  });

  it('what is not a node name passes unchanged', () => {
    const kept = [row('change', 'console.debug(y)', 'block content; line 1; was "console.log(x)"'), row('insert', 'bold words', 'bold'), row('insert', 'plain')];
    expect(plainRows(kept).map((r) => r.note)).toEqual(kept.map((r) => r.note));
  });

  it('no row of a list change and a bold change speaks in editor internals', () => {
    const rows = plainRows([
      row('insert', 'Added item', 'new listitem; value: 2'),
      row('change', 'Second item', 'listitem value: 2 → 3'),
      row('change', 'Keep this word plain.', 'paragraph textFormat: plain → bold'),
      row('change', 'word', 'text format: plain → bold'),
    ]);
    for (const r of rows) expect(`${r.text} ${r.note ?? ''}`).not.toMatch(INTERNAL);
    expect(rows).toHaveLength(2);
  });
});

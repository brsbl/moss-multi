// T5.S7: a card's rows cost work in Yjs runs, not characters, and are built once per preview hash. A code block's
// payload edit reads as its changed line, before and after, never as character fragments.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { payloadValueOf, type Hunk } from '@moss-multi/core/suggest/apply';
import { describeHunks, describePreview, describeStats, type ReviewRow } from '@moss-multi/core/suggest/describe';
import { diffText } from '@moss-multi/core/text-diff';

const shown = (rows: ReviewRow[]) => rows.map((row) => `${row.kind} ${JSON.stringify(row.text)} ${row.note ?? ''}`).join('\n');

/** Units built for `hunks`. */
function work(hunks: Hunk[]): { units: number; rows: ReviewRow[] } {
  const before = describeStats.units;
  const rows = describeHunks(hunks);
  return { units: describeStats.units - before, rows };
}

/** One character typed into the middle of an `n`-character payload line. */
function payloadEdit(n: number): Hunk {
  const half = n / 2;
  return {
    kind: 'payload', id: 'p', op: 'changed',
    before: { text: 'a'.repeat(n), ids: [['1:0', n]], map: [] },
    after: { text: `${'a'.repeat(half)}Z${'a'.repeat(half)}`, ids: [['1:0', half], ['9:0', 1], [`1:${half}`, half]], map: [] },
  };
}

/** One character typed into the middle of an `n`-character paragraph. */
function blockEdit(n: number): Hunk {
  const half = n / 2;
  const map = { id: '1:0', type: 'Map', keys: [['__type', { Any: ['text'] }], ['__format', { Any: [0] }]] };
  const keys = [['__type', { Any: ['paragraph'] }]];
  return {
    kind: 'block', id: '1:5', op: 'changed',
    before: { type: 'XmlText', seq: [map, { id: '1:1', s: 'a'.repeat(n) }], keys },
    after: { type: 'XmlText', seq: [map, { id: '1:1', s: 'a'.repeat(half) }, { id: '9:0', s: 'Z' }, { id: `1:${1 + half}`, s: 'a'.repeat(half) }], keys },
  };
}

describe('T5.S7 card work scales with runs, not characters @p:mean-2 @p:R17', () => {
  it.each([
    ['a code payload', payloadEdit],
    ['a paragraph', blockEdit],
  ] as const)('one character typed into %s of 64 KiB and of 1 MiB costs the same few units', (_name, edit) => {
    const small = work([edit(1 << 16)]);
    const large = work([edit(1 << 20)]);
    expect(large.units, `${small.units} units at 64 KiB, ${large.units} at 1 MiB`).toBe(small.units);
    expect(large.units).toBeLessThanOrEqual(16);
    expect(large.rows.some((row) => row.text.includes('Z')), shown(large.rows)).toBe(true);
  });

  it("a one-character payload edit's row is clipped around the change, not the whole 1 MiB line", () => {
    const { rows } = work([payloadEdit(1 << 20)]);
    expect(rows, shown(rows)).toHaveLength(1);
    for (const row of rows) expect(row.text.length + (row.note?.length ?? 0), shown(rows)).toBeLessThan(400);
  });
});

describe('T5.S7 rows are built once per preview hash @p:mean-2 @p:R17', () => {
  it('describing the same preview again returns the same rows without recomputing', () => {
    const hunks = [payloadEdit(1 << 16)];
    const calls = describeStats.calls;
    const first = describePreview({ hash: 'h-once', hunks });
    const again = describePreview({ hash: 'h-once', hunks });
    expect(describeStats.calls - calls).toBe(1);
    expect(again).toBe(first);
    describePreview({ hash: 'h-other', hunks });
    expect(describeStats.calls - calls).toBe(2);
  });
});

/** A payload hunk for code `before` edited to `after` by a character diff, as the register input writes it. */
function codeEdit(before: string, after: string, delta = diffText(before, after)): Hunk {
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc.getText('payload').insert(0, before);
  const was = payloadValueOf(doc);
  doc.clientID = 9;
  doc.getText('payload').applyDelta(delta);
  return { kind: 'payload', id: 'p', op: 'changed', before: was, after: payloadValueOf(doc) };
}

describe('T5.S7 a code edit reads as its changed line, before and after @p:mean-2 @p:R17', () => {
  it('console.log(x) → console.debug(y): one row with the new line, the old line in its note', () => {
    const rows = describeHunks([codeEdit('console.log(x)', 'console.debug(y)')]);
    expect(rows, shown(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'change', text: 'console.debug(y)' });
    expect(rows[0].note, shown(rows)).toContain('block content');
    expect(rows[0].note, shown(rows)).toContain('"console.log(x)"');
  });

  it('an edit on the second of three lines names that line alone', () => {
    const rows = describeHunks([codeEdit('a = 1\nb = 2\nc = 3', 'a = 1\nb = 20\nc = 3')]);
    expect(rows, shown(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'insert', text: 'b = 20' });
    expect(rows[0].note, shown(rows)).toContain('line 2');
    expect(rows[0].note, shown(rows)).toContain('"b = 2"');
  });

  it('edits on two separate lines read as two rows, top to bottom', () => {
    const rows = describeHunks([codeEdit('let a = 1;\nkeep();\nlet b = 2;', 'let alpha = 1;\nkeep();\nlet b = 3;')]);
    expect(rows.map((row) => row.text), shown(rows)).toEqual(['let alpha = 1;', 'let b = 3;']);
  });

  it('text removed and added again after the change (an edit written from the caret) reads as unchanged', () => {
    const before = 'console.log(x)\nreturn total;';
    const rows = describeHunks([codeEdit(before, 'console.debug(y)\nreturn total;', [{ retain: 8 }, { delete: before.length - 8 }, { insert: 'debug(y)\nreturn total;' }])]);
    expect(rows, shown(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'change', text: 'console.debug(y)' });
    expect(rows[0].note, shown(rows)).toContain('line 1; was "console.log(x)"');
  });

  it('a removal keeps the old line as its text and says what the line is now', () => {
    const rows = describeHunks([codeEdit('seed', 'see')]);
    expect(rows, shown(rows)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'delete', text: 'seed' });
    expect(rows[0].note, shown(rows)).toContain('"see"');
  });
});

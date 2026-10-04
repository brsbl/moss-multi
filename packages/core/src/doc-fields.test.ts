// doc-fields (A§10.4): the title and frontmatter Y.Texts take minimal character diffs, the diff stays bounded on a
// large edit, and a caret follows its character through a remote change by the change's own delta.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { observeField, readField, remapCaret, writeField } from './doc-fields.ts';
import { applyOps, diffText, LCS_CELL_BUDGET, type TextOp } from './text-diff.ts';

const LOCAL = 'local';

/** Two docs that exchange every update, like two synced clients. */
function pair(initial = ''): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  a.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, update, 'remote');
  });
  b.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, update, 'remote');
  });
  if (initial) writeField(a, 'title', initial, LOCAL);
  return [a, b];
}

/** Two docs that start from the same state and exchange nothing until `sync`. */
function apart(initial: string): { a: Y.Doc; b: Y.Doc; sync: () => void } {
  const a = new Y.Doc();
  writeField(a, 'title', initial, LOCAL);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return {
    a,
    b,
    sync: () => {
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    },
  };
}

/** Characters a script inserts plus characters it deletes. */
const touched = (ops: TextOp[]): number =>
  ops.reduce((sum, op) => sum + ('insert' in op ? op.insert.length : 'delete' in op ? op.delete : 0), 0);

describe('minimal diff', () => {
  it('writes only the characters that changed, in one transaction', () => {
    const [a, b] = pair('Quarterly plan');
    const seen: { delta: unknown; origin: unknown }[] = [];
    observeField(b, 'title', (_text, change) => seen.push(change));
    expect(writeField(a, 'title', 'Quarterly travel plan', LOCAL)).toBe(true);
    expect(readField(b, 'title')).toBe('Quarterly travel plan');
    expect(seen, 'one remote change').toHaveLength(1);
    expect(seen[0].delta, 'an insert at the edit point, everything else retained').toEqual([{ retain: 10 }, { insert: 'travel ' }]);
  });

  it('a write of the same text emits nothing', () => {
    const [a] = pair('Same');
    let updates = 0;
    a.on('update', () => {
      updates += 1;
    });
    expect(writeField(a, 'title', 'Same', LOCAL)).toBe(false);
    expect(updates).toBe(0);
  });

  it('concurrent renames of different regions both survive', () => {
    const { a, b, sync } = apart('Plan for launch');
    writeField(a, 'title', 'Draft plan for launch', LOCAL);
    writeField(b, 'title', 'Plan for launch day', LOCAL);
    sync();
    expect(readField(a, 'title')).toBe('Draft plan for launch day');
    expect(readField(b, 'title')).toBe(readField(a, 'title'));
  });

  it('a concurrent rename never clobbers text typed in the middle', () => {
    const { a, b, sync } = apart('Roadmap');
    writeField(a, 'title', 'Road to the map', LOCAL);
    writeField(b, 'title', 'Roadmap 2027', LOCAL);
    sync();
    expect(readField(a, 'title')).toBe('Road to the map 2027');
  });

  it('diffText retains the shared text and applies exactly', () => {
    const current = 'The quick brown fox';
    const target = 'The quick red fox jumps';
    const ops = diffText(current, target);
    expect(applyOps(current, ops)).toBe(target);
    // "r" and " fox" are kept: "b", "o", "w", "n" go and "ed" and " jumps" come.
    expect(touched(ops)).toBe(4 + 2 + ' jumps'.length);
  });
});

describe('budget fallback', () => {
  const N = 300;
  const kept = (i: number) => `kept line ${i} stays exactly as it was`;
  const changedLine = (word: string, i: number) => `${word} line ${i} ${'x'.repeat(i % 7)}`;
  /** Each kept line followed by a line that changes, so the differing middle holds every kept line. */
  const doc = (word: string) => Array.from({ length: N }, (_, i) => `${kept(i)}\n${changedLine(word, i)}`).join('\n');

  it('a middle past the character budget aligns by lines, retaining the shared lines', () => {
    const current = doc('old');
    const target = doc('new');
    // Prefix and suffix trimming leave a middle whose character table is past the budget.
    expect(current.length * target.length).toBeGreaterThan(LCS_CELL_BUDGET);
    const started = Date.now();
    const ops = diffText(current, target);
    expect(Date.now() - started, 'bounded work').toBeLessThan(2_000);
    expect(applyOps(current, ops)).toBe(target);
    // Every kept line is retained, so only the changed lines are touched; a coarse replace touches all of it.
    const changed = Array.from({ length: N }, (_, i) => changedLine('old', i).length + changedLine('new', i).length + 2).reduce((a, b) => a + b, 0);
    expect(touched(ops)).toBeLessThanOrEqual(changed);
    expect(touched(ops)).toBeLessThan((current.length + target.length) * 0.6);
  });

  it('a middle past the line budget too is one coarse replace, still exact', () => {
    const n = Math.ceil(Math.sqrt(LCS_CELL_BUDGET)) + 10;
    const current = Array.from({ length: n }, (_, i) => `a${i}`).join('\n');
    const target = Array.from({ length: n }, (_, i) => `b${i}`).join('\n');
    const started = Date.now();
    const ops = diffText(current, target);
    expect(Date.now() - started, 'bounded work').toBeLessThan(2_000);
    expect(applyOps(current, ops)).toBe(target);
    expect(ops.filter((op) => 'insert' in op)).toHaveLength(1);
  });

  it('a large paste replacing a small selection (n=500,000) is exact, coalesced and bounded', () => {
    const paste = 'y'.repeat(500_000);
    const started = Date.now();
    const ops = diffText('aXb', `a${paste}b`);
    expect(Date.now() - started, 'bounded work').toBeLessThan(2_000);
    expect(ops).toEqual([{ retain: 1 }, { delete: 1 }, { insert: paste }]);
    const [a, b] = pair('aXb');
    writeField(a, 'title', `a${paste}b`, LOCAL);
    expect(readField(b, 'title')).toBe(`a${paste}b`);
  });

  it('writeField stays exact on a large title edit', () => {
    const [a, b] = pair('x'.repeat(5_000));
    writeField(a, 'title', 'y'.repeat(5_000), LOCAL);
    expect(readField(b, 'title')).toBe('y'.repeat(5_000));
  });
});

describe('caret remap from the change delta', () => {
  /** The caret at `caret` in b after a's write, remapped through the delta b observed. */
  function remapAfter(initial: string, write: (a: Y.Doc) => void, caret: number): { caret: number; text: string } {
    const [a, b] = pair(initial);
    let next = caret;
    observeField(b, 'title', (_text, change) => {
      next = remapCaret(next, change.delta);
    });
    write(a);
    return { caret: next, text: readField(b, 'title') };
  }

  it('"aa" -> "aaa" with the new "a" typed before the caret moves the caret right', () => {
    const result = remapAfter('aa', (a) => a.getText('title').insert(0, 'a'), 1);
    expect(result).toEqual({ caret: 2, text: 'aaa' });
  });

  it('"aa" -> "aaa" with the new "a" typed after the caret leaves it in place', () => {
    const result = remapAfter('aa', (a) => a.getText('title').insert(2, 'a'), 1);
    expect(result).toEqual({ caret: 1, text: 'aaa' });
  });

  it('an insert exactly at the caret leaves the caret before it', () => {
    expect(remapAfter('ab', (a) => a.getText('title').insert(1, 'X'), 1)).toEqual({ caret: 1, text: 'aXb' });
  });

  it('a delete before the caret shifts it left, and one spanning it clamps to the start of the cut', () => {
    expect(remapAfter('hello world', (a) => a.getText('title').delete(0, 6), 8)).toEqual({ caret: 2, text: 'world' });
    expect(remapAfter('hello world', (a) => a.getText('title').delete(3, 5), 6)).toEqual({ caret: 3, text: 'helrld' });
  });

  it('a minimal write elsewhere keeps the caret on its character', () => {
    const result = remapAfter('Plan', (a) => writeField(a, 'title', 'Big Plan', LOCAL), 2);
    expect(result).toEqual({ caret: 6, text: 'Big Plan' });
  });
});

describe('observeField', () => {
  it('reports the text after each change and the transaction origin', () => {
    const doc = new Y.Doc();
    const seen: [string, unknown][] = [];
    const stop = observeField(doc, 'frontmatter', (text, change) => seen.push([text, change.origin]));
    writeField(doc, 'frontmatter', 'status: draft\n', LOCAL);
    stop();
    writeField(doc, 'frontmatter', 'status: done\n', LOCAL);
    expect(seen).toEqual([['status: draft\n', LOCAL]]);
  });
});

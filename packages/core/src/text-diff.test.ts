import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyOps, diffAtCaret, diffText, rebaseOps } from './text-diff.ts';

describe('diffAtCaret', () => {
  it('places an insert inside a run of equal characters where the caret is', () => {
    expect(diffAtCaret('aa', 'aaa', 2)).toEqual([{ retain: 1 }, { insert: 'a' }]);
    expect(diffAtCaret('aa', 'aaa', 1)).toEqual([{ insert: 'a' }]);
    expect(diffText('aa', 'aaa')).toEqual([{ retain: 2 }, { insert: 'a' }]);
  });

  it('reads a replaced selection and a backspace as one edit', () => {
    expect(diffAtCaret('seed', 's  d', 3)).toEqual([{ retain: 1 }, { delete: 2 }, { insert: '  ' }]);
    expect(diffAtCaret('abba', 'aba', 1)).toEqual([{ retain: 1 }, { delete: 1 }]);
    for (const [before, after, caret] of [['', 'x', 1], ['xy', '', 0], ['😀b', '😀😀b', 4]] as const) {
      expect(applyOps(before, diffAtCaret(before, after, caret))).toBe(after);
    }
  });
});

describe('rebaseOps', () => {
  it('applies an edit made on a stale text to the current one without deleting what a peer added', () => {
    // The field showed "seed"; the user selected "ee" and typed "x" while a peer's "BEN" was in flight at the start.
    const ops = diffAtCaret('seed', 'sxd', 2);
    const rebased = rebaseOps('seed', ops, 'BENseed');
    expect(applyOps('BENseed', rebased)).toBe('BENsxd');
    // A whole-value write of the stale text would have deleted the peer's characters.
    expect(applyOps('BENseed', diffText('BENseed', 'sxd'))).toBe('sxd');
  });

  it('keeps a peer insert at the edges of the replaced range', () => {
    const ops = diffAtCaret('abc', 'aXc', 2);
    expect(applyOps('aPbQc', rebaseOps('abc', ops, 'aPbQc'))).toBe('aPXQc');
  });

  it('converges with the peer when both apply to one Y.Text', () => {
    const ada = new Y.Doc();
    const ben = new Y.Doc();
    try {
      ada.getText('t').insert(0, 'seed');
      Y.applyUpdate(ben, Y.encodeStateAsUpdate(ada));
      ben.getText('t').insert(4, '!');
      Y.applyUpdate(ada, Y.encodeStateAsUpdate(ben));
      const text = ada.getText('t');
      text.applyDelta(rebaseOps('seed', diffAtCaret('seed', 'seXed', 3), text.toString()));
      expect(text.toString()).toBe('seXed!');
    } finally { ada.destroy(); ben.destroy(); }
  });
});

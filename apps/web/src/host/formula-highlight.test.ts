// T3.B13 (B279): typing `==marked==` latched moss's formula mode on `==marked=` (formula-runtime's
// `highlight-delimiters` seam), which held back the == highlight shortcut; Space then made `marked` a formula and
// dropped the word; `==two words=` latched it on `words=`. An `=` of a `==` run, or one after an unclosed `==` on its
// line, is a highlight delimiter; formulas still match.
import { describe, expect, it } from 'vitest';
import { findFormulaPatternAtCursor } from '@moss-desktop/renderer/editor/utils/formula-runtime';
import { formulaChipBoxes } from './formula-chip';

const at = (text: string, options = {}) => findFormulaPatternAtCursor(text, text.length, { allowInlineAnonymous: true, ...options });

describe('formula patterns beside == highlights', () => {
  it('finds no formula while a ==highlight== is typed', () => {
    for (const text of [
      'Start. ==', 'Start. ==m', 'Start. ==marked', 'Start. ==marked=', 'Start. ==marked==', 'Start. ==marked== ',
      'Start. ==two words', 'Start. ==two words=', 'Start. ==two words==', 'a ==b== and ==two more words=',
    ]) {
      expect(at(text), text).toBeNull();
      expect(at(text, { allowEmptyExpression: true }), `${text} (draft)`).toBeNull();
    }
  });

  it('still finds named and anonymous formulas', () => {
    expect(at('price=12')).toMatchObject({ name: 'price', expression: '12' });
    expect(at('=2+3')).toMatchObject({ name: null, expression: '2+3' });
    expect(at('rate=', { allowEmptyExpression: true })).toMatchObject({ name: 'rate', expression: '' });
    expect(at('Start ==marked== then price=12')).toMatchObject({ name: 'price', expression: '12' });
  });
});

// T9.44: a bound editor's formula draft is local paint, yet keeps moss's chip geometry: 8 px a side, 2 px above and
// below the line, rounded 6 px at its two ends.
describe('formula draft chip boxes', () => {
  it('pads a one-line draft like moss, round at both ends', () => {
    expect(formulaChipBoxes([{ left: 435, top: 193, width: 38.09375, height: 19 }], { lineHeight: 22.5 })).toEqual([
      { left: 427, top: 189.25, width: 54.09375, height: 26.5, roundStart: true, roundEnd: true },
    ]);
  });

  it('pads into no more room than the text leaves', () => {
    const [box] = formulaChipBoxes([{ left: 100, top: 10, width: 40, height: 19 }], { lineHeight: 23, startRoom: 3, endRoom: 0 });
    expect(box).toMatchObject({ left: 97, width: 43, top: 6, height: 27 });
  });

  it('pads only the outer ends of a wrapped draft', () => {
    const boxes = formulaChipBoxes([
      { left: 700, top: 10, width: 100, height: 19 },
      { left: 400, top: 33, width: 50, height: 19 },
    ], { lineHeight: 23 });
    expect(boxes.map(({ left, width, roundStart, roundEnd }) => ({ left, width, roundStart, roundEnd }))).toEqual([
      { left: 692, width: 108, roundStart: true, roundEnd: false },
      { left: 400, width: 58, roundStart: false, roundEnd: true },
    ]);
  });
});

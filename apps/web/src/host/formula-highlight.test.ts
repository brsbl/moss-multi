// T3.B13 (B279): typing `==marked==` latched moss's formula mode on `==marked=` (formula-runtime's
// `highlight-delimiters` seam), which held back the == highlight shortcut; Space then made `marked` a formula and
// dropped the word. An `=` of a `==` run, or one closing `==name=`, is a highlight delimiter; formulas still match.
import { describe, expect, it } from 'vitest';
import { findFormulaPatternAtCursor } from '@moss-desktop/renderer/editor/utils/formula-runtime';

const at = (text: string, options = {}) => findFormulaPatternAtCursor(text, text.length, { allowInlineAnonymous: true, ...options });

describe('formula patterns beside == highlights', () => {
  it('finds no formula while a ==highlight== is typed', () => {
    for (const text of ['Start. ==', 'Start. ==m', 'Start. ==marked', 'Start. ==marked=', 'Start. ==marked==', 'Start. ==marked== ']) {
      expect(at(text), text).toBeNull();
      expect(at(text, { allowEmptyExpression: true }), `${text} (draft)`).toBeNull();
    }
  });

  it('still finds named and anonymous formulas', () => {
    expect(at('price=12')).toMatchObject({ name: 'price', expression: '12' });
    expect(at('=2+3')).toMatchObject({ name: null, expression: '2+3' });
    expect(at('rate=', { allowEmptyExpression: true })).toMatchObject({ name: 'rate', expression: '' });
  });
});

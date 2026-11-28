// T5.3: a card row shows its text's exact characters. Whitespace a reader could not see (leading, trailing, a run, a
// tab, a line break, a whitespace-only change) is drawn as a marked glyph, never trimmed and never a paragraph mark.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RowText } from './RowText.tsx';

const html = (text: string, struck = false) => renderToStaticMarkup(createElement(RowText, { text, struck }));
/** The marked whitespace glyphs, in order. */
const marked = (markup: string) => [...markup.matchAll(/<span[^>]*data-row-space[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);

describe('T5.3 a card row shows whitespace exactly @p:mean-2 @p:R17', () => {
  it('indentation added to a code line reads as four marked spaces, not a paragraph mark', () => {
    const out = html('    ');
    expect(out).not.toContain('¶');
    expect(marked(out)).toEqual(['····']);
  });

  it('a single space inserted between two words shows as a marked space', () => {
    const out = html(' ');
    expect(out).not.toContain('¶');
    expect(marked(out)).toEqual(['·']);
  });

  it("a deleted word's trailing space is kept and struck", () => {
    const out = html('quickly ', true);
    expect(out).toContain('line-through');
    expect(out).toContain('quickly');
    expect(marked(out)).toEqual(['·']);
  });

  it('leading indentation before code is kept', () => {
    const out = html('    log()');
    expect(marked(out)).toEqual(['····']);
    expect(out).toContain('log()');
  });

  it('a space between words reads as a plain space', () => {
    const out = html('Line 1');
    expect(marked(out)).toEqual([]);
    expect(out).toContain('Line 1');
  });
});

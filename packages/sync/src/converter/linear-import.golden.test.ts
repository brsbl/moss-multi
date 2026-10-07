// The linear inline pass (markdown/linear-import.ts) builds the tree Lexical's own import builds: over every fixture,
// the converter cases and random strings of the tokens the transformers care about, with the work budget lifted so
// the two algorithms are compared. At the default budget no fixture or L3 case is cut, and one paragraph of many
// matches imports in linear time, where Lexical's recursion overflows the stack.
import { $convertFromMarkdownString as $lexicalConvertFromMarkdownString } from '@lexical/markdown';
import { $withDocumentImport, withImportFormulaIds } from '@moss-desktop/renderer/editor/markdown/fixes';
import { $convertFromMarkdownString, LINEAR_IMPORT_LIMITS, linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { escapeHtmlEntities, normalizeMarkdownForImport } from '@moss-desktop/renderer/editor/markdown/normalize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { $getRoot } from 'lexical';
import { CONVERTER_CASES, converterBody, LARGE_ORDINARY_NOTES, ORDINARY_NOTES } from '../../measure/converter-cases.ts';
import { FIXTURES, SCALE_UNIT, scaleNote } from './fixtures.ts';
import { createConverterEditor, exportMarkdown, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS } from './index.ts';

type Convert = typeof $lexicalConvertFromMarkdownString;

// The imported tree, as the pipeline imports (no selection, formula ids derived from the markdown).
function tree(convert: Convert, markdown: string): string {
  const prepared = escapeHtmlEntities(normalizeMarkdownForImport(markdown));
  const editor = createConverterEditor();
  editor.update(
    () => $withDocumentImport(() => withImportFormulaIds(prepared, () => convert(prepared, MARKDOWN_EDITOR_TRANSFORMERS))),
    { discrete: true },
  );
  return JSON.stringify(editor.getEditorState().toJSON());
}

const TOKENS = [
  '*', '**', '***', '_', '__', '~~', '`', '``', '\\', '\\*', '\\`', '\\_', '[', ']', '(', ')', '[[', ']]', '![', '?[', '](',
  '{{', '}}', '|', '<u>', '</u>', '<mark data-color="red">', '</mark>', '<span style="font-family: serif">', '</span>',
  '==', '%%', '&#42;', '#ff0000', 'rgb(1, 2, 3)', 'http://a.co', 'https://example.com/x', 'a', 'b c', 'x1', ' ', '  ',
  '.', ',', ':', '-', '"', "'", '!', '?', '\t', '\n', '# ', '- ', '> ', '1. ',
];

const DENSE_TOKENS = [
  '*', '**', '***', '_', '__', '~~', '`', '``', '\\', '\\*', '\\`', '[a](b)', '[a_b](c*d)', '[a`b](c)', 'a', 'b', ' ', '  ', 'x*y',
  'x_y', '`a`', '**b**', '*c*', '_d_', '#fff', 'http://a.co ', '[[w]]', '(', ')', '.', '!',
];

// Deterministic pseudo-random strings of tokens, `count` of them, each up to `maxTokens` long.
function* fuzz(count: number, seed: number, maxTokens: number, tokens = TOKENS): Generator<string> {
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

const caseBodies = (sizes: number[]) => Object.values(CONVERTER_CASES).flatMap((c) => sizes.map((bytes) => converterBody(c, bytes)));

describe('linear inline import @p:tech-4', () => {
  describe('with the budget lifted', () => {
    const limits = { ...LINEAR_IMPORT_LIMITS };
    beforeAll(() => {
      LINEAR_IMPORT_LIMITS.perChar = Number.POSITIVE_INFINITY;
      LINEAR_IMPORT_LIMITS.perImport = Number.POSITIVE_INFINITY;
    });
    afterAll(() => {
      Object.assign(LINEAR_IMPORT_LIMITS, limits);
    });

    // The first few inputs the two imports build differently.
    const differing = (texts: Iterable<string>) => {
      const found: string[] = [];
      for (const text of texts) {
        if (tree($convertFromMarkdownString, text) !== tree($lexicalConvertFromMarkdownString, text)) found.push(text.slice(0, 300));
        if (found.length === 5) break;
      }
      return found;
    };

    it('builds the tree Lexical builds for every fixture and converter case', () => {
      expect(differing([...FIXTURES.map((f) => f.markdown), ...caseBodies([40, 700, 2_000])])).toEqual([]);
    }, 300_000);

    it('builds the tree Lexical builds for random token strings', () => {
      expect(differing(fuzz(8_000, 7, 40))).toEqual([]);
    }, 300_000);

    it('builds the tree Lexical builds for long lines of random tokens', () => {
      expect(differing(fuzz(60, 11, 1_200))).toEqual([]);
    }, 300_000);

    // Long lines dense in delimiters, backticks, escapes and matches: the format search reuses its answer across
    // the parts of a line, and these are where a wrong reuse would show.
    it('builds the tree Lexical builds for long lines dense in delimiters', () => {
      expect(differing(fuzz(1_500, 3, 300, DENSE_TOKENS))).toEqual([]);
    }, 300_000);
  });

  // A line's budget is linear in its length and matches, so ordinary notes use a small share of it (and of the
  // import's), however long their lines; none is cut.
  const shares = (run: () => void) => {
    Object.assign(linearImportStats, { peakLineShare: 0, peakImportShare: 0 });
    const before = linearImportStats.cut;
    run();
    return { cut: linearImportStats.cut - before, line: linearImportStats.peakLineShare, import: linearImportStats.peakImportShare };
  };

  it.each(Object.entries(ORDINARY_NOTES))('cuts no line of an ordinary note and builds Lexical\'s tree: %s', (_name, body) => {
    const markdown = body();
    let ours = '';
    const used = shares(() => {
      ours = tree($convertFromMarkdownString, markdown);
    });
    expect(used.cut).toBe(0);
    expect(used.line).toBeLessThan(0.25);
    expect(used.import).toBeLessThan(0.25);
    expect(ours === tree($lexicalConvertFromMarkdownString, markdown)).toBe(true);
  }, 120_000);

  it.each<[string, () => string]>([
    ['the 2 MB scale note of mixed content', () => scaleNote(Math.ceil((2 * 1024 * 1024) / SCALE_UNIT.length))],
    ...Object.entries(LARGE_ORDINARY_NOTES),
  ])('cuts no line of %s, and builds Lexical\'s tree', (_name, body) => {
    const markdown = body();
    let ours = '';
    const used = shares(() => {
      ours = tree($convertFromMarkdownString, markdown);
    });
    expect(used.cut).toBe(0);
    expect(used.line).toBeLessThan(0.25);
    expect(used.import).toBeLessThan(0.25);
    expect(ours === tree($lexicalConvertFromMarkdownString, markdown)).toBe(true);
  }, 120_000);

  // A cut line keeps the rest of its text as literal text: every character survives, and the export writes it so
  // that the next import reads the same text.
  describe('when the budget is spent', () => {
    const textOf = (editor: ReturnType<typeof importMarkdown>) => editor.getEditorState().read(() => $getRoot().getTextContent());
    const withoutDelimiters = (text: string) => text.replace(/[*_~\s]/g, '');
    const lossless = (markdown: string) => {
      const before = linearImportStats.cut;
      const editor = importMarkdown(markdown);
      const cut = linearImportStats.cut - before;
      const text = textOf(editor);
      return { cut, kept: withoutDelimiters(text) === withoutDelimiters(markdown), literal: /[*_]/.test(text), reread: textOf(importMarkdown(exportMarkdown(editor))) === text };
    };

    it('keeps a pathological line\'s text', () => {
      const n = 10_000;
      expect(lossless(`${'*x _x '.repeat(n)}y${' x_ x*'.repeat(n)}`)).toEqual({ cut: 1, kept: true, literal: true, reread: true });
    }, 120_000);

    // moss's color callback reads the whole paragraph per color once the line holds a bracket: quadratic in moss's
    // own import, so a few such paragraphs spend the import's budget and the rest keep their text.
    it('keeps the text of lines past the import\'s budget', () => {
      const colors = Array.from({ length: 2_000 }, (_, i) => `#${((Math.imul(i + 1, 2654435761) >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`).join(' ');
      const result = lossless(Array.from({ length: 12 }, (_, i) => `**b${i}** [x] ${colors}`).join('\n\n'));
      expect(result.cut).toBeGreaterThanOrEqual(6);
      expect(result).toMatchObject({ kept: true, literal: true, reread: true });
    }, 120_000);

    // A line cut partway keeps its unconverted rest as the text it reads as (escapes decoded), so each export and
    // import gives back the same markdown and text: no backslashes pile up.
    it('keeps a cut line\'s rest exactly through repeated export and import', () => {
      const before = linearImportStats.cut;
      let editor = importMarkdown(`quokka ${'[a](b) '.repeat(150_000)}tail a\\\\b \\_ _ *c* \`d\` \\\\\\\\ \\*`);
      expect(linearImportStats.cut - before).toBeGreaterThan(0);
      const text = textOf(editor);
      expect(text.slice(-30)).toBe('[a](b) tail a\\b _ _ *c* `d` \\\\ *'.slice(-30));
      const exports: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        exports.push(exportMarkdown(editor));
        editor = importMarkdown(exports[round]);
        expect(textOf(editor) === text).toBe(true);
      }
      expect(exports[1] === exports[0] && exports[2] === exports[0]).toBe(true);
    }, 120_000);
  });

  it('cuts no fixture line and no L3 case at the default budget', () => {
    const before = linearImportStats.cut;
    for (const f of FIXTURES) importMarkdown(f.markdown, f.options);
    for (const c of Object.values(CONVERTER_CASES)) for (const bytes of c.parityBytes ?? [40, 3_000]) importMarkdown(converterBody(c, bytes));
    expect(linearImportStats.cut - before).toBe(0);
  }, 120_000);

  // Paragraphs that overflowed Lexical's recursion or took tens of seconds (T3.S4's checker repros, then four times
  // larger): each imports in a few seconds at most, and the larger in about four times the smaller's time.
  it.each([
    ['formatted pill openers before one destination', (n: number) => `x ${'*?['.repeat(n)}](${'a'.repeat(n)}`, 20_000],
    ['URL labels before one destination', (n: number) => `x ${'[http://a'.repeat(n)}](${'a'.repeat(4 * n)}`, 10_000],
    // A word first: a line that starts with a URL is moss's raw-URL block, not inline text.
    ['raw URLs', (n: number) => `x ${'http://a '.repeat(n)}`, 20_000],
    ['embeddable URLs', (n: number) => `x ${'https://example.com '.repeat(n)}`, 10_000],
    ['emphasis spans', (n: number) => `x ${'*a* '.repeat(n)}`, 20_000],
  ] as const)('imports one paragraph of many matches in linear time: %s', (_name, body, n) => {
    const timed = (markdown: string) => {
      const started = performance.now();
      importMarkdown(markdown);
      return performance.now() - started;
    };
    timed(body(n / 10));
    const small = timed(body(n));
    const large = timed(body(4 * n));
    expect(small).toBeLessThan(3_000);
    expect(large).toBeLessThan(Math.max(8 * small, 400));
  }, 120_000);
});

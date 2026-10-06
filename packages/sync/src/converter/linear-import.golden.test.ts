// The linear inline pass (markdown/linear-import.ts) builds the tree Lexical's own import builds: over every fixture,
// the converter cases and random strings of the tokens the transformers care about, with the work budget lifted so
// the two algorithms are compared. At the default budget no fixture or L3 case is cut, and one paragraph of many
// matches imports in linear time, where Lexical's recursion overflows the stack.
import { $convertFromMarkdownString as $lexicalConvertFromMarkdownString } from '@lexical/markdown';
import { $withDocumentImport, withImportFormulaIds } from '@moss-desktop/renderer/editor/markdown/fixes';
import { $convertFromMarkdownString, LINEAR_IMPORT_LIMITS, linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { escapeHtmlEntities, normalizeMarkdownForImport } from '@moss-desktop/renderer/editor/markdown/normalize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';
import { FIXTURES } from './fixtures.ts';
import { createConverterEditor, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS } from './index.ts';

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

// Deterministic pseudo-random strings of tokens, `count` of them, each up to `maxTokens` long.
function* fuzz(count: number, seed: number, maxTokens: number): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  for (let i = 0; i < count; i += 1) {
    const length = next() % maxTokens;
    let text = '';
    for (let j = 0; j < length; j += 1) text += TOKENS[next() % TOKENS.length];
    yield text;
  }
}

const caseBodies = (sizes: number[]) => Object.values(CONVERTER_CASES).flatMap((c) => sizes.map((bytes) => converterBody(c, bytes)));

describe('linear inline import @p:tech-4', () => {
  describe('with the budget lifted', () => {
    const limits = { ...LINEAR_IMPORT_LIMITS };
    beforeAll(() => {
      LINEAR_IMPORT_LIMITS.perChar = Number.POSITIVE_INFINITY;
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
    ['raw URLs', (n: number) => 'http://a '.repeat(n), 20_000],
    ['embeddable URLs', (n: number) => 'https://example.com '.repeat(n), 10_000],
    ['emphasis spans', (n: number) => '*a* '.repeat(n), 20_000],
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

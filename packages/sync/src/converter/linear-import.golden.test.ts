// The linear inline pass (markdown/linear-import.ts) builds the tree Lexical's own import builds: over every fixture,
// the converter cases and random strings of the tokens the transformers care about, with the work budget lifted so
// the two algorithms are compared. At the default budget no fixture or L3 case is cut, and one paragraph of many
// matches imports in linear time, where Lexical's recursion overflows the stack.
import { $convertFromMarkdownString as $lexicalConvertFromMarkdownString } from '@lexical/markdown';
import { $withDocumentImport, withImportFormulaIds } from '@moss-desktop/renderer/editor/markdown/fixes';
import { $convertFromMarkdownString, LINEAR_IMPORT_LIMITS, linearImportStats } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { escapeHtmlEntities, normalizeMarkdownForImport } from '@moss-desktop/renderer/editor/markdown/normalize';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { $getRoot, $isElementNode, type ElementNode } from 'lexical';
import { CONVERTER_CASES, converterBody, LARGE_ORDINARY_NOTES, MULTILINE_CASES, multilineBody, ORDINARY_NOTES } from '../../measure/converter-cases.ts';
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
      Object.assign(LINEAR_IMPORT_LIMITS, {
        lineChars: Number.POSITIVE_INFINITY,
        perLine: Number.POSITIVE_INFINITY,
        matches: Number.POSITIVE_INFINITY,
        tabs: Number.POSITIVE_INFINITY,
        perChar: Number.POSITIVE_INFINITY,
        perImport: Number.POSITIVE_INFINITY,
        perNote: Number.POSITIVE_INFINITY,
      });
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

    it('builds the tree Lexical builds for notes of one short line repeated', () => {
      const bodies = Object.values(MULTILINE_CASES).flatMap((c) => (c.parityBytes ?? [40, 2_000]).map((bytes) => multilineBody(c, bytes)));
      expect(differing(bodies)).toEqual([]);
    }, 300_000);

    // @lexical/markdown's tab split, patched (patches/@lexical__markdown@0.48.0.patch) to link a text node's parts in
    // after it, still calls TextNode.splitText while a range selection exists: the two give the same tree.
    it('splits tabs into the nodes TextNode.splitText makes', () => {
      const withSelection = (markdown: string, selected: boolean) => {
        const editor = createConverterEditor();
        editor.update(
          () => {
            if (selected) $getRoot().selectEnd();
            $lexicalConvertFromMarkdownString(markdown, MARKDOWN_EDITOR_TRANSFORMERS);
          },
          { discrete: true },
        );
        return JSON.stringify(editor.getEditorState().toJSON());
      };
      const texts = [
        'a\tb\n\tc\td\n**x**\ty\t\n\t',
        '- a\tb\n- \tc\n\n> q\tr\n> \ts',
        '| a\tb | c |\n| --- | --- |\n| \td | e\t |',
        ...fuzz(2_000, 13, 30, ['\t', '\t\t', 'a', ' ', '\n', '**', '*', '`', '[a](b)', '> ', '- ', '#ff0000', '\\']),
      ];
      const found = texts.filter((text) => withSelection(text, false) !== withSelection(text, true)).slice(0, 5);
      expect(found).toEqual([]);
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

  // A line's budget is linear in its length, a little more per byte than the densest ordinary paragraph (one-letter
  // links each followed by bold) takes, and ordinary notes use a small share of the import's; none is cut.
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
    expect(used.line).toBeLessThan(0.95);
    expect(used.import).toBeLessThan(0.25);
    expect(ours === tree($lexicalConvertFromMarkdownString, markdown)).toBe(true);
  }, 120_000);

  // The checker's dense paragraphs of short formatted words: converted in full, and written back as they were.
  it.each([
    'a paragraph of 400 italic tags',
    'a paragraph of 300 bold labels with code and italic values',
    'a paragraph of 500 code spans',
    'a paragraph of 400 one-letter links, each followed by bold',
  ])('converts %s and exports it unchanged', (name) => {
    const markdown = ORDINARY_NOTES[name]();
    const before = linearImportStats.cut;
    const exported = exportMarkdown(importMarkdown(markdown));
    expect(linearImportStats.cut - before).toBe(0);
    expect(exported === markdown).toBe(true);
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
    expect(used.line).toBeLessThan(0.95);
    expect(used.import).toBeLessThan(0.25);
    expect(ours === tree($lexicalConvertFromMarkdownString, markdown)).toBe(true);
  }, 120_000);

  // A cut line keeps its whole text as literal text: every character survives, and the export writes it so
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

    // A cut line goes back to its whole text, decoded as moss decodes any line's text, so what it reads as never
    // depends on where the cut fell, and each export and import gives back the same markdown and text.
    const roundTrips = (markdown: string, text: string) => {
      let editor = importMarkdown(markdown);
      const exports: string[] = [];
      for (let round = 0; round < 3; round += 1) {
        exports.push(exportMarkdown(editor));
        editor = importMarkdown(exports[round]);
        expect(textOf(editor) === text).toBe(true);
      }
      expect(exports[1] === exports[0] && exports[2] === exports[0]).toBe(true);
    };

    it('keeps a cut line\'s whole text exactly through repeated export and import', () => {
      const before = linearImportStats.cut;
      const links = '[a](b) '.repeat(150_000);
      const markdown = `quokka ${links}tail a\\\\b \\_ _ *c* \`d\` \\\\\\\\ \\*`;
      const text = textOf(importMarkdown(markdown));
      expect(linearImportStats.cut - before).toBeGreaterThan(0);
      expect(text.slice(-30)).toBe(`${links}tail a\\b _ _ *c* \`d\` \\\\ *`.slice(-30));
      expect(text === `quokka ${links}tail a\\b _ _ *c* \`d\` \\\\ *`).toBe(true);
      roundTrips(markdown, text);
    }, 120_000);

    // The checker's case: a code span that starts a formatted part was decoded when the line was whole and left
    // escaped when the line was cut further on. A cut line now converts none of its parts; the line before it does.
    it('converts no part of a cut line, whatever comes first in it', () => {
      const line = (n: number) => `quokka ~~\`\\*\` ${'[a](b) word '.repeat(n)}z~~`;
      const before = linearImportStats.cut;
      const whole = textOf(importMarkdown(line(1_000)));
      expect(linearImportStats.cut - before).toBe(0);
      expect(whole.slice(0, 18)).toBe('quokka * a word a ');
      const markdown = `**Before** it.\n\n${line(150_000)}`;
      const editor = importMarkdown(markdown);
      expect(linearImportStats.cut - before).toBeGreaterThan(0);
      const shape = editor.getEditorState().read(() => $getRoot().getChildren().map((block) => ($isElementNode(block) ? block.getChildrenSize() : -1)));
      expect(shape).toEqual([2, 1]);
      const text = textOf(editor);
      expect(text.slice(0, 32)).toBe('Before it.\n\nquokka ~~`*` [a](b) ');
      expect(text === `Before it.\n\nquokka ~~\`*\` ${'[a](b) word '.repeat(150_000)}z~~`).toBe(true);
      roundTrips(markdown, text);
    }, 120_000);
  });

  // Caps that bound what any one line costs, each fixed by the line's own text (scripts/measure-converter.mjs holds a
  // line of every converter case, from 1 KB to 2 MB, to the per-line workerd budget).
  describe('per-line caps', () => {
    const textOf = (editor: ReturnType<typeof importMarkdown>) => editor.getEditorState().read(() => $getRoot().getTextContent());
    const cuts = (run: () => void) => {
      const before = linearImportStats.cut;
      run();
      return linearImportStats.cut - before;
    };
    const blocks = (editor: ReturnType<typeof importMarkdown>) =>
      editor.getEditorState().read(() => $getRoot().getChildren().map((block) => [block.getType(), block.getTextContent()]));

    it('keeps a line longer than lineChars literally, out of moss\'s normalization and the block transformers', () => {
      const line = `# **b** [a](b)\u00a0${'x'.repeat(LINEAR_IMPORT_LIMITS.lineChars)}`;
      let editor = importMarkdown('');
      expect(cuts(() => {
        editor = importMarkdown(`Before **it**.\n\n${line}\n\nAfter **it**.`);
      })).toBe(1);
      expect(blocks(editor)).toEqual([['paragraph', 'Before it.'], ['paragraph', line], ['paragraph', 'After it.']]);
      const again = importMarkdown(exportMarkdown(editor));
      expect(textOf(again) === textOf(editor)).toBe(true);
    }, 120_000);

    it('gives a long line inside a fenced block back to that block', () => {
      const long = 'y'.repeat(LINEAR_IMPORT_LIMITS.lineChars + 1);
      for (const markdown of [`\`\`\`moss-html\n<p>${long}</p>\n\`\`\``, `\`\`\`js\nconst a = '${long}';\n\`\`\``]) {
        const state = JSON.stringify(importMarkdown(markdown).getEditorState().toJSON());
        expect(state.includes(long)).toBe(true);
        // No marker of a long line (a control character, which JSON escapes) is left behind.
        expect(/\\u000[1-8]/.test(state)).toBe(false);
      }
    }, 120_000);

    it('keeps a line of more than `matches` matches literally, and converts one of that many', () => {
      const line = (n: number) => `x ${'*a* word '.repeat(n)}`;
      const at = LINEAR_IMPORT_LIMITS.matches;
      let editor = importMarkdown('');
      expect(cuts(() => {
        editor = importMarkdown(line(at));
      })).toBe(0);
      expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(`x ${'a word '.repeat(at)}`);
      expect(cuts(() => {
        editor = importMarkdown(line(at + 1));
      })).toBe(1);
      expect(blocks(editor)).toEqual([['paragraph', line(at + 1)]]);
    }, 120_000);

    // A line whose work passes perChar per byte: dense short links, wiki links or tabs. A palette, the densest ordinary
    // paragraph and a short line of a few links convert.
    it('keeps a line that takes more work than its length allows literally', () => {
      const childTypes = (markdown: string) =>
        importMarkdown(markdown).getEditorState().read(() => $getRoot().getFirstChildOrThrow<ElementNode>().getChildren().map((node) => node.getType()));
      for (const dense of [`x ${'[a](b) '.repeat(2_000)}`, `x ${'[[a]] '.repeat(2_000)}`, `a${'\t'.repeat(1_000)}b`]) {
        let editor = importMarkdown('');
        expect(cuts(() => {
          editor = importMarkdown(dense);
        })).toBe(1);
        expect(blocks(editor)).toEqual([['paragraph', dense]]);
      }
      expect(cuts(() => importMarkdown('[a](b) [c](d) [[e]] *f*\tg'))).toBe(0);
      expect(childTypes('[a](b) [c](d) [[e]] *f*\tg')).toContain('tab');
      expect(cuts(() => importMarkdown(ORDINARY_NOTES['a palette paragraph of 2,000 colors']()))).toBe(0);
      expect(cuts(() => importMarkdown(ORDINARY_NOTES['a paragraph of 400 one-letter links, each followed by bold']()))).toBe(0);
    }, 120_000);

    it('keeps the tabs of a line of more than `tabs` tabs as text, and makes tab nodes of fewer', () => {
      const childTypes = (markdown: string) =>
        importMarkdown(markdown).getEditorState().read(() => $getRoot().getFirstChildOrThrow<ElementNode>().getChildren().map((node) => node.getType()));
      expect(childTypes('**a**\tb')).toEqual(['text', 'tab', 'text']);
      const many = `**a**${'\t'.repeat(LINEAR_IMPORT_LIMITS.tabs + 1)}b`;
      expect(cuts(() => importMarkdown(many))).toBe(1);
      expect(childTypes(many)).toEqual(['text']);
      expect(textOf(importMarkdown(many))).toBe(many);
    }, 120_000);

    // Numeric entities (`&#9;`, with leading zeros, or with an escaped `#`) decode to tabs after the inline pass, so they
    // count toward `tabs` as literal tabs do: a line of more keeps them as text, tab for tab.
    it('counts the tabs numeric entities decode to', () => {
      const childTypes = (markdown: string) =>
        importMarkdown(markdown).getEditorState().read(() => $getRoot().getFirstChildOrThrow<ElementNode>().getChildren().map((node) => node.getType()));
      expect(childTypes('**a**&#9;b')).toContain('tab');
      const over = LINEAR_IMPORT_LIMITS.tabs + 1;
      for (const entity of ['&#9;', '&#0009;', '&\\#9;']) {
        const many = `**a**${entity.repeat(over)}b`;
        expect(cuts(() => importMarkdown(many))).toBe(1);
        expect(childTypes(many)).toEqual(['text']);
        // moss's normalization wraps an entity in zero-width spaces, which stay beside the tab it decodes to.
        expect(textOf(importMarkdown(many)).replace(/\u200b/g, '')).toBe(`**a**${'\t'.repeat(over)}b`);
      }
      const mixed = `x ${'\t&#9;'.repeat(Math.ceil(over / 2))}`;
      expect(cuts(() => importMarkdown(mixed))).toBe(1);
      expect(childTypes(mixed)).toEqual(['text']);
      // A line cut at its work budget keeps its tabs as text too.
      const dense = `x ${'[a](b) '.repeat(2_000)}\t&#9;`;
      expect(cuts(() => importMarkdown(dense))).toBe(1);
      expect(childTypes(dense)).toEqual(['text']);
    }, 120_000);

    // A note's work, its lines' and its table cells', is held to perNote: past it, each line after keeps its text as
    // literal text and each table row after is a paragraph line, so a note of any lines stays within SP2.
    it('keeps the lines after a note has spent perNote as literal text', () => {
      const perNote = LINEAR_IMPORT_LIMITS.perNote;
      const line = 'x [a](b) **c**';
      const note = Array.from({ length: 400 }, () => line).join('\n\n');
      const table = ['| a | b |', '| --- | --- |', ...Array.from({ length: 400 }, (_, i) => `| *${i}* | [l](u) |`)].join('\n');
      try {
        LINEAR_IMPORT_LIMITS.perNote = 2_000_000;
        let editor = importMarkdown('');
        const cut = cuts(() => {
          editor = importMarkdown(note);
        });
        const shapes = blocks(editor);
        expect(shapes).toHaveLength(400);
        expect(cut).toBeGreaterThan(0);
        expect(cut).toBeLessThan(400);
        // The lines before the budget ran out convert; every line after it is literal.
        expect(shapes[0]).toEqual(['paragraph', 'x a c']);
        expect(shapes.at(-1)).toEqual(['paragraph', line]);
        const literal = shapes.findIndex(([, text]) => text === line);
        expect(shapes.slice(literal).every(([, text]) => text === line)).toBe(true);
        expect(JSON.stringify(importMarkdown(note).getEditorState().toJSON())).toBe(JSON.stringify(editor.getEditorState().toJSON()));
        const types = importMarkdown(table).getEditorState().read(() => $getRoot().getChildren().map((block) => block.getType()));
        expect(types[0]).toBe('table');
        expect(types.slice(1).length).toBeGreaterThan(0);
        expect(types.slice(1).every((type) => type === 'paragraph')).toBe(true);
      } finally {
        LINEAR_IMPORT_LIMITS.perNote = perNote;
      }
      expect(cuts(() => importMarkdown(note))).toBe(0);
      expect(importMarkdown(table).getEditorState().read(() => $getRoot().getChildren().map((block) => block.getType()))).toEqual(['table']);
    }, 120_000);

    // Nothing about a cut depends on timing or on anything but the bytes imported.
    it('imports the same bytes the same way every time', () => {
      const stateOf = (markdown: string) => JSON.stringify(importMarkdown(markdown).getEditorState().toJSON());
      const differing: string[] = [];
      for (const [name, c] of Object.entries(CONVERTER_CASES)) {
        for (const bytes of [1024, 64 * 1024, 256 * 1024]) {
          const markdown = converterBody(c, bytes);
          if (stateOf(markdown) !== stateOf(markdown)) differing.push(`${name} at ${bytes} B`);
        }
      }
      expect(differing).toEqual([]);
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

  // T3.S4's third check: table rows and notes of repeated short lines that took quadratic time or worse (moss's table
  // parsing, its block scans and cell merges, Lexical's joining of a paragraph's lines and its tab split): each imports
  // and exports at four times the size in about four times the time.
  it.each([
    ['a table cell of escaped backticks', (n: number) => `| \`${'\\`'.repeat(n)}x |`, 500],
    ['a table row of escaped wiki openers', (n: number) => `| a | ${'\\[[a | '.repeat(n)} |`, 300],
    ['a table row of backslashes', (n: number) => `| a | ${'\\'.repeat(n)} |`, 8_000],
    ['a table row of empty cells', (n: number) => `| a ${'|'.repeat(n)}`, 20_000],
    ['lines of one quote', (n: number) => '> a\n'.repeat(n), 4_000],
    ['tab-indented lines', (n: number) => '\ta\n'.repeat(n), 1_000],
    ['entity-tab-indented lines', (n: number) => '&#9;a\n'.repeat(n), 1_000],
    ['a line of entity tabs', (n: number) => `x ${'&#9;'.repeat(n)}`, 5_000],
    ['tab group openers', (n: number) => ':::tabs\n'.repeat(n), 2_000],
    ['table rows of open wiki links', (n: number) => '| [[a\n'.repeat(n), 1_000],
    ['table rows of open wiki links after a table', (n: number) => `| a | b |\n| --- | --- |\n${'| [[c | d |\n'.repeat(n)}`, 500],
    ['pill openers between bold delimiters', (n: number) => `x **${'?['.repeat(n)}**`, 5_000],
  ] as const)('imports and exports in linear time: %s', (_name, body, n) => {
    const timed = (markdown: string) => {
      const started = performance.now();
      exportMarkdown(importMarkdown(markdown));
      return performance.now() - started;
    };
    timed(body(n / 10));
    const small = timed(body(n));
    const large = timed(body(4 * n));
    expect(small).toBeLessThan(3_000);
    expect(large).toBeLessThan(Math.max(8 * small, 400));
  }, 120_000);
});

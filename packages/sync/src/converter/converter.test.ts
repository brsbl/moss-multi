// L1 (A§12; S-conv §5): the converter in Node with no DOM. Per family: the import golden (A1), the export golden
// (A2) and the fixpoint (A3). A missing golden fails; with GOLDEN_OUT set it is also written there for review.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $convertFromMarkdownString, $convertToMarkdownString, registerMarkdownShortcuts, type Transformer } from '@lexical/markdown';
import { LinkNode } from '@lexical/link';
import { CodeNode } from '@lexical/code-core';
import { $createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection } from 'lexical';
import { describe, expect, it } from 'vitest';
import { withImportFormulaIds } from '@moss-desktop/renderer/editor/markdown/fixes';
import { $postImportNormalize, escapeHtmlEntities, normalizeMarkdownForImport, unescapeHtmlEntities } from '@moss-desktop/renderer/editor/markdown/normalize';
import { createConverterEditor, exportMarkdown, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS, type NoteBodyImportOptions } from './index.ts';
import { CANONICALIZED, DEVIATING, FIXTURES, fixture, golden, NOT_IDEMPOTENT, SCALE_FIXTURES, SCALE_UNIT, stringify, transformerSignature } from './fixtures.ts';

function expectGolden(file: string, actual: string): void {
  const expected = golden(file);
  if (expected === undefined) {
    const out = process.env.GOLDEN_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, file), actual);
    }
    throw new Error(`golden fixtures/goldens/${file} is missing${out ? `; wrote it to ${out}` : ''}`);
  }
  expect(actual).toBe(expected);
}

const treeOf = (markdown: string, options?: NoteBodyImportOptions) => stringify(importMarkdown(markdown, options).getEditorState().toJSON());

describe('L1 converter in Node @p:tech-1', () => {
  it('runs without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('covers every family in S-conv §5.4', () => {
    const families = [
      'paragraphs', 'text-formats', 'styles', 'entities', 'headings', 'quotes', 'lists', 'rules', 'links', 'wiki-links',
      'embed-pills', 'raw-urls', 'images', 'line-loss', 'video', 'web-embed', 'code-blocks', 'callouts', 'charts',
      'canvas', 'moss-html', 'tabs', 'tables', 'formulas', 'color-codes', 'comments', 'composition',
    ];
    expect(FIXTURES.map((f) => f.name)).toEqual(expect.arrayContaining(families));
  });

  describe.each(FIXTURES.map((f) => [f.name, f] as const))('%s', (name, { markdown, options }) => {
    it('A1 matches its import golden', () => {
      expectGolden(`${name}.json`, treeOf(markdown, options));
    });

    it('A2 matches its export golden', () => {
      expectGolden(`${name}.export.md`, exportMarkdown(importMarkdown(markdown, options)));
    });

    // A known miss also pins its second pass as a golden, so any further change on that pass fails.
    it(NOT_IDEMPOTENT[name] ? `A3 export is not idempotent at the pin: ${NOT_IDEMPOTENT[name]}` : 'A3 export is idempotent after one pass', () => {
      const exported = exportMarkdown(importMarkdown(markdown, options));
      const again = exportMarkdown(importMarkdown(exported, options));
      if (!NOT_IDEMPOTENT[name]) return expect(again).toBe(exported);
      expect(again).not.toBe(exported);
      expectGolden(`${name}.export2.md`, again);
    });

    const known = CANONICALIZED[name] ?? NOT_IDEMPOTENT[name];
    it(known ? `A3 first import is not the exported tree at the pin: ${known}` : 'A3 first import is the tree its export carries', () => {
      const reimported = treeOf(exportMarkdown(importMarkdown(markdown, options)), options);
      if (!known) return expect(reimported).toBe(treeOf(markdown, options));
      expect(reimported).not.toBe(treeOf(markdown, options));
      expectGolden(`${name}.reimport.json`, reimported);
    });
  });
});

describe('converter fixes @p:tech-4', () => {
  it('mints the same formula ids for the same markdown on every import', () => {
    const { markdown } = fixture('formulas');
    expect(treeOf(markdown)).toBe(treeOf(markdown));
    const exported = exportMarkdown(importMarkdown(markdown));
    expect(exported).toBe(exportMarkdown(importMarkdown(markdown)));
    expect(exported).toMatch(/\{\{timeline\|6 weeks\|id=[0-9a-f-]{36}\}\}/);
  });

  it('gives repeated anonymous formulas distinct ids', () => {
    const state = importMarkdown('{{2+2|4}} and {{2+2|4}}').getEditorState().toJSON();
    const ids = JSON.stringify(state).match(/"formulaId":"[^"]+"/g) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it('never mints an id the note already carries, before or after the formula that carries it', () => {
    // a404dbad-… is the id an earlier import minted for the first anonymous `timeline|6 weeks`.
    const markdown = [
      'Added before {{timeline|6 weeks}} the exported one.',
      'Exported earlier {{timeline|6 weeks|id=a404dbad-dbf9-55f7-ac7c-3faac17874c9}}.',
      'Added after {{timeline|6 weeks}} it.',
    ].join('\n\n');
    const ids = (text: string) => [...JSON.stringify(importMarkdown(text).getEditorState().toJSON()).matchAll(/"formulaId":"([^"]+)"/g)].map((m) => m[1]);
    const first = ids(markdown);
    expect(first).toHaveLength(3);
    expect(new Set(first).size).toBe(3);
    expect(first[1]).toBe('a404dbad-dbf9-55f7-ac7c-3faac17874c9');
    expect(ids(markdown)).toEqual(first);
    expect(ids(exportMarkdown(importMarkdown(markdown)))).toEqual(first);
  });

  it('keeps the text of IMAGE and TABLE lines moss imported as empty paragraphs (DEVIATIONS)', () => {
    expect(DEVIATING.has('line-loss')).toBe(true);
    const exported = exportMarkdown(importMarkdown(fixture('line-loss').markdown));
    expect(exported).toContain('caption (x)');
    expect(exported).toContain('https://cdn.example.com/clip.mp4');
    expect(exported).toContain('| --- | --- |');
  });

  // MarkdownEditor also runs these transformers as typing shortcuts. There Lexical passes the text after the caret
  // as `children` and clears nothing, so a rejected line must leave every node as it was.
  async function typeSpaceAfter(line: string, following: string): Promise<string> {
    const editor = createConverterEditor();
    const stop = registerMarkdownShortcuts(editor, MARKDOWN_EDITOR_TRANSFORMERS);
    try {
      editor.update(
        () => {
          const text = $createTextNode(line);
          $getRoot().clear().append($createParagraphNode().append(text, $createTextNode(following).toggleFormat('bold')));
          text.select(line.length, line.length);
        },
        { discrete: true },
      );
      editor.update(
        () => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) throw new Error('expected a range selection');
          selection.insertText(' ');
        },
        { discrete: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      return editor.getEditorState().read(() => $getRoot().getTextContent());
    } finally {
      stop();
    }
  }

  it.each([
    ['![clip](https://cdn.example.com/clip.mp4)', 'important'],
    ['| --- | --- |', 'note'],
  ])('typing a space after a rejected `%s` keeps the line and the text after the caret', async (line, following) => {
    expect(await typeSpaceAfter(line, following)).toBe(`${line} ${following}`);
  });
});

// S-conv §5.4 Scale. The 2 MB note itself converts, timed, in workerd in the SP2 step (scripts/measure-converter.mjs).
describe('scale @p:tech-1', () => {
  const blocks = (markdown: string) => importMarkdown(markdown).getEditorState().read(() => $getRoot().getChildrenSize());
  const formulaIds = (markdown: string) => [...treeOf(markdown).matchAll(/"formulaId": "([^"]+)"/g)].map((m) => m[1]);

  // Fewer blocks means one fixture or copy swallowed the next (fixtures/scale.json says what is left out and why).
  it('the scale unit has exactly the blocks of its fixtures, and two units twice that', () => {
    expect(blocks(SCALE_UNIT)).toBe(SCALE_FIXTURES.reduce((sum, f) => sum + blocks(f.markdown), 0));
    expect(blocks(`${SCALE_UNIT}\n\n${SCALE_UNIT}`)).toBe(2 * blocks(SCALE_UNIT));
  });

  it('1,000 formulas get 1,000 distinct ids that survive the round trip', () => {
    const markdown = Array.from({ length: 500 }, (_, i) => `Row ${i}: {{${i}+1|${i + 1}}} and {{total|6 weeks}}`).join('\n\n');
    const ids = formulaIds(markdown);
    expect(ids).toHaveLength(1000);
    expect(new Set(ids).size).toBe(1000);
    const exported = exportMarkdown(importMarkdown(markdown));
    expect(formulaIds(exported)).toEqual(ids);
    expect(exportMarkdown(importMarkdown(exported))).toBe(exported);
  });

  it('50 tables import as 50 tables and round-trip', () => {
    const table = (i: number) => `| Item ${i} | Value |\n| --- | --- |\n| a${i} | {{${i}*2|${i * 2}}} |\n| b${i} | [[Note ${i}]] |`;
    const markdown = Array.from({ length: 50 }, (_, i) => `Table ${i}\n\n${table(i)}`).join('\n\n');
    const tables = (text: string) => importMarkdown(text).getEditorState().read(() => $getRoot().getChildren().filter((node) => node.getType() === 'table').length);
    expect(tables(markdown)).toBe(50);
    const exported = exportMarkdown(importMarkdown(markdown));
    expect(tables(exported)).toBe(50);
    expect(exportMarkdown(importMarkdown(exported))).toBe(exported);
  });
});

// Each control must break a golden, proving the goldens see transformer order and membership.
describe('negative controls @p:tech-4', () => {
  // The pipeline's own steps with a substitute transformer list: the A1 tree and the A2 export, as one string.
  function roundTripWith(transformers: Transformer[], markdown: string, options: NoteBodyImportOptions = {}): string {
    const editor = createConverterEditor();
    const prepared = escapeHtmlEntities(normalizeMarkdownForImport(markdown));
    editor.update(
      () =>
        withImportFormulaIds(prepared, () => {
          $convertFromMarkdownString(prepared, transformers);
          $postImportNormalize(options.comments, undefined, { layoutMetadata: options.layout });
        }),
      { discrete: true },
    );
    const state = editor.getEditorState();
    return `${stringify(state.toJSON())}${state.read(() => unescapeHtmlEntities($convertToMarkdownString(transformers)))}`;
  }
  const goldenPair = (name: string) => `${golden(`${name}.json`)}${golden(`${name}.export.md`)}`;
  const list = () => [...MARKDOWN_EDITOR_TRANSFORMERS];
  const indexOf = (transformers: Transformer[], test: (t: Transformer & Record<string, unknown>) => boolean) => {
    const index = transformers.findIndex((t) => test(t as Transformer & Record<string, unknown>));
    expect(index, 'transformer not found').toBeGreaterThanOrEqual(0);
    return index;
  };
  const isImage = (t: Record<string, unknown>) => t.type === 'element' && (t.regExp as RegExp)?.source === '^!\\[.*\\]\\(.*\\)\\s*$';
  const isLegacyPill = (t: Record<string, unknown>) => t.type === 'text-match' && (t.importRegExp as RegExp)?.source.startsWith('\\?\\[');
  const isLink = (t: Record<string, unknown>) => t.type === 'text-match' && (t.dependencies as unknown[])?.includes(LinkNode);
  const isMossHtml = (t: Record<string, unknown>) => t.type === 'multiline-element' && (t.regExpStart as RegExp)?.source.includes('moss-html');
  const isCode = (t: Record<string, unknown>) => t.type === 'multiline-element' && (t.dependencies as unknown[])?.includes(CodeNode);

  it('pins the 45-entry order the controls rely on', () => {
    const transformers = list();
    expect(transformers).toHaveLength(45);
    expectGolden('transformer-order.txt', `${transformers.map(transformerSignature).join('\n')}\n`);
    expect(indexOf(transformers, isImage)).toBe(2);
    expect(indexOf(transformers, isLegacyPill)).toBeLessThan(indexOf(transformers, isLink));
    expect(indexOf(transformers, isMossHtml)).toBeLessThan(indexOf(transformers, isCode));
  });

  it('reproduces the goldens with the real list', () => {
    for (const name of ['images', 'embed-pills', 'moss-html']) {
      const { markdown, options } = fixture(name);
      expect(roundTripWith(list(), markdown, options), name).toBe(goldenPair(name));
    }
  });

  it('removing IMAGE_TRANSFORMER breaks the images golden', () => {
    const transformers = list();
    transformers.splice(indexOf(transformers, isImage), 1);
    expect(roundTripWith(transformers, fixture('images').markdown)).not.toBe(goldenPair('images'));
  });

  it('moving EMBED_PILL_TRANSFORMER after LINK_TRANSFORMER breaks the legacy pill', () => {
    const transformers = list();
    const [pill] = transformers.splice(indexOf(transformers, isLegacyPill), 1);
    transformers.splice(indexOf(transformers, isLink) + 1, 0, pill);
    expect(roundTripWith(transformers, fixture('embed-pills').markdown)).not.toBe(goldenPair('embed-pills'));
  });

  it('moving the moss-html transformer after CODE turns the block into code', () => {
    const transformers = list();
    const [html] = transformers.splice(indexOf(transformers, isMossHtml), 1);
    transformers.splice(indexOf(transformers, isCode) + 1, 0, html);
    const result = roundTripWith(transformers, fixture('moss-html').markdown);
    expect(result).not.toBe(goldenPair('moss-html'));
    expect(result).toContain('"type": "code-block"');
  });
});

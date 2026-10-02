// L1 (A§12; S-conv §5): the converter in Node with no DOM. Per family: the import golden (A1), the export golden
// (A2) and the fixpoint (A3). A missing golden fails; with GOLDEN_OUT set it is also written there for review.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { $convertFromMarkdownString, $convertToMarkdownString, type Transformer } from '@lexical/markdown';
import { LinkNode } from '@lexical/link';
import { CodeNode } from '@lexical/code-core';
import { describe, expect, it } from 'vitest';
import { withImportFormulaIds } from '@moss-desktop/renderer/editor/markdown/fixes';
import { $postImportNormalize, escapeHtmlEntities, normalizeMarkdownForImport, unescapeHtmlEntities } from '@moss-desktop/renderer/editor/markdown/normalize';
import { createConverterEditor, exportMarkdown, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS, type NoteBodyImportOptions } from './index.ts';
import { CANONICALIZED, DEVIATING, FIXTURES, fixture, golden, NOT_IDEMPOTENT, stringify } from './fixtures.ts';

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

    it(NOT_IDEMPOTENT[name] ? `A3 export is not idempotent at the pin: ${NOT_IDEMPOTENT[name]}` : 'A3 export is idempotent after one pass', () => {
      const exported = exportMarkdown(importMarkdown(markdown, options));
      const again = exportMarkdown(importMarkdown(exported, options));
      if (NOT_IDEMPOTENT[name]) expect(again).not.toBe(exported);
      else expect(again).toBe(exported);
    });

    const known = CANONICALIZED[name] ?? NOT_IDEMPOTENT[name];
    it(known ? `A3 first import is not the exported tree at the pin: ${known}` : 'A3 first import is the tree its export carries', () => {
      const exported = exportMarkdown(importMarkdown(markdown, options));
      if (known) expect(treeOf(exported, options)).not.toBe(treeOf(markdown, options));
      else expect(treeOf(exported, options)).toBe(treeOf(markdown, options));
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

  it('keeps the text of IMAGE and TABLE lines moss imported as empty paragraphs (DEVIATIONS)', () => {
    expect(DEVIATING.has('line-loss')).toBe(true);
    const exported = exportMarkdown(importMarkdown(fixture('line-loss').markdown));
    expect(exported).toContain('caption (x)');
    expect(exported).toContain('https://cdn.example.com/clip.mp4');
    expect(exported).toContain('| --- | --- |');
  });
});

// Each control must break a golden, proving the goldens see transformer order and membership.
describe('negative controls @p:tech-4', () => {
  // The pipeline's own steps with a substitute transformer list: the A1 tree and the A2 export, as one string.
  function roundTripWith(transformers: Transformer[], markdown: string, options: NoteBodyImportOptions = {}): string {
    const editor = createConverterEditor();
    editor.update(
      () =>
        withImportFormulaIds(() => {
          $convertFromMarkdownString(escapeHtmlEntities(normalizeMarkdownForImport(markdown)), transformers);
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

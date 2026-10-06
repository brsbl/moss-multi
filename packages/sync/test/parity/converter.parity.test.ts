// L3 (A§12; S-conv §5.1): the split converter against moss's own pipeline at the pin, run from the pristine
// MarkdownEditor.tsx in jsdom as moss's tests run it. Same tree and same markdown for every fixture, except the
// documented deviations; formula ids the markdown does not carry are compared by order (moss mints random ones).
import { createHeadlessEditor } from '@lexical/headless';
import { $convertFromMarkdownString, $convertToMarkdownString, type Transformer } from '@lexical/markdown';
import type { Klass, LexicalNode } from 'lexical';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportMarkdown, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS, type NoteBodyImportOptions } from '../../src/converter/index.ts';
import { DEVIATING, FIXTURES, fixture, stringify, transformerSignature } from '../../src/converter/fixtures.ts';
import { CONVERTER_CASES, converterBody } from '../../measure/converter-cases.ts';

declare const __MOSS_PRISTINE__: string;

interface MossEditorModule {
  MARKDOWN_EDITOR_NODES: Klass<LexicalNode>[];
  MARKDOWN_EDITOR_TRANSFORMERS: Transformer[];
  normalizeMarkdownForImport(markdown: string): string;
  escapeHtmlEntities(markdown: string): string;
  unescapeHtmlEntities(markdown: string): string;
  $postImportNormalize(comments?: unknown, root?: unknown, options?: { layoutMetadata?: unknown }): void;
}

let moss: MossEditorModule;

beforeAll(async () => {
  const entry = `${__MOSS_PRISTINE__}/packages/desktop/src/renderer/editor/MarkdownEditor.tsx`;
  moss = (await import(/* @vite-ignore */ entry)) as MossEditorModule;
}, 120_000);

// moss's importMarkdownValue and serializeCurrent, minus the H1 lift (the converter keeps the H1 as content).
function pristineRoundTrip(markdown: string, options: NoteBodyImportOptions) {
  const editor = createHeadlessEditor({ namespace: 'pristine', nodes: moss.MARKDOWN_EDITOR_NODES, onError: (error) => {
    throw error;
  } });
  editor.update(
    () => {
      $convertFromMarkdownString(moss.escapeHtmlEntities(moss.normalizeMarkdownForImport(markdown)), moss.MARKDOWN_EDITOR_TRANSFORMERS);
      moss.$postImportNormalize(options.comments, undefined, { layoutMetadata: options.layout });
    },
    { discrete: true },
  );
  const state = editor.getEditorState();
  return { tree: state.toJSON(), markdown: state.read(() => moss.unescapeHtmlEntities($convertToMarkdownString(moss.MARKDOWN_EDITOR_TRANSFORMERS))) };
}

function oursRoundTrip(markdown: string, options: NoteBodyImportOptions) {
  const editor = importMarkdown(markdown, options);
  return { tree: editor.getEditorState().toJSON(), markdown: exportMarkdown(editor) };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

// Replaces formula ids the source does not author with their order of appearance.
function comparable(source: string, result: { tree: unknown; markdown: string }) {
  const authored = new Set(source.match(UUID) ?? []);
  const order = new Map<string, string>();
  const ordinal = (id: string) => {
    if (authored.has(id)) return id;
    if (!order.has(id)) order.set(id, `minted-${order.size}`);
    return order.get(id)!;
  };
  const tree = JSON.parse(JSON.stringify(result.tree), (key, value) => (key === 'formulaId' && typeof value === 'string' ? ordinal(value) : value));
  return { tree: stringify(tree), markdown: result.markdown.replace(UUID, ordinal) };
}

describe('L3 parity with moss at the pin @p:tech-4', () => {
  it('runs the same 45 transformers as moss, in the same order', () => {
    expect(MARKDOWN_EDITOR_TRANSFORMERS).toHaveLength(45);
    expect(MARKDOWN_EDITOR_TRANSFORMERS.map(transformerSignature)).toEqual(moss.MARKDOWN_EDITOR_TRANSFORMERS.map(transformerSignature));
  });

  it.each(FIXTURES.filter((f) => !DEVIATING.has(f.name)).map((f) => [f.name, f] as const))('%s', (_name, { markdown, options }) => {
    const ours = comparable(markdown, oursRoundTrip(markdown, options));
    const pristine = comparable(markdown, pristineRoundTrip(markdown, options));
    expect(ours.tree).toBe(pristine.tree);
    expect(ours.markdown).toBe(pristine.markdown);
  });

  // The linear matching (markdown/linear-match.ts) changes no output on notes of unclosed openers.
  it.each(Object.entries(CONVERTER_CASES))('unclosed openers, %s', (_name, c) => {
    for (const bytes of [40, 3_000]) {
      const markdown = converterBody(c, bytes);
      const ours = comparable(markdown, oursRoundTrip(markdown, {}));
      const pristine = comparable(markdown, pristineRoundTrip(markdown, {}));
      expect(ours.tree).toBe(pristine.tree);
      expect(ours.markdown).toBe(pristine.markdown);
    }
  });

  it('line-loss: moss drops the rejected lines, the converter keeps them (DEVIATIONS)', () => {
    const { markdown, options } = fixture('line-loss');
    const pristine = pristineRoundTrip(markdown, options).markdown;
    const ours = oursRoundTrip(markdown, options).markdown;
    for (const text of ['caption (x)', 'https://cdn.example.com/clip.mp4', '| --- | --- |']) {
      expect(pristine).not.toContain(text);
      expect(ours).toContain(text);
    }
  });
});

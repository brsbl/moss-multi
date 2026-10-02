// L2 (A§12; S-conv §5.1): the converter inside workerd gives the L1 results, and a 2 MB note converts.
import { $getRoot, type LexicalEditor } from 'lexical';
import { describe, expect, it } from 'vitest';
import { FIXTURES, golden, SCALE_UNIT, scaleNote, stringify } from '../../src/converter/fixtures.ts';

declare const __MOSS_PRISTINE__: string;

// The import cycle (S-conv B5): nodes → CommentPlugin → comment-import → MarkdownEditor → nodes. Entered at a
// node file, the transformer module runs before that class exists. A native ESM engine throws the TDZ
// ReferenceError; Vite's module runner hands over `undefined` instead. Either is the same defect.
async function enterAtChartNode(load: () => Promise<{ chart: unknown; nodes: unknown[] }>) {
  try {
    const { chart, nodes } = await load();
    const captured = nodes.filter((node) => node === undefined).length;
    return { broken: captured > 0 || !nodes.includes(chart), detail: `${captured} node classes captured before initialization` };
  } catch (error) {
    return { broken: /before initialization/.test(String(error)), detail: String(error) };
  }
}

describe('L2 converter in workerd @p:tech-1', () => {
  it('enters at a node class, as a server entry does, and gets every class it registers', { timeout: 120_000 }, async () => {
    const entered = await enterAtChartNode(async () => {
      const { ChartNode } = await import('@moss-desktop/renderer/editor/nodes/ChartNode');
      const { MARKDOWN_EDITOR_NODES } = await import('../../src/converter/index.ts');
      return { chart: ChartNode, nodes: [...MARKDOWN_EDITOR_NODES] };
    });
    expect(entered.broken, `TDZ in the converter's import graph: ${entered.detail}`).toBe(false);
    const { exportMarkdown, importMarkdown } = await import('../../src/converter/index.ts');
    expect(typeof document).toBe('undefined');
    expect(exportMarkdown(importMarkdown('Hello **workerd**'))).toBe('Hello **workerd**');
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))('A5 %s matches the L1 goldens', { timeout: 60_000 }, async (name, { markdown, options }) => {
    const { exportMarkdown, importMarkdown } = await import('../../src/converter/index.ts');
    const editor = importMarkdown(markdown, options);
    expect(stringify(editor.getEditorState().toJSON())).toBe(golden(`${name}.json`));
    expect(exportMarkdown(editor)).toBe(golden(`${name}.export.md`));
  });

  // The SP2 step (scripts/measure-converter.mjs) converts and times the same note at 2 MB in workerd.
  it('converts the mixed-family scale note with every block of every copy', { timeout: 120_000 }, async () => {
    const { exportMarkdown, importMarkdown } = await import('../../src/converter/index.ts');
    const blocks = (editor: LexicalEditor) => editor.getEditorState().read(() => $getRoot().getChildrenSize());
    const unit = importMarkdown(SCALE_UNIT);
    const editor = importMarkdown(scaleNote(8));
    expect(blocks(editor)).toBe(8 * blocks(unit));
    expect(blocks(importMarkdown(exportMarkdown(editor)))).toBe(8 * blocks(importMarkdown(exportMarkdown(unit))));
  });
});

describe('L2 negative control: the unsplit tree @p:tech-1', () => {
  it('entering pristine moss at nodes/ChartNode breaks the node set', { timeout: 120_000 }, async () => {
    const editor = `${__MOSS_PRISTINE__}/packages/desktop/src/renderer/editor`;
    const entered = await enterAtChartNode(async () => {
      const { ChartNode } = await import(/* @vite-ignore */ `${editor}/nodes/ChartNode.tsx`);
      const { MARKDOWN_EDITOR_NODES } = await import(/* @vite-ignore */ `${editor}/MarkdownEditor.tsx`);
      return { chart: ChartNode, nodes: [...MARKDOWN_EDITOR_NODES] };
    });
    expect(entered.broken, entered.detail).toBe(true);
  });
});

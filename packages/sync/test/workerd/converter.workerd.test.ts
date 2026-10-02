// L2 (A§12; S-conv §5.1): the converter inside workerd gives the L1 results, and a 2 MB note converts.
import { describe, expect, it } from 'vitest';
import { FIXTURES, golden, stringify } from '../../src/converter/fixtures.ts';

declare const __MOSS_PRISTINE__: string;

describe('L2 converter in workerd @p:tech-1', () => {
  it('imports the node classes before the transformers, as a server entry does, and converts', async () => {
    // Entering at a node file is what a server does; on the unsplit tree this is the TDZ cycle (S-conv B5).
    const { ChartNode } = await import('@moss-desktop/renderer/editor/nodes/ChartNode');
    const { exportMarkdown, importMarkdown, MARKDOWN_EDITOR_NODES } = await import('../../src/converter/index.ts');
    expect(MARKDOWN_EDITOR_NODES).toContain(ChartNode);
    expect(typeof document).toBe('undefined');
    expect(exportMarkdown(importMarkdown('Hello **workerd**'))).toBe('Hello **workerd**');
  });

  it.each(FIXTURES.map((f) => [f.name, f] as const))('A5 %s matches the L1 goldens', async (name, { markdown, options }) => {
    const { exportMarkdown, importMarkdown } = await import('../../src/converter/index.ts');
    const editor = importMarkdown(markdown, options);
    expect(stringify(editor.getEditorState().toJSON())).toBe(golden(`${name}.json`));
    expect(exportMarkdown(editor)).toBe(golden(`${name}.export.md`));
  });

  it('converts a 2 MB note', { timeout: 120_000 }, async () => {
    const { exportMarkdown, importMarkdown } = await import('../../src/converter/index.ts');
    const corpus = FIXTURES.filter((f) => !f.options.comments).map((f) => f.markdown).join('\n\n');
    let note = '';
    while (note.length < 2 * 1024 * 1024) note += `${corpus}\n\n`;
    const exported = exportMarkdown(importMarkdown(note));
    expect(exported.length).toBeGreaterThan(note.length / 2);
  });
});

describe('L2 negative control: the unsplit tree @p:tech-1', () => {
  it('entering pristine moss at nodes/ChartNode throws the TDZ error', async () => {
    // Prism's global is installed first so the only failure left is the import cycle (S-conv B4, B5).
    const prism = (await import('prismjs')) as { default?: unknown };
    (globalThis as { Prism?: unknown }).Prism ??= prism.default ?? prism;
    const entry = `${__MOSS_PRISTINE__}/packages/desktop/src/renderer/editor/nodes/ChartNode.tsx`;
    await expect(import(/* @vite-ignore */ entry)).rejects.toThrow(/before initialization/);
  });
});

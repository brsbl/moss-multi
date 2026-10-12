// One converter (A§0, A§12): every client path that imports a whole note's markdown (MarkdownEditor's load, paste and
// replacement, the embedded editor's content update) prepares it as the DocDO does ($importNoteBody), so a line's
// budget and cut (markdown/linear-import.ts) are reckoned on the same bytes on both sides.
import { readFileSync } from 'node:fs';
import * as pipeline from '@moss-desktop/renderer/editor/markdown/pipeline';
import { $convertFromMarkdownString, LINEAR_IMPORT_LIMITS } from '@moss-desktop/renderer/editor/markdown/linear-import';
import { $postImportNormalize } from '@moss-desktop/renderer/editor/markdown/normalize';
import { describe, expect, it } from 'vitest';
import { createConverterEditor, importMarkdown, MARKDOWN_EDITOR_TRANSFORMERS } from './index.ts';

const REPO = new URL('../../../../', import.meta.url);
const SITES = ['vendor/moss/packages/desktop/src/renderer/editor/MarkdownEditor.tsx', 'packages/editor/src/mount.tsx'];

// The first argument of each `$convertFromMarkdownString(` call in the source.
function importArguments(source: string): string[] {
  const args: string[] = [];
  for (let at = source.indexOf('$convertFromMarkdownString('); at >= 0; at = source.indexOf('$convertFromMarkdownString(', at + 1)) {
    let depth = 0;
    let i = at + '$convertFromMarkdownString('.length;
    const start = i;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ',' && depth === 0) break;
    }
    args.push(source.slice(start, i).trim());
  }
  return args;
}

describe('client imports prepare markdown as the DocDO does @p:tech-4', () => {
  for (const site of SITES) {
    it(`${site} imports only prepared markdown`, () => {
      const source = readFileSync(new URL(site, REPO), 'utf8');
      const args = importArguments(source);
      expect(args.length).toBeGreaterThan(0);
      for (const arg of args) expect(arg).toMatch(/^prepareNoteMarkdown\(/);
      const code = source
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      expect(code).not.toMatch(/\bnormalizeMarkdownForImport\(/);
    });
  }

  it('prepareNoteMarkdown then the import gives $importNoteBody tree, for long lines and lines normalization lengthens', () => {
    const prepare = (pipeline as Record<string, unknown>).prepareNoteMarkdown as ((markdown: string) => string) | undefined;
    expect(typeof prepare).toBe('function');
    const highlight = `==${Array.from({ length: 400 }, (_, i) => `**b${i}** *i${i}*`).join(' ')}==`;
    const long = `quokka ${'*a* '.repeat(Math.ceil(LINEAR_IMPORT_LIMITS.lineChars / 4) + 10)}`;
    for (const markdown of [`# Note\n\n${highlight}\n\nafter`, `before\n\n${long}\n\nafter *b*`]) {
      const editor = createConverterEditor();
      editor.update(
        () => {
          $convertFromMarkdownString(prepare!(markdown), MARKDOWN_EDITOR_TRANSFORMERS);
          $postImportNormalize();
        },
        { discrete: true },
      );
      const client = JSON.stringify(editor.getEditorState().toJSON().root);
      expect(client).toBe(JSON.stringify(importMarkdown(markdown).getEditorState().toJSON().root));
    }
  });
});

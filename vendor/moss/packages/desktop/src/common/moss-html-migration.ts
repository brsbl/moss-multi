// ported-from: packages/desktop/src/common/moss-html-migration.ts @ 762abb777
import {
  canonicalizeMossHtmlDocument,
  type MossHtmlDocumentOptions
} from './moss-html-document';
import {
  buildFencedCodeBlock,
  scanMossHtmlFenceBlocks
} from './markdown-fences';

export const canonicalizeMossHtmlBlocks = (
  markdown: string,
  options: MossHtmlDocumentOptions = {}
): {
  markdown: string;
  changed: boolean;
  warnings: string[];
  canonicalizedBlockCount: number;
} => {
  if (!markdown.includes('moss-html')) {
    return {
      markdown,
      changed: false,
      warnings: [],
      canonicalizedBlockCount: 0
    };
  }

  const lines = markdown.split('\n');
  const warnings: string[] = [];
  const replacements: Array<{
    startLineIndex: number;
    deleteCount: number;
    replacementLines: string[];
  }> = [];
  let canonicalizedBlockCount = 0;

  for (const item of scanMossHtmlFenceBlocks(lines)) {
    if (item.kind === 'unterminated') {
      warnings.push(
        `[moss-html-migration] unterminated moss-html fence at line ${item.headerLineIndex + 1}`
      );
      continue;
    }

    const { block } = item;
    const trimmedRawHtml = block.rawHtml.trim();
    if (trimmedRawHtml.length === 0) {
      continue;
    }
    try {
      const canonicalized = canonicalizeMossHtmlDocument(trimmedRawHtml, options);
      if (!canonicalized.didUpgrade) {
        continue;
      }

      replacements.push({
        startLineIndex: block.headerLineIndex,
        deleteCount: block.closingLineIndex - block.headerLineIndex + 1,
        replacementLines: buildFencedCodeBlock({
          rawContent: canonicalized.rawHtml,
          info: 'moss-html',
          minimumFenceLength: block.fenceLength,
          indent: block.indent
        }).split('\n')
      });
      canonicalizedBlockCount += 1;
    } catch (error) {
      warnings.push(
        `[moss-html-migration] failed to canonicalize moss-html fence at line ${block.headerLineIndex + 1}: ${(error as Error).message}`
      );
    }
  }

  for (const replacement of replacements.reverse()) {
    lines.splice(
      replacement.startLineIndex,
      replacement.deleteCount,
      ...replacement.replacementLines
    );
  }

  return {
    markdown: replacements.length > 0 ? lines.join('\n') : markdown,
    changed: replacements.length > 0,
    warnings,
    canonicalizedBlockCount
  };
};

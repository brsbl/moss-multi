// ported-from: packages/desktop/src/common/note-markdown-migrations/moss-html-normalize-fence-headers.ts @ 762abb777
import {
  isMarkdownClosingFence,
  parseMarkdownOpeningFence,
  type MarkdownFenceState
} from '../markdown-fences';
import type { NoteMarkdownMigration } from '../note-markdown-migration-runner';

export interface MossHtmlFenceNormalizationResult {
  markdown: string;
  changed: boolean;
}

const MOSS_HTML_FENCE_HEADER_RE = /^( {0,3})(`{3,})moss-html(?:\s+.*)?$/;

export function normalizeLegacyMossHtmlFenceHeaders(
  markdown: string
): MossHtmlFenceNormalizationResult {
  if (!markdown.includes('moss-html')) {
    return { markdown, changed: false };
  }

  const segments = markdown.split(/(\r?\n)/);
  let changed = false;
  let activeFence: MarkdownFenceState | null = null;

  for (let i = 0; i < segments.length; i += 2) {
    const line = segments[i] ?? '';

    if (activeFence !== null) {
      if (isMarkdownClosingFence(line, activeFence)) {
        activeFence = null;
      }
      continue;
    }

    const mossHtmlHeaderMatch = line.match(MOSS_HTML_FENCE_HEADER_RE);
    if (mossHtmlHeaderMatch) {
      const canonicalLine = `${mossHtmlHeaderMatch[1]}${mossHtmlHeaderMatch[2]}moss-html`;
      if (line !== canonicalLine) {
        segments[i] = canonicalLine;
        changed = true;
      }
      activeFence = {
        marker: '`',
        length: mossHtmlHeaderMatch[2].length
      };
      continue;
    }

    const openingFence = parseMarkdownOpeningFence(line);
    if (openingFence !== null) {
      activeFence = openingFence;
    }
  }

  return {
    markdown: changed ? segments.join('') : markdown,
    changed
  };
}

export const mossHtmlNormalizeFenceHeadersMigration: NoteMarkdownMigration = {
  id: 'moss-html-normalize-fence-headers',
  phases: ['editor-read', 'asset-reference-scan'],
  appliesTo: (markdown) => markdown.includes('moss-html'),
  async migrate(markdown) {
    const result = normalizeLegacyMossHtmlFenceHeaders(markdown);
    return {
      markdown: result.markdown
    };
  }
};

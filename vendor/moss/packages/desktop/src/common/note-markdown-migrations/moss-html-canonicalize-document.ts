// ported-from: packages/desktop/src/common/note-markdown-migrations/moss-html-canonicalize-document.ts @ 762abb777
import {
  canonicalizeMossHtmlBlocks
} from '../moss-html-migration';
import type { NoteMarkdownMigration } from '../note-markdown-migration-runner';

export const mossHtmlCanonicalizeDocumentMigration: NoteMarkdownMigration = {
  id: 'moss-html-canonicalize-document',
  phases: ['editor-read', 'asset-reference-scan'],
  appliesTo: (markdown) => markdown.includes('moss-html'),
  async migrate(markdown) {
    const result = canonicalizeMossHtmlBlocks(markdown);
    return {
      markdown: result.markdown,
      warnings: result.warnings
    };
  }
};

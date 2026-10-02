// ported-from: packages/desktop/src/common/note-markdown-migrations/legacy-mockup-image-to-moss-html.ts @ 762abb777
import {
  migrateLegacyMockupRefs
} from '../legacy-mockup-migration';
import type { NoteMarkdownMigration } from '../note-markdown-migration-runner';

export const legacyMockupImageToMossHtmlMigration: NoteMarkdownMigration = {
  id: 'legacy-mockup-image-to-moss-html',
  phases: ['editor-read', 'asset-reference-scan'],
  appliesTo: (markdown) => markdown.includes('-mockup.png'),
  async migrate(markdown, context) {
    const result = await migrateLegacyMockupRefs(
      markdown,
      context.readNoteRelativeFile
    );
    return {
      markdown: result.markdown,
      warnings: result.warnings
    };
  }
};

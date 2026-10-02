// ported-from: packages/desktop/src/common/note-markdown-migrations.ts @ 762abb777
import {
  defineMarkdownMigrationRegistry,
  runMarkdownMigrations,
  type NoteMarkdownMigrationContext
} from './note-markdown-migration-runner';
import { legacyMockupImageToMossHtmlMigration } from './note-markdown-migrations/legacy-mockup-image-to-moss-html';
import { mossHtmlCanonicalizeDocumentMigration } from './note-markdown-migrations/moss-html-canonicalize-document';
import { mossHtmlNormalizeFenceHeadersMigration } from './note-markdown-migrations/moss-html-normalize-fence-headers';

export const READ_ONLY_MARKDOWN_MIGRATIONS = defineMarkdownMigrationRegistry([
  mossHtmlNormalizeFenceHeadersMigration,
  legacyMockupImageToMossHtmlMigration,
  mossHtmlCanonicalizeDocumentMigration
]);

export function runReadOnlyMarkdownMigrations(
  markdown: string,
  context: NoteMarkdownMigrationContext
): ReturnType<typeof runMarkdownMigrations> {
  return runMarkdownMigrations(markdown, READ_ONLY_MARKDOWN_MIGRATIONS, context);
}

export {
  runMarkdownMigrations,
  type AppliedNoteMarkdownMigration,
  type NoteMarkdownMigration,
  type NoteMarkdownMigrationContext,
  NoteMarkdownMigrationError,
  type NoteMarkdownMigrationPhase,
  type NoteMarkdownMigrationStep,
  type NoteMarkdownMigrationRunResult
} from './note-markdown-migration-runner';

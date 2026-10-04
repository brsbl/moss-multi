// ported-from: packages/desktop/src/common/note-markdown-migration-runner.ts @ 762abb777
export type NoteMarkdownMigrationPhase = 'editor-read' | 'asset-reference-scan';
export type NoteMarkdownMigrationStep = 'preflight' | 'transform';

export interface NoteMarkdownMigrationContext {
  /** Read-only helper for migration companion files. It must never write note content. */
  readNoteRelativeFile(relativePath: string): Promise<string | null>;
  /** Describes why this projection is being built. Both phases are non-persisting. */
  phase: NoteMarkdownMigrationPhase;
}

export interface NoteMarkdownMigration {
  /** Stable identifier used by tests, diagnostics, and future registry changes. */
  id: string;
  /**
   * Migrations in this registry build read-only projections. Persisting
   * transformed markdown must happen through the normal editor save path.
   */
  phases: readonly NoteMarkdownMigrationPhase[];
  appliesTo(markdown: string): boolean;
  migrate(
    markdown: string,
    context: NoteMarkdownMigrationContext
  ): Promise<{ markdown: string; warnings?: readonly string[] }>;
}

export interface AppliedNoteMarkdownMigration {
  id: string;
  phase: NoteMarkdownMigrationPhase;
  changed: boolean;
  warningCount: number;
}

export interface NoteMarkdownMigrationRunResult {
  markdown: string;
  warnings: string[];
  appliedMigrations: AppliedNoteMarkdownMigration[];
}

export class NoteMarkdownMigrationError extends Error {
  constructor(
    public readonly migrationId: string,
    public readonly phase: NoteMarkdownMigrationPhase,
    public readonly originalError: unknown,
    public readonly step: NoteMarkdownMigrationStep = 'transform'
  ) {
    const message = originalError instanceof Error ? originalError.message : String(originalError);
    super(`Markdown migration "${migrationId}" failed during ${phase} ${step}: ${message}`);
    this.name = 'NoteMarkdownMigrationError';
  }
}

const MIGRATION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const VALID_PHASES: ReadonlySet<NoteMarkdownMigrationPhase> = new Set([
  'editor-read',
  'asset-reference-scan'
]);

const validateMarkdownMigrationRegistry = (
  migrations: readonly NoteMarkdownMigration[]
): void => {
  const ids = new Set<string>();

  for (const migration of migrations) {
    const id = migration.id;
    if (!MIGRATION_ID_RE.test(id)) {
      throw new Error(
        `Markdown migration registry contains non-canonical migration id "${id}"; use lowercase kebab-case`
      );
    }
    if (ids.has(id)) {
      throw new Error(`Markdown migration registry contains duplicate migration id "${id}"`);
    }
    ids.add(id);

    if (!Array.isArray(migration.phases) || migration.phases.length === 0) {
      throw new Error(`Markdown migration "${id}" must declare at least one phase`);
    }
    const phases = new Set<NoteMarkdownMigrationPhase>();
    for (const phase of migration.phases) {
      if (!VALID_PHASES.has(phase)) {
        throw new Error(`Markdown migration "${id}" declares unsupported phase "${phase}"`);
      }
      if (phases.has(phase)) {
        throw new Error(`Markdown migration "${id}" declares duplicate phase "${phase}"`);
      }
      phases.add(phase);
    }
  }
};

const freezeMarkdownMigration = (
  migration: NoteMarkdownMigration
): Readonly<NoteMarkdownMigration> => Object.freeze({
  ...migration,
  phases: Object.freeze([...migration.phases])
});

export function defineMarkdownMigrationRegistry(
  migrations: readonly NoteMarkdownMigration[]
): readonly NoteMarkdownMigration[] {
  validateMarkdownMigrationRegistry(migrations);
  return Object.freeze(migrations.map(freezeMarkdownMigration));
}

const validateMarkdownMigrationResult = (
  result: Awaited<ReturnType<NoteMarkdownMigration['migrate']>>
): void => {
  if (!result || typeof result.markdown !== 'string') {
    throw new TypeError('Migration returned an invalid result; expected a markdown string');
  }
  if (
    result.warnings !== undefined &&
    (!Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== 'string'))
  ) {
    throw new TypeError('Migration returned invalid warnings; expected an array of strings');
  }
};

export async function runMarkdownMigrations(
  markdown: string,
  migrations: readonly NoteMarkdownMigration[],
  context: NoteMarkdownMigrationContext
): Promise<NoteMarkdownMigrationRunResult> {
  if (!VALID_PHASES.has(context.phase)) {
    throw new Error(`Unsupported markdown migration phase "${context.phase}"`);
  }
  validateMarkdownMigrationRegistry(migrations);

  let current = markdown;
  const warnings: string[] = [];
  const appliedMigrations: AppliedNoteMarkdownMigration[] = [];

  for (const migration of migrations) {
    if (!migration.phases.includes(context.phase)) {
      continue;
    }

    let applies: boolean;
    try {
      applies = migration.appliesTo(current);
      if (typeof applies !== 'boolean') {
        throw new TypeError('Migration preflight must return a boolean');
      }
    } catch (error) {
      throw new NoteMarkdownMigrationError(migration.id, context.phase, error, 'preflight');
    }

    if (!applies) {
      continue;
    }

    const before = current;
    let result: Awaited<ReturnType<NoteMarkdownMigration['migrate']>>;
    try {
      result = await migration.migrate(current, context);
      validateMarkdownMigrationResult(result);
    } catch (error) {
      throw new NoteMarkdownMigrationError(migration.id, context.phase, error, 'transform');
    }
    const migrationWarnings = [...(result.warnings ?? [])];

    warnings.push(...migrationWarnings);
    current = result.markdown;
    appliedMigrations.push({
      id: migration.id,
      phase: context.phase,
      changed: current !== before,
      warningCount: migrationWarnings.length
    });
  }

  return {
    markdown: current,
    warnings,
    appliedMigrations
  };
}

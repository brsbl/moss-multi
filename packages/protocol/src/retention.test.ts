// The retention-copy build property (T2.3; L§4.8): every place that trashes something is found from source (each
// writer of a non-null deleted_at and each caller of a delete route), each is registered with the surfaces that
// speak for it, those surfaces read their words from retention.ts, and no other source counts days down, says
// "forever" or restates the retention period. The last block proves each check can fail.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETENTION_DAYS, TRASH_COPY, TRASHED_ACTION } from './retention.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOTS = ['apps/web/src', 'packages/core/src', 'packages/protocol/src', 'packages/sync/src', 'packages/ui/src', 'packages/viewer/src',
  'vendor/moss/packages/desktop/src', 'vendor/moss/packages/shared/src'];
const MODULE = 'packages/protocol/src/retention.ts';
const R = 'vendor/moss/packages/desktop/src/renderer';

/** Each place that trashes something, and the files whose copy speaks for it. */
const SURFACES: Record<string, string[]> = {
  'apps/web/src/api/trash.ts': ['apps/web/src/api/trash.ts'],
  'apps/web/src/api/folders.ts': ['apps/web/src/api/folders.ts'],
  'apps/web/src/host/bridge/index.ts': ['apps/web/src/host/surfaces/TrashConfirmation.tsx', 'apps/web/src/host/collab/ConnectionNotice.tsx'],
  [`${R}/App.tsx`]: [`${R}/panels/CanvasAreaContent.tsx`, `${R}/editor/MarkdownEditor.tsx`, `${R}/panels/TrashedNotesPanelContent.tsx`],
  [`${R}/panels/NotesListPanelContent.tsx`]: [`${R}/panels/NotesListPanelContent.tsx`, `${R}/panels/TrashedNotesPanelContent.tsx`],
};

function walk(dir: string): string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return /^(node_modules|fixtures|test|stories|dev)$/.test(entry.name) ? [] : walk(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.(test|stories)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/** Code lines only: a comment may describe the old behavior. */
const codeLines = (text: string) => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

/** A write that sends something to trash: a non-null deleted_at. */
const writesDeletedAt = (text: string) => codeLines(text).some((line) => /deleted_at\s*=\s*\?/.test(line) || /\.set\(\{[^}]*\bdeletedAt:\s*(?!null\b)/.test(line));
/** A call of a delete route: the REST DELETE, or moss's own note and folder delete invokers. */
const callsDeleteRoute = (text: string) => codeLines(text).some((line) => /method:\s*'DELETE'|(notesApi|foldersApi)\.delete\.invoke\(/.test(line));
const readsModule = (text: string) => /from '@moss-multi\/(protocol|host)\/retention(\.ts)?'/.test(text);

const FORBIDDEN: [RegExp, string][] = [
  [/removed forever|permanently deleted|deleted forever/i, 'says the note goes forever'],
  [/will be deleted|\bdeleted in\b/i, 'counts days down to a deletion'],
  [new RegExp(`\\b${RETENTION_DAYS}[- ]days?\\b`), 'restates the retention period'],
  [/retentionDays:\s*\d/, 'restates the retention period'],
];

/** Problems with one file's copy; the module itself is the one place allowed to state the period. */
function copyProblems(path: string, text: string): string[] {
  if (path === MODULE) return [];
  return codeLines(text).flatMap((line) => FORBIDDEN.filter(([pattern]) => pattern.test(line)).map(([, why]) => `${path}: ${why}: ${line.trim()}`));
}

/** Writers and callers the registry does not name. */
const unregistered = (found: string[], registry: Record<string, string[]>) => found.filter((path) => !(path in registry));

describe('retention copy', () => {
  const files = ROOTS.flatMap(walk);
  const found = files.filter((path) => {
    const text = read(path);
    return writesDeletedAt(text) || callsDeleteRoute(text);
  }).sort();

  it('finds the trash writers and delete callers from source', () => {
    expect(found, 'the server writers and the client callers').toEqual(expect.arrayContaining(['apps/web/src/api/folders.ts', `${R}/App.tsx`]));
  });

  it('registers every writer and caller with the surfaces that speak for it, and nothing else', () => {
    expect(unregistered(found, SURFACES), 'a writer or caller with no registered surface').toEqual([]);
    expect(Object.keys(SURFACES).filter((path) => !found.includes(path)), 'registered, but no longer trashes anything').toEqual([]);
  });

  it('reads every registered surface’s words from the one module', () => {
    const surfaces = [...new Set(Object.values(SURFACES).flat())];
    expect(surfaces.filter((path) => !readsModule(read(path))), 'a surface writing its own trash copy').toEqual([]);
  });

  it('never counts days down, says "forever" or restates the period outside the module', () => {
    expect(files.flatMap((path) => copyProblems(path, read(path)))).toEqual([]);
  });

  it('states the period once, as a minimum the copy promises', () => {
    expect(TRASHED_ACTION).toEqual({ action: 'trashed', restorable: true, retentionDays: 30 });
    expect(TRASH_COPY.cliRemoved).toBe('moved to Trash — you can restore it for 30 days');
    for (const text of [TRASH_COPY.emptyTrash, TRASH_COPY.trashedNote, TRASH_COPY.trashFolder('Plans')]) {
      expect(text).toMatch(/restored? (it |them )?for 30 days/);
      expect(copyProblems('elsewhere.ts', `const copy = ${JSON.stringify(text)};`), 'outside the module the same words would fail').not.toEqual([]);
    }
  });

  describe('each check can fail', () => {
    it('flags moss’s own countdown and "forever" copy', () => {
      expect(copyProblems('a.tsx', 'const m = `Note will be deleted in ${days} days`;')).toHaveLength(1);
      expect(copyProblems('a.tsx', '  Deleted notes stay here for 30 days before being removed forever.')).toHaveLength(2);
      expect(copyProblems('a.ts', '  return { retentionDays: 30 };')).toHaveLength(1);
      expect(copyProblems('a.ts', '  // removed forever after 30 days, in a comment')).toEqual([]);
    });

    it('finds a new writer or caller, and flags it until it is registered', () => {
      expect(writesDeletedAt("db.prepare('UPDATE docs SET deleted_at = ?1 WHERE id = ?2')")).toBe(true);
      expect(writesDeletedAt('await db.update(docs).set({ deletedAt: Date.now() })')).toBe(true);
      expect(writesDeletedAt("db.prepare('UPDATE docs SET deleted_at = NULL')")).toBe(false);
      expect(callsDeleteRoute("await request(`/api/docs/${id}`, { method: 'DELETE' })")).toBe(true);
      expect(callsDeleteRoute('const ok = await notesApi.delete.invoke(noteId);')).toBe(true);
      expect(unregistered(['apps/web/src/api/vaults.ts'], SURFACES)).toEqual(['apps/web/src/api/vaults.ts']);
    });

    it('flags a surface that does not read the module', () => {
      expect(readsModule("import { TRASH_COPY } from '@moss-multi/host/retention';")).toBe(true);
      expect(readsModule("const copy = 'Note will be deleted in 30 days';")).toBe(false);
    });
  });
});

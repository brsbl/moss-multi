import { is } from 'drizzle-orm';
import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedD1, migrations, statements, type TestD1 } from '../test/d1.ts';
import * as schema from './schema.ts';

interface ForeignKey {
  table: string;
  columns: string;
  refTable: string;
  refColumns: string;
  onDelete: string;
}

const label = (fk: ForeignKey) => `${fk.table}(${fk.columns}) -> ${fk.refTable}(${fk.refColumns})`;
const names = (list: string) => list.split(',').map((s) => s.trim().replace(/^[`"]|[`"]$/g, '')).join(',');

function declaredForeignKeys(): ForeignKey[] {
  const tables = Object.values(schema).filter((value) => is(value, SQLiteTable)) as unknown as SQLiteTable[];
  return tables.flatMap((table) => {
    const config = getTableConfig(table);
    return config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        table: config.name,
        columns: ref.columns.map((c) => c.name).join(','),
        refTable: getTableConfig(ref.foreignTable).name,
        refColumns: ref.foreignColumns.map((c) => c.name).join(','),
        onDelete: fk.onDelete ?? 'no action',
      };
    });
  });
}

function parseForeignKeys(table: string, body: string): ForeignKey[] {
  const pattern = /FOREIGN KEY\s*\(([^)]+)\)\s*REFERENCES\s*[`"]([^`"]+)[`"]\s*\(([^)]+)\)([^,\n]*)/gi;
  return [...body.matchAll(pattern)].map((m) => ({
    table,
    columns: names(m[1]),
    refTable: m[2],
    refColumns: names(m[3]),
    onDelete: (/ON DELETE (cascade|set null|set default|restrict|no action)/i.exec(m[4])?.[1] ?? 'no action').toLowerCase(),
  }));
}

/** Foreign keys of the tables the SQL leaves behind, following drizzle's rebuilds (create __new_x, drop x, rename). */
function appliedForeignKeys(files: string[]): ForeignKey[] {
  const tables = new Map<string, ForeignKey[]>();
  for (const sql of files) {
    for (const statement of statements(sql)) {
      const create = /^CREATE TABLE [`"]([^`"]+)[`"]\s*\(([\s\S]*)\)\s*;?$/i.exec(statement);
      const drop = /^DROP TABLE [`"]([^`"]+)[`"]/i.exec(statement);
      const rename = /^ALTER TABLE [`"]([^`"]+)[`"] RENAME TO [`"]([^`"]+)[`"]/i.exec(statement);
      if (create) tables.set(create[1], parseForeignKeys(create[1], create[2]));
      else if (drop) tables.delete(drop[1]);
      else if (rename) {
        tables.set(rename[2], (tables.get(rename[1]) ?? []).map((fk) => ({ ...fk, table: rename[2] })));
        tables.delete(rename[1]);
      }
    }
  }
  return [...tables.values()].flat();
}

/** Every declared reference must be in the DDL with the same onDelete, and the DDL may hold no other. */
function parityProblems(declared: ForeignKey[], applied: ForeignKey[]): string[] {
  const problems: string[] = [];
  const inSql = new Map(applied.map((fk) => [label(fk), fk]));
  for (const fk of declared) {
    const match = inSql.get(label(fk));
    if (!match) problems.push(`${label(fk)}: declared in schema.ts, missing from the SQL`);
    else if (match.onDelete !== fk.onDelete) {
      problems.push(`${label(fk)}: schema.ts has ON DELETE ${fk.onDelete}, the SQL has ${match.onDelete}`);
    }
  }
  const inSchema = new Set(declared.map(label));
  for (const fk of applied) if (!inSchema.has(label(fk))) problems.push(`${label(fk)}: in the SQL, not in schema.ts`);
  return problems;
}

const sqlFiles = () => migrations().map((m) => m.sql);

describe('DDL parity', () => {
  it('starts from one squashed 0000_init', () => {
    expect(migrations().map((m) => m.name)[0]).toBe('0000_init.sql');
  });

  it('has every schema.ts reference in the migration DDL with the same onDelete', () => {
    const declared = declaredForeignKeys();
    expect(declared.filter((fk) => fk.onDelete === 'cascade').length).toBeGreaterThan(10);
    expect(parityProblems(declared, appliedForeignKeys(sqlFiles()))).toEqual([]);
  });

  it('goes red when any one onDelete is removed from the SQL', () => {
    const declared = declaredForeignKeys();
    const files = sqlFiles();
    const caught: string[] = [];
    files.forEach((sql, i) => {
      for (const action of sql.matchAll(/ ON DELETE (cascade|set null|set default|restrict)/gi)) {
        const stripped = sql.slice(0, action.index) + sql.slice(action.index + action[0].length);
        const problems = parityProblems(declared, appliedForeignKeys(files.map((f, j) => (j === i ? stripped : f))));
        expect(problems.length).toBeLessThanOrEqual(1); // 0 only if a later migration rebuilds that table
        for (const problem of problems) {
          expect(problem).toMatch(new RegExp(`ON DELETE ${action[1]}, the SQL has no action$`, 'i'));
          caught.push(problem.split(':')[0]);
        }
      }
    });
    const expected = declared.filter((fk) => fk.onDelete !== 'no action').map(label);
    expect(caught.sort()).toEqual(expected.sort());
  });
});

describe('the applied SQL in D1', () => {
  let d1: TestD1;
  beforeAll(async () => {
    d1 = await migratedD1();
  }, 60_000);
  afterAll(() => d1?.dispose());

  const run = (sql: string, ...values: unknown[]) => d1.db.prepare(sql).bind(...values).run();
  const count = async (table: string, column: string, value: string) =>
    (await d1.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first<{ n: number }>())?.n;

  it('cascades a user delete through sessions, accounts, vaults, docs and grants', async () => {
    const t = Date.now();
    await run('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
      'u1', 'Ada', 'ada-ddl@example.invalid', t, t);
    await run('INSERT INTO session (id, expires_at, token, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      's1', t + 1e6, 'tok-ddl', 'u1', t, t);
    await run('INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      'a1', 'u1', 'credential', 'u1', t, t);
    await run('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      'v1', 'u1', 'u1', 'Home', 'vault', t);
    await run('INSERT INTO docs (id, owner_user_id, created_by, folder_id, filename, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'd1', 'u1', 'u1', 'v1', 'untitled.md', t, t);
    await run('INSERT INTO doc_members (doc_id, principal_id, principal_type, role, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      'd1', 'u2', 'user', 'viewer', 'u1', t);
    await run('DELETE FROM user WHERE id = ?', 'u1');
    for (const [table, column, value] of [
      ['session', 'user_id', 'u1'], ['account', 'user_id', 'u1'], ['folders', 'owner_user_id', 'u1'],
      ['docs', 'owner_user_id', 'u1'], ['doc_members', 'doc_id', 'd1'],
    ]) {
      expect(await count(table, column, value), table).toBe(0);
    }
  });

  it('refuses a vault with a parent and a folder without one', async () => {
    const t = Date.now();
    await run('INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)',
      'u3', 'Cy', 'cy-ddl@example.invalid', t, t);
    await run('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      'v3', 'u3', 'u3', 'Home', 'vault', t);
    await expect(run('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'v4', 'u3', 'u3', 'Nested', 'vault', 'v3', t)).rejects.toThrow(/CHECK/i);
    await expect(run('INSERT INTO folders (id, owner_user_id, created_by, name, kind, parent_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      'f4', 'u3', 'u3', 'Loose', 'folder', t)).rejects.toThrow(/CHECK/i);
  });
});

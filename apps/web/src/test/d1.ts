// Unit tests run against a real local D1 (Miniflare's workerd) with the committed migration SQL applied,
// so a drift between schema.ts and drizzle/*.sql cannot hide behind hand-written DDL (L§4.8).
import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';

const DRIZZLE = new URL('../../drizzle/', import.meta.url);

/** The migration files in apply order, as `wrangler d1 migrations apply` reads them. */
export function migrations(): { name: string; sql: string }[] {
  return readdirSync(DRIZZLE)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, DRIZZLE), 'utf8') }));
}

export const statements = (sql: string) =>
  sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

export interface TestD1 {
  db: D1Database;
  dispose: () => Promise<void>;
}

export async function migratedD1(): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response(null) }',
    compatibilityDate: '2025-09-02',
    d1Databases: ['DB'],
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  for (const { sql } of migrations()) {
    for (const statement of statements(sql)) await db.prepare(statement).run();
  }
  return { db, dispose: () => mf.dispose() };
}

/** D1 allows at most this many bound parameters per statement. */
export const D1_MAX_PARAMS = 100;

/** `db` with every statement's bound-parameter count recorded in `binds`, in order, and every prepared statement counted. */
export function countingBinds(db: D1Database): { db: D1Database; binds: number[]; prepared: () => number } {
  const binds: number[] = [];
  let prepared = 0;
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key, target);
      return (query: string) => {
        prepared += 1;
        return new Proxy(target.prepare(query), {
          get(statement, name) {
            if (name !== 'bind') return Reflect.get(statement, name, statement);
            return (...values: unknown[]) => {
              binds.push(values.length);
              return statement.bind(...values);
            };
          },
        });
      };
    },
  });
  return { db: wrapped, binds, prepared: () => prepared };
}

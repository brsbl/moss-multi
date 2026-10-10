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
  /** The ASSETS R2 bucket (A§16), local to this Miniflare. */
  assets: R2Bucket;
  dispose: () => Promise<void>;
}

export async function migratedD1(): Promise<TestD1> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch: () => new Response(null) }',
    compatibilityDate: '2025-09-02',
    d1Databases: ['DB'],
    r2Buckets: ['ASSETS'],
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const assets = (await mf.getR2Bucket('ASSETS')) as unknown as R2Bucket;
  for (const { sql } of migrations()) {
    for (const statement of statements(sql)) await db.prepare(statement).run();
  }
  return { db, assets, dispose: () => mf.dispose() };
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

/**
 * `db` with every row D1 hands back counted (`rows`) and every round trip, a statement or a batch, counted (`trips`).
 * `after`, when given, runs once a statement's rows are in hand and before its caller sees them.
 */
export function countingRows(db: D1Database, after?: (rows: unknown) => Promise<void> | void) {
  let rows = 0;
  let trips = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const seen = async <T>(result: T, count: number): Promise<T> => {
    rows += count;
    if (after) await after(result);
    return result;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, name) {
        if (name === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (name === 'all') return async () => { trips += 1; const result = await target.all(); return seen(result, result.results.length); };
        if (name === 'run') return async () => { trips += 1; const result = await target.run(); return seen(result, result.results?.length ?? 0); };
        if (name === 'first') return async (column?: string) => {
          trips += 1;
          const result = await (column === undefined ? target.first() : target.first(column));
          return seen(result, result === null ? 0 : 1);
        };
        if (name === 'raw') return async (options?: { columnNames?: boolean }) => {
          trips += 1;
          const result = await target.raw(options as { columnNames: true });
          return seen(result, result.length - (options?.columnNames ? 1 : 0));
        };
        const value = Reflect.get(target, name, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  const wrapped = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
        trips += 1;
        const results = await target.batch(statements.map((statement) => real.get(statement) ?? statement));
        return seen(results, results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: wrapped, rows: () => rows, trips: () => trips };
}

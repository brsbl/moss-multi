import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

/** Drizzle over this request's D1 binding; never cached across requests. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** `column IN values` bound as one JSON parameter, so a list of any length stays under D1's 100-parameter limit. */
export function inJson(column: SQLWrapper, values: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`;
}

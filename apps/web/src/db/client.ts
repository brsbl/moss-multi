import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema.ts';

/** Drizzle over this request's D1 binding; never cached across requests. */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;

import { Server } from 'partyserver';
import { REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import type { SyncEnv } from './env.ts';

/** Where a window keeps its attempts between wakes. */
export interface AttemptStore {
  load(): number[];
  save(attempts: number[]): void;
}

/**
 * A sliding window of grants: `take` grants while fewer than `max` attempts fall in the last `windowMs`. Denied
 * attempts count, so a caller that keeps hammering stays refused. With a store, a wake resumes the window (A§5.1).
 */
export class RateWindow {
  #attempts: number[] | null = null;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly store?: AttemptStore,
  ) {}

  take(now = Date.now()): boolean {
    this.#attempts ??= this.store?.load() ?? [];
    const recent = this.#attempts.filter((at) => now - at < this.windowMs);
    recent.push(now);
    // Only the newest `max` matter to the next decision, so a flood never grows the list.
    this.#attempts = recent.slice(-this.max);
    this.store?.save(this.#attempts);
    return recent.length <= this.max;
  }
}

/** One row per window in the DO's SQLite, holding at most `max` timestamps. */
function sqlAttempts(sql: SqlStorage, name: string): AttemptStore {
  sql.exec('CREATE TABLE IF NOT EXISTS rate_windows (name TEXT PRIMARY KEY, attempts TEXT NOT NULL)');
  return {
    load: () => {
      const [row] = sql.exec<{ attempts: string }>('SELECT attempts FROM rate_windows WHERE name = ?', name).toArray();
      const parsed: unknown = row ? JSON.parse(row.attempts) : [];
      return Array.isArray(parsed) ? parsed.filter((at): at is number => typeof at === 'number') : [];
    },
    save: (attempts) => {
      sql.exec(
        'INSERT INTO rate_windows (name, attempts) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET attempts = excluded.attempts',
        name,
        JSON.stringify(attempts),
      );
    },
  };
}

// One per principal, named by its id: workspace channel, sign-out registry and the REST write limit (A§5.2).
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };
  #writes: RateWindow | null = null;

  /** One REST write by this principal (a rename now, a push later); false past REST_WRITE_RATE. */
  takeWriteToken(): boolean {
    // Persisted: a PrincipalDO idle for ~10 s is evicted, and a wake must not hand out a fresh window.
    this.#writes ??= new RateWindow(REST_WRITE_RATE.max, REST_WRITE_RATE.windowMs, sqlAttempts(this.ctx.storage.sql, 'rest-writes'));
    return this.#writes.take();
  }
}

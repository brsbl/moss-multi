import { SUGGEST_LIMITS } from '@moss-multi/protocol/suggest';

interface Entry {
  /** Counted refusals in the current window, at most `max`. */
  refusals: number[];
  /** When the principal's cooldown ends; 0 when none. */
  until: number;
}

/**
 * Suggest refusals per principal in the last window and cooldown deadlines, in the DocDO's storage so a wake (the DO
 * hibernates with its sockets kept) clears neither. Read lazily per principal, cached, and a row is pruned once its
 * window and cooldown have both passed.
 */
export class SuggestCooldowns {
  readonly #cache = new Map<string, Entry>();

  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS suggest_refusals (principal_id TEXT PRIMARY KEY, refusals TEXT NOT NULL,
      until INTEGER NOT NULL, expires INTEGER NOT NULL)`);
  }

  #entry(principalId: string, now: number): Entry {
    let entry = this.#cache.get(principalId);
    if (!entry) {
      const row = this.sql.exec<{ refusals: string; until: number }>('SELECT refusals, until FROM suggest_refusals WHERE principal_id = ?', principalId).toArray()[0];
      entry = row ? { refusals: JSON.parse(row.refusals) as number[], until: Number(row.until) } : { refusals: [], until: 0 };
      this.#cache.set(principalId, entry);
    }
    entry.refusals = entry.refusals.filter((at) => now - at < SUGGEST_LIMITS.refusals.windowMs);
    if (entry.until <= now) entry.until = 0;
    return entry;
  }

  coolingDown(principalId: string, now = Date.now()): boolean {
    return this.#entry(principalId, now).until > now;
  }

  /** Counts one refusal; true when it starts the principal's cooldown. */
  count(principalId: string, now = Date.now()): boolean {
    const { max, windowMs } = SUGGEST_LIMITS.refusals;
    const entry = this.#entry(principalId, now);
    entry.refusals.push(now);
    const tripped = entry.refusals.length >= max;
    if (tripped) {
      entry.refusals = [];
      entry.until = now + SUGGEST_LIMITS.cooldownMs;
    }
    const expires = Math.max(entry.until, (entry.refusals.at(-1) ?? 0) + windowMs);
    this.sql.exec('DELETE FROM suggest_refusals WHERE expires <= ?', now);
    for (const [id, cached] of this.#cache) {
      if (id !== principalId && cached.until <= now && cached.refusals.every((at) => now - at >= windowMs)) this.#cache.delete(id);
    }
    this.sql.exec(
      'INSERT INTO suggest_refusals (principal_id, refusals, until, expires) VALUES (?, ?, ?, ?) ON CONFLICT(principal_id) DO UPDATE SET refusals = excluded.refusals, until = excluded.until, expires = excluded.expires',
      principalId, JSON.stringify(entry.refusals), entry.until, expires,
    );
    return tripped;
  }
}

import { Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { TRUSTED } from '@moss-multi/protocol/sync';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import { REST_WRITE_RATE, UPLOAD_RATE } from '@moss-multi/protocol/limits';
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

// One per principal, named by its id: workspace channel (one authenticated socket per tab, hibernatable), sign-out
// registry, the REST write limit (A§5.2) and the upload limit (A§16). An upload window may also be named for a link
// and an IP (`link:<hash>:<ip>`), which no principal is, so nothing connects to it.
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };
  #writes: RateWindow | null = null;
  #uploads: RateWindow | null = null;

  override onConnect(connection: Connection, context: ConnectionContext): void {
    const principal = context.request.headers.get(TRUSTED.principal);
    if (principal !== this.name) {
      connection.close(4401, 'refused');
      return;
    }
    const sessionId = context.request.headers.get(TRUSTED.session);
    connection.setState({ sessionId });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    // Clients can keep the channel alive, but can never publish workspace events.
    if (message === 'ping') connection.send('pong');
  }

  override onClose(connection: Connection): void {
    // The pinned workerd compatibility date predates automatic close replies.
    connection.close(1000, 'closed');
  }

  async publish(event: WorkspaceEvent): Promise<void> {
    await this.__unsafe_ensureInitialized();
    this.broadcast(JSON.stringify(event));
  }

  /** One REST write by this principal (a rename now, a push later); false past REST_WRITE_RATE. */
  takeWriteToken(): boolean {
    // Persisted: a PrincipalDO idle for ~10 s is evicted, and a wake must not hand out a fresh window.
    this.#writes ??= new RateWindow(REST_WRITE_RATE.max, REST_WRITE_RATE.windowMs, sqlAttempts(this.ctx.storage.sql, 'rest-writes'));
    return this.#writes.take();
  }

  /** One media upload or cross-note copy counted against this name; false past UPLOAD_RATE. Persisted, as above. */
  takeUploadToken(): boolean {
    this.#uploads ??= new RateWindow(UPLOAD_RATE.max, UPLOAD_RATE.windowMs, sqlAttempts(this.ctx.storage.sql, 'uploads'));
    return this.#uploads.take();
  }
}

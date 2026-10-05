import { getServerByName, Server, type Connection, type ConnectionContext, type WSMessage } from 'partyserver';
import { CLOSE, TRUSTED } from '@moss-multi/protocol/sync';
import type { WorkspaceEvent } from '@moss-multi/protocol/workspace';
import { ACCESS_DEADLINE_MS, ACCESS_TICK_MS, REST_WRITE_RATE, SESSION_MAX_MS } from '@moss-multi/protocol/limits';
import { liveCredentials, withDeadline } from './access-epoch.ts';
import type { DocDO, RecheckInput } from './doc-do.ts';
import type { SyncEnv } from './env.ts';

/** Runs an awaited recheck on one doc's DocDO (A§8); throws when the DO does not acknowledge. */
export type Rechecker = (docId: string, input: RecheckInput) => Promise<unknown>;

/** Which of the sessions and agent keys are still live; throws when D1 cannot answer. */
export type CredentialCheck = (sessions: string[], agents: string[]) => Promise<{ sessions: Set<string>; agents: Set<string> }>;

/** Close code for a validation D1 could not answer: the client retries (RFC 6455 "try again later"). */
const TRY_AGAIN = 1013;

type ChannelState = { sessionId?: string | null };

/** The registry key of an agent's sockets, which belong to the principal rather than a session. */
const PRINCIPAL_KEY = '';

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
// registry and the REST write limit (A§5.2).
export class PrincipalDO extends Server<SyncEnv> {
  static options = { hibernate: true };
  /** Where endSession's rechecks go; the Node harness swaps it. */
  static rechecker: (env: SyncEnv) => Rechecker | null = (env) => (env?.DocDO
    ? async (docId, input) => (await getServerByName(env.DocDO as unknown as DurableObjectNamespace<DocDO>, docId)).recheck(input)
    : null);
  /**
   * Where the workspace channel reads whether its sockets' sessions and keys are live (A§8 pull validation): before
   * every event it sends, on every ping, at admission and on a tick. With no D1 (the Node harness), nothing is read.
   */
  static credentials: (env: SyncEnv) => CredentialCheck | null = (env) => (env?.DB ? (sessions, agents) => liveCredentials(env.DB, sessions, agents) : null);
  #writes: RateWindow | null = null;
  #registryReady = false;
  /** When the next access tick is due; null when nothing happened since the last one. */
  #tickAt: number | null = null;

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const principal = context.request.headers.get(TRUSTED.principal);
    if (principal !== this.name) {
      connection.close(4401, 'refused');
      return;
    }
    const sessionId = context.request.headers.get(TRUSTED.session) || null;
    // An upgrade resolved before its sign-out (or its agent key's revocation) that arrives afterwards (A§5.2).
    if (this.#ended(sessionId ?? PRINCIPAL_KEY)) {
      if (sessionId === null) {
        connection.close(CLOSE.noPrincipal, 'revoked');
        return;
      }
      connection.send(JSON.stringify({ type: 'session-ended', sessionId } satisfies WorkspaceEvent));
      connection.close(CLOSE.sessionEnded, 'session ended');
      return;
    }
    connection.setState({ sessionId });
    // Registered first, so a sign-out by any path that commits after this read is seen by the next event, ping or tick.
    if ((await this.#validate([connection])).length === 0) return;
    await this.#armTick();
  }

  override async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    // Clients can keep the channel alive, but can never publish workspace events.
    if (message !== 'ping') return;
    if ((await this.#validate([connection])).length === 0) return;
    connection.send('pong');
    await this.#armTick();
  }

  override async onAlarm(): Promise<void> {
    this.#tickAt = null;
    await this.#validate([...this.getConnections()]);
  }

  /**
   * Pull validation (A§8): closes each socket whose session ended (4402, after telling it) or whose agent key was
   * revoked (4401), and returns the ones still live. A socket D1 could not vouch for closes 1013 and reconnects.
   */
  async #validate(connections: Connection[]): Promise<Connection[]> {
    const check = (this.constructor as typeof PrincipalDO).credentials(this.env);
    if (!check || connections.length === 0) return connections;
    const sessionOf = (connection: Connection) => (connection as Connection<ChannelState>).state?.sessionId ?? null;
    const sessions = [...new Set(connections.map(sessionOf).filter((id): id is string => id !== null))];
    const agent = connections.some((connection) => sessionOf(connection) === null);
    let live: { sessions: Set<string>; agents: Set<string> };
    try {
      live = await withDeadline(ACCESS_DEADLINE_MS, (race) => race(check(sessions, agent ? [this.name] : [])));
    } catch (error) {
      console.error('PrincipalDO could not validate its sockets', error);
      for (const connection of connections) connection.close(TRY_AGAIN, 'unvalidated');
      return [];
    }
    return connections.filter((connection) => {
      const sessionId = sessionOf(connection);
      if (sessionId === null ? live.agents.has(this.name) : live.sessions.has(sessionId)) return true;
      if (sessionId !== null) {
        try {
          connection.send(JSON.stringify({ type: 'session-ended', sessionId } satisfies WorkspaceEvent));
        } catch {
          // already closing
        }
      }
      connection.close(sessionId === null ? CLOSE.noPrincipal : CLOSE.sessionEnded, sessionId === null ? 'revoked' : 'session ended');
      return false;
    });
  }

  async #armTick(): Promise<void> {
    if (this.#tickAt !== null || !(this.constructor as typeof PrincipalDO).credentials(this.env)) return;
    this.#tickAt = Date.now() + ACCESS_TICK_MS;
    await this.ctx.storage.setAlarm(this.#tickAt);
  }

  override onClose(connection: Connection): void {
    // The pinned workerd compatibility date predates automatic close replies.
    connection.close(1000, 'closed');
  }

  /** Sent only to sockets whose session or key D1 still vouches for, read after the event was asked for. */
  async publish(event: WorkspaceEvent): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const message = JSON.stringify(event);
    for (const connection of await this.#validate([...this.getConnections()])) {
      try {
        connection.send(message);
      } catch {
        // closing; its close handler runs
      }
    }
    await this.#armTick();
  }

  /**
   * The sign-out registry (A§5.2): a DocDO records that `sessionId` (null for an agent) has a socket on `docId`. The
   * answer is `ended` when that session, or this agent, already ended: its upgrade was resolved before the sign-out
   * or the key's revocation, and the DocDO closes it.
   */
  registerDocSocket(sessionId: string | null, docId: string): 'ok' | 'ended' {
    const sql = this.#registry();
    const key = sessionId ?? PRINCIPAL_KEY;
    const now = Date.now();
    if (this.#ended(key)) return 'ended';
    sql.exec(
      'INSERT INTO doc_sockets (session_id, doc_id, at) VALUES (?, ?, ?) ON CONFLICT(session_id, doc_id) DO UPDATE SET at = excluded.at',
      key,
      docId,
      now,
    );
    // A session that expired without a sign-out leaves its rows; they go once no session could still use them. No
    // socket outlives its row: a DocDO closes each at DOC_SOCKET_MAX_MS, and its reconnect registers again.
    sql.exec('DELETE FROM doc_sockets WHERE at < ?', now - SESSION_MAX_MS);
    return 'ok';
  }

  /**
   * Sign-out (A§5.2, A§7): remembers the session as ended, so a socket that registers later closes 4402, tells and
   * closes the session's workspace sockets at once, then runs an awaited recheck on every doc the session opened.
   * Throws when a doc does not acknowledge; a retry rechecks the docs still listed.
   */
  async endSession(sessionId: string): Promise<void> {
    await this.#remember(sessionId);
    const event: WorkspaceEvent = { type: 'session-ended', sessionId };
    for (const connection of this.getConnections<{ sessionId?: string | null }>()) {
      if (connection.state?.sessionId !== sessionId) continue;
      connection.send(JSON.stringify(event));
      connection.close(CLOSE.sessionEnded, 'session ended');
    }
    await this.#recheck(sessionId, { sessions: [sessionId] });
  }

  /** An agent key's revocation (A§8): every doc the agent opened closes its sockets, and later ones are refused. */
  async revokePrincipal(): Promise<void> {
    await this.#remember(PRINCIPAL_KEY);
    for (const connection of this.getConnections()) connection.close(CLOSE.noPrincipal, 'revoked');
    await this.#recheck(PRINCIPAL_KEY, { principalIds: [this.name] });
  }

  async #remember(key: string): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const sql = this.#registry();
    const now = Date.now();
    sql.exec('INSERT OR IGNORE INTO ended_sessions (session_id, at) VALUES (?, ?)', key, now);
    sql.exec('DELETE FROM ended_sessions WHERE at < ?', now - SESSION_MAX_MS);
  }

  async #recheck(key: string, revocation: Omit<RecheckInput, 'at'>): Promise<void> {
    const sql = this.#registry();
    const now = Date.now();
    const docIds = sql.exec<{ doc_id: string }>('SELECT doc_id FROM doc_sockets WHERE session_id = ?', key).toArray().map((row) => row.doc_id);
    const recheck = (this.constructor as typeof PrincipalDO).rechecker(this.env);
    if (!recheck) throw new Error('PrincipalDO has no DocDO binding to recheck');
    const results = await Promise.allSettled(docIds.map(async (docId) => {
      await recheck(docId, { ...revocation, at: now });
      sql.exec('DELETE FROM doc_sockets WHERE session_id = ? AND doc_id = ?', key, docId);
    }));
    const failed = results.filter((result) => result.status === 'rejected');
    if (failed.length > 0) throw new Error(`${failed.length} of ${docIds.length} docs did not acknowledge the recheck`);
  }

  #ended(key: string): boolean {
    return this.#registry().exec('SELECT 1 FROM ended_sessions WHERE session_id = ?', key).toArray().length > 0;
  }

  #registry(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#registryReady) {
      sql.exec('CREATE TABLE IF NOT EXISTS doc_sockets (session_id TEXT NOT NULL, doc_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, doc_id))');
      sql.exec('CREATE TABLE IF NOT EXISTS ended_sessions (session_id TEXT PRIMARY KEY, at INTEGER NOT NULL)');
      this.#registryReady = true;
    }
    return sql;
  }

  /** One REST write by this principal (a rename now, a push later); false past REST_WRITE_RATE. */
  takeWriteToken(): boolean {
    // Persisted: a PrincipalDO idle for ~10 s is evicted, and a wake must not hand out a fresh window.
    this.#writes ??= new RateWindow(REST_WRITE_RATE.max, REST_WRITE_RATE.windowMs, sqlAttempts(this.ctx.storage.sql, 'rest-writes'));
    return this.#writes.take();
  }
}

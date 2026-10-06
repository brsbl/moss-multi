// The access epoch (A§8 pull validation): D1 triggers bump a vault owner's epoch in the same statement as every write
// that can lower access in that owner's vaults (a grant changed or removed, a link changed or revoked, a doc or folder
// moved or trashed). A socket records the epoch its role was resolved under; a DocDO re-reads it before applying any
// frame and re-resolves the sockets it outdated. Credentials (a session, an agent key) are read directly each time.

/** Close code for an admission or validation that could not be confirmed: the client retries (RFC 6455 "try again
 * later"). */
export const TRY_AGAIN = 1013;

export interface Stamp {
  /** `<owner>:<epoch>` of the doc's vault owner; '' for a doc D1 no longer has. */
  key: string;
  sessions: Set<string>;
  agents: Set<string>;
}

/**
 * A validation's deadline (L§4.7): `run` passes each D1 read through `race`, which rejects once `ms` have passed, so a
 * read that hangs fails closed instead of holding the frames and sockets waiting on it.
 */
export async function withDeadline<T>(ms: number, run: (race: <R>(read: Promise<R>) => Promise<R>) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('access validation passed its deadline')), ms);
  });
  expired.catch(() => undefined);
  try {
    return await run((read) => Promise.race([read, expired]));
  } finally {
    clearTimeout(timer);
  }
}

const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');

/** The doc's epoch key, read before a role is resolved, so a change that commits after it is seen as a new key. */
export async function epochKey(db: D1Database, docId: string): Promise<string> {
  const row = await db.prepare(`SELECT d.owner_user_id AS owner, coalesce(e.epoch, 0) AS epoch FROM docs d
    LEFT JOIN access_epochs e ON e.owner_user_id = d.owner_user_id WHERE d.id = ?`).bind(docId).first<{ owner: string; epoch: number }>();
  return row ? `${row.owner}:${row.epoch}` : '';
}

/** Which of `sessions` are live (unexpired) and which of `agents` are unrevoked, in one batch. */
export async function liveCredentials(db: D1Database, sessions: string[], agents: string[], now = Date.now()): Promise<{ sessions: Set<string>; agents: Set<string> }> {
  const statements: D1PreparedStatement[] = [];
  if (sessions.length) statements.push(db.prepare(`SELECT id FROM session WHERE expires_at > ? AND id IN (${placeholders(sessions.length)})`).bind(now, ...sessions));
  if (agents.length) statements.push(db.prepare(`SELECT id FROM agents WHERE revoked_at IS NULL AND id IN (${placeholders(agents.length)})`).bind(...agents));
  const results = statements.length ? await db.batch<{ id: string }>(statements) : [];
  const ids = (i: number) => new Set((results[i]?.results ?? []).map((row) => row.id));
  return { sessions: sessions.length ? ids(0) : new Set(), agents: agents.length ? ids(sessions.length ? 1 : 0) : new Set() };
}

/** The doc's epoch key and the live credentials among its sockets, read together. */
export async function readStamp(db: D1Database, docId: string, sessions: string[], agents: string[]): Promise<Stamp> {
  const [key, live] = await Promise.all([epochKey(db, docId), liveCredentials(db, sessions, agents)]);
  return { key, ...live };
}

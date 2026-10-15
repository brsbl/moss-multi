// The push base cache (A§5.1, A§17): every `.md` file the doc served to a pull, by its sha-256, so a push can name its
// base by hash. A base is the doc's own export, at most a little over 2 MB, so it is stored in parts under the DO's
// 2 MB row cap. Bases expire after BASE_TTL_MS and a doc keeps the newest BASES_KEPT; a push whose base is gone is
// answered `base-missing` and the CLI resends the base it kept.
const BASE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const BASES_KEPT = 8;
const PART_BYTES = 1024 * 1024;
/** A served base is re-stamped at most this often, so repeated pulls do not rewrite its row. */
const RESTAMP_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class BaseCache {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS bases (hash TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (hash, part))');
  }

  get(hash: string, now = Date.now()): string | null {
    const rows = this.sql.exec<{ data: ArrayBuffer; created_at: number }>('SELECT data, created_at FROM bases WHERE hash = ? ORDER BY part', hash).toArray();
    if (rows.length === 0 || rows[0]!.created_at < now - BASE_TTL_MS) return null;
    const parts = rows.map((row) => new Uint8Array(row.data));
    const whole = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      whole.set(part, at);
      at += part.byteLength;
    }
    return decoder.decode(whole);
  }

  /** Remembers `text` under its `hash`; the caller has computed it. Prunes expired and surplus bases in the same turn. */
  put(hash: string, text: string, now = Date.now()): void {
    const [stamped] = this.sql.exec<{ created_at: number }>('SELECT created_at FROM bases WHERE hash = ? AND part = 0', hash).toArray();
    if (stamped && stamped.created_at >= now - RESTAMP_MS) return;
    if (stamped) this.sql.exec('UPDATE bases SET created_at = ? WHERE hash = ?', now, hash);
    else {
      const bytes = encoder.encode(text);
      for (let part = 0, at = 0; at < bytes.byteLength || part === 0; part += 1, at += PART_BYTES) {
        const slice = bytes.slice(at, at + PART_BYTES);
        this.sql.exec('INSERT INTO bases (hash, part, data, created_at) VALUES (?, ?, ?, ?)', hash, part, slice.buffer, now);
      }
    }
    this.sql.exec('DELETE FROM bases WHERE created_at < ?', now - BASE_TTL_MS);
    this.sql.exec(
      'DELETE FROM bases WHERE hash NOT IN (SELECT hash FROM bases WHERE part = 0 ORDER BY created_at DESC LIMIT ?)',
      BASES_KEPT,
    );
  }
}

// Version history storage (A§14): one row per version in the DocDO's SQLite, its content spilled to R2 above 1.5 MB.
// Auto versions and restore points are pruned oldest first; named versions are bounded per person, so nobody can fill
// a bound that refuses someone else's.
import type { VersionContent } from './version-content.ts';

export type VersionKind = 'auto' | 'named' | 'restore-point';

/** What a version lists with: never its content. */
export interface VersionMeta {
  id: string;
  kind: VersionKind;
  name: string | null;
  createdAt: number;
  createdBy: string | null;
  authorIds: string[];
  title: string;
  bytes: number;
  spilled: boolean;
}

/** Where spilled versions live: the ASSETS bucket in the Worker, a map in the harness. */
export interface VersionBlobs {
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(keys: string[]): Promise<void>;
}

/** Content above this many bytes spills to R2 (a DO SQLite row holds at most 2 MB). */
export const VERSION_SPILL_BYTES = 1.5 * 1024 * 1024;
/** Named versions one person may keep on one doc. */
export const NAMED_VERSIONS_PER_PERSON = 50;
/** Auto versions and restore points a doc keeps; older ones are pruned. */
export const AUTO_VERSIONS_KEPT = 50;
export const RESTORE_POINTS_KEPT = 20;
/** The activity trigger (A§14): this many updates, or this long since the last auto version, checked on save. */
export const ACTIVITY_UPDATES = 500;
export const ACTIVITY_MS = 10 * 60_000;
export const VERSION_NAME_MAX = 80;

/** A version that would spill with no bucket to spill to. */
export class VersionSpillError extends Error {
  constructor() {
    super('version-spill');
    this.name = 'VersionSpillError';
  }
}

// A type, not an interface, so it satisfies SqlStorage's row constraint.
type Row = {
  id: string;
  kind: VersionKind;
  name: string | null;
  created_at: number;
  created_by: string | null;
  author_ids: string;
  title: string;
  bytes: number;
  hash: string;
  r2_key: string | null;
};

const META_COLUMNS = 'id, kind, name, created_at, created_by, author_ids, title, bytes, hash, r2_key';
const CONTENT_KEYS = ['frontmatter', 'markdown', 'lexical', 'payloads', 'comments'] as const;

const metaOf = (row: Row): VersionMeta => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  createdAt: Number(row.created_at),
  createdBy: row.created_by,
  authorIds: JSON.parse(row.author_ids) as string[],
  title: row.title,
  bytes: Number(row.bytes),
  spilled: row.r2_key !== null,
});

async function hashOf(content: VersionContent): Promise<string> {
  const text = JSON.stringify([content.title, ...CONTENT_KEYS.map((key) => content[key])]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class VersionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly docId: string,
    private readonly blobs: () => VersionBlobs | null,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, created_by TEXT,
      author_ids TEXT NOT NULL, title TEXT NOT NULL, frontmatter TEXT, markdown TEXT, lexical_json TEXT, payloads TEXT,
      comments TEXT, r2_key TEXT, bytes INTEGER NOT NULL, hash TEXT NOT NULL)`);
  }

  /** Newest first. */
  list(): VersionMeta[] {
    return this.sql.exec<Row>(`SELECT ${META_COLUMNS} FROM versions ORDER BY seq DESC`).toArray().map(metaOf);
  }

  meta(id: string): VersionMeta | null {
    const [row] = this.sql.exec<Row>(`SELECT ${META_COLUMNS} FROM versions WHERE id = ?`, id).toArray();
    return row ? metaOf(row) : null;
  }

  namedBy(principal: string): number {
    return Number(this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM versions WHERE kind = 'named' AND created_by = ?", principal).one().n);
  }

  /** The version's content, from its row or its spill; null when there is none. */
  async content(id: string): Promise<VersionContent | null> {
    const [row] = this.sql.exec<Row & { frontmatter: string | null; markdown: string | null; lexical_json: string | null; payloads: string | null; comments: string | null }>(
      'SELECT title, frontmatter, markdown, lexical_json, payloads, comments, r2_key FROM versions WHERE id = ?',
      id,
    ).toArray();
    if (!row) return null;
    if (row.r2_key === null) {
      return {
        title: row.title,
        frontmatter: row.frontmatter ?? '',
        markdown: row.markdown ?? '',
        lexical: row.lexical_json ?? '{"root":{"type":"root","children":[]}}',
        payloads: row.payloads ?? '{}',
        comments: row.comments ?? '{}',
      };
    }
    const blobs = this.blobs();
    const body = blobs ? await blobs.get(row.r2_key) : null;
    if (body === null) return null;
    return { title: row.title, ...(JSON.parse(body) as Omit<VersionContent, 'title'>) };
  }

  /**
   * Stores a version. With `dedupe`, a content equal to the latest version's stores nothing and returns null. Content
   * above VERSION_SPILL_BYTES goes to R2 first, so a row never names a spill that is not there.
   */
  async add(
    kind: VersionKind,
    content: VersionContent,
    options: { name?: string | null; createdBy?: string | null; authorIds?: string[]; at?: number; dedupe?: boolean },
  ): Promise<VersionMeta | null> {
    const hash = await hashOf(content);
    if (options.dedupe) {
      const [latest] = this.sql.exec<{ hash: string }>('SELECT hash FROM versions ORDER BY seq DESC LIMIT 1').toArray();
      if (latest?.hash === hash) return null;
    }
    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    const bytes = CONTENT_KEYS.reduce((sum, key) => sum + encoder.encode(content[key]).byteLength, 0);
    let r2Key: string | null = null;
    if (bytes > VERSION_SPILL_BYTES) {
      const blobs = this.blobs();
      if (!blobs) throw new VersionSpillError();
      r2Key = `versions/${this.docId}/${id}.json`;
      await blobs.put(r2Key, JSON.stringify(Object.fromEntries(CONTENT_KEYS.map((key) => [key, content[key]]))));
    }
    const inline = r2Key === null;
    this.sql.exec(
      `INSERT INTO versions (id, seq, kind, name, created_at, created_by, author_ids, title, frontmatter, markdown, lexical_json, payloads, comments, r2_key, bytes, hash)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM versions), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, options.name ?? null, options.at ?? Date.now(), options.createdBy ?? null, JSON.stringify(options.authorIds ?? []), content.title,
      inline ? content.frontmatter : null, inline ? content.markdown : null, inline ? content.lexical : null,
      inline ? content.payloads : null, inline ? content.comments : null, r2Key, bytes, hash,
    );
    if (kind === 'auto') await this.#prune('auto', AUTO_VERSIONS_KEPT);
    if (kind === 'restore-point') await this.#prune('restore-point', RESTORE_POINTS_KEPT);
    return this.meta(id);
  }

  /** Drops the oldest versions of `kind` past `keep`, and their spills. */
  async #prune(kind: VersionKind, keep: number): Promise<void> {
    const stale = this.sql.exec<{ id: string; r2_key: string | null }>(
      'SELECT id, r2_key FROM versions WHERE kind = ? ORDER BY seq DESC LIMIT -1 OFFSET ?',
      kind,
      keep,
    ).toArray();
    if (stale.length === 0) return;
    for (const { id } of stale) this.sql.exec('DELETE FROM versions WHERE id = ?', id);
    const keys = stale.flatMap((row) => (row.r2_key ? [row.r2_key] : []));
    if (keys.length === 0) return;
    try {
      await this.blobs()?.delete(keys);
    } catch (error) {
      console.error('version spill cleanup failed', error);
    }
  }
}

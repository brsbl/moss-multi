// Version history storage (A§14): one row per version in the DocDO's SQLite, its content spilled to R2 above 1.5 MB.
// Auto versions and restore points are pruned oldest first; named versions are bounded per person, so nobody can fill
// a bound that refuses someone else's. A version charged to a person is refunded to them when it is pruned. A spill is written before its row and recorded as an orphan until the row
// lands; a pruned or unwritten spill stays recorded until R2 confirms its delete, so no blob outlives every record.
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

/** A captured version ready to insert: its id, hash, size and, above the spill size, its R2 key. */
export interface Prepared {
  id: string;
  content: VersionContent;
  hash: string;
  bytes: number;
  r2Key: string | null;
}

export interface InsertOptions {
  name?: string | null;
  createdBy?: string | null;
  authorIds?: string[];
  at?: number;
  dedupe?: boolean;
  /** Whether its bytes were charged to `createdBy`, so pruning it refunds them. */
  charged?: boolean;
}

/** A refund owed to a person for a pruned version charged to them. */
export interface Refund {
  id: number;
  principal: string;
  bytes: number;
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
/** A version lists with at most this much of its title; the whole title is part of its content and its bytes. */
export const VERSION_TITLE_LIST_MAX = 200;
/** How long a spill may wait for its row before it counts as an orphan to delete. */
const SPILL_GRACE_MS = 60 * 60_000;
const SWEEP_BATCH = 100;

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

type ContentRow = Row & Record<'full_title' | 'frontmatter' | 'markdown' | 'lexical_json' | 'payloads' | 'comments' | 'anchors', string | null>;

const META_COLUMNS = 'id, kind, name, created_at, created_by, author_ids, title, bytes, hash, r2_key';
/** What a version's bytes count and its spill holds: the title too, since only a short prefix of it is listed. */
const CONTENT_KEYS = ['title', 'frontmatter', 'markdown', 'lexical', 'payloads', 'comments', 'anchors'] as const;

/** The title a version lists with: at most VERSION_TITLE_LIST_MAX UTF-16 units, never half a surrogate pair. */
function listTitle(title: string): string {
  if (title.length <= VERSION_TITLE_LIST_MAX) return title;
  const cut = title.slice(0, VERSION_TITLE_LIST_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

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

/** Two independent 53-bit string hashes (cyrb53), synchronous so a version is prepared in the caller's turn. */
function hashText(text: string): string {
  const half = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return `${half(1)}${half(2)}`;
}

export class VersionStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly docId: string,
    private readonly blobs: () => VersionBlobs | null,
    private readonly spillBytes = VERSION_SPILL_BYTES,
    private readonly transact: <T>(run: () => T) => T = (run) => run(),
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, created_by TEXT,
      author_ids TEXT NOT NULL, title TEXT NOT NULL, full_title TEXT, frontmatter TEXT, markdown TEXT, lexical_json TEXT,
      payloads TEXT, comments TEXT, anchors TEXT, r2_key TEXT, bytes INTEGER NOT NULL, hash TEXT NOT NULL,
      charged INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('CREATE TABLE IF NOT EXISTS version_orphans (r2_key TEXT PRIMARY KEY, due INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS version_refunds (id INTEGER PRIMARY KEY AUTOINCREMENT, principal TEXT NOT NULL, bytes INTEGER NOT NULL)');
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

  /** Every version's bytes: what the doc's vault is charged. */
  totalBytes(): number {
    return Number(this.sql.exec<{ n: number }>('SELECT COALESCE(SUM(bytes), 0) AS n FROM versions').one().n);
  }

  /** The version's content, from its row or its spill; null when there is none. */
  async content(id: string): Promise<VersionContent | null> {
    const [row] = this.sql.exec<ContentRow>(
      'SELECT title, full_title, frontmatter, markdown, lexical_json, payloads, comments, anchors, r2_key FROM versions WHERE id = ?',
      id,
    ).toArray();
    if (!row) return null;
    if (row.r2_key === null) {
      return {
        title: row.full_title ?? row.title,
        frontmatter: row.frontmatter ?? '',
        markdown: row.markdown ?? '',
        lexical: row.lexical_json ?? '{"root":{"type":"root","children":[]}}',
        payloads: row.payloads ?? '{}',
        comments: row.comments ?? '{}',
        anchors: row.anchors ?? '{}',
      };
    }
    const blobs = this.blobs();
    const body = blobs ? await blobs.get(row.r2_key) : null;
    if (body === null) return null;
    const spilled = JSON.parse(body) as Omit<VersionContent, 'title' | 'anchors'> & { title?: string; anchors?: string };
    return { ...spilled, anchors: spilled.anchors ?? '{}', title: spilled.title ?? row.title };
  }

  /** A captured content's id, hash and size, in the caller's turn; `spill` must run first when it has an R2 key. */
  prepare(content: VersionContent): Prepared {
    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    const bytes = CONTENT_KEYS.reduce((sum, key) => sum + encoder.encode(content[key]).byteLength, 0);
    const hash = hashText(JSON.stringify(CONTENT_KEYS.map((key) => content[key])));
    return { id, content, hash, bytes, r2Key: bytes > this.spillBytes ? `versions/${this.docId}/${id}.json` : null };
  }

  /** Writes a prepared version's spill, recorded as an orphan until its row is inserted. */
  async spill(prepared: Prepared): Promise<void> {
    if (prepared.r2Key === null) return;
    const blobs = this.blobs();
    if (!blobs) throw new VersionSpillError();
    this.sql.exec('INSERT OR REPLACE INTO version_orphans (r2_key, due) VALUES (?, ?)', prepared.r2Key, Date.now() + SPILL_GRACE_MS);
    const { content } = prepared;
    await blobs.put(prepared.r2Key, JSON.stringify(Object.fromEntries(CONTENT_KEYS.map((key) => [key, content[key]]))));
  }

  /**
   * Stores a prepared (and spilled) version in the caller's turn, or throws with nothing stored. With `dedupe`, a
   * content equal to the latest version's stores nothing and returns null.
   */
  insert(kind: VersionKind, prepared: Prepared, options: InsertOptions): VersionMeta | null {
    const { id, hash, r2Key } = prepared;
    if (options.dedupe) {
      const [latest] = this.sql.exec<{ hash: string }>('SELECT hash FROM versions ORDER BY seq DESC LIMIT 1').toArray();
      if (latest?.hash === hash) {
        this.discard(prepared);
        return null;
      }
    }
    return this.transact(() => {
      this.#insertRow(kind, prepared, options);
      if (r2Key !== null) this.sql.exec('DELETE FROM version_orphans WHERE r2_key = ?', r2Key);
      if (kind === 'auto') this.#prune('auto', AUTO_VERSIONS_KEPT);
      if (kind === 'restore-point') this.#prune('restore-point', RESTORE_POINTS_KEPT);
      return this.meta(id);
    });
  }

  #insertRow(kind: VersionKind, { id, content, hash, bytes, r2Key }: Prepared, options: InsertOptions): void {
    const inline = r2Key === null;
    const listed = listTitle(content.title);
    this.sql.exec(
      `INSERT INTO versions (id, seq, kind, name, created_at, created_by, author_ids, title, full_title, frontmatter, markdown, lexical_json, payloads, comments, anchors, r2_key, bytes, hash, charged)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM versions), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, options.name ?? null, options.at ?? Date.now(), options.createdBy ?? null, JSON.stringify(options.authorIds ?? []), listed,
      inline && listed !== content.title ? content.title : null,
      inline ? content.frontmatter : null, inline ? content.markdown : null, inline ? content.lexical : null,
      inline ? content.payloads : null, inline ? content.comments : null, inline ? content.anchors : null, r2Key, bytes, hash,
      options.charged && options.createdBy ? bytes : 0,
    );
  }

  /** Refunds owed for pruned versions, oldest first. */
  refunds(): Refund[] {
    return this.sql.exec<{ id: number; principal: string; bytes: number }>('SELECT id, principal, bytes FROM version_refunds ORDER BY id LIMIT ?', SWEEP_BATCH)
      .toArray().map((row) => ({ id: Number(row.id), principal: row.principal, bytes: Number(row.bytes) }));
  }

  /** Records a refund owed to `principal`, paid at the next sweep. */
  owe(principal: string, bytes: number): void {
    if (bytes > 0) this.sql.exec('INSERT INTO version_refunds (principal, bytes) VALUES (?, ?)', principal, bytes);
  }

  refunded(id: number): void {
    this.sql.exec('DELETE FROM version_refunds WHERE id = ?', id);
  }

  /** Whether anything is left for a later sweep: a spill to delete or a refund to pay. */
  pending(): boolean {
    const orphans = Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM version_orphans').one().n);
    const refunds = Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM version_refunds').one().n);
    return orphans + refunds > 0;
  }

  /** A prepared version that will not be inserted: its spill, if any, is deleted at the next sweep. */
  discard(prepared: Prepared): void {
    if (prepared.r2Key !== null) this.sql.exec('INSERT OR REPLACE INTO version_orphans (r2_key, due) VALUES (?, 0)', prepared.r2Key);
  }

  /** Prepares, spills and inserts; a failure discards the spill and throws. */
  async add(kind: VersionKind, content: VersionContent, options: InsertOptions): Promise<VersionMeta | null> {
    const prepared = this.prepare(content);
    try {
      await this.spill(prepared);
      return this.insert(kind, prepared, options);
    } catch (error) {
      this.discard(prepared);
      throw error;
    }
  }

  /** Deletes the spills of pruned or never-inserted versions; a key stays recorded until R2 confirms its delete. */
  async sweep(): Promise<void> {
    const keys = this.sql.exec<{ r2_key: string }>('SELECT r2_key FROM version_orphans WHERE due <= ? LIMIT ?', Date.now(), SWEEP_BATCH)
      .toArray().map((row) => row.r2_key);
    const blobs = this.blobs();
    if (keys.length === 0 || !blobs) return;
    try {
      await blobs.delete(keys);
    } catch (error) {
      console.error('version spill cleanup failed; it is retried at the next version write', error);
      return;
    }
    for (const key of keys) this.sql.exec('DELETE FROM version_orphans WHERE r2_key = ?', key);
  }

  /** Drops the oldest versions of `kind` past `keep`; their spills are recorded for the sweep. */
  #prune(kind: VersionKind, keep: number): void {
    const stale = this.sql.exec<{ id: string; r2_key: string | null; created_by: string | null; charged: number }>(
      'SELECT id, r2_key, created_by, charged FROM versions WHERE kind = ? ORDER BY seq DESC LIMIT -1 OFFSET ?',
      kind,
      keep,
    ).toArray();
    for (const { id, r2_key: key, created_by: principal, charged } of stale) {
      if (key) this.sql.exec('INSERT OR REPLACE INTO version_orphans (r2_key, due) VALUES (?, 0)', key);
      if (principal && Number(charged) > 0) this.sql.exec('INSERT INTO version_refunds (principal, bytes) VALUES (?, ?)', principal, Number(charged));
      this.sql.exec('DELETE FROM versions WHERE id = ?', id);
    }
  }
}

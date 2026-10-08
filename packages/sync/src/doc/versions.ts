// Version history storage (A§14): one row per version in the DocDO's SQLite, its content spilled to R2 above 1.5 MB.
// A note's history is bounded per note by pruning, never by charging a person or a vault: auto versions and restore
// points are pruned oldest first past their counts and the note's history bytes, in the write that adds a version.
// Named versions are never pruned; they are capped per person and per note. A spill is written before its row and
// recorded as an orphan until the row lands; a pruned or unwritten spill stays recorded until R2 confirms its delete.
import {
  NAMED_VERSIONS_PER_NOTE, NAMED_VERSIONS_PER_PERSON, VERSION_AUTO_KEPT, VERSION_HISTORY_BYTES_PER_NOTE, VERSION_RESTORE_POINTS_KEPT,
  VERSION_RESTORE_POINTS_PROTECTED,
} from '@moss-multi/protocol/limits';
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
  /** The person a named version counts against: the acting user, so an agent counts as its owner. */
  countedBy?: string | null;
  authorIds?: string[];
  at?: number;
  dedupe?: boolean;
}

/** A note's version bounds (A§14); the DocDO passes the protocol limits, tests lower them. */
export interface VersionBounds {
  /** Auto versions kept; older ones are pruned. */
  autoKept: number;
  /** Restore points kept; older ones are pruned. */
  restorePointsKept: number;
  /** The newest restore points, never pruned for bytes. */
  restorePointsProtected: number;
  /** Bytes of auto versions and restore points kept; the oldest are pruned past it. */
  historyBytes: number;
  /** Live named versions one person may keep on the note, and the note may keep. */
  namedPerPerson: number;
  namedPerNote: number;
}

export const VERSION_BOUNDS: VersionBounds = {
  autoKept: VERSION_AUTO_KEPT,
  restorePointsKept: VERSION_RESTORE_POINTS_KEPT,
  restorePointsProtected: VERSION_RESTORE_POINTS_PROTECTED,
  historyBytes: VERSION_HISTORY_BYTES_PER_NOTE,
  namedPerPerson: NAMED_VERSIONS_PER_PERSON,
  namedPerNote: NAMED_VERSIONS_PER_NOTE,
};

/** Content above this many bytes spills to R2 (a DO SQLite row holds at most 2 MB). */
export const VERSION_SPILL_BYTES = 1.5 * 1024 * 1024;
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
    private readonly bounds: () => VersionBounds = () => VERSION_BOUNDS,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, created_at INTEGER NOT NULL, created_by TEXT,
      author_ids TEXT NOT NULL, title TEXT NOT NULL, full_title TEXT, frontmatter TEXT, markdown TEXT, lexical_json TEXT,
      payloads TEXT, comments TEXT, anchors TEXT, r2_key TEXT, bytes INTEGER NOT NULL, hash TEXT NOT NULL, counted_by TEXT)`);
    const columns = sql.exec<{ name: string }>('PRAGMA table_info(versions)').toArray();
    if (!columns.some((column) => column.name === 'counted_by')) sql.exec('ALTER TABLE versions ADD COLUMN counted_by TEXT');
    sql.exec('CREATE TABLE IF NOT EXISTS version_orphans (r2_key TEXT PRIMARY KEY, due INTEGER NOT NULL)');
  }

  /** Newest first. */
  list(): VersionMeta[] {
    return this.sql.exec<Row>(`SELECT ${META_COLUMNS} FROM versions ORDER BY seq DESC`).toArray().map(metaOf);
  }

  meta(id: string): VersionMeta | null {
    const [row] = this.sql.exec<Row>(`SELECT ${META_COLUMNS} FROM versions WHERE id = ?`, id).toArray();
    return row ? metaOf(row) : null;
  }

  /**
   * Why `person` (the acting user: an agent counts as its owner) may not add a named version now, or null; check and
   * insert in one turn so no save races past it. A row from before counted_by counts against its creator.
   */
  namedRefusal(person: string): 'version-limit' | 'note-version-limit' | null {
    const { namedPerPerson, namedPerNote } = this.bounds();
    const count = (where: string, ...args: string[]) =>
      Number(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM versions WHERE kind = 'named'${where}`, ...args).one().n);
    if (count(' AND COALESCE(counted_by, created_by) = ?', person) >= namedPerPerson) return 'version-limit';
    if (count('') >= namedPerNote) return 'note-version-limit';
    return null;
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
      if (kind !== 'named') this.#prune(id);
      return this.meta(id);
    });
  }

  #insertRow(kind: VersionKind, { id, content, hash, bytes, r2Key }: Prepared, options: InsertOptions): void {
    const inline = r2Key === null;
    const listed = listTitle(content.title);
    this.sql.exec(
      `INSERT INTO versions (id, seq, kind, name, created_at, created_by, author_ids, title, full_title, frontmatter, markdown, lexical_json, payloads, comments, anchors, r2_key, bytes, hash, counted_by)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM versions), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, kind, options.name ?? null, options.at ?? Date.now(), options.createdBy ?? null, JSON.stringify(options.authorIds ?? []), listed,
      inline && listed !== content.title ? content.title : null,
      inline ? content.frontmatter : null, inline ? content.markdown : null, inline ? content.lexical : null,
      inline ? content.payloads : null, inline ? content.comments : null, inline ? content.anchors : null, r2Key, bytes, hash,
      options.countedBy ?? null,
    );
  }

  /** Whether a spill is still left for a later sweep. */
  pending(): boolean {
    return Number(this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM version_orphans').one().n) > 0;
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

  /**
   * Keeps the note's history within its bounds after `added` is inserted: auto versions and restore points past their
   * counts go, then, while their bytes exceed the bound, the oldest auto versions and then the oldest restore points
   * past the protected newest few. `added` and named versions are never pruned. Pruned spills are recorded for the sweep.
   */
  #prune(added: string): void {
    const { autoKept, restorePointsKept, restorePointsProtected, historyBytes } = this.bounds();
    type Stale = { id: string; r2_key: string | null; bytes: number };
    const oldestFirst = (kind: VersionKind, skipNewest: number) => this.sql.exec<Stale>(
      'SELECT id, r2_key, bytes FROM versions WHERE kind = ? AND id != ? ORDER BY seq DESC LIMIT -1 OFFSET ?', kind, added, skipNewest,
    ).toArray().reverse();
    const drop = ({ id, r2_key: key }: Stale) => {
      if (key) this.sql.exec('INSERT OR REPLACE INTO version_orphans (r2_key, due) VALUES (?, 0)', key);
      this.sql.exec('DELETE FROM versions WHERE id = ?', id);
    };
    const kindOf = this.meta(added)?.kind;
    // The added version holds one of its kind's places.
    for (const row of oldestFirst('auto', Math.max(0, autoKept - (kindOf === 'auto' ? 1 : 0)))) drop(row);
    for (const row of oldestFirst('restore-point', Math.max(0, restorePointsKept - (kindOf === 'restore-point' ? 1 : 0)))) drop(row);
    let total = Number(this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes), 0) AS n FROM versions WHERE kind != 'named'").one().n);
    const protectedPoints = Math.max(0, restorePointsProtected - (kindOf === 'restore-point' ? 1 : 0));
    for (const row of [...oldestFirst('auto', 0), ...oldestFirst('restore-point', protectedPoints)]) {
      if (total <= historyBytes) break;
      drop(row);
      total -= Number(row.bytes);
    }
  }
}

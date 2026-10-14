import { Server } from 'partyserver';
import type { SyncEnv } from './env.ts';
import { buildFtsMatch, extractWikiLinks, makeSnippet, scoreEntry, tokenizeQuery } from './search-core.ts';

export { SEARCH_DO_NAME } from './search-core.ts';

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
/** Allowed docs with no entry that one search reports, so the Worker can feed them. */
const UNINDEXED_REPORT = 25;

export interface IndexEntry {
  docId: string;
  /** Y.Text('title'). */
  title: string;
  /** The converter's markdown export of the body, never `toString()` of the tree (L§4.14). */
  body: string;
}

export interface SearchQuery {
  query: string;
  /** The caller's discovery closure (A§8): nothing else may appear. */
  allowedDocIds: string[];
  limit?: number;
}

export interface SearchHit {
  docId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface BacklinksAnswer {
  /** The allowed docs whose bodies link to one of the keys. */
  sources: string[];
  /** As in SearchAnswer: allowed docs the index has never been fed, which may link too. */
  unindexed: string[];
}

export interface SearchAnswer {
  results: SearchHit[];
  /** Allowed docs the index has never been fed, at most a few; the Worker wakes their DocDOs to feed them. */
  unindexed: string[];
}

type EntryRow = { doc_id: string; title: string; body: string };

/**
 * Glyphdown's SearchDO as RPC (A§5): `entries` is the indexed copy, `entries_fts` its FTS5 shadow keyed by the entry's
 * rowid (a LIKE scan if FTS5 is missing), and `links` the wiki keys each body links to. DocDOs feed it; the Worker queries it with the
 * caller's permissions already reduced to doc ids, so it needs no principal.
 */
export class SearchDO extends Server<SyncEnv> {
  static options = { hibernate: true };

  #engine: 'fts5' | 'like' = 'fts5';

  override async onStart(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS entries (doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS links (src_doc_id TEXT NOT NULL, target_key TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS links_target ON links (target_key)');
    sql.exec('CREATE INDEX IF NOT EXISTS links_src ON links (src_doc_id)');
    sql.exec('CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    try {
      sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(doc_id UNINDEXED, title, body)');
      this.#engine = 'fts5';
    } catch (error) {
      console.warn('SearchDO: FTS5 unavailable, searching by LIKE', error);
      this.#engine = 'like';
      return;
    }
    // FTS rows written before they shared the entry's rowid are rebuilt once, so writes can find them by rowid.
    if (sql.exec("SELECT 1 FROM search_meta WHERE key = 'fts-rowid'").toArray().length === 0) {
      this.ctx.storage.transactionSync(() => {
        sql.exec('DELETE FROM entries_fts');
        sql.exec('INSERT INTO entries_fts (rowid, doc_id, title, body) SELECT rowid, doc_id, title, body FROM entries');
        sql.exec("INSERT INTO search_meta (key, value) VALUES ('fts-rowid', '1')");
      });
    }
  }

  /** Upserts one doc and replaces its links. True when its set of link targets changed. */
  async index(entry: IndexEntry): Promise<{ linksChanged: boolean }> {
    await this.__unsafe_ensureInitialized();
    const sql = this.ctx.storage.sql;
    const keys = extractWikiLinks(entry.body);
    const before = new Set(sql.exec<{ target_key: string }>('SELECT target_key FROM links WHERE src_doc_id = ?', entry.docId).toArray().map((row) => row.target_key));
    const linksChanged = before.size !== keys.length || keys.some((key) => !before.has(key));
    this.ctx.storage.transactionSync(() => {
      const { rowid } = sql.exec<{ rowid: number }>(`INSERT INTO entries (doc_id, title, body, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at RETURNING rowid`,
      entry.docId, entry.title, entry.body, Date.now()).one();
      if (this.#engine === 'fts5') {
        sql.exec('DELETE FROM entries_fts WHERE rowid = ?', rowid);
        sql.exec('INSERT INTO entries_fts (rowid, doc_id, title, body) VALUES (?, ?, ?, ?)', rowid, entry.docId, entry.title, entry.body);
      }
      if (linksChanged) {
        sql.exec('DELETE FROM links WHERE src_doc_id = ?', entry.docId);
        for (const key of keys) sql.exec('INSERT INTO links (src_doc_id, target_key) VALUES (?, ?)', entry.docId, key);
      }
    });
    return { linksChanged };
  }

  async remove(docId: string): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const removed = sql.exec<{ rowid: number }>('DELETE FROM entries WHERE doc_id = ? RETURNING rowid', docId).toArray();
      if (this.#engine === 'fts5') for (const { rowid } of removed) sql.exec('DELETE FROM entries_fts WHERE rowid = ?', rowid);
      sql.exec('DELETE FROM links WHERE src_doc_id = ?', docId);
    });
  }

  async search({ query, allowedDocIds, limit }: SearchQuery): Promise<SearchAnswer> {
    await this.__unsafe_ensureInitialized();
    // The allowed ids go in as one JSON parameter (DO SQLite binds at most 100), read back with json_each.
    const allowed = JSON.stringify([...new Set(allowedDocIds)]);
    const unindexed = allowedDocIds.length ? this.#unindexed(allowed) : [];
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0 || allowedDocIds.length === 0) return { results: [], unindexed };
    const max = clampLimit(limit);
    const rows = this.#engine === 'fts5' ? this.#matchFts(query, allowed) : this.#matchLike(allowed);
    return { results: rank(rows, query, tokens, max, this.#engine === 'fts5'), unindexed };
  }

  /** The allowed docs whose bodies link to any of `keys` (a doc's title key, filename stem and id key, A§5.3). */
  async backlinks({ keys, allowedDocIds }: { keys: string[]; allowedDocIds: string[] }): Promise<BacklinksAnswer> {
    await this.__unsafe_ensureInitialized();
    const allowed = JSON.stringify([...new Set(allowedDocIds)]);
    const unindexed = allowedDocIds.length ? this.#unindexed(allowed) : [];
    const wanted = [...new Set(keys.filter((key) => key !== ''))];
    if (wanted.length === 0 || allowedDocIds.length === 0) return { sources: [], unindexed };
    // Driven by the allowed ids through links_src, so other tenants' links to the same key are never read.
    const sources = this.ctx.storage.sql.exec<{ src_doc_id: string }>(
      `SELECT DISTINCT l.src_doc_id FROM json_each(?) AS a CROSS JOIN links AS l INDEXED BY links_src
        WHERE l.src_doc_id = a.value AND l.target_key IN (${wanted.map(() => '?').join(', ')})`, allowed, ...wanted,
    ).toArray().map((row) => row.src_doc_id);
    return { sources, unindexed };
  }

  #unindexed(allowed: string): string[] {
    return this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT value AS id FROM json_each(?) WHERE value NOT IN (SELECT doc_id FROM entries) LIMIT ?`, allowed, UNINDEXED_REPORT,
    ).toArray().map((row) => row.id);
  }

  /**
   * The allowed docs FTS5 matches, found by rowid from the allowed ids. Only MATCH decides membership: bm25's
   * statistics span every tenant's notes, so ranking is left to `rank`, which reads nothing but the doc itself.
   */
  #matchFts(query: string, allowed: string): EntryRow[] {
    const match = buildFtsMatch(query);
    if (match === null) return [];
    return this.ctx.storage.sql.exec<EntryRow>(
      `SELECT e.doc_id, e.title, e.body FROM entries AS e JOIN entries_fts AS f ON f.rowid = e.rowid
        WHERE entries_fts MATCH ? AND f.rowid IN (SELECT rowid FROM entries WHERE doc_id IN (SELECT value FROM json_each(?)))`, match, allowed,
    ).toArray();
  }

  #matchLike(allowed: string): EntryRow[] {
    return this.ctx.storage.sql.exec<EntryRow>(
      'SELECT doc_id, title, body FROM entries WHERE doc_id IN (SELECT value FROM json_each(?))', allowed,
    ).toArray();
  }
}

/**
 * scoreEntry (title hits dominate body hits), score descending, then doc id. FTS5's matches stay even when its
 * tokenizer matched where a plain substring does not (folded diacritics); LIKE keeps only scored rows.
 */
function rank(rows: EntryRow[], query: string, tokens: string[], limit: number, matched: boolean): SearchHit[] {
  const scored: (EntryRow & { score: number })[] = [];
  for (const row of rows) {
    const score = scoreEntry(row.title, row.body, tokens);
    if (score > 0 || matched) scored.push({ ...row, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.doc_id < b.doc_id ? -1 : a.doc_id > b.doc_id ? 1 : 0));
  return scored.slice(0, limit).map((row) => ({ docId: row.doc_id, title: row.title, snippet: makeSnippet(row.body, query), score: row.score }));
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), SEARCH_MAX_LIMIT);
}

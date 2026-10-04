import { Server } from 'partyserver';
import type { SyncEnv } from './env.ts';
import { buildFtsMatch, extractWikiLinks, makeSnippet, scoreEntry, tokenizeQuery } from './search-core.ts';

export { SEARCH_DO_NAME } from './search-core.ts';

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
/** FTS candidates read before the permission filter. */
const CANDIDATE_ROWS = 400;
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

export interface SearchAnswer {
  results: SearchHit[];
  /** Allowed docs the index has never been fed, at most a few; the Worker wakes their DocDOs to feed them. */
  unindexed: string[];
}

type EntryRow = { doc_id: string; title: string; body: string };

/**
 * Glyphdown's SearchDO as RPC (A§5): `entries` is the indexed copy, `entries_fts` its FTS5 shadow (a LIKE scan if
 * FTS5 is missing), and `links` the wiki keys each body links to. DocDOs feed it; the Worker queries it with the
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
    try {
      sql.exec('CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(doc_id UNINDEXED, title, body)');
      this.#engine = 'fts5';
    } catch (error) {
      console.warn('SearchDO: FTS5 unavailable, searching by LIKE', error);
      this.#engine = 'like';
    }
  }

  /** Upserts one doc and replaces its links. True when its set of link targets changed. */
  async index(entry: IndexEntry): Promise<{ linksChanged: boolean }> {
    await this.__unsafe_ensureInitialized();
    const sql = this.ctx.storage.sql;
    const keys = extractWikiLinks(entry.body);
    const before = sql.exec<{ target_key: string }>('SELECT target_key FROM links WHERE src_doc_id = ?', entry.docId).toArray().map((row) => row.target_key);
    this.ctx.storage.transactionSync(() => {
      sql.exec(`INSERT INTO entries (doc_id, title, body, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(doc_id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`,
      entry.docId, entry.title, entry.body, Date.now());
      if (this.#engine === 'fts5') {
        sql.exec('DELETE FROM entries_fts WHERE doc_id = ?', entry.docId);
        sql.exec('INSERT INTO entries_fts (doc_id, title, body) VALUES (?, ?, ?)', entry.docId, entry.title, entry.body);
      }
      sql.exec('DELETE FROM links WHERE src_doc_id = ?', entry.docId);
      for (const key of keys) sql.exec('INSERT INTO links (src_doc_id, target_key) VALUES (?, ?)', entry.docId, key);
    });
    return { linksChanged: before.length !== keys.length || before.some((key) => !keys.includes(key)) };
  }

  async remove(docId: string): Promise<void> {
    await this.__unsafe_ensureInitialized();
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec('DELETE FROM entries WHERE doc_id = ?', docId);
      if (this.#engine === 'fts5') sql.exec('DELETE FROM entries_fts WHERE doc_id = ?', docId);
      sql.exec('DELETE FROM links WHERE src_doc_id = ?', docId);
    });
  }

  async search({ query, allowedDocIds, limit }: SearchQuery): Promise<SearchAnswer> {
    await this.__unsafe_ensureInitialized();
    const allowed = new Set(allowedDocIds);
    const unindexed = this.#unindexed(allowed);
    const tokens = tokenizeQuery(query);
    if (tokens.length === 0 || allowed.size === 0) return { results: [], unindexed };
    const max = clampLimit(limit);
    const results = this.#engine === 'fts5' ? this.#searchFts(query, allowed, max) : this.#searchLike(query, tokens, allowed, max);
    return { results, unindexed };
  }

  /** The allowed docs whose bodies link to any of `keys` (a doc's title key and filename stem, A§5.3). */
  async backlinks({ keys, allowedDocIds }: { keys: string[]; allowedDocIds: string[] }): Promise<string[]> {
    await this.__unsafe_ensureInitialized();
    const allowed = new Set(allowedDocIds);
    const wanted = [...new Set(keys.filter((key) => key !== ''))];
    if (wanted.length === 0 || allowed.size === 0) return [];
    const rows = this.ctx.storage.sql.exec<{ src_doc_id: string }>(
      `SELECT DISTINCT src_doc_id FROM links WHERE target_key IN (${wanted.map(() => '?').join(', ')})`, ...wanted,
    ).toArray();
    return rows.map((row) => row.src_doc_id).filter((id) => allowed.has(id));
  }

  #unindexed(allowed: Set<string>): string[] {
    const ids = [...allowed];
    const indexed = new Set<string>();
    // DO SQLite binds at most 100 parameters per statement.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90);
      for (const row of this.ctx.storage.sql.exec<{ doc_id: string }>(
        `SELECT doc_id FROM entries WHERE doc_id IN (${chunk.map(() => '?').join(', ')})`, ...chunk,
      ).toArray()) indexed.add(row.doc_id);
    }
    return ids.filter((id) => !indexed.has(id)).slice(0, UNINDEXED_REPORT);
  }

  /** bm25 with the title weighted 5× the body, then the permission filter. */
  #searchFts(query: string, allowed: Set<string>, limit: number): SearchHit[] {
    const match = buildFtsMatch(query);
    if (match === null) return [];
    const rows = this.ctx.storage.sql.exec<EntryRow & { rank: number }>(
      `SELECT doc_id, title, body, bm25(entries_fts, 0.0, 5.0, 1.0) AS rank FROM entries_fts
        WHERE entries_fts MATCH ? ORDER BY rank LIMIT ?`, match, CANDIDATE_ROWS,
    ).toArray();
    const results: SearchHit[] = [];
    for (const row of rows) {
      if (!allowed.has(row.doc_id)) continue;
      results.push({ docId: row.doc_id, title: row.title, snippet: makeSnippet(row.body, query), score: -row.rank });
      if (results.length >= limit) break;
    }
    return results;
  }

  #searchLike(query: string, tokens: string[], allowed: Set<string>, limit: number): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const row of this.ctx.storage.sql.exec<EntryRow>('SELECT doc_id, title, body FROM entries').toArray()) {
      if (!allowed.has(row.doc_id)) continue;
      const score = scoreEntry(row.title, row.body, tokens);
      if (score > 0) hits.push({ docId: row.doc_id, title: row.title, snippet: makeSnippet(row.body, query), score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function clampLimit(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), SEARCH_MAX_LIMIT);
}

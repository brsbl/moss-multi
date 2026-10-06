// Search and links (A§15; glyphdown's api/search.ts): the index is the global SearchDO; this side reduces the caller to
// the doc ids they may discover (A§8 accessibleDocs) before asking it, so nothing else can ever appear.
//   GET /api/search?q=[&limit=][&vault=]   ranked hits with a text snippet
//   GET /api/docs/:id/backlinks            docs in the doc's vault whose bodies wiki-link it by title, stem or id
//   GET /api/docs/:id/headings             h1–h4 of the DocDO's export, for `[[Note#` completion
import { waitUntil } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { getServerByName } from 'partyserver';
import { idKey, parseHeadings, SEARCH_DO_NAME, wikiKey } from '@moss-multi/sync/search';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { accessibleDocs, accessibleFolders, MAX_FOLDER_DEPTH, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { vaultOf } from './folders.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';

export type SearchEnv = AuthEnv & Pick<AppEnv, 'DocDO'> & Partial<Pick<AppEnv, 'SearchDO'>>;

export interface SearchResultRow {
  id: string;
  title: string;
  snippet: string;
  folderId: string;
  updatedAt: number;
}

export interface LinkedDoc {
  id: string;
  title: string;
  folderId: string;
  updatedAt: number;
}

const DOC_LINKS = /^\/api\/docs\/([^/]+)\/(backlinks|headings)$/;
/** How long a search waits for the index to take in docs it has never been fed before answering. */
const BACKFILL_WAIT_MS = 3_000;

const unavailable = () => json({ error: 'unavailable', message: 'Search isn’t available right now. Try again.' }, 503, NO_STORE);

const index = async (env: SearchEnv) =>
  env.SearchDO ? getServerByName(env.SearchDO, SEARCH_DO_NAME) : null;

/** The live doc ids under a vault, the vault's own docs included. */
async function docIdsInVault(db: D1Database, vaultId: string): Promise<Set<string>> {
  const rows = await db.prepare(`WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 1 FROM folders WHERE id = ?1
      UNION ALL SELECT f.id, sub.depth + 1 FROM folders f JOIN sub ON f.parent_id = sub.id WHERE sub.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT d.id AS id FROM docs d WHERE d.deleted_at IS NULL AND d.folder_id IN (SELECT id FROM sub)`)
    .bind(vaultId).all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

/** The caller's discovery closure; a share link alone discovers nothing (A§8). */
async function discoverable(db: Db, principal: Principal) {
  if (principal.type === 'anonymous') return new Map<string, Awaited<ReturnType<typeof accessibleDocs>>[number]>();
  return new Map((await accessibleDocs(db, principal, await accessibleFolders(db, principal))).map((row) => [row.id, row]));
}

async function search(request: Request, env: SearchEnv): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim();
  const limit = Number(url.searchParams.get('limit') ?? '') || undefined;
  const db = createDb(env.DB);
  let allowed = await discoverable(db, principal);
  const vaultId = url.searchParams.get('vault');
  if (vaultId) {
    const vault = await resolveFolderAccess(db, principal, vaultId);
    if (!vault || vault.kind !== 'vault' || vault.deleted) return notFound();
    const inVault = await docIdsInVault(env.DB, vaultId);
    allowed = new Map([...allowed].filter(([id]) => inVault.has(id)));
  }
  if (!query || allowed.size === 0) return json({ results: [] }, 200, NO_STORE);
  const stub = await index(env);
  if (!stub) return unavailable();
  const ask = { query, allowedDocIds: [...allowed.keys()], limit };
  let answer = await stub.search(ask);
  // A doc the index has never been fed (created before search, or a feed that failed) feeds itself now, and the
  // search waits briefly for it so a cold doc is found on this search, not only on a later one.
  if (answer.unindexed.length) {
    const fed = backfill(env, answer.unindexed);
    waitUntil(fed);
    const done = await Promise.race([fed.then(() => true), new Promise<false>((resolve) => setTimeout(resolve, BACKFILL_WAIT_MS, false))]);
    if (done) answer = await stub.search(ask);
  }
  // D1 names the doc: the index's copy of a title can trail a rename by a save.
  const results: SearchResultRow[] = answer.results.flatMap((hit) => {
    const row = allowed.get(hit.docId);
    return row ? [{ id: row.id, title: row.title, snippet: hit.snippet, folderId: row.folderId, updatedAt: row.updatedAt }] : [];
  });
  return json({ results }, 200, NO_STORE);
}

async function backfill(env: SearchEnv, docIds: string[]): Promise<void> {
  await Promise.all(docIds.map(async (docId) => {
    try {
      await (await getServerByName(env.DocDO, docId)).reindex();
    } catch (error) {
      console.warn(`search backfill for ${docId} failed`, error);
    }
  }));
}

/** The target's readers only; its sources are the caller's discoverable docs in the same vault (A§15). */
async function backlinks(request: Request, env: SearchEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  const [target] = await db.select({ title: docs.title, filename: docs.filename, folderId: docs.folderId }).from(docs).where(eq(docs.id, docId)).limit(1);
  if (!target) return notFound();
  const vault = await vaultOf(db, target.folderId);
  const discovered = await discoverable(db, principal);
  const inVault = vault ? await docIdsInVault(env.DB, vault) : new Set<string>();
  const allowed = [...discovered.keys()].filter((id) => id !== docId && inVault.has(id));
  if (allowed.length === 0) return json({ backlinks: [] }, 200, NO_STORE);
  const stub = await index(env);
  if (!stub) return unavailable();
  const stem = target.filename.startsWith('pending-') ? '' : target.filename.replace(/\.md$/, '');
  const ids = await stub.backlinks({ keys: [wikiKey(target.title), wikiKey(stem), idKey(docId)], allowedDocIds: allowed });
  const linked: LinkedDoc[] = ids.flatMap((id) => {
    const row = discovered.get(id);
    return row ? [{ id: row.id, title: row.title, folderId: row.folderId, updatedAt: row.updatedAt }] : [];
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return json({ backlinks: linked }, 200, NO_STORE);
}

/** Whoever can read the doc, a link holder included, reads its headings from the DO export (A§15). */
async function headings(request: Request, env: SearchEnv, docId: string): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal) return unauthenticated();
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  const markdown = await (await getServerByName(env.DocDO, docId)).exportMarkdown();
  return json({ headings: parseHeadings(markdown) }, 200, NO_STORE);
}

/** The search routes, or null for a path they don't own. */
export function handleSearchRoutes(request: Request, env: SearchEnv): Promise<Response> | null {
  const { pathname } = new URL(request.url);
  const links = DOC_LINKS.exec(pathname);
  if (pathname !== '/api/search' && !links) return null;
  if (request.method !== 'GET') return Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'GET' }));
  if (!links) return search(request, env);
  const docId = decodeURIComponent(links[1]);
  return links[2] === 'backlinks' ? backlinks(request, env, docId) : headings(request, env, docId);
}

// The active vault's tree, plus directly shared items whose parents are inaccessible, plus the caller's own trashed
// notes in it for the Trash view, each with `trashedAt` (A§11).
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { accessibleDocs, accessibleFolders, MAX_FOLDER_DEPTH } from './access.ts';
import { NO_STORE, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

interface TrashedRow { id: string; title: string; filename: string; folderId: string; createdAt: number; updatedAt: number; trashedAt: number }

/** The owner's trashed notes whose folder chain ends at `vaultId`, trashed folders included. */
async function trashedIn(db: D1Database, ownerId: string, vaultId: string): Promise<TrashedRow[]> {
  const rows = await db.prepare(`WITH RECURSIVE up(doc_id, id, parent_id, kind, depth) AS (
      SELECT d.id, f.id, f.parent_id, f.kind, 1 FROM docs d JOIN folders f ON f.id = d.folder_id
        WHERE d.owner_user_id = ?1 AND d.deleted_at IS NOT NULL
      UNION ALL SELECT up.doc_id, f.id, f.parent_id, f.kind, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
        WHERE up.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT id, title, filename, folder_id AS folderId, created_at AS createdAt, updated_at AS updatedAt, deleted_at AS trashedAt
      FROM docs WHERE id IN (SELECT doc_id FROM up WHERE id = ?2 AND kind = 'vault')`).bind(ownerId, vaultId).all<TrashedRow>();
  return rows.results;
}

export async function workspace(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type !== 'user') return unauthenticated();
  const db = createDb(env.DB);
  const home = await ensureDefaultVault(db, principal.id);
  const visible = await accessibleFolders(db, principal);
  const docs = await accessibleDocs(db, principal, Promise.resolve(visible));
  const byId = new Map(visible.map((folder) => [folder.id, folder]));
  const vaults = visible.filter((folder) => folder.kind === 'vault').map((folder) => ({
    id: folder.id, name: folder.name, role: folder.role, owned: folder.ownerUserId === principal.id,
  })).sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const params = new URL(request.url).searchParams;
  const doc = docs.find((doc) => doc.id === params.get('doc'));
  const docVault = doc && byId.get(doc.folderId)?.vaultId;
  const requested = docVault && vaults.some((vault) => vault.id === docVault) ? docVault : params.get('vault');
  const vault = vaults.find((vault) => vault.id === requested) ?? vaults.find((vault) => vault.id === home)!;

  const paths = new Map<string, string>([[vault.id, 'Notes']]);
  const used = new Set<string>(['Notes']);
  const pathFor = (id: string): string | null => {
    const cached = paths.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder || folder.kind === 'vault') return null;
    const parent = folder.parentId && byId.has(folder.parentId) ? pathFor(folder.parentId) : 'Notes';
    if (!parent) return null;
    const base = `${parent}/${folder.name.replaceAll('/', '∕')}`;
    let path = base;
    if (used.has(path)) path = `${base} (${folder.id})`;
    while (used.has(path)) path += '~';
    used.add(path);
    paths.set(id, path);
    return path;
  };
  const folders = visible.filter((folder) => folder.kind !== 'vault').sort((a, b) =>
    Number(b.ownerUserId === principal.id) - Number(a.ownerUserId === principal.id) || a.id.localeCompare(b.id),
  ).flatMap((folder) => {
    const path = pathFor(folder.id);
    return path ? [{ id: folder.id, name: path.split('/').pop()!, path, role: folder.role,
      surfaced: !folder.parentId || !byId.has(folder.parentId), createdAt: folder.createdAt,
      noteCount: docs.filter((doc) => doc.folderId === folder.id).length }] : [];
  });
  const rows = docs.flatMap((doc) => {
    const surfaced = !byId.has(doc.folderId);
    const folderPath = surfaced ? 'Notes' : pathFor(doc.folderId);
    return folderPath ? [{ id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      role: doc.role, folderPath, surfaced }] : [];
  });
  // A trashed note shows under its folder while that folder is live, else at the root it would be restored to.
  const trashed = (await trashedIn(env.DB, principal.id, vault.id)).map((doc) => ({ id: doc.id, title: doc.title,
    filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt, role: 'owner' as const, folderPath: pathFor(doc.folderId) ?? 'Notes',
    surfaced: false, trashedAt: doc.trashedAt }));
  rows.push(...trashed);
  rows.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const ids = params.has('ids') ? new Set(params.getAll('ids')) : null;
  return json({ vault, vaults, docs: ids ? rows.filter((row) => ids.has(row.id)) : rows, folders }, 200, NO_STORE);
}

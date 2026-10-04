// The active vault's tree, plus directly shared items whose parents are inaccessible, plus the trashed notes the
// caller manages (A§8) in it, or in a vault they cannot see, for the Trash view, each with `trashedAt` (A§11). A share link scopes a
// listing of its own (T2.4): an anonymous holder sees only the linked doc, or the linked folder as the root of a
// one-vault workspace; a signed-in holder of a folder link they cannot otherwise see is offered that folder beside
// their vaults. Link listings never name the owner's vault or the folders around the link.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { maxRole, type Role } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, type Db } from '../db/client.ts';
import { docs as docsTable, folders as foldersTable } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { accessibleDocs, accessibleFolders, liveLink, MAX_FOLDER_DEPTH, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

interface VaultRow { id: string; name: string; role: Role; owned: boolean }
interface FolderRow { id: string; name: string; path: string; role: Role; surfaced: boolean; createdAt: number; noteCount: number }
interface DocRow { id: string; title: string; filename: string; createdAt: number; updatedAt: number; role: Role; folderPath: string; surfaced: boolean; trashedAt?: number }
interface TrashedRow { id: string; title: string; filename: string; folderId: string; createdAt: number; updatedAt: number; trashedAt: number; vaultId: string }

/**
 * The trashed notes user `userId` manages (A§8: the vault's owner, or an `owner` grant on the note or a folder of its
 * chain), each with its live vault, trashed folders included. Only vaults whose owner the user is, or co-owns
 * something of, are read.
 */
async function trashedManagedBy(db: D1Database, userId: string): Promise<TrashedRow[]> {
  const rows = await db.prepare(`WITH RECURSIVE owners(id) AS (
      SELECT ?1
      UNION SELECT f.owner_user_id FROM folder_members m JOIN folders f ON f.id = m.folder_id WHERE m.principal_id = ?1 AND m.role = 'owner'
      UNION SELECT d.owner_user_id FROM doc_members m JOIN docs d ON d.id = m.doc_id WHERE m.principal_id = ?1 AND m.role = 'owner'
    ), up(doc_id, id, parent_id, kind, depth) AS (
      SELECT d.id, f.id, f.parent_id, f.kind, 1 FROM docs d JOIN folders f ON f.id = d.folder_id
        WHERE d.owner_user_id IN (SELECT id FROM owners) AND d.deleted_at IS NOT NULL
      UNION ALL SELECT up.doc_id, f.id, f.parent_id, f.kind, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
        WHERE up.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT d.id, d.title, d.filename, d.folder_id AS folderId, d.created_at AS createdAt, d.updated_at AS updatedAt,
        d.deleted_at AS trashedAt, v.id AS vaultId
      FROM docs d JOIN up v ON v.doc_id = d.id AND v.kind = 'vault' JOIN folders vf ON vf.id = v.id AND vf.deleted_at IS NULL
      WHERE d.owner_user_id = ?1
        OR EXISTS (SELECT 1 FROM doc_members m WHERE m.doc_id = d.id AND m.principal_id = ?1 AND m.role = 'owner')
        OR EXISTS (SELECT 1 FROM up JOIN folder_members m ON m.folder_id = up.id
          WHERE up.doc_id = d.id AND m.principal_id = ?1 AND m.role = 'owner')`).bind(userId).all<TrashedRow>();
  return rows.results;
}

const byUpdated = (a: DocRow, b: DocRow) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);

/** Collision-free `Notes/...` paths for folders under a root, which is `Notes` itself (A§9 id↔path map). */
type TreeNode = { id: string; name: string; parentId: string | null; kind: string };

function pathMap(rootId: string, byId: Map<string, TreeNode>) {
  const paths = new Map<string, string>([[rootId, 'Notes']]);
  const used = new Set<string>(['Notes']);
  const pathFor = (id: string, depth = 0): string | null => {
    const cached = paths.get(id);
    if (cached) return cached;
    const folder = byId.get(id);
    if (!folder || folder.kind === 'vault' || depth > MAX_FOLDER_DEPTH) return null;
    const parent = folder.parentId && byId.has(folder.parentId) ? pathFor(folder.parentId, depth + 1) : 'Notes';
    if (!parent) return null;
    const base = `${parent}/${folder.name.replaceAll('/', '∕')}`;
    let path = base;
    if (used.has(path)) path = `${base} (${folder.id})`;
    while (used.has(path)) path += '~';
    used.add(path);
    paths.set(id, path);
    return path;
  };
  return pathFor;
}

/** The live subtree under `rootId` (the root excluded), at most MAX_FOLDER_DEPTH levels down. */
async function subtree(db: Db, rootId: string, ownerUserId: string) {
  const rows = await db.select().from(foldersTable).where(and(eq(foldersTable.ownerUserId, ownerUserId), isNull(foldersTable.deletedAt)));
  const children = new Map<string, typeof rows>();
  for (const row of rows) if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  const found: typeof rows = [];
  let level = [rootId];
  for (let depth = 0; depth < MAX_FOLDER_DEPTH && level.length; depth += 1) {
    const next = level.flatMap((id) => children.get(id) ?? []);
    found.push(...next);
    level = next.map((row) => row.id);
  }
  return found;
}

/** A folder link's workspace: the folder as the vault root, its subfolders and its docs, each at the caller's role. */
async function folderLinkListing(db: Db, principal: Principal, token: string, root: { id: string; name: string; ownerUserId: string; role: Role }) {
  const below = await subtree(db, root.id, root.ownerUserId);
  const byId = new Map<string, TreeNode>([[root.id, { id: root.id, name: root.name, parentId: null, kind: 'vault' }], ...below.map((row): [string, TreeNode] => [row.id, row])]);
  const pathFor = pathMap(root.id, byId);
  const rows = await db.select().from(docsTable).where(and(inArray(docsTable.folderId, [root.id, ...below.map((row) => row.id)]), isNull(docsTable.deletedAt)));
  const docs = (await Promise.all(rows.map(async (doc): Promise<DocRow | null> => {
    const access = await resolveDocAccess(db, principal, doc.id, token);
    const folderPath = pathFor(doc.folderId);
    return access && folderPath ? { id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      role: access.role, folderPath, surfaced: true } : null;
  }))).filter((row): row is DocRow => row !== null).sort(byUpdated);
  // Each folder at the caller's own role, so a grant on a subfolder above the link's role shows.
  const folders: FolderRow[] = (await Promise.all(below.map(async (folder): Promise<FolderRow | null> => {
    const path = pathFor(folder.id);
    const role = (await resolveFolderAccess(db, principal, folder.id, token))?.role ?? root.role;
    return path ? { id: folder.id, name: path.split('/').pop()!, path, role, surfaced: true, createdAt: folder.createdAt,
      noteCount: docs.filter((doc) => doc.folderPath === path).length } : null;
  }))).filter((row): row is FolderRow => row !== null);
  return { docs, folders };
}

/** What a presented link scopes, or null for a forged, revoked or inaccessible one. */
async function linkScope(db: Db, principal: Principal, token: string | null) {
  const link = await liveLink(db, token);
  if (!link || !token) return null;
  if (link.targetType === 'doc') {
    const access = await resolveDocAccess(db, principal, link.targetId, token);
    if (!access || access.deleted) return null;
    const [doc] = await db.select().from(docsTable).where(eq(docsTable.id, link.targetId)).limit(1);
    if (!doc) return null;
    const row: DocRow = { id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      role: access.role, folderPath: 'Notes', surfaced: true };
    return { kind: 'doc' as const, vault: { id: doc.id, name: 'Shared note', role: access.role, owned: false }, docs: [row], folders: [] as FolderRow[] };
  }
  const access = await resolveFolderAccess(db, principal, link.targetId, token);
  if (!access || access.deleted) return null;
  const vault: VaultRow = { id: link.targetId, name: access.name, role: access.role, owned: false };
  return { kind: 'folder' as const, vault, linkOnly: access.linkOnly,
    list: () => folderLinkListing(db, principal, token, { id: link.targetId, name: access.name, ownerUserId: access.ownerUserId, role: access.role }) };
}

/** The docs and folders a presented link covers (a folder link covers its live subtree), with the link's role. */
async function linkCover(db: Db, token: string) {
  const link = await liveLink(db, token);
  if (!link) return null;
  if (link.targetType === 'doc') return { role: link.role, docIds: new Set([link.targetId]), folderIds: new Set<string>() };
  const [root] = await db.select({ ownerUserId: foldersTable.ownerUserId }).from(foldersTable).where(eq(foldersTable.id, link.targetId)).limit(1);
  if (!root) return null;
  const below = await subtree(db, link.targetId, root.ownerUserId);
  return { role: link.role, docIds: new Set<string>(), folderIds: new Set([link.targetId, ...below.map((row) => row.id)]) };
}

export async function workspace(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'agent') return unauthenticated();
  const db = createDb(env.DB);
  const params = new URL(request.url).searchParams;
  const ids = params.has('ids') ? new Set(params.getAll('ids')) : null;
  const only = (rows: DocRow[]) => (ids ? rows.filter((row) => ids.has(row.id)) : rows);

  if (principal.type === 'anonymous') {
    const scope = await linkScope(db, principal, principal.shareToken);
    if (!scope) return notFound();
    const { docs, folders } = scope.kind === 'doc' ? scope : await scope.list();
    return json({ vault: scope.vault, vaults: [scope.vault], docs: only(docs), folders }, 200, NO_STORE);
  }

  const home = await ensureDefaultVault(db, principal.id);
  const visible = await accessibleFolders(db, principal);
  const docs = await accessibleDocs(db, principal, Promise.resolve(visible));
  const byId = new Map(visible.map((folder) => [folder.id, folder]));
  const vaults: VaultRow[] = visible.filter((folder) => folder.kind === 'vault').map((folder) => ({
    id: folder.id, name: folder.name, role: folder.role, owned: folder.ownerUserId === principal.id,
  })).sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  // A folder link the caller cannot otherwise see is offered as a vault of its own.
  const token = shareTokenOf(request);
  const scope = token ? await linkScope(db, principal, token) : null;
  const linkVault = scope?.kind === 'folder' && scope.linkOnly ? scope : null;
  if (linkVault) vaults.push(linkVault.vault);

  const doc = docs.find((doc) => doc.id === params.get('doc'));
  const shownFolder = byId.get(params.get('folder') ?? '');
  const followed = (doc && byId.get(doc.folderId)?.vaultId) || shownFolder?.vaultId;
  // The link's own workspace when asked for, or when the landing's folder or doc is reachable only through it.
  const askedLink = linkVault !== null && params.get('vault') === linkVault.vault.id;
  if (linkVault && (askedLink || (!followed && (params.has('folder') || params.has('doc'))))) {
    const { docs: rows, folders } = await linkVault.list();
    const folderId = params.get('folder');
    if (askedLink || folderId === linkVault.vault.id || folders.some((folder) => folder.id === folderId)
      || rows.some((row) => row.id === params.get('doc'))) {
      return json({ vault: linkVault.vault, vaults, docs: only(rows), folders }, 200, NO_STORE);
    }
  }

  // A presented link lifts every row it covers to the MAX of the caller's role and the link's (A§8).
  const cover = token ? await linkCover(db, token) : null;
  const lift = (role: Role, docId: string | null, folderId: string): Role =>
    cover && ((docId !== null && cover.docIds.has(docId)) || cover.folderIds.has(folderId)) ? (maxRole(role, cover.role) ?? role) : role;
  for (const row of vaults) if (row !== linkVault?.vault) row.role = lift(row.role, null, row.id);

  const requested = followed && vaults.some((vault) => vault.id === followed) ? followed : params.get('vault');
  const vault = vaults.find((vault) => vault.id === requested && vault !== linkVault?.vault) ?? vaults.find((vault) => vault.id === home)!;

  const pathFor = pathMap(vault.id, byId);
  const folders = visible.filter((folder) => folder.kind !== 'vault').sort((a, b) =>
    Number(b.ownerUserId === principal.id) - Number(a.ownerUserId === principal.id) || a.id.localeCompare(b.id),
  ).flatMap((folder) => {
    const path = pathFor(folder.id);
    return path ? [{ id: folder.id, name: path.split('/').pop()!, path, role: lift(folder.role, null, folder.id),
      surfaced: !folder.parentId || !byId.has(folder.parentId), createdAt: folder.createdAt,
      noteCount: docs.filter((doc) => doc.folderId === folder.id).length }] : [];
  });
  const rows = docs.flatMap((doc) => {
    const surfaced = !byId.has(doc.folderId);
    const folderPath = surfaced ? 'Notes' : pathFor(doc.folderId);
    return folderPath ? [{ id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      role: lift(doc.role, doc.id, doc.folderId), folderPath, surfaced }] : [];
  });
  // A trashed note shows under its folder while that folder is live, else at the root it would be restored to; one in
  // a vault the caller cannot see surfaces at the root, as a shared live note does.
  const trashed = (await trashedManagedBy(env.DB, principal.id))
    .filter((doc) => doc.vaultId === vault.id || byId.get(doc.vaultId)?.kind !== 'vault')
    .map((doc): DocRow => {
      const surfaced = doc.vaultId !== vault.id;
      return { id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt, role: 'owner',
        folderPath: surfaced ? 'Notes' : pathFor(doc.folderId) ?? 'Notes', surfaced, trashedAt: doc.trashedAt };
    });
  rows.push(...trashed);
  rows.sort(byUpdated);
  return json({ vault, vaults, docs: only(rows), folders }, 200, NO_STORE);
}

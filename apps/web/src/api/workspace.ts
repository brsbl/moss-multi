// The active vault's tree, plus directly shared items whose parents are inaccessible, plus the trashed
// notes in it the caller manages (owner or co-owner) for the Trash view, each with `trashedAt` (A§11). A share link scopes a
// listing of its own (T2.4): an anonymous holder sees only the linked doc, or the linked folder as the root of a
// one-vault workspace; a signed-in holder of a folder link they cannot otherwise see is offered that folder beside
// their vaults. Link listings never name the owner's vault or the folders around the link.
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { can, foldRole, maxRole, type Role } from '@moss-multi/protocol/roles';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf, type Principal } from '../auth/principal.ts';
import { createDb, inJson, type Db } from '../db/client.ts';
import { docMembers, docs as docsTable, folderMembers, folders as foldersTable } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { accessibleDocs, accessibleFolders, actingUserId, folderChain, grantees, liveLink, MAX_FOLDER_DEPTH, resolveDocAccess, resolveFolderAccess } from './access.ts';
import { NO_STORE, notFound, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

interface VaultRow { id: string; name: string; role: Role; owned: boolean }
interface FolderRow { id: string; name: string; path: string; role: Role; surfaced: boolean; createdAt: number; noteCount: number }
interface DocRow { id: string; title: string; filename: string; createdAt: number; updatedAt: number; role: Role; folderPath: string; surfaced: boolean; trashedAt?: number }
interface TrashedRow { id: string; title: string; filename: string; folderId: string; createdAt: number; updatedAt: number; trashedAt: number }

/** A lookup of the roles granted on each id among `rows`, empty for an id with none. */
function rolesById(rows: { id: string; role: Role }[]): (id: string) => Role[] {
  const byId = new Map<string, Role[]>();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row.role]);
  return (id: string) => byId.get(id) ?? [];
}

/**
 * Trashed notes the signed-in caller may manage, each with the vault its folder chain ends at, trashed folders
 * included. Rows come from ownership, doc grants and folder grants, each with its folder chain; the caller's grants are
 * then folded per row as resolveDocAccess does (the check trash and restore make), so a co-owner who trashes a note
 * finds it in Trash. Three queries, however large Trash grows.
 */
async function managedTrash(db: D1Database, userId: string): Promise<(TrashedRow & { vaultId: string })[]> {
  const [chains, folderGrants, docGrants] = await Promise.all([
    db.prepare(`WITH RECURSIVE granted(id, depth) AS (
      SELECT folder_id, 1 FROM folder_members WHERE principal_id = ?1
      UNION SELECT f.id, granted.depth + 1 FROM folders f JOIN granted ON f.parent_id = granted.id WHERE granted.depth < ${MAX_FOLDER_DEPTH}
    ), up(doc_id, id, parent_id, kind, depth) AS (
      SELECT d.id, f.id, f.parent_id, f.kind, 1 FROM docs d JOIN folders f ON f.id = d.folder_id
        WHERE d.deleted_at IS NOT NULL AND (d.owner_user_id = ?1 OR d.folder_id IN (SELECT id FROM granted)
          OR d.id IN (SELECT doc_id FROM doc_members WHERE principal_id = ?1))
      UNION ALL SELECT up.doc_id, f.id, f.parent_id, f.kind, up.depth + 1 FROM folders f JOIN up ON f.id = up.parent_id
        WHERE up.depth < ${MAX_FOLDER_DEPTH}
    ) SELECT d.id, d.title, d.filename, d.folder_id AS folderId, d.created_at AS createdAt, d.updated_at AS updatedAt,
        d.deleted_at AS trashedAt, d.owner_user_id AS ownerUserId, up.id AS chainId, up.kind
      FROM docs d JOIN up ON up.doc_id = d.id ORDER BY d.id, up.depth`)
      .bind(userId).all<TrashedRow & { ownerUserId: string; chainId: string; kind: string }>(),
    db.prepare('SELECT folder_id AS id, role FROM folder_members WHERE principal_id = ?').bind(userId).all<{ id: string; role: Role }>(),
    db.prepare('SELECT doc_id AS id, role FROM doc_members WHERE principal_id = ?').bind(userId).all<{ id: string; role: Role }>(),
  ]);
  const onFolder = rolesById(folderGrants.results);
  const onDoc = rolesById(docGrants.results);
  const byDoc = new Map<string, { row: TrashedRow & { ownerUserId: string }; grants: Role[]; vaultId: string | null }>();
  for (const { chainId, kind, ...row } of chains.results) {
    const entry = byDoc.get(row.id) ?? byDoc.set(row.id, { row, grants: [...onDoc(row.id)], vaultId: null }).get(row.id)!;
    entry.grants.push(...onFolder(chainId));
    if (kind === 'vault') entry.vaultId = chainId;
  }
  return [...byDoc.values()].flatMap(({ row: { ownerUserId, ...row }, grants, vaultId }) => {
    const role = foldRole({ owner: ownerUserId === userId, grants, link: null, anonymous: false });
    return vaultId && role && can(role, 'manage') ? [{ ...row, vaultId }] : [];
  });
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

/**
 * A folder link's workspace: the folder as the vault root, its subfolders and its docs, each at the caller's role as
 * resolveDocAccess and resolveFolderAccess fold it (ownership, grants up the chain, the link as a ceiling). At most six
 * queries with a fixed number of parameters, however large the subtree.
 */
async function folderLinkListing(db: Db, principal: Principal, token: string, root: { id: string; name: string; ownerUserId: string; role: Role }) {
  const ids = grantees(principal);
  const [below, rootChain, link, folderGrants, docGrants] = await Promise.all([
    subtree(db, root.id, root.ownerUserId),
    folderChain(db, root.id),
    liveLink(db, token),
    ids.length ? db.select({ id: folderMembers.folderId, role: folderMembers.role }).from(folderMembers).where(inArray(folderMembers.principalId, ids)) : [],
    ids.length ? db.select({ id: docMembers.docId, role: docMembers.role }).from(docMembers).where(inArray(docMembers.principalId, ids)) : [],
  ]);
  const byId = new Map<string, TreeNode>([[root.id, { id: root.id, name: root.name, parentId: null, kind: 'vault' }], ...below.map((row): [string, TreeNode] => [row.id, row])]);
  const pathFor = pathMap(root.id, byId);
  const rows = await db.select().from(docsTable).where(and(inJson(docsTable.folderId, [root.id, ...below.map((row) => row.id)]), isNull(docsTable.deletedAt)));

  const onFolder = rolesById(folderGrants);
  const onDoc = rolesById(docGrants);
  // folderChain(folderId), walked in memory down here and read once above the root.
  const chainOf = (folderId: string) => {
    const chain: string[] = [];
    let current: string | null = folderId;
    while (current && current !== root.id && chain.length < MAX_FOLDER_DEPTH) {
      chain.push(current);
      current = byId.get(current)?.parentId ?? null;
    }
    if (current === root.id) chain.push(...rootChain);
    return chain.slice(0, MAX_FOLDER_DEPTH);
  };
  const actor = actingUserId(principal);
  const roleOf = (ownerUserId: string, docId: string | null, folderId: string) => {
    const chain = chainOf(folderId);
    const covers = link && (link.targetType === 'doc' ? link.targetId === docId : chain.includes(link.targetId));
    return foldRole({ owner: actor === ownerUserId, grants: [...(docId === null ? [] : onDoc(docId)), ...chain.flatMap(onFolder)],
      link: covers ? link.role : null, anonymous: principal.type === 'anonymous', agent: principal.type === 'agent' });
  };

  const docs = rows.flatMap((doc): DocRow[] => {
    const role = roleOf(doc.ownerUserId, doc.id, doc.folderId);
    const folderPath = pathFor(doc.folderId);
    return role && folderPath ? [{ id: doc.id, title: doc.title, filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      role, folderPath, surfaced: true }] : [];
  }).sort(byUpdated);
  // Each folder at the caller's own role, so a grant on a subfolder above the link's role shows.
  const folders: FolderRow[] = below.flatMap((folder): FolderRow[] => {
    const path = pathFor(folder.id);
    const role = roleOf(folder.ownerUserId, null, folder.id) ?? root.role;
    return path ? [{ id: folder.id, name: path.split('/').pop()!, path, role, surfaced: true, createdAt: folder.createdAt,
      noteCount: docs.filter((doc) => doc.folderPath === path).length }] : [];
  });
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
  const docs = await accessibleDocs(db, principal, visible);
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
  // A trashed note shows under its folder while that folder is live, else at the root it would be restored to.
  // A note in a vault the caller cannot see surfaces in every vault, as a live one does.
  const trashed = (await managedTrash(env.DB, principal.id)).filter((doc) => doc.vaultId === vault.id || !byId.has(doc.vaultId))
    .map((doc): DocRow => ({ id: doc.id, title: doc.title,
    filename: doc.filename, createdAt: doc.createdAt, updatedAt: doc.updatedAt, role: 'owner', folderPath: pathFor(doc.folderId) ?? 'Notes',
    surfaced: false, trashedAt: doc.trashedAt }));
  rows.push(...trashed);
  rows.sort(byUpdated);
  return json({ vault, vaults, docs: only(rows), folders }, 200, NO_STORE);
}

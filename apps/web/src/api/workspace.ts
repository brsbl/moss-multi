// The active vault's tree, plus directly shared items whose parents are inaccessible (A§11).
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { accessibleDocs, accessibleFolders } from './access.ts';
import { NO_STORE, unauthenticated } from './respond.ts';
import { ensureDefaultVault } from './vaults.ts';

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
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return json({ vault, vaults, docs: rows, folders }, 200, NO_STORE);
}

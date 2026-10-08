// The vaults API (T3.5; A§6, A§11): POST /api/vaults creates one of the caller's own vaults, PATCH /api/vaults/:id
// renames it, DELETE /api/vaults/:id sends it to Trash as one batch through the folder trash path. Rename and trash
// are the vault owner's alone, on ownership; a member gets 403, anyone else the one 404. The last live vault is never
// trashed. Every refusal carries a sentence, since the switcher shows the message it gets.
import { eq } from 'drizzle-orm';
import { principalsWithFolderAccess, publishTo, type FanoutEnv } from '@moss-multi/sync/fanout';
import { resolvePrincipal } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { folders } from '../db/schema.ts';
import { json } from '../worker/route.ts';
import { accessibleFolders, actingUserId, resolveFolderAccess } from './access.ts';
import { FOLDER_NAME_MAX, trashFolder, type FoldersEnv } from './folders.ts';
import { NO_STORE, notFound, readJsonObject, unauthenticated } from './respond.ts';

const refuse = (status: number, error: string, message: string) => json({ error, message }, status, NO_STORE);

const isUnique = (error: unknown) => /UNIQUE/i.test(`${error} ${(error as { cause?: unknown })?.cause ?? ''}`);

/** The trimmed name, or the sentence that says what is wrong with it. Same rules as a folder's. */
function vaultName(value: unknown): { name: string } | { problem: string } {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { problem: 'Give the vault a name.' };
  if (name.length > FOLDER_NAME_MAX) return { problem: `Vault names can be at most ${FOLDER_NAME_MAX} characters.` };
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return { problem: 'Vault names can’t contain “/” or “\\”.' };
  return { name };
}

const taken = (name: string) => refuse(409, 'vault-exists', `You already have a vault named “${name}”.`);

/** Tells everyone who can see the vault to re-read their switcher; a committed change never fails on it. */
async function announce(env: FoldersEnv, principalIds: Iterable<string>): Promise<void> {
  if (!env.PrincipalDO) return;
  try {
    await Promise.all([...new Set(principalIds)].map((id) =>
      publishTo({ DB: env.DB, PrincipalDO: env.PrincipalDO } as FanoutEnv, id, { type: 'vaults' })));
  } catch (error) {
    console.error('workspace vault notification failed', error);
  }
}

async function owner(request: Request, env: FoldersEnv): Promise<string | null> {
  const principal = await resolvePrincipal(request, env);
  return principal && principal.type !== 'anonymous' ? actingUserId(principal) : null;
}

async function createVault(request: Request, env: FoldersEnv): Promise<Response> {
  const userId = await owner(request, env);
  if (!userId) return unauthenticated();
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  const named = vaultName(body.name);
  if ('problem' in named) return refuse(400, 'bad-name', named.problem);
  const id = crypto.randomUUID();
  try {
    await createDb(env.DB).insert(folders)
      .values({ id, ownerUserId: userId, createdBy: userId, name: named.name, kind: 'vault', createdAt: Date.now() });
  } catch (error) {
    if (isUnique(error)) return taken(named.name);
    throw error;
  }
  await announce(env, [userId]);
  return json({ vault: { id, name: named.name, role: 'owner', owned: true } }, 201, NO_STORE);
}

/** The live vault `id` when the caller owns it, else the response that refuses them. */
async function ownedVault(request: Request, env: FoldersEnv, id: string, verb: string): Promise<{ userId: string } | Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const access = await resolveFolderAccess(createDb(env.DB), principal, id);
  if (!access || access.kind !== 'vault') return notFound();
  const userId = actingUserId(principal);
  if (access.ownerUserId !== userId || !userId) {
    return access.deleted ? notFound() : refuse(403, 'forbidden', `Only the vault’s owner can ${verb} it.`);
  }
  return { userId };
}

async function renameVault(request: Request, env: FoldersEnv, id: string): Promise<Response> {
  const owned = await ownedVault(request, env, id, 'rename');
  if (owned instanceof Response) return owned;
  const body = await readJsonObject(request);
  if (!body) return refuse(400, 'bad-request', 'The request body must be a JSON object.');
  const named = vaultName(body.name);
  if ('problem' in named) return refuse(400, 'bad-name', named.problem);
  try {
    const result = await env.DB.prepare("UPDATE folders SET name = ?1 WHERE id = ?2 AND kind = 'vault' AND deleted_at IS NULL")
      .bind(named.name, id).run();
    if ((result.meta?.changes ?? 0) === 0) return notFound();
  } catch (error) {
    if (isUnique(error)) return taken(named.name);
    throw error;
  }
  await announce(env, await principalsWithFolderAccess(env.DB, id));
  return json({ vault: { id, name: named.name, role: 'owner', owned: true } }, 200, NO_STORE);
}

async function trashVault(request: Request, env: FoldersEnv, id: string): Promise<Response> {
  const owned = await ownedVault(request, env, id, 'move');
  if (owned instanceof Response) return owned;
  const [vault] = await createDb(env.DB).select({ deletedAt: folders.deletedAt }).from(folders).where(eq(folders.id, id));
  if (vault?.deletedAt === null) {
    const live = await env.DB.prepare("SELECT count(*) AS n FROM folders WHERE owner_user_id = ?1 AND kind = 'vault' AND deleted_at IS NULL")
      .bind(owned.userId).first<{ n: number }>();
    if ((live?.n ?? 0) <= 1) return refuse(409, 'last-vault', 'This is your only vault, so it can’t be moved to Trash. Create another vault first.');
  }
  // Sharers hear about the vault going away from the folder trash's own notification.
  return trashFolder(request, env, id, 'vault');
}

/** GET /api/vaults: the vaults a signed-in person or an agent can open (the CLI's `vaults`; T7.1). */
async function listVaults(request: Request, env: FoldersEnv): Promise<Response> {
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  const userId = actingUserId(principal);
  const vaults = (await accessibleFolders(createDb(env.DB), principal)).filter((folder) => folder.kind === 'vault')
    .map((folder) => ({ id: folder.id, name: folder.name, role: folder.role, owned: folder.ownerUserId === userId }))
    .sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return json({ vaults }, 200, NO_STORE);
}

const VAULT = /^\/api\/vaults\/([^/]+)$/;

/** `/api/vaults` and `/api/vaults/:id`. */
export function handleVaults(request: Request, env: FoldersEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/vaults') {
    if (request.method === 'GET') return listVaults(request, env);
    return request.method === 'POST' ? createVault(request, env) : Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'GET, POST' }));
  }
  const vault = VAULT.exec(pathname);
  if (vault) {
    if (request.method === 'PATCH') return renameVault(request, env, vault[1]);
    if (request.method === 'DELETE') return trashVault(request, env, vault[1]);
    return Promise.resolve(json({ error: 'method-not-allowed' }, 405, { allow: 'PATCH, DELETE' }));
  }
  return Promise.resolve(json({ error: 'not-found' }, 404));
}

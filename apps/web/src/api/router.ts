// /api/* (A§4.1 step 5). Unknown paths get a JSON 404; /api never answers with HTML.
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { crossOriginCookie, needsAppOrigin } from '../worker/origin-gate.ts';
import { json } from '../worker/route.ts';
import { ASSET_ROUTE, handleAssets } from './assets.ts';
import { handleDocs, type DocsEnv } from './docs.ts';
import { feedback } from './feedback.ts';
import { handleFolderRoutes } from './folders.ts';
import { handleSearchRoutes } from './search.ts';
import { handleVaults } from './vault-routes.ts';
import { handleTrash } from './trash.ts';
import { workspace } from './workspace.ts';

const NO_STORE = { 'cache-control': 'no-store' };

/** The signed-in caller, user or agent. A share token alone is not an identity. */
async function me(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated' }, 401, NO_STORE);
  if (principal.type === 'agent') return json({ principal }, 200, NO_STORE);
  const { type, id, name, email } = principal;
  return json({ principal: { type, id, name, email } }, 200, NO_STORE);
}

export type ApiEnv = DocsEnv & Partial<Pick<AppEnv, 'PrincipalDO' | 'SearchDO'>>;

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  // The origin gate (A§18) before any mutation; a read resolves no principal here.
  if (needsAppOrigin(request) && crossOriginCookie(request, await resolvePrincipal(request, env), env)) {
    return json({ error: 'forbidden', message: 'Cross-origin request refused' }, 403, NO_STORE);
  }
  const { pathname } = new URL(request.url);
  if (pathname === '/api/me') return me(request, env);
  if (pathname === '/api/workspace') return workspace(request, env);
  if (pathname === '/api/feedback') return feedback(request, env);
  if (ASSET_ROUTE.test(pathname)) {
    return env.ASSETS ? handleAssets(request, { ...env, ASSETS: env.ASSETS }) : json({ error: 'unavailable' }, 503, NO_STORE);
  }
  const searched = handleSearchRoutes(request, env);
  if (searched) return searched;
  if (pathname === '/api/vaults' || pathname.startsWith('/api/vaults/')) return handleVaults(request, env);
  if (pathname.startsWith('/api/trash/')) return handleTrash(request, env);
  if (pathname === '/api/docs' || pathname.startsWith('/api/docs/')) return handleDocs(request, env);
  if (pathname === '/api/folders' || pathname.startsWith('/api/folders/')) return handleFolderRoutes(request, env);
  return json({ error: 'not-found' }, 404);
}

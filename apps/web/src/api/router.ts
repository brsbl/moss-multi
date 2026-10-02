// /api/* (A§4.1 step 5). Unknown paths get a JSON 404; /api never answers with HTML.
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal } from '../auth/principal.ts';
import { json } from '../worker/route.ts';
import { handleDocs, type DocsEnv } from './docs.ts';
import { feedback } from './feedback.ts';
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

export type ApiEnv = DocsEnv;

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/api/me') return me(request, env);
  if (pathname === '/api/workspace') return workspace(request, env);
  if (pathname === '/api/feedback') return feedback(request, env);
  if (pathname === '/api/docs' || pathname.startsWith('/api/docs/')) return handleDocs(request, env);
  return json({ error: 'not-found' }, 404);
}

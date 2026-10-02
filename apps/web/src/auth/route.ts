// /api/auth/* (A§4.1 step 3): better-auth built per request.
import { json } from '../worker/route.ts';
import { createAuth, type AuthEnv } from './auth.ts';

// The CLI's device flow posts from a terminal, which sends no Origin.
const NO_ORIGIN_PATHS = new Set(['/api/auth/device/code', '/api/auth/device/token']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * better-auth 1.6.23 checks Origin only on requests that carry a cookie or fetch metadata, so a bare POST (a
 * script or form tooling) would sign up or sign in unchecked. Every other unsafe auth request needs an Origin;
 * better-auth then rejects one that is not BETTER_AUTH_URL's.
 */
function missingOrigin(request: Request): boolean {
  if (SAFE_METHODS.has(request.method) || NO_ORIGIN_PATHS.has(new URL(request.url).pathname)) return false;
  const origin = request.headers.get('origin');
  return !origin || origin === 'null';
}

export async function handleAuthRoute(request: Request, env: AuthEnv): Promise<Response> {
  if (missingOrigin(request)) return json({ code: 'MISSING_OR_NULL_ORIGIN', message: 'Missing or null Origin' }, 403);
  return createAuth(env).handler(request);
}

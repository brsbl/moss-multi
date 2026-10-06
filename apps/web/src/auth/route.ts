// /api/auth/* (A§4.1 step 3): better-auth built per request. Sign-out first ends the session in every open window
// (A§7): the session's PrincipalDO rechecks each doc it opened and closes its workspace sockets.
import { endSession } from '@moss-multi/sync/fanout';
import type { AppEnv } from '../env.ts';
import { crossOriginCookie } from '../worker/origin-gate.ts';
import { json } from '../worker/route.ts';
import { createAuth, type AuthEnv } from './auth.ts';
import { resolvePrincipal } from './principal.ts';

const SIGN_OUT = '/api/auth/sign-out';

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

/**
 * Before better-auth deletes the session, so a failure leaves something to retry (A§7 has it after; once deleted, a
 * retry could no longer name the session): the PrincipalDO records the session as ended, so a socket that registers
 * later closes 4402, and the session's open windows close before the answer.
 */
async function endSignedOutSession(request: Request, env: AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>): Promise<Response | null> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== SIGN_OUT || !env.PrincipalDO) return null;
  const principal = await resolvePrincipal(request, env);
  // Another origin's request is better-auth's to refuse; it ends nothing here.
  if (principal?.type !== 'user' || crossOriginCookie(request, principal, env)) return null;
  try {
    await endSession({ DB: env.DB, PrincipalDO: env.PrincipalDO }, principal.id, principal.sessionId);
    return null;
  } catch (error) {
    console.error('sign-out could not end the session', error);
    return json({ code: 'SESSION_NOT_ENDED', message: 'Couldn’t sign you out. Try again.' }, 503, { 'cache-control': 'no-store' });
  }
}

export async function handleAuthRoute(request: Request, env: AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>): Promise<Response> {
  if (missingOrigin(request)) return json({ code: 'MISSING_OR_NULL_ORIGIN', message: 'Missing or null Origin' }, 403);
  const refused = await endSignedOutSession(request, env);
  if (refused) return refused;
  return createAuth(env).handler(request);
}

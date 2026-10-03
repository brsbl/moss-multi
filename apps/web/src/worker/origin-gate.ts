// The one Origin gate (A§18). The browser attaches the session cookie to every request for this host, whichever
// page asked: a same-site page on another port or a sibling subdomain gets past SameSite=Lax. So a socket upgrade or
// a state-changing request whose principal came from that cookie must carry the app's own Origin. A bearer token,
// an agent key or a share token is never attached by the browser, so it passes. better-auth checks /api/auth/*.
import type { Principal } from '../auth/principal.ts';
import type { AppEnv } from '../env.ts';
import { isUpgrade } from './route.ts';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reads are not gated: a same-origin GET carries no Origin, and without CORS no other page can read the answer. */
export const needsAppOrigin = (request: Request): boolean => isUpgrade(request) || !SAFE_METHODS.has(request.method);

/** BETTER_AUTH_URL's origin, the one better-auth trusts; config.ts refuses to serve without it. */
const appOrigin = (env: Pick<AppEnv, 'BETTER_AUTH_URL'>): string => new URL(env.BETTER_AUTH_URL ?? '').origin;

/** True when the request must be refused: a cookie principal on a socket or a state change, from another origin. */
export function crossOriginCookie(request: Request, principal: Principal | null, env: Pick<AppEnv, 'BETTER_AUTH_URL'>): boolean {
  if (principal?.type !== 'user' || principal.credential !== 'cookie' || !needsAppOrigin(request)) return false;
  return request.headers.get('origin') !== appOrigin(env);
}

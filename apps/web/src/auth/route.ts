// /api/auth/* (A§4.1 step 3): better-auth built per request. Sign-out first ends the session in every open window
// (A§7): the session's PrincipalDO rechecks each doc it opened and closes its workspace sockets.
import { endSession } from '@moss-multi/sync/fanout';
import { NO_STORE } from '../api/respond.ts';
import type { AppEnv } from '../env.ts';
import { appOrigin, crossOriginCookie } from '../worker/origin-gate.ts';
import { json } from '../worker/route.ts';
import { createAuth, SIGN_UP_ADDRESS_DAILY, SIGN_UP_PRUNE_BATCH, type AuthEnv } from './auth.ts';
import { addressBucket } from './client-address.ts';
import { isLoopbackUrl } from './config.ts';
import { resolvePrincipal } from './principal.ts';

const SIGN_OUT = '/api/auth/sign-out';

// The CLI's device flow posts from a terminal, which sends no Origin.
const NO_ORIGIN_PATHS = new Set(['/api/auth/device/code', '/api/auth/device/token']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * better-auth 1.6.23 checks Origin only on requests that carry a cookie or fetch metadata, and only after its rate
 * limiter and the sign-up count here have run. So every unsafe auth request must carry BETTER_AUTH_URL's own Origin
 * before anything is counted: a foreign page cannot spend its visitors' sign-up or sign-in allowance.
 */
function foreignOrigin(request: Request, env: AuthEnv): boolean {
  if (SAFE_METHODS.has(request.method) || NO_ORIGIN_PATHS.has(new URL(request.url).pathname)) return false;
  return request.headers.get('origin') !== appOrigin(env);
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

/** Counts one attempt against `key`'s fixed window and answers the count and when the window opened. */
const COUNT_ATTEMPT = `INSERT INTO signup_limits (key, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
  RETURNING count, window_start AS windowStart`;

/** Windows closed for a day or more, a bounded batch through `signup_limits_window_idx`. */
const PRUNE = `DELETE FROM signup_limits WHERE key IN (
  SELECT key FROM signup_limits WHERE window_start < ?1 LIMIT ${SIGN_UP_PRUNE_BATCH})`;

/**
 * Open sign-up's bound beyond better-auth's minute limit (A§7, A§18): sign-ups per client address (an IPv6 /64 as one)
 * per day, counted in D1 before better-auth runs; 429 past it, and 503 when the count cannot be kept. The count is per
 * address only, so no one fills a bucket another person needs, and a request without a usable address is refused
 * rather than pooled. Only a loopback request to the loopback test-hook stack, which mints principals per run, skips this.
 */
async function signUpRefused(request: Request, env: AuthEnv): Promise<Response | null> {
  if (request.method !== 'POST' || !new URL(request.url).pathname.startsWith('/api/auth/sign-up/')) return null;
  if (env.MOSS_TEST_HOOKS === '1' && isLoopbackUrl(env.BETTER_AUTH_URL) && isLoopbackUrl(request.url)) return null;
  const address = addressBucket(request.headers.get('cf-connecting-ip'));
  if (!address) {
    return json({ code: 'CLIENT_ADDRESS_REQUIRED', message: 'Sign-up needs to know where the request came from.' }, 403, NO_STORE);
  }
  const now = Date.now();
  const window = SIGN_UP_ADDRESS_DAILY.window * 1000;
  let counted: { count: number; windowStart: number };
  try {
    const [attempt] = await env.DB.batch([
      env.DB.prepare(COUNT_ATTEMPT).bind(`address:${address}`, now, window),
      env.DB.prepare(PRUNE).bind(now - 2 * window),
    ]);
    counted = (attempt.results as { count: number; windowStart: number }[])[0];
  } catch (error) {
    console.error('sign-up limits unavailable', error);
    return json({ code: 'SIGN_UP_UNAVAILABLE', message: 'Sign-up is unavailable right now. Try again in a minute.' }, 503, NO_STORE);
  }
  if (counted.count <= SIGN_UP_ADDRESS_DAILY.max) return null;
  const wait = counted.windowStart + window - now;
  return json({ code: 'TOO_MANY_SIGN_UPS', message: 'Too many sign-ups from here. Try again later.' }, 429,
    { ...NO_STORE, 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) });
}

export async function handleAuthRoute(request: Request, env: AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>): Promise<Response> {
  if (foreignOrigin(request, env)) return json({ code: 'FOREIGN_ORIGIN', message: 'This request must come from the app itself.' }, 403, NO_STORE);
  const tooMany = await signUpRefused(request, env);
  if (tooMany) return tooMany;
  const refused = await endSignedOutSession(request, env);
  if (refused) return refused;
  return createAuth(env).handler(request);
}

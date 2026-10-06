// /api/auth/* (A§4.1 step 3): better-auth built per request. Sign-out first ends the session in every open window
// (A§7): the session's PrincipalDO rechecks each doc it opened and closes its workspace sockets.
import { endSession } from '@moss-multi/sync/fanout';
import { NO_STORE, parseJsonObject, readCapped } from '../api/respond.ts';
import type { AppEnv } from '../env.ts';
import { crossOriginCookie } from '../worker/origin-gate.ts';
import { json } from '../worker/route.ts';
import { createAuth, SIGN_UP_ADDRESS_DAILY, SIGN_UP_DOMAIN_HOURLY, type AuthEnv } from './auth.ts';
import { isLoopbackUrl } from './config.ts';
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

/** A sign-up body is a few short fields; past this it is refused unread. */
const SIGN_UP_BODY_MAX_BYTES = 16 * 1024;

/** Counts one attempt against `key`'s fixed window and answers the count and when the window opened. */
const COUNT_ATTEMPT = `INSERT INTO signup_limits (key, window_start, count) VALUES (?1, ?2, 1)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE count + 1 END,
    window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END
  RETURNING count, window_start AS windowStart`;

function emailDomain(body: Record<string, unknown> | null): string | null {
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return email.includes('@') && domain && domain.length <= 255 ? domain : null;
}

/**
 * Open sign-up's bounds beyond better-auth's minute limit (A§7, A§18): sign-ups per client address per day and per email
 * domain per hour, counted in D1 before better-auth runs; 429 past either, and 503 when the count cannot be kept. Only
 * the loopback test-hook stack, which mints principals per run, skips them.
 */
async function signUpRefused(request: Request, env: AuthEnv): Promise<Response | null> {
  if (request.method !== 'POST' || !new URL(request.url).pathname.startsWith('/api/auth/sign-up/')) return null;
  if (isLoopbackUrl(env.BETTER_AUTH_URL) && env.MOSS_TEST_HOOKS === '1') return null;
  const text = await readCapped(request.clone(), SIGN_UP_BODY_MAX_BYTES);
  if (text === 'too-large') return json({ code: 'BODY_TOO_LARGE', message: 'The request is too large.' }, 413, NO_STORE);
  const domain = emailDomain(text === null ? null : parseJsonObject(text));
  const windows = [
    { key: `address:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`, rule: SIGN_UP_ADDRESS_DAILY },
    ...(domain ? [{ key: `domain:${domain}`, rule: SIGN_UP_DOMAIN_HOURLY }] : []),
  ];
  const now = Date.now();
  let counted: { count: number; windowStart: number }[];
  try {
    const results = await env.DB.batch([
      ...windows.map(({ key, rule }) => env.DB.prepare(COUNT_ATTEMPT).bind(key, now, rule.window * 1000)),
      // Windows closed for a day or more hold nothing the next attempt needs.
      env.DB.prepare('DELETE FROM signup_limits WHERE window_start < ?1').bind(now - SIGN_UP_ADDRESS_DAILY.window * 2000),
    ]);
    counted = results.slice(0, windows.length).map((result) => (result.results as { count: number; windowStart: number }[])[0]);
  } catch (error) {
    console.error('sign-up limits unavailable', error);
    return json({ code: 'SIGN_UP_UNAVAILABLE', message: 'Sign-up is unavailable right now. Try again in a minute.' }, 503, NO_STORE);
  }
  const over = windows.map(({ rule }, i) => ({ rule, ...counted[i] })).filter(({ rule, count }) => count > rule.max);
  if (over.length === 0) return null;
  const wait = Math.max(...over.map(({ rule, windowStart }) => windowStart + rule.window * 1000 - now));
  return json({ code: 'TOO_MANY_SIGN_UPS', message: 'Too many sign-ups from here. Try again later.' }, 429,
    { ...NO_STORE, 'retry-after': String(Math.max(1, Math.ceil(wait / 1000))) });
}

export async function handleAuthRoute(request: Request, env: AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>): Promise<Response> {
  if (missingOrigin(request)) return json({ code: 'MISSING_OR_NULL_ORIGIN', message: 'Missing or null Origin' }, 403);
  const tooMany = await signUpRefused(request, env);
  if (tooMany) return tooMany;
  const refused = await endSignedOutSession(request, env);
  if (refused) return refused;
  return createAuth(env).handler(request);
}

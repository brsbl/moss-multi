// Per-run principals (S-test §3.3). Sign-up and sign-in go through the real auth API as declared setup (the auth
// journey uses the login UI instead); the guard makes the owner's accounts unreachable by construction.
import { createHmac, randomBytes } from 'node:crypto';
import { claimSlot, seedEmail } from '../../scripts/deploy/seed.mjs';
import { authHeadroom, type AuthKind, extendTimeout, recordAuth, RESERVE } from './auth-pace.ts';
import type { CanaryState } from './stack.ts';

export const EXAMPLE_DOMAIN = '@example.invalid';

export interface Principal {
  label: string;
  name: string;
  email: string;
  password: string;
  id: string | null;
  /** A canary pool principal (A§21): signs in once per run, and its contexts share that session. */
  pooled?: boolean;
}

export interface SessionCookie {
  name: string;
  value: string;
  url: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
}

/**
 * Invariant 8: at least two distinct principal ids per journey unless it opted out with a reason, and every
 * email at @example.invalid.
 */
export function principalProblems(principals: Pick<Principal, 'email' | 'id'>[], solo: string | null): string[] {
  const problems = principals
    .filter((p) => !p.email.toLowerCase().endsWith(EXAMPLE_DOMAIN))
    .map((p) => `${p.email} is not a test principal (${EXAMPLE_DOMAIN})`);
  if (solo !== null) {
    if (!solo.trim()) problems.push('actors.solo() needs a reason');
    return problems;
  }
  const distinct = new Set(principals.map((p) => p.id ?? `email:${p.email}`)).size;
  if (distinct < 2) problems.push(`${distinct} distinct principal(s); a journey needs at least 2 (or actors.solo(reason))`);
  return problems;
}

export function assertTestEmail(email: string): void {
  if (!email.toLowerCase().endsWith(EXAMPLE_DOMAIN)) throw new Error(`refusing principal ${email}: test principals are ${EXAMPLE_DOMAIN}`);
}

const DISPLAY = ['Ada', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'];

/** Credentials for `mm-<runToken>-<label>-<n>@example.invalid`, not signed up yet (the auth journey uses the card). */
export function newPrincipal(runToken: string, label: string, n: number): Principal {
  const email = `mm-${runToken}-${label}-${n}${EXAMPLE_DOMAIN}`.toLowerCase();
  assertTestEmail(email);
  const first = DISPLAY.find((name) => name.toLowerCase() === label.toLowerCase()) ?? `${label[0].toUpperCase()}${label.slice(1)}`;
  return { label, name: `${first} ${runToken.slice(-4)}`, email, password: randomBytes(18).toString('base64url'), id: null };
}

/** Signs up `mm-<runToken>-<label>-<n>@example.invalid` with a same-origin Origin (better-auth 403s without it). */
export async function mintPrincipal(baseUrl: string, runToken: string, label: string, n: number): Promise<Principal> {
  const { email, name, password } = newPrincipal(runToken, label, n);
  const response = await pastAuthLimit('sign-up', () => fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email, password, name }),
    signal: AbortSignal.timeout(15_000),
  }));
  const text = await response.text();
  if (!response.ok) throw new Error(`sign-up for ${email}: ${response.status} ${text.slice(0, 200)}`);
  const id = (JSON.parse(text) as { user?: { id?: string } }).user?.id ?? null;
  return { label, name, email, password, id };
}

/** A seeded principal's sign-in session, handed to its first browser context (session tokens are single-issue). */
const seededSessions = new Map<string, SessionCookie[]>();

/**
 * A per-run principal the staging deploy wrote for this run (scripts/deploy/seed.mjs): staging allows 30 sign-ups a day
 * per address, far fewer than the suite needs. Claims this shard's next slot, signs in, names it as `newPrincipal`
 * would, and opens its workspace, which makes the home vault a sign-up's hook would have made. Past the slots, it
 * signs up as `mintPrincipal` does.
 */
export async function seededPrincipal(baseUrl: string, seed: NonNullable<CanaryState['seed']>, password: string, runToken: string, label: string, n: number): Promise<Principal> {
  const slot = claimSlot(seed.claimDir, seed.count);
  if (slot === null) return mintPrincipal(baseUrl, runToken, label, n);
  const { name } = newPrincipal(runToken, label, n);
  const principal: Principal = { label, name, email: seedEmail(seed.token, seed.slots, slot), password, id: null };
  assertTestEmail(principal.email);
  const response = await pastAuthLimit('sign-in', () => postSignIn(baseUrl, principal));
  const text = await response.clone().text();
  if (!response.ok) throw new Error(`sign-in for seeded ${principal.email}: ${response.status} ${text.slice(0, 200)}`);
  principal.id = (JSON.parse(text) as { user?: { id?: string } }).user?.id ?? null;
  const cookies = sessionCookies(response, baseUrl, principal.email);
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const named = await fetch(`${baseUrl}/api/auth/update-user`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, cookie },
    body: JSON.stringify({ name }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!named.ok) throw new Error(`naming seeded ${principal.email}: ${named.status}`);
  const workspace = await fetch(`${baseUrl}/api/workspace`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
  if (!workspace.ok) throw new Error(`the workspace of seeded ${principal.email}: ${workspace.status}`);
  await workspace.arrayBuffer();
  seededSessions.set(`${baseUrl} ${principal.email}`, cookies);
  return principal;
}

/**
 * Sign-up and sign-in are limited per address off the hook stack (auth.ts): staging and the canary rehearsal. Setup
 * paces itself under the limit (auth-pace.ts); a 429 that still comes (another job sharing the address) waits out the
 * window, at most six times.
 */
async function pastAuthLimit(kind: AuthKind, post: () => Promise<Response>): Promise<Response> {
  await authHeadroom(kind, RESERVE);
  let response = await post();
  for (let attempt = 0; attempt < 6 && response.status === 429; attempt += 1) {
    const waitMs = Math.min(Number(response.headers.get('x-retry-after')) || 60, 65) * 1000 + 500;
    extendTimeout(waitMs);
    await new Promise((done) => setTimeout(done, waitMs));
    response = await post();
  }
  // The local dev server can restart its worker while a POST is in flight and answer 503 "Your worker restarted
  // mid-request. Please try sending the request again." (wrangler); the request is sent again, at most three times.
  for (let attempt = 0; attempt < 3 && response.status === 503 && /\bworker restarted mid-request\b/.test(await response.clone().text()); attempt += 1) {
    await new Promise((done) => setTimeout(done, 1_000));
    response = await post();
  }
  if (response.status !== 429) recordAuth(kind);
  return response;
}

export function parseSetCookie(header: string, url: string): SessionCookie {
  const [pair, ...attributes] = header.split(';').map((part) => part.trim());
  const eq = pair.indexOf('=');
  const flags = new Map(attributes.map((attribute) => {
    const [key, ...rest] = attribute.split('=');
    return [key.toLowerCase(), rest.join('=')] as const;
  }));
  const sameSite = (flags.get('samesite') ?? 'lax').toLowerCase();
  return {
    name: pair.slice(0, eq),
    value: pair.slice(eq + 1),
    url,
    httpOnly: flags.has('httponly'),
    secure: flags.has('secure'),
    sameSite: sameSite === 'strict' ? 'Strict' : sameSite === 'none' ? 'None' : 'Lax',
  };
}

async function postSignIn(baseUrl: string, principal: Principal): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email: principal.email, password: principal.password }),
    signal: AbortSignal.timeout(15_000),
  });
}

function sessionCookies(response: Response, baseUrl: string, email: string): SessionCookie[] {
  const cookies = response.headers.getSetCookie().map((header) => parseSetCookie(header, baseUrl));
  if (cookies.length === 0) throw new Error(`sign-in for ${email} set no cookie`);
  return cookies;
}

/** The one session per run of each pool principal, keyed by origin and email. */
const pooledSessions = new Map<string, SessionCookie[]>();
/** Pool principals already resolved this run, so a later test signs in to none of them again. */
const pooledPrincipals = new Map<string, Principal>();

/**
 * One fresh session per browser context: session tokens are single-issue (L§4.20). A pool principal reuses its run's
 * one session instead, because staging limits sign-ins to 10 a minute per address (auth.ts) and no canary leg signs out.
 */
export async function signIn(baseUrl: string, principal: Principal): Promise<SessionCookie[]> {
  assertTestEmail(principal.email);
  const pooled = principal.pooled ? pooledSessions.get(`${baseUrl} ${principal.email}`) : undefined;
  if (pooled) return pooled.map((cookie) => ({ ...cookie }));
  const seeded = seededSessions.get(`${baseUrl} ${principal.email}`);
  if (seeded) {
    seededSessions.delete(`${baseUrl} ${principal.email}`);
    return seeded;
  }
  const response = await pastAuthLimit('sign-in', () => postSignIn(baseUrl, principal));
  if (!response.ok) throw new Error(`sign-in for ${principal.email}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const cookies = sessionCookies(response, baseUrl, principal.email);
  if (principal.pooled) pooledSessions.set(`${baseUrl} ${principal.email}`, cookies);
  return cookies.map((cookie) => ({ ...cookie }));
}

/**
 * A fixed canary principal, `canary-<label>@example.invalid`, reused across runs (A§21): its password derives from
 * the pool secret, it signs up only on the pool's first run, and it signs in once per run. Returns it with its id.
 */
export async function poolPrincipal(baseUrl: string, secret: string, label: string): Promise<Principal> {
  if (secret.length < 32) throw new Error('the canary pool secret must be at least 32 characters');
  const email = `canary-${label}${EXAMPLE_DOMAIN}`.toLowerCase();
  assertTestEmail(email);
  const first = DISPLAY.find((name) => name.toLowerCase() === label.toLowerCase()) ?? `${label[0].toUpperCase()}${label.slice(1)}`;
  const known = pooledPrincipals.get(`${baseUrl} ${email}`);
  if (known) return { ...known };
  const principal: Principal = {
    label, name: `${first} Canary`, email, password: createHmac('sha256', secret).update(email).digest('base64url'), id: null, pooled: true,
  };
  let response = await postSignIn(baseUrl, principal);
  if (response.status === 429) {
    // A Playwright worker restarted after a failure signs in again; wait out the window once.
    const wait = Math.min(Number(response.headers.get('x-retry-after')) || 60, 60);
    await new Promise((done) => setTimeout(done, wait * 1000));
    response = await postSignIn(baseUrl, principal);
  }
  if (response.status === 401) {
    // The pool's first run on this database.
    response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ email, password: principal.password, name: principal.name }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  const text = await response.clone().text();
  if (!response.ok) throw new Error(`canary principal ${email}: ${response.status} ${text.slice(0, 200)} (a changed pool secret needs fresh pool labels)`);
  principal.id = (JSON.parse(text) as { user?: { id?: string } }).user?.id ?? null;
  if (!principal.id) throw new Error(`canary principal ${email}: no user id in ${text.slice(0, 200)}`);
  pooledSessions.set(`${baseUrl} ${email}`, sessionCookies(response, baseUrl, email));
  pooledPrincipals.set(`${baseUrl} ${email}`, principal);
  return { ...principal };
}

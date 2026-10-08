// Per-run principals (S-test §3.3). Sign-up and sign-in go through the real auth API as declared setup (the auth
// journey uses the login UI instead); the guard makes the owner's accounts unreachable by construction.
import { createHmac, randomBytes } from 'node:crypto';

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
  const response = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email, password, name }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`sign-up for ${email}: ${response.status} ${text.slice(0, 200)}`);
  const id = (JSON.parse(text) as { user?: { id?: string } }).user?.id ?? null;
  return { label, name, email, password, id };
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
  const response = await postSignIn(baseUrl, principal);
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

// Per-run principals (S-test §3.3). Sign-up and sign-in go through the real auth API as declared setup (the auth
// journey uses the login UI instead); the guard makes the owner's accounts unreachable by construction.
import { randomBytes } from 'node:crypto';

export const EXAMPLE_DOMAIN = '@example.invalid';

export interface Principal {
  label: string;
  name: string;
  email: string;
  password: string;
  id: string | null;
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

/** One fresh session per browser context: session tokens are single-issue (L§4.20). */
export async function signIn(baseUrl: string, principal: Principal): Promise<SessionCookie[]> {
  assertTestEmail(principal.email);
  const response = await fetch(`${baseUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ email: principal.email, password: principal.password }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`sign-in for ${principal.email}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  const cookies = response.headers.getSetCookie().map((header) => parseSetCookie(header, baseUrl));
  if (cookies.length === 0) throw new Error(`sign-in for ${principal.email} set no cookie`);
  return cookies;
}

// Responses every doc route shares. One 404 for a missing, inaccessible or trashed doc keeps them byte-identical (A§8).
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, type Principal } from '../auth/principal.ts';
import { json } from '../worker/route.ts';

export const NO_STORE = { 'cache-control': 'no-store' };

export const notFound = (): Response => json({ error: 'not-found' }, 404, NO_STORE);

export const unauthenticated = (): Response => json({ error: 'unauthenticated' }, 401, NO_STORE);

export const refuse = (status: number, error: string, message: string, headers: Record<string, string> = {}) =>
  json({ error, message }, status, { ...NO_STORE, ...headers });

/** Whether a D1 write changed a row. */
export const changed = (result: D1Result | undefined) => (result?.meta?.changes ?? 0) > 0;

/** The caller, unless anonymous. */
export async function signedIn(request: Request, env: AuthEnv): Promise<Principal | null> {
  const principal = await resolvePrincipal(request, env);
  return principal && principal.type !== 'anonymous' ? principal : null;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : {};
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

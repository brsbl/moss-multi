// Responses every doc route shares. One 404 for a missing, inaccessible or trashed doc keeps them byte-identical (A§8).
import { json } from '../worker/route.ts';

export const NO_STORE = { 'cache-control': 'no-store' };

export const notFound = (): Response => json({ error: 'not-found' }, 404, NO_STORE);

export const unauthenticated = (): Response => json({ error: 'unauthenticated' }, 401, NO_STORE);

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : {};
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

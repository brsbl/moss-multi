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

/** 429 for a daily bound on rows a route adds (A§18). */
export const overDailyBound = (message: string) => refuse(429, 'rate-limited', message, { 'retry-after': '3600' });

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const body: unknown = text ? JSON.parse(text) : {};
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The cap on a JSON request body, far above the largest any route but note creation and feedback takes. */
export const JSON_BODY_MAX_BYTES = 64 * 1024;

/** Thrown by readJsonObject for a body over its cap; handleApi answers it with 413 `too-large`. */
export class BodyTooLarge extends Error {}

export const tooLarge = () => refuse(413, 'too-large', 'That request is too large.');

/**
 * The body as a JSON object, or null when it is not one. A body that declares or runs past `max` bytes throws
 * BodyTooLarge without being buffered beyond the cap.
 */
export async function readJsonObject(request: Request, max = JSON_BODY_MAX_BYTES): Promise<Record<string, unknown> | null> {
  const text = await readCapped(request, max);
  if (text === 'too-large') throw new BodyTooLarge();
  return text === null ? null : parseJsonObject(text);
}

/**
 * The body as text, refused as `too-large` when it declares or runs past `max` bytes, so an oversized body is never
 * buffered; null when it cannot be read.
 */
export async function readCapped(request: Request, max: number): Promise<string | 'too-large' | null> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return 'too-large';
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        return 'too-large';
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

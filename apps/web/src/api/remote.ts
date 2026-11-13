// Server fetches of caller-supplied URLs (A§16, A§18): the fetch and DoH resolver they go through, and the bounded
// body read they share. Unit tests answer remote hosts and DNS themselves.
import { REMOTE_FETCH_RATE } from '@moss-multi/protocol/limits';
import { getServerByName } from 'partyserver';
import type { AuthEnv } from '../auth/auth.ts';
import { sha256Hex, type Principal } from '../auth/principal.ts';
import type { AppEnv } from '../env.ts';
import { json } from '../worker/route.ts';
import { collectCapped, joinChunks, NO_STORE } from './respond.ts';
import { createDohResolver, type RemoteFetch } from './ssrf.ts';

export type RemoteFetchEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>;

/** One identity's throttle: a person or agent by id, a link holder by its link. */
async function throttleKey(principal: Principal): Promise<string> {
  return principal.type === 'anonymous' ? `link:${await sha256Hex(principal.shareToken)}` : principal.id;
}

/** A remote-fetch token from the caller's PrincipalDO (REMOTE_FETCH_RATE), or the 429 to send. */
export async function takeFetchToken(env: RemoteFetchEnv, principal: Principal): Promise<Response | null> {
  if (!env.PrincipalDO) return json({ error: 'unavailable' }, 503, NO_STORE);
  const stub = await getServerByName(env.PrincipalDO, await throttleKey(principal));
  if (await stub.takeFetchToken()) return null;
  return json({ error: 'rate-limited', message: 'Too many fetches at once. Try again in a minute.' }, 429,
    { ...NO_STORE, 'retry-after': String(REMOTE_FETCH_RATE.windowMs / 1000) });
}

let override: RemoteFetch | null = null;

export function remoteFetch(): RemoteFetch {
  return override ?? { fetch: (input, init) => fetch(input, init), resolve: createDohResolver() };
}

export function setRemoteFetchForTests(remote: RemoteFetch | null): void {
  override = remote;
}

/** Seconds a remote fetch may take, every hop included. */
export const REMOTE_TIMEOUT_MS = 8_000;

/** At most `cap` bytes of the body, or null when it holds more. */
export async function readCapped(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(response.headers.get('content-length') ?? 0) > cap) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const read = await collectCapped(reader, cap, () => reader.cancel());
  return read === 'too-large' ? null : joinChunks(read);
}

/** The first `cap` bytes of the body, the rest discarded: enough of a page to read its head. */
export async function readPrefix(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, cap));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, bytes.byteLength - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return bytes;
}

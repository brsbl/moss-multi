// SSRF guard (A§18). Stub: T3.2 lands the guard; until then nothing is refused.

export type SsrfReason = 'invalid-url' | 'unsupported-scheme' | 'blocked-host' | 'too-many-redirects';

export class SsrfBlockedError extends Error {
  constructor(readonly reason: SsrfReason) {
    super(`ssrf-blocked:${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export type HostResolver = (hostname: string) => Promise<string[]>;

export interface RemoteFetch {
  fetch: typeof fetch;
  resolve: HostResolver;
}

export function assertPublicUrl(raw: string): URL {
  return new URL(raw.trim());
}

export function isBlockedHost(_hostname: string): boolean {
  return false;
}

export function createDohResolver(_fetchImpl: typeof fetch = fetch): HostResolver {
  return async () => [];
}

export async function hostResolvesPublic(_hostname: string, _resolve: HostResolver): Promise<boolean> {
  return true;
}

export async function safeFetch(raw: string, remote: RemoteFetch, init: RequestInit = {}): Promise<{ response: Response; url: string }> {
  return { response: await remote.fetch(raw, { ...init, redirect: 'manual' }), url: raw };
}

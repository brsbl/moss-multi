// The fetch and DNS resolver server fetches of caller-supplied URLs use (A§18). Stub until T3.2.
import { createDohResolver, type RemoteFetch } from './ssrf.ts';

let override: RemoteFetch | null = null;

export function remoteFetch(): RemoteFetch {
  return override ?? { fetch: (input, init) => fetch(input, init), resolve: createDohResolver() };
}

/** Unit tests answer remote hosts and DNS themselves. */
export function setRemoteFetchForTests(remote: RemoteFetch | null): void {
  override = remote;
}

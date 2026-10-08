// The bundle's side of the client protocol (registers.md rule 10, A§4.1): every same-origin REST call names the
// protocol this bundle speaks, and a server that refuses it as outdated tells every open doc to stop and offer a
// reload. The doc socket names it as a URL parameter (doc-session.ts) and is refused with 4426.
import { CLIENT_PROTOCOL, OUTDATED_ERROR, OUTDATED_STATUS, PROTOCOL_HEADER } from '@moss-multi/protocol/client-protocol';

const listeners = new Set<() => void>();

/** Calls `listener` when the server says this bundle is too old; returns the unsubscriber. */
export function onOutdated(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportOutdated(): void {
  for (const listener of [...listeners]) listener();
}

const isApi = (url: URL) => url.origin === window.location.origin && (url.pathname === '/api' || url.pathname.startsWith('/api/'));

async function refusedAsOutdated(response: Response): Promise<boolean> {
  if (response.status !== OUTDATED_STATUS) return false;
  try {
    return ((await response.clone().json()) as { error?: unknown }).error === OUTDATED_ERROR;
  } catch {
    return false;
  }
}

/** `fetch` that names the client protocol on same-origin API requests and reports an outdated refusal. */
export function withClientProtocol(fetchImpl: typeof fetch): typeof fetch {
  return async (input, init) => {
    const href = input instanceof Request ? input.url : input instanceof URL ? input.href : String(input);
    const url = new URL(href, window.location.href);
    if (!isApi(url)) return fetchImpl(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    // A caller that names a protocol itself keeps it.
    if (!headers.has(PROTOCOL_HEADER)) headers.set(PROTOCOL_HEADER, String(CLIENT_PROTOCOL));
    const response = await fetchImpl(input, { ...init, headers });
    if (await refusedAsOutdated(response)) reportOutdated();
    return response;
  };
}

/** Wraps the page's fetch once, before anything calls it (client.tsx). */
export function installClientProtocol(): void {
  window.fetch = withClientProtocol(window.fetch.bind(window));
}

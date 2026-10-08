// The Worker's routing order (A§4.1). Pure: server.ts supplies the handlers, so the order is unit-tested in Node.
import {
  isOutdated, OUTDATED_ERROR, OUTDATED_STATUS, PROTOCOL_HEADER, PROTOCOL_PARAM, protocolOf,
} from '@moss-multi/protocol/client-protocol';
import { DOC_BODY_CAP_BYTES, JSON_BODY_CAP_BYTES } from '@moss-multi/protocol/limits';
import { CLOSE } from '@moss-multi/protocol/sync';
import type { Build } from '../provenance.ts';
import { HTML_FRAME_PATH, htmlFrameResponse } from './html-frame.ts';

export const DOC_PARTY = 'doc-d-o';

/** A party connection's verdict. Denials carry the close code the client sees (A§4.1, A§10.5). */
export type PartyAuth = { ok: true; headers: Record<string, string> } | { ok: false; code: 4401 | 4404 | 4410 };

export interface RouteDeps {
  build: Build;
  testHooksAllowed: (request: Request) => boolean;
  /** null for a path or method no hook serves. */
  handleTestHook: (request: Request) => Promise<Response | null>;
  handleAuth: (request: Request) => Promise<Response>;
  handleWorkspaceSocket: (request: Request) => Promise<Response>;
  handleApi: (request: Request) => Promise<Response>;
  authenticateParty: (request: Request, docId: string) => Promise<PartyAuth>;
  routeParty: (request: Request) => Promise<Response | null>;
  /** Accepts the upgrade and closes it with `code`; workerd only. */
  refuseSocket: (code: number) => Response;
  startFetch: (request: Request) => Promise<Response>;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function versionResponse(request: Request, build: Build): Response {
  if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405, { allow: 'GET' });
  return json(build, 200, { 'cache-control': 'no-store' });
}

export const isUpgrade = (request: Request) => request.headers.get('upgrade')?.toLowerCase() === 'websocket';
const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

const UNTRUSTED = /^x-(?:moss|partykit)-/i;

/**
 * Clones without an init, because `new Request(request, {headers})` drops `Upgrade` and `Sec-WebSocket-*`
 * (L§4.7). Client `x-moss-*` and `x-partykit-*` headers go before the trusted ones are set.
 */
export function forwardPartyRequest(request: Request, trusted: Record<string, string>): Request {
  const forwarded = new Request(request);
  for (const name of [...forwarded.headers.keys()]) {
    if (UNTRUSTED.test(name)) forwarded.headers.delete(name);
  }
  for (const [name, value] of Object.entries(trusted)) forwarded.headers.set(name, value);
  return forwarded;
}

const PARTY_STATUS = {
  4401: [401, 'unauthorized'],
  4404: [404, 'not-found'],
  4410: [410, 'gone'],
} as const;

const outdatedResponse = () => json({ error: OUTDATED_ERROR }, OUTDATED_STATUS, { 'cache-control': 'no-store' });

/** REST from a bundle naming an older protocol; a request naming none is not a bundle (the CLI, an agent). */
const outdatedRest = (request: Request): boolean => {
  const sent = request.headers.get(PROTOCOL_HEADER);
  return sent !== null && isOutdated(protocolOf(sent));
};

const MEDIA_UPLOAD = /^\/api\/docs\/[^/]+\/assets$/;
const DOC_BODY = /^\/api\/docs(?:\/[^/]+\/push)?$/;

/** The most an /api body may hold (A§18), or null for a media upload, which checks its own declared length (assets.ts). */
export function bodyCapFor(pathname: string): number | null {
  if (MEDIA_UPLOAD.test(pathname)) return null;
  return DOC_BODY.test(pathname) ? DOC_BODY_CAP_BYTES : JSON_BODY_CAP_BYTES;
}

const tooLarge = () => json({ error: 'too-large', message: 'The request body is too large.' }, 413, { 'cache-control': 'no-store' });

/**
 * The request with its body read whole, at most `cap` bytes, or a 413 that reads no further: by the declared length
 * when there is one, else as the bytes arrive. Handlers buffer and parse bodies, so an unbounded one holds the isolate.
 */
async function capBody(request: Request, cap: number): Promise<Request | Response> {
  if (!request.body) return request;
  if (Number(request.headers.get('content-length')) > cap) return tooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      return tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}

async function routePartyRequest(request: Request, deps: RouteDeps): Promise<Response> {
  // Split exactly as partyserver does, so the doc we authorize is the room it routes to.
  const parts = new URL(request.url).pathname.split('/').filter(Boolean);
  if (parts.length !== 3 || parts[1] !== DOC_PARTY) return json({ error: 'not-found' }, 404);
  // Before anything else: a bundle older than the server's protocol must not write, whoever it is (rule 10).
  if (isOutdated(protocolOf(new URL(request.url).searchParams.get(PROTOCOL_PARAM)))) {
    return isUpgrade(request) ? deps.refuseSocket(CLOSE.outdated) : outdatedResponse();
  }
  const auth = await deps.authenticateParty(request, parts[2]);
  if (!auth.ok) {
    // Never refuse before the upgrade: a refused handshake is a 1006 the client retries forever.
    if (isUpgrade(request)) return deps.refuseSocket(auth.code);
    const [status, error] = PARTY_STATUS[auth.code];
    return json({ error }, status);
  }
  const response = await deps.routeParty(forwardPartyRequest(request, auth.headers));
  return response ?? json({ error: 'not-found' }, 404);
}

export async function routeRequest(incoming: Request, deps: RouteDeps): Promise<Response> {
  let request = incoming;
  const { pathname } = new URL(request.url);
  if (pathname === '/api/version') return versionResponse(request, deps.build);
  // Without the gate, or for a path no hook serves, hook paths get the same 404 as any unknown route.
  if (under(pathname, '/__test') && deps.testHooksAllowed(request)) {
    const hooked = await deps.handleTestHook(request);
    if (hooked) return hooked;
  }
  if (under(pathname, '/api') && outdatedRest(request)) return outdatedResponse();
  const cap = under(pathname, '/api') && request.body ? bodyCapFor(pathname) : null;
  if (cap !== null) {
    const capped = await capBody(request, cap);
    if (capped instanceof Response) return capped;
    request = capped;
  }
  if (pathname.startsWith('/api/auth/')) return deps.handleAuth(request);
  if (pathname === '/api/workspace/ws') return deps.handleWorkspaceSocket(request);
  if (under(pathname, '/api')) return deps.handleApi(request);
  if (under(pathname, '/parties')) return routePartyRequest(request, deps);
  if (pathname === HTML_FRAME_PATH) return htmlFrameResponse(request);
  return deps.startFetch(request);
}

// The Worker's routing order (A§4.1). Pure: server.ts supplies the handlers, so the order is unit-tested in Node.
// Tests-first stub: nothing is routed yet; every request goes to Start SSR.
import type { Build } from '../provenance.ts';

/** A party connection's verdict. Denials carry the close code the client sees (A§4.1, A§10.5). */
export type PartyAuth = { ok: true; headers: Record<string, string> } | { ok: false; code: 4401 | 4404 | 4410 };

export interface RouteDeps {
  build: Build;
  testHooksAllowed: (request: Request) => boolean;
  handleTestHook: (request: Request) => Promise<Response>;
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

export async function routeRequest(request: Request, deps: RouteDeps): Promise<Response> {
  return deps.startFetch(request);
}

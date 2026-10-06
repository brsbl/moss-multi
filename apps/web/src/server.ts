import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';
import { env, waitUntil } from 'cloudflare:workers';
import { routePartykitRequest } from 'partyserver';
import { DocDO } from '@moss-multi/sync';
import { handleApi } from './api/router.ts';
import { refusalFor } from './auth/config.ts';
import { handleAuthRoute } from './auth/route.ts';
import { asAppEnv } from './env.ts';
import { BUILD } from './provenance.ts';
import { mintNonce, withCsp } from './worker/csp.ts';
import { docAccessCheck } from './worker/doc-access.ts';
import { testHooksAllowed } from './worker/handlers.ts';
import { workspaceSocket } from './worker/workspace.ts';
import { authenticateParty } from './worker/party.ts';
import { routeRequest } from './worker/route.ts';
import { handleTestHook } from './worker/test-hooks.ts';

export { DocDO, PrincipalDO, SearchDO } from '@moss-multi/sync';

// Every DocDO re-validates its sockets through the one resolver before applying a frame (A§8 pull validation).
DocDO.access = (doEnv) => (doEnv?.DB ? docAccessCheck(doEnv) : null);

const startFetch = createStartHandler(defaultStreamHandler);

function refuseSocket(code: number): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, 'refused');
  return new Response(null, { status: 101, webSocket: pair[0] });
}

export default createServerEntry({
  async fetch(request) {
    const appEnv = asAppEnv(env);
    // Fail closed (A§7): a weak secret or hooks off loopback serve nothing at all.
    const refusal = refusalFor(appEnv);
    if (refusal) return refusal;
    try {
      return await routeRequest(request, {
        handleWorkspaceSocket: (req) => workspaceSocket(req, appEnv, refuseSocket),
        handleAuth: (req) => handleAuthRoute(req, appEnv),
        handleApi: (req) => handleApi(req, appEnv),
        build: BUILD,
        testHooksAllowed: (req) => testHooksAllowed(req, appEnv),
        handleTestHook: (req) => handleTestHook(req, appEnv),
        authenticateParty: (req, docId) => authenticateParty(req, docId, appEnv),
        routeParty: (req) => routePartykitRequest(req, env as never),
        refuseSocket,
        startFetch: async (req) => {
          const nonce = mintNonce();
          return withCsp(await startFetch(req, { context: { nonce } }), nonce, req.url);
        },
      });
    } catch (error) {
      const { pathname } = new URL(request.url);
      waitUntil(Promise.resolve().then(() => console.error(`worker error: ${request.method} ${pathname}`, error)));
      throw error;
    }
  },
});

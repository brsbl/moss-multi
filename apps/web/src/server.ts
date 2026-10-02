import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server';
import { createServerEntry } from '@tanstack/react-start/server-entry';
import { env, waitUntil } from 'cloudflare:workers';
import { routePartykitRequest } from 'partyserver';
import { asAppEnv } from './env.ts';
import { BUILD } from './provenance.ts';
import { stubHandlers, testHooksAllowed } from './worker/handlers.ts';
import { routeRequest } from './worker/route.ts';

export { DocDO, PrincipalDO, SearchDO } from '@moss-multi/sync';

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
    try {
      return await routeRequest(request, {
        ...stubHandlers,
        build: BUILD,
        testHooksAllowed: (req) => testHooksAllowed(req, appEnv),
        routeParty: (req) => routePartykitRequest(req, env as never),
        refuseSocket,
        startFetch: async (req) => startFetch(req),
      });
    } catch (error) {
      const { pathname } = new URL(request.url);
      waitUntil(Promise.resolve().then(() => console.error(`worker error: ${request.method} ${pathname}`, error)));
      throw error;
    }
  },
});

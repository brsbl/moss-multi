// The two loopback test hooks (A§19), reached only through testHooksAllowed. Content is never seeded here. Any
// other hook path, or the wrong method, falls through to the unknown-route 404.
import type { AppEnv } from '../env.ts';
import { json } from './route.ts';

const HOOK = /^\/__test\/docs\/([^/]+)\/(instance|reset)$/;

export async function handleTestHook(request: Request, env: Pick<AppEnv, 'DocDO'>): Promise<Response | null> {
  const match = HOOK.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, docId, hook] = match;
  // Raw stubs: neither hook runs onStart, so the probe never wakes the DO it measures.
  const stub = env.DocDO.get(env.DocDO.idFromName(docId));
  if (hook === 'instance' && request.method === 'GET') return json(await stub.probeInstance(), 200, { 'cache-control': 'no-store' });
  if (hook === 'reset' && request.method === 'POST') {
    try {
      await stub.abortInstance();
    } catch {
      // ctx.abort() always rejects the call that ends the instance.
    }
    return new Response(null, { status: 204 });
  }
  return null;
}

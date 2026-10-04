// The loopback test hooks (A§19), reached only through testHooksAllowed. Content is never seeded here. Any other hook
// path, or the wrong method, falls through to the unknown-route 404.
import { MEMBER_ROLES } from '@moss-multi/protocol/roles';
import type { AppEnv } from '../env.ts';
import { json } from './route.ts';

const HOOK = /^\/__test\/docs\/([^/]+)\/(instance|reset|link)$/;

export async function handleTestHook(request: Request, env: Pick<AppEnv, 'DocDO' | 'DB'>): Promise<Response | null> {
  const url = new URL(request.url);
  const match = HOOK.exec(url.pathname);
  if (!match) return null;
  const [, docId, hook] = match;
  // Declared setup until T2.4's links API: a live share link on the doc, made by its owner.
  if (hook === 'link' && request.method === 'POST') {
    const role = url.searchParams.get('role') ?? 'viewer';
    if (!(MEMBER_ROLES as readonly string[]).includes(role)) return json({ error: 'bad-role' }, 400);
    const owner = await env.DB.prepare('SELECT owner_user_id AS owner FROM docs WHERE id = ?').bind(docId).first<{ owner: string }>();
    if (!owner) return json({ error: 'not-found' }, 404);
    const token = crypto.randomUUID().replaceAll('-', '');
    await env.DB.prepare('INSERT INTO share_links (token, target_type, target_id, role, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .bind(token, 'doc', docId, role, owner.owner, Date.now()).run();
    return json({ token }, 201, { 'cache-control': 'no-store' });
  }
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

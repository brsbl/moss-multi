// Settings → Agents (T3.6; A§7, A§8): a signed-in person's agent keys. POST mints one and returns its `mm_sk_` key once
// (only the sha256 is stored); GET lists the caller's live agents with the id a share names; DELETE revokes one, then
// closes its sockets through the one kick path before answering. An agent key administers nothing.
import { revokeAgent } from '@moss-multi/sync/fanout';
import type { AppEnv } from '../env.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { AGENT_KEY_PREFIX, resolvePrincipal, sha256Hex } from '../auth/principal.ts';
import { json } from '../worker/route.ts';
import { changed, NO_STORE, notFound, readJsonObject, refuse, unauthenticated } from './respond.ts';

export type AgentsEnv = AuthEnv & Partial<Pick<AppEnv, 'PrincipalDO'>>;

export interface AgentSummary {
  id: string;
  name: string;
  createdAt: number;
}

export const AGENT_NAME_MAX = 80;
const ITEM = /^\/api\/agents\/([^/]+)$/;
const KICK_FAILED = 'The key is revoked, but the agent’s open connections haven’t closed yet. Try again.';

const newKey = () => `${AGENT_KEY_PREFIX}${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;

async function list(env: AgentsEnv, ownerId: string): Promise<Response> {
  const { results } = await env.DB.prepare(`SELECT id, name, created_at AS createdAt FROM agents
      WHERE owner_user_id = ?1 AND revoked_at IS NULL ORDER BY created_at, rowid`).bind(ownerId).all<AgentSummary>();
  return json({ agents: results }, 200, NO_STORE);
}

async function mint(request: Request, env: AgentsEnv, ownerId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > AGENT_NAME_MAX) return refuse(400, 'bad-request', `Name the agent (up to ${AGENT_NAME_MAX} characters).`);
  const key = newKey();
  const agent: AgentSummary = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  await env.DB.prepare('INSERT INTO agents (id, owner_user_id, name, key_hash, created_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL)')
    .bind(agent.id, ownerId, agent.name, await sha256Hex(key), agent.createdAt).run();
  return json({ agent, key }, 201, NO_STORE);
}

/**
 * Revokes first, so the key is refused from this moment whatever happens next, then kicks. A kick that is not
 * acknowledged answers 503 and a retry kicks again; pull validation closes the sockets within a tick regardless (A§8).
 */
async function revoke(env: AgentsEnv, ownerId: string, agentId: string): Promise<Response> {
  const written = await env.DB.prepare('UPDATE agents SET revoked_at = ?3 WHERE id = ?1 AND owner_user_id = ?2 AND revoked_at IS NULL')
    .bind(agentId, ownerId, Date.now()).run();
  if (!changed(written)) {
    const owned = await env.DB.prepare('SELECT 1 AS ok FROM agents WHERE id = ?1 AND owner_user_id = ?2').bind(agentId, ownerId).first();
    if (!owned) return notFound();
  }
  if (!env.PrincipalDO) return refuse(503, 'unavailable', KICK_FAILED);
  try {
    await revokeAgent({ DB: env.DB, PrincipalDO: env.PrincipalDO }, agentId);
  } catch (error) {
    console.error('agent revocation kick failed', error);
    return refuse(503, 'unavailable', KICK_FAILED);
  }
  return json({ revoked: { id: agentId } }, 200, NO_STORE);
}

/** `/api/agents` (GET, POST) and `/api/agents/:id` (DELETE). */
export async function handleAgents(request: Request, env: AgentsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const item = ITEM.exec(pathname);
  if (pathname !== '/api/agents' && !item) return notFound();
  const allowed = item ? ['DELETE'] : ['GET', 'POST'];
  if (!allowed.includes(request.method)) return json({ error: 'method-not-allowed' }, 405, { allow: allowed.join(', ') });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return unauthenticated();
  if (principal.type !== 'user') return refuse(403, 'forbidden', 'An agent key can’t manage agents.');
  if (item) return revoke(env, principal.id, item[1]);
  return request.method === 'GET' ? list(env, principal.id) : mint(request, env, principal.id);
}

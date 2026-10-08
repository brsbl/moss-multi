// The version history REST API (A§14): GET /api/docs/:id/versions and /versions/:vid for any signed-in reader, POST
// /versions {name} saves a named version and POST /versions/:vid/restore restores one, for an editor or above. Named
// versions are counted per person (an agent as its owner) by that person's PrincipalDO and restores as REST writes;
// the DocDO re-authorizes the actor in the same serialized write (A§8), so the Worker's role is never the last word.
import { getServerByName } from 'partyserver';
import { NAMED_VERSION_RATE, NAMED_VERSIONS_PER_NOTE, NAMED_VERSIONS_PER_PERSON, REST_WRITE_RATE } from '@moss-multi/protocol/limits';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { actingUserId, resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { NO_STORE, notFound, readJsonObject } from './respond.ts';

export const VERSIONS_ROUTE = /^\/api\/docs\/([^/]+)\/versions(?:\/([^/]+)(\/restore)?)?$/;

/** Version ids, as the DocDO mints them. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_MAX = 80;

type Action = 'list' | 'save' | 'get' | 'restore';

const FLOOR: Record<Action, Role> = { list: 'viewer', get: 'viewer', save: 'editor', restore: 'editor' };
const MESSAGE: Record<Action, string> = {
  list: "You can't open this note.",
  get: "You can't open this note.",
  save: 'Only an editor can save a version.',
  restore: 'Only an editor can restore a version.',
};

/** What a person reads for a DocDO refusal; a note's history is bounded per note (A§14), never charged to anyone. */
const REFUSAL: Record<string, string> = {
  'version-limit': `You have saved the most named versions this note keeps for one person (${NAMED_VERSIONS_PER_PERSON}).`,
  'note-version-limit': `This note has the most named versions it keeps (${NAMED_VERSIONS_PER_NOTE}).`,
  'restore-unverified': 'This version could not be restored exactly, so the note was left as it is.',
};

interface Verdict {
  ok: boolean;
  status?: number;
  reason?: string;
  versions?: unknown[];
  version?: unknown;
  restorePoint?: string | null;
}

/** `/api/docs/:id/versions[/:vid[/restore]]`. */
export async function handleVersions(request: Request, env: DocsEnv, match: RegExpExecArray): Promise<Response> {
  const [, docId, vid, restore] = match;
  const action: Action = restore ? 'restore' : vid ? 'get' : request.method === 'POST' ? 'save' : 'list';
  const method = action === 'list' || action === 'get' ? 'GET' : 'POST';
  if (request.method !== method) return json({ error: 'method-not-allowed' }, 405, { allow: vid && !restore ? 'GET' : restore ? 'POST' : 'GET, POST' });
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous') return json({ error: 'unauthenticated', message: 'Sign in to see version history' }, 401, NO_STORE);
  // The body is read before access resolves, so a stalled body cannot outlive a revocation or a trash.
  const body = method === 'POST' ? ((await readJsonObject(request)) ?? {}) : {};
  const access = await resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  if (!access || access.deleted) return notFound();
  if (!roleAtLeast(access.role, FLOOR[action])) return json({ error: 'forbidden', message: MESSAGE[action] }, 403, NO_STORE);
  if (vid !== undefined && !ID.test(vid)) return json({ error: 'bad-request' }, 400, NO_STORE);
  const rawName = (body as { name?: unknown }).name;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (action === 'save' && (!name || name.length > NAME_MAX)) return json({ error: 'bad-request', message: 'A version needs a name of 1 to 80 characters' }, 400, NO_STORE);
  const person = actingUserId(principal) ?? principal.id;
  if (action === 'save' || action === 'restore') {
    // Named saves are rated per person: an agent spends its owner's tokens, so more keys add no rate.
    const principalDO = await getServerByName(env.PrincipalDO, action === 'save' ? person : principal.id);
    const allowed = action === 'save' ? await principalDO.takeVersionToken() : await principalDO.takeWriteToken();
    if (!allowed) {
      const window = action === 'save' ? NAMED_VERSION_RATE.windowMs : REST_WRITE_RATE.windowMs;
      return json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(window / 1000) });
    }
  }
  const input = {
    reviewer: { id: principal.id, role: access.role },
    actor: {
      kind: principal.type,
      principalId: principal.id,
      sessionId: principal.type === 'user' ? principal.sessionId : null,
      shareToken: shareTokenOf(request),
    },
  };
  const stub = await getServerByName(env.DocDO, docId);
  let verdict: Verdict;
  if (action === 'list') verdict = (await stub.listVersions(input)) as Verdict;
  else if (action === 'get') verdict = (await stub.getVersion({ ...input, id: vid })) as Verdict;
  else if (action === 'save') verdict = (await stub.saveVersion({ ...input, name, actingUserId: person })) as Verdict;
  else verdict = (await stub.restoreVersion({ ...input, id: vid })) as Verdict;
  if (!verdict.ok) {
    const reason = verdict.reason ?? 'refused';
    return json({ error: reason, ...(REFUSAL[reason] ? { message: REFUSAL[reason] } : {}) }, verdict.status ?? 409, NO_STORE);
  }
  if (action === 'list') return json({ versions: verdict.versions ?? [] }, 200, NO_STORE);
  if (action === 'restore') return json({ restorePoint: verdict.restorePoint ?? null, version: verdict.version ?? null }, 200, NO_STORE);
  return json({ version: verdict.version }, action === 'save' ? 201 : 200, NO_STORE);
}

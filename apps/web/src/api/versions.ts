// The version history REST API (A§14): GET /api/docs/:id/versions and /versions/:vid for any signed-in reader, POST
// /versions {name} saves a named version and POST /versions/:vid/restore {base} restores one, for an editor or above.
// Named versions are counted per person (an agent as its owner) by that person's PrincipalDO and restores as REST
// writes; the DocDO re-authorizes the actor in the same serialized write (A§8), so the Worker's role is never the last word.
import { getServerByName } from 'partyserver';
import { NAMED_VERSION_RATE, NAMED_VERSIONS_PER_NOTE, NAMED_VERSIONS_PER_PERSON, REST_WRITE_RATE, STATE_CAP_BYTES } from '@moss-multi/protocol/limits';
import { roleAtLeast, type Role } from '@moss-multi/protocol/roles';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { json } from '../worker/route.ts';
import { actingUserId, resolveDocAccess } from './access.ts';
import type { DocsEnv } from './docs.ts';
import { JSON_BODY_MAX_BYTES, NO_STORE, notFound, readJsonObject, tooLarge } from './respond.ts';

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
  'restore-base-stale': 'The note has changed since Restore was opened. Open Restore again to restore this version.',
};

/**
 * A restore's base as a client sends it (restore-base.ts), bounded; the DocDO decides whether it is usable. A state
 * vector never encodes longer than the state it describes (restore-base.test.ts), and every entry point holds a note and
 * its payloads to STATE_CAP_BYTES together (A§5.1), so an honest base's vectors decode to at most that: in base64,
 * BASE_VECTOR_MAX_CHARS plus each vector's padding.
 */
const BASE_MAX_PAYLOADS = 10_000;
const BASE64_PADDING = 4;
export const BASE_VECTOR_MAX_CHARS = 4 * Math.ceil(STATE_CAP_BYTES / 3);
/**
 * A restore body's cap (T6.R): every vector, and each payload's id (at most 64 characters), JSON and padding, over the
 * default cap for the rest. A save names at most 80 characters, under the default.
 */
export const RESTORE_BODY_MAX_BYTES = JSON_BODY_MAX_BYTES + BASE_VECTOR_MAX_CHARS + BASE_MAX_PAYLOADS * (64 + 6 + BASE64_PADDING);
function restoreBase(raw: unknown): { ok: true; base: unknown } | { ok: false } {
  if (raw === undefined) return { ok: true, base: undefined };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };
  const { note, payloads, age } = raw as Record<string, unknown>;
  if (typeof note !== 'string' || typeof age !== 'number') return { ok: false };
  if (typeof payloads !== 'object' || payloads === null || Array.isArray(payloads)) return { ok: false };
  const entries = Object.entries(payloads);
  if (entries.length > BASE_MAX_PAYLOADS || entries.some(([id, sv]) => id.length > 64 || typeof sv !== 'string')) return { ok: false };
  const chars = entries.reduce((sum, [, sv]) => sum + (sv as string).length, note.length);
  if (chars > BASE_VECTOR_MAX_CHARS + BASE64_PADDING * (entries.length + 1)) return { ok: false };
  return { ok: true, base: { note, payloads: Object.fromEntries(entries), age } };
}

const rateLimited = (windowMs: number) => json({ error: 'rate-limited' }, 429, { ...NO_STORE, 'retry-after': String(windowMs / 1000) });

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
  const person = actingUserId(principal) ?? principal.id;
  const resolve = () => resolveDocAccess(createDb(env.DB), principal, docId, shareTokenOf(request));
  const refusal = (access: Awaited<ReturnType<typeof resolve>>): Response | null => {
    if (!access || access.deleted) return notFound();
    if (!roleAtLeast(access.role, FLOOR[action])) return json({ error: 'forbidden', message: MESSAGE[action] }, 403, NO_STORE);
    return null;
  };
  // A restore's body can run to megabytes (T6.S9), so it is read only for a principal who may restore, after a declared
  // oversize is refused and the acting person's write token is charged (an agent spends its owner's, so keys add no rate).
  if (action === 'restore') {
    const early = refusal(await resolve());
    if (early) return early;
    if (Number(request.headers.get('content-length') ?? 0) > RESTORE_BODY_MAX_BYTES) return tooLarge();
    if (!(await (await getServerByName(env.PrincipalDO, person)).takeWriteToken())) return rateLimited(REST_WRITE_RATE.windowMs);
  }
  const body = method === 'POST' ? ((await readJsonObject(request, action === 'restore' ? RESTORE_BODY_MAX_BYTES : undefined)) ?? {}) : {};
  // Access resolves (again) once the body is in, so a revocation, demotion or trash during a slow body still wins.
  const access = await resolve();
  const refused = refusal(access);
  if (refused || !access) return refused ?? notFound();
  if (vid !== undefined && !ID.test(vid)) return json({ error: 'bad-request' }, 400, NO_STORE);
  const rawName = (body as { name?: unknown }).name;
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (action === 'save' && (!name || name.length > NAME_MAX)) return json({ error: 'bad-request', message: 'A version needs a name of 1 to 80 characters' }, 400, NO_STORE);
  const base = restoreBase((body as { base?: unknown }).base);
  if (action === 'restore' && !base.ok) return json({ error: 'bad-request', message: 'A restore base is malformed' }, 400, NO_STORE);
  // Named saves are rated per person: an agent spends its owner's tokens, so more keys add no rate.
  if (action === 'save' && !(await (await getServerByName(env.PrincipalDO, person)).takeVersionToken())) return rateLimited(NAMED_VERSION_RATE.windowMs);
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
  else verdict = (await stub.restoreVersion({ ...input, id: vid, base: base.ok ? base.base : undefined })) as Verdict;
  if (!verdict.ok) {
    const reason = verdict.reason ?? 'refused';
    return json({ error: reason, ...(REFUSAL[reason] ? { message: REFUSAL[reason] } : {}) }, verdict.status ?? 409, NO_STORE);
  }
  if (action === 'list') return json({ versions: verdict.versions ?? [] }, 200, NO_STORE);
  if (action === 'restore') return json({ restorePoint: verdict.restorePoint ?? null, version: verdict.version ?? null }, 200, NO_STORE);
  return json({ version: verdict.version }, action === 'save' ? 201 : 200, NO_STORE);
}

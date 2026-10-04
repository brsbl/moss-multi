// Admission at /parties/doc-d-o/<docId> (A§4.1 step 6): who is calling and their role on the doc. Denials are
// closes after the upgrade (route.ts): 4401 with no credential or a cookie from another origin, 4404 for a missing
// or inaccessible doc, 4410 for a trashed one the caller could otherwise open.
import { CLOSE, encodePartyPrincipal, TRUSTED, type PartyPrincipal } from '@moss-multi/protocol/sync';
import { resolveDocAccess } from '../api/access.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { crossOriginCookie } from './origin-gate.ts';
import type { PartyAuth } from './route.ts';

export async function authenticateParty(request: Request, docId: string, env: AuthEnv): Promise<PartyAuth> {
  const principal = await resolvePrincipal(request, env);
  // Before the doc is looked up, so the close says nothing about whether it exists.
  if (!principal || crossOriginCookie(request, principal, env)) return { ok: false, code: CLOSE.noPrincipal };
  const access = await resolveDocAccess(createDb(env.DB), principal, docId);
  if (!access) return { ok: false, code: CLOSE.unavailable };
  if (access.deleted) return { ok: false, code: CLOSE.deleted };
  const party: PartyPrincipal = { id: principal.id, kind: principal.type, name: principal.name };
  const headers: Record<string, string> = {
    [TRUSTED.principal]: encodePartyPrincipal(party),
    [TRUSTED.role]: access.role,
  };
  if (principal.type === 'user') headers[TRUSTED.session] = principal.sessionId;
  const share = shareTokenOf(request);
  if (share) headers[TRUSTED.share] = share;
  return { ok: true, headers };
}

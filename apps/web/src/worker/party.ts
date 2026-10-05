// Admission at /parties/doc-d-o/<docId> (A§4.1 step 6): who is calling and their role on the doc, from the one
// resolver (A§8: ownership, grants, a presented link as a ceiling). Denials are closes after the upgrade (route.ts):
// 4401 with no credential or a cookie from another origin, 4404 for a missing or inaccessible doc or a forged or
// revoked link, 4410 for a trashed one the caller could otherwise open.
import { CLOSE, encodePartyPrincipal, TRUSTED, type PartyPrincipal } from '@moss-multi/protocol/sync';
import { resolveDocAccess } from '../api/access.ts';
import { acceptShares } from '../api/members.ts';
import type { AuthEnv } from '../auth/auth.ts';
import { resolvePrincipal, shareTokenOf } from '../auth/principal.ts';
import { createDb } from '../db/client.ts';
import { crossOriginCookie } from './origin-gate.ts';
import type { PartyAuth } from './route.ts';

export async function authenticateParty(request: Request, docId: string, env: AuthEnv): Promise<PartyAuth> {
  // Before anything is read: a revocation committed after this instant outdates the role resolved below (A§8).
  const resolvedAt = Date.now();
  const principal = await resolvePrincipal(request, env);
  // Before the doc is looked up, so the close says nothing about whether it exists.
  if (!principal || crossOriginCookie(request, principal, env)) return { ok: false, code: CLOSE.noPrincipal };
  const share = shareTokenOf(request);
  const db = createDb(env.DB);
  const access = await resolveDocAccess(db, principal, docId, share);
  if (!access) return { ok: false, code: CLOSE.unavailable };
  if (access.deleted) return { ok: false, code: CLOSE.deleted };
  await acceptShares(env.DB, principal, docId, access);
  const party: PartyPrincipal = { id: principal.id, kind: principal.type, name: principal.name };
  const headers: Record<string, string> = {
    [TRUSTED.principal]: encodePartyPrincipal(party),
    [TRUSTED.role]: access.role,
    [TRUSTED.presence]: principal.type !== 'anonymous' && !access.linkOnly ? '1' : '0',
    [TRUSTED.resolvedAt]: String(resolvedAt),
  };
  if (principal.type === 'user') headers[TRUSTED.session] = principal.sessionId;
  // The role and the link's mark come from one read: a socket the link lifted carries it, so revoking the link closes
  // it even when the revocation lands mid-admission; one the link did not lift is not closed by a dead link.
  if (share && (principal.type === 'anonymous' || access.viaLink)) headers[TRUSTED.share] = share;
  return { ok: true, headers };
}

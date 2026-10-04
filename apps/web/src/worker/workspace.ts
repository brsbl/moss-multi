import { getServerByName } from 'partyserver';
import { TRUSTED } from '@moss-multi/protocol/sync';
import { resolvePrincipal } from '../auth/principal.ts';
import type { AppEnv } from '../env.ts';
import { crossOriginCookie } from './origin-gate.ts';
import { forwardPartyRequest, isUpgrade, json } from './route.ts';

export async function workspaceSocket(request: Request, env: AppEnv, refuse: (code: number) => Response): Promise<Response> {
  if (!isUpgrade(request)) return json({ error: 'upgrade-required' }, 426);
  const principal = await resolvePrincipal(request, env);
  if (!principal || principal.type === 'anonymous' || crossOriginCookie(request, principal, env)) return refuse(4401);
  const headers: Record<string, string> = { [TRUSTED.principal]: principal.id };
  if (principal.type === 'user') headers[TRUSTED.session] = principal.sessionId;
  const stub = await getServerByName(env.PrincipalDO, principal.id);
  return stub.fetch(forwardPartyRequest(request, headers));
}

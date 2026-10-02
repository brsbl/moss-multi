// Admission at /parties/doc-d-o/<docId> (A§4.1 step 6). Fails closed until T0.7 lands the resolver.
import type { AuthEnv } from '../auth/auth.ts';
import type { PartyAuth } from './route.ts';

export async function authenticateParty(request: Request, docId: string, env: AuthEnv): Promise<PartyAuth> {
  void [request, docId, env];
  return { ok: false, code: 4401 };
}

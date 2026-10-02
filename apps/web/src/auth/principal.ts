// T0.4 tests first: not implemented yet.
import type { AuthEnv } from './auth.ts';

export const AGENT_KEY_PREFIX = 'mm_sk_';

export type Principal =
  | { type: 'user'; id: string; name: string; email: string; sessionId: string }
  | { type: 'agent'; id: string; name: string; ownerUserId: string }
  | { type: 'anonymous'; id: 'anonymous'; name: 'Anonymous'; shareToken: string };

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const resolvePrincipal: (request: Request, env: AuthEnv) => Promise<Principal | null> = async () => null;

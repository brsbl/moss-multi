// Route handlers that later tasks fill in, and the test-hook gate (A§19).
import type { AppEnv } from '../env.ts';
import { json, type PartyAuth } from './route.ts';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isLoopback(url: string | undefined): boolean {
  try {
    return LOOPBACK.has(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
}

type HookEnv = Pick<AppEnv, 'MOSS_TEST_HOOKS' | 'MOSS_TEST_HOOKS_SECRET' | 'BETTER_AUTH_URL'>;

/** All four must hold: hooks on, a loopback request, a loopback BETTER_AUTH_URL, and the per-run secret header. */
export function testHooksAllowed(request: Request, env: HookEnv): boolean {
  const secret = env.MOSS_TEST_HOOKS_SECRET;
  return (
    env.MOSS_TEST_HOOKS === '1' &&
    !!secret &&
    request.headers.get('x-moss-test-hook') === secret &&
    isLoopback(request.url) &&
    isLoopback(env.BETTER_AUTH_URL)
  );
}

const notImplemented = async () => json({ error: 'not-implemented' }, 501);

export const stubHandlers = {
  handleTestHook: notImplemented, // T0.7: instance probe and reset
  handleAuth: notImplemented, // T0.4: better-auth per request
  handleWorkspaceSocket: notImplemented, // PrincipalDO workspace channel
  handleApi: async () => json({ error: 'not-found' }, 404),
  // Fails closed until principals and roles exist (T0.4, T0.7).
  authenticateParty: async (): Promise<PartyAuth> => ({ ok: false, code: 4401 }),
};

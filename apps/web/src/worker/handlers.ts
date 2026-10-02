// Route handlers that later tasks fill in, and the test-hook gate (A§19).
import { isLoopbackUrl } from '../auth/config.ts';
import type { AppEnv } from '../env.ts';
import { json } from './route.ts';

type HookEnv = Pick<AppEnv, 'MOSS_TEST_HOOKS' | 'MOSS_TEST_HOOKS_SECRET' | 'BETTER_AUTH_URL'>;

/** All four must hold: hooks on, a loopback request, a loopback BETTER_AUTH_URL, and the per-run secret header. */
export function testHooksAllowed(request: Request, env: HookEnv): boolean {
  const secret = env.MOSS_TEST_HOOKS_SECRET;
  return (
    env.MOSS_TEST_HOOKS === '1' &&
    !!secret &&
    request.headers.get('x-moss-test-hook') === secret &&
    isLoopbackUrl(request.url) &&
    isLoopbackUrl(env.BETTER_AUTH_URL)
  );
}

const notImplemented = async () => json({ error: 'not-implemented' }, 501);

export const stubHandlers = {
  handleWorkspaceSocket: notImplemented, // PrincipalDO workspace channel
};

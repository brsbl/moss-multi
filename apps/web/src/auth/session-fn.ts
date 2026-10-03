// The session read (A§4.2): one server function, run in-process during SSR and over HTTP from the client. A
// failed lookup answers `unavailable` instead of throwing, so a transient D1 error degrades in place and never
// reads as "signed out" (R10). Worker-only modules load inside the handlers, which the client build replaces.
import { createServerFn } from '@tanstack/react-start';
import type { SessionAnswer, SocialProviderId } from '../host/auth-state.ts';

export const lookupSession = createServerFn({ method: 'GET' }).handler(async (): Promise<SessionAnswer> => {
  try {
    const [{ getRequest }, { env }, { createAuth }, { asAppEnv }] = await Promise.all([
      import('@tanstack/react-start/server'),
      import('cloudflare:workers'),
      import('./auth.ts'),
      import('../env.ts'),
    ]);
    const found = await createAuth(asAppEnv(env)).api.getSession({ headers: getRequest().headers });
    if (!found) return { kind: 'signed-out' };
    const { id, name, email } = found.user;
    return { kind: 'signed-in', user: { id, name, email } };
  } catch (error) {
    console.error('session lookup failed', error);
    return { kind: 'unavailable' };
  }
});

/** The OAuth providers this deployment registers; the card renders a button for these only (A§7). */
export const loginProviders = createServerFn({ method: 'GET' }).handler(async (): Promise<SocialProviderId[]> => {
  const [{ env }, { configuredSocialProviders }, { asAppEnv }] = await Promise.all([
    import('cloudflare:workers'),
    import('./config.ts'),
    import('../env.ts'),
  ]);
  return Object.keys(configuredSocialProviders(asAppEnv(env))) as SocialProviderId[];
});

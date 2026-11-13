// Auth configuration checks (A§7, A§18): the Worker refuses to serve rather than run with forgeable sessions
// or test hooks reachable off loopback.
import type { AppEnv } from '../env.ts';

/** The template value a developer copies before setting a real one; treated as no secret at all. */
export const PLACEHOLDER_SECRET = 'dev-only-secret-not-for-production';
export const MIN_SECRET_LENGTH = 32;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackUrl(url: string | undefined): boolean {
  try {
    return LOOPBACK.has(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
}

/** better-auth's minimum password length: 8 on a loopback dev stack, 12 on every deployment. */
export function minPasswordLength(url: string | undefined): number {
  return isLoopbackUrl(url) ? 8 : 12;
}

export type ConfigEnv = Pick<AppEnv, 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOSS_TEST_HOOKS'>;

/** Why this env must not serve, or null. Never echoes the secret. */
export function configProblem(env: ConfigEnv): string | null {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) return 'BETTER_AUTH_SECRET is missing';
  if (secret.startsWith(PLACEHOLDER_SECRET)) return 'BETTER_AUTH_SECRET is the placeholder';
  if (secret.length < MIN_SECRET_LENGTH) return `BETTER_AUTH_SECRET is under ${MIN_SECRET_LENGTH} characters`;
  try {
    new URL(env.BETTER_AUTH_URL ?? '');
  } catch {
    return 'BETTER_AUTH_URL is missing or not a URL';
  }
  if (env.MOSS_TEST_HOOKS === '1' && !isLoopbackUrl(env.BETTER_AUTH_URL)) {
    return 'MOSS_TEST_HOOKS=1 with a non-loopback BETTER_AUTH_URL';
  }
  return null;
}

/** The response for every request while the env is misconfigured, or null when it may serve. */
export function refusalFor(env: ConfigEnv): Response | null {
  const problem = configProblem(env);
  if (!problem) return null;
  console.error(`refusing to serve: ${problem}`);
  return new Response(JSON.stringify({ error: 'misconfigured' }), {
    status: 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export type SocialEnv = Pick<AppEnv, 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>;

/** OAuth providers with both an id and a secret. The server registers, and the login card renders, only these. */
type Credentials = { clientId: string; clientSecret: string };

export function configuredSocialProviders(env: SocialEnv): { github?: Credentials; google?: Credentials } {
  const providers: { github?: Credentials; google?: Credentials } = {};
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return providers;
}

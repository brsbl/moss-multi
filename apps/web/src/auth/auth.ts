// better-auth, built per request because D1 bindings are per invocation (A§7, L§4.9).
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { ensureDefaultVault } from '../api/vaults.ts';
import { createDb } from '../db/client.ts';
import { authSchema } from '../db/schema.ts';
import type { AppEnv } from '../env.ts';
import { configProblem, configuredSocialProviders, isLoopbackUrl } from './config.ts';

export const CLI_CLIENT_ID = 'moss-multi-cli';

// better-auth limits only when NODE_ENV=production and counts per isolate by default, so the limits are
// explicit and stored in D1. Only the loopback test-hook stack raises them; config.ts keeps hooks off staging.
export const SIGN_IN_LIMIT = { window: 60, max: 10 };
export const SIGN_UP_LIMIT = { window: 60, max: 10 };
const HOOK_STACK_LIMIT = { window: 60, max: 10_000 };

export type AuthEnv = Pick<
  AppEnv,
  | 'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOSS_TEST_HOOKS'
  | 'GITHUB_CLIENT_ID' | 'GITHUB_CLIENT_SECRET' | 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'
>;

export function createAuth(env: AuthEnv) {
  const problem = configProblem(env);
  if (problem) throw new Error(`refusing to build auth: ${problem}`);
  const loopback = isLoopbackUrl(env.BETTER_AUTH_URL);
  const hookStack = loopback && env.MOSS_TEST_HOOKS === '1';
  const db = createDb(env.DB);

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, { provider: 'sqlite', schema: authSchema }),
    session: { cookieCache: { enabled: false } },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: loopback ? 8 : 12,
      requireEmailVerification: false, // no email provider is configured (P:People)
    },
    socialProviders: configuredSocialProviders(env),
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: {
        '/sign-in/*': hookStack ? HOOK_STACK_LIMIT : SIGN_IN_LIMIT,
        '/sign-up/*': hookStack ? HOOK_STACK_LIMIT : SIGN_UP_LIMIT,
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // Explicit, because better-auth turns both checks off when NODE_ENV=test.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    telemetry: { enabled: false },
    databaseHooks: {
      user: {
        create: {
          // The account already exists here; a failure is logged and healed by the next ensureDefaultVault caller.
          after: async (created) => {
            try {
              await ensureDefaultVault(db, created.id);
            } catch (error) {
              console.error('Home vault on sign-up failed', error);
            }
          },
        },
      },
    },
    plugins: [
      deviceAuthorization({
        expiresIn: '15m',
        interval: '5s',
        verificationUri: '/device',
        validateClient: (clientId) => clientId === CLI_CLIENT_ID,
      }),
      bearer(),
      tanstackStartCookies(), // must stay last
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

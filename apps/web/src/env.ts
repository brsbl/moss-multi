import type { DocDO, PrincipalDO, SearchDO } from '@moss-multi/sync';

// Bindings from wrangler.jsonc plus the vars and secrets the Worker reads.
export interface AppEnv {
  DB: D1Database;
  ASSETS: R2Bucket;
  DocDO: DurableObjectNamespace<DocDO>;
  PrincipalDO: DurableObjectNamespace<PrincipalDO>;
  SearchDO: DurableObjectNamespace<SearchDO>;
  BETTER_AUTH_SECRET?: string;
  BETTER_AUTH_URL?: string;
  MOSS_TEST_HOOKS?: string;
  MOSS_TEST_HOOKS_SECRET?: string;
  /** "allowlist" on the pilot (T8.P1): only MOSS_ALLOWED_EMAILS may sign up. Unset, sign-up is open. */
  MOSS_SIGN_UP?: string;
  /** Emails separated by commas, semicolons or whitespace; a Worker secret. */
  MOSS_ALLOWED_EMAILS?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export const asAppEnv = (env: unknown): AppEnv => env as AppEnv;

// T0.4 tests first: not implemented yet.
import type { AppEnv } from '../env.ts';

export const SIGN_IN_LIMIT = { window: 60, max: 10 };

export type AuthEnv = Pick<AppEnv, 'DB' | 'BETTER_AUTH_SECRET' | 'BETTER_AUTH_URL' | 'MOSS_TEST_HOOKS'>;

export const createAuth: (env: AuthEnv) => never = () => {
  throw new Error('not implemented');
};
